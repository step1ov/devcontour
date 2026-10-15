import type { DevContour } from './service.ts';
import type { DevContourState, Task } from './model.ts';
import { TaskFailure } from './failure.ts';
import { repositories } from './repositories.ts';
import { usageTotals, type UsageRecord } from './usage.ts';
import { liveCall } from './live-calls.ts';

/**
 * Бюджеты расходов и времени вызовов моделей.
 *
 * Расход считается по сохранённым записям вызовов, а не по счётчикам попыток:
 * `retry --reset`, возврат попытки после отказа окружения, переход этапа
 * ведущего и перезапуск процесса его не уменьшают. Ошибочные, идущие и
 * прерванные вызовы входят в расход. Неизвестная стоимость делает денежный
 * бюджет неопределённым; что тогда делать, задаёт `budgets.onUnknown`.
 *
 * Учёт локален: записи вызовов не переносятся между клонами, поэтому бюджет
 * считает вызовы этой установки.
 */
export type BudgetScope = { kind: 'task' | 'board' | 'workspace'; id?: string };

/** Все записи вызовов всех владельцев: workspace и каждого компонента. */
export function usageRecords(h: DevContour): UsageRecord[] {
  const owners = [undefined, ...repositories(h.config).map((r) => r.id)];
  const seen = new Map<string, UsageRecord>();
  for (const owner of owners)
    for (const record of Object.values(h.store.localRecords<UsageRecord>('usage', owner)))
      seen.set(record.id, record);
  return [...seen.values()];
}

/** Доска задачи в текущем графе. */
const boardOf = (s: DevContourState, taskId: string) =>
  s.boards.find((b) => b.revisions.some((r) => r.taskIds.includes(taskId)));

/** Задачи доски — всех её ревизий. */
function boardTasks(s: DevContourState, boardId: string) {
  const board = s.boards.find((b) => b.id === boardId);
  return new Set(board?.revisions.flatMap((r) => r.taskIds) ?? []);
}

/** Задача записи: закреплённая при вызове, у прежних записей — по попытке. */
const recordTask = (s: DevContourState, r: UsageRecord) =>
  r.taskId ??
  (r.runId ? s.runs.find((x) => x.id === r.runId)?.taskId : undefined) ??
  (r.subjectId && s.tasks.some((t) => t.id === r.subjectId) ? r.subjectId : undefined);

/** Доска записи: закреплённая при вызове, у прежних записей — по текущему графу. */
function recordBoard(s: DevContourState, r: UsageRecord) {
  if (r.boardId) return r.boardId;
  if (r.subjectId && s.boards.some((b) => b.id === r.subjectId)) return r.subjectId;
  const task = recordTask(s, r);
  return task ? boardOf(s, task)?.id : undefined;
}

/**
 * Записи вызовов области. Задаче принадлежат её попытки, вызовы о ней и
 * вызовы о её доске целиком (ревью плана, восстановление доски): правила
 * долевой атрибуции нет, и вызов о доске не должен считаться нулевым для
 * задачи. Доске — вызовы, закреплённые за ней при вызове: перенос задачи на
 * другую доску расход не переносит.
 */
export function scopeRecords(s: DevContourState, records: UsageRecord[], scope: BudgetScope) {
  if (scope.kind === 'workspace') return records;
  if (scope.kind === 'board') return records.filter((r) => recordBoard(s, r) === scope.id);
  const boards = taskBoards(s, records, scope.id!);
  return records.filter((r) => {
    if (r.taskIds) return r.taskIds.includes(scope.id!);
    const task = recordTask(s, r);
    return task === scope.id || (!task && boards.has(recordBoard(s, r) ?? ''));
  });
}

/**
 * Доски задачи: текущая и те, на которых она тратила. Задача, перенесённая с
 * исчерпанной доски, остаётся под её ограничением.
 */
function taskBoards(s: DevContourState, records: UsageRecord[], taskId: string) {
  const boards = new Set<string>();
  const current = boardOf(s, taskId);
  if (current) boards.add(current.id);
  for (const r of records)
    if ((r.taskId === taskId || r.taskIds?.includes(taskId)) && r.boardId) boards.add(r.boardId);
  return boards;
}

/**
 * Попытки области, вызовы которых не записаны: начаты до первой записи учёта
 * этой установки, модель вызывалась (есть кандидат или замер реализации), а
 * записи реализации этой попытки нет. Их стоимость и время неизвестны и не
 * выдумываются; более поздние вызовы той же попытки пробел не закрывают.
 */
