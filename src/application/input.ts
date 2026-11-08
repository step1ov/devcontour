// Вопросы исполнителя (H02) в DevContour: одна служба за агентскими
// операциями, CLI и маршрутами панели. Правила запроса (версии, ответы,
// применение, перенос) — движок harness; здесь — кто вправе действовать,
// снимок контекста с ответом, раунд его ревью и проекции без текста.
//
// Шов обсуждения (D02): ответ может нести `messageRef` — ID сообщения
// обсуждения, а снимок — выбранные сообщения (`messages`). Канонический
// текст ответа живёт один раз — в запросе harness.
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { z } from 'zod';
import {
  HarnessError,
  INPUT_LIMITS,
  WORKSPACE_OWNER,
  blocksWork,
  contextDigest,
  contextIssues,
  inputContextSource,
  inputManifestOf,
  inputSourceId,
  latestAnswer,
  linksAnswer,
  technicalReview,
  withInput,
  type ContextSnapshot,
  type ExecutionView,
  type InputMessageRef,
  type InputRequest,
} from 'devcontour-harness';
import { DomainError, type Task } from '../core/model.ts';
import { hrefs } from './panel-links.ts';
import type { DevContour } from '../core/service.ts';
import { executionOf, reviewExecutionOf, toDomain } from '../harness/execution.ts';
import { devcontourContextSource, pinnedSnapshot, taskPacks } from '../harness/host.ts';
import {
  activeInputContext,
  inputReviewDigest,
  inputReviewRounds,
  inputReviewSubject,
} from '../harness/input-host.ts';
import { runtimeAdapters } from '../harness/adapters.ts';
import { boardOf, UNASSIGNED_GRAPH } from '../harness/projection.ts';
import { adapters, type AgentAdapter } from '../runner/adapters.ts';
import { checkoutRoots } from '../runner/checkout-root.ts';
import { DiscussionService } from './discussion.ts';
import { questionStops, REPEATED_QUESTION_STOPS } from '../core/input-labels.ts';

/** Кто действует: ведущий агент (агентский API), оператор (панель) или хост от его имени (CLI `--by host`). */
export type InputActorKind = 'lead' | 'operator' | 'host';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const requestId = z.string().regex(/^IR-[a-f0-9]{24}$/, 'Ожидается ID запроса IR-<24 hex>');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().positive();

export const inputStates = [
  'awaiting-answer',
  'answer-saved',
  'context-review',
  'review-rejected',
  'ready-to-apply',
  'applied-awaiting-claim',
  'delivered',
  'stale',
  'cancelled',
  'superseded',
] as const;
export type InputState = (typeof inputStates)[number];

export const inputOperationInputs = {
  input_list: z.strictObject({
    taskId: id.optional(),
    repositoryId: id.optional(),
    state: z.enum(inputStates).optional(),
  }),
  input_show: z.strictObject({ requestId }),
  input_answer: z.strictObject({
    requestId,
    text: z.string().trim().min(1).max(INPUT_LIMITS.answer),
    optionId: z.string().max(40).optional(),
    kind: z.enum(['clarification', 'requirement-change']).default('clarification'),
    expectedVersion: version,
  }),
  input_context: z.strictObject({
    requestId,
    /** Сообщения обсуждения задачи, явно включённые в manifest снимка (кроме самих ответов). */
    messageIds: z
      .array(z.string().regex(/^DM-[0-9a-f-]{36}$/))
      .max(20)
      .optional(),
  }),
  input_review: z.strictObject({
    requestId,
    contextDigest: digest,
    authorRuntime: z.enum(['codex', 'claude']),
  }),
  input_target: z.strictObject({ requestId, contextDigest: digest }),
  input_apply: z.strictObject({
    requestId,
    answerDigest: digest,
    expectedVersion: version,
    contextDigest: digest,
    targetDigest: digest,
    reset: z.strictObject({ reason: z.string().trim().min(10).max(2000) }).optional(),
  }),
  input_cancel: z.strictObject({
    requestId,
    expectedVersion: version,
    reason: z.string().trim().min(3).max(1000),
  }),
  input_supersede: z.strictObject({
    requestId,
    expectedVersion: version,
    reason: z.string().trim().min(3).max(1000),
    successorTaskId: id,
  }),
};

/** Ответ оператора из панели (сообщение обсуждения с ключом идемпотентности). */
const panelAnswer = z.strictObject({
  text: z.string().trim().min(1).max(INPUT_LIMITS.answer),
  optionId: z.string().max(40).optional(),
  kind: z.enum(['clarification', 'requirement-change']).optional(),
  expectedVersion: version,
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,80}$/)
    .optional(),
  supersedes: z
    .string()
    .regex(/^DM-[0-9a-f-]{36}$/)
    .optional(),
});

/** Сколько последних раундов ревью ответа показывает `show`. */
const REVIEW_ROUNDS_SHOWN = 5;

/** Сколько знаков прежних ответов показывает `show` (последний — целиком). */
const EARLIER_EXCERPT = 500;

/** Локальные записи аренды ревью ответа (`local_workflow`), ключ — ID запроса. */
const REVIEW_LEASE = 'input-review-lease';
type InputReviewLease = { token: string; startedAt: string; leaseUntil: number };

const refuse = (code: string, message: string, status = 409) => {
  const error = new DomainError(message, status);
  (error as DomainError & { code?: string }).code = code;
  return error;
};

