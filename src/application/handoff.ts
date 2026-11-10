// Пакет передачи контекста новой сессии ведущего агента: сборка и отрисовка —
// общие функции devcontour-harness (`handoffPack`, `handoffMarkdown`) над
// движком DevContour и тем же хранилищем, что у исполнения. Пакет только
// читает состояние: моделей не вызывает, записей и событий не создаёт.
//
// Это не handoff публикации ChangeSet (`devcontour handoff --changeset`):
// тот готовит результат к push/PR человеком.
import { DiscussionService, type InboxRequest } from './discussion.ts';
import { InputService } from './input.ts';
import {
  hintDetail,
  hintLocaleOf,
  PLAN_HINT_IDS,
  type HintLocale,
  type HintOf,
} from './hint-messages.ts';
import {
  HANDOFF_MAX_BYTES,
  HANDOFF_MIN_BYTES,
  handoffMarkdown,
  handoffPack,
  policySecrets,
  redactDeep,
  redactor,
  type Redactor,
  type ExecutionView,
  type HandoffPack,
  type HandoffSource,
  type WorkflowJob as HarnessJob,
} from 'devcontour-harness';
import { z } from 'zod';
import { DomainError, type Config } from '../core/model.ts';
import type { DevContour } from '../core/service.ts';
import { LeadWorkflow, type WorkflowJob } from '../core/lead-workflow.ts';
import {
  boardTasks,
  liftsPause,
  loopAhead,
  planApproved,
  unapprovedTasks,
  type LoopOutlook,
} from '../runner/lead-outlook.ts';
import { repositories } from '../core/repositories.ts';
import { leadLiftsPause } from '../core/work-status.ts';
import { executionOf, toDomain } from '../harness/execution.ts';
import type { DevContourExecutionStore } from '../harness/store.ts';

export const handoffFormats = ['json', 'md'] as const;
export type HandoffFormat = (typeof handoffFormats)[number];

/**
 * Намерения — по правилу пакета harness: пробелы по краям снимаются, пустые
 * строки отбрасываются, непустых не больше 20 (иначе 400), строка длиннее
 * 1000 знаков усекается и считается в `truncated.intentions`. Схема задаёт
 * только транспортный предел.
 */
export const handoffRequestInput = z.strictObject({
  /** Доска DevContour — граф harness с тем же id; без неё — вся доска workspace. */
  boardId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,80}$/)
    .optional(),
  /** Намерения агента: единственный текст пакета не из хранилища. */
  intentions: z.array(z.string().max(10_000)).max(100).optional(),
});

/** Вход операции `session_handoff` агентского API. */
export const handoffInput = handoffRequestInput.extend({
  format: z.enum(handoffFormats).default('json'),
});

export type HandoffRequest = z.infer<typeof handoffRequestInput>;

/**
 * Команды harness в `next.command` пакета (`handoffCommands`) и что делать в
 * DevContour. Controller очереди — работающий сервер контура; работу доски
 * продолжает её задание ведущего (`workflow_start`), а не сервер сам по себе.
 * Правила цикла — `loopOutlook` (src/runner/lead-outlook.ts).
 */
const hostCommandsEn = {
  'harness run':
    'Not a DevContour command. The running server holds the controller role but does not lift pauses itself: a board continues under its lead workflow job (workflow_start {"kind": "board", "id": BOARD, "authorRuntime": …}; workflow_status lists jobs). With approvalMode agent the job loop, at stage 1 (tasks), lifts the initial pause, the shutdown pause and an operator pause set before the job started, and checks a moved base itself (base-check); at stage 2 (acceptance) it lifts only the shutdown pause. It retries failed tasks within the repair budget and stops the job when the budget or the failure class allows no retry. With approvalMode operator jobs do not run: the operator starts the queue and retries. host.next names the step for this pack.',
  'harness resume':
    'queue_set {"paused": false}, or devcontour queue --start --workspace …; an operator pause is lifted only on the user\'s decision.',
};

const hostCommandsRu: Record<keyof typeof hostCommandsEn, string> = {
  'harness run':
    'Не команда DevContour. Работающий сервер держит роль controller, но паузы сам не снимает: доску продолжает её задание ведущего (workflow_start {"kind": "board", "id": BOARD, "authorRuntime": …}; workflow_status перечисляет задания). С approvalMode agent цикл задания на стадии 1 (задачи) снимает начальную паузу, паузу остановки и паузу оператора, поставленную до старта задания, и сам проверяет сдвинутую базу (base-check); на стадии 2 (приёмка) снимает только паузу остановки. Он повторяет упавшие задачи в пределах бюджета исправлений и останавливает задание, когда бюджет или класс отказа повтора не допускают. С approvalMode operator задания не исполняются: оператор запускает очередь и повторяет задачи. host.next называет шаг для этого пакета.',
  'harness resume':
    'queue_set {"paused": false} или devcontour queue --start --workspace …; паузу оператора снимают только по решению пользователя.',
};

/** Описания команд harness на языке подсказок (`hintLocale`); ключи — как есть. */
export const handoffHostCommandsByLocale: Record<
  HintLocale,
  Record<keyof typeof hostCommandsEn, string>
> = {
  en: hostCommandsEn,
  ru: hostCommandsRu,
};

/** Описания по умолчанию — английские, как прежде. */
export const handoffHostCommands = hostCommandsEn;

/**
 * Шаг DevContour вместо команды harness: что сделать ведущему агенту или
 * человеку. `code` и `params` — стабильное описание шага (`HintParamMap`,
 * src/application/hint-messages.ts): параметры — только то, чего нет в
 * полях шага; `detail` — его текст на языке подсказок конфигурации
 * (`hintLocale`, без поля — английский).
 */
export type HandoffHostNext = HandoffHostNextFields & HintOf;

interface HandoffHostNextFields {
  action:
    | 'workflow_start'
    | 'workflow_retry'
    | 'wait'
    | 'queue_set'
    | 'decide'
    | 'fix-input'
    | 'operator'
    | 'answer-input'
    | 'apply-input'
    | 'close-follow-up';
  boardId?: string;
  /** Задание ведущего, к которому относится шаг. */
  job?: {
    key: string;
    repositoryId?: string;
    status: string;
    stage: number;
    attempts: number;
    maxAttempts: number;
    repairs: number;
  };
  /** Что сделает цикл ведущего по этому заданию на следующем такте (`loopOutlook`). */
  loop?: LoopOutlook;
  /**
   * О чём решение `decide`: `plan` — план доски не согласован (объём работы
   * решает ведущий или пользователь), `job` — задание ведущего.
   */
  decision?: 'plan' | 'job';
  /** Задачи, из-за которых план не согласован (`decision: plan`). */
  plan?: {
    drafts: string[];
    stale: string[];
    /** Задачи, которые подсказка предлагает на ревью плана (до 20): без `unverified` и `blocked`. */
    review: string[];
    reviewCount: number;
    /** Не разобранные ведущим находки агентов (до 20): их разбирают до ревью. */
    unverified: string[];
    unverifiedCount: number;
    /** Черновики, которые утверждение отвергнет, и причина (до 20): их правят до ревью. */
    blocked: { id: string; reason: string }[];
    blockedCount: number;
  };
  /**
   * Вопрос исполнителя, к которому относится шаг (`answer-input`, `apply-input`,
   * `close-follow-up`); у переноса ответа заменённого вопроса (`apply-carry`)
   * `state` — `superseded`.
   */
  input?: { requestId: string; taskId: string; state: string; actor: 'lead' | 'operator' };
  detail: string;
}

