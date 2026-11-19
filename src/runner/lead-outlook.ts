// Что сделает цикл ведущего (`LeadRunner`) со своим заданием доски на
// следующем такте — чистые правила без записи. Цикл исполняет ровно эти
// решения, пакет передачи контекста (`session_handoff`) объясняет по ним
// следующий шаг: правила одни, разойтись им негде.
import { LeadWorkflow, type WorkflowJob } from '../core/lead-workflow.ts';
import { boardOwner } from '../core/sync-state.ts';
import {
  DomainError,
  unverifiedFinding,
  type AuditEvent,
  type DevContourState,
  type Task,
} from '../core/model.ts';
import type { DevContour } from '../core/service.ts';
import { carriedTaskIds, heldBaseOf, staleBaseStop } from '../core/work-status.ts';
import { repairDecision, type RepairDecision } from '../core/repair.ts';
import { findingOutsideScope } from '../core/workflow.ts';

/** Решение по эпизоду восстановления свойства (`recoverProperties`). */
export type RecoveryStep =
  /** Цикл остановится: задание упадёт с этой причиной. */
  | { kind: 'stop'; task: Task; reason: string }
  /** Разбор ведущим: резерв вызова модели и решение по эпизоду. */
  | { kind: 'analyze'; task: Task }
  /** Разбор оборвался без решения: эпизод закрывается, задание падает. */
  | { kind: 'interrupted'; task: Task; reason: string }
  /** Добавление случаев эпизода, затем решение после него. */
  | { kind: 'apply'; task: Task }
  /** Решение принято: повтор задачи или ожидание его результата. */
  | { kind: 'after'; task: Task };

/**
 * Пауза человека, поставленная после старта задания (или без времени,
 * записанная прежней версией), — его решение: цикл её не снимает.
 */
export const operatorDecided = (s: DevContourState, job: Pick<WorkflowJob, 'startedAt'>) =>
  s.paused &&
  s.pauseReason === 'operator' &&
  (s.pausedAt === undefined || s.pausedAt >= job.startedAt);

/** Первый эпизод восстановления среди задач работы и что с ним сделает цикл. */
export function recoveryStep(
  h: DevContour,
  s: DevContourState,
  job: WorkflowJob,
  taskIds: readonly string[],
): RecoveryStep | undefined {
  const tasks = s.tasks.filter((t) => taskIds.includes(t.id) && t.recovery);
  for (const task of tasks) {
    const r = task.recovery!;
    if (task.status === 'cancelled') continue;
    switch (r.status) {
      case 'awaiting-lead':
        if (operatorDecided(s, job))
          return {
            kind: 'stop',
            task,
            reason: `${task.id}: разбор свойства ${r.property} ждёт снятия паузы человеком`,
          };
        if ((job.repairs ?? 0) >= h.config.repairBudget)
          return {
            kind: 'stop',
            task,
            reason: `${task.id}: исчерпан бюджет восстановлений доски; разбор свойства ${r.property} — решение человека`,
          };
        return { kind: 'analyze', task };
      case 'analyzing':
        return {
          kind: 'interrupted',
          task,
          reason: `${task.id}: разбор прерван до решения; нужен ведущий или пользователь`,
        };
      case 'applying':
        return { kind: 'apply', task };
      case 'retry':
      case 'retrying':
        return { kind: 'after', task };
      default:
        return {
          kind: 'stop',
          task,
          reason: `${task.id}: ${r.reason ?? 'разбор свойства ' + r.property + ' ждёт решения'}`,
        };
    }
  }
  return undefined;
}

/** Исход решения по эпизоду (`afterDecision`): повтор, ожидание или остановка. */
export function afterStep(
  task: Task,
): { kind: 'none' } | { kind: 'retry-task' } | { kind: 'wait' } | { kind: 'stop'; reason: string } {
  const r = task.recovery;
  if (!r) return { kind: 'none' };
  if (r.status === 'retry' && task.status === 'cancelled')
    return { kind: 'stop', reason: `${task.id}: задача отменена человеком` };
  if (r.status === 'retry' && task.status === 'failed') return { kind: 'retry-task' };
  if (r.status === 'retry' || r.status === 'retrying') return { kind: 'wait' };
  return { kind: 'stop', reason: `${task.id}: ${r.reason ?? r.status}` };
}

/** Решение по упавшим задачам работы в бюджете восстановлений задания. */
export function repairStep(h: DevContour, job: WorkflowJob, taskIds: readonly string[]) {
  return repairDecision(
    h,
    taskIds.map((id) => ({ id })),
    {
      budgetLeft: h.config.repairBudget - (job.repairs ?? 0),
      maxAttempts: h.config.maxAttempts,
    },
  );
}

