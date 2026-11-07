import { randomUUID } from 'node:crypto';
import { checkJsonBytes } from 'devcontour-harness';
import { DomainError, type DevContourState, type Task } from '../core/model.ts';
import { digest, specDigest, type DevContour } from '../core/service.ts';
import { repositories } from '../core/repositories.ts';
import { taskOwner } from '../core/sync-state.ts';
import { executionOf } from '../harness/execution.ts';
import { InputService } from './input.ts';
import {
  DISCUSSION_PAGE_BYTES,
  DISCUSSION_TEXT_BYTES,
  clipText,
  discussionInputs,
  discussionMessage,
  textTooLong,
  type DiscussionMessage,
} from '../core/discussion-model.ts';

type Author = DiscussionMessage['author'];

/** Байт JSON-вида выдержки текста в очереди ведущего: полный текст — `discussion_read`. */
export const INBOX_EXCERPT_BYTES = 1000;

/**
 * Запись очереди ведущего — ограниченная проекция обращения: выдержка
 * текста, его длина и версия треда для `discussion_resolve`. Размер записи
 * не зависит от длины текста, поэтому страница очереди всегда продвигается.
 */
export interface InboxRequest {
  id: string;
  taskId: string;
  createdAt: string;
  /** Обращение исправляет прежнее: в очереди — только последняя версия. */
  supersedes?: string;
  excerpt: string;
  truncated: boolean;
  /** Длина полного текста в байтах UTF-8. */
  textBytes: number;
  /** Версия треда задачи — `expectedVersion` для `discussion_resolve`. */
  version: number;
  /** Ведущий просил ответа, и оператор ответил: обращение снова ждёт обработки. */
  reopened?: { dispositionId: string; answerId: string };
}

/** Курсор очереди: позиция последней выданной записи в каждой схеме хранения (по её владельцу). */
function parseInboxCursor(cursor: string | undefined): Record<string, number> {
  if (!cursor) return {};
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    value = undefined;
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.values(value).every((n) => Number.isSafeInteger(n) && (n as number) >= 0)
  )
    throw new DomainError('Некорректный cursor', 400);
  return value as Record<string, number>;
}

/**
 * Обсуждение задачи: заметки, обращения к ведущему агенту и их обработка.
 * Один прикладной сервис для HTTP, CLI и MCP. Происхождение автора задаёт
 * вход (панель — operator, агентские операции — lead), а не поле запроса.
 *
 * Записи лежат вне документа состояния: заметка не меняет постановку, её
 * digest, согласования, очередь, попытки и расход. Обращение не переписывает
 * утверждённую задачу — изменение идёт обычной ревизией, а обработка
 * обращения лишь ссылается на неё.
 */
export class DiscussionService {
  constructor(readonly h: DevContour) {}

