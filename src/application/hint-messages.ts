// Тексты шага DevContour пакета передачи (`host.next.detail`) по языку
// подсказок (`hintLocale` конфигурации). Шаг несёт стабильный `code` и
// `params`; текст собирается одним каталогом на язык из кода, параметров и
// полей самого шага (доска, задание, цикл, план, вопрос). Команды, JSON, id и
// пути входят в текст как есть на любом языке.
import type { LoopOutlook } from '../runner/lead-outlook.ts';
import { hrefs } from './panel-links.ts';

export const hintLocales = ['en', 'ru'] as const;
export type HintLocale = (typeof hintLocales)[number];

/** Язык подсказок конфигурации: без поля — английский, как прежде. */
export const hintLocaleOf = (config: { hintLocale?: HintLocale }): HintLocale =>
  config.hintLocale ?? 'en';

/** Повторные остановки задачи вопросом исполнителя (`questionStops` сводки). */
export interface HintQuestionStops {
  count: number;
  limit: number;
  exhausted: boolean;
}

type None = Record<string, never>;
/** Повторные остановки вопросом — дополнение текстов вопроса исполнителя. */
type Stops = { stops?: HintQuestionStops };

/**
 * Параметры каждого кода: только то, чего нет в полях шага. Состав кода —
 * часть ответа `session_handoff`; новый код добавляется в оба каталога.
 */
export interface HintParamMap {
  /** `approvalMode: operator`: задания ведущего не исполняются. */
  operator: None;
  /** План доски не согласован (`decision: plan`); `scope` — задач плана в области ревью. */
  'plan-unapproved': { scope: number };
  /** Действующее задание остановится на следующем такте (`stage`). */
  'job-stops': { stage: number };
  /** Действующее задание продолжает сервер; `stage` — стадия следующего такта. */
  'job-live': { stage: number };
  /** `workflow_start` откажет: причина отказа как есть. */
  'input-refused': { reason: string };
  /** Задание упало, повтор остановится снова. */
  'job-retry-stops': { error?: string };
  /** Задание упало, повтор продвинет его. */
  'job-retry': { error?: string };
  /**
   * Задание стоит на задаче `taskId`, отменённой после выдачи (D46): `by` —
   * актёр отмены (`graph` — задачу убрала новая редакция графа доски,
   * `unknown` — не записан, считается отменой человеком),
   * `budget` — задачу остановил бюджет. Повтор и старт задания вернут то же
   * упавшее задание.
   */
  'job-cancelled-task': {
    taskId: string;
    by: 'host' | 'operator' | 'graph' | 'unknown';
    budget: boolean;
    /** Задание действует: после повтора задачи оно продолжится само. */
    live: boolean;
    /**
     * Все задачи ревизии отменены: приёмке нужна хотя бы одна выполненная
     * задача, поэтому второй путь — новая ревизия доски, а не приёмка без
     * задачи. Нет поля — в ревизии есть неотменённые задачи.
     */
    allCancelled?: true;
    error?: string;
  };
  /** Попытки задания исчерпаны. */
  'job-exhausted': { error?: string };
  /** Задание текущего входа уже stale или completed. */
  'job-settled': None;
  /** Задание не продолжается (применение политики, другой процесс). */
  'job-idle': None;
  /** Действующего задания нет; `running` — идёт попытка без задания. */
  'board-start': { running: boolean };
  /** Пауза выдачи, её снимет действующее задание; `pause` — причина паузы. */
  'pause-lift': { pause: string; stage: number };
  /** Пауза человека (`by: lead` — её поставил ведущий через queue_set), её не снимает ни одно задание. */
  'pause-operator': { by?: 'lead' };
  /**
   * Перенос базы удержан до подтверждения человека (`base.check.held`):
   * `paths` — чувствительные пути (`компонент:путь`), которые цикл задания
   * снять не вправе.
   */
  'base-held': { paths: string[] };
  /** Открытый follow-up исполнителя. */
  'follow-up': { severity: number; version: number };
  /** Вопрос ждёт ответа ведущего (без минимумов, режим agent). */
  'answer-lead': { version: number } & Stops;
  /**
   * Вопрос ждёт ответа оператора; `floors` — минимумы критичности,
   * `version` — версия запроса для `input_propose`, `proposed` — текущее
   * предложение ведущего ждёт подтверждения оператора (F37).
   */
  'answer-operator': { floors: string[]; version?: number; proposed?: boolean } & Stops;
  /** Применённый ответ устарел; `operator` — применяет оператор. */
  'apply-stale': { reason: string; operator: boolean } & Stops;
  /** Ревью отклонило ответ. */
  /**
   * Ревью отклонило ответ. `operator` — применяет оператор; `operatorAnswers` —
   * исправляет ответ оператор (ведущий только предлагает, `input_propose`),
   * `proposed` — предложение исправления уже ждёт оператора (F37).
   */
  'apply-rejected': { operator: boolean; operatorAnswers?: boolean; proposed?: boolean } & Stops;
  /** Ответ применён, задача ждёт следующей попытки. */
  'apply-claim': Stops;
  /** Ответ сохранён, но не применён (`state`). */
  'apply-saved': { state: string; operator: boolean } & Stops;
  /**
   * Исходная остановка вопроса не держится (постановка изменилась не только
   * перепривязкой контракта, или была другая попытка): `input_apply` откажет
   * (F39). `operatorAnswers` — заменить или снять вопрос может только оператор.
   */
  'apply-moved': { operatorAnswers: boolean } & Stops;
  /**
   * Цепочку после ответа ведёт сервер (`InputResumer`): `phase` — фаза
   * прохода (`resume` сводки вопроса), `trigger` — кто ответил. Фазы
   * `failed`, `blocked`, `needs-lead` — проход остановился, `detail` — причина.
   */
  'apply-auto': { phase: string; trigger: string; detail?: string } & Stops;
  /**
   * Ответ заменённого вопроса ждёт переноса в постановку задачи (F14):
   * `draft` — перенос в черновике, затем утверждение; `unreleased` — доска
   * без утверждённых задач: пауза, утверждение, перенос, снятие паузы;
   * `now` — задача утверждена, перенос сразу. `active` — идущие попытки
   * графа доски: движок откажет в переносе до их окончания (шаг `wait`).
   * `pause` — задача утверждена, а очередь идёт (или её паузу снимет цикл
   * задания): сначала пауза очереди. `userPause` — пауза человека до старта
   * задания, её снимет цикл, а пауза ведущего её не заменит: удержать задачу
   * может только новая пауза человека
   * (шаг `queue_set`), иначе по окончании попыток задачу выдадут без ответа.
   */
  'apply-carry': { order: CarryOrder; active?: string[]; pause?: true; userPause?: true };
}
/** Порядок переноса ответа заменённого вопроса (`apply-carry`). */
export type CarryOrder = 'draft' | 'unreleased' | 'now';
export type HintCode = keyof HintParamMap;