/** Шаг без текста: текст собирает каталог по коду (`hintDetail`). */
type HostNextDraft = Omit<HandoffHostNextFields, 'detail'> & HintOf;

/** Шаг с текстом на языке подсказок конфигурации. */
const withDetail = (h: DevContour, step: HostNextDraft): HandoffHostNext => ({
  ...step,
  detail: hintDetail(step, hintLocaleOf(h.config)),
});

/** Пакет harness и приложение DevContour. */
export interface DevContourHandoff {
  pack: HandoffPack;
  /**
   * Язык описаний команд (`commands`) ответа — `hintLocale` конфигурации; в
   * ответ не входит. Без поля — английский.
   */
  locale?: HintLocale;
  host: {
    next?: HandoffHostNext;
    /** Доски с действующим заданием ведущего (его очередь продолжает сервер). */
    liveBoards: string[];
    /**
     * Необработанные обращения к ведущему из обсуждений задач: до пяти,
     * выдержка текста после редактора секретов; остальное — `discussion_inbox`
     * с курсором, полный текст — `discussion_read`. `omitted` — обращения
     * есть, но в предел ответа не поместились.
     */
    discussion?: {
      requests: InboxRequest[];
      nextCursor?: string;
      omitted?: true;
    };
  };
}

/** Владельцы заданий ведущего: workspace и компоненты (как `LeadWorkflow.view`). */
const ownersOf = (config: Config) => [undefined, ...repositories(config).map((r) => r.id)];

type State = ReturnType<DevContourExecutionStore['stateOf']>;
/** Задание harness как задание ведущего DevContour (тот же объект, другой `kind`). */
const asLead = (job: HarnessJob) => ({ ...job, kind: 'board' }) as unknown as WorkflowJob;

/**
 * Вход задания доски по состоянию: digest и владелец (правило
 * `LeadWorkflow.staleBoards`) или причина, по которой его не построить
 * (нет согласованной подготовки, у доски нет задач) — тогда и
 * `workflow_start` откажет с той же причиной.
 */
function boardInputs(h: DevContour) {
  const lead = new LeadWorkflow(h);
  const cache = new WeakMap<State, Map<string, { digest: string; owner?: string } | string>>();
  return (id: string, state: State) => {
    let byBoard = cache.get(state);
    if (!byBoard) {
      byBoard = new Map<string, { digest: string; owner?: string } | string>();
      cache.set(state, byBoard);
    }
    if (!byBoard.has(id))
      try {
        byBoard.set(id, lead.input('board', id, state));
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        byBoard.set(id, error.message);
      }
    return byBoard.get(id)!;
  };
}

/**
 * Источник пакета (`HandoffSource`) над движком DevContour (`executionOf`):
 * движок, его политика и адаптер очереди заданий — экземпляр `Harness` не
 * нужен.
 *
 * Задание графа harness в DevContour — задание ведущего по доске (id доски —
 * id графа) у любого владельца: пакет и диагнозы видят его счётчик
 * восстановлений, а продолжает ли оно работу, решает очередь заданий
 * DevContour с её продуктовым входом (`LeadWorkflow.queue`). Задания
 * ChangeSet графу не соответствуют и в пакет не входят. В режиме
 * `approvalMode: operator` цикл ведущего заданий не исполняет
 * (`LeadRunner.advance`): ни одно задание не продолжается.
 *
 * Порядок списка (и `repairs` пакета: у доски бывает несколько заданий):
 * действующие задания первыми, затем задания по текущему входу доски, затем
 * новые первыми.
 */
export function harnessOf(h: DevContour) {
  const { engine, store } = executionOf(h);
  const queue = new LeadWorkflow(h).queue();
  const owners = ownersOf(h.config);
  const operator = h.config.approvalMode === 'operator';
  const inputOf = boardInputs(h);
  const continues = (
    job: HarnessJob,
    view: ExecutionView,
    options: { reconfigureApplies?: boolean } = {},
  ) => !operator && queue.continues({ ...job, kind: 'board' }, view, options);
  const current = (job: HarnessJob, state: State) => {
    const bound = inputOf(job.id, state);
    return (
      typeof bound !== 'string' && bound.digest === job.inputDigest && bound.owner === job.owner
    );
  };
  const list = (): HarnessJob[] =>
    store.read((view) => {
      const state = store.stateOf(view);
      const options = { reconfigureApplies: engine.reconfigureApplies(view) };
      const rank = (job: HarnessJob) =>
        (continues(job, view, options) ? 0 : 2) + (current(job, state) ? 0 : 1);
      return owners
        .flatMap((owner) => queue.list(owner))
        .filter((job) => job.kind === 'board')
        .map((job): HarnessJob => ({ ...job, kind: 'graph' }))
        .sort(
          (a, b) =>
            rank(a) - rank(b) ||
            (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0),
        );
    });
  const workflows = { list, continues };
  const source: HandoffSource = { engine, policy: engine.policy, workflows };
  return { source, workflows, engine, current, inputOf };
}

/** Наследуемое значение короче — обычное слово или число, а не учётные данные. */
const MIN_INHERITED = 8;

/**
 * Маска текстов пакета. Переданная маска заменяет маску пакета по умолчанию
 * (секреты политики), поэтому она собрана из всех известных значений
 * контура, заданных в окружении читающего процесса:
 * - секреты (`secrets`) политики harness и любого профиля окружения
 *   конфигурации DevContour (workspace, компоненты, preview, профили
 *   инструментов) — `policySecrets` пакета над обоими;
 * - поля DevContour, которых в политике нет: MCP `bearerTokenEnv` и токены
 *   подключений forge (`tokenEnv`) любой длины, наследуемые значения
 *   (`inherit`) и переменные MCP (`env`) не короче 8 знаков — короткие
 *   («1», «true») маскировали бы обычный текст.
 */
