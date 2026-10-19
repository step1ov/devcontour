import { createHash } from 'node:crypto';
import type { DevContourState, Evidence, Task } from './model.ts';

/**
 * Доказательство названного сценария — правило harness: решающая test-запись
 * фазы интеграции на принятом SHA под версией проверок попытки. Здесь только
 * продуктовый выбор записей задачи (wrapper без правил).
 */
export { requirementProof, unprovenReason } from 'devcontour-harness';

/**
 * Evidence, которым задача подтверждает результат: последний успешный
 * прогон, а для задачи, завершённой в другом клоне, — её receipt. Одно
 * определение для всех потребителей: приёмки, INTENT и отчёта требований.
 */
export function taskEvidence(s: Pick<DevContourState, 'runs'>, task: Task): readonly Evidence[] {
  const run = s.runs.findLast((r) => r.taskId === task.id && r.status === 'succeeded');
  return (run?.evidence ?? task.sharedCompletion?.receipt.checks ?? []) as Evidence[];
}

/**
 * Версия проверок, под которой получены записи `taskEvidence`: решающая
 * запись доказательства — записанная под ней. Попытка прежней версии её не
 * закрепляла — тогда undefined, и запись выбирается без неё, как раньше.
 */
export function taskChecks(s: Pick<DevContourState, 'runs'>, task: Task): string | undefined {
  const run = s.runs.findLast((r) => r.taskId === task.id && r.status === 'succeeded');
  return run ? run.checks?.effective : task.sharedCompletion?.receipt.checkVersion?.effective;
}

/** Предел имени testcase: столько переносит receipt между клонами. */
export const TEST_ID_LIMIT = 1000;
/**
 * Имя testcase в receipt Git sync (формат receipt не меняется). Длинное
 * заменяется хешем, а не обрезается: обрезка дала бы коллизии и ложные
 * совпадения. Такое имя помечено opaque и ничего не подтверждает — то же
 * правило, что у переносимой формы результата harness.
 */
export function portableTest<T extends { id: string; opaque?: true }>(test: T): T {
  return test.id.length > TEST_ID_LIMIT
    ? { ...test, id: 'sha256:' + createHash('sha256').update(test.id).digest('hex'), opaque: true }
    : test;
}
