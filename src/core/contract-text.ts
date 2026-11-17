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

const tokens = (text: string, pattern: RegExp) =>
  [
    ...new Set(
      (text.match(pattern) ?? []).filter(
        (t) => !NOT_RULES.has(t.slice(0, t.indexOf('-')).toLowerCase()),
      ),
    ),
  ].sort();

export function idTokens(text: string) {
  return tokens(text, ID_TOKEN);
}

/**
 * Тело ID правила для консолидации: составной ID в верхнем регистре
 * (`ORD-RET-01`, `FR-LOG-01`, `PRG-R09`, `CVE-2024-1234` — сегменты букв или
 * цифр, последний — до трёх прописных и номер) или ID-токен `ID_TOKEN`
 * (`REQ-12`, `ТР-4`, `req-1.2`); номер может нести строчную букву
 * (`REQ-3a`). Составные ID в нижнем регистре не распознаются: цепочки
 * `vue-router-4`, `node-fetch-2` в обычном тексте и коде неотличимы от них.
 */
const RULE_BODY =
  '\\p{Lu}{2,}(?:-[\\p{Lu}\\p{N}]+)*-\\p{Lu}{0,3}\\d+\\p{Ll}?(?:\\.\\d+)*|\\p{L}{2,}-\\d+\\p{Ll}?(?:\\.\\d+)*';
/** Граница ID: `REQ-3a` и `REQ-3b` — разные ID, а не два `REQ-3`. */
const BEFORE = '(?<![\\p{L}\\p{N}_-])';
const AFTER = '(?![\\p{L}\\p{N}_])';
const RULE_TOKEN = new RegExp(`${BEFORE}(?:${RULE_BODY})${AFTER}`, 'gu');
/** Несколько ID подряд: `REQ-1, REQ-2`, `REQ-3 и REQ-4`, `REQ-5/REQ-6`. */
const RULE_LIST = `(?:${RULE_BODY})${AFTER}(?:(?:\\s*[,/&]\\s*|\\s+(?:and|и)\\s+)(?:${RULE_BODY})${AFTER})*`;

/**
 * ID правил для консолидации: `idTokens` и составные ID. Консолидация не
 * должна незаметно уронить правило `ORD-RET-03`. Импорт Git sync и прочие
 * пользователи `idTokens` прежние: принятые записи не пересуживаются.
 */