export function handoffRedactor(config: Config, policy: unknown, source = process.env) {
  const values = new Set<string>([
    ...policySecrets(policy, source),
    ...policySecrets(config, source),
  ]);
  const add = (name: unknown, min = 1) => {
    const value = typeof name === 'string' ? source[name] : undefined;
    if (value && value.length >= min) values.add(value);
  };
  const walk = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(walk);
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if ((key === 'inherit' || key === 'env') && Array.isArray(v))
        (v as unknown[]).forEach((name) => add(name, MIN_INHERITED));
      if (key === 'bearerTokenEnv' || key === 'tokenEnv') add(v);
      walk(v);
    }
  };
  walk(config);
  return redactor([...values]);
}

/** Сведения задания для шага хоста. */
const jobRef = (job: HarnessJob) => ({
  key: job.key,
  ...(job.owner ? { repositoryId: job.owner } : {}),
  status: job.status,
  stage: job.stage,
  attempts: job.attempts,
  maxAttempts: job.maxAttempts,
  repairs: job.repairs ?? 0,
});

export interface HostContext {
  h: DevContour;
  pack: HandoffPack;
  view: ExecutionView;
  state: State;
  /** Задания досок (вид графа) в порядке `harnessOf`. */
  jobs: HarnessJob[];
  live: (job: HarnessJob) => boolean;
  current: (job: HarnessJob) => boolean;
  /** Причина, по которой вход доски не построить, или `undefined`. */
  inputError: (boardId: string) => string | undefined;
}

/**
 * Контекст шага хоста над одним снимком движка. Пакет строится только когда
 * шагу он нужен (`pack`): решения досок (`boardStep` с остановкой, повтором
 * или входом) его не читают.
 */
export function hostContext(
  h: DevContour,
  harness: ReturnType<typeof harnessOf>,
  view: ExecutionView,
  state: State,
  pack: () => HandoffPack,
): HostContext {
  const reconfigure = { reconfigureApplies: harness.engine.reconfigureApplies(view) };
  let built: HandoffPack | undefined;
  return {
    h,
    get pack() {
      return (built ??= pack());
    },
    view,
    state,
    jobs: harness.workflows.list(),
    live: (job) => harness.workflows.continues(job, view, reconfigure),
    current: (job) => harness.current(job, state),
    inputError: (id) => {
      const bound = harness.inputOf(id, state);
      return typeof bound === 'string' ? bound : undefined;
    },
  };
}

/** Предел причины отказа одного черновика в `host.next.plan.blocked`. */
const REASON_CHARS = 300;

/**
 * Решение о плане доски, если он не согласован: задание отправило бы его на
 * ревью и, одобренный, выпустило бы все задачи доски — это решение об
 * объёме, а не шаг очереди.
 */
export function planStep(boardId: string, ctx: HostContext): HandoffHostNext | undefined {
  const found = boardTasks(ctx.state, boardId);
  if (!found || planApproved(ctx.h, found.revision, found.tasks)) return undefined;
  const why = unapprovedTasks(ctx.h, ctx.state, found.tasks);
  // Утверждение (и ревью плана до модели) отвергнет черновик без предусловий,
  // ревью отвергнет неразобранную находку: подсказка называет такие задачи и
  // не включает их в область ревью, а без других задач ревью не предлагает
  // вовсе — оно было бы оплачено впустую. Списки с текстом причин ограничены,
  // как подсказка: `host` не растёт с числом черновиков.
  const held = new Set([...why.blocked.map((b) => b.id), ...why.unverified]);
  const scope = [...why.drafts, ...why.stale];
  const review = scope.filter((id) => !held.has(id));
  const plan = {
    drafts: why.drafts,
    stale: why.stale,
    review: review.slice(0, PLAN_HINT_IDS),
    reviewCount: review.length,
    unverified: why.unverified.slice(0, PLAN_HINT_IDS),
    unverifiedCount: why.unverified.length,
    blocked: why.blocked.slice(0, PLAN_HINT_IDS).map((b) => ({
      id: b.id,
      reason: b.reason.length > REASON_CHARS ? b.reason.slice(0, REASON_CHARS - 1) + '…' : b.reason,
    })),
    blockedCount: why.blocked.length,
  };
  // Текст подсказки (`plan-unapproved` каталога) называет задачи `plan`:
  // неразобранные находки, черновики, которые утверждение отвергнет, и
  // область ревью — весь план без --tasks или явный усечённый список.
  return withDetail(ctx.h, {
    action: 'decide',
    decision: 'plan',
    boardId,
    plan,
    code: 'plan-unapproved',
    params: { scope: scope.length },
  });
}

/** Цикл задания сам что-то сделает (не только ждёт задач). */
const acts = (loop: LoopOutlook | undefined) =>
  !!loop && loop.step !== 'wait' && loop.step !== 'none';

/** Шаг по заданиям одной доски: ждать, повторить, начать, исправить вход или решить. */
export function boardStep(boardId: string, ctx: HostContext): HandoffHostNext | undefined {
  const step = boardDraft(boardId, ctx);
  return step && withDetail(ctx.h, step);
}

function boardDraft(boardId: string, ctx: HostContext): HostNextDraft | undefined {
  const { h, state } = ctx;
  // Принятая ревизия без открытых задач: заданию доски делать нечего.
  const done = boardTasks(state, boardId);
  if (
    done?.revision.status === 'accepted' &&
    done.tasks.every((t) => t.status === 'done' || t.status === 'cancelled')
  )
    return undefined;
  const jobs = ctx.jobs.filter((j) => j.id === boardId);
  const live = jobs.find(ctx.live);
  if (live) {
    const { stage, outlook: loop } = loopAhead(h, state, asLead(live));
    const cancelled = cancelledStop(boardId, ctx, live, loop, {}, true);
    if (cancelled) return cancelled;
    if (loop.step === 'stop')
      return {
        action: 'decide',
        decision: 'job',
        boardId,
        job: jobRef(live),
        loop,
        code: 'job-stops',
        params: { stage },
      };
    return {
      action: 'wait',
      boardId,
      job: jobRef(live),
      loop,
      code: 'job-live',
      params: { stage },
    };
  }
  const refused = ctx.inputError(boardId);
  if (refused)
    return {
      action: 'fix-input',
      boardId,
      code: 'input-refused',
      params: { reason: refused },
    };
  const job = jobs.find((j) => ctx.current(j));
  const error = job?.error ? { error: job.error } : {};
  if (job?.status === 'failed') {
    // Повтор задания — тот же такт цикла по состоянию сейчас.
    const { outlook: loop } = loopAhead(h, state, { ...asLead(job), status: 'queued' });
    if (job.attempts < job.maxAttempts) {
      // Исчерпанное задание сюда не входит: `workflow_retry` его не примет,
      // и шаг остаётся `job-exhausted`.
      const cancelled = cancelledStop(boardId, ctx, job, loop, error);
      if (cancelled) return cancelled;
      if (loop.step === 'stop')
        return {
          action: 'decide',
          decision: 'job',
          boardId,
          job: jobRef(job),
          loop,
          code: 'job-retry-stops',
          params: error,
        };
      return {
        action: 'workflow_retry',
        boardId,
        job: jobRef(job),
        loop,
        code: 'job-retry',
        params: error,
      };
    }
    return {
      action: 'decide',
      decision: 'job',
      boardId,
      job: jobRef(job),
      code: 'job-exhausted',
      params: error,
    };
  }
  if (job?.status === 'stale' || job?.status === 'completed')
    return {
      action: 'decide',
      decision: 'job',
      boardId,
      job: jobRef(job),
      code: 'job-settled',
      params: {},
    };
  if (job)
    return {
      action: 'wait',
      boardId,
      job: jobRef(job),
      code: 'job-idle',
      params: {},
    };
  const plan = planStep(boardId, ctx);
  if (plan) return plan;
  const running = ctx.pack.active.some((a) => ctx.view.work(a.workId)?.graphId === boardId);
  const previous = jobs.find((j) => j.status !== 'completed');
  return {
    action: 'workflow_start',
    boardId,
    ...(previous ? { job: jobRef(previous) } : {}),
    code: 'board-start',
    params: { running },
  };
}

