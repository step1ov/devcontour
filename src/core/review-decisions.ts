// Решения владельца по находкам технического ревью, которые harness поднял до
// эскалации (harness 0.1.0-alpha.54, протокол ревью §8): блокирующая находка,
// открытая три раунда подряд, останавливает следующий раунд до оплаченного
// вызова (`INPUT_REQUIRED`), пока оператор не примет её ограничением или не
// разрешит ещё раунды. DevContour хранит решение до следующего раунда того же
// предмета (`review-decisions` в `local_workflow`) и передаёт его движку как
// `dispositions` с `by: operator`; записанный раунд решение снимает.
// Записывает только человек (CLI без `--by host`): ведущему такое решение
// движок не разрешает.
import { z } from 'zod';
import { HarnessError, type ReviewDisposition } from 'devcontour-harness';
import { DomainError } from './model.ts';
import type { Store } from './store.ts';

export const REVIEW_DECISIONS = 'review-decisions';

const findingId = z.string().regex(/^[a-f0-9]{64}$/, 'Ожидается ID находки (64 hex)');

export const reviewDecisionInput = z.strictObject({
  kind: z.enum(['plan', 'contract']),
  /** Предмет раундов harness: как в отказе эскалации (`Ревью плана <предмет>`). */
  subject: z.string().min(1).max(500),
  findings: z.array(findingId).min(1).max(20),
  decision: z.enum(['continue', 'accepted-limitation']),
  reason: z.string().trim().min(3).max(4000),
});

interface Stored {
  kind: 'plan' | 'contract';
  subject: string;
  dispositions: ReviewDisposition[];
  at: string;
}

const keyOf = (kind: string, subject: string) => `${kind}:${subject}`;

/** Записать решение оператора; следующий раунд предмета передаст его движку. */
export function recordReviewDecision(store: Store, raw: unknown) {
  const input = reviewDecisionInput.parse(raw);
  const key = keyOf(input.kind, input.subject);
  return store.atomic(() => {
    const previous = store
      .localEntries<Stored>(REVIEW_DECISIONS)
      .find((e) => e.owner === undefined && e.key === key)?.value;
    // Новое решение по той же находке заменяет прежнее.
    const kept = (previous?.dispositions ?? []).filter((d) => !input.findings.includes(d.finding));
    const value: Stored = {
      kind: input.kind,
      subject: input.subject,
      dispositions: [
        ...kept,
        ...input.findings.map((finding) => ({
          finding,
          decision: input.decision,
          by: 'operator' as const,
          reason: input.reason,
        })),
      ],
      at: new Date().toISOString(),
    };
    store.saveLocal(REVIEW_DECISIONS, undefined, key, value);
    return { status: 'recorded' as const, ...value };
  });
}

/** Решения оператора, ждущие следующего раунда предмета. */
export function pendingReviewDecisions(
  store: Store,
  kind: 'plan' | 'contract',
  subject: string,
): ReviewDisposition[] {
  const key = keyOf(kind, subject);
  return (
    store.localEntries<Stored>(REVIEW_DECISIONS).find((e) => e.owner === undefined && e.key === key)
      ?.value.dispositions ?? []
  );
}

/** Раунд записан: решения применены движком и хранятся в его истории. */
export function clearReviewDecisions(store: Store, kind: 'plan' | 'contract', subject: string) {
  const key = keyOf(kind, subject);
  if (!pendingReviewDecisions(store, kind, subject).length) return;
  store.atomic(() => store.deleteLocal(REVIEW_DECISIONS, undefined, key));
}

/**
 * Отказ эскалации словами DevContour: движок называет свою CLI, а здесь —
 * команда DevContour с предметом и ID находок (они — в `issues` отказа).
 */
export function escalationRefusal(error: unknown, kind: 'plan' | 'contract', subject: string) {
  if (!(error instanceof HarnessError) || error.code !== 'INPUT_REQUIRED') return undefined;
  const ids = error.issues
    .filter((i) => i.path[0] === 'findings' && typeof i.path[1] === 'string')
    .map((i) => `${String(i.path[1])} (${i.message})`);
  if (!ids.length) return undefined;
  const refusal = new DomainError(
    `${error.message.split(' Ответ:')[0]} Решение — за владельцем (оператором), ведущий его не принимает: devcontour review-decide --kind ${kind} --subject ${JSON.stringify(subject)} --findings <id[,id…]> --decision accepted-limitation|continue --reason "<основание>" --workspace …; затем тот же раунд ревью снова. Находки: ${ids.join('; ')}`,
    409,
  );
  (refusal as DomainError & { code?: string }).code = 'INPUT_REQUIRED';
  return refusal;
}
