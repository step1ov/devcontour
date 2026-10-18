// Решение о восстановлении упавшей задачи доски — правило harness
// (`repairDecision`): класс отказа, одинаковые отпечатки среди прошлых
// попыток, бюджет попыток задачи и общий бюджет восстановлений. Здесь только
// перевод поручения harness в задачу DevContour.
import { repairDecision as decide } from 'devcontour-harness';
import type { Task } from './model.ts';
import type { FailureKind } from './failure.ts';
import type { DevContour } from './service.ts';
import { executionOf } from '../harness/execution.ts';

export type RepairDecision =
  | {
      action: 'retry';
      taskId: string;
      kind: FailureKind;
      fingerprint: string;
      /** Класс держит выдачу: починив его, нужно снять его блокировку. */
      blocksQueue: boolean;
      reason: string;
    }
  | { action: 'stop'; taskId?: string; kind?: FailureKind; reason: string };

/** Что делать с упавшими задачами доски; нечего чинить — `undefined`. */
export function repairDecision(
  h: DevContour,
  tasks: Pick<Task, 'id'>[],
  options: { budgetLeft: number; maxAttempts: number },
): RepairDecision | undefined {
  return executionOf(h).engine.read((view) => {
    const works = tasks.flatMap((t) => {
      const work = view.work(t.id);
      return work ? [work] : [];
    });
    const decided = decide(view, works, options);
    if (!decided) return undefined;
    const { workId, ...rest } = decided;
    return { ...rest, ...(workId ? { taskId: workId } : {}) } as RepairDecision;
  });
}
