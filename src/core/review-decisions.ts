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
import { HarnessError, type ReviewDisposition, type ReviewRecord } from 'devcontour-harness';
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

type Finding = ReviewRecord['findings'][number];

const stored = (store: Store, key: string) =>
  store.localEntries<Stored>(REVIEW_DECISIONS).find((e) => e.owner === undefined && e.key === key)
    ?.value;

/**
 * Записать решение оператора; следующий раунд предмета передаст его движку.
 * `last` — находки последнего раунда предмета: решение — только по открытой
 * находке этого предмета (иначе отказ, а не отравленный следующий раунд).
 */
export function recordReviewDecision(
  store: Store,
  raw: unknown,
  last: readonly Finding[] | undefined,
) {
  const input = reviewDecisionInput.parse(raw);
  if (!last)
    throw new DomainError(
      `Ревью ${input.kind} ${input.subject}: раундов нет — проверьте предмет (как в отказе эскалации)`,
      404,
    );
  for (const id of input.findings) {
    const f = last.find((x) => x.id === id);
    if (!f || f.status !== 'open')
      throw new DomainError(
        `Находка ${id} ${f ? `не открыта (${f.status})` : 'не найдена'} в последнем раунде ревью ${input.kind} ${input.subject}`,
        409,
      );
  }
  const key = keyOf(input.kind, input.subject);
  return store.atomic(() => {
    // Новое решение по той же находке заменяет прежнее.
    const kept = (stored(store, key)?.dispositions ?? []).filter(
      (d) => !input.findings.includes(d.finding),
    );
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

/**
 * Решения оператора, ждущие следующего раунда предмета: только по находкам,
 * открытым в его последнем раунде (`last`) — решение по закрытой или чужой
 * находке движок отклонил бы, и оно не должно останавливать ревью.
 */
export function pendingReviewDecisions(
  store: Store,
  kind: 'plan' | 'contract',
  subject: string,
  last: readonly Finding[] | undefined,
): ReviewDisposition[] {
  const open = new Set((last ?? []).filter((f) => f.status === 'open').map((f) => f.id));
  return (stored(store, keyOf(kind, subject))?.dispositions ?? []).filter((d) =>
    open.has(d.finding),
  );
}

const same = (a: ReviewDisposition, b: ReviewDisposition) =>
  a.finding === b.finding && a.decision === b.decision && a.reason === b.reason;

/**
 * Раунд записан: снять те решения, которые он применил (у находки раунда —
 * `disposition` этого раунда). Раунд с ответом вне протокола решений не
 * применяет — они остаются; решение, записанное оператором во время раунда
 * (другое содержание), тоже остаётся. Сверка — в транзакции.
 */
export function clearReviewDecisions(
  store: Store,
  kind: 'plan' | 'contract',
  subject: string,
  used: readonly ReviewDisposition[],
  record: Pick<ReviewRecord, 'round' | 'findings'>,
) {
  if (!used.length) return;
  const applied = used.filter(
    (d) => record.findings.find((f) => f.id === d.finding)?.disposition?.round === record.round,
  );
  if (!applied.length) return;
  const key = keyOf(kind, subject);
  store.atomic(() => {
    const current = stored(store, key);
    if (!current) return;
    const rest = current.dispositions.filter((d) => !applied.some((a) => same(a, d)));
    if (rest.length === current.dispositions.length) return;
    if (rest.length)
      store.saveLocal(REVIEW_DECISIONS, undefined, key, { ...current, dispositions: rest });
    else store.deleteLocal(REVIEW_DECISIONS, undefined, key);
  });
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