/**
 * Пауза выдачи на стадии задания: проверить перенесённую базу, снять паузу
 * или оставить. Стадия 1 снимает исходную паузу («очередь не запускали»),
 * паузу штатной остановки и паузу человека, поставленную до старта задания;
 * паузу отказа runtime, остановку «база прогонов отстала» (`staleBaseStop`)
 * и ожидание проверки базы не снимает. Стадия 2 снимает
 * только паузу остановки. С выполненными задачами пауза не трогается. При
 * удержанном переносе базы (`heldBaseOf`) пауза не снимается ни на одной
 * стадии: её снимает подтверждение человека.
 */
export function pauseStep(
  s: DevContourState,
  job: WorkflowJob,
  tasks: readonly Task[],
  /** Сбои такта (`scheduler.error`): по ним узнаётся остановка «база отстала». */
  errors: Pick<AuditEvent, 'id' | 'at' | 'type' | 'data'>[] = [],
): { checkBase: boolean; lift: boolean } {
  if (tasks.every((t) => t.status === 'done')) return { checkBase: false, lift: false };
  const checkBase = s.paused && s.pauseReason === 'base-check';
  // Удержанный перенос базы (D42) подтверждает только человек. Снятие любой
  // паузы снимает и ожидание проверки базы (`resume`), поэтому при удержании
  // цикл не снимает ни паузу человека до старта задания, ни паузу остановки:
  // иначе очередь пошла бы на неподтверждённой базе.
  const held = !!heldBaseOf(s);
  if (job.stage === 1) {
    const decided =
      s.paused &&
      (s.pauseReason === 'runtime' ||
        // Перенесённую базу проверяет цикл (или человек): само ожидание цикл не снимает.
        s.pauseReason === 'base-check' ||
        // Остановку «база прогонов отстала» снятие не исправит: следующий
        // такт поставит её снова. Её снимает сам такт, когда причина ушла.
        !!staleBaseStop(s, errors) ||
        operatorDecided(s, job));
    return { checkBase, lift: !decided && !held };
  }
  return { checkBase, lift: s.paused && s.pauseReason === 'shutdown' && !held };
}

/** Последние сбои такта очереди: вход правила `pauseStep`. */
export const tickErrors = (h: Pick<DevContour, 'store'>) =>
  h.store.latestEvents(['scheduler.error'], 50);

/** Задачи текущей ревизии доски без перенесённых из принятой. */
export function boardTasks(s: DevContourState, boardId: string) {
  const b = s.boards.find((b) => b.id === boardId);
  if (!b) return undefined;
  const revision = b.revisions.at(-1)!;
  const carried = carriedTaskIds(b, s.tasks);
  return {
    board: b,
    revision,
    tasks: s.tasks.filter((t) => revision.taskIds.includes(t.id) && !carried.has(t.id)),
  };
}

/**
 * Задачи, которые ведёт задание доски. Отмена ведущим (`cancel --by host`)
 * задачи, которая ни разу не выдавалась (нет попыток и отказов), — его решение
 * об объёме ревизии, а не остановка человеком: такая задача, как и в приёмке
 * доски, в работу не входит, и задание идёт к приёмке без неё. Задача, которую
 * уже выдавали (попытка, отказ, исчерпанный бюджет), отменой ведущего из
 * работы не выпадает: иначе отмена упавшей задачи обходила бы остановку
 * задания и принимала доску без её требования, мимо ревью плана. Такая
 * отмена, как и отмена человеком или с неизвестным актёром, остаётся в работе:
 * восстановление её не повторяет и останавливает задание (`repairStep`).
 *
 * Живая задача ревизии, которая зависит от выпавшей, не будет выдана
 * никогда: задание не ждёт её молча, а останавливается с этой причиной.
 */
export function leadScope(
  tasks: readonly Task[],
  runs: DevContourState['runs'],
): {
  tasks: Task[];
  stop?: { taskId: string; reason: string };
} {
  const dropped = new Set(
    tasks
      .filter(
        (t) =>
          t.status === 'cancelled' &&
          t.cancelledBy === 'host' &&
          t.attempt === 0 &&
          !t.failure &&
          !t.neutralFailures &&
          !runs.some((r) => r.taskId === t.id),
      )
      .map((t) => t.id),
  );
  const kept = tasks.filter((t) => !dropped.has(t.id));
  const orphan = kept.find(
    (t) =>
      t.status !== 'cancelled' && t.status !== 'done' && t.dependsOn.some((d) => dropped.has(d)),
  );
  if (!orphan) return { tasks: kept };
  const dependency = orphan.dependsOn.find((d) => dropped.has(d))!;
  return {
    tasks: kept,
    stop: {
      taskId: orphan.id,
      reason: `${orphan.id}: зависит от задачи ${dependency}, отменённой ведущим, и не будет выдана. Отмените ${orphan.id} или исправьте её зависимости в новой ревизии доски.`,
    },
  };
}

