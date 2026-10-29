import type { JointBudgetCheckpoint } from 'devcontour-harness/contracts';
import { DomainError, type DevContourState, type Verification } from './model.ts';

/** Область бюджета не зависит от порядка задач, ChangeSet, модели или digest. */
function sameWorks(verification: Verification, workIds: readonly string[]) {
  const ids = new Set(workIds);
  const actual = new Set(verification.tasks.map((t) => t.id));
  return (
    actual.size === verification.tasks.length &&
    actual.size === ids.size &&
    [...actual].every((id) => ids.has(id))
  );
}

/** Только завершённые проверки, уже существующие в транзакции приёмки. */
export function settledJointVerifications(state: DevContourState, workIds: readonly string[]) {
  return state.changeSets
    .flatMap((c) => c.verifications)
    .filter((v) => (v.status === 'passed' || v.status === 'failed') && sameWorks(v, workIds))
    .map((v) => v.id)
    .sort();
}

/**
 * Принятая локальная история той же транзакции. Legacy не переписываем:
 * известен лишь собственный префикс принятого ChangeSet, sibling debt остаётся.
 * Сохранённый checkpoint проверяет движок; повреждённый не заменяем legacy.
 */
export function acceptedJointBudgetCheckpoints(
  state: DevContourState,
  workIds: readonly string[],
): JointBudgetCheckpoint[] {
  return state.changeSets.flatMap((c) => {
    if (!c.acceptance) return [];
    const index = c.verifications.findIndex((v) => v.id === c.acceptance!.verificationId);
    const anchor = c.verifications[index];
    if (!anchor) throw new DomainError('Принятая проверка бюджетного checkpoint не найдена');
    if (!sameWorks(anchor, workIds)) return [];
    if (c.acceptance.jointBudgetCheckpoint !== undefined) {
      const checkpoint = c.acceptance.jointBudgetCheckpoint;
      if (
        !checkpoint ||
        typeof checkpoint !== 'object' ||
        checkpoint.verificationId !== c.acceptance.verificationId
      )
        throw new DomainError('Бюджетный checkpoint не соответствует принятой проверке');
      return [checkpoint];
    }
    return [
      {
        verificationId: anchor.id,
        settledVerificationIds: c.verifications
          .slice(0, index + 1)
          .filter((v) => (v.status === 'passed' || v.status === 'failed') && sameWorks(v, workIds))
          .map((v) => v.id),
      },
    ];
  });
}