/** Поля шага, из которых текст берёт доску, задание, цикл, план и вопрос. */
export interface HintSubject {
  boardId?: string;
  job?: { key: string; repositoryId?: string; status: string; stage: number; maxAttempts: number };
  loop?: LoopOutlook;
  plan?: {
    drafts: string[];
    stale: string[];
    review: string[];
    reviewCount: number;
    unverified: string[];
    unverifiedCount: number;
    blocked: { id: string; reason: string }[];
    blockedCount: number;
  };
  input?: { requestId: string; taskId: string };
}

/** Код шага и его параметры одной парой (по ней сужается тип параметров). */
export type HintOf = { [C in HintCode]: { code: C; params: HintParamMap[C] } }[HintCode];

type Catalog = { [C in HintCode]: (p: HintParamMap[C], s: HintSubject) => string };

/** Сколько id задач называет подсказка ревью плана. */
export const PLAN_HINT_IDS = 20;

const reasonOf = (loop: LoopOutlook | undefined) => (loop && 'reason' in loop ? loop.reason : '');
/** Аргумент `workflow_retry` задания шага (JSON как есть). */
const retryArgs = (s: HintSubject) =>
  `{"key": ${JSON.stringify(s.job!.key)}${s.job!.repositoryId ? ', "repositoryId": ' + JSON.stringify(s.job!.repositoryId) : ''}}`;
/** Список id подсказки плана с отметкой о не вошедших. */
const hintList = (xs: string[], total: number, field: string, sep = ',') =>
  xs.slice(0, PLAN_HINT_IDS).join(sep) +
  (total > PLAN_HINT_IDS ? ` (… ещё ${total - PLAN_HINT_IDS}: host.next.${field})` : '');
const blockedList = (s: HintSubject) =>
  hintList(
    s.plan!.blocked.map((b) => `${b.id} — ${b.reason}`),
    s.plan!.blockedCount,
    'plan.blocked',
    '; ',
  );
const reviewTasks = (s: HintSubject) => s.plan!.review.join(',');

// ── English (по умолчанию: тексты байтово прежние) ─────────────────────────