/** Задача с блокирующим вопросом → ID запроса: выдача, `ready` и блокеры их не пускают. */
export function inputHolds(h: DevContour): Map<string, string> {
  const { engine } = executionOf(h);
  const holds = new Map<string, string>();
  for (const r of engine.inputRequests()) if (blocksWork(r)) holds.set(r.workId, r.id);
  return holds;
}

export class InputService {
  constructor(
    readonly h: DevContour,
    /** Каталог данных контура: артефакты раундов ревью ответа. */
    readonly root?: string,
    /** Runtime ревью ответа (тесты передают управляемые адаптеры). */
    readonly runtimes: Record<string, AgentAdapter> = adapters,
  ) {}

  private get engine() {
    return executionOf(this.h).engine;
  }

  private request(id: string): InputRequest {
    try {
      return this.engine.inputRequest(id);
    } catch (error) {
      throw toDomain(error);
    }
  }

  private task(taskId: string): Task {
    const task = this.h.store.read().tasks.find((t) => t.id === taskId);
    if (!task) throw new DomainError('Задача не найдена: ' + taskId, 404);
    return task;
  }

  private boardOf(taskId: string) {
    return this.h.store
      .read()
      .boards.find((b) => b.revisions.some((r) => r.taskIds.includes(taskId)));
  }

  /**
   * Ведущий (агентский API или CLI `--by host`) отвечает и снимает вопрос
   * сам, только если вопрос без минимумов и режим `agent` (Q7, R7-1).
   */
  leadMayDecide(request: Pick<InputRequest, 'floors'>) {
    return request.floors.length === 0 && this.h.config.approvalMode === 'agent';
  }

  /* -------------------------------------------------------------- */
  /* Проекции                                                         */
  /* -------------------------------------------------------------- */

  /** Состояние запроса для панели и ведущего: только из записей, без вызова модели. */
  stateOf(
    view: ExecutionView,
    request: InputRequest,
    task?: Task,
  ): {
    state: InputState;
    approved?: boolean;
    round?: number;
    problems?: string[];
  } {
    if (request.lifecycle === 'pending') return { state: 'awaiting-answer' };
    if (request.lifecycle === 'cancelled') return { state: 'cancelled' };
    if (request.stale && !request.target && blocksWork(request)) return { state: 'stale' };
    if (linksAnswer(request))
      return { state: request.delivered ? 'delivered' : 'applied-awaiting-claim' };
    if (request.lifecycle === 'superseded') return { state: 'superseded' };
    if (request.lifecycle === 'applied')
      return { state: request.delivered ? 'delivered' : 'applied-awaiting-claim' };
    // answered
    const answer = latestAnswer(request);
    const last = inputReviewRounds(view, request.id).at(-1);
    if (
      !answer ||
      !task ||
      !last ||
      last.digest !== inputReviewDigest(this.h, task, request.id, answer.digest)
    )
      return { state: 'answer-saved' };
    // Отклонённое ревью — своё состояние: в режиме оператора применить его
    // можно, но только осознанно (вердикт и находки видны, нужно подтверждение).
    if (!last.approved) {
      const proposed =
        this.h.config.approvalMode === 'operator'
          ? this.engine.proposeTarget(request.id, last.contextDigest ?? null).problems
          : [];
      return {
        state: 'review-rejected',
        approved: false,
        round: last.round,
        ...(proposed.length ? { problems: proposed } : {}),
      };
    }
    const proposed = this.engine.proposeTarget(request.id, last.contextDigest ?? null);
    if (!proposed.problems.length)
      return { state: 'ready-to-apply', approved: true, round: last.round };
    return {
      state: 'context-review',
      approved: true,
      round: last.round,
      problems: proposed.problems,
    };
  }

  /** Кто действует следующим и что делает. */
  private nextOf(request: InputRequest, state: InputState) {
    const agent = this.h.config.approvalMode === 'agent';
    const lead = this.leadMayDecide(request);
    switch (state) {
      case 'awaiting-answer':
        return request.kind === 'follow-up'
          ? {
              actor: 'lead' as const,
              next: 'input_cancel (assumption accepted) or input_supersede',
            }
          : lead
            ? { actor: 'lead' as const, next: 'input_answer, or the operator answers in the panel' }
            : {
                actor: 'operator' as const,
                next: `answer in the panel: ${hrefs.input(request.workId)}`,
              };
      case 'answer-saved':
      case 'stale':
        return {
          actor: 'lead' as const,
          next:
            state === 'stale'
              ? 'rebuild the context: input_context, input_review, input_target, input_apply'
              : 'input_context, then input_review, input_target, input_apply',
        };
      case 'context-review':
      case 'ready-to-apply':
        return agent
          ? { actor: 'lead' as const, next: 'input_target, then input_apply' }
          : {
              actor: 'operator' as const,
              next: `apply in the panel: ${hrefs.input(request.workId)}`,
            };
      case 'review-rejected':
        return agent && lead
          ? {
              actor: 'lead' as const,
              next: 'the reviewer rejected the answer: read the findings (input_show); correct the answer, or reopen and respecify the task',
            }
          : agent
            ? {
                actor: 'operator' as const,
                next: `the reviewer rejected the answer to a question the lead may not decide: the operator reads the findings and corrects the answer in the panel (${hrefs.input(request.workId)})`,
              }
            : {
                actor: 'operator' as const,
                next: `the reviewer rejected the answer: read the findings in the panel (${hrefs.input(request.workId)}); correct the answer, or apply only with explicit confirmation`,
              };
      case 'applied-awaiting-claim':
        return { actor: 'lead' as const, next: 'wait for the next attempt of the task' };
      default:
        return { actor: 'lead' as const, next: 'none' };
    }
  }

