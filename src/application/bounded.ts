/**
 * Ограничители проекций панели. Диагностику пишут runner, гейты, scheduler и
 * ведущий (ошибки, отчёты, причины решений), и её длину не ограничивает ни
 * одна схема: в сводку и детали она попадает сокращённой. Усечение — общая
 * операция harness (`clipText`/`clipDeep`): длина в code units JS, «…» после
 * усечения, ключ `token` удаляется на любой глубине; общего предела размера
 * объекта нет. Здесь — пределы хоста.
 */
import { CLIP_DIAGNOSTIC, CLIP_SHORT, clipDeep, clipText } from 'devcontour-harness';

/** Сколько знаков текста остаётся в компактной строке. */
export const SHORT = CLIP_SHORT;
/** Предел одной строки диагностики (ошибки, отчёты, история эпизода). */
export const DIAGNOSTIC = CLIP_DIAGNOSTIC;

export const short = clipText;

/** Строки не длиннее `n` на любой глубине, без токенов владения. */
export const clip = <T>(value: T, n = DIAGNOSTIC): T => clipDeep(value, n);
