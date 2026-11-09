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
  /** Пауза человека, её не снимает ни одно задание. */
  'pause-operator': None;
  /** Открытый follow-up исполнителя. */
  'follow-up': { severity: number; version: number };
  /** Вопрос ждёт ответа ведущего (без минимумов, режим agent). */
  'answer-lead': { version: number } & Stops;
  /** Вопрос ждёт ответа оператора; `floors` — минимумы критичности. */
  'answer-operator': { floors: string[] } & Stops;
  /** Применённый ответ устарел; `operator` — применяет оператор. */
  'apply-stale': { reason: string; operator: boolean } & Stops;
  /** Ревью отклонило ответ. */
  'apply-rejected': { operator: boolean } & Stops;
  /** Ответ применён, задача ждёт следующей попытки. */
  'apply-claim': Stops;
  /** Ответ сохранён, но не применён (`state`). */
  'apply-saved': { state: string; operator: boolean } & Stops;
}
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
  'pause-operator': (_, s) =>
    'Dispatch is paused by the operator and no job loop lifts it: resume only on the user\'s decision with queue_set {"paused": false} (devcontour queue --start).' +
    (s.loop && s.boardId ? ` Meanwhile the job loop of board ${s.boardId} ${loopEn(s.loop)}.` : ''),
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
      `Task ${taskId} waits for the operator's answer to ${requestId} in the panel (${hrefs.input(taskId)})${p.floors.length ? `: the question is critical (${p.floors.join(', ')})` : ''}. Wait: the lead does not answer it and no queue step helps.` +
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
      `The reviewer rejected the answer to ${requestId} (input_show names the findings): correct the answer, or reopen and respecify the task${p.operator ? '; the operator may apply it only with explicit confirmation' : ''}.` +
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
};

// ── Русский ────────────────────────────────────────────────────────────────

function loopRu(o: LoopOutlook) {
  switch (o.step) {
    case 'review-plan':
      return 'проводит ревью плана';
    case 'advance':
      return 'завершает стадию';
    case 'recovery':
      return `ведёт эпизод свойства задачи ${o.taskId} (${o.action})`;
    case 'repair':
      return `повторяет задачу ${o.taskId} (${o.reason})`;
    case 'stop':
      return `останавливает задание: ${o.reason}`;
    case 'check-base':
      return 'проверяет сдвинутую базу';
    case 'lift-pause':
      return `снимает паузу ${o.pause}`;
    case 'wait':
      return 'ждёт задач доски';
    case 'accept':
      return 'принимает доску';
    case 'none':
      return 'ничего не делает';
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
    ? ` Задача ${taskId} останавливалась вопросом исполнителя ${q.count} раз(а); попытку возвращают только первые ${q.limit}${q.exhausted ? ', дальнейшие остановки расходуют попытки, а при исчерпанных попытках input_apply возвращает блокер ATTEMPTS_EXHAUSTED, пока ответ не применён с reset {"reason": …}' : ''}. Стоит дополнить постановку задачи ответами на эти вопросы заранее (board_correct или переоткрытие с новой постановкой).`
    : '';
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
  'job-retry': (p, s) =>
    `Задание ведущего доски ${s.boardId!} упало${failedRu(p.error)}. При повторе цикл задания ${loopRu(s.loop!)}: workflow_retry ${retryArgs(s)}.`,
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
    `Выдача на паузе (${p.pause}); задание ведущего доски ${s.boardId!} снимет паузу на стадии ${p.stage}${s.loop!.step === 'lift-pause' ? '' : ', после того как ' + loopRu(s.loop!)}. ${SERVER_RU}`,
  'pause-operator': (_, s) =>
    'Выдачу приостановил оператор, и ни один цикл задания её не снимет: возобновляйте только по решению пользователя — queue_set {"paused": false} (devcontour queue --start).' +
    (s.loop && s.boardId ? ` Тем временем цикл задания доски ${s.boardId} ${loopRu(s.loop)}.` : ''),
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
      `Задача ${taskId} ждёт ответа оператора на ${requestId} в панели (${hrefs.input(taskId)})${p.floors.length ? `: вопрос критический (${p.floors.join(', ')})` : ''}. Ждите: ведущий на него не отвечает, и шаг очереди не поможет.` +
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
      `Ревьюер отклонил ответ на ${requestId} (замечания — в input_show): исправьте ответ или переоткройте задачу с новой постановкой${p.operator ? '; оператор может применить его только с явным подтверждением' : ''}.` +
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
};

/** Каталоги по языку: у каждого кода — текст на каждом языке (проверяет тип и тест). */
export const hintCatalogs: Record<HintLocale, Catalog> = { en, ru };

/** Текст шага на языке `locale` по коду, параметрам и полям шага. */
export function hintDetail(step: HintSubject & HintOf, locale: HintLocale): string {
  const render = hintCatalogs[locale][step.code] as (p: unknown, s: HintSubject) => string;
  return render(step.params, step);
}
