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
import {
  HarnessError,
  escalatedFindings,
  type ReviewDisposition,
  type ReviewRecord,
} from 'devcontour-harness';
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

/** Решение оператора, привязанное к раунду, состояние которого он видел. */
type Decision = ReviewDisposition & { forRound: number };

interface Stored {
  kind: 'plan' | 'contract';
  subject: string;
  dispositions: Decision[];
  at: string;
}

const keyOf = (kind: string, subject: string) => `${kind}:${subject}`;

type Last = Pick<ReviewRecord, 'round' | 'findings'> | undefined;

const stored = (store: Store, key: string) =>
  store.localEntries<Stored>(REVIEW_DECISIONS).find((e) => e.owner === undefined && e.key === key)
    ?.value;

/** Находки, которые ждут решения оператора после последнего раунда. */
const escalated = (last: NonNullable<Last>) =>
  new Set(escalatedFindings(last.findings, last.round).map((f) => f.id));

/**
 * Записать решение оператора; следующий раунд предмета передаст его движку.
 * `last` — последний раунд предмета: решение — только по открытой находке
 * этого предмета, `continue` — только по находке после эскалации (иначе
 * отказ, а не отравленный следующий раунд). Решение привязано к этому
 * раунду: после следующего раунда оно не повторяется.
 */
export function recordReviewDecision(store: Store, raw: unknown, last: Last) {
  const input = reviewDecisionInput.parse(raw);
  if (!last)
    throw new DomainError(
      `Ревью ${input.kind} ${input.subject}: раундов нет — проверьте предмет (как в отказе эскалации)`,
      404,
    );
  const waiting = escalated(last);
  for (const id of input.findings) {
    const f = last.findings.find((x) => x.id === id);
    if (!f || f.status !== 'open')
      throw new DomainError(
        `Находка ${id} ${f ? `не открыта (${f.status})` : 'не найдена'} в последнем раунде ревью ${input.kind} ${input.subject}`,
        409,
      );
    if (input.decision === 'continue' && !waiting.has(id))
      throw new DomainError(
        `Находка ${id} не ждёт решения: продолжение нужно только после эскалации`,
        409,
      );
  }
  const key = keyOf(input.kind, input.subject);
  return store.atomic(() => {
    // Новое решение по той же находке заменяет прежнее; решения прежних
    // раундов уже не действуют.
    const kept = (stored(store, key)?.dispositions ?? []).filter(
      (d) => d.forRound === last.round && !input.findings.includes(d.finding),
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
          forRound: last.round,
        })),
      ],
      at: new Date().toISOString(),
    };
    store.saveLocal(REVIEW_DECISIONS, undefined, key, value);
    return { status: 'recorded' as const, ...value };
  });
}

/**
 * Решения оператора для следующего раунда предмета: записанные по его
 * последнему раунду, по открытой находке, `continue` — только по находке
 * после эскалации. Остальные движок отклонил бы, и ревью они не держат.
 */
export function pendingReviewDecisions(
  store: Store,
  kind: 'plan' | 'contract',
  subject: string,
  last: Last,
): ReviewDisposition[] {
  if (!last) return [];
  const open = new Set(last.findings.filter((f) => f.status === 'open').map((f) => f.id));
  const waiting = escalated(last);
  return (stored(store, keyOf(kind, subject))?.dispositions ?? [])
    .filter(
      (d) =>
        d.forRound === last.round &&
        open.has(d.finding) &&
        (d.decision !== 'continue' || waiting.has(d.finding)),
    )
    .map((d) => ({ finding: d.finding, decision: d.decision, by: d.by, reason: d.reason }));
}

/**
 * Раунд записан. Применил ли он решения: у их находок — решение этого раунда
 * или изменение в нём (reviewer мог тут же открыть находку снова). Раунд с
 * ответом вне протокола их не применяет: решения переносятся на него и ждут
 * следующего. Иначе решения прежнего раунда сняты — и применённые, и
 * записанные во время раунда по прежнему состоянию (их нужно принять заново
 * по новому раунду). Сверка — в транзакции.
 */
export function clearReviewDecisions(
  store: Store,
  kind: 'plan' | 'contract',
  subject: string,
  used: readonly ReviewDisposition[],
  record: Pick<ReviewRecord, 'round' | 'findings'>,
) {
  if (!used.length) return;
  const applied = used.some((d) => {
    const f = record.findings.find((x) => x.id === d.finding);
    return f?.disposition?.round === record.round || f?.changedIn === record.round;
  });
  const key = keyOf(kind, subject);
  store.atomic(() => {
    const current = stored(store, key);
    if (!current) return;
    if (!applied) {
      store.saveLocal(REVIEW_DECISIONS, undefined, key, {
        ...current,
        dispositions: current.dispositions.map((d) =>
          d.forRound === record.round - 1 ? { ...d, forRound: record.round } : d,
        ),
      });
      return;
    }
    const rest = current.dispositions.filter((d) => d.forRound >= record.round);
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
