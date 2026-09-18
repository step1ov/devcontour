import { z } from 'zod';

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
  outcome: 'active' | 'returned' | 'error';
  promptBytes: number;
  promptDigest: string;
  usage: Usage;
  costUsd: number | null;
  costSource: 'provider-reported' | 'tariff-estimate' | 'unknown';
  price?: Price;
}
export function priceUsage(usage: Usage, price?: Price) {
  if (usage.reportedUsd !== null)
    return { costUsd: usage.reportedUsd, costSource: 'provider-reported' as const };
  const { inputTokens: i, outputTokens: o, cacheReadTokens: r, cacheWriteTokens: w } = usage;
  if (!price || [i, o, r, w].some((v) => v === null) || i! < r! + w!)
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
export function usageTotals(records: UsageRecord[], uncovered = false) {
  const complete =
    records.length > 0 &&
    !uncovered &&
    records.every((r) => r.outcome !== 'active' && r.usage.complete && r.costUsd !== null);
  const knownCostUsd = records.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  return {
    calls: records.length,
    costUsd: complete ? knownCostUsd : null,
    knownCostUsd,
    complete,
    unknownCalls: records.filter(
      (r) => r.costUsd === null || !r.usage.complete || r.outcome === 'active',
    ).length,
    estimatedCalls: records.filter((r) => r.costSource === 'tariff-estimate').length,
  };
}