/**
 * Задание стоит (или встанет) на задаче, отменённой после выдачи: отменой
 * человека, отменой без актёра или отменой ведущего задачи, у которой уже
 * была попытка или отказ (например, исчерпанный бюджет). По D46 такая задача
 * из работы задания не выпадает: `workflow_retry` и `workflow_start` вернут
 * то же упавшее задание. Шаг называет законные пути: повтор задачи (подъём
 * предела, если её остановил бюджет, — решение пользователя; задачу, которую
 * отменил человек или актёр не записан, повторяет только пользователь) или
 * приёмку ревизии без неё — тоже решение пользователя (карточка центра
 * внимания оператору). Ни бюджет, ни приёмку ведущий сам не меняет.
 */
function cancelledStop(
  boardId: string,
  ctx: HostContext,
  job: HarnessJob,
  loop: LoopOutlook,
  error: { error?: string } = {},
  /** Задание действует: после повтора задачи оно продолжится само, без `workflow_retry`. */
  live = false,
): HostNextDraft | undefined {
  if (loop.step !== 'stop' || !loop.taskId) return undefined;
  const task = ctx.state.tasks.find((t) => t.id === loop.taskId);
  if (task?.status !== 'cancelled') return undefined;
  // Только задача, которую уже выдавали (попытка, отказ, прогон): отмена
  // невыданной задачи — решение об объёме плана, а не остановка работы,
  // и пути «повтор или приёмка без неё» к ней не относятся (D46, `leadScope`).
  const issued =
    task.attempt > 0 ||
    !!task.failure ||
    !!task.neutralFailures ||
    ctx.state.runs.some((r) => r.taskId === task.id);
  if (!issued) return undefined;
  // Приёмке доски нужна хотя бы одна неотменённая задача ревизии.
  const revision = ctx.state.boards.find((b) => b.id === boardId)?.revisions.at(-1);
  const allCancelled =
    !!revision &&
    revision.taskIds.every(
      (id) => ctx.state.tasks.find((t) => t.id === id)?.status === 'cancelled',
    );
  return {
    action: 'decide',
    decision: 'job',
    boardId,
    job: jobRef(job),
    loop,
    code: 'job-cancelled-task',
    params: {
      taskId: task.id,
      by: task.cancelledBy ?? 'unknown',
      budget: stoppedOnBudget(task, ctx.state.runs),
      live,
      ...(allCancelled ? { allCancelled: true as const } : {}),
      ...error,
    },
  };
}

/**
 * Исчерпанное задание доски (`job-exhausted`), цикл которого стоит на задаче,
 * отменённой после выдачи: параметры той же остановки, что у
 * `job-cancelled-task`. Шаг ведущего остаётся `job-exhausted` (`workflow_retry`
 * его не примет), а центр внимания по ним показывает решение оператору: приёмку
 * без задачи или новую ревизию доски — без повтора задания.
 */
export function exhaustedOnCancelled(boardId: string, ctx: HostContext) {
  const job = ctx.jobs.find((j) => j.id === boardId && ctx.current(j));
  if (job?.status !== 'failed' || job.attempts < job.maxAttempts) return undefined;
  const { outlook: loop } = loopAhead(ctx.h, ctx.state, { ...asLead(job), status: 'queued' });
  const step = cancelledStop(boardId, ctx, job, loop);
  return step?.code === 'job-cancelled-task' ? step.params : undefined;
}

/**
 * Задачу остановил бюджет: её последняя попытка упала отказом класса `budget`
 * или выдачу держало удержание бюджетом. Класс отказа самой задачи отмена
 * переписывает (`cancelled`), поэтому он берётся из попытки.
 */
const stoppedOnBudget = (
  t: { id: string; failureKind?: string; budgetBlock?: unknown },
  runs: readonly { taskId: string; failureKind?: string }[],
) =>
  t.failureKind === 'budget' ||
  !!t.budgetBlock ||
  runs.findLast((r) => r.taskId === t.id)?.failureKind === 'budget';

/** Срочность шага при выборе одного из досок workspace. */
const urgency: Record<HandoffHostNext['action'], number> = {
  decide: 0,
  'fix-input': 0,
  operator: 0,
  'answer-input': 0,
  'apply-input': 0,
  'close-follow-up': 1,
  queue_set: 1,
  workflow_retry: 1,
  workflow_start: 2,
  wait: 3,
};
/** Решение о плане не срочнее работы других досок: оно о будущем объёме. */
const rank = (x: HandoffHostNext) => (x.decision === 'plan' ? 4 : urgency[x.action]);

/**
 * Шаг DevContour по состоянию и правилам цикла ведущего (`loopOutlook`), а не
 * по `next.command`: с работающим сервером роль controller жива, и пакет
 * команды не называет, хотя исходную паузу и паузу остановки снимает только
 * цикл задания доски.
 */
/**
 * Шаг по вопросу исполнителя, когда его называет пакет (`INPUT_REQUIRED`):
 * ответ — оператор в панели (ведущий — только вопрос без минимумов в режиме
 * agent), применение — цепочка ведущего, follow-up — его закрытие. Шага
 * очереди не придумывает: вопрос выдачу не держит.
 */
