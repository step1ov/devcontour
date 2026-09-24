import type { DevContourState, Task } from './model.ts';
import { repairPolicy, type FailureKind } from './failure.ts';

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

/**
 * Что делать с упавшей задачей доски.
 *
 * Решение принимается доменом и только по записанному состоянию: класс отказа,
 * сохранённый в момент падения, число одинаковых отпечатков среди прошлых
 * попыток, бюджет попыток задачи и бюджет восстановлений доски. Ни одного
 * обращения к сети, git или рантайму — поэтому вся таблица решений проверяется
 * тестами, а перезапуск процесса ничего не меняет: те же данные дают тот же
 * ответ.
 *
 * Повтор здесь — обычный повтор в пределах бюджета попыток задачи. Сброс
 * бюджета остаётся действием человека: он означает «причина устранена
 * снаружи», и утверждать это за человека контур не вправе.
 */
export function repairDecision(
  s: DevContourState,
  tasks: Task[],
  options: { budgetLeft: number; maxAttempts: number },
): RepairDecision | undefined {
  const broken = tasks.filter((t) => ['failed', 'cancelled'].includes(t.status));
  if (!broken.length) return undefined;

  // Отмена человеком не восстанавливается — ни первой, ни после других.
  // Проверяется раньше выбора задачи: иначе отменённая задача ждала бы своей
  // очереди за чинимыми и цикл успел бы потратить на них бюджет.
  const cancelled = broken.find((t) => t.status === 'cancelled');
  if (cancelled)
    return {
      action: 'stop',
      taskId: cancelled.id,
      kind: 'cancelled',
      reason: `${cancelled.id}: ${repairPolicy.cancelled.explain}`,
    };

  const task = broken[0];
  const kind: FailureKind = task.failureKind ?? 'unknown';
  const rule = repairPolicy[kind];
  const detail = task.failure ? ` Отказ: ${task.failure.slice(0, 300)}` : '';

  if (rule.action === 'stop')
    return {
      action: 'stop',
      taskId: task.id,
      kind,
      reason: `${task.id}: ${rule.explain}${detail}`,
    };

  if (options.budgetLeft <= 0)
    return {
      action: 'stop',
      taskId: task.id,
      kind,
      reason: `${task.id}: исчерпан бюджет автоматических восстановлений доски. Продолжение требует решения человека.${detail}`,
    };

  // Сброс бюджета попыток означает «причина устранена снаружи». Цикл такого
  // знания не имеет, поэтому на потолке попыток он останавливается, а не
  // обнуляет счётчик за человека.
  if (task.attempt >= options.maxAttempts)
    return {
      action: 'stop',
      taskId: task.id,
      kind,
      reason: `${task.id}: исчерпан бюджет попыток задачи. Устраните причину и повторите со сбросом, указав его.${detail}`,
    };

  const fingerprint = task.failureFingerprint;
  const identical = fingerprint
    ? s.runs.filter((r) => r.taskId === task.id && r.failureFingerprint === fingerprint).length
    : 0;
  if (!fingerprint || identical > rule.repeats)
    return {
      action: 'stop',
      taskId: task.id,
      kind,
      reason: fingerprint
        ? `${task.id}: одна и та же причина ${identical} раз подряд, новой гипотезы нет. ${rule.explain}${detail}`
        : `${task.id}: отказ записан без отпечатка, повторы считать нечем.${detail}`,
    };

  return {
    action: 'retry',
    taskId: task.id,
    kind,
    fingerprint,
    blocksQueue: rule.blocksQueue ?? false,
    reason: `${task.id}: ${kind}, повтор ${identical} из ${rule.repeats}.${detail}`,
  };
}