/**
 * План доски согласован: ревизия принята или ни одна её задача не черновик
 * и не утверждена при другой политике исполнения. Иначе стадия 0 задания
 * отправит план на ревью и, одобренный, выпустит все его задачи.
 */
export function planApproved(
  h: DevContour,
  revision: { status: string },
  tasks: readonly Task[],
): boolean {
  return (
    revision.status === 'accepted' ||
    tasks.every((t) => t.status !== 'draft' && !h.approvalStale(t))
  );
}

/**
 * Почему план не согласован: черновые задачи, утверждённые при другой
 * политике, не разобранные ведущим находки агентов — ревью отвергло бы их как
 * непроверенные — и черновики, которые утверждение отвергнет (`approvable`).
 * Неразобранная находка считается один раз, среди `unverified`: её разбор —
 * правка черновика, которая исправляет и предусловия утверждения.
 */
export function unapprovedTasks(h: DevContour, s: DevContourState, tasks: readonly Task[]) {
  const drafts = tasks.filter((t) => t.status === 'draft');
  return {
    drafts: drafts.map((t) => t.id),
    stale: tasks.filter((t) => t.status !== 'draft' && h.approvalStale(t)).map((t) => t.id),
    unverified: drafts.filter(unverifiedFinding).map((t) => t.id),
    // Черновики находок, чья роль не может изменить файл находки (F73):
    // разобранные и нет — роль выбирают при разборе.
    misrouted: drafts.flatMap((t) => {
      const out = findingOutsideScope(h.config, t);
      return out ? [{ id: t.id, role: t.role, ...out }] : [];
    }),
    blocked: drafts
      .filter((t) => !unverifiedFinding(t))
      .flatMap((t) => {
        try {
          h.approvable(s, t);
          return [];
        } catch (e) {
          if (!(e instanceof DomainError)) throw e;
          // Причина обычно уже начинается с id задачи: не повторять его.
          const reason = e.message.startsWith(`${t.id}: `)
            ? e.message.slice(t.id.length + 2)
            : e.message;
          return [{ id: t.id, reason }];
        }
      }),
  };
}

/** Следующий такт цикла ведущего по заданию доски. */
export type LoopOutlook =
  | { step: 'review-plan' }
  /** Стадия завершится, задание перейдёт к следующей. */
  | { step: 'advance' }
  | { step: 'recovery'; taskId: string; action: 'analyze' | 'apply' | 'retry-task' | 'wait' }
  | { step: 'repair'; taskId: string; reason: string }
  /** Задание упадёт с этой причиной. */
  | { step: 'stop'; taskId?: string; reason: string }
  | { step: 'check-base' }
  | { step: 'lift-pause'; pause: 'initial' | 'shutdown' | 'operator' | 'reconfigure' }
  /** Задачи идут: цикл ждёт их результата. */
  | { step: 'wait' }
  | { step: 'accept' }
  /** Не задание доски или доски нет. */
  | { step: 'none' };

/**
 * Что сделает цикл ведущего на следующем такте задания `job` (как будто оно
 * взято сейчас) по состоянию `s`: те же решения, что `LeadRunner.execute`,
 * в том же порядке — эпизоды свойств, восстановление упавших задач, пауза
 * выдачи, приёмка. Только чтение.
 */