function inputNext(ctx: HostContext): HandoffHostNext | undefined {
  const { pack } = ctx;
  if (pack.next.code !== 'INPUT_REQUIRED' || !pack.next.workId) return undefined;
  return inputStep(ctx, pack.next.workId);
}

/** Шаг по вопросу исполнителя одной задачи (блокирующий запрос — первым). */
function inputStep(ctx: HostContext, taskId: string): HandoffHostNext | undefined {
  const { view, h } = ctx;
  const service = new InputService(h);
  const summary = service
    .list({ taskId })
    .requests.filter((r) => !['cancelled', 'superseded', 'delivered'].includes(r.state))
    .sort((a, b) => Number(b.blocking) - Number(a.blocking))[0];
  if (!summary) return undefined;
  const boardId = view.work(taskId)?.graphId;
  const ref = {
    requestId: summary.requestId,
    taskId,
    state: summary.state,
    actor: summary.actor,
  };
  const base = { ...(boardId ? { boardId } : {}), input: ref };
  const operator = h.config.approvalMode === 'operator';
  // Повторные остановки вопросом: свободные остановки кончаются, и частые
  // вопросы — признак неполной постановки. Ведущий узнаёт это из шага.
  const stops = summary.questionStops ? { stops: summary.questionStops } : {};
  if (!summary.blocking)
    return withDetail(h, {
      action: 'close-follow-up',
      ...base,
      code: 'follow-up',
      params: { severity: summary.severity, version: summary.version },
    });
  if (summary.state === 'awaiting-answer')
    return withDetail(h, {
      action: 'answer-input',
      ...base,
      ...(summary.actor === 'lead'
        ? { code: 'answer-lead' as const, params: { version: summary.version, ...stops } }
        : { code: 'answer-operator' as const, params: { floors: summary.floors, ...stops } }),
    });
  return withDetail(h, {
    action: 'apply-input',
    ...base,
    ...(summary.state === 'stale'
      ? {
          code: 'apply-stale' as const,
          params: { reason: summary.stale?.reason ?? 'context', operator, ...stops },
        }
      : summary.state === 'review-rejected'
        ? { code: 'apply-rejected' as const, params: { operator, ...stops } }
        : summary.state === 'applied-awaiting-claim'
          ? { code: 'apply-claim' as const, params: stops }
          : { code: 'apply-saved' as const, params: { state: summary.state, operator, ...stops } }),
  });
}

/**
 * Открытый follow-up (решение исполнителя в автономном режиме), когда
 * других шагов нет: работа может быть уже принята, а решение ждёт ведущего.
 */
function followUpNext(ctx: HostContext): HandoffHostNext | undefined {
  const { pack, h } = ctx;
  const open = new InputService(h)
    .list()
    .requests.find(
      (r) =>
        r.kind === 'follow-up' &&
        r.state === 'awaiting-answer' &&
        (!pack.graphId || r.boardId === pack.graphId),
    );
  if (!open) return undefined;
  return withDetail(h, {
    action: 'close-follow-up',
    ...(open.boardId ? { boardId: open.boardId } : {}),
    input: { requestId: open.requestId, taskId: open.taskId, state: open.state, actor: 'lead' },
    code: 'follow-up',
    params: { severity: open.severity, version: open.version },
  });
}

/**
 * Ответ заменённого вопроса ждёт переноса в постановку задачи (F14). Вопрос
 * выдачу не держит, и пакет harness его не называет: без этого шага ведущий
 * видел бы ожидание, старт задания или утверждение плана — и попытка (или
 * утверждение черновика) прошла бы без ответа.
 */
function carryNext(ctx: HostContext): HandoffHostNext | undefined {
  const { pack, h } = ctx;
  // В режиме оператора ответ переносит оператор в панели: шаг ведущего — `operator`.
  if (h.config.approvalMode === 'operator') return undefined;
  // Перенос, который можно начать, — раньше ждущего.
  const carry = new InputService(h)
    .pendingCarries()
    .filter((c) => !pack.graphId || c.boardId === pack.graphId)
    .sort((a, b) => Number(!!a.active.length) - Number(!!b.active.length))[0];
  if (!carry) return undefined;
  // Идущие попытки графа доски: движок откажет в переносе до их окончания,
  // и шаг — ожидание (ревью ответа до того — лишний вызов модели). Задача
  // уже утверждена (`now`), а очередь идёт: заменённый вопрос выдачу не
  // держит, и по окончании попыток планировщик выдал бы её без ответа —
  // сначала пауза очереди.
  const waiting = carry.active.length > 0;
  const pause = waiting && carry.order === 'now' && !ctx.state.paused;
  return withDetail(h, {
    action: pause ? 'queue_set' : waiting ? 'wait' : 'apply-input',
    ...(carry.boardId ? { boardId: carry.boardId } : {}),
    input: { requestId: carry.requestId, taskId: carry.taskId, state: 'superseded', actor: 'lead' },
    code: 'apply-carry',
    params: {
      order: carry.order,
      ...(waiting ? { active: carry.active } : {}),
      ...(pause ? { pause: true as const } : {}),
    },
  });
}

function hostNext(ctx: HostContext): HandoffHostNext | undefined {
  const step = hostStep(ctx);
  // Решение о плане — о будущем объёме (например, разбор находок на
  // неутверждённой доске). Пакет harness называет первую по порядку работ
  // остановку, и черновик ранней доски заслонял блокеры живой работы: ответ
  // на вопрос исполнителя, который ждёт применения, и упавшее задание доски.
  // Они — раньше решения о плане.
  if (step?.decision === 'plan') return liveBlocker(ctx) ?? step;
  // Перенос ответа — раньше шагов очереди и ожидания (`rank` больше 0): они
  // выдали бы задачу без ответа. Решения о задании, вопросы и режим
  // оператора — прежде переноса.
  // Ожидание переноса (идут попытки доски) своей доски — на том же месте:
  // старт задания или снятие паузы продолжили бы выдачу до переноса.
  if (step && rank(step) === 0) return step;
  // Ожидание переноса — как ожидание (`rank` шага `wait`): действие другой
  // доски (старт или повтор задания) оно не прячет, только шаги своей доски,
  // другие ожидания и шаги паузы: снятие паузы до переноса выдало бы задачу
  // без ответа.
  const carry = carryNext(ctx);
  if (
    carry &&
    (carry.action !== 'wait' ||
      !step ||
      rank(step) >= rank(carry) ||
      step.action === 'queue_set' ||
      step.boardId === carry.boardId)
  )
    return carry;
  return step ?? followUpNext(ctx);
}

/**
 * Блокер живой работы, который ведущий снимает сам: вопрос исполнителя, на
 * который ведущий отвечает или ответ на который ждёт подготовки и
 * применения, затем упавшее задание доски (повтор или решение по нему).
 * Ожидание ответа оператора и применённого ответа сюда не входит: ведущему
 * там делать нечего, и решение о плане остаётся его шагом.
 */