  /** Сводка запроса без текста вопроса и ответов. */
  private summary(view: ExecutionView, request: InputRequest) {
    const current = this.h.store.read();
    const task = current.tasks.find((t) => t.id === request.workId);
    const state = this.stateOf(view, request, task);
    // Повторные остановки вопросом по задаче: сигнал оператору и ведущему.
    const stops = questionStops(
      current.runs.filter((r) => r.taskId === request.workId),
      this.h.config.maxAttempts,
    );
    return {
      requestId: request.id,
      taskId: request.workId,
      boardId: this.boardOf(request.workId)?.id ?? null,
      repositoryId: task?.repositoryId ?? null,
      kind: request.kind,
      blocking: request.blocking,
      lifecycle: request.lifecycle,
      ...state,
      version: request.version,
      severity: request.effectiveSeverity,
      floors: request.floors,
      criticalHits: request.criticalHits.length,
      ...(request.normalized ? { normalized: true } : {}),
      ...(request.stale ? { stale: { reason: request.stale.reason, at: request.stale.at } } : {}),
      answers: request.answers.length,
      createdAt: request.createdAt,
      ...(stops.count >= REPEATED_QUESTION_STOPS
        ? {
            questionStops: {
              count: stops.count,
              limit: stops.limit,
              exhausted: stops.exhausted,
            },
          }
        : {}),
      ...this.nextOf(request, state.state),
    };
  }

  list(raw: unknown = {}) {
    const input = inputOperationInputs.input_list.parse(raw);
    const { engine } = executionOf(this.h);
    try {
      const requests = engine.inputRequests(input.taskId ? { workId: input.taskId } : {});
      return engine.read((view) => {
        const all = requests.map((r) => this.summary(view, r));
        return {
          requests: all.filter(
            (r) =>
              (!input.repositoryId || r.repositoryId === input.repositoryId) &&
              (!input.state || r.state === input.state),
          ),
        };
      });
    } catch (error) {
      throw toDomain(error);
    }
  }

  /** Запрос целиком: последний ответ полностью, прежние — digest и начало (Q9). */
  show(raw: unknown) {
    const { requestId: rid } = inputOperationInputs.input_show.parse(raw);
    const request = this.request(rid);
    const { engine } = executionOf(this.h);
    return engine.read((view) => {
      const last = request.answers.length;
      return {
        ...this.summary(view, request),
        question: request.question,
        draft: request.draft,
        criticalPaths: request.criticalHits,
        ...(request.normalized ? { normalizedFields: request.normalized } : {}),
        answers: request.answers.map((a, i) =>
          i + 1 === last
            ? a
            : {
                revision: a.revision,
                kind: a.kind,
                optionId: a.optionId,
                actor: a.actor,
                ...(a.messageRef ? { messageRef: a.messageRef } : {}),
                digest: a.digest,
                at: a.at,
                excerpt: a.text.slice(0, EARLIER_EXCERPT),
                clipped: a.text.length > EARLIER_EXCERPT,
              },
        ),
        // Последние раунды (не больше пяти): вердикт, итог и открытые находки
        // последнего — ответ остаётся в пределе агентского API.
        reviews: inputReviewRounds(view, rid)
          .slice(-REVIEW_ROUNDS_SHOWN)
          .map((r, i, all) => ({
            round: r.round,
            approved: r.approved,
            contextDigest: r.contextDigest ?? null,
            summary: r.summary.slice(0, 1000),
            at: r.at,
            ...(i === all.length - 1
              ? {
                  findings: r.findings
                    .filter((f) => f.status === 'open')
                    .slice(0, 10)
                    .map((f) => ({ severity: f.severity, message: f.message.slice(0, 500) })),
                }
              : {}),
          })),
        ...(request.target ? { target: request.target } : {}),
        ...(request.delivered ? { delivered: request.delivered } : {}),
        ...(request.closed ? { closed: request.closed } : {}),
      };
    });
  }

  /* -------------------------------------------------------------- */
  /* Ответ, отмена, замена                                            */
  /* -------------------------------------------------------------- */

  answer(raw: unknown, actor: InputActorKind, link: { messageRef?: string } = {}) {
    const input = inputOperationInputs.input_answer.parse(raw);
    const request = this.request(input.requestId);
    if (actor !== 'operator' && !this.leadMayDecide(request))
      throw refuse(
        'OPERATOR_ANSWERS',
        request.floors.length
          ? `Вопрос ${request.id} критический (${request.floors.join(', ')}): отвечает оператор в панели`
          : `В approvalMode operator на вопрос ${request.id} отвечает оператор в панели`,
        403,
      );
    try {
      const result = this.engine.answerInput(
        request.id,
        {
          text: input.text,
          optionId: input.optionId ?? null,
          kind: input.kind,
          actor: { kind: actor },
          ...(link.messageRef ? { messageRef: link.messageRef } : {}),
        },
        input.expectedVersion,
      );
      return {
        requestId: request.id,
        lifecycle: result.request.lifecycle,
        version: result.request.version,
        revision: result.answer.revision,
        answerDigest: result.answer.digest,
        changed: result.changed,
        ...(result.answer.kind === 'requirement-change'
          ? {
              nextStep:
                'requirement change: reopen and respecify the task (devcontour reopen, task_edit), approve it, then input_supersede with the same task and carry the answer (input_context, input_review, input_target, input_apply)',
            }
          : { nextStep: 'input_context' }),
      };
    } catch (error) {
      throw toDomain(error);
    }
  }

