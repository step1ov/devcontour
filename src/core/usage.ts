import { z } from 'zod';
import type { RuntimeDiagnostics } from './runtime-diagnostics.ts';

const count = z.number().int().nonnegative().nullable();
export const usageSchema = z
  .object({
    inputTokens: count,
    outputTokens: count,
    cacheReadTokens: count,
    cacheWriteTokens: count,
    reportedUsd: z.number().nonnegative().nullable(),
    complete: z.boolean(),
    source: z.enum(['codex-turn-events', 'claude-result', 'unavailable']),
  })
  .strict();
export type Usage = z.infer<typeof usageSchema>;
export const unknownUsage = (): Usage => ({
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reportedUsd: null,
  complete: false,
  source: 'unavailable',
});
export const priceSchema = z
  .object({
    runtime: z.enum(['codex', 'claude']),
    model: z.string().min(1),
    effectiveAt: z.iso.datetime(),
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
  })
  .strict();
export type Price = z.infer<typeof priceSchema>;
export interface UsageRecord {
  diagnostics?: RuntimeDiagnostics;
  id: string;
  repositoryId?: string;
  runId?: string;
  subjectId?: string;
  stage: string;
  runtime: string;
  model: string | null;
  runtimeVersion: string | null;
  startedAt: string;
  finishedAt?: string;
  /**
   * `abandoned` — вызов не завершился: процесс, который его вёл, умер.
   * Восстановление закрывает такие записи; их стоимость неизвестна, если её
   * не успели сообщить.
   */
  outcome: 'active' | 'returned' | 'error' | 'abandoned';
  /** Процесс, который ведёт вызов: по нему восстановление узнаёт прерванные. */
  process?: { id: string; pid: number };
  /** Когда восстановление признало вызов прерванным: верхняя граница его времени. */
  abandonedAt?: string;
  promptBytes: number;
  promptDigest: string;
  usage: Usage;
  costUsd: number | null;
  costSource: 'provider-reported' | 'tariff-estimate' | 'unknown';
  price?: Price;
}
/**
 * Стоимость вызова. Сообщённая провайдером — как есть, и при ошибке вызова.
 * Оценка по тарифу — только по полным счётчикам: у оборванного вызова они
 * частичные, и оценка выдала бы нижнюю границу за стоимость.
 */
export function priceUsage(usage: Usage, price?: Price) {
  if (usage.reportedUsd !== null)
    return { costUsd: usage.reportedUsd, costSource: 'provider-reported' as const };
  const { inputTokens: i, outputTokens: o, cacheReadTokens: r, cacheWriteTokens: w } = usage;
  if (!price || !usage.complete || [i, o, r, w].some((v) => v === null) || i! < r! + w!)
    return { costUsd: null, costSource: 'unknown' as const };
  return {
    costUsd:
      ((i! - r! - w!) * price.input +
        o! * price.output +
        r! * price.cacheRead +
        w! * price.cacheWrite) /
      1e6,
    costSource: 'tariff-estimate' as const,
  };
}
/** Время вызова: до завершения, а у идущего — до `at`. */
export const callDurationMs = (r: UsageRecord, at = Date.now()) =>
  Math.max(
    0,
    Date.parse(r.finishedAt ?? r.abandonedAt ?? new Date(at).toISOString()) -
      Date.parse(r.startedAt),
  );

export function usageTotals(records: UsageRecord[], uncovered = false, at = Date.now()) {
  const complete =
    records.length > 0 &&
    !uncovered &&
    records.every(
      (r) =>
        r.outcome !== 'active' &&
        r.outcome !== 'abandoned' &&
        r.usage.complete &&
        r.costUsd !== null,
    );
  const sum = (source: UsageRecord['costSource']) =>
    records.filter((r) => r.costSource === source).reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const reportedUsd = sum('provider-reported');
  const estimatedUsd = sum('tariff-estimate');
  const knownCostUsd = reportedUsd + estimatedUsd;
  return {
    calls: records.length,
    costUsd: complete ? knownCostUsd : null,
    knownCostUsd,
    /** Сообщено провайдером. */
    reportedUsd,
    /** Оценено по тарифу. */
    estimatedUsd,
    complete,
    unknownCalls: records.filter(
      (r) =>
        r.costUsd === null ||
        !r.usage.complete ||
        r.outcome === 'active' ||
        r.outcome === 'abandoned',
    ).length,
    estimatedCalls: records.filter((r) => r.costSource === 'tariff-estimate').length,
    reportedCalls: records.filter((r) => r.costSource === 'provider-reported').length,
    /** Идущие вызовы и прерванные падением процесса. */
    unfinishedCalls: records.filter((r) => r.outcome === 'active').length,
    abandonedCalls: records.filter((r) => r.outcome === 'abandoned').length,
    errorCalls: records.filter((r) => r.outcome === 'error').length,
    durationMs: records.reduce((s, r) => s + callDurationMs(r, at), 0),
  };
}