function liveBlocker(ctx: HostContext): HandoffHostNext | undefined {
  const { pack, h } = ctx;
  const inScope = (boardId: string | null | undefined) => !pack.graphId || boardId === pack.graphId;
  const asking = new InputService(h)
    .list()
    .requests.filter(
      (r) =>
        r.blocking &&
        inScope(r.boardId) &&
        !['cancelled', 'superseded', 'delivered', 'applied-awaiting-claim'].includes(r.state),
    );
  for (const taskId of [...new Set(asking.map((r) => r.taskId))]) {
    const step = inputStep(ctx, taskId);
    if (
      step?.action === 'apply-input' ||
      (step?.action === 'answer-input' && step.input?.actor === 'lead')
    )
      return step;
  }
  // Перенос в черновике — до утверждения плана и до повтора задания: тот
  // выдал бы задачу без ответа. Решение о задании — раньше переноса, как в
  // основном пути.
  const job = jobBlocker(ctx);
  if (job && rank(job) === 0) return job;
  // Ожидание переноса не прячет повтор задания другой доски.
  const carry = carryNext(ctx);
  if (carry?.action === 'wait' && job && job.boardId !== carry.boardId) return job;
  return carry ?? job;
}

/**
 * Упавшее задание доски (повтор или решение по нему) в области пакета. Оно
 * и без открытых поручений: все задачи доски приняты, а задание упало на
 * стадии приёмки (например, по таймауту gate) — доска ждёт повтора.
 */
function jobBlocker(ctx: HostContext): HandoffHostNext | undefined {
  const { pack, state } = ctx;
  const inScope = (boardId: string) => !pack.graphId || boardId === pack.graphId;
  const boards = [...new Set(ctx.jobs.map((j) => j.id))].filter(
    (id) => inScope(id) && state.boards.some((b) => b.id === id),
  );
  return boards
    .map((id) => boardStep(id, ctx))
    .filter(
      (x): x is HandoffHostNext =>
        !!x && (x.action === 'workflow_retry' || (x.action === 'decide' && x.decision === 'job')),
    )
    .sort((a, b) => rank(a) - rank(b))[0];
}

function hostStep(ctx: HostContext): HandoffHostNext | undefined {
  const { pack, view, state, h } = ctx;
  // Открытых поручений нет, но доска ещё не принята: шаг — только
  // восстановление её упавшего задания (без него ведущий не узнал бы, что
  // приёмку держит упавшее задание).
  if (!pack.summary.open) return h.config.approvalMode === 'operator' ? undefined : jobBlocker(ctx);
  const input = inputNext(ctx);
  if (input) return input;
  if (h.config.approvalMode === 'operator')
    return withDetail(h, { action: 'operator', code: 'operator', params: {} });
  const workId = pack.next.workId;
  const next = (workId ? view.work(workId)?.graphId : undefined) ?? pack.graphId;
  // Решение ведущего или пользователя, не связанное с очередью (разбор
  // отказа, перепланирование зависимых), — шаг пакета: шага очереди хост
  // не придумывает. Остаётся лишь решение по заданию или плану доски этого
  // решения.
  const nextDecides =
    (pack.next.actor === 'lead' || pack.next.actor === 'user') &&
    pack.next.action !== 'wait' &&
    pack.next.action !== 'none' &&
    pack.next.action !== 'resume-queue';
  if (nextDecides) {
    // Доски решения: его поручение, а у свёрнутой остановки без поручения —
    // поручения той же остановки (`works`).
    const ids = next
      ? [next]
      : pack.stops
          .filter((x) => x.code === pack.next.code && x.action === pack.next.action)
          .flatMap((x) => [...(x.workId ? [x.workId] : []), ...(x.works ?? [])])
          .map((id) => view.work(id)?.graphId);
    const own = [...new Set(ids)].filter(
      (id): id is string => !!id && state.boards.some((b) => b.id === id),
    );
    // Выдуманный шаг очереди (начать задание, снять паузу) отбрасывается;
    // ожидание действующего задания и повтор упавшего — шаги самой доски:
    // без них ведущий начал бы то же решение вручную наперегонки с заданием.
    // Ожидание задания, цикл которого лишь ждёт задач, спрятало бы решение
    // пакета за «сервер продолжит»: вместо него — решение о плане доски,
    // если план не согласован, иначе шага нет и стоит шаг пакета.
    return own
      .map((id) => {
        const step = boardStep(id, ctx);
        if (step?.action === 'wait' && !acts(step.loop)) return planStep(id, ctx);
        return step;
      })
      .filter((x): x is HandoffHostNext => !!x)
      .filter((x) => x.action !== 'workflow_start' && x.action !== 'queue_set')
      .sort((a, b) => rank(a) - rank(b))[0];
  }
  const boards =
    next && state.boards.some((b) => b.id === next)
      ? [next]
      : [...new Set(pack.works.map((w) => w.graphId))].filter((id) =>
          state.boards.some((b) => b.id === id),
        );
  const steps = boards
    .map((id) => boardStep(id, ctx))
    .filter((x): x is HandoffHostNext => !!x)
    .sort((a, b) => rank(a) - rank(b));
  if (state.paused) {
    // Решение по заданию (цикл остановит его, задание упало без пользы от
    // повтора, вход не построить) важнее паузы: её снятие его не исправит.
    // Решение о плане не срочнее: оно о будущем объёме, после ожидания
    // снимающего паузу задания и паузы человека (общий порядок `rank`).
    const decision = steps.find(
      (x) => (x.action === 'decide' && x.decision !== 'plan') || x.action === 'fix-input',
    );
    if (decision) return decision;
    // Пауза выдачи общая: её снимает любое действующее задание, чей цикл
    // снимет её — сразу или после такта, который сначала чинит задачу.
    const live = ctx.jobs.filter(ctx.live);
    for (const job of live)
      if (liftsPause(h, state, asLead(job))) {
        const { stage, outlook: loop } = loopAhead(h, state, asLead(job));
        return withDetail(h, {
          action: 'wait',
          boardId: job.id,
          job: jobRef(job),
          loop,
          code: 'pause-lift',
          params: { pause: state.pauseReason ?? 'initial', stage },
        });
      }
    if (state.pauseReason === 'operator') {
      const first = live[0];
      const ahead = first ? loopAhead(h, state, asLead(first)) : undefined;
      // «Тем временем» текста называет цикл задания этой доски (`loop`).
      return withDetail(h, {
        action: 'queue_set',
        ...(first ? { boardId: first.id, job: jobRef(first), loop: ahead!.outlook } : {}),
        code: 'pause-operator',
        params: leadLiftsPause(state) ? { by: 'lead' } : {},
      });
    }
  }
  return steps[0];
}

