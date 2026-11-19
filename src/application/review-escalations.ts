// Эскалации технического ревью, которые ждут владельца (harness
// 0.1.0-alpha.54, протокол ревью §8): блокирующая находка плана, контракта
// или ответа на вопрос исполнителя открыта три раунда подряд, и следующий
// раунд движок не начнёт, пока оператор не примет её ограничением или не
// разрешит ещё раунды (`review-decide`, карточка центра внимания). Одно
// чтение для центра внимания и `session_handoff`: последний раунд каждого
// предмета, его эскалированные находки и решения владельца, уже записанные
// для следующего раунда. Только чтение.
import {
  WORKSPACE_OWNER,
  escalatedFindings,
  openRounds,
  type ReviewRecord,
} from 'devcontour-harness';
import { dirname } from 'node:path';
import { pendingReviewDecisions, recordReviewDecision } from '../core/review-decisions.ts';
import { DomainError } from '../core/model.ts';
import { executionOf, reviewExecutionOf } from '../harness/execution.ts';
import type { DevContour } from '../core/service.ts';
import type { ContractAttempt } from '../core/model.ts';
import type { Store } from '../core/store.ts';

/** Предел находок эскалации в карточке и шаге: остальные — числом. */
export const ESCALATION_FINDINGS = 20;

export interface ReviewEscalation {
  kind: 'plan' | 'contract';
  /** Предмет раундов harness (как в `review-decide --subject`). */
  subject: string;
  /** Последний раунд предмета: решения записываются по нему. */
  round: number;
  at: string;
  summary: string;
  /** Блокирующие находки, открытые три раунда подряд и без решения владельца. */
  findings: { id: string; message: string; rounds: number }[];
  /** Сколько таких находок сверх `findings`. */
  more: number;
  /** Задача вопроса исполнителя (предмет `input-<requestId>`). */
  requestId?: string;
  /** Заголовок контракта по записи раунда DevContour (`contractAttempts`, каталог артефакта раунда). */
  title?: string;
}

const INPUT_PREFIX = 'input-';

/**
 * Последние раунды предметов, разобранные один раз на версию данных
 * хранилища: опрос без записей не разбирает записи ревью заново.
 */
const cache = new WeakMap<Store, { revision: number; value: readonly ReviewEscalation[] }>();

/**
 * Эскалации, ждущие решения владельца: у последнего раунда предмета есть
 * эскалированные находки (`escalatedFindings`), по которым решение для
 * следующего раунда ещё не записано (`pendingReviewDecisions`). Записанное
 * решение снимает находку отсюда: дальше шаг ведущего — тот же раунд ревью.
 * Старые первыми.
 */
export function reviewEscalations(h: DevContour): readonly ReviewEscalation[] {
  const revision = h.store.version().revision;
  const hit = cache.get(h.store);
  if (hit && hit.revision === revision) return hit.value;
  const last = new Map<string, ReviewRecord>();
  for (const { value: r } of executionOf(h).engine.read((v) =>
    v.locals('reviews', WORKSPACE_OWNER),
  )) {
    const key = `${r.kind}\u0000${r.subject}`;
    const prev = last.get(key);
    if (!prev || r.round > prev.round) last.set(key, r);
  }
  // Записи раундов DevContour — только для заголовка эскалированного контракта.
  let attempts: readonly ContractAttempt[] | undefined;
  const value: ReviewEscalation[] = [];
  for (const r of last.values()) {
    const waiting = escalatedFindings(r.findings, r.round);
    if (!waiting.length) continue;
    const decided = new Set(
      pendingReviewDecisions(h.store, r.kind, r.subject, r).map((d) => d.finding),
    );
    const open = waiting.filter((f) => !decided.has(f.id));
    if (!open.length) continue;
    const title =
      r.kind === 'contract'
        ? (attempts ??= h.store.read().contractAttempts ?? []).find(
            (a) => a.artifact === dirname(r.artifact) && a.attempt === r.round,
          )?.title
        : undefined;
    value.push({
      kind: r.kind,
      subject: r.subject,
      round: r.round,
      at: r.at,
      summary: r.summary,
      findings: open.slice(0, ESCALATION_FINDINGS).map((f) => ({
        id: f.id,
        message: f.message,
        rounds: openRounds(f, r.round),
      })),
      more: Math.max(0, open.length - ESCALATION_FINDINGS),
      ...(r.kind === 'plan' && r.subject.startsWith(INPUT_PREFIX)
        ? { requestId: r.subject.slice(INPUT_PREFIX.length) }
        : {}),
      ...(title ? { title } : {}),
    });
  }
  value.sort((a, b) => a.at.localeCompare(b.at) || a.subject.localeCompare(b.subject));
  cache.set(h.store, { revision, value });
  return value;
}

/** Что ревьюировали — словами владельца. */
export function escalationSubjectText(e: ReviewEscalation, boardTitle?: string) {
  if (e.requestId) return 'ответа на вопрос исполнителя';
  if (e.kind === 'contract') return e.title ? `контракта «${e.title}»` : 'контракта';
  return boardTitle ? `плана доски «${boardTitle}»` : `плана доски ${e.subject}`;
}

/**
 * Решение владельца по эскалированным находкам — одно правило для CLI
 * `review-decide` и карточки центра внимания: только оператор (ведущему
 * движок такое решение не разрешает, и DevContour его не записывает), по
 * последнему раунду предмета (`recordReviewDecision`).
 */
export function decideReview(h: DevContour, raw: unknown, actor: 'operator' | 'lead') {
  if (actor !== 'operator')
    throw new DomainError(
      'Решение по находке после эскалации — решение оператора; ведущий агент его не принимает',
      403,
    );
  const { kind, subject } = (raw ?? {}) as { kind?: unknown; subject?: unknown };
  return recordReviewDecision(
    h.store,
    raw,
    (kind === 'plan' || kind === 'contract') && typeof subject === 'string'
      ? reviewExecutionOf(h).engine.reviews(kind, subject).at(-1)
      : undefined,
  );
}
