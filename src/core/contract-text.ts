import { basename } from 'node:path';

/**
 * Чистые проверки текста консолидации (F20): ID-токены правил, якоря
 * заголовков и ссылки соседних документов. Ими пользуются предпроверки
 * операции и импорт Git sync — без модели и без Git.
 */

/**
 * ID-токены правил: буквенный префикс (латиница или кириллица, любой
 * регистр), дефис, номер с подномерами — `REQ-12`, `ТР-4`, `req-1.2`.
 * Не после буквы, цифры, `_` или `-`, чтобы не резать составные слова.
 */
export const ID_TOKEN = /(?<![\p{L}\p{N}_-])\p{L}{2,}-\d+(?:\.\d+)*/gu;
/** Префиксы кодировок, алгоритмов и стандартов: `UTF-8`, `SHA-256`, `ISO-8601` — не правила. */
const NOT_RULES = new Set([
  'utf',
  'ucs',
  'sha',
  'md',
  'iso',
  'ecma',
  'es',
  'tls',
  'ssl',
  'http',
  'ipv',
  'rfc',
  'base',
]);

export function idTokens(text: string) {
  return [
    ...new Set(
      (text.match(ID_TOKEN) ?? []).filter(
        (t) => !NOT_RULES.has(t.slice(0, t.indexOf('-')).toLowerCase()),
      ),
    ),
  ].sort();
}

/** Якорь заголовка в форме GitHub: нижний регистр, без пунктуации, пробелы — дефисы. */
export function slug(heading: string) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Заголовки Markdown вне блоков кода: текст без явного `{#id}`. */
export function headings(text: string) {
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of text.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)?.[1];
    if (heading !== undefined) out.push(heading);
  }
  return out;
}

/**
 * Якоря документа: заголовки Markdown (повтор получает суффикс `-1`, `-2`,
 * как у GitHub) и явные `id`/`name` HTML и `{#id}`. Заголовки внутри блоков
 * кода не считаются.
 */
export function anchors(text: string) {
  const out = new Set<string>();
  const counts = new Map<string, number>();
  for (const heading of headings(text)) {
    const explicit = /\{#([^}\s]+)\}\s*$/.exec(heading)?.[1];
    if (explicit) out.add(explicit.toLowerCase());
    const base = slug(heading.replace(/\{#[^}]*\}\s*$/, ''));
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  for (const m of text.matchAll(/<a\s[^>]*\b(?:id|name)\s*=\s*["']([^"']+)["']/gi))
    out.add(m[1].toLowerCase());
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Якоря документа `file`, на которые ссылается текст соседа: `catalog.md#rules`. */
export function referencedAnchors(text: string, file: string) {
  const name = escape(basename(file));
  const found = new Set<string>();
  for (const m of text.matchAll(
    new RegExp(`(?:^|[^\\w./-])(?:[\\w./-]*/)?${name}#([^\\s)\\]>"'\`]+)`, 'g'),
  )) {
    let anchor = m[1];
    try {
      anchor = decodeURIComponent(anchor);
    } catch {
      /* Оставить как есть. */
    }
    found.add(anchor.toLowerCase());
  }
  return [...found];
}

/**
 * Детерминированные условия равносильности текста `next` прежнему `previous`
 * документа `file`: короче, все ID-токены на месте, якоря, на которые
 * ссылаются `siblings`, на месте. Пустые списки и `longer: false` — годно.
 */
export function textChecks(
  previous: string,
  next: string,
  file: string,
  siblings: readonly { source?: string; title: string; content: string }[],
) {
  const kept = new Set(idTokens(next));
  const before = anchors(previous);
  const after = anchors(next);
  return {
    longer: next.length >= previous.length,
    lost: idTokens(previous).filter((id) => !kept.has(id)),
    broken: siblings.flatMap((c) =>
      referencedAnchors(c.content, file)
        .filter((a) => before.has(a) && !after.has(a))
        .map((a) => `${c.source ?? c.title}: #${a}`),
    ),
  };
}