  private task(state: Readonly<DevContourState>, taskId: string) {
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) throw new DomainError('Задача не найдена', 404);
    return task;
  }

  /** Страница треда задачи: cursor — seq последней выданной записи. */
  read(raw: unknown, maxBytes = DISCUSSION_PAGE_BYTES) {
    const v = discussionInputs.discussion_read.parse(raw);
    const state = this.h.store.read();
    const task = this.task(state, v.taskId);
    const owner = taskOwner(task);
    // Чтение с конца: `latest` — последняя страница, `before` — страница
    // перед seq; ответ по возрастанию и `previousCursor`, если есть раньше.
    const backward = v.latest || v.before !== undefined;
    const after = Number(v.cursor ?? 0);
    const rows = backward
      ? this.h.store
          .discussionPageBefore(owner, task.id, v.before ? Number(v.before) : Infinity, v.limit)
          .reverse()
      : this.h.store.discussionPage(owner, task.id, after, v.limit);
    const items: DiscussionMessage[] = [];
    for (const row of rows) {
      const message = this.parse(row);
      if (!checkJsonBytes([message], maxBytes).within)
        throw new DomainError('Запись больше страницы', 413);
      // Вперёд страница режется с нового края, назад — со старого (ниже).
      if (!backward && !checkJsonBytes([...items, message], maxBytes).within) break;
      items.push(message);
    }
    const version = this.h.store.discussionVersion(owner, task.id);
    if (backward) {
      // С конца страница режется со старшего края: последние записи — всегда.
      while (items.length > 1 && !checkJsonBytes(items, maxBytes).within) items.shift();
    }
    const last = items.at(-1)?.seq ?? after;
    const first = items[0]?.seq;
    const older =
      first !== undefined && this.h.store.discussionPageBefore(owner, task.id, first, 1).length > 0;
    return {
      taskId: task.id,
      version,
      messages: items,
      ...(last < version ? { nextCursor: String(last) } : {}),
      ...(older ? { previousCursor: String(first) } : {}),
      // Граница хранения: история — у владельца задачи, Git sync её не переносит.
      storage: 'local' as const,
    };
  }

  /**
   * Запись хранилища в форме сообщения. У принятого ответа на вопрос
   * исполнителя текста в записи нет: он берётся из запроса harness по версии
   * ответа (канонический текст хранится один раз).
   */
  private parse(row: unknown): DiscussionMessage {
    const value = row as { text?: unknown; input?: { requestId: string; revision?: number } };
    if (value.text === undefined && value.input?.revision !== undefined) {
      let text = '(ответ не найден в запросе исполнителя)';
      try {
        const request = executionOf(this.h).engine.inputRequest(value.input.requestId);
        text = request.answers.find((a) => a.revision === value.input!.revision)?.text ?? text;
      } catch {
        /* Запрос не найден: сообщение остаётся читаемым. */
      }
      return discussionMessage.parse({ ...value, text });
    }
    return discussionMessage.parse(row);
  }

  /** Сообщение задачи по ID (ссылка ответа, выбор для снимка с ответом). */
  message(taskId: string, id: string) {
    const task = this.task(this.h.store.read(), taskId);
    const row = this.h.store.discussionById(taskOwner(task), id);
    if (!row) return undefined;
    const message = this.parse(row);
    return message.taskId === taskId ? message : undefined;
  }

  /** Заметка, обращение к ведущему или ответ на вопрос исполнителя от `author`. */
  post(raw: unknown, author: Exclude<Author, 'runtime'>) {
    tooLong(raw);
    const v = discussionInputs.discussion_post.parse(raw);
    if (v.kind === 'answer') {
      if (!v.input)
        throw new DomainError('Ответ на вопрос исполнителя называет запрос (input.requestId)', 400);
      return this.answer(
        {
          taskId: v.taskId,
          text: v.text,
          idempotencyKey: v.idempotencyKey,
          ...v.input,
          ...(v.supersedes ? { supersedes: v.supersedes } : {}),
          ...(v.replyTo ? { replyTo: v.replyTo } : {}),
        },
        author,
      );
    }
    if (v.input)
      throw new DomainError(
        'Поле input — только у ответа на вопрос исполнителя (kind answer)',
        400,
      );
    return this.append(v.taskId, author, {
      kind: v.kind,
      text: v.text,
      idempotencyKey: v.idempotencyKey,
      expectedVersion: v.expectedVersion,
      ...(v.replyTo ? { replyTo: v.replyTo } : {}),
      ...(v.supersedes ? { supersedes: v.supersedes } : {}),
    });
  }

  /**
   * Обработка обращения ведущим: принято в новую ревизию, отклонено с
   * причиной или нужен ответ. Чтение обращения обработкой не является.
   */
  resolve(raw: unknown) {
    tooLong(raw);
    const v = discussionInputs.discussion_resolve.parse(raw);
    const request = this.find(v.requestId);
    if (!request || request.kind !== 'change-request')
      throw new DomainError('Обращение не найдено', 404);
    const state = this.h.store.read();
    if (v.refs.revision !== undefined && !v.refs.boardId)
      throw new DomainError('Ревизия указывается вместе с доской (refs.boardId)', 400);
    // Ссылки любой обработки — на существующую работу; принятие — на
    // настоящую новую: ревизию доски или задачи, созданные после обращения.
    if (v.outcome === 'accepted' && !v.refs.boardId && !v.refs.taskIds?.length)
      throw new DomainError('Принятое обращение ссылается на ревизию доски или задачи', 400);
    if (v.refs.boardId) {
      const board = state.boards.find((b) => b.id === v.refs.boardId);
      const revision =
        v.refs.revision === undefined
          ? board?.revisions.at(-1)
          : board?.revisions.find((r) => r.number === v.refs.revision);
      if (!revision) throw new DomainError('Ревизия доски не найдена', 404);
      if (v.outcome === 'accepted' && revision.createdAt <= request.createdAt)
        throw new DomainError('Ревизия старше обращения: изменение ещё не внесено', 409);
    }
    for (const id of v.refs.taskIds ?? []) {
      const t = state.tasks.find((x) => x.id === id);
      if (!t) throw new DomainError('Задача не найдена: ' + id, 404);
      if (v.outcome === 'accepted' && t.createdAt <= request.createdAt)
        throw new DomainError('Задача старше обращения: изменение ещё не внесено: ' + id, 409);
    }
    return this.append(request.taskId, 'lead', {
      kind: 'disposition',
      text: v.reason,
      replyTo: request.id,
      idempotencyKey: v.idempotencyKey,
      expectedVersion: v.expectedVersion,
      disposition: { outcome: v.outcome, refs: v.refs },
      // В транзакции записи, после проверки повтора: повтор той же обработки
      // возвращает прежнюю запись, а не отказ.
      check: (owner) => {
        if (this.h.store.discussionSupersededBy(owner, request.id))
          throw new DomainError('Обращение исправлено: обработайте его новую версию', 409, {
            code: 'request-superseded',
          });
        const last = this.h.store.discussionLatestDisposition(owner, request.id);
        const outcome = last && this.parse(last).disposition?.outcome;
        if (outcome && outcome !== 'needs-answer')
          throw new DomainError('Обращение уже обработано', 409, { code: 'already-resolved' });
      },
    });
  }

  /**
   * Необработанные обращения к ведущему по всем задачам, старые первыми.
   * Схемы хранения читаются по одной (в центральном хранилище владельцы
   * делят таблицу), каждая — с запасом в одну запись, чтобы знать, есть ли
   * продолжение; страница — слияние схем по времени события с позицией
   * каждой схемы в курсоре. `redact` применяется к полному тексту до выдержки.
   */
  inbox(
    raw: unknown,
    maxBytes = DISCUSSION_PAGE_BYTES,
    options: { redact?: (text: string) => string; excerptBytes?: number } = {},
  ) {
    const v = discussionInputs.discussion_inbox.parse(raw);
    const positions = parseInboxCursor(v.cursor);
    // Одна схема — один список; ключ курсора — первый её владелец
    // (`@workspace` или id репозитория): имя схемы зависит от порядка
    // репозиториев в конфигурации, владелец — нет.
    const lists = this.schemaOwners().map((owner) => ({
      key: owner ?? '@workspace',
      owner,
      at: 0,
      rows: this.h.store.discussionInbox(owner, positions[owner ?? '@workspace'] ?? 0, v.limit + 1),
    }));
    const excerptBytes = options.excerptBytes ?? INBOX_EXCERPT_BYTES;
    const project = (
      owner: string | undefined,
      row: (typeof lists)[number]['rows'][number],
      bytes: number,
    ): InboxRequest => {
      const message = this.parse(row.message);
      const text = options.redact ? options.redact(message.text) : message.text;
      const { excerpt, truncated } = clipText(text, bytes);
      return {
        id: message.id,
        taskId: message.taskId,
        createdAt: message.createdAt,
        ...(message.supersedes ? { supersedes: message.supersedes } : {}),
        excerpt,
        truncated,
        textBytes: Buffer.byteLength(message.text, 'utf8'),
        version: this.h.store.discussionVersion(owner, message.taskId),
        ...(row.reopened ? { reopened: row.reopened } : {}),
      };
    };
    const items: InboxRequest[] = [];
    const next = { ...positions };
    while (items.length < v.limit) {
      const heads = lists.filter((l) => l.at < l.rows.length);
      if (!heads.length) break;
      const list = heads.reduce((a, b) =>
        b.rows[b.at].at < a.rows[a.at].at || (b.rows[b.at].at === a.rows[a.at].at && b.key < a.key)
          ? b
          : a,
      );
      const row = list.rows[list.at];
      let item = project(list.owner, row, excerptBytes);
      if (!checkJsonBytes([...items, item], maxBytes).within) {
        if (items.length) break;
        // Первая запись страницы выдаётся всегда — с выдержкой короче, а
        // если и без выдержки не помещается, предел меньше записи очереди.
        for (let bytes = excerptBytes >> 1; ; bytes >>= 1) {
          item = project(list.owner, row, bytes);
          if (checkJsonBytes([item], maxBytes).within) break;
          if (!bytes) throw new DomainError('Предел страницы меньше записи очереди обращений', 413);
        }
      }
      items.push(item);
      next[list.key] = row.position;
      list.at++;
    }
    const more = lists.some((l) => l.at < l.rows.length);
    return {
      requests: items,
      ...(more
        ? { nextCursor: Buffer.from(JSON.stringify(next), 'utf8').toString('base64url') }
        : {}),
    };
  }

  /**
   * Владелец-представитель каждой схемы хранения: одна схема — один список.
   * Первый владелец схемы (`@workspace` или id репозитория): имя схемы
   * зависит от порядка репозиториев в конфигурации, владелец — нет.
   */
  private schemaOwners() {
    const schemas = new Map<string, string | undefined>();
    for (const owner of [undefined, ...repositories(this.h.config).map((r) => r.id)]) {
      const schema = this.h.store.discussionSchema(owner);
      if (!schemas.has(schema)) schemas.set(schema, owner);
    }
    return [...schemas.values()];
  }

  /**
   * Обращения, по которым ведущий попросил ответа оператора и ответа ещё нет
   * (дополнение `reopened` очереди ведущего), по всем схемам хранения.
   */
  awaitingOperator(limit: number) {
    return this.schemaOwners().flatMap((owner) =>
      this.h.store.discussionAwaitingOperator(owner, limit).map((row) => {
        const request = this.parse(row.message);
        return {
          owner,
          request,
          dispositionId: row.dispositionId,
          at: row.at,
          /** Версия треда — `expectedVersion` ответа оператора. */
          version: this.h.store.discussionVersion(owner, request.taskId),
        };
      }),
    );
  }

  /** Обработки обращений по всем схемам хранения (история центра внимания). */
  dispositions(limit: number) {
    return this.schemaOwners().flatMap((owner) =>
      this.h.store.discussionDispositions(owner, limit).map((row) => ({
        owner,
        disposition: this.parse(row.message),
        answeredAt: row.answeredAt,
        correctedAt: row.correctedAt,
      })),
    );
  }

  /** Цепочка исправлений обращения: первое сообщение и последняя обработка. */
  chain(owner: string | undefined, id: string) {
    return this.h.store.discussionChain(owner, id);
  }

  /**
   * Ответ на вопрос исполнителя сообщением обсуждения. Одна транзакция:
   * повтор по ключу — прежнее сообщение; ответ записывается в запрос harness
   * (`InputService.answer`, правило актёра — там же) со ссылкой на это
   * сообщение (`messageRef`), а сообщение хранит ссылку на версию ответа без
   * текста. CAS — версия запроса, а не треда. Поздний ответ (запрос снят
   * или заменён) сохраняется историей обсуждения с текстом и
   * `accepted: false` и задачу не возобновляет; применённый ответ не
   * исправляется (409: изменение — обращением к ведущему).
   */
  answer(
    v: {
      taskId: string;
      requestId: string;
      text: string;
      idempotencyKey: string;
      expectedVersion: number;
      optionId?: string;
      kind?: 'clarification' | 'requirement-change';
      supersedes?: string;
      replyTo?: string;
    },
    author: Exclude<Author, 'runtime'>,
  ) {
    const payloadDigest = digest({
      taskId: v.taskId,
      author,
      kind: 'answer',
      text: v.text,
      requestId: v.requestId,
      optionId: v.optionId ?? null,
      answerKind: v.kind ?? 'clarification',
      replyTo: v.replyTo ?? null,
      supersedes: v.supersedes ?? null,
    });
    const inputs = new InputService(this.h);
    return this.h.store.atomic(() => {
      const state = this.h.store.read();
      const task = this.task(state, v.taskId);
      const owner = taskOwner(task);
      const same = this.h.store.discussionByKey(owner, v.taskId, author, v.idempotencyKey);
      if (same) {
        const existing = this.parse(same);
        if (existing.payloadDigest !== payloadDigest)
          throw new DomainError('Ключ запроса уже использован другим сообщением', 409, {
            code: 'idempotency-conflict',
          });
        return {
          message: existing,
          version: this.h.store.discussionVersion(owner, v.taskId),
          delivered: !!existing.input && !('accepted' in existing.input),
        };
      }
      const request = inputs.show({ requestId: v.requestId });
      if (request.taskId !== v.taskId)
        throw new DomainError(`Запрос ${v.requestId} не относится к задаче ${v.taskId}`, 404);
      for (const ref of [v.replyTo, v.supersedes]) {
        if (!ref) continue;
        const target = this.h.store.discussionById(owner, ref) as { taskId?: string } | undefined;
        if (!target || target.taskId !== v.taskId)
          throw new DomainError('Ссылка на сообщение другой задачи или несуществующее', 400);
      }
      if (v.supersedes) {
        const target = this.parse(this.h.store.discussionById(owner, v.supersedes));
        if (target.author !== author || target.kind !== 'answer')
          throw new DomainError('Исправить можно только свой ответ', 403);
        if (target.input?.requestId !== v.requestId)
          throw new DomainError('Исправление ответа — ответ на тот же вопрос', 400);
        if (this.h.store.discussionSupersededBy(owner, v.supersedes))
          throw new DomainError('Ответ уже исправлен: исправьте его новую версию', 409, {
            code: 'already-superseded',
          });
      }
      const id = 'DM-' + randomUUID();
      let input: NonNullable<DiscussionMessage['input']>;
      try {
        const saved = inputs.answer(
          {
            requestId: v.requestId,
            text: v.text,
            ...(v.optionId ? { optionId: v.optionId } : {}),
            ...(v.kind ? { kind: v.kind } : {}),
            expectedVersion: v.expectedVersion,
          },
          author,
          { messageRef: id },
        );
        input = {
          requestId: v.requestId,
          revision: saved.revision,
          answerDigest: saved.answerDigest,
        };
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== 'NOT_READY') throw error;
        const lifecycle = inputs.show({ requestId: v.requestId }).lifecycle;
        if (lifecycle === 'applied')
          throw new DomainError(
            `Ответ на запрос ${v.requestId} уже применён: изменение — обращение к ведущему (change-request)`,
            409,
            { code: 'answer-applied' },
          );
        // Поздний ответ — только к снятому или заменённому вопросу; иной отказ
        // NOT_READY остаётся отказом.
        if (lifecycle !== 'cancelled' && lifecycle !== 'superseded') throw error;
        input = { requestId: v.requestId, accepted: false, lifecycle };
      }
      const late = 'accepted' in input;
      const latest = state.runs.filter((r) => r.taskId === v.taskId).at(-1);
      const record = {
        id,
        taskId: v.taskId,
        threadId: v.taskId,
        author,
        kind: 'answer' as const,
        // Принятый ответ — текст в запросе harness; поздний — только здесь.
        ...(late ? { text: v.text } : {}),
        createdAt: new Date().toISOString(),
        ...(v.replyTo ? { replyTo: v.replyTo } : {}),
        ...(v.supersedes ? { supersedes: v.supersedes } : {}),
        basis: { specDigest: specDigest(task), ...(latest ? { runId: latest.id } : {}) },
        idempotencyKey: v.idempotencyKey,
        payloadDigest,
        input,
      };
      const seq = this.h.store.discussionInsert(
        owner,
        {
          id,
          taskId: v.taskId,
          author,
          idempotencyKey: v.idempotencyKey,
          kind: 'answer',
          ...(v.replyTo ? { replyTo: v.replyTo } : {}),
        },
        record,
      );
      this.h.store.appendEvent('discussion.posted', {
        taskId: v.taskId,
        messageId: id,
        kind: 'answer',
        author,
        requestId: v.requestId,
        accepted: !late,
      });
      return { message: this.parse({ ...record, seq }), version: seq, delivered: !late };
    });
  }

  private find(id: string) {
    const owners = [undefined, ...repositories(this.h.config).map((r) => r.id)];
    for (const owner of owners) {
      const row = this.h.store.discussionById(owner, id);
      if (row) return this.parse(row);
    }
    return undefined;
  }

  private append(
    taskId: string,
    author: Author,
    input: {
      kind: DiscussionMessage['kind'];
      text: string;
      idempotencyKey: string;
      expectedVersion: number;
      replyTo?: string;
      supersedes?: string;
      disposition?: DiscussionMessage['disposition'];
      check?: (owner: string | undefined) => void;
    },
  ) {
    const payload = {
      taskId,
      author,
      kind: input.kind,
      text: input.text,
      replyTo: input.replyTo ?? null,
      supersedes: input.supersedes ?? null,
      disposition: input.disposition ?? null,
    };
    const payloadDigest = digest(payload);
    return this.h.store.atomic(() => {
      const state = this.h.store.read();
      const task: Task = this.task(state, taskId);
      const owner = taskOwner(task);
      // Повтор того же запроса (двойной клик, вторая вкладка, повтор после
      // timeout) возвращает прежнюю запись; другой payload под ключом — отказ.
      const same = this.h.store.discussionByKey(owner, taskId, author, input.idempotencyKey);
      if (same) {
        const existing = this.parse(same);
        if (existing.payloadDigest !== payloadDigest)
          throw new DomainError('Ключ запроса уже использован другим сообщением', 409, {
            code: 'idempotency-conflict',
          });
        return { message: existing, version: this.h.store.discussionVersion(owner, taskId) };
      }
      const version = this.h.store.discussionVersion(owner, taskId);
      if (version !== input.expectedVersion)
        throw new DomainError('Обсуждение изменилось; перечитайте его', 409, {
          code: 'version-conflict',
          version,
        });
      for (const ref of [input.replyTo, input.supersedes]) {
        if (!ref) continue;
        const target = this.h.store.discussionById(owner, ref) as { taskId?: string } | undefined;
        if (!target || target.taskId !== taskId)
          throw new DomainError('Ссылка на сообщение другой задачи или несуществующее', 400);
      }
      if (input.supersedes) {
        const target = this.parse(this.h.store.discussionById(owner, input.supersedes));
        if (target.author !== author)
          throw new DomainError('Исправить можно только своё сообщение', 403);
        if (target.kind === 'disposition')
          throw new DomainError('Обработка обращения не исправляется: запишите новую', 400);
        // История линейна: исправляется только последняя версия сообщения.
        if (this.h.store.discussionSupersededBy(owner, input.supersedes))
          throw new DomainError('Сообщение уже исправлено: исправьте его новую версию', 409, {
            code: 'already-superseded',
          });
      }
      input.check?.(owner);
      const latest = state.runs.filter((r) => r.taskId === taskId).at(-1);
      const id = 'DM-' + randomUUID();
      const record = {
        id,
        taskId,
        threadId: taskId,
        author,
        kind: input.kind,
        text: input.text,
        createdAt: new Date().toISOString(),
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        ...(input.supersedes ? { supersedes: input.supersedes } : {}),
        basis: { specDigest: specDigest(task), ...(latest ? { runId: latest.id } : {}) },
        idempotencyKey: input.idempotencyKey,
        payloadDigest,
        ...(input.disposition ? { disposition: input.disposition } : {}),
      };
      const seq = this.h.store.discussionInsert(
        owner,
        {
          id,
          taskId,
          author,
          idempotencyKey: input.idempotencyKey,
          kind: input.kind,
          ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        },
        record,
      );
      // Журнал — только идентификаторы: текст обсуждения не попадает в общие
      // события и отчёты.
      this.h.store.appendEvent('discussion.posted', {
        taskId,
        messageId: id,
        kind: input.kind,
        author,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      });
      const message = discussionMessage.parse({ ...record, seq });
      return { message, version: seq };
    });
  }
}

/** Текст длиннее предела — явный 413, как обещает договор, а не ошибка схемы. */
function tooLong(raw: unknown) {
  if (textTooLong(raw))
    throw new DomainError(`Сообщение больше ${DISCUSSION_TEXT_BYTES} байт UTF-8`, 413);
}

/** Байт JSON-вида текста в ответе агентской записи: полный текст ведущий прислал сам. */
export const WRITE_REPLY_TEXT_BYTES = 2000;

/**
 * Ответ записи в агентском API ограничен независимо от длины текста: запись
 * уже зафиксирована, и предел ответа не должен превращать её в ошибку.
 * Полный текст — `discussion_read`.
 */
export function boundedWrite(result: { message: DiscussionMessage; version: number }) {
  const { excerpt, truncated } = clipText(result.message.text, WRITE_REPLY_TEXT_BYTES);
  return {
    message: { ...result.message, text: excerpt },
    ...(truncated
      ? { textTruncated: true, textBytes: Buffer.byteLength(result.message.text, 'utf8') }
      : {}),
    version: result.version,
  };
}
