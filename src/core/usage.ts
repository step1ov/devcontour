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
  process?: { id: string; pid: number; startedAt?: number };
  /** Когда восстановление признало вызов прерванным: верхняя граница его времени. */
  abandonedAt?: string;
  /**
   * Время вызова по монотонным часам процесса, который его вёл: перевод
   * системных часов его не искажает. Нет поля — время по меткам начала и конца.
   */
  durationMs?: number;
  /**
   * Время идущего вызова по монотонным часам его процесса, сохраняемое по ходу
   * вызова: другой процесс не видит его время ниже этого замера, даже если
   * системные часы переведены назад.
   */
  elapsedMs?: number;
  /**
   * Начало вызова по монотонным часам ОС (нс, общие для процессов одной
   * машины до перезагрузки): по ним другой процесс считает время идущего
   * вызова независимо от системных часов.
   */
  startedHr?: string;
  /**
   * Задача и доска, о которых вызов, на момент вызова: расход остаётся за ними,
   * даже если граф потом изменится (перенос задачи между досками).
   */
  taskId?: string;
  boardId?: string;
  /**
   * Задачи, за которыми учтён вызов о доске (её открытые задачи на момент
   * вызова): перенос задачи не снимает с неё этот расход.
   */
  taskIds?: string[];
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
/**
 * Начало идущих вызовов этого процесса по монотонным часам. Без зависимостей
 * от Node: модуль входит и в бандл панели.
 */
const activeStarts = new Map<string, number>();
/** Монотонные часы ОС, нс; их регистрирует runner (в панели их нет). */
let monotonicNow: (() => bigint) | undefined;
export const registerMonotonic = (now: () => bigint) => {
  monotonicNow = now;
};
export const activeStart = (id: string) => activeStarts.get(id);
export const startActive = (id: string) => activeStarts.set(id, performance.now());
export const endActive = (id: string) => activeStarts.delete(id);
/**
 * Время вызова: монотонное, если записано; иначе по меткам до завершения, а у
 * идущего — до `at`. `null` — время неизвестно: метки противоречат друг другу
 * (часы переведены назад), и ноль выдал бы потраченное время за непотраченное.
 */
export const callDurationMs = (r: UsageRecord, at = Date.now()): number | null => {
  if (r.durationMs !== undefined) return r.durationMs;
  // Идущий вызов этого процесса — по монотонным часам: перевод системных
  // часов не уменьшает уже потраченное время.
  const started = r.outcome === 'active' ? activeStart(r.id) : undefined;
  if (started !== undefined) return Math.round(performance.now() - started);
  // Идущий вызов другого процесса той же машины — по монотонным часам ОС.
  // Отрицательная разность — часы другой загрузки: тогда по меткам.
  if (r.outcome === 'active' && r.startedHr && monotonicNow) {
    const elapsed = Number((monotonicNow() - BigInt(r.startedHr)) / 1_000_000n);
    if (elapsed >= 0) return Math.max(elapsed, r.elapsedMs ?? 0);
  }
  const elapsed =
    Date.parse(r.finishedAt ?? r.abandonedAt ?? new Date(at).toISOString()) -
    Date.parse(r.startedAt);
  // Сохранённый монотонный замер — нижняя граница: откат часов не опускает
  // время ниже него.
  if (r.elapsedMs !== undefined) return Math.max(r.elapsedMs, elapsed);
  return elapsed >= 0 ? elapsed : null;
};
/**
 * Стоимость вызова известна, когда она сообщена провайдером (в том числе 0 и
 * при ошибке или прерывании) или оценена по полным счётчикам завершённого
 * вызова. Идущий вызов ещё может стоить больше записанного; у прерванного
 * оценка — лишь нижняя граница: после неё он мог продолжать тратить.
 */
export const knownCost = (r: UsageRecord) =>
  r.costUsd !== null &&
  r.outcome !== 'active' &&
  (r.outcome !== 'abandoned' || r.costSource === 'provider-reported');

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
    unknownCalls: records.filter((r) => !knownCost(r)).length,
    estimatedCalls: records.filter((r) => r.costSource === 'tariff-estimate').length,
    reportedCalls: records.filter((r) => r.costSource === 'provider-reported').length,
    /** Идущие вызовы и прерванные падением процесса. */
    unfinishedCalls: records.filter((r) => r.outcome === 'active').length,
    abandonedCalls: records.filter((r) => r.outcome === 'abandoned').length,
    errorCalls: records.filter((r) => r.outcome === 'error').length,
    durationMs: records.reduce((s, r) => s + (callDurationMs(r, at) ?? 0), 0),
    /** Вызовы с неизвестным временем: их время в `durationMs` не вошло. */
    unknownDurationCalls: records.filter((r) => callDurationMs(r, at) === null).length,
  };
}