export function loopOutlook(h: DevContour, s: DevContourState, job: WorkflowJob): LoopOutlook {
  if (job.kind !== 'board') return { step: 'none' };
  const found = boardTasks(s, job.id);
  if (!found) return { step: 'none' };
  const { revision, tasks } = found;
  if (job.stage === 0) {
    // Отменённая выданная задача остановит любую стадию задач (D46): ревью
    // плана до неё выпустило бы задачи, которые задание не доведёт (F75).
    const stop = stageZeroStop(h, s, job, tasks);
    if (stop) return { step: 'stop', ...stop };
    return planApproved(h, revision, tasks) ? { step: 'advance' } : { step: 'review-plan' };
  }
  // Стадии исполнения и приёмки ведут задачи без отменённых ведущим (`leadScope`).
  const scope = leadScope(tasks, s.runs);
  if (scope.stop) return { step: 'stop', ...scope.stop };
  const ids = scope.tasks.map((t) => t.id);
  const recovery = recoveryStep(h, s, job, ids);
  if (recovery) {
    const taskId = recovery.task.id;
    if (recovery.kind === 'stop' || recovery.kind === 'interrupted')
      return { step: 'stop', taskId, reason: recovery.reason };
    if (recovery.kind !== 'after') return { step: 'recovery', taskId, action: recovery.kind };
    const after = afterStep(recovery.task);
    if (after.kind === 'stop') return { step: 'stop', taskId, reason: after.reason };
    if (after.kind !== 'none') return { step: 'recovery', taskId, action: after.kind };
  }
  const repair: RepairDecision | undefined = repairStep(h, job, ids);
  if (repair?.action === 'stop')
    return {
      step: 'stop',
      ...(repair.taskId ? { taskId: repair.taskId } : {}),
      reason: repair.reason,
    };
  if (repair) return { step: 'repair', taskId: repair.taskId, reason: repair.reason };
  const pause = pauseStep(s, job, scope.tasks, tickErrors(h));
  if (pause.checkBase) return { step: 'check-base' };
  if (pause.lift && s.paused)
    return {
      step: 'lift-pause',
      pause: (s.pauseReason ?? 'initial') as 'initial' | 'shutdown' | 'operator' | 'reconfigure',
    };
  if (job.stage === 1) return { step: 'advance' };
  return scope.tasks.every((t) => t.status === 'done') ? { step: 'accept' } : { step: 'wait' };
}

/**
 * Снимет ли цикл задания текущую паузу выдачи без решения человека: на
 * ближайшем такте (`lift-pause`, проверка перенесённой базы) или после
 * такта, который сначала чинит задачу или ведёт эпизод (`repair`,
 * `recovery` с повтором или ожиданием), — тогда паузу снимает следующий такт
 * той же стадии по `pauseStep`. Остановка задания паузу не снимает.
 */
export function liftsPause(h: DevContour, s: DevContourState, job: WorkflowJob): boolean {
  if (!s.paused) return false;
  const { stage, outlook } = loopAhead(h, s, job);
  if (outlook.step === 'lift-pause') return true;
  // Удержанное ожидание проверка базы не снимет, пока перенос не подтвердит
  // человек (или ревью не одобрит документ контракта).
  if (outlook.step === 'check-base') return !heldBaseOf(s);
  const first =
    outlook.step === 'repair' ||
    (outlook.step === 'recovery' && (outlook.action === 'retry-task' || outlook.action === 'wait'));
  if (!first) return false;
  const found = boardTasks(s, job.id);
  return (
    !!found &&
    pauseStep(s, { ...job, stage }, leadScope(found.tasks, s.runs).tasks, tickErrors(h)).lift
  );
}

/**
 * Ближайший такт цикла, который что-то делает: стадия, завершающаяся без
 * действий (`advance`), пропускается — следующий такт идёт уже со следующей
 * стадии. Возвращает стадию этого такта и его решение.
 */
export function loopAhead(
  h: DevContour,
  s: DevContourState,
  job: WorkflowJob,
): { stage: number; outlook: LoopOutlook } {
  let stage = job.stage;
  let outlook = loopOutlook(h, s, job);
  while (outlook.step === 'advance' && stage < 2) {
    stage++;
    outlook = loopOutlook(h, s, { ...job, stage });
  }
  return { stage, outlook };
}

/** Задачу уже выдавали: попытка, отказ, исчерпанный бюджет или прогон. */
export const issuedTask = (
  t: Pick<Task, 'id' | 'attempt' | 'failure' | 'neutralFailures'>,
  runs: DevContourState['runs'],
) => t.attempt > 0 || !!t.failure || !!t.neutralFailures || runs.some((r) => r.taskId === t.id);

/**
 * Отменённая задача текущей ревизии доски, на которой остановится любое
 * задание этой ревизии (D46, F75): отменённая человеком, без актёра или
 * ведущим после выдачи — то, что `leadScope` оставляет в работе. Пока она
 * в ревизии, ни одно задание доски её не примет: задачи, добавленные и
 * утверждённые в эту ревизию, пойдут без задания, которое их чинит и
 * принимает.
 */
export function revisionStopper(s: DevContourState, boardId: string): Task | undefined {
  const found = boardTasks(s, boardId);
  if (!found || found.revision.status === 'accepted') return undefined;
  return leadScope(found.tasks, s.runs).tasks.find((t) => t.status === 'cancelled');
}