/**
 * Предел свободного текста шага (причина, ошибка задания) в `params` и
 * `detail` ответа: `host` пределом ответа не ужимается.
 */
const HINT_TEXT_CHARS = 1000;
/** Усечение по символам Unicode: суррогатная пара не разрезается. */
const clip = (text: string) => {
  const chars = [...text];
  return chars.length > HINT_TEXT_CHARS ? chars.slice(0, HINT_TEXT_CHARS - 1).join('') + '…' : text;
};

/**
 * Шаг в ответе: под той же маской, что пакет (ошибка задания и причина отказа
 * входа могут нести значения секретов), затем свободный текст усечён и текст
 * собран заново. Маска — до усечения: секрет на границе усечения иначе
 * остался бы частью. Сам шаг (`boardStep`) не усечён: появление карточки
 * центра внимания считается по полному английскому тексту, как прежде.
 */
function presentable(h: DevContour, step: HandoffHostNext, redact: Redactor): HandoffHostNext {
  const masked = redactDeep(step, redact);
  const params: Record<string, unknown> = { ...masked.params };
  for (const key of ['reason', 'error'])
    if (typeof params[key] === 'string') params[key] = clip(params[key]);
  const next = withDetail(h, { ...masked, params } as HostNextDraft);
  return { ...next, detail: redact(next.detail) };
}

/** Предел всего ответа (пакет, приложение и команды) в формате ответа. */
export interface HandoffLimit {
  bytes: number;
  format: HandoffFormat;
}

/**
 * Пакет передачи контекста workspace или одной доски (до 256 КБ, предел
 * пакета) и приложение DevContour. Только чтение; пакет и задания досок —
 * один снимок хранилища.
 */
export function devcontourHandoff(h: DevContour, input: HandoffRequest = {}): DevContourHandoff {
  return devcontourHandoffWithin(h, input).value;
}

/**
 * Пакет, ответ которого (`handoffResponse` в формате `limit.format`) не
 * больше `limit.bytes`: предел пакета harness (`maxBytes`, мера `markdown` для
 * Markdown) — предел ответа без приложения DevContour, его раздела Markdown
 * и команд. Размер результата проверяется здесь: если пакет всё же больше,
 * предел уменьшается на превышение (не ниже `HANDOFF_MIN_BYTES`). Приложение
 * (`host`) строится по полному пакету. `trimmed` — пределом ответа
 * отброшены записи, которых в полном пакете нет.
 */
export function devcontourHandoffWithin(
  h: DevContour,
  input: HandoffRequest = {},
  limit?: HandoffLimit,
): { value: DevContourHandoff; trimmed: boolean } {
  // CLI передаёт флаги как есть: формат id и транспортный предел — той же схемой.
  const parsed = handoffRequestInput.safeParse(input);
  if (!parsed.success)
    throw new DomainError(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
      400,
    );
  const request = parsed.data;
  const harness = harnessOf(h);
  const { source, engine } = harness;
  const { store } = executionOf(h);
  const { boardId } = request;
  try {
    return store.read((v) => {
      const state = store.stateOf(v);
      if (boardId !== undefined) {
        if (!state.boards.some((b) => b.id === boardId))
          throw new DomainError('Доска не найдена: ' + boardId, 404);
        if (!v.graph(boardId)) {
          // Движок ведёт граф доски только с первой утверждённой задачи:
          // пакета черновой доски нет. Отказ называет, что на доске, и шаг.
          const board = state.boards.find((b) => b.id === boardId)!;
          const ids = new Set(board.revisions.at(-1)?.taskIds ?? []);
          const drafts = state.tasks.filter((t) => ids.has(t.id) && t.status === 'draft').length;
          throw new DomainError(
            `Доска ${boardId} ещё не выпущена: ${
              drafts
                ? `черновиков задач — ${drafts}, утверждённых или выпущенных нет`
                : 'задач в работе нет'
            }, поэтому пакета доски нет. Пакет без доски (session_handoff без boardId, в CLI — без --board) называет следующий шаг; пакет доски появится после ${
              drafts
                ? 'утверждения плана (review-plan)'
                : 'добавления задач (task_create или plan_import) и утверждения плана'
            }.`,
            409,
          );
        }
      }
      const options = {
        ...(boardId !== undefined ? { graphId: boardId } : {}),
        ...(request.intentions ? { intentions: request.intentions } : {}),
        redact: handoffRedactor(h.config, engine.policy),
      };
      const pack = handoffPack(source, options);
      const locale = hintLocaleOf(h.config);
      const ctx = hostContext(h, harness, v, state, () => pack);
      const liveBoards = [...new Set(ctx.jobs.filter(ctx.live).map((j) => j.id))];
      // Шаг — под той же маской, что пакет: ошибка задания и причина отказа
      // входа могут нести значения секретов (в `detail` и в `params`).
      const step = hostNext(ctx);
      const next = step && presentable(h, step, options.redact);
      // Обращения — в своём байтовом бюджете: выдержки после редактора
      // секретов, полный текст — `discussion_read`. Бюджет — доля предела
      // ответа; если ответ всё же больше предела, он уменьшается ниже.
      const discussionOf = (budget: number): DevContourHandoff['host']['discussion'] => {
        const service = new DiscussionService(h);
        try {
          const inbox = service.inbox({ limit: HANDOFF_DISCUSSION_ITEMS }, budget, {
            redact: options.redact,
            excerptBytes: HANDOFF_DISCUSSION_EXCERPT,
          });
          if (!inbox.requests.length) return undefined;
          return {
            requests: inbox.requests,
            ...(inbox.nextCursor ? { nextCursor: inbox.nextCursor } : {}),
          };
        } catch (error) {
          if (error instanceof DomainError && error.status === 413)
            return { requests: [], omitted: true };
          throw error;
        }
      };
      const withDiscussion = (discussion: DevContourHandoff['host']['discussion']) => ({
        ...(next ? { next } : {}),
        liveBoards,
        ...(discussion ? { discussion } : {}),
      });
      let budget = limit
        ? Math.min(HANDOFF_DISCUSSION_BYTES, Math.floor(limit.bytes / 4))
        : HANDOFF_DISCUSSION_BYTES;
      let host = withDiscussion(discussionOf(budget));
      if (!limit) return { value: { pack, host, locale }, trimmed: false };
      const size = (p: HandoffPack) =>
        bytes(handoffResponse({ pack: p, host, locale }, limit.format));
      if (size(pack) <= limit.bytes) return { value: { pack, host, locale }, trimmed: false };
      // Предел пакета — предел ответа без того, что добавляет DevContour
      // (приложение, команды, конверт). Для Markdown — без самого текста
      // пакета в его виде в ответе (строка JSON), чтобы экранирование
      // полного текста не считалось накладным расходом: мера пакета harness
      // `markdown` берёт и JSON пакета, которого в ответе нет, поэтому оценка
      // лишь начальная — дальше предел подбирается по размеру ответа.
      const own =
        limit.format === 'md'
          ? Buffer.byteLength(JSON.stringify(handoffMarkdown(pack))) - 2
          : bytes(pack);
      // Предел пакета — от `HANDOFF_MIN_BYTES` до `HANDOFF_MAX_BYTES`: ниже
      // ответ в пределе не удержать (вызывающий проверяет размер сам).
      const clamp = (n: number) => Math.min(HANDOFF_MAX_BYTES, Math.max(HANDOFF_MIN_BYTES, n));
      const build = (maxBytes: number) =>
        handoffPack(source, {
          ...options,
          maxBytes,
          measure: limit.format === 'md' ? 'markdown' : 'json',
        });
      let maxBytes = clamp(limit.bytes - (size(pack) - own));
      let best: { pack: HandoffPack; size: number } | undefined;
      let last = pack;
      /** Наименьший предел пакета, ответ которого превысил предел ответа. */
      let overshot = Infinity;
      // Не больше 6 сборок: превышение — шаг вниз на превышение, запас больше
      // 2% предела — шаг вверх на запас, но ниже предела, уже давшего
      // превышение (в пределе ответа остаётся лучший).
      for (let i = 0; i < 6; i++) {
        last = build(maxBytes);
        const got = size(last);
        if (got <= limit.bytes) {
          if (!best || got > best.size) best = { pack: last, size: got };
          const slack = limit.bytes - got;
          if (
            slack <= limit.bytes * 0.02 ||
            droppedOf(last.truncated) === droppedOf(pack.truncated)
          )
            break;
          const up = Math.min(clamp(maxBytes + slack), overshot - 1);
          if (up <= maxBytes) break;
          maxBytes = up;
        } else {
          overshot = Math.min(overshot, maxBytes);
          if (maxBytes === HANDOFF_MIN_BYTES) break;
          maxBytes = clamp(maxBytes - (got - limit.bytes));
        }
      }
      const fitted = best?.pack ?? last;
      // Пакет не ужимается ниже `HANDOFF_MIN_BYTES`: остаток предела
      // освобождают обращения — меньше записей, затем только отметка о них.
      for (let i = 0; i < 4 && host.discussion?.requests.length; i++) {
        const over =
          bytes(handoffResponse({ pack: fitted, host, locale }, limit.format)) - limit.bytes;
        if (over <= 0) break;
        budget -= over;
        host = withDiscussion(
          budget > 0 && i < 3 ? discussionOf(budget) : { requests: [], omitted: true },
        );
      }
      return {
        value: { pack: fitted, host, locale },
        trimmed: droppedOf(fitted.truncated) > droppedOf(pack.truncated),
      };
    });
  } catch (error) {
    throw toDomain(error);
  }
}

