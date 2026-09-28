import { createHash } from 'node:crypto';
import type { FailureKind } from './failure.ts';
import type { DevContourState, Run, Task } from './model.ts';

// Переиспользование реализации после несостоявшейся проверки.
//
// Реализация — самая дорогая фаза попытки. Если после неё отказала не работа,
// а окружение (оборвался транспорт проверяющего, истёк срок владения, кончилось
// время ревью), новая попытка писала тот же код заново. Одинаковое дерево
// файлов при этом ничего не доказывает: код переиспользуется, только когда
// совпадают все основания, на которых он был написан, — и проверки с ревью
// исполняются заново. Всё, что не совпало или не записано, означает обычную
// попытку с нуля.

/** Отказы, которые ничего не говорят о коде кандидата. */
export const reusableFailures: readonly FailureKind[] = ['environment', 'timeout'];

/** Основания фазы реализации: всё, от чего зависел написанный код. */
export interface ImplementationBasis {
  /** Утверждённая спецификация задачи. */
  spec: string;
  /** Контракты, на которые задача ссылается, по их digest. */
  contracts: Record<string, string>;
  /** Договор исполнения: проверки, окружение, роли, изоляция, память. */
  policyDigest: string;
  runtime: string;
  model?: string;
  /** Ветка интеграции, от которой ответвлён кандидат. */
  baseSha: string;
  context: unknown;
  dependencies: unknown;
  memory?: string;
  /** Версия контура: правила области и сборки подсказки. */
  tool: string;
}

export function implementationBasis(task: Task, run: Run, baseSha: string, tool: string) {
  const basis: ImplementationBasis = {
    spec: task.approvedDigest ?? '',
    contracts: task.contractDigests,
    policyDigest: run.policyDigest,
    runtime: run.runtime,
    model: run.model,
    baseSha,
    context: run.context ?? [],
    dependencies: run.dependencies ?? [],
    memory: run.memory?.digest,
    tool,
  };
  return createHash('sha256').update(JSON.stringify(basis)).digest('hex');
}

export type ReuseDecision =
  { reuse: true; from: Run; candidateSha: string } | { reuse: false; reason: string };

/**
 * Можно ли вместо новой реализации взять кандидата предыдущей попытки.
 *
 * Только непосредственно предыдущая попытка той же задачи: пропустить более
 * позднее отклонение ревью и вернуться к старому коду значило бы проигнорировать
 * замечание. Только кандидат, прошедший реализацию (записан его SHA), и только
 * после отказа, не относящегося к коду. Основания должны совпасть целиком.
 */
export function reusableImplementation(
  s: DevContourState,
  task: Task,
  currentRunId: string,
  basis: string,
): ReuseDecision {
  if (!task.approvedDigest) return { reuse: false, reason: 'задача не утверждена' };
  const previous = s.runs.findLast((r) => r.taskId === task.id && r.id !== currentRunId);
  if (!previous) return { reuse: false, reason: 'предыдущей попытки нет' };
  if (!['failed', 'expired'].includes(previous.status))
    return { reuse: false, reason: `предыдущая попытка ${previous.status}` };
  if (!previous.failureKind || !reusableFailures.includes(previous.failureKind))
    return {
      reuse: false,
      reason: `отказ класса ${previous.failureKind ?? 'unknown'} относится к коду или не определён`,
    };
  if (!previous.candidateSha || !previous.implementationBasis)
    return { reuse: false, reason: 'кандидат предыдущей попытки не записан' };
  if (previous.implementationBasis !== basis)
    return { reuse: false, reason: 'основания реализации изменились' };
  return { reuse: true, from: previous, candidateSha: previous.candidateSha };
}

/**
 * Черновик предыдущей попытки, с которого стоит продолжить.
 *
 * Время реализации кончилось раньше работы — или ревью отклонило готового
 * кандидата за конкретные находки. Повтор с пустого дерева тратит предел
 * попытки на уже сделанное и нередко упирается в него снова. Черновик берётся
 * только у непосредственно предыдущей попытки и только если постановка и
 * контракты с тех пор не менялись: иначе он написан под другую задачу.
 * Проверки и ревью он не заменяет — это отправная точка.
 */
export type Draft =
  | { kind: 'timeout'; runId: string; patch: string; digest: string; files: string[] }
  | { kind: 'review'; runId: string; baseSha: string; candidateSha: string };
export function continuableDraft(
  s: DevContourState,
  task: Task,
  currentRunId: string,
): Draft | undefined {
  const previous = s.runs.findLast((r) => r.taskId === task.id && r.id !== currentRunId);
  if (!previous || previous.status !== 'failed') return undefined;
  if (
    previous.failureKind === 'review' &&
    previous.candidateSha &&
    previous.baseSha &&
    previous.implementationBasis &&
    task.approvedDigest
  ) {
    // Основания записаны хешем; постановку и контракты сверяет спецификация
    // задачи, одобренная до этой попытки и не менявшаяся после.
    if (previous.startedAt < (task.approvedAt ?? '')) return undefined;
    return {
      kind: 'review',
      runId: previous.id,
      baseSha: previous.baseSha,
      candidateSha: previous.candidateSha,
    };
  }
  if (
    !previous.partial ||
    previous.failureKind !== 'timeout' ||
    previous.candidateSha ||
    previous.partial.spec !== task.approvedDigest ||
    JSON.stringify(previous.partial.contracts) !== JSON.stringify(task.contractDigests)
  )
    return undefined;
  return {
    kind: 'timeout',
    runId: previous.id,
    patch: previous.partial.patch,
    digest: previous.partial.digest,
    files: previous.partial.files,
  };
}