/** Пути после остановки задания отменой выданной задачи (D46): текст подсказок CLI. */
const stopRoutes = (taskId: string) =>
  `пути: повтор задачи, если она ещё нужна (task_retry или devcontour retry --task ${taskId} --by host; отмену человеком повторяет только пользователь), приёмка ревизии без неё оператором в панели, либо замена на новой доске (plan_import без boardId, затем workflow_start {"kind": "board"} для новой доски) — добавленная в эту ревизию задача пошла бы без задания`;

/**
 * Предупреждение о доске, задание которой остановлено отменённой задачей
 * (F75): для ответов `task_create` и ревью плана.
 */
export function stopperWarning(s: DevContourState, boardId: string) {
  const stopper = revisionStopper(s, boardId);
  if (!stopper) return {};
  return {
    jobStop: {
      taskId: stopper.id,
      warning: `Задача ${stopper.id} ревизии доски ${boardId} ${stopper.cancelledBy === 'host' ? 'отменена ведущим после выдачи' : 'отменена человеком'} (D46): любое задание ведущего этой ревизии остановится на ней, поэтому утверждённые здесь задачи никто не будет чинить и принимать; ${stopRoutes(stopper.id)}.`,
    },
  };
}

/**
 * Что отмена задачи `taskId` актёром `by` сделает с заданиями её доски
 * (F75): по D46 отмена человеком или отмена ведущим уже выданной задачи
 * останавливает задание доски навсегда — `workflow_retry` и `workflow_start`
 * его не продвинут, а ChangeSet с этой доской будет ждать её приёмки.
 * `undefined` — отмена задание не останавливает (невыданная задача ведущего,
 * задача вне текущей ревизии, уже отменённая или выполненная).
 */
export function cancelImpact(h: DevContour, taskId: string, by: 'host' | 'operator') {
  const s = h.store.read();
  const t = s.tasks.find((x) => x.id === taskId);
  if (!t || t.status === 'cancelled' || t.status === 'done') return undefined;
  const board = s.boards.find((b) => b.revisions.at(-1)!.taskIds.includes(taskId));
  if (!board || board.revisions.at(-1)!.status === 'accepted') return undefined;
  const issued = issuedTask(t, s.runs);
  if (by === 'host' && !issued) return undefined;
  const live = (j: WorkflowJob) => j.status === 'queued' || j.status === 'running';
  const workflow = new LeadWorkflow(h);
  const owner = boardOwner(board, s);
  const jobs = [
    ...workflow
      .list(owner)
      .filter((j) => j.kind === 'board' && j.id === board.id && live(j))
      .map((j) => ({ key: j.key, kind: j.kind, id: j.id, status: j.status, stage: j.stage })),
    ...workflow
      .list()
      .filter(
        (j) =>
          j.kind === 'changeset' &&
          live(j) &&
          s.changeSets.some((c) => c.id === j.id && c.boardIds.includes(board.id)),
      )
      .map((j) => ({ key: j.key, kind: j.kind, id: j.id, status: j.status, stage: j.stage })),
  ];
  return {
    boardId: board.id,
    taskId,
    issued,
    jobs,
    warning: `Отмена задачи ${taskId}${issued ? ' после выдачи' : ' человеком'} навсегда останавливает задание ведущего доски ${board.id} (D46)${jobs.length ? `: действующие задания ${jobs.map((j) => j.key.slice(0, 8)).join(', ')} остановятся на следующем такте` : ''}; workflow_retry и workflow_start его не продвинут, ChangeSet с этой доской будет ждать её приёмки; ${stopRoutes(taskId)}.`,
  };
}

/**
 * Остановка стадии 0 задания доски (F75): в ревизии есть отменённая задача,
 * на которой остановится стадия задач (D46). Причина — та же, что у
 * остановки на стадии задач (`repairStep`), чтобы шаг передачи узнал её
 * (`job-cancelled-task`).
 */
export function stageZeroStop(
  h: DevContour,
  s: DevContourState,
  job: WorkflowJob,
  tasks: readonly Task[],
): { taskId: string; reason: string } | undefined {
  const stopper = leadScope(tasks, s.runs).tasks.find((t) => t.status === 'cancelled');
  if (!stopper) return undefined;
  const decided = repairStep(h, job, [stopper.id]);
  return decided?.action === 'stop'
    ? { taskId: decided.taskId ?? stopper.id, reason: decided.reason }
    : undefined;
}