/**
 * Ответ пакета — один вид у операции агентского API и CLI: JSON —
 * `{format, pack, host, commands}`, `md` — `{format, markdown, host,
 * commands}`; Markdown — текст пакета harness и раздел DevContour.
 */
export function handoffResponse(value: DevContourHandoff, format: HandoffFormat) {
  const { pack, host } = value;
  const commands = handoffHostCommandsByLocale[value.locale ?? 'en'];
  return format === 'md'
    ? {
        format,
        markdown: handoffMarkdown(pack) + hostMarkdown(host, commands),
        host,
        commands,
      }
    : { format, pack, host, commands };
}

function hostMarkdown(host: DevContourHandoff['host'], commands: Record<string, string>) {
  return [
    '',
    '## В DevContour',
    '',
    ...(host.next ? [`- **Следующий шаг: ${host.next.action}** — ${host.next.detail}`] : []),
    `- Действующие задания досок: ${host.liveBoards.length ? host.liveBoards.join(', ') : 'нет'}`,
    ...(host.discussion
      ? [
          host.discussion.requests.length
            ? `- Обращения к ведущему без обработки: ${host.discussion.requests
                .map((r) => `${r.taskId} (${r.id}${r.reopened ? ', есть ответ оператора' : ''})`)
                .join(', ')}${host.discussion.nextCursor ? ' и ещё — discussion_inbox' : ''}`
            : '- Есть обращения к ведущему без обработки — discussion_inbox',
        ]
      : []),
    ...Object.entries(commands).map(([k, v]) => `- \`${k}\` — ${v}`),
    '',
  ].join('\n');
}

/** Текст для CLI: JSON того же вида, что у операции, или Markdown. */
export function renderHandoff(value: DevContourHandoff, format: HandoffFormat): string {
  const response = handoffResponse(value, format);
  return response.markdown ?? JSON.stringify(response, null, 2) + '\n';
}

export const parseHandoffFormat = (format: string | undefined): HandoffFormat => {
  if (format === undefined) return 'json';
  if (!(handoffFormats as readonly string[]).includes(format))
    throw new DomainError('format: ожидается json или md', 400);
  return format as HandoffFormat;
};

/** Обращений к ведущему в пакете, байт их блока и байт выдержки каждого. */
const HANDOFF_DISCUSSION_ITEMS = 5;
const HANDOFF_DISCUSSION_BYTES = 8000;
const HANDOFF_DISCUSSION_EXCERPT = 600;

/** Предел ответа операции: каталог обещает не больше 64 KiB. */
export const AGENT_HANDOFF_BYTES = 60_000;

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

/** Сколько записей пакета отброшено пределами (`truncated`). */
const droppedOf = (t: HandoffPack['truncated']) =>
  t.works + t.stops + t.failures + t.unfinished + t.budgets + t.intentionsDropped;

/** CLI с полным пакетом — без предела ответа операции. */
export const HANDOFF_FULL_HINT =
  'devcontour session-handoff --workspace <path> [--board ID] [--intent TEXT]... [--format json|md] [--out FILE]';

/**
 * Пакет для ведущего агента в пределе ответа операции (`handoffResponse`).
 * Сверх предела записи отбрасываются тем же порядком, что у пакета
 * (`truncated.bySize`); тогда `full` называет CLI с полным пакетом.
 */
export function agentHandoff(h: DevContour, input: z.infer<typeof handoffInput>) {
  const { format, ...request } = input;
  const { value, trimmed } = devcontourHandoffWithin(h, request, {
    bytes: AGENT_HANDOFF_BYTES,
    format,
  });
  return { ...handoffResponse(value, format), ...(trimmed ? { full: HANDOFF_FULL_HINT } : {}) };
}