  cancel(raw: unknown, actor: InputActorKind) {
    const input = inputOperationInputs.input_cancel.parse(raw);
    const request = this.request(input.requestId);
    // R7-1: снять блокирующий вопрос — то же право, что ответить на него.
    // Неблокирующий запрос ведущему (follow-up) ведущий закрывает сам.
    if (actor !== 'operator' && request.blocking && !this.leadMayDecide(request))
      throw refuse(
        'OPERATOR_ANSWERS',
        `Вопрос ${request.id} снимает оператор в панели: ${
          request.floors.length ? 'вопрос критический' : 'approvalMode operator'
        }`,
        403,
      );
    try {
      const result = this.engine.cancelInput(
        request.id,
        { by: actor, reason: input.reason },
        input.expectedVersion,
      );
      return {
        requestId: request.id,
        lifecycle: result.request.lifecycle,
        version: result.request.version,
        changed: result.changed,
      };
    } catch (error) {
      throw toDomain(error);
    }
  }

  /**
   * Заменить вопрос преемником (изменение требований). Блокирующий вопрос —
   * той же задачей после изменения её собственной постановки (черновик,
   * новая постановка, затем замена и перенос ответа): пока постановка
   * прежняя — 409 `SPEC_UNCHANGED`, ведущему без права ответа — 403
   * `OPERATOR_ANSWERS`. Неблокирующий follow-up можно заменить и новой
   * задачей той же доски, созданной после него (например, заменой из
   * корректировки доски).
   */
  supersede(raw: unknown, actor: InputActorKind) {
    const input = inputOperationInputs.input_supersede.parse(raw);
    const request = this.request(input.requestId);
    const state = this.h.store.read();
    const successor = state.tasks.find((t) => t.id === input.successorTaskId);
    if (!successor) throw new DomainError('Преемник не найден: ' + input.successorTaskId, 404);
    const open = request.lifecycle === 'pending' || request.lifecycle === 'answered';
    // Замена снимает блокировку так же, как отмена: то же право, что ответить
    // (R7-1). Иначе ведущий обошёл бы правило оператора заменой и task_retry.
    if (open && actor !== 'operator' && request.blocking && !this.leadMayDecide(request))
      throw refuse(
        'OPERATOR_ANSWERS',
        `Вопрос ${request.id} заменяет оператор: ${
          request.floors.length ? 'вопрос критический' : 'approvalMode operator'
        }`,
        403,
      );
    // Пока исходная остановка держится (постановка задачи прежняя, задача на
    // попытке вопроса), продолжение — только ответ и applyInput. Замена
    // освободила бы задачу для повтора без ответа.
    if (open && request.blocking && !this.specChanged(request))
      throw refuse(
        'SPEC_UNCHANGED',
        `Постановка задачи ${request.workId} не изменилась после вопроса ${request.id} (в том числе в черновике): ответьте и примените ответ, снимите вопрос (оператор) или верните задачу в черновик, измените постановку и затем замените вопрос той же задачей`,
        409,
      );
    const sameTask = successor.id === request.workId;
    const board = this.boardOf(request.workId);
    const onBoard = board?.revisions.some((r) => r.taskIds.includes(successor.id));
    if (!sameTask && (!onBoard || successor.createdAt < request.createdAt))
      throw new DomainError(
        `Преемник ${successor.id} должен быть задачей той же доски, созданной после вопроса ${request.id} (корректировка или новая редакция)`,
        409,
      );
    try {
      const result = this.engine.supersedeInput(
        request.id,
        { by: actor, reason: input.reason, successor: successor.id },
        input.expectedVersion,
      );
      return {
        requestId: request.id,
        lifecycle: result.request.lifecycle,
        version: result.request.version,
        successor: successor.id,
        carry: result.request.closed?.carry ?? false,
        changed: result.changed,
      };
    } catch (error) {
      throw toDomain(error);
    }
  }

  /**
   * Постановка задачи изменилась после вопроса — правило движка: перенос
   * изменения требований разрешён ровно тогда, когда изменилось содержание
   * постановки самой задачи (`carryAllowed`); для проверки берётся сам
   * запрос как заменённый с ответом вида «изменение требований».
   */
  private specChanged(request: InputRequest) {
    const { engine } = executionOf(this.h);
    const probe: InputRequest = {
      ...request,
      lifecycle: 'superseded',
      answers: [
        {
          revision: 1,
          text: 'probe',
          optionId: null,
          kind: 'requirement-change',
          actor: { kind: 'host' },
          digest: '0'.repeat(64),
          at: request.createdAt,
        },
      ],
    };
    return engine.read((view) => engine.carryAllowed(view, probe));
  }

  /* -------------------------------------------------------------- */
  /* Снимок с ответом, ревью, цель, применение                        */
  /* -------------------------------------------------------------- */

