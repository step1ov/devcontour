// Бюджеты в отображении DevContour: тот же расчёт harness, области под
// прежними именами (`task`, `board`, `workspace`) для панели, метрик и обзора.
import type { DevContour } from '../core/service.ts';
import { executionOf } from './execution.ts';

const scopeOf = (scope: { kind: 'work' | 'group' | 'total'; id?: string }) =>
  scope.kind === 'total'
    ? { kind: 'workspace' as const }
    : { kind: scope.kind === 'work' ? ('task' as const) : ('board' as const), id: scope.id! };

/** Обзор бюджетов контура; нет бюджетов в конфигурации — `undefined`. */
export function budgetOverview(h: DevContour) {
  const overview = executionOf(h).engine.budgets();
  if (!overview) return undefined;
  return {
    onUnknown: overview.onUnknown,
    budgets: overview.budgets.map((b) => ({ ...b, scope: scopeOf(b.scope) })),
  };
}
