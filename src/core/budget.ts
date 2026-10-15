import type { DevContour } from './service.ts';
import type { DevContourState, Task } from './model.ts';
import { TaskFailure } from './failure.ts';
import { repositories } from './repositories.ts';
import { usageTotals, type UsageRecord } from './usage.ts';

/**
 * Бюджеты расходов и времени вызовов моделей.
 *
 * Расход считается по сохранённым записям вызовов, а не по счётчикам попыток:
 * `retry --reset`, возврат попытки после отказа окружения, переход этапа
 * ведущего и перезапуск процесса его не уменьшают. Ошибочные, идущие и
 * прерванные вызовы входят в расход. Неизвестная стоимость делает денежный
 * бюджет неопределённым; что тогда делать, задаёт `budgets.onUnknown`.
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

/** Задачи доски — всех её ревизий. */
function boardTasks(s: DevContourState, boardId: string) {
  const board = s.boards.find((b) => b.id === boardId);
  return new Set(board?.revisions.flatMap((r) => r.taskIds) ?? []);
}

/** Записи вызовов области: попытки задачи и вызовы о ней (ревью плана, восстановление). */
export function scopeRecords(s: DevContourState, records: UsageRecord[], scope: BudgetScope) {
  if (scope.kind === 'workspace') return records;
  const taskIds = scope.kind === 'task' ? new Set([scope.id!]) : boardTasks(s, scope.id!);
  const runIds = new Set(s.runs.filter((r) => taskIds.has(r.taskId)).map((r) => r.id));
  return records.filter(
    (r) =>
      (r.runId && runIds.has(r.runId)) ||
      (r.subjectId && (taskIds.has(r.subjectId) || r.subjectId === scope.id)),
  );
}

export type BudgetStatus = {
  scope: BudgetScope;
  limit: { usd?: number; timeMs?: number };
  spent: ReturnType<typeof usageTotals>;
  state: 'within' | 'exceeded' | 'undetermined';
  reason?: string;
};

export function budgetStatus(
  h: DevContour,
  s: DevContourState,
  scope: BudgetScope,
  records = usageRecords(h),
  at = Date.now(),
): BudgetStatus | undefined {
  const limit = h.config.budgets?.[scope.kind];
  if (!limit) return undefined;
  const spent = usageTotals(scopeRecords(s, records, scope), false, at);
  const name = scope.kind === 'workspace' ? 'workspace' : `${scope.kind} ${scope.id}`;
  const usd = spent.reportedUsd + spent.estimatedUsd;
  const detail =
    `израсходовано: сообщено $${spent.reportedUsd.toFixed(4)}, оценено $${spent.estimatedUsd.toFixed(4)}, ` +
    `неизвестных вызовов ${spent.unknownCalls}, время ${Math.round(spent.durationMs / 1000)} с`;
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
  if (limit.usd !== undefined && spent.unknownCalls > 0)
    return {
      scope,
      limit,
      spent,
      state: 'undetermined',
      reason: `Бюджет ${name} не определён: у ${spent.unknownCalls} вызовов неизвестна стоимость; ${detail}`,
    };
  return { scope, limit, spent, state: 'within' };
}

/** Бюджеты, относящиеся к задаче: её собственный, её доски и workspace. */
export function taskBudgets(
  h: DevContour,
  s: DevContourState,
  task: Task,
  records = usageRecords(h),
) {
  const board = s.boards.find((b) => b.revisions.some((r) => r.taskIds.includes(task.id)));
  return [
    budgetStatus(h, s, { kind: 'task', id: task.id }, records),
    board ? budgetStatus(h, s, { kind: 'board', id: board.id }, records) : undefined,
    budgetStatus(h, s, { kind: 'workspace' }, records),
  ].filter((b): b is BudgetStatus => !!b);
}

/** Бюджеты вызова модели: по его попытке, задаче или доске, и workspace. */
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
  return [
    board ? budgetStatus(h, s, { kind: 'board', id: board.id }, records) : undefined,
    budgetStatus(h, s, { kind: 'workspace' }, records),
  ].filter((b): b is BudgetStatus => !!b);
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
    durationMs: b.spent.durationMs,
    // Остаток денег известен, только когда неизвестных вызовов нет.
    remainingUsd:
      b.limit.usd === undefined || b.spent.unknownCalls > 0 ? null : Math.max(0, b.limit.usd - usd),
    remainingMs:
      b.limit.timeMs === undefined ? null : Math.max(0, b.limit.timeMs - b.spent.durationMs),
    ...(b.reason ? { reason: b.reason } : {}),
  };
}

/** Бюджеты контура: workspace, доски с незавершённой работой, задачи. */
export function budgetOverview(h: DevContour, s: DevContourState, records = usageRecords(h)) {
  if (!h.config.budgets) return undefined;
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
      .map((scope) => budgetStatus(h, s, scope, records))
      .filter((b): b is BudgetStatus => !!b)
      .map(budgetView),
  };
}
