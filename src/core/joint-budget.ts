import type { JointBudgetCheckpoint } from 'devcontour-harness/contracts';
import { MAX_NEUTRAL_FAILURES, WORKSPACE_OWNER, type ExecutionView } from 'devcontour-harness';
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
 * Проверка, прерванная до результата gates (остановка хоста, потеря
 * владения), — определение движка (`jointInterrupted`): отметка движка и нет
 * evidence. Предел набора она не тратит; у таких проверок свой предел
 * (`MAX_NEUTRAL_FAILURES`).
 */
export const interruptedJoint = (v: Pick<Verification, 'status' | 'evidence' | 'interrupted'>) =>
  v.status === 'failed' && v.interrupted === true && !v.evidence.length;

/**
 * Завершённая проверка без результата gates: прерванная или отказ до gates,
 * в том числе записанная прежними версиями без отметки. Её снимает явный
 * сброс бюджета оператором; проверки с evidence сброс не снимает.
 */
export const gatelessJoint = (v: Pick<Verification, 'status' | 'evidence'>) =>
  v.status === 'failed' && !v.evidence.length;

/**
 * Окно бюджета набора, как его считает движок (`jointBudgetWindow`):
 * проверки набора после принятого ChangeSet этого набора (checkpoint) и не
 * снятые сбросом оператора (`resetIds` — снятые сбросами проверки).
 */
export function jointBudgetRuns(
  state: DevContourState,
  workIds: readonly string[],
  resetIds: ReadonlySet<string> = new Set(),
) {
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
    .filter((v) => sameWorks(v, workIds) && !settled.has(v.id) && !resetIds.has(v.id));
}

/** Проверки, снятые сбросами бюджета (`joint-budget-resets` движка). */
export function jointResetIds(view: Pick<ExecutionView, 'locals'>) {
  return new Set(
    view
      .locals('joint-budget-resets', WORKSPACE_OWNER)
      .flatMap((r) => r.value.settledVerificationIds),
  );
}

/** Команда сброса бюджета оператором — для отказов и карточки. */
export const budgetResetCommand = (changeSetId: string) =>
  `devcontour changeset-budget-reset --changeset ${changeSetId} --reason … --workspace …`;

/**
 * Отказ начала проверки по пределу: сколько засчитано, сколько прервано до
 * результата gates (не засчитываются, свой предел), что снимает сброс
 * оператора и какой путь остаётся. Предел движка — по набору задач (а не по
 * ChangeSet) до принятия ChangeSet этого набора. Предел самого ChangeSet
 * (`scope` changeset) — другой: при запасе у набора новый ChangeSet
 * проверку начнёт.
 */
export function jointBudgetRefusal(
  state: DevContourState,
  workIds: readonly string[],
  limit: number,
  scope: 'changeset' | 'set',
  options: { changeSetId: string; resetIds?: ReadonlySet<string> },
) {
  const window = jointBudgetRuns(state, workIds, options.resetIds);
  const interrupted = window.filter(interruptedJoint).length;
  const counted = window.length - interrupted;
  const resettable = window.filter(gatelessJoint).length;
  const setSpent = scope === 'set' || counted >= limit || interrupted >= MAX_NEUTRAL_FAILURES;
  const head =
    scope === 'changeset'
      ? `Исчерпан лимит попыток ChangeSet (${limit})`
      : `Исчерпан предел совместных проверок этого набора задач (${limit})`;
  const route =
    'Путь: измените набор задач (новая ревизия доски: добавьте задачу, например исправление по провалу gate, или отмените ненужную), примите доску и создайте ChangeSet по ней; либо спросите пользователя.';
  const reset = resettable
    ? ` Без результата gates — ${resettable}: их снимает сброс бюджета оператором с причиной (${budgetResetCommand(options.changeSetId)}; решение человека, ведущий агент его не выполняет). Проверки с результатом gates сброс не снимает.`
    : '';
  return (
    head +
    `: засчитано проверок набора ${counted} из ${limit}` +
    (interrupted
      ? `; прервано до результата gates ${interrupted} (в предел не засчитываются, их предел ${MAX_NEUTRAL_FAILURES})`
      : '') +
    '.' +
    (setSpent
      ? reset +
        ' Иначе предел набора снимает только принятие ChangeSet этого набора, поэтому новый ChangeSet над теми же задачами получит тот же отказ. ' +
        route
      : ` У набора задач осталось проверок: ${limit - counted} — создайте новый ChangeSet по тем же доскам и проверьте его (workspace-verify).`)
  );
}
