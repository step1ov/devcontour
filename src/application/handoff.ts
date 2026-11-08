// Пакет передачи контекста новой сессии ведущего агента: сборка и отрисовка —
// общие функции devcontour-harness (`handoffPack`, `handoffMarkdown`) над
// движком DevContour и тем же хранилищем, что у исполнения. Пакет только
// читает состояние: моделей не вызывает, записей и событий не создаёт.
//
// Это не handoff публикации ChangeSet (`devcontour handoff --changeset`):
// тот готовит результат к push/PR человеком.
import { DiscussionService, type InboxRequest } from './discussion.ts';
import { InputService } from './input.ts';
import { hrefs } from './panel-links.ts';
import {
  HANDOFF_MAX_BYTES,
  HANDOFF_MIN_BYTES,
  handoffMarkdown,
  handoffPack,
  policySecrets,
  redactor,
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
export const handoffHostCommands = {
  'harness run':
    'Not a DevContour command. The running server holds the controller role but does not lift pauses itself: a board continues under its lead workflow job (workflow_start {"kind": "board", "id": BOARD, "authorRuntime": …}; workflow_status lists jobs). With approvalMode agent the job loop, at stage 1 (tasks), lifts the initial pause, the shutdown pause and an operator pause set before the job started, and checks a moved base itself (base-check); at stage 2 (acceptance) it lifts only the shutdown pause. It retries failed tasks within the repair budget and stops the job when the budget or the failure class allows no retry. With approvalMode operator jobs do not run: the operator starts the queue and retries. host.next names the step for this pack.',
  'harness resume':
    'queue_set {"paused": false}, or devcontour queue --start --workspace …; an operator pause is lifted only on the user\'s decision.',
} as const;

/** Шаг DevContour вместо команды harness: что сделать ведущему агенту или человеку. */
export interface HandoffHostNext {
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
  /** Вопрос исполнителя, к которому относится шаг (`answer-input`, `apply-input`, `close-follow-up`). */
  input?: { requestId: string; taskId: string; state: string; actor: 'lead' | 'operator' };
  detail: string;
}

/** Пакет harness и приложение DevContour. */
export interface DevContourHandoff {
  pack: HandoffPack;
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

/** Что сделает цикл — словами для `detail`. */
function loopText(o: LoopOutlook) {
  switch (o.step) {
    case 'review-plan':
      return 'reviews the plan';
    case 'advance':
      return 'finishes its stage';
    case 'recovery':
      return `handles the property episode of task ${o.taskId} (${o.action})`;
    case 'repair':
      return `retries task ${o.taskId} (${o.reason})`;
    case 'stop':
      return `stops the job: ${o.reason}`;
    case 'check-base':
      return 'checks the moved base';
    case 'lift-pause':
      return `lifts the ${o.pause} pause`;
    case 'wait':
      return "waits for the board's tasks";
    case 'accept':
      return 'accepts the board';
    case 'none':
      return 'has nothing to do';
  }
}

/** Как снять остановку цикла: задачу чинит человек или ведущий, не повтор задания. */
const STOP_REMEDY =
  'Diagnose it; fix or retry the task by hand (MCP task_retry, or devcontour retry --task ID --by host [--reset --reason TEXT]; a property episode — recovery_decide) or ask the user. Retrying the job (workflow_retry) before that fails again.';

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

const OPERATOR_STEP =
  'approvalMode operator: lead workflow jobs do not run. The operator reviews plans and accepts boards in the panel, starts the queue (devcontour queue --start --workspace …) and retries failed tasks (devcontour retry --task ID --workspace …).';

/** Сколько id задач называет подсказка ревью плана. */
const PLAN_HINT_IDS = 20;
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
  const list = (xs: string[], total: number, field: string, sep = ',') =>
    xs.slice(0, PLAN_HINT_IDS).join(sep) +
    (total > PLAN_HINT_IDS ? ` (… ещё ${total - PLAN_HINT_IDS}: host.next.${field})` : '');
  // Правка черновика сохраняет отсутствующие в файле необязательные поля, но
  // ключи со значением по умолчанию получают его: их переносят из задачи.
  const edit =
    'devcontour edit-task --task ID --file FILE --workspace …; fields absent from the file are kept, except repositoryId, scope, dependsOn and contracts, which fall back to their defaults: copy them from the current task';
  const unverified = plan.unverifiedCount
    ? ` ${plan.unverifiedCount} draft task(s) are unverified agent findings: the lead triages them before approval — verify the reproduction and priority, merge duplicates, cancel stale or misrouted ones (devcontour cancel --task ID --reason … --by host --workspace …), write testable acceptance and gates (${edit}; the edit marks the finding triaged): ${list(plan.unverified, plan.unverifiedCount, 'plan.unverified')}.`
    : '';
  const blocked = plan.blockedCount
    ? ` ${plan.blockedCount} draft task(s) fail approval preconditions, so approval refuses them and review-plan stops on them before the model call; fix these first (${edit}) or cancel them: ${list(
        plan.blocked.map((b) => `${b.id} — ${b.reason}`),
        plan.blockedCount,
        'plan.blocked',
        '; ',
      )}.`
    : '';
  // Область длиннее подсказки: весь план — ревью без --tasks; иначе область
  // в подсказке усечена, и это сказано прямо, а не спрятано за «ещё N».
  const tasks =
    review.length <= PLAN_HINT_IDS
      ? `--tasks ${review.join(',')} `
      : review.length === scope.length
        ? `(the whole plan, ${review.length} tasks: no --tasks needed) `
        : `--tasks ${plan.review.join(',')} (scope truncated: the first ${PLAN_HINT_IDS} of ${review.length} reviewable tasks; review the rest in a later round) `;
  const next = review.length
    ? ` Review the plan with an explicit scope (devcontour review-plan --board ${boardId} ${tasks}--author-runtime codex|claude --workspace …, keeping only the tasks to run; review-plan also checks INTENT story bindings, which this hint does not), or edit/cancel the tasks first; register workflow_start only for an approved plan.`
    : ' No task of the plan is ready for review: review-plan only after these are handled; register workflow_start only for an approved plan.';
  return {
    action: 'decide',
    decision: 'plan',
    boardId,
    plan,
    detail: `The plan of board ${boardId} is not approved (${plan.drafts.length} draft task(s)${plan.stale.length ? `, ${plan.stale.length} approved under another policy` : ''}).${unverified}${blocked} workflow_start would send the whole plan to review and run every task once approved: choosing the scope is the lead's or the user's decision.${next}`,
  };
}

/** Цикл задания сам что-то сделает (не только ждёт задач). */
const acts = (loop: LoopOutlook | undefined) =>
  !!loop && loop.step !== 'wait' && loop.step !== 'none';

/** Шаг по заданиям одной доски: ждать, повторить, начать, исправить вход или решить. */
export function boardStep(boardId: string, ctx: HostContext): HandoffHostNext | undefined {
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
    if (loop.step === 'stop')
      return {
        action: 'decide',
        decision: 'job',
        boardId,
        job: jobRef(live),
        loop,
        detail: `Next, at stage ${stage}, the lead workflow job of board ${boardId} stops: ${loop.reason}. ${STOP_REMEDY}`,
      };
    return {
      action: 'wait',
      boardId,
      job: jobRef(live),
      loop,
      detail: `Board ${boardId} has a live lead workflow job (stage ${live.stage}); next, at stage ${stage}, the job loop ${loopText(loop)}. The running DevContour server continues it; if the server is stopped, start it (devcontour start --workspace …).`,
    };
  }
  const refused = ctx.inputError(boardId);
  if (refused)
    return {
      action: 'fix-input',
      boardId,
      detail: `workflow_start for board ${boardId} would be refused: ${refused}. Fix that first (approvals in the panel, tasks of the board), then register the job.`,
    };
  const job = jobs.find((j) => ctx.current(j));
  if (job?.status === 'failed') {
    if (job.attempts < job.maxAttempts) {
      // Повтор задания — тот же такт цикла по состоянию сейчас.
      const { outlook: loop } = loopAhead(h, state, { ...asLead(job), status: 'queued' });
      if (loop.step === 'stop')
        return {
          action: 'decide',
          decision: 'job',
          boardId,
          job: jobRef(job),
          loop,
          detail: `The lead workflow job of board ${boardId} failed${job.error ? ': ' + job.error : ''}, and a retry would stop again: ${loop.reason}. ${STOP_REMEDY} Then workflow_retry {"key": ${JSON.stringify(job.key)}${job.owner ? ', "repositoryId": ' + JSON.stringify(job.owner) : ''}}.`,
        };
      return {
        action: 'workflow_retry',
        boardId,
        job: jobRef(job),
        loop,
        detail: `The lead workflow job of board ${boardId} failed${job.error ? ': ' + job.error : ''}. On retry the job loop ${loopText(loop)}: workflow_retry {"key": ${JSON.stringify(job.key)}${job.owner ? ', "repositoryId": ' + JSON.stringify(job.owner) : ''}}.`,
      };
    }
    return {
      action: 'decide',
      decision: 'job',
      boardId,
      job: jobRef(job),
      detail: `The lead workflow job of board ${boardId} used all ${job.maxAttempts} attempts${job.error ? ': ' + job.error : ''}. workflow_start returns this failed job until the board input changes: diagnose, then change the board or its tasks (a new input registers a new job) or ask the user.`,
    };
  }
  if (job?.status === 'stale' || job?.status === 'completed')
    return {
      action: 'decide',
      decision: 'job',
      boardId,
      job: jobRef(job),
      detail: `A lead workflow job for exactly the current input of board ${boardId} is already ${job.status}${job.status === 'stale' ? ' (the input changed and then returned to it)' : ''}; workflow_start returns it unchanged and it will not run. Change the board or its tasks to register a new job, or continue by hand (devcontour queue --start, retry, accept; docs/cli.md), or ask the user.`,
    };
  if (job)
    return {
      action: 'wait',
      boardId,
      job: jobRef(job),
      detail: `The lead workflow job of board ${boardId} is ${job.status} but does not continue now (a policy apply is pending or another process holds it); check workflow_status.`,
    };
  const plan = planStep(boardId, ctx);
  if (plan) return plan;
  const running = ctx.pack.active.some((a) => ctx.view.work(a.workId)?.graphId === boardId);
  const previous = jobs.find((j) => j.status !== 'completed');
  return {
    action: 'workflow_start',
    boardId,
    ...(previous ? { job: jobRef(previous) } : {}),
    detail:
      `No live lead workflow job for board ${boardId}${previous ? ` (its ${previous.status} job was started on another input)` : ''}: with the DevContour server running, register workflow_start {"kind": "board", "id": ${JSON.stringify(boardId)}, "authorRuntime": …}; queue_set {"paused": false} alone resumes dispatch without the job's pause handling and repairs.` +
      (running
        ? ' An attempt is running: the server finishes it without a job; the board can also be continued by hand (MCP task_retry or devcontour retry --by host, accept; docs/cli.md).'
        : ''),
  };
}

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
  const repeated = summary.questionStops
    ? ` Task ${taskId} has stopped with a writer question ${summary.questionStops.count} times; only the first ${summary.questionStops.limit} give the attempt back${summary.questionStops.exhausted ? ', further stops count as attempts, and with the attempts used up input_apply returns blocker ATTEMPTS_EXHAUSTED until it is applied with reset {"reason": …}' : ''}. Consider making the task spec answer these questions up front (board_correct or reopen and respecify).`
    : '';
  if (!summary.blocking)
    return {
      action: 'close-follow-up',
      ...base,
      detail: `Follow-up ${summary.requestId} of task ${taskId} (a decision the writer took itself, severity ${summary.severity}): accept it with input_cancel {"requestId": "${summary.requestId}", "expectedVersion": ${summary.version}, "reason": "assumption accepted"} or, if it changes requirements, correct the board (board_correct) and input_supersede with the replacement task (a task without an accepted result: reopen, respecify and supersede with the same task).`,
    };
  if (summary.state === 'awaiting-answer')
    return {
      action: 'answer-input',
      ...base,
      detail:
        (summary.actor === 'lead'
          ? `Task ${taskId} waits for an answer to ${summary.requestId} (no floors, approvalMode agent): answer with input_answer {"requestId": "${summary.requestId}", "expectedVersion": ${summary.version}, …} after input_show, or let the operator answer in the panel (${hrefs.input(taskId)}). The answer does not resume the task by itself.`
          : `Task ${taskId} waits for the operator's answer to ${summary.requestId} in the panel (${hrefs.input(taskId)})${summary.floors.length ? `: the question is critical (${summary.floors.join(', ')})` : ''}. Wait: the lead does not answer it and no queue step helps.`) +
        repeated,
    };
  const chain = operator
    ? `input_context, input_review --author-runtime; then the operator applies in the panel (${hrefs.input(taskId)})`
    : 'input_context, input_review --author-runtime, input_target, input_apply';
  return {
    action: 'apply-input',
    ...base,
    detail:
      (summary.state === 'stale'
        ? `The applied answer to ${summary.requestId} went stale before the next attempt (${summary.stale?.reason ?? 'context'}): rebuild it — ${chain}.`
        : summary.state === 'review-rejected'
          ? `The reviewer rejected the answer to ${summary.requestId} (input_show names the findings): correct the answer, or reopen and respecify the task${operator ? '; the operator may apply it only with explicit confirmation' : ''}.`
          : summary.state === 'applied-awaiting-claim'
            ? `The answer to ${summary.requestId} is applied; task ${taskId} waits for its next attempt.`
            : `The answer to ${summary.requestId} is saved but not applied (${summary.state}): ${chain}.`) +
      repeated,
  };
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
  return {
    action: 'close-follow-up',
    ...(open.boardId ? { boardId: open.boardId } : {}),
    input: { requestId: open.requestId, taskId: open.taskId, state: open.state, actor: 'lead' },
    detail: `Follow-up ${open.requestId} of task ${open.taskId} (a decision the writer took itself, severity ${open.severity}): accept it with input_cancel {"requestId": "${open.requestId}", "expectedVersion": ${open.version}, "reason": "assumption accepted"} or, if it changes requirements, correct the board (board_correct) and input_supersede with the replacement task (a task without an accepted result: reopen, respecify and supersede with the same task).`,
  };
}