function uncoveredRuns(s: DevContourState, records: UsageRecord[], scope: BudgetScope) {
  const epoch = Math.min(...records.map((r) => Date.parse(r.startedAt)));
  const implemented = new Set(
    records.filter((r) => r.stage === 'implementation' && r.runId).map((r) => r.runId),
  );
  const tasks =
    scope.kind === 'workspace'
      ? undefined
      : scope.kind === 'task'
        ? new Set([scope.id!])
        : boardTasks(s, scope.id!);
  return s.runs.filter(
    (r) =>
      (!tasks || tasks.has(r.taskId)) &&
      !implemented.has(r.id) &&
      Date.parse(r.startedAt) < epoch &&
      (r.candidateSha || r.timings?.some((x) => x.stage.startsWith('implementation'))),
  ).length;
}

export type BudgetStatus = {
  scope: BudgetScope;
  limit: { usd?: number; timeMs?: number };
  spent: ReturnType<typeof usageTotals> & { uncoveredRuns: number; liveCalls: number };
  state: 'within' | 'exceeded' | 'undetermined';
  reason?: string;
};

export function budgetStatus(
  h: DevContour,
  s: DevContourState,
  scope: BudgetScope,
  records?: UsageRecord[],
  at = Date.now(),
): BudgetStatus | undefined {
  const limit = h.config.budgets?.[scope.kind];
  if (!limit) return undefined;
  const all = records ?? usageRecords(h);
  const own = scopeRecords(s, all, scope);
  const spent = {
    ...usageTotals(own, false, at),
    uncoveredRuns: uncoveredRuns(s, all, scope),
    // Исключение из неизвестных — только для вызовов с подтверждённо живым
    // владельцем: вызов умершего процесса неизвестен сразу, не дожидаясь
    // восстановления.
    liveCalls: own.filter((r) => liveCall(r, at, 2 * h.config.runTimeoutMs)).length,
  };
  const name = scope.kind === 'workspace' ? 'workspace' : `${scope.kind} ${scope.id}`;
  const usd = spent.reportedUsd + spent.estimatedUsd;
  const detail =
    `израсходовано: сообщено $${spent.reportedUsd.toFixed(4)}, оценено $${spent.estimatedUsd.toFixed(4)}, ` +
    `неизвестных вызовов ${spent.unknownCalls}, время ${Math.round(spent.durationMs / 1000)} с` +
    (spent.uncoveredRuns ? `, попыток без учёта вызовов ${spent.uncoveredRuns}` : '');
  if (limit.usd !== undefined && usd >= limit.usd)
    return {
      scope,
      limit,
      spent,
      state: 'exceeded',
      reason: `Бюджет ${name} исчерпан: предел $${limit.usd}; ${detail}`,
    };
  if (limit.timeMs !== undefined && spent.durationMs >= limit.timeMs)
    return {
      scope,
      limit,
      spent,
      state: 'exceeded',
      reason: `Бюджет времени ${name} исчерпан: предел ${Math.round(limit.timeMs / 1000)} с; ${detail}`,
    };
  // Идущий вызов живого процесса начат в пределах бюджета и не прерывается:
  // его стоимость станет известна по окончании, а неопределённым бюджет
  // делают остальные вызовы без стоимости. Иначе любой идущий вызов останавливал бы
  // параллельную работу той же области. Перерасход поэтому ограничен
  // вызовами, идущими одновременно.
  const settledUnknown = spent.unknownCalls - spent.liveCalls;
  const unknown = [
    ...(limit.usd !== undefined && settledUnknown
      ? [`у ${settledUnknown} вызовов неизвестна стоимость`]
      : []),
    ...(limit.timeMs !== undefined && spent.unknownDurationCalls
      ? [`у ${spent.unknownDurationCalls} вызовов неизвестно время`]
      : []),
    ...(spent.uncoveredRuns ? [`у ${spent.uncoveredRuns} попыток вызовы не записаны`] : []),
  ];
  if (unknown.length)
    return {
      scope,
      limit,
      spent,
      state: 'undetermined',
      reason: `Бюджет ${name} не определён: ${unknown.join(', ')}; ${detail}`,
    };
  return { scope, limit, spent, state: 'within' };
}

/** Бюджеты, относящиеся к задаче: её собственный, её досок и workspace. */
export function taskBudgets(
  h: DevContour,
  s: DevContourState,
  task: Task,
  records = usageRecords(h),
) {
  return [
    budgetStatus(h, s, { kind: 'task', id: task.id }, records),
    ...[...taskBoards(s, records, task.id)].map((id) =>
      budgetStatus(h, s, { kind: 'board', id }, records),
    ),
    budgetStatus(h, s, { kind: 'workspace' }, records),
  ].filter((b): b is BudgetStatus => !!b);
}