export function ruleTokens(text: string) {
  return tokens(text, RULE_TOKEN);
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
const LABEL = new RegExp(`^(?:${RULE_BODY})${AFTER}`, 'u');

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

/** Разделитель после метки правила: `REQ-1.`, `REQ-1:`, `REQ-1 —`, `| REQ-1 |`, конец. */
const SEPARATOR = /^\s*(?:[.:|—–]|-\s|$)/u;
/**
 * ID, которыми начинается блок: список ID (`REQ-1, REQ-2:`) с разделителем
 * следом; в обёртке — `**REQ-15**`, `` `REQ-4` ``, `(REQ-10)`, `[REQ-11]` —
 * хватает пробела после неё.
 */
function leadIds(start: string) {
  const text = start.trim();
  const wrapped = /^(?:\*\*|__|`|\(|\[)/.test(text);
  const m = new RegExp(`^[(\\[]?(${RULE_LIST})([)\\]]?)(.*)$`, 'u').exec(text.replace(MARKUP, ''));
  if (!m) return [];
  const [, ids, closed, rest] = m;
  return SEPARATOR.test(rest) || closed || (wrapped && /^\s/.test(rest)) ? ruleTokens(ids) : [];
}

/**
 * ID, которые документ определяет сам, по месту в структуре, с силой
 * определения:
 *
 * - 3 — заголовок: метка в начале (`### ORD-04. …`) или после одного слова
 *   с разделителем (`## Rule REQ-6: …`);
 * - 2 — начало блока: абзаца, пункта списка (и задачи `- [ ]`), ячейки
 *   таблицы, цитаты или элемента HTML (`<li>`, `<td>`, `<p>`, `<dt>`), — ID
 *   или список ID с разделителем следом (`REQ-1. …`, `- REQ-1, REQ-2: …`,
 *   `| Orders | REQ-3: … |`, `| REQ-4 |`) или в обёртке (`**REQ-5** …`,
 *   `(REQ-6) …`, `[REQ-7] …`). Ячейка таблицы (Markdown или `<td>`) —
 *   запись строки: ID в её начале с разделителем или во всю ячейку называет
 *   правило строки, а ячейка-перечень вроде `REQ-5 (TC-01), REQ-6` —
 *   ссылки. Строка, которая связывает ID, правила не определяет: две ячейки
 *   начинаются с ID (матрица `| TC-01 | REQ-1 |`) или другая ячейка называет
 *   правило, определённое вне таблиц (журнал `| DEC-040 | REQ-1 changed |`);
 * - 1 — метка в тексте: ID с точкой и словом следом (`…: REQ-3. The listing`)
 *   или полужирная метка с разделителем (`**REQ-7**: …`).
 *
 * Остальные вхождения — ссылки: на ADR, сценарии тестов, правила других
 * документов или этого же («по ORD-05»). Определение в прозе («REQ-7
 * requires …» посреди абзаца) и в блоке кода не распознаётся: такой ID
 * остаётся в предпроверке (должен стоять в новом тексте) и приходит ревьюеру
 * в `references`, смысл которых он обязан сохранить и которые, если они
 * задают правило, отображает как правило.
 */
export function definitions(text: string) {
  const known = new Set(ruleTokens(text));
  const out = new Map<string, number>();
  const define = (ids: string[], strength: number) => {
    for (const id of ids) if (known.has(id) && (out.get(id) ?? 0) < strength) out.set(id, strength);
  };
  const inline = [
    new RegExp(`${BEFORE}(${RULE_LIST})[\`*_]*\\.[\`*_]*\\s+(?=\\p{L})`, 'gu'),
    new RegExp(`(?:\\*\\*|__)(${RULE_LIST})(?:\\*\\*|__)\\s*[:.—–]`, 'gu'),
    new RegExp(`(?:\\*\\*|__)(${RULE_LIST})[.:](?:\\*\\*|__)`, 'gu'),
  ];
  const rows: string[][] = [];
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
      const label = headingLabel(heading);
      if (label) define([label], 3);
      const plain = heading
        .replace(/\{#[^}]*\}\s*$/, '')
        .replace(MARKUP, '')
        .trim()
        .replace(SECTION_NUMBER, '');
      const named = new RegExp(`^\\p{L}+\\s+(${RULE_LIST})`, 'u').exec(plain);
      if (named && SEPARATOR.test(plain.slice(named[0].length))) define(ruleTokens(named[1]), 3);
      previous = '';
      continue;
    }
    // Начало блока: после пустой строки или заголовка, пункт списка (и
    // задача), ячейка таблицы, элемент HTML; маркеры цитаты не считаются.
    const bare = line.replace(/^\s*(?:>\s?)+/, '');
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(bare)?.[1];
    const starts: string[] = [];
    if (/^\s*\|/.test(bare))
      rows.push(
        bare
          .trim()
          .replace(/^\||\|$/g, '')
          .split(/(?<!\\)\|/),
      );
    else if (item !== undefined) starts.push(item);
    else if (!previous.trim()) starts.push(bare);
    // Элементы HTML: текст элемента до следующего тега; ячейки — запись строки.
    const cells = [...bare.matchAll(/<t[dh]\b[^>]*>([^<]*)/gi)].map((m) => m[1]);
    if (cells.length) rows.push(cells);
    for (const m of bare.matchAll(/<(?:li|p|dt|dd)\b[^>]*>([^<]*)/gi)) starts.push(m[1]);
    for (const start of starts) define(leadIds(start), 2);
    for (const pattern of inline)
      for (const m of line.matchAll(pattern)) define(ruleTokens(m[1]), 1);
    previous = bare;
  }
  // Строка таблицы, которая связывает ID, правила не определяет: две ячейки
  // начинаются с ID (матрица `| TC-01 | REQ-1 |`) или другая ячейка называет
  // правило, определённое вне таблиц (журнал `| DEC-040 | REQ-1 changed |`).
  const elsewhere = new Set(out.keys());
  for (const row of rows) {
    const ids = row.map(leadIds);
    if (ids.filter((x) => x.length).length > 1) continue;
    ids.forEach((own, i) => {
      if (!own.length) return;
      const others = ruleTokens(row.filter((_, j) => j !== i).join(' '));
      if (!others.some((id) => elsewhere.has(id))) define(own, 2);
    });
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
  /** Токенизатор ID: Git sync — `idTokens`, регистрация консолидации — `ruleTokens`. */
  ids: (text: string) => string[] = idTokens,
) {
  const kept = new Set(ids(next));
  const before = anchors(previous);
  const after = anchors(next);
  return {
    longer: next.length >= previous.length,
    lost: ids(previous).filter((id) => !kept.has(id)),
    broken: siblings.flatMap((c) =>
      referencedAnchors(c.content, file)
        .filter((a) => before.has(a) && !after.has(a))
        .map((a) => `${c.source ?? c.title}: #${a}`),
    ),
  };
}
