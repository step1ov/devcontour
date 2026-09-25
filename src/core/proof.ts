import { createHash } from 'node:crypto';
import type { DevContourState, Evidence, RequirementLink, Task } from './model.ts';

/**
 * Уровни доказательства критерия — от сильного к отсутствующему.
 *
 * `testcase` — назван конкретный тест, он выполнился на принятом SHA и прошёл.
 * `gate` — известно только, что проверка была зелёной. Это прежний уровень:
 *   зелёной проверка бывает и тогда, когда заявленное поведение не проверяет
 *   никто, поэтому он назван отдельно, а не выдаётся за подтверждение.
 * `none` — подтверждения нет, и причина названа.
 */
export type ProofLevel = 'testcase' | 'gate' | 'none';

export interface RequirementProof {
  id: string;
  level: ProofLevel;
  /** Почему уровень именно такой — человеку и ревью. */
  reason: string;
  testId?: string;
}

/**
 * Чем подтверждён критерий на принятом результате.
 *
 * Правило узкое намеренно: доказательством считается только evidence фазы
 * интеграции на том самом SHA, который принят. Зелёный кандидат до слияния
 * доказывает состояние, которого в ветке приёмки нет.
 *
 * Посторонний зелёный testcase не подходит: сверяется именно названный id.
 * Пропущенный, упавший и повторяющийся id подтверждения не дают — повтор
 * потому, что неизвестно, какой из одноимённых тестов имелся в виду. Обрезанный
 * манифест тоже не даёт: по нему нельзя отличить отсутствие теста от предела
 * размера.
 */
export function requirementProof(
  // Нужны только адресующие поля: функция не читает ни текст требования, ни
  // его digest, и не должна требовать их от вызывающего.
  link: Pick<RequirementLink, 'id' | 'gate' | 'testId'>,
  evidence: readonly Evidence[],
  resultSha: string | undefined,
): RequirementProof {
  const base = { id: link.id, testId: link.testId };
  if (!resultSha) return { ...base, level: 'none', reason: 'Результат ещё не принят' };
  const relevant = evidence.filter(
    (e) => e.gate === link.gate && e.phase === 'integration' && e.sha === resultSha,
  );
  if (!relevant.length)
    return {
      ...base,
      level: 'none',
      reason: `Проверка ${link.gate} на принятом SHA не выполнялась`,
    };
  if (!relevant.some((e) => e.passed))
    return { ...base, level: 'none', reason: `Проверка ${link.gate} не прошла` };

  if (!link.testId)
    return {
      ...base,
      level: 'gate',
      reason: `Проверка ${link.gate} зелёная, но сценарий не связан с конкретным тестом`,
    };

  const withManifest = relevant.filter((e) => e.passed && e.tests?.length);
  if (!withManifest.length)
    return {
      ...base,
      level: 'none',
      reason: `Проверка ${link.gate} не сообщила, какие тесты выполнились`,
    };
  if (withManifest.some((e) => e.testsTruncated))
    return {
      ...base,
      level: 'none',
      reason: 'Список выполненных тестов обрезан: отсутствие теста по нему не доказать',
    };
  // Имя, изменённое redaction или заменённое хешем, не сопоставляется: оно
  // могло совпасть с названным тестом случайно или по подстановке.
  const found = withManifest.flatMap((e) =>
    e.tests!.filter((t) => !t.opaque && t.id === link.testId),
  );
  if (!found.length) {
    const opaque = withManifest.some((e) => e.tests!.some((t) => t.opaque));
    return {
      ...base,
      level: 'none',
      reason:
        `Тест ${link.testId} не выполнялся` +
        (opaque ? ' (имена части тестов скрыты redaction или хешем и не сопоставляются)' : ''),
    };
  }
  if (found.length > 1)
    return {
      ...base,
      level: 'none',
      reason: `Тест ${link.testId} встречается ${found.length} раза: неясно, какой проверяет сценарий`,
    };
  if (found[0].status !== 'passed')
    return { ...base, level: 'none', reason: `Тест ${link.testId}: ${found[0].status}` };
  return { ...base, level: 'testcase', reason: `Тест ${link.testId} выполнился и прошёл` };
}

/**
 * Критерий, назвавший свой тест, обязан его предъявить.
 *
 * Задача без `testId` принимается на прежнем уровне: история не переписывается
 * и не выдаётся за более сильное доказательство. Но если тест назван, а
 * подтверждения нет — принимать нечего, и приёмка отказывает.
 */
export function unprovenRequirements(
  requirements: readonly RequirementLink[] | undefined,
  evidence: readonly Evidence[],
  resultSha: string | undefined,
) {
  return (requirements ?? [])
    .filter((link) => link.testId)
    .map((link) => requirementProof(link, evidence, resultSha))
    .filter((proof) => proof.level !== 'testcase');
}

/**
 * Evidence, которым задача подтверждает результат: последний успешный
 * прогон, а для задачи, завершённой в другом клоне, — её receipt. Одно
 * определение для всех потребителей: приёмки, INTENT и отчёта требований.
 */
export function taskEvidence(s: Pick<DevContourState, 'runs'>, task: Task): readonly Evidence[] {
  const run = s.runs.findLast((r) => r.taskId === task.id && r.status === 'succeeded');
  return (run?.evidence ?? task.sharedCompletion?.receipt.checks ?? []) as Evidence[];
}
/** Причина, по которой названные сценарии задачи не подтверждены, или undefined. */
export function unprovenReason(
  requirements: readonly RequirementLink[] | undefined,
  evidence: readonly Evidence[],
  resultSha: string | undefined,
) {
  const unproven = unprovenRequirements(requirements, evidence, resultSha);
  return unproven.length
    ? 'Сценарий не подтверждён выполненным тестом: ' +
        unproven.map((p) => `${p.id} — ${p.reason}`).join('; ')
    : undefined;
}

/** Предел имени testcase: столько переносит receipt между клонами. */
export const TEST_ID_LIMIT = 1000;
/**
 * Имя testcase, пригодное для переноса. Длинное заменяется хешем, а не
 * обрезается: обрезка дала бы коллизии и ложные совпадения. Такое имя
 * помечено opaque и ничего не подтверждает.
 */
export function portableTest<T extends { id: string; opaque?: true }>(test: T): T {
  return test.id.length > TEST_ID_LIMIT
    ? { ...test, id: 'sha256:' + createHash('sha256').update(test.id).digest('hex'), opaque: true }
    : test;
}
