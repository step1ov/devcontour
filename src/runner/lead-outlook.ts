// Что сделает цикл ведущего (`LeadRunner`) со своим заданием доски на
// следующем такте — чистые правила без записи. Цикл исполняет ровно эти
// решения, пакет передачи контекста (`session_handoff`) объясняет по ним
// следующий шаг: правила одни, разойтись им негде.
import type { WorkflowJob } from '../core/lead-workflow.ts';
import { DomainError, unverifiedFinding, type DevContourState, type Task } from '../core/model.ts';
import type { DevContour } from '../core/service.ts';
import { carriedTaskIds } from '../core/work-status.ts';
import { repairDecision, type RepairDecision } from '../core/repair.ts';

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
 * паузу отказа runtime и ожидание проверки базы не снимает. Стадия 2 снимает
 * только паузу остановки. С выполненными задачами пауза не трогается.
 */
export function pauseStep(
  s: DevContourState,
  job: WorkflowJob,
  tasks: readonly Task[],
): { checkBase: boolean; lift: boolean } {
  if (tasks.every((t) => t.status === 'done')) return { checkBase: false, lift: false };
  const checkBase = s.paused && s.pauseReason === 'base-check';
  if (job.stage === 1) {
    const decided =
      s.paused &&
      (s.pauseReason === 'runtime' ||
        // Перенесённую базу проверяет цикл (или человек): само ожидание цикл не снимает.
        s.pauseReason === 'base-check' ||
        operatorDecided(s, job));
    return { checkBase, lift: !decided };
  }
  return { checkBase, lift: s.paused && s.pauseReason === 'shutdown' };
}

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
 * политике, черновики, которые утверждение отвергнет (`approvable`), — ревью
 * плана откажет на них до модели, — и не разобранные ведущим находки агентов:
 * ревью отвергло бы их как непроверенные, их сначала разбирают.
 */
export function unapprovedTasks(h: DevContour, s: DevContourState, tasks: readonly Task[]) {
  const drafts = tasks.filter((t) => t.status === 'draft');
  return {
    drafts: drafts.map((t) => t.id),
    stale: tasks.filter((t) => t.status !== 'draft' && h.approvalStale(t)).map((t) => t.id),
    unverified: drafts.filter(unverifiedFinding).map((t) => t.id),
    blocked: drafts.flatMap((t) => {
      try {
        h.approvable(s, t);
        return [];
      } catch (e) {
        if (!(e instanceof DomainError)) throw e;
        return [{ id: t.id, reason: e.message }];
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
  if (job.stage === 0)
    return planApproved(h, revision, tasks) ? { step: 'advance' } : { step: 'review-plan' };
  const ids = tasks.map((t) => t.id);
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
  const pause = pauseStep(s, job, tasks);
  if (pause.checkBase) return { step: 'check-base' };
  if (pause.lift && s.paused)
    return {
      step: 'lift-pause',
      pause: (s.pauseReason ?? 'initial') as 'initial' | 'shutdown' | 'operator' | 'reconfigure',
    };
  if (job.stage === 1) return { step: 'advance' };
  return tasks.every((t) => t.status === 'done') ? { step: 'accept' } : { step: 'wait' };
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
  if (outlook.step === 'lift-pause' || outlook.step === 'check-base') return true;
  const first =
    outlook.step === 'repair' ||
    (outlook.step === 'recovery' && (outlook.action === 'retry-task' || outlook.action === 'wait'));
  if (!first) return false;
  const found = boardTasks(s, job.id);
  return !!found && pauseStep(s, { ...job, stage }, found.tasks).lift;
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