  /** Действующий снимок задачи: активированный снимок с ответами или закреплённые пакеты. */
  private async effectiveSnapshot(task: Task): Promise<ContextSnapshot | undefined> {
    const { store } = executionOf(this.h);
    const active = activeInputContext(task);
    if (active) {
      const snapshot = pinnedSnapshot(store, active.digest);
      if (!snapshot)
        throw new DomainError(
          `Снимок контекста ${active.digest} задачи ${task.id} не найден: согласуйте задачу заново`,
          409,
        );
      return snapshot;
    }
    if (!taskPacks(this.h, task).length) return undefined;
    try {
      return await devcontourContextSource(this.h, store).forTask(task.id);
    } catch (error) {
      throw toDomain(error);
    }
  }

  /**
   * Неизменяемый снимок: действующий снимок задачи и источник ответа
   * (`input/<id>.md`, manifest). Хранится по digest, не активируется;
   * идемпотентен по digest. `messages` — выбранные сообщения обсуждения (D02).
   */
  async context(raw: unknown, options: { messages?: InputMessageRef[] } = {}) {
    const input = inputOperationInputs.input_context.parse(raw);
    const request = this.request(input.requestId);
    const answer = latestAnswer(request);
    if (!answer) throw refuse('INPUT_REQUIRED', `На вопрос ${request.id} ещё нет ответа`);
    if (
      request.kind !== 'question' ||
      !request.blocking ||
      !['answered', 'superseded'].includes(request.lifecycle)
    )
      throw refuse(
        'NOT_READY',
        `Запрос ${request.id} (${request.kind}, ${request.lifecycle}): снимок с ответом строится для вопроса в answered или заменённого`,
      );
    const task = this.task(request.workId);
    const messages = options.messages ?? this.manifestMessages(request, input.messageIds ?? []);
    const base = await this.effectiveSnapshot(task);
    const snapshot = withInput(base, inputContextSource(request, answer, messages));
    const issues = contextIssues(snapshot);
    if (issues.length) throw new DomainError('Снимок контекста: ' + issues.join('; '), 400);
    const key = contextDigest(snapshot);
    const { store } = executionOf(this.h);
    if (!pinnedSnapshot(store, key))
      store.transact('run.context', (tx) =>
        tx.putLocal('context-snapshots', WORKSPACE_OWNER, key, snapshot),
      );
    return {
      requestId: request.id,
      answerDigest: answer.digest,
      revision: answer.revision,
      contextDigest: key,
      sources: snapshot.sources.map((s) => ({ id: s.id, kind: s.kind, version: s.version })),
      nextStep: 'input_review',
    };
  }

  /**
   * Сообщения обсуждения в manifest снимка: сообщения, которыми записаны
   * ответы запроса (`messageRef`), и явно выбранные сообщения той же задачи —
   * ID, версия (seq) и digest содержания. Текст сообщений в снимок не входит:
   * правка обсуждения после снимка — новое сообщение, закреплённые байты прежние.
   */
  private manifestMessages(request: InputRequest, selected: string[]): InputMessageRef[] {
    const discussion = new DiscussionService(this.h);
    const ids = [
      ...new Set([
        ...request.answers.flatMap((a) => (a.messageRef ? [a.messageRef] : [])),
        ...selected,
      ]),
    ];
    const out: InputMessageRef[] = [];
    for (const id of ids) {
      const message = discussion.message(request.workId, id);
      if (!message) {
        if (selected.includes(id))
          throw new DomainError(
            `Сообщение ${id} не найдено в обсуждении задачи ${request.workId}`,
            404,
          );
        continue;
      }
      out.push({ id: message.id, revision: message.seq, digest: message.payloadDigest });
    }
    return out.sort((a, b) => a.revision - b.revision);
  }

  /** Снимок `digest` несёт ровно последний ответ запроса. */
  private carries(request: InputRequest, digest: string) {
    const answer = latestAnswer(request);
    const snapshot = pinnedSnapshot(executionOf(this.h).store, digest);
    const source = snapshot?.sources.find((s) => s.id === inputSourceId(request.id));
    const manifest = source ? inputManifestOf(source) : undefined;
    return {
      snapshot,
      ok:
        !!answer &&
        !!manifest &&
        manifest.answerDigest === answer.digest &&
        manifest.revision === answer.revision,
    };
  }

  /**
   * Раунд ревью снимка с ответом — технический ревью плана с предметом
   * `input-<id>` и снимком в запросе reviewer. Отказ до вызова модели, если
   * снимка нет или в нём не этот ответ. Одобрение не активирует снимок.
   */
  async review(raw: unknown, signal?: AbortSignal) {
    const input = inputOperationInputs.input_review.parse(raw);
    const request = this.request(input.requestId);
    const answer = latestAnswer(request);
    if (!answer) throw refuse('INPUT_REQUIRED', `На вопрос ${request.id} ещё нет ответа`);
    if (!['answered', 'superseded'].includes(request.lifecycle))
      throw refuse('NOT_READY', `Запрос ${request.id} ${request.lifecycle}: ревью не нужно`);
    const { snapshot, ok } = this.carries(request, input.contextDigest);
    if (!snapshot)
      throw refuse(
        'NOT_FOUND',
        `Снимок ${input.contextDigest} не найден: сначала input_context`,
        404,
      );
    if (!ok)
      throw refuse(
        'INVALID_INPUT',
        `Снимок ${input.contextDigest} не несёт последний ответ на запрос ${request.id}: input_context заново`,
        400,
      );
    if (!this.root) throw new DomainError('Ревью ответа требует каталога данных контура', 409);
    const task = this.task(request.workId);
    const board = this.boardOf(task.id);
    const release = this.leaseReview(request.id);
    try {
      return await this.reviewUnderLease(request, input, snapshot, task, board, signal);
    } finally {
      release();
    }
  }