/**
 * Бюджеты вызова модели: по его попытке или задаче — бюджеты задачи; о доске —
 * бюджеты доски и каждой её открытой задачи, за которыми вызов будет учтён.
 */
export function callBudgets(
  h: DevContour,
  s: DevContourState,
  meta: { runId?: string; subjectId?: string },
  records = usageRecords(h),
) {
  const taskId =
    s.runs.find((r) => r.id === meta.runId)?.taskId ??
    s.tasks.find((t) => t.id === meta.subjectId)?.id;
  const task = taskId ? s.tasks.find((t) => t.id === taskId) : undefined;
  if (task) return taskBudgets(h, s, task, records);
  const board = s.boards.find((b) => b.id === meta.subjectId);
  const open = board
    ? s.tasks.filter(
        (t) => boardTasks(s, board.id).has(t.id) && !['done', 'cancelled'].includes(t.status),
      )
    : [];
  const seen = new Set<string>();
  return [
    board ? budgetStatus(h, s, { kind: 'board', id: board.id }, records) : undefined,
    ...open.flatMap((t) => taskBudgets(h, s, t, records)),
    budgetStatus(h, s, { kind: 'workspace' }, records),
  ].filter((b): b is BudgetStatus => {
    if (!b) return false;
    const key = `${b.scope.kind}:${b.scope.id ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Бюджет, который запрещает тратить: превышен или не определён при `onUnknown: stop`. */
export function blockingBudget(h: DevContour, statuses: BudgetStatus[]) {
  const stopOnUnknown = (h.config.budgets?.onUnknown ?? 'stop') === 'stop';
  return statuses.find(
    (b) => b.state === 'exceeded' || (b.state === 'undetermined' && stopOnUnknown),
  );
}

/** Отказ до траты: превышенный или неопределённый бюджет не даёт начать вызов. */
export function assertBudget(h: DevContour, statuses: BudgetStatus[]) {
  const blocking = blockingBudget(h, statuses);
  if (blocking) throw new TaskFailure('budget', blocking.reason!);
}

/** Компактный вид бюджета для метрик, обзора и MCP. */
export function budgetView(b: BudgetStatus) {
  const usd = b.spent.reportedUsd + b.spent.estimatedUsd;
  return {
    scope: b.scope,
    state: b.state,
    limit: b.limit,
    reportedUsd: b.spent.reportedUsd,
    estimatedUsd: b.spent.estimatedUsd,
    unknownCalls: b.spent.unknownCalls,
    unfinishedCalls: b.spent.unfinishedCalls,
    abandonedCalls: b.spent.abandonedCalls,
    errorCalls: b.spent.errorCalls,
    uncoveredRuns: b.spent.uncoveredRuns,
    durationMs: b.spent.durationMs,
    // Остаток денег известен, только когда неизвестных вызовов и попыток нет.
    remainingUsd:
      b.limit.usd === undefined ||
      b.spent.unknownCalls > b.spent.liveCalls ||
      b.spent.uncoveredRuns > 0
        ? null
        : Math.max(0, b.limit.usd - usd),
    remainingMs:
      b.limit.timeMs === undefined ||
      b.spent.unknownDurationCalls > 0 ||
      b.spent.uncoveredRuns > 0
        ? null
        : Math.max(0, b.limit.timeMs - b.spent.durationMs),
    ...(b.reason ? { reason: b.reason } : {}),
  };
}

/** Бюджеты контура: workspace, доски с незавершённой работой, задачи. */
export function budgetOverview(h: DevContour, s: DevContourState, records?: UsageRecord[]) {
  if (!h.config.budgets) return undefined;
  const all = records ?? usageRecords(h);
  const open = new Set(
    s.tasks.filter((t) => !['done', 'cancelled'].includes(t.status)).map((t) => t.id),
  );
  const scopes: BudgetScope[] = [
    { kind: 'workspace' },
    ...s.boards
      .filter((b) => b.revisions.some((r) => r.taskIds.some((id) => open.has(id))))
      .map((b) => ({ kind: 'board' as const, id: b.id })),
    ...s.tasks.filter((t) => open.has(t.id)).map((t) => ({ kind: 'task' as const, id: t.id })),
  ];
  return {
    onUnknown: h.config.budgets.onUnknown,
    budgets: scopes
      .map((scope) => budgetStatus(h, s, scope, all))
      .filter((b): b is BudgetStatus => !!b)
      .map(budgetView),
  };
}
