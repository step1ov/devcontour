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

/** Разметка Markdown, которая не меняет слово: `**REQ-1**`, `` `REQ-1` ``. */
const MARKUP = /[`*_]/g;
/** Номер раздела перед текстом заголовка: `4.`, `2.1`, `10.`. */
const SECTION_NUMBER = /^\d+(?:\.\d+)*\.?\s+/;
/**
 * Метка в начале заголовка, похожая на ID, в том числе составная:
 * `ORD-RET-01`, `REQ-4.2`. По ней ревьюер называет раздел, не повторяя
 * его заголовок целиком.
 */
const LABEL = /^\p{L}{2,}(?:-\p{L}[\p{L}\p{N}]*)*-\d+(?:\.\d+)*/u;

/** Метка заголовка (`ORD-04` у «ORD-04. Оплата заказа») или undefined. */
export function headingLabel(heading: string) {
  const text = heading
    .replace(/\{#[^}]*\}\s*$/, '')
    .replace(MARKUP, '')
    .trim();
  return LABEL.exec(text.replace(SECTION_NUMBER, ''))?.[0];
}

/**
 * Разделы документа: заголовок (undefined — текст до первого заголовка),
 * его якоря и собственный текст до следующего заголовка любого уровня, вместе
 * со строкой заголовка. Подразделы в текст раздела не входят. Заголовки
 * внутри блоков кода разделов не начинают.
 */
export function sections(text: string) {
  const out: { heading?: string; anchors: string[]; text: string }[] = [{ anchors: [], text: '' }];
  const counts = new Map<string, number>();
  let fence: string | undefined;
  for (const line of text.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
    }
    const heading = fence || marker ? undefined : /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)?.[1];
    if (heading !== undefined) {
      const own: string[] = [];
      const explicit = /\{#([^}\s]+)\}\s*$/.exec(heading)?.[1];
      if (explicit) own.push(explicit.toLowerCase());
      const base = slug(heading.replace(/\{#[^}]*\}\s*$/, ''));
      const n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      own.push(n ? `${base}-${n}` : base);
      out.push({ heading, anchors: own, text: line + '\n' });
      continue;
    }
    const section = out.at(-1)!;
    section.text += line + '\n';
    for (const m of line.matchAll(/<a\s[^>]*\b(?:id|name)\s*=\s*["']([^"']+)["']/gi))
      section.anchors.push(m[1].toLowerCase());
  }
  return out;
}

/**
 * ID, которые документ определяет сам, по месту в структуре, с силой
 * определения: 3 — метка в начале заголовка (`### ORD-04. …`); 2 — первое
 * слово блока (абзаца, пункта списка, строки таблицы или цитаты) с
 * разделителем следом (`REQ-1. …`, `- REQ-2: …`, `| REQ-3 | …`); 1 — метка
 * правила в тексте (`…: REQ-3. The listing…` — ID, точка и слово с
 * прописной). Остальные вхождения — ссылки: на ADR, сценарии тестов, правила
 * других документов или этого же («по ORD-05»).
 */
export function definitions(text: string) {
  const known = new Set(idTokens(text));
  const out = new Map<string, number>();
  const define = (id: string | undefined, strength: number) => {
    if (id && known.has(id) && (out.get(id) ?? 0) < strength) out.set(id, strength);
  };
  const lead = (line: string) =>
    new RegExp(`^(${ID_TOKEN.source})\\s*(?:[.:)|—–]|-\\s|$)`, 'u').exec(
      line.replace(MARKUP, '').trim(),
    )?.[1];
  let fence: string | undefined;
  let previous = '';
  for (const line of text.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      previous = '';
      continue;
    }
    if (fence) continue;
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)?.[1];
    if (heading !== undefined) {
      define(headingLabel(heading), 3);
      previous = '';
      continue;
    }
    // Первое слово блока: после пустой строки или заголовка, пункт списка,
    // строка таблицы; маркеры цитаты не считаются.
    const bare = line.replace(/^\s*(?:>\s?)+/, '');
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(bare)?.[1];
    const row = /^\s*\|(.*)$/.exec(bare)?.[1];
    const start = item ?? row ?? (previous.trim() ? undefined : bare);
    if (start !== undefined) define(lead(start), 2);
    for (const m of line.matchAll(
      new RegExp(`(${ID_TOKEN.source})[\`*_]*\\.[\`*_]*\\s+(?=\\p{Lu})`, 'gu'),
    ))
      define(m[1], 1);
    previous = bare;
  }
  return out;
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