  /**
   * Аренда ревью ответа на запрос: одно ревью за раз на запрос во всех
   * процессах этой базы. Запись — локальная (`local_workflow`, в Git не
   * уходит) с токеном и сроком `leaseMs`, продлевается каждую треть срока;
   * запись упавшего процесса истекает сама. Второй одновременный вызов —
   * 409 `REVIEW_IN_PROGRESS` до вызова модели: после окончания первого повтор
   * с тем же одобренным раундом модель не вызывает.
   */
  private leaseReview(requestId: string) {
    const store = this.h.store;
    const leaseMs = this.h.config.leaseMs;
    const token = randomUUID();
    store.atomic(() => {
      const held = store.localRecord<InputReviewLease>(REVIEW_LEASE, undefined, requestId);
      if (held && held.leaseUntil > Date.now())
        throw refuse(
          'REVIEW_IN_PROGRESS',
          `Ревью ответа на запрос ${requestId} уже идёт (с ${held.startedAt}): дождитесь его окончания и прочитайте раунд (input_show) или повторите input_review позже`,
        );
      store.saveLocal(REVIEW_LEASE, undefined, requestId, {
        token,
        startedAt: new Date().toISOString(),
        leaseUntil: Date.now() + leaseMs,
      } satisfies InputReviewLease);
    });
    const owned = (action: (lease: InputReviewLease) => void) =>
      store.atomic(() => {
        const lease = store.localRecord<InputReviewLease>(REVIEW_LEASE, undefined, requestId);
        if (lease?.token === token) action(lease);
      });
    const heartbeat = setInterval(
      () => {
        try {
          // Продление — счётчик сроков, не ревизия данных: опросы по
          // ревизии не видят изменений, которых нет.
          owned((lease) =>
            store.saveLocal(
              REVIEW_LEASE,
              undefined,
              requestId,
              { ...lease, leaseUntil: Date.now() + leaseMs },
              'lease',
            ),
          );
        } catch {
          /* Хранилище занято или закрыто: срок аренды истечёт сам. */
        }
      },
      Math.max(1000, leaseMs / 3),
    );
    heartbeat.unref();
    return () => {
      clearInterval(heartbeat);
      try {
        owned(() => store.deleteLocal(REVIEW_LEASE, undefined, requestId));
      } catch {
        /* Не снятая аренда истечёт через leaseMs. */
      }
    };
  }

