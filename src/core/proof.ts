import { createHash } from 'node:crypto';
import type { DevContourState, Evidence, Task } from './model.ts';

/**
 * Доказательство названного сценария — правило harness: решающая test-запись
 * фазы интеграции на принятом SHA под версией проверок попытки. Здесь только
 * продуктовый выбор записей задачи (wrapper без правил).
 */
export { requirementProof, unprovenReason } from 'devcontour-harness';

/** То, по чему задача узнаёт действующий договор исполнения. */
export interface PolicyOf {
  taskPolicyDigest(t: Pick<Task, 'repositoryId' | 'consumers'>): string;
  policyDigest(repositoryId?: string, legacy?: boolean): string;
  /** Подтверждает ли receipt задачи её результат при текущей конфигурации. */
  receiptHolds(s: DevContourState, t: Task): boolean;
}

/**
 * Договоры, под которыми попытка этого clone доказывает задачу сейчас:
 * текущий и — для задачи без потребителей — тот же договор без изоляции в
 * форме прежней версии. Тот же ID gate с другой командой, группой или
 * окружением — другой договор: его записи задачу уже не подтверждают, как и в
 * `Engine.uncoveredGates` harness.
 */
function currentPolicies(h: PolicyOf, task: Task) {
  const own = h.taskPolicyDigest(task);
  return task.consumers?.length ? [own] : [own, h.policyDigest(task.repositoryId, true)];
}

/**
 * Решающая запись задачи. Без `current` — принятая история: последняя
 * успешная попытка этого clone, иначе receipt другого (отчёты, INTENT:
 * принятое не переписывается сменой конфигурации). С `current` — то, что
 * подтверждает задачу для нового решения о приёмке: попытка под действующим
 * договором, иначе receipt, который получатель harness принимает при текущей
 * конфигурации (digest в receipt — договор отправителя с его путями, с
 * локальным он не сравнивается).
 */
function decisive(s: DevContourState, task: Task, current?: PolicyOf) {
  const policies = current ? currentPolicies(current, task) : undefined;
  const run = s.runs.findLast(
    (r) =>
      r.taskId === task.id &&
      r.status === 'succeeded' &&
      (!policies || policies.includes(r.policyDigest)),
  );
  if (run) return { run };
  const receipt = task.sharedCompletion?.receipt;
  return receipt && (!current || current.receiptHolds(s, task)) ? { receipt } : {};
}

/**
 * Evidence, которым задача подтверждает результат (`decisive`). Одно
 * определение для всех потребителей: приёмки доски (с `current`), INTENT и
 * отчёта требований.
 */
export function taskEvidence(
  s: DevContourState,
  task: Task,
  current?: PolicyOf,
): readonly Evidence[] {
  const { run, receipt } = decisive(s, task, current);
  return (run?.evidence ?? receipt?.checks ?? []) as Evidence[];
}

/**
 * Версия проверок, под которой получены записи `taskEvidence`: решающая
 * запись доказательства — записанная под ней. Попытка прежней версии её не
 * закрепляла — тогда undefined, и запись выбирается без неё, как раньше.
 */
export function taskChecks(s: DevContourState, task: Task, current?: PolicyOf): string | undefined {
  const { run, receipt } = decisive(s, task, current);
  return run ? run.checks?.effective : receipt?.checkVersion?.effective;
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