function loopEn(o: LoopOutlook) {
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

const STOP_REMEDY_EN =
  'Diagnose it; fix or retry the task by hand (MCP task_retry, or devcontour retry --task ID --by host [--reset --reason TEXT]; a property episode — recovery_decide) or ask the user. Retrying the job (workflow_retry) before that fails again.';
const EDIT_EN =
  'devcontour edit-task --task ID --file FILE --workspace …; fields absent from the file are kept, except repositoryId, scope, dependsOn and contracts, which fall back to their defaults: copy them from the current task';
const SERVER_EN =
  'The running DevContour server continues it; if the server is stopped, start it (devcontour start --workspace …).';

const repeatedEn = (taskId: string, q: HintQuestionStops | undefined) =>
  q
    ? ` Task ${taskId} has stopped with a writer question ${q.count} times; only the first ${q.limit} give the attempt back${q.exhausted ? ', further stops count as attempts, and with the attempts used up input_apply returns blocker ATTEMPTS_EXHAUSTED until it is applied with reset {"reason": …}' : ''}. Consider making the task spec answer these questions up front (board_correct or reopen and respecify).`
    : '';
/** Пауза до переноса: задача утверждена, очередь идёт (`apply-carry` с `pause`). */
const pauseCarryEn =
  ' First pause the queue yourself (queue_set {"paused": true}; a pause that the job loop lifts does not count): the superseded question does not hold the task, and once the running attempts end the queue would issue it without the answer.';
/** Пауза человека до старта задания: её снимет цикл (`apply-carry` с `userPause`). */
const userPauseCarryEn =
  ' The queue is paused by the user, but the pause was set before the board job started, so the job loop lifts it, and a lead pause (queue_set) does not replace a user pause: the queue would issue the task without the answer once the running attempts end. Ask the user to pause the queue again now with devcontour queue --pause --workspace … (a command the user runs, without --by host): a pause set after the job start is not lifted by its loop. The user must not start the queue first: while it is paused the panel offers only a start, and a start lets the queue issue the task at once.';
/** Ожидание переноса: в графе доски идут попытки (`apply-carry` с `active`). */
const waitCarryEn = (active: string[]) =>
  ` Wait: attempts run on the board of the task (${active.slice(0, 5).join(', ')}${active.length > 5 ? ', …' : ''}), and input_target and input_apply refuse the carry until they end; start the chain (input_review calls a model) only then.`;
const chainEn = (operator: boolean, taskId: string) =>
  operator
    ? `input_context, input_review --author-runtime; then the operator applies in the panel (${hrefs.input(taskId)})`
    : 'input_context, input_review --author-runtime, input_target, input_apply';

function planEn(p: { scope: number }, s: HintSubject) {
  const plan = s.plan!;
  const boardId = s.boardId!;
  const unverified = plan.unverifiedCount
    ? ` ${plan.unverifiedCount} draft task(s) are unverified agent findings: the lead triages them before approval — verify the reproduction and priority, merge duplicates, cancel stale or misrouted ones (devcontour cancel --task ID --reason … --by host --workspace …), write testable acceptance and gates (${EDIT_EN}; the edit marks the finding triaged): ${hintList(plan.unverified, plan.unverifiedCount, 'plan.unverified')}.`
    : '';
  const blocked = plan.blockedCount
    ? ` ${plan.blockedCount} draft task(s) fail approval preconditions, so approval refuses them and review-plan stops on them before the model call; fix these first (${EDIT_EN}) or cancel them: ${blockedList(s)}.`
    : '';
  const tasks =
    plan.reviewCount <= PLAN_HINT_IDS
      ? `--tasks ${reviewTasks(s)} `
      : plan.reviewCount === p.scope
        ? `(the whole plan, ${plan.reviewCount} tasks: no --tasks needed) `
        : `--tasks ${reviewTasks(s)} (scope truncated: the first ${PLAN_HINT_IDS} of ${plan.reviewCount} reviewable tasks; review the rest in a later round) `;
  const next = plan.reviewCount
    ? ` Review the plan with an explicit scope (devcontour review-plan --board ${boardId} ${tasks}--author-runtime codex|claude --workspace …, keeping only the tasks to run; review-plan also checks INTENT story bindings, which this hint does not), or edit/cancel the tasks first; register workflow_start only for an approved plan.`
    : ' No task of the plan is ready for review: review-plan only after these are handled; register workflow_start only for an approved plan.';
  return `The plan of board ${boardId} is not approved (${plan.drafts.length} draft task(s)${plan.stale.length ? `, ${plan.stale.length} approved under another policy` : ''}).${unverified}${blocked} workflow_start would send the whole plan to review and run every task once approved: choosing the scope is the lead's or the user's decision.${next}`;
}

const failedEn = (error: string | undefined) => (error ? ': ' + error : '');

const en: Catalog = {
  operator: () =>
    'approvalMode operator: lead workflow jobs do not run. The operator reviews plans and accepts boards in the panel, starts the queue (devcontour queue --start --workspace …) and retries failed tasks (devcontour retry --task ID --workspace …).',
  'plan-unapproved': planEn,
  'job-stops': (p, s) =>
    `Next, at stage ${p.stage}, the lead workflow job of board ${s.boardId!} stops: ${reasonOf(s.loop)}. ${STOP_REMEDY_EN}`,
  'job-live': (p, s) =>
    `Board ${s.boardId!} has a live lead workflow job (stage ${s.job!.stage}); next, at stage ${p.stage}, the job loop ${loopEn(s.loop!)}. ${SERVER_EN}`,
  'input-refused': (p, s) =>
    `workflow_start for board ${s.boardId!} would be refused: ${p.reason}. Fix that first (approvals in the panel, tasks of the board), then register the job.`,
  'job-retry-stops': (p, s) =>
    `The lead workflow job of board ${s.boardId!} failed${failedEn(p.error)}, and a retry would stop again: ${reasonOf(s.loop)}. ${STOP_REMEDY_EN} Then workflow_retry ${retryArgs(s)}.`,
  'job-cancelled-task': (p, s) => {
    const task = p.taskId;
    const who =
      p.by === 'host'
        ? 'cancelled by the lead after it had been issued'
        : p.by === 'operator'
          ? 'cancelled by the user'
          : p.by === 'graph'
            ? 'removed by a new revision of the board graph'
            : "cancelled without a recorded actor (counted as the user's cancel)";
    // Повтор задачи ведущим — только своей отмены (или снятой редакцией графа).
    const lead = p.by === 'host' || p.by === 'graph';
    const job = p.live
      ? 'the live job then continues on its own'
      : `then workflow_retry ${retryArgs(s)}`;
    const retry = lead
      ? `task_retry (devcontour retry --task ${task} --by host), ${job}`
      : `the user retries the task in the panel (the retry action on the task page; ask the user), ${job}`;
    const first = p.budget
      ? `(1) the user raises the exceeded budget limit (budgets in the config, applied with devcontour config-apply --keys budgets); then ${retry}`
      : lead
        ? `(1) if the task is still needed, ${retry}`
        : `(1) ${retry}`;
    const owner = p.allCancelled
      ? p.budget || !lead
        ? "Both are the user's decisions and the attention center shows them to the operator: ask the user; do not raise budgets, retry the task or replan the board yourself."
        : "A new board revision instead of the task is the user's decision and the attention center shows it to the operator: ask the user before replanning."
      : p.budget || !lead
        ? "Both are the user's decisions and the attention center shows them to the operator: ask the user; do not raise budgets, retry the task or accept the board yourself."
        : "Accepting without the task is the user's decision and the attention center shows it to the operator: do not accept the board yourself.";
    // Все задачи ревизии отменены: принимать нечего, второй путь — новая ревизия.
    const second = p.allCancelled
      ? `(2) every task of the revision is cancelled, so the board cannot be accepted: when the user decides so, the lead plans a new revision of board ${s.boardId!}`
      : `(2) the operator accepts the revision without task ${task} in the panel (the accept action on the board page) once its other tasks are done`;
    return `The lead workflow job of board ${s.boardId!} ${p.live ? 'stops at its next step' : 'stopped'}${failedEn(p.error)}: task ${task} was ${who}${p.budget ? ' when it hit a budget' : ''}, and an issued task does not leave the job (D46, docs/decisions.md), so workflow_retry and workflow_start do not move it. Recovery paths: ${first}; ${second}. ${owner}`;
  },
  'job-retry': (p, s) =>
    `The lead workflow job of board ${s.boardId!} failed${failedEn(p.error)}. On retry the job loop ${loopEn(s.loop!)}: workflow_retry ${retryArgs(s)}.`,
  'job-exhausted': (p, s) =>
    `The lead workflow job of board ${s.boardId!} used all ${s.job!.maxAttempts} attempts${failedEn(p.error)}. workflow_start returns this failed job until the board input changes: diagnose, then change the board or its tasks (a new input registers a new job) or ask the user.`,
  'job-settled': (_, s) =>
    `A lead workflow job for exactly the current input of board ${s.boardId!} is already ${s.job!.status}${s.job!.status === 'stale' ? ' (the input changed and then returned to it)' : ''}; workflow_start returns it unchanged and it will not run. Change the board or its tasks to register a new job, or continue by hand (devcontour queue --start, retry, accept; docs/cli.md), or ask the user.`,
  'job-idle': (_, s) =>
    `The lead workflow job of board ${s.boardId!} is ${s.job!.status} but does not continue now (a policy apply is pending or another process holds it); check workflow_status.`,
  'board-start': (p, s) =>
    `No live lead workflow job for board ${s.boardId!}${s.job ? ` (its ${s.job.status} job was started on another input)` : ''}: with the DevContour server running, register workflow_start {"kind": "board", "id": ${JSON.stringify(s.boardId!)}, "authorRuntime": …}; queue_set {"paused": false} alone resumes dispatch without the job's pause handling and repairs.` +
    (p.running
      ? ' An attempt is running: the server finishes it without a job; the board can also be continued by hand (MCP task_retry or devcontour retry --by host, accept; docs/cli.md).'
      : ''),
  'pause-lift': (p, s) =>
    `Dispatch is paused (${p.pause}); the lead workflow job of board ${s.boardId!} lifts the pause at stage ${p.stage}${s.loop!.step === 'lift-pause' ? '' : ' after it ' + loopEn(s.loop!)}. ${SERVER_EN}`,
  'pause-operator': (p, s) =>
    (p.by === 'lead'
      ? 'Dispatch is paused by the lead (queue_set) and no job loop lifts it: resume with queue_set {"paused": false} (devcontour queue --start) once the reason for the pause is resolved.'
      : 'Dispatch is paused by the operator and no job loop lifts it: resume only on the user\'s decision with queue_set {"paused": false} (devcontour queue --start).') +
    (s.loop && s.boardId ? ` Meanwhile the job loop of board ${s.boardId} ${loopEn(s.loop)}.` : ''),
  'base-held': (p, s) =>
    `operator: confirm the base move. The moved base changes acceptance or contour setup (${p.paths.length ? p.paths.join(', ') : 'see the wait in the attention center'}), and gates of that base do not prove such a change, so dispatch waits for a human: ask the user to confirm it with the confirm-and-start action of the base move card in the attention center of the panel. The lead does not lift this wait itself (no queue_set, no workflow_retry). The job loop lifts on its own only contract documents at the exact text that an independent review approved (review-contract or contract-change); acceptance files, profile, config and gates always need the user.` +
    (s.boardId ? ` The job loop of board ${s.boardId} waits until then.` : ''),
  'follow-up': (p, s) => {
    const { requestId, taskId } = s.input!;
    return `Follow-up ${requestId} of task ${taskId} (a decision the writer took itself, severity ${p.severity}): accept it with input_cancel {"requestId": "${requestId}", "expectedVersion": ${p.version}, "reason": "assumption accepted"} or, if it changes requirements, correct the board (board_correct) and input_supersede with the replacement task (a task without an accepted result: reopen, respecify and supersede with the same task).`;
  },
  'answer-lead': (p, s) => {
    const { requestId, taskId } = s.input!;
    return (
      `Task ${taskId} waits for an answer to ${requestId} (no floors, approvalMode agent): answer with input_answer {"requestId": "${requestId}", "expectedVersion": ${p.version}, …} after input_show, or let the operator answer in the panel (${hrefs.input(taskId)}). The answer does not resume the task by itself.` +
      repeatedEn(taskId, p.stops)
    );
  },
  'answer-operator': (p, s) => {
    const { requestId, taskId } = s.input!;
    return (
      `Task ${taskId} waits for the operator's answer to ${requestId} in the panel (${hrefs.input(taskId)})${p.floors.length ? `: the question is critical (${p.floors.join(', ')})` : ''}. Do not answer it yourself; no queue step helps. ` +
      (p.proposed
        ? 'Your proposed answer waits for the operator to confirm it in one click or answer differently; replace it with input_propose only if the facts changed, and tell the user the decision is waiting.'
        : `If the registered contracts and accepted files decide it, propose the answer: input_propose {"requestId": "${requestId}", "expectedVersion": ${p.version ?? '…'}, "text": …, "optionId": …, "reasoning": …} after input_show; the operator confirms it in one click or answers differently. Otherwise ask the user to answer in the panel.`) +
      repeatedEn(taskId, p.stops)
    );
  },
  'apply-stale': (p, s) => {
    const { requestId, taskId } = s.input!;
    return (
      `The applied answer to ${requestId} went stale before the next attempt (${p.reason}): rebuild it — ${chainEn(p.operator, taskId)}.` +
      repeatedEn(taskId, p.stops)
    );
  },
  'apply-rejected': (p, s) => {
    const { requestId, taskId } = s.input!;
    return (
      `The reviewer rejected the answer to ${requestId} (input_show names the findings): ` +
      (p.operatorAnswers
        ? p.proposed
          ? 'the operator corrects the answer; your proposed correction waits for the operator to confirm it'
          : 'the operator corrects the answer; propose a corrected answer with input_propose for the operator to confirm, or reopen and respecify the task'
        : 'correct the answer, or reopen and respecify the task') +
      `${p.operator ? '; the operator may apply it only with explicit confirmation' : ''}.` +
      repeatedEn(taskId, p.stops)
    );
  },
  'apply-claim': (p, s) => {
    const { requestId, taskId } = s.input!;
    return (
      `The answer to ${requestId} is applied; task ${taskId} waits for its next attempt.` +
      repeatedEn(taskId, p.stops)
    );
  },
  'apply-saved': (p, s) => {
    const { requestId, taskId } = s.input!;
    return (
      `The answer to ${requestId} is saved but not applied (${p.state}): ${chainEn(p.operator, taskId)}.` +
      repeatedEn(taskId, p.stops)
    );
  },
  'apply-moved': (p, s) => {
    const { requestId, taskId } = s.input!;
    const chain = 'input_context, input_review, input_target, input_apply';
    return (
      `The saved answer to ${requestId} cannot be applied: the stop of task ${taskId} no longer holds (its spec changed after the question, not only by a contract-change rebinding, or another attempt ran), so input_apply would be refused. ` +
      (p.operatorAnswers
        ? `You may not supersede this question: ask the user to cancel it in the panel (${hrefs.input(taskId)}) or supersede it with the same task (devcontour input-supersede --by operator), then carry the answer (${chain}).`
        : `Supersede it with the same task (input_supersede) and carry the answer (${chain}), or cancel it (input_cancel).`) +
      repeatedEn(taskId, p.stops)
    );
  },
  'apply-auto': (p, s) => {
    const { requestId, taskId } = s.input!;
    const chain = 'input_context, input_review, input_target, input_apply';
    const why = p.detail ? ` (${p.detail})` : '';
    return (
      (p.phase === 'failed'
        ? `DevContour could not review the answer to ${requestId} automatically${why}: fix the cause (runtime, budget), then run ${chain} yourself.`
        : p.phase === 'blocked'
          ? `The answer to ${requestId} is reviewed but cannot be applied${why}: resolve that cause, then input_target and input_apply${p.detail?.startsWith('ATTEMPTS_EXHAUSTED') ? ' with reset.reason (the attempt budget of the task is spent)' : ''}.`
          : p.phase === 'needs-lead'
            ? p.detail === 'requirement-change'
              ? `The answer to ${requestId} changes requirements: reopen and respecify task ${taskId}, input_supersede with the same task, carry the answer (${chain}), then approve the task.`
              : `DevContour does not know the author runtime to review the answer to ${requestId}: start the board job (workflow_start) or run ${chain} yourself.`
            : `DevContour continues task ${taskId} on the server after the ${p.trigger === 'operator' ? "operator's" : "lead's"} answer to ${requestId} (${p.phase}): it runs ${chain} itself with the configured reviewer and the same checks. Do not run them yourself; wait, or read input_show.`) +
      repeatedEn(taskId, p.stops)
    );
  },
  'apply-carry': (p, s) => {
    const { requestId, taskId } = s.input!;
    const chain = 'input_context, input_review, input_target, input_apply';
    return (
      `The answer to the superseded question ${requestId} waits to be carried into task ${taskId}: ${
        p.order === 'draft'
          ? `carry it while the task is a draft (${chain}), then approve the task (workflow_start or review-plan --tasks ${taskId}): the approval keeps the carried answer when the spec is unchanged after the carry.`
          : p.order === 'unreleased'
            ? `the board of the task has no approved task yet, so the answer cannot be carried into the draft: pause the queue (queue_set), approve the task (workflow_start or review-plan --tasks ${taskId}), carry the answer (${chain}), then lift the pause.`
            : p.active
              ? `carry it after they end (${chain}).`
              : `carry it now (${chain}): the superseded question does not hold the task, so pause the queue (queue_set) if an attempt without the answer must not start.`
      }` +
      (p.pause ? pauseCarryEn : '') +
      (p.userPause ? userPauseCarryEn : '') +
      (p.active ? waitCarryEn(p.active) : '')
    );
  },
};

// ── Русский ────────────────────────────────────────────────────────────────

function loopRu(o: LoopOutlook) {
  switch (o.step) {
    case 'review-plan':
      return 'проведёт ревью плана';
    case 'advance':
      return 'завершит стадию';
    case 'recovery':
      return `проведёт эпизод свойства задачи ${o.taskId} (${o.action})`;
    case 'repair':
      return `повторит задачу ${o.taskId} (${o.reason})`;
    case 'stop':
      return `остановится: ${o.reason}`;
    case 'check-base':
      return 'проверит сдвинутую базу';
    case 'lift-pause':
      return `снимет паузу ${o.pause}`;
    case 'wait':
      return 'будет ждать задач доски';
    case 'accept':
      return 'примет доску';
    case 'none':
      return 'ничего не сделает';
  }
}

const STOP_REMEDY_RU =
  'Разберите причину; исправьте или повторите задачу вручную (MCP task_retry или devcontour retry --task ID --by host [--reset --reason TEXT]; эпизод свойства — recovery_decide) либо спросите пользователя. Повтор задания (workflow_retry) до этого снова упадёт.';
const EDIT_RU =
  'devcontour edit-task --task ID --file FILE --workspace …; отсутствующие в файле поля сохраняются, кроме repositoryId, scope, dependsOn и contracts — они получают значения по умолчанию: перенесите их из текущей задачи';
const SERVER_RU =
  'Его продолжает работающий сервер DevContour; если сервер остановлен, запустите его (devcontour start --workspace …).';

const repeatedRu = (taskId: string, q: HintQuestionStops | undefined) =>
  q
    ? ` Остановок задачи ${taskId} вопросом исполнителя: ${q.count}; попытку возвращают только первые ${q.limit}${q.exhausted ? ', дальнейшие остановки расходуют попытки, а при исчерпанных попытках input_apply возвращает блокер ATTEMPTS_EXHAUSTED, пока ответ не применён с reset {"reason": …}' : ''}. Стоит дополнить постановку задачи ответами на эти вопросы заранее (board_correct или переоткрытие с новой постановкой).`
    : '';
/** Пауза до переноса: задача утверждена, очередь идёт (`apply-carry` с `pause`). */
const pauseCarryRu =
  ' Сначала сами поставьте очередь на паузу (queue_set {"paused": true}; пауза, которую снимет цикл задания, не в счёт): заменённый вопрос выдачу задачи не держит, и по окончании идущих попыток очередь выдала бы её без ответа.';
/** Пауза человека до старта задания: её снимет цикл (`apply-carry` с `userPause`). */
const userPauseCarryRu =
  ' Очередь приостановил пользователь, но до старта задания доски, поэтому цикл задания эту паузу снимет, а пауза ведущего (queue_set) паузу пользователя не заменяет: по окончании идущих попыток очередь выдала бы задачу без ответа. Попросите пользователя сейчас снова поставить очередь на паузу командой devcontour queue --pause --workspace … (его собственная команда, без --by host): паузу, поставленную после старта задания, его цикл не снимает. Запускать очередь перед этим пользователь не должен: пока очередь на паузе, панель предлагает только запуск, а запуск сразу позволит очереди выдать задачу.';
/** Ожидание переноса: в графе доски идут попытки (`apply-carry` с `active`). */
const waitCarryRu = (active: string[]) =>
  ` Подождите: в графе доски задачи идут попытки (${active.slice(0, 5).join(', ')}${active.length > 5 ? ', …' : ''}), и input_target и input_apply откажут в переносе до их окончания; цепочку начинайте только потом (input_review вызывает модель).`;
const chainRu = (operator: boolean, taskId: string) =>
  operator
    ? `input_context, input_review --author-runtime; затем оператор применяет ответ в панели (${hrefs.input(taskId)})`
    : 'input_context, input_review --author-runtime, input_target, input_apply';

function planRu(p: { scope: number }, s: HintSubject) {
  const plan = s.plan!;
  const boardId = s.boardId!;
  const unverified = plan.unverifiedCount
    ? ` Неразобранные находки агентов среди черновиков: ${plan.unverifiedCount}. Ведущий разбирает их до утверждения — проверяет воспроизведение и приоритет, объединяет дубликаты, отменяет устаревшие и ошибочно направленные (devcontour cancel --task ID --reason … --by host --workspace …), пишет проверяемые критерии приёмки и gates (${EDIT_RU}; правка отмечает находку разобранной): ${hintList(plan.unverified, plan.unverifiedCount, 'plan.unverified')}.`
    : '';
  const blocked = plan.blockedCount
    ? ` Черновики, не проходящие условия утверждения: ${plan.blockedCount}. Утверждение их отвергнет, а review-plan остановится на них до вызова модели; сначала исправьте их (${EDIT_RU}) или отмените: ${blockedList(s)}.`
    : '';
  const tasks =
    plan.reviewCount <= PLAN_HINT_IDS
      ? `--tasks ${reviewTasks(s)} `
      : plan.reviewCount === p.scope
        ? `(весь план, задач: ${plan.reviewCount}; --tasks не нужен) `
        : `--tasks ${reviewTasks(s)} (область усечена: первые ${PLAN_HINT_IDS} из ${plan.reviewCount} задач, готовых к ревью; остальные — в следующем раунде) `;
  const next = plan.reviewCount
    ? ` Проведите ревью плана с явной областью (devcontour review-plan --board ${boardId} ${tasks}--author-runtime codex|claude --workspace …, оставив только задачи к исполнению; review-plan проверяет и привязки к историям INTENT, чего эта подсказка не делает) или сначала исправьте либо отмените задачи; workflow_start регистрируйте только для утверждённого плана.`
    : ' Ни одна задача плана не готова к ревью: review-plan — только после разбора этих задач; workflow_start регистрируйте только для утверждённого плана.';
  return `План доски ${boardId} не утверждён (черновиков: ${plan.drafts.length}${plan.stale.length ? `, утверждено при другой политике: ${plan.stale.length}` : ''}).${unverified}${blocked} workflow_start отправил бы на ревью весь план и после утверждения запустил бы все его задачи: выбор объёма — решение ведущего или пользователя.${next}`;
}

const failedRu = (error: string | undefined) => (error ? ': ' + error : '');

const ru: Catalog = {
  operator: () =>
    'approvalMode operator: задания ведущего не исполняются. Оператор проводит ревью планов и принимает доски в панели, запускает очередь (devcontour queue --start --workspace …) и повторяет упавшие задачи (devcontour retry --task ID --workspace …).',
  'plan-unapproved': planRu,
  'job-stops': (p, s) =>
    `На следующем такте, на стадии ${p.stage}, задание ведущего доски ${s.boardId!} остановится: ${reasonOf(s.loop)}. ${STOP_REMEDY_RU}`,
  'job-live': (p, s) =>
    `У доски ${s.boardId!} действующее задание ведущего (стадия ${s.job!.stage}); на следующем такте, на стадии ${p.stage}, цикл задания ${loopRu(s.loop!)}. ${SERVER_RU}`,
  'input-refused': (p, s) =>
    `workflow_start для доски ${s.boardId!} будет отклонён: ${p.reason}. Сначала устраните это (согласования в панели, задачи доски), затем зарегистрируйте задание.`,
  'job-retry-stops': (p, s) =>
    `Задание ведущего доски ${s.boardId!} упало${failedRu(p.error)}, и повтор снова остановится: ${reasonOf(s.loop)}. ${STOP_REMEDY_RU} Затем workflow_retry ${retryArgs(s)}.`,
  'job-cancelled-task': (p, s) => {
    const task = p.taskId;
    const who =
      p.by === 'host'
        ? 'отменена ведущим агентом уже после выдачи'
        : p.by === 'operator'
          ? 'отменена пользователем'
          : p.by === 'graph'
            ? 'убрана новой редакцией графа доски'
            : 'отменена без записанного актёра (считается отменой пользователя)';
    const lead = p.by === 'host' || p.by === 'graph';
    const job = p.live
      ? 'затем действующее задание продолжится само'
      : `затем workflow_retry ${retryArgs(s)}`;
    const retry = lead
      ? `task_retry (devcontour retry --task ${task} --by host), ${job}`
      : `пользователь повторяет задачу в панели (повтор на странице задачи; спросите пользователя), ${job}`;
    const first = p.budget
      ? `(1) пользователь поднимает исчерпанный предел бюджета (budgets в конфигурации, применение — devcontour config-apply --keys budgets); затем ${retry}`
      : lead
        ? `(1) если задача ещё нужна — ${retry}`
        : `(1) ${retry}`;
    const owner = p.allCancelled
      ? p.budget || !lead
        ? 'Оба решения — пользователя, центр внимания показывает их оператору: спросите пользователя; сами не поднимайте бюджет, не повторяйте задачу и не перепланируйте доску.'
        : 'Новая ревизия доски вместо задачи — решение пользователя, центр внимания показывает его оператору: спросите пользователя, прежде чем перепланировать.'
      : p.budget || !lead
        ? 'Оба решения — пользователя, центр внимания показывает их оператору: спросите пользователя; сами не поднимайте бюджет, не повторяйте задачу и не принимайте доску.'
        : 'Приёмка без задачи — решение пользователя, центр внимания показывает его оператору: сами доску не принимайте.';
    const second = p.allCancelled
      ? `(2) все задачи ревизии отменены, принимать нечего: по решению пользователя ведущий планирует новую ревизию доски ${s.boardId!}`
      : `(2) оператор принимает ревизию без задачи ${task} в панели (страница доски, «Принять доску»), когда остальные задачи готовы`;
    return `Задание ведущего доски ${s.boardId!} ${p.live ? 'остановится на следующем такте' : 'остановлено'}${failedRu(p.error)}: задача ${task} ${who}${p.budget ? ', когда упёрлась в бюджет' : ''}, а выданная задача из работы задания не выпадает (D46, docs/decisions.md), поэтому workflow_retry и workflow_start его не продвинут. Пути восстановления: ${first}; ${second}. ${owner}`;
  },
  'job-retry': (p, s) =>
    `Задание ведущего доски ${s.boardId!} упало${failedRu(p.error)}. После workflow_retry цикл задания ${loopRu(s.loop!)}: workflow_retry ${retryArgs(s)}.`,
  'job-exhausted': (p, s) =>
    `Задание ведущего доски ${s.boardId!} израсходовало все попытки (${s.job!.maxAttempts})${failedRu(p.error)}. Пока вход доски не изменится, workflow_start возвращает это упавшее задание: разберите причину, затем измените доску или её задачи (новый вход регистрирует новое задание) либо спросите пользователя.`,
  'job-settled': (_, s) =>
    `Задание ведущего для точно такого же текущего входа доски ${s.boardId!} уже в состоянии ${s.job!.status}${s.job!.status === 'stale' ? ' (вход менялся и вернулся к прежнему)' : ''}; workflow_start вернёт его без изменений, и оно не будет исполняться. Измените доску или её задачи, чтобы зарегистрировать новое задание, или продолжайте вручную (devcontour queue --start, retry, accept; docs/cli.md), или спросите пользователя.`,
  'job-idle': (_, s) =>
    `Задание ведущего доски ${s.boardId!} в состоянии ${s.job!.status}, но сейчас не продолжается (ждёт применения политики или его держит другой процесс); проверьте workflow_status.`,
  'board-start': (p, s) =>
    `У доски ${s.boardId!} нет действующего задания ведущего${s.job ? ` (её задание в состоянии ${s.job.status} начато на другом входе)` : ''}: при работающем сервере DevContour зарегистрируйте workflow_start {"kind": "board", "id": ${JSON.stringify(s.boardId!)}, "authorRuntime": …}; один queue_set {"paused": false} возобновляет выдачу без снятия пауз и восстановлений задания.` +
    (p.running
      ? ' Идёт попытка: сервер завершит её и без задания; доску можно продолжить и вручную (MCP task_retry или devcontour retry --by host, accept; docs/cli.md).'
      : ''),
  'pause-lift': (p, s) =>
    `Выдача на паузе (${p.pause}); задание ведущего доски ${s.boardId!} снимет паузу на стадии ${p.stage}${s.loop!.step === 'lift-pause' ? '' : '; до этого цикл задания ' + loopRu(s.loop!)}. ${SERVER_RU}`,
  'pause-operator': (p, s) =>
    (p.by === 'lead'
      ? 'Выдачу приостановил ведущий агент (queue_set), и ни один цикл задания её не снимет: возобновите queue_set {"paused": false} (devcontour queue --start), когда причина паузы устранена.'
      : 'Выдачу приостановил оператор, и ни один цикл задания её не снимет: возобновляйте только по решению пользователя — queue_set {"paused": false} (devcontour queue --start).') +
    (s.loop && s.boardId ? ` Тем временем цикл задания доски ${s.boardId} ${loopRu(s.loop)}.` : ''),
  'base-held': (p, s) =>
    `operator: подтвердите перенос базы. Перенесённая база меняет приёмку или настройку контура (${p.paths.length ? p.paths.join(', ') : 'см. ожидание в центре внимания'}), а gates этой базы такое изменение не доказывают, поэтому выдача ждёт человека: попросите пользователя подтвердить перенос кнопкой «Подтвердить и запустить» в «Внимании» панели. Ведущий агент это ожидание сам не снимает (ни queue_set, ни workflow_retry). Цикл задания сам снимает только документы контрактов в редакции, одобренной независимым ревью (review-contract или contract-change); файлы приёмки, профиль, конфигурацию и gates всегда подтверждает пользователь.` +
    (s.boardId ? ` До этого цикл задания доски ${s.boardId} ждёт.` : ''),
  'follow-up': (p, s) => {
    const { requestId, taskId } = s.input!;
    return `Follow-up ${requestId} задачи ${taskId} (решение, которое исполнитель принял сам, серьёзность ${p.severity}): примите его через input_cancel {"requestId": "${requestId}", "expectedVersion": ${p.version}, "reason": "assumption accepted"} или, если оно меняет требования, скорректируйте доску (board_correct) и выполните input_supersede с задачей-заменой (задача без принятого результата: переоткройте её, задайте новую постановку и замените той же задачей).`;
  },
  'answer-lead': (p, s) => {
    const { requestId, taskId } = s.input!;
    return (
      `Задача ${taskId} ждёт ответа на ${requestId} (минимумов нет, approvalMode agent): ответьте через input_answer {"requestId": "${requestId}", "expectedVersion": ${p.version}, …} после input_show или оставьте ответ оператору в панели (${hrefs.input(taskId)}). Сам ответ задачу не возобновляет.` +
      repeatedRu(taskId, p.stops)
    );
  },
  'answer-operator': (p, s) => {
    const { requestId, taskId } = s.input!;
    return (
      `Задача ${taskId} ждёт ответа оператора на ${requestId} в панели (${hrefs.input(taskId)})${p.floors.length ? `: вопрос критический (${p.floors.join(', ')})` : ''}. Сами на него не отвечайте; шаг очереди не поможет. ` +
      (p.proposed
        ? 'Ваше предложение ответа ждёт оператора: он подтвердит его одним нажатием или ответит иначе. Заменяйте его через input_propose, только если факты изменились, и сообщите пользователю, что решение ждёт его.'
        : `Если ответ следует из зарегистрированных контрактов и принятых файлов, предложите его: input_propose {"requestId": "${requestId}", "expectedVersion": ${p.version ?? '…'}, "text": …, "optionId": …, "reasoning": …} после input_show; оператор подтвердит его одним нажатием или ответит иначе. Иначе попросите пользователя ответить в панели.`) +
      repeatedRu(taskId, p.stops)
    );
  },
  'apply-stale': (p, s) => {
    const { requestId, taskId } = s.input!;
    return (
      `Применённый ответ на ${requestId} устарел до следующей попытки (${p.reason}): соберите его заново — ${chainRu(p.operator, taskId)}.` +
      repeatedRu(taskId, p.stops)
    );
  },
  'apply-rejected': (p, s) => {
    const { requestId, taskId } = s.input!;
    return (
      `Ревьюер отклонил ответ на ${requestId} (замечания — в input_show): ` +
      (p.operatorAnswers
        ? p.proposed
          ? 'ответ исправляет оператор; ваше предложение исправления ждёт его подтверждения'
          : 'ответ исправляет оператор; предложите исправленный ответ через input_propose, чтобы оператор подтвердил его, или переоткройте задачу с новой постановкой'
        : 'исправьте ответ или переоткройте задачу с новой постановкой') +
      `${p.operator ? '; оператор может применить его только с явным подтверждением' : ''}.` +
      repeatedRu(taskId, p.stops)
    );
  },
  'apply-claim': (p, s) => {
    const { requestId, taskId } = s.input!;
    return (
      `Ответ на ${requestId} применён; задача ${taskId} ждёт следующей попытки.` +
      repeatedRu(taskId, p.stops)
    );
  },
  'apply-saved': (p, s) => {
    const { requestId, taskId } = s.input!;
    return (
      `Ответ на ${requestId} сохранён, но не применён (${p.state}): ${chainRu(p.operator, taskId)}.` +
      repeatedRu(taskId, p.stops)
    );
  },
  'apply-moved': (p, s) => {
    const { requestId, taskId } = s.input!;
    const chain = 'input_context, input_review, input_target, input_apply';
    return (
      `Сохранённый ответ на ${requestId} применить нельзя: исходная остановка задачи ${taskId} не держится (постановка изменилась после вопроса не только перепривязкой контракта, или была другая попытка), и input_apply откажет. ` +
      (p.operatorAnswers
        ? `Заменить этот вопрос вы не вправе: попросите пользователя снять его в панели (${hrefs.input(taskId)}) или заменить той же задачей (devcontour input-supersede --by operator), затем перенесите ответ (${chain}).`
        : `Замените его той же задачей (input_supersede) и перенесите ответ (${chain}) или снимите его (input_cancel).`) +
      repeatedRu(taskId, p.stops)
    );
  },
  'apply-auto': (p, s) => {
    const { requestId, taskId } = s.input!;
    const chain = 'input_context, input_review, input_target, input_apply';
    const why = p.detail ? ` (${p.detail})` : '';
    return (
      (p.phase === 'failed'
        ? `DevContour не смог автоматически проверить ответ на ${requestId}${why}: устраните причину (рантайм, бюджет) и выполните ${chain} сами.`
        : p.phase === 'blocked'
          ? `Ответ на ${requestId} проверен, но применить его нельзя${why}: устраните эту причину, затем input_target и input_apply${p.detail?.startsWith('ATTEMPTS_EXHAUSTED') ? ' с reset.reason (бюджет попыток задачи исчерпан)' : ''}.`
          : p.phase === 'needs-lead'
            ? p.detail === 'requirement-change'
              ? `Ответ на ${requestId} меняет требования: переоткройте задачу ${taskId} с новой постановкой, input_supersede той же задачей, перенесите ответ (${chain}), затем утвердите задачу.`
              : `DevContour не знает рантайм автора для ревью ответа на ${requestId}: запустите задание доски (workflow_start) или выполните ${chain} сами.`
            : `DevContour продолжает задачу ${taskId} на сервере после ответа ${p.trigger === 'operator' ? 'оператора' : 'ведущего'} на ${requestId} (${p.phase}): он сам выполняет ${chain} с настроенным ревьюером и теми же проверками. Сами их не выполняйте; ждите или читайте input_show.`) +
      repeatedRu(taskId, p.stops)
    );
  },
  'apply-carry': (p, s) => {
    const { requestId, taskId } = s.input!;
    const chain = 'input_context, input_review, input_target, input_apply';
    return (
      `Ответ заменённого вопроса ${requestId} ждёт переноса в задачу ${taskId}: ${
        p.order === 'draft'
          ? `перенесите его, пока задача — черновик (${chain}), затем утвердите задачу (workflow_start или review-plan --tasks ${taskId}): утверждение сохраняет перенесённый ответ, если постановка после переноса не менялась.`
          : p.order === 'unreleased'
            ? `у доски задачи ещё нет утверждённых задач, и перенести ответ в черновик нельзя: поставьте очередь на паузу (queue_set), утвердите задачу (workflow_start или review-plan --tasks ${taskId}), перенесите ответ (${chain}), затем снимите паузу.`
            : p.active
              ? `перенесите его после их окончания (${chain}).`
              : `перенесите его сейчас (${chain}): заменённый вопрос выдачу задачи не держит, поэтому поставьте очередь на паузу (queue_set), если попытка без ответа начаться не должна.`
      }` +
      (p.pause ? pauseCarryRu : '') +
      (p.userPause ? userPauseCarryRu : '') +
      (p.active ? waitCarryRu(p.active) : '')
    );
  },
};

/** Каталоги по языку: у каждого кода — текст на каждом языке (проверяет тип и тест). */
export const hintCatalogs: Record<HintLocale, Catalog> = { en, ru };

/** Текст шага на языке `locale` по коду, параметрам и полям шага. */
export function hintDetail(step: HintSubject & HintOf, locale: HintLocale): string {
  const render = hintCatalogs[locale][step.code] as (p: unknown, s: HintSubject) => string;
  return render(step.params, step);
}

/**
 * Язык человекочитаемого ответа независимого ревьюера (план, контракт):
 * итог и находки показываются оператору в панели и центре внимания. Без
 * `hintLocale` или с английским — указания нет, промпт прежний. Машинные
 * поля, булево `approved`, значения перечислений (`severity`, `status`) и
 * идентификаторы ревьюер оставляет как есть: их разбирает harness. Прежние
 * находки после смены языка остаются на прежнем: их состояние — только в
 * `previous`, без повтора новыми находками по-русски.
 */
export function reviewLanguageInstructions(locale: HintLocale): string[] {
  return locale === 'ru'
    ? [
        'Language: the operator reads your review in Russian. Write all human-readable text of your answer in Russian: the summary, every finding message, the basis of each previous finding and any other free-text explanation. Keep JSON keys, the boolean approved, enum values (severity, status), rule names, ids, file paths, commands and code verbatim, in their original language. Previous findings may be in another language: report their state only in `previous`, by id, and do not restate them as new findings in Russian.',
      ]
    : [];
}