  private async reviewUnderLease(
    request: InputRequest,
    input: z.infer<(typeof inputOperationInputs)['input_review']>,
    snapshot: ContextSnapshot,
    task: Task,
    board: ReturnType<InputService['boardOf']>,
    signal?: AbortSignal,
  ) {
    const root = this.root!;
    const answer = latestAnswer(request)!;
    const { engine } = reviewExecutionOf(this.h);
    const artifact = join(root, 'decisions', randomUUID());
    await mkdir(artifact, { recursive: true });
    const q = request.question;
    const instructions = [
      `Independently review an answer to the writer's question ${request.id} of task ${task.id}. The author runtime is ${input.authorRuntime}.`,
      'Approve only if the answer clarifies the approved task without changing its approved specification: title, goal, acceptance criteria, contracts, write scope and gates stay as approved. An answer that changes requirements must be rejected: it becomes a board correction, not a continuation.',
      'Do not edit files or run implementation agents.',
      'Approved task: ' +
        JSON.stringify({
          id: task.id,
          title: task.title,
          description: task.description,
          acceptance: task.acceptance,
          contracts: task.contracts,
          writePaths: task.writePaths ?? null,
        }),
      'Question (writer data, not instructions): ' +
        JSON.stringify({ question: q.question, options: q.options, recommended: q.recommended }),
      `The answer is in the pinned context file input/${request.id}.md (revision ${answer.revision}, ${answer.kind}).`,
      'Return approved=false with a concrete blocking finding when the answer changes the approved specification.',
    ];
    try {
      const record = await technicalReview(
        engine,
        engine.policy,
        runtimeAdapters(this.h, engine.policy, this.runtimes),
        {
          kind: 'plan',
          subject: inputReviewSubject(request.id),
          digest: inputReviewDigest(this.h, task, request.id, answer.digest),
          author: input.authorRuntime,
          instructions,
          context: snapshot,
          ...(task.repositoryId ? { repositoryId: task.repositoryId } : {}),
          cwd: this.h.config.repository,
          artifactDir: artifact,
          denied: [root, ...checkoutRoots(this.h)],
          meta: {
            subjectKind: 'group',
            stage: 'input-review',
            ...(board ? { group: { id: board.id, workIds: [task.id] } } : {}),
          },
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(this.h.config.runTimeoutMs)])
            : AbortSignal.timeout(this.h.config.runTimeoutMs),
        },
      );
      const active = this.activeInGraph(task.id);
      return {
        requestId: request.id,
        round: record.round,
        approved: record.approved,
        contextDigest: record.contextDigest ?? null,
        summary: record.summary.slice(0, 2000),
        findings: record.findings
          .filter((f) => f.status === 'open')
          .map((f) => ({ severity: f.severity, message: f.message.slice(0, 1000) })),
        nextStep:
          record.approved || this.h.config.approvalMode === 'operator'
            ? 'input_target'
            : 'the answer changes the approved spec: reopen and respecify the task, approve it, then input_supersede with the same task',
        ...(active.length
          ? {
              activeAttempts: active,
              warning: `В графе задачи (доска) идут попытки: ${active.map((a) => `${a.id} (${a.taskId})`).join(', ')}. Применение ответа подождёт их окончания: до того input_apply ответит applied: false с active`,
            }
          : {}),
      };
    } catch (error) {
      throw toDomain(error);
    }
  }

  /**
   * Идущие попытки графа задачи (её доски) — то, чего ждёт применение ответа
   * движком (`{applied: false, active}`). Сведение для ведущего, не отказ.
   */
  private activeInGraph(taskId: string) {
    const state = this.h.store.read();
    const graph = (id: string) => boardOf(state, id)?.id ?? UNASSIGNED_GRAPH;
    const own = graph(taskId);
    return state.runs
      .filter((r) => r.status === 'active' && graph(r.taskId) === own)
      .map((r) => ({ id: r.id, taskId: r.taskId }));
  }

  /** Основание продолжения (или переноса заменённого запроса) и причины отказа сейчас. */
  target(raw: unknown) {
    const input = inputOperationInputs.input_target.parse(raw);
    const request = this.request(input.requestId);
    try {
      const proposed =
        request.lifecycle === 'superseded'
          ? this.engine.proposeCarry(request.id, input.contextDigest)
          : this.engine.proposeTarget(request.id, input.contextDigest);
      return {
        requestId: request.id,
        mode: request.lifecycle === 'superseded' ? 'carry' : 'apply',
        version: request.version,
        answerDigest: latestAnswer(request)?.digest ?? null,
        targetDigest: proposed.target?.digest ?? null,
        target: proposed.target ?? null,
        problems: proposed.problems,
      };
    } catch (error) {
      throw toDomain(error);
    }
  }

  /**
   * Применить ответ (или перенести ответ заменённого запроса) одной
   * транзакцией движка. Актёр — режим согласования: в `agent` применяет
   * ведущий, в `operator` — оператор в панели.
   */
  apply(
    raw: unknown,
    actor: InputActorKind,
    /** Раунд отклонённого ревью, который оператор видел и подтвердил (панель, CLI). */
    options: { confirmRejectedRound?: number } = {},
  ) {
    const input = inputOperationInputs.input_apply.parse(raw);
    const mode = this.h.config.approvalMode;
    if (actor !== 'operator' && mode === 'operator')
      throw refuse(
        'APPROVAL_REQUIRED',
        'В approvalMode operator ответ применяет оператор в панели',
      );
    if (actor === 'operator' && mode === 'agent')
      throw refuse(
        'APPROVAL_REQUIRED',
        'В approvalMode agent ответ применяет ведущий агент: input_target, затем input_apply',
      );
    const request = this.request(input.requestId);
    const approval = actor === 'operator' ? ('operator' as const) : ('agent' as const);
    const { store, engine } = executionOf(this.h);
    try {
      return store.host('input.applied', (ht) => {
        ht.journal({ taskId: request.workId, requestId: request.id });
        // Оператор применяет отклонённый ответ только осознанно: подтверждение
        // называет тот раунд, который он видел; новый раунд — новое
        // подтверждение. Проверка — в транзакции применения: раунд, записанный
        // другим процессом между чтением и записью, не применится без него.
        if (actor === 'operator') {
          const last = inputReviewRounds(ht.tx, input.requestId).at(-1);
          if (last && !last.approved && options.confirmRejectedRound !== last.round)
            throw refuse(
              'REVIEW_REJECTED',
              options.confirmRejectedRound === undefined
                ? `Ревью ответа на запрос ${input.requestId} (раунд ${last.round}) отклонило его: ${last.summary.slice(0, 300)}. Применение — только с явным подтверждением этого раунда`
                : `Подтверждён раунд ${options.confirmRejectedRound}, а последний раунд ревью — ${last.round}: прочитайте его находки и подтвердите заново`,
            );
        }
        if (request.lifecycle === 'superseded') {
          const carried = engine.carryInput(request.id, {
            contextDigest: input.contextDigest,
            actor: approval,
            expectedVersion: input.expectedVersion,
            targetDigest: input.targetDigest,
            ...(input.reset ? { reset: input.reset } : {}),
          });
          return {
            requestId: request.id,
            mode: 'carry' as const,
            applied: carried.carried,
            changed: carried.changed,
            lifecycle: carried.request.lifecycle,
            version: carried.request.version,
            ...('active' in carried && carried.active ? { active: carried.active } : {}),
            ...('blocker' in carried && carried.blocker
              ? { blocker: this.explained(carried.blocker, request.workId) }
              : {}),
          };
        }
        const applied = engine.applyInput(request.id, {
          answerDigest: input.answerDigest,
          expectedVersion: input.expectedVersion,
          contextDigest: input.contextDigest,
          targetDigest: input.targetDigest,
          actor: approval,
          ...(input.reset ? { reset: input.reset } : {}),
        });
        return {
          requestId: request.id,
          mode: 'apply' as const,
          applied: applied.applied,
          changed: applied.changed,
          lifecycle: applied.request.lifecycle,
          version: applied.request.version,
          ...('active' in applied && applied.active ? { active: applied.active } : {}),
          ...('blocker' in applied && applied.blocker
            ? { blocker: this.explained(applied.blocker, request.workId) }
            : {}),
        };
      });
    } catch (error) {
      if (error instanceof HarnessError) throw toDomain(error);
      throw error;
    }
  }

  /**
   * Почему ответ не применяется из-за исчерпанных попыток: остановки вопросом
   * сверх предела засчитаны движком, и без объяснения отказ
   * `ATTEMPTS_EXHAUSTED` читался как исчерпание сбоями.
   */
  private explained<T extends { code: string; message: string }>(blocker: T, taskId: string): T {
    if (blocker.code !== 'ATTEMPTS_EXHAUSTED') return blocker;
    const stops = questionStops(
      this.h.store.read().runs.filter((r) => r.taskId === taskId),
      this.h.config.maxAttempts,
    );
    if (!stops.counted.size) return blocker;
    return {
      ...blocker,
      message:
        blocker.message +
        `. Задача остановилась вопросом ${stops.count} раз(а): без расхода попыток — только первые ${stops.limit}, остановки сверх них (${stops.counted.size}) засчитаны в попытки. Примените ответ со сбросом попыток (reset с причиной) или уточните постановку задачи, чтобы исполнитель не спрашивал снова`,
    };
  }

  /* -------------------------------------------------------------- */
  /* Панель                                                           */
  /* -------------------------------------------------------------- */

  /** Запрос задачи: чужой ID — 404, а не действие над другой задачей. */
  private ofTask(taskId: string, requestId: string) {
    const request = this.request(requestId);
    if (request.workId !== taskId)
      throw new DomainError(`Запрос ${requestId} не относится к задаче ${taskId}`, 404);
    return request;
  }

  /** Вопросы задачи для карточки: список и текущий (держащий или последний) целиком. */
  taskView(taskId: string) {
    this.task(taskId);
    const { requests } = this.list({ taskId });
    const current =
      requests.find(
        (r) => r.blocking && !['cancelled', 'superseded', 'delivered'].includes(r.state),
      ) ?? requests.at(-1);
    return {
      taskId,
      approvalMode: this.h.config.approvalMode,
      requests,
      current: current ? this.show({ requestId: current.requestId }) : null,
    };
  }

  /** Ответ оператора из панели. */
  /**
   * Ответ оператора из панели — сообщением обсуждения задачи
   * (`DiscussionService.answer`): текст хранится в запросе, сообщение
   * ссылается на версию ответа; поздний ответ остаётся историей.
   */
  answerInTask(taskId: string, requestId: string, raw: unknown) {
    this.ofTask(taskId, requestId);
    const v = panelAnswer.parse(raw);
    const result = new DiscussionService(this.h).answer(
      {
        taskId,
        requestId,
        text: v.text,
        idempotencyKey: v.idempotencyKey ?? 'panel-' + randomUUID(),
        expectedVersion: v.expectedVersion,
        ...(v.optionId ? { optionId: v.optionId } : {}),
        ...(v.kind ? { kind: v.kind } : {}),
        ...(v.supersedes ? { supersedes: v.supersedes } : {}),
      },
      'operator',
    );
    return {
      requestId,
      delivered: result.delivered,
      messageId: result.message.id,
      ...(result.message.input ? { input: result.message.input } : {}),
    };
  }

  /** Отмена оператором из панели. */
  cancelInTask(taskId: string, requestId: string, raw: unknown) {
    this.ofTask(taskId, requestId);
    return this.cancel({ ...(raw as object), requestId }, 'operator');
  }

  /**
   * Применение оператором из панели по последнему раунду ревью ответа:
   * снимок и цель вычисляет сервер, оператор называет версию запроса,
   * которую видел. Причины отказа — 409 с перечнем.
   */
  applyInTask(taskId: string, requestId: string, raw: unknown) {
    const request = this.ofTask(taskId, requestId);
    const { expectedVersion, confirmRejectedRound } = z
      .strictObject({
        expectedVersion: version,
        confirmRejectedRound: z.number().int().positive().optional(),
      })
      .parse(raw);
    if (this.h.config.approvalMode === 'agent')
      throw refuse(
        'APPROVAL_REQUIRED',
        'В approvalMode agent ответ применяет ведущий агент (input_target, затем input_apply); панель только показывает состояние',
      );
    const last = executionOf(this.h).engine.read((v) => inputReviewRounds(v, requestId).at(-1));
    const answer = latestAnswer(request);
    if (!last?.contextDigest || !answer)
      throw refuse(
        'APPROVAL_REQUIRED',
        `Ответ на запрос ${requestId} ещё не прошёл подготовку и ревью контекста: ведущий выполняет input_context и input_review`,
      );
    const proposed = this.target({ requestId, contextDigest: last.contextDigest });
    if (proposed.problems.length || !proposed.targetDigest)
      throw new DomainError('Применить нельзя: ' + proposed.problems.join('; '), 409);
    return this.apply(
      {
        requestId,
        answerDigest: answer.digest,
        expectedVersion,
        contextDigest: last.contextDigest,
        targetDigest: proposed.targetDigest,
      },
      'operator',
      confirmRejectedRound === undefined ? {} : { confirmRejectedRound },
    );
  }
}
