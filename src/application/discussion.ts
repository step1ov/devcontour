import { randomUUID } from 'node:crypto';
import { checkJsonBytes } from 'devcontour-harness';
import { DomainError, type DevContourState, type Task } from '../core/model.ts';
import { digest, specDigest, type DevContour } from '../core/service.ts';
import { repositories } from '../core/repositories.ts';
import { taskOwner } from '../core/sync-state.ts';
import {
  DISCUSSION_PAGE_BYTES,
  discussionInputs,
  discussionMessage,
  type DiscussionMessage,
} from '../core/discussion-model.ts';

type Author = DiscussionMessage['author'];

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
      const message = discussionMessage.parse(row);
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

  /** Заметка или обращение к ведущему от `author`. */
  post(raw: unknown, author: Exclude<Author, 'runtime'>) {
    const v = discussionInputs.discussion_post.parse(raw);
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
    const v = discussionInputs.discussion_resolve.parse(raw);
    const request = this.find(v.requestId);
    if (!request || request.kind !== 'change-request')
      throw new DomainError('Обращение не найдено', 404);
    const state = this.h.store.read();
    if (v.outcome === 'accepted') {
      // Принятие ссылается на настоящую новую работу: ревизию доски или
      // задачи, созданные после обращения.
      if (!v.refs.boardId && !v.refs.taskIds?.length)
        throw new DomainError('Принятое обращение ссылается на ревизию доски или задачи', 400);
      if (v.refs.boardId) {
        const board = state.boards.find((b) => b.id === v.refs.boardId);
        const revision = board?.revisions[(v.refs.revision ?? board.revisions.length) - 1];
        if (!revision) throw new DomainError('Ревизия доски не найдена', 404);
        if (revision.createdAt <= request.createdAt)
          throw new DomainError('Ревизия старше обращения: изменение ещё не внесено', 409);
      }
      for (const id of v.refs.taskIds ?? []) {
        const t = state.tasks.find((x) => x.id === id);
        if (!t) throw new DomainError('Задача не найдена: ' + id, 404);
        if (t.createdAt <= request.createdAt)
          throw new DomainError('Задача старше обращения: изменение ещё не внесено: ' + id, 409);
      }
    }
    return this.append(request.taskId, 'lead', {
      kind: 'disposition',
      text: v.reason,
      replyTo: request.id,
      idempotencyKey: v.idempotencyKey,
      expectedVersion: v.expectedVersion,
      disposition: { outcome: v.outcome, refs: v.refs },
    });
  }

  /** Необработанные обращения к ведущему по всем задачам, старые первыми. */
  inbox(raw: unknown, maxBytes = DISCUSSION_PAGE_BYTES) {
    const v = discussionInputs.discussion_inbox.parse(raw);
    // Cursor — seq последней выданной записи у каждого владельца.
    let positions: Record<string, number> = {};
    if (v.cursor)
      try {
        positions = JSON.parse(Buffer.from(v.cursor, 'base64url').toString('utf8')) as Record<
          string,
          number
        >;
      } catch {
        throw new DomainError('Некорректный cursor', 409);
      }
    const owners = [undefined, ...repositories(this.h.config).map((r) => r.id)];
    const keyOf = (owner?: string) => owner ?? '@workspace';
    const candidates = owners
      .flatMap((owner) =>
        this.h.store
          .discussionPending(owner, positions[keyOf(owner)] ?? 0, v.limit)
          .map((row) => ({ owner, message: discussionMessage.parse(row) })),
      )
      // В центральном хранилище владельцы делят одну таблицу: запись — один раз.
      .filter((c, i, all) => all.findIndex((x) => x.message.id === c.message.id) === i)
      .sort((a, b) => a.message.createdAt.localeCompare(b.message.createdAt));
    const items: { owner?: string; message: DiscussionMessage }[] = [];
    for (const c of candidates.slice(0, v.limit)) {
      if (!checkJsonBytes([...items, c], maxBytes).within) break;
      items.push(c);
    }
    const next = { ...positions };
    for (const { owner, message } of items)
      next[keyOf(owner)] = Math.max(next[keyOf(owner)] ?? 0, message.seq);
    const more = items.length < candidates.length;
    return {
      requests: items.map((i) => i.message),
      ...(more
        ? { nextCursor: Buffer.from(JSON.stringify(next), 'utf8').toString('base64url') }
        : {}),
    };
  }

  private find(id: string) {
    const owners = [undefined, ...repositories(this.h.config).map((r) => r.id)];
    for (const owner of owners) {
      const row = this.h.store.discussionById(owner, id);
      if (row) return discussionMessage.parse(row);
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
        const existing = discussionMessage.parse(same);
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
        const target = discussionMessage.parse(
          this.h.store.discussionById(owner, input.supersedes),
        );
        if (target.author !== author)
          throw new DomainError('Исправить можно только своё сообщение', 403);
      }
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