function hostNext(ctx: HostContext): HandoffHostNext | undefined {
  const step = hostStep(ctx);
  // Решение о плане — о будущем объёме (например, разбор находок на
  // неутверждённой доске). Пакет harness называет первую по порядку работ
  // остановку, и черновик ранней доски заслонял блокеры живой работы: ответ
  // на вопрос исполнителя, который ждёт применения, и упавшее задание доски.
  // Они — раньше решения о плане.
  if (step?.decision === 'plan') return liveBlocker(ctx) ?? step;
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
  const { pack, state, h } = ctx;
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
  if (!pack.summary.open) return undefined;
  const input = inputNext(ctx);
  if (input) return input;
  if (h.config.approvalMode === 'operator') return { action: 'operator', detail: OPERATOR_STEP };
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
        return {
          action: 'wait',
          boardId: job.id,
          job: jobRef(job),
          loop,
          detail: `Dispatch is paused (${state.pauseReason ?? 'initial'}); the lead workflow job of board ${job.id} lifts the pause at stage ${stage}${loop.step === 'lift-pause' ? '' : ' after it ' + loopText(loop)}. The running DevContour server continues it; if the server is stopped, start it (devcontour start --workspace …).`,
        };
      }
    if (state.pauseReason === 'operator') {
      const first = live[0];
      const ahead = first ? loopAhead(h, state, asLead(first)) : undefined;
      return {
        action: 'queue_set',
        ...(first ? { boardId: first.id, job: jobRef(first), loop: ahead!.outlook } : {}),
        detail:
          'Dispatch is paused by the operator and no job loop lifts it: resume only on the user\'s decision with queue_set {"paused": false} (devcontour queue --start).' +
          (ahead ? ` Meanwhile the job loop of board ${first.id} ${loopText(ahead.outlook)}.` : ''),
      };
    }
  }
  return steps[0];
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
      const ctx = hostContext(h, harness, v, state, () => pack);
      const liveBoards = [...new Set(ctx.jobs.filter(ctx.live).map((j) => j.id))];
      const next = hostNext(ctx);
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
      if (!limit) return { value: { pack, host }, trimmed: false };
      const size = (p: HandoffPack) => bytes(handoffResponse({ pack: p, host }, limit.format));
      if (size(pack) <= limit.bytes) return { value: { pack, host }, trimmed: false };
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
        const over = bytes(handoffResponse({ pack: fitted, host }, limit.format)) - limit.bytes;
        if (over <= 0) break;
        budget -= over;
        host = withDiscussion(
          budget > 0 && i < 3 ? discussionOf(budget) : { requests: [], omitted: true },
        );
      }
      return {
        value: { pack: fitted, host },
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
  return format === 'md'
    ? {
        format,
        markdown: handoffMarkdown(pack) + hostMarkdown(host),
        host,
        commands: handoffHostCommands,
      }
    : { format, pack, host, commands: handoffHostCommands };
}

function hostMarkdown(host: DevContourHandoff['host']) {
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
    ...Object.entries(handoffHostCommands).map(([k, v]) => `- \`${k}\` — ${v}`),
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
