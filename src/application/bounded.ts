/**
 * Ограничители проекций панели. Диагностику пишут runner, гейты, scheduler и
 * ведущий (ошибки, отчёты, причины решений), и её длину не ограничивает ни
 * одна схема: в сводку и детали она попадает сокращённой.
 */

/** Сколько знаков текста остаётся в компактной строке. */
export const SHORT = 300;
/** Предел одной строки диагностики (ошибки, отчёты, история эпизода). */
export const DIAGNOSTIC = 2000;

export const short = (text: string | undefined, n = SHORT) =>
  text && text.length > n ? text.slice(0, n) + '…' : text;

/** Строки не длиннее `n` на любой глубине, без токенов владения. */
export function clip<T>(value: T, n = DIAGNOSTIC): T {
  if (typeof value === 'string') return short(value, n) as T;
  if (Array.isArray(value)) return (value as unknown[]).map((v) => clip(v, n)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== 'token')
        .map(([k, v]) => [k, clip(v, n)]),
    ) as T;
  return value;
}
