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

/**
 * Проверка, оборванная до первого gate (остановка, потеря срока владения,
 * отказ окружения до установки): записей gates у неё нет. Результата о
 * коде она не дала. Движок, который сам отмечает такие проверки
 * (`interrupted`), их в предел не засчитывает; прежний движок засчитывает.
 */
export const interruptedJoint = (v: Pick<Verification, 'status' | 'evidence' | 'interrupted'>) =>
  v.status === 'failed' && (v.interrupted === true || !v.evidence.length);

/**
 * Проверки набора, которые движок засчитывает в предел сейчас: после
 * последнего сброса (принятого ChangeSet этого набора — его checkpoint) и
 * без отмеченных движком как прерванные.
 */
export function jointBudgetRuns(state: DevContourState, workIds: readonly string[]) {
  let settled = new Set<string>();
  try {
    settled = new Set(
      acceptedJointBudgetCheckpoints(state, workIds).flatMap((c) => c.settledVerificationIds),
    );
  } catch {
    /* Повреждённый checkpoint отклонит сам движок; текст считает без него. */
  }
  return state.changeSets
    .flatMap((c) => c.verifications)
    .filter((v) => sameWorks(v, workIds) && !settled.has(v.id) && v.interrupted !== true);
}

/**
 * Отказ начала проверки по пределу: что исчерпано, сколько из засчитанного
 * — проверки без результата gate и какой путь остаётся. Предел движка — по
 * набору задач (а не по ChangeSet) до принятия ChangeSet этого набора, и
 * сбросить его нельзя: при исчерпанном пределе набора новый ChangeSet над
 * теми же задачами получает тот же отказ. Предел самого ChangeSet (`scope`
 * changeset) — другой: при запасе у набора новый ChangeSet проверку начнёт.
 */
export function jointBudgetRefusal(
  state: DevContourState,
  workIds: readonly string[],
  limit: number,
  scope: 'changeset' | 'set',
) {
  const runs = jointBudgetRuns(state, workIds);
  const interrupted = runs.filter(interruptedJoint).length;
  const setSpent = scope === 'set' || runs.length >= limit;
  const head =
    scope === 'changeset'
      ? `Исчерпан лимит попыток ChangeSet (${limit})`
      : `Исчерпан предел совместных проверок этого набора задач (${limit})`;
  const route =
    'Путь: измените набор задач (новая ревизия доски: добавьте задачу, например исправление по провалу gate, или отмените ненужную), примите доску и создайте ChangeSet по ней; либо спросите пользователя.';
  return (
    head +
    (interrupted
      ? `; из засчитанных проверок этого набора ${interrupted} прерваны до первого gate и результата о коде не дали, но предел расходуют`
      : '') +
    (setSpent
      ? '. Предел набора считается по задачам до принятия ChangeSet этого набора, поэтому новый ChangeSet над теми же задачами получит тот же отказ. ' +
        route
      : `. У набора задач осталось проверок: ${limit - runs.length} — создайте новый ChangeSet по тем же доскам и проверьте его (workspace-verify).`)
  );
}
