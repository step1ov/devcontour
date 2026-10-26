import { execFile } from 'node:child_process';
import { posix } from 'node:path';
import { promisify } from 'node:util';
import { DomainError } from '../core/model.ts';
import { withinPaths } from '../core/workflow.ts';
import { streamBlob } from './contract-artifacts.ts';

/**
 * Локальные зависимости закреплённых артефактов.
 *
 * Закреплённый приёмочный тест может импортировать соседний helper или
 * эталонные данные. Если их не закрепили и не защитили, исполнитель ослабил
 * бы приёмку правкой helper: ни один закреплённый файл не изменился, digest
 * контракта прежний, ревью не повторяется. Здесь вычисляется статическое
 * замыкание зависимостей внутри репозитория компонента — по закоммиченной
 * ревизии, той же, из которой закреплены артефакты.
 *
 * Разбор — собственный лексер, а не регулярные выражения по тексту:
 * комментарии, строки, шаблоны и regex-литералы пропускаются, и `import` в
 * строке или комментарии не считается зависимостью. TypeScript в DevContour
 * — только инструмент разработки и в установленном пакете отсутствует.
 */
export interface ClosureLimits {
  /** Сколько файлов замыкания допустимо (разобранных и найденных). */
  maxFiles: number;
  /** Сколько байт исходников разбирается за одно замыкание. */
  maxBytes: number;
}
export const defaultClosureLimits: ClosureLimits = {
  maxFiles: 2000,
  maxBytes: 32 * 1024 * 1024,
};

/** Файлы, которые разбираются как JavaScript/TypeScript. */
const SOURCE = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
/** Порядок разрешения спецификатора без расширения. */
const RESOLVE = [...SOURCE, '.json'];
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};
export const isSource = (path: string) => SOURCE.includes(posix.extname(path));

export type SpecifierKind = 'static' | 'dynamic' | 'require' | 'url' | 'resolve';
export interface Specifier {
  specifier: string;
  kind: SpecifierKind;
}

type Token = { type: 'id' | 'str' | 'punct' | 'num' | 'regex'; value: string };
/** После этих слов `/` начинает regex-литерал, а не деление. */
const REGEX_AFTER = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);
const idStart = (c: string) => /[A-Za-z_$\u0080-￿]/.test(c);
const idPart = (c: string) => /[\w$\u0080-￿]/.test(c);

/**
 * Токены исходника. Шаблон без подстановок — строка; шаблон с подстановками
 * разбирается внутри `${...}`, а его литеральные части пропускаются.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  // Стек фигурных скобок: true — скобка открывает подстановку шаблона.
  const braces: boolean[] = [];
  let i = 0;
  const n = source.length;
  const regexAllowed = () => {
    const last = tokens.at(-1);
    if (!last) return true;
    if (last.type === 'num' || last.type === 'str' || last.type === 'regex') return false;
    if (last.type === 'id') return REGEX_AFTER.has(last.value);
    return ![')', ']', '}'].includes(last.value);
  };
  /** Литеральная часть шаблона до `` ` `` или `${`; возвращает текст и признак подстановки. */
  const templatePart = () => {
    let text = '';
    while (i < n) {
      const c = source[i];
      if (c === '\\') {
        text += source.slice(i, i + 2);
        i += 2;
      } else if (c === '`') {
        i++;
        return { text, open: false };
      } else if (c === '$' && source[i + 1] === '{') {
        i += 2;
        return { text, open: true };
      } else {
        text += c;
        i++;
      }
    }
    return { text, open: false };
  };
  while (i < n) {
    const c = source[i];
    if (c === '\n' || c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
      i++;
    } else if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++;
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === '"' || c === "'") {
      let value = '';
      i++;
      while (i < n && source[i] !== c && source[i] !== '\n') {
        if (source[i] === '\\') {
          value += source[i + 1] ?? '';
          i += 2;
        } else value += source[i++];
      }
      i++;
      tokens.push({ type: 'str', value });
    } else if (c === '`') {
      i++;
      const part = templatePart();
      if (part.open) {
        braces.push(true);
        tokens.push({ type: 'punct', value: '`${' });
      } else tokens.push({ type: 'str', value: part.text });
    } else if (c === '{') {
      braces.push(false);
      tokens.push({ type: 'punct', value: c });
      i++;
    } else if (c === '}') {
      i++;
      if (braces.pop()) {
        // Конец подстановки: продолжается литеральная часть шаблона.
        const part = templatePart();
        if (part.open) braces.push(true);
        tokens.push({ type: 'punct', value: part.open ? '}${' : '}`' });
      } else tokens.push({ type: 'punct', value: '}' });
    } else if (c === '/' && regexAllowed()) {
      // Regex-литерал: до закрывающего `/` вне класса символов.
      let inClass = false;
      i++;
      while (i < n && source[i] !== '\n') {
        const d = source[i];
        if (d === '\\') i += 2;
        else {
          i++;
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) break;
        }
      }
      while (i < n && idPart(source[i])) i++;
      tokens.push({ type: 'regex', value: '' });
    } else if (idStart(c)) {
      const start = i;
      while (i < n && idPart(source[i])) i++;
      tokens.push({ type: 'id', value: source.slice(start, i) });
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      while (i < n && /[\w.]/.test(source[i])) i++;
      tokens.push({ type: 'num', value: '' });
    } else {
      tokens.push({ type: 'punct', value: c });
      i++;
    }
  }
  return tokens;
}

/**
 * Литеральные спецификаторы модулей и файлов: `import … from`, `export … from`,
 * `import 'x'`, `import('x')`, `require('x')`, `import.meta.resolve('x')` и
 * `new URL('x', import.meta.url)`. Вычисляемый спецификатор статически не
 * известен и не возвращается.
 */
export function moduleSpecifiers(source: string): Specifier[] {
  const t = tokenize(source);
  const out: Specifier[] = [];
  const is = (k: number, value: string) => t[k]?.value === value && t[k].type !== 'str';
  const str = (k: number) => (t[k]?.type === 'str' ? t[k].value : undefined);
  // Обращение к свойству (`x.import`, `x.require`) — не синтаксис модуля.
  const member = (k: number) => is(k - 1, '.') && !is(k - 2, '.');
  for (let k = 0; k < t.length; k++) {
    const tok = t[k];
    if (tok.type !== 'id' || member(k)) continue;
    if (tok.value === 'import') {
      if (str(k + 1) !== undefined) out.push({ specifier: str(k + 1)!, kind: 'static' });
      else if (is(k + 1, '(') && str(k + 2) !== undefined && (is(k + 3, ')') || is(k + 3, ',')))
        out.push({ specifier: str(k + 2)!, kind: 'dynamic' });
      else if (
        is(k + 1, '.') &&
        is(k + 2, 'meta') &&
        is(k + 3, '.') &&
        is(k + 4, 'resolve') &&
        is(k + 5, '(') &&
        str(k + 6) !== undefined
      )
        out.push({ specifier: str(k + 6)!, kind: 'resolve' });
    } else if (tok.value === 'from' && str(k + 1) !== undefined) {
      // `from` со строкой сразу за ним бывает только в import/export.
      out.push({ specifier: str(k + 1)!, kind: 'static' });
    } else if (
      tok.value === 'require' &&
      is(k + 1, '(') &&
      str(k + 2) !== undefined &&
      is(k + 3, ')')
    ) {
      out.push({ specifier: str(k + 2)!, kind: 'require' });
    } else if (
      tok.value === 'URL' &&
      is(k - 1, 'new') &&
      is(k + 1, '(') &&
      str(k + 2) !== undefined &&
      is(k + 3, ',') &&
      is(k + 4, 'import') &&
      is(k + 5, '.') &&
      is(k + 6, 'meta') &&
      is(k + 7, '.') &&
      is(k + 8, 'url')
    ) {
      out.push({ specifier: str(k + 2)!, kind: 'url' });
    }
  }
  return out;
}

const run = promisify(execFile);
type Entry = { mode: string; type: string; blob: string; size: number };
/** Дерево ревизии: путь → запись. Один вызов Git на замыкание. */
async function treeOf(repoPath: string, revision: string) {
  const { stdout } = await run('git', ['ls-tree', '-r', '-l', '-z', '--full-tree', revision], {
    cwd: repoPath,
    maxBuffer: 512 * 1024 * 1024,
    encoding: 'utf8',
  });
  const tree = new Map<string, Entry>();
  for (const line of stdout.split('\0')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    const [mode, type, blob, size] = line.slice(0, tab).split(/\s+/);
    tree.set(line.slice(tab + 1), { mode, type, blob, size: Number(size) || 0 });
  }
  return tree;
}

export interface Dependency {
  /** Путь в репозитории (POSIX, от корня компонента). */
  path: string;
  /** Файл, который на него ссылается. */
  from: string;
  /** Как записана ссылка. */
  specifier: string;
  /** Файла нет в ревизии: исполнитель мог бы его создать. */
  missing?: true;
}

/**
 * Статическое замыкание локальных зависимостей артефактов на ревизии.
 * Обход идёт транзитивно по JS/TS-файлам, включая закреплённые и защищённые
 * (их собственные импорты тоже часть приёмки), и не заходит в `stop` —
 * объявленную реализацию под тестом. Пакетные спецификаторы (`zod`,
 * `node:fs`) не учитываются. Выход из репозитория, symlink и submodule —
 * отказ, как у самих артефактов; превышение пределов — отказ, а не
 * молчаливо неполное замыкание.
 */
export async function artifactClosure(
  repoPath: string,
  revision: string,
  roots: string[],
  stop: string[] = [],
  limits: ClosureLimits = defaultClosureLimits,
) {
  const tree = await treeOf(repoPath, revision);
  const found = new Map<string, Dependency>();
  const queue = roots.filter(isSource);
  const parsed = new Set<string>(queue);
  let bytes = 0;
  const overflow = (what: string) =>
    new DomainError(
      `Замыкание зависимостей артефактов больше предела ${what}: оно не проверено полностью. Объявите реализацию под тестом в underTest или сократите закреплённые файлы`,
      400,
    );
  const fileAt = (path: string, from: string, specifier: string) => {
    const e = tree.get(path);
    if (!e) return undefined;
    if (e.mode === '120000')
      throw new DomainError(
        `Зависимость артефакта — symlink: ${path} (из ${from}: ${specifier})`,
        400,
      );
    if (e.type !== 'blob')
      throw new DomainError(
        `Зависимость артефакта не файл: ${path} (из ${from}: ${specifier})`,
        400,
      );
    return e;
  };
  /** Разрешение как у Node и TypeScript: точный путь, .js→.ts, расширения, index. */
  const resolveIn = (target: string, from: string, specifier: string, exact: boolean) => {
    const candidates = [target];
    if (!exact) {
      const ext = posix.extname(target);
      for (const alt of JS_TO_TS[ext] ?? []) candidates.push(target.slice(0, -ext.length) + alt);
      for (const ext of RESOLVE) candidates.push(target + ext);
      for (const ext of RESOLVE) candidates.push(posix.join(target, 'index' + ext));
    }
    for (const c of candidates) if (fileAt(c, from, specifier)) return c;
    return undefined;
  };
  while (queue.length) {
    const file = queue.shift()!;
    const entry = fileAt(file, file, file);
    if (!entry) continue;
    bytes += entry.size;
    if (bytes > limits.maxBytes) throw overflow(`${limits.maxBytes} байт`);
    const read = await streamBlob(repoPath, entry.blob, entry.size);
    for (const { specifier, kind } of moduleSpecifiers(read.head.toString('utf8'))) {
      const clean = specifier.replace(/[?#].*$/, '');
      // `new URL('x', import.meta.url)` — относительный URL файла без схемы.
      const relative =
        clean.startsWith('./') ||
        clean.startsWith('../') ||
        clean === '.' ||
        clean === '..' ||
        (kind === 'url' && !/^[a-z][a-z0-9+.-]*:/i.test(clean) && !clean.startsWith('/'));
      if (clean.startsWith('/') || clean.startsWith('file:'))
        throw new DomainError(
          `Зависимость артефакта вне репозитория: ${specifier} (из ${file})`,
          400,
        );
      if (!relative || !clean) continue;
      const target = posix.normalize(posix.join(posix.dirname(file), clean));
      if (target === '..' || target.startsWith('../') || target === '.')
        throw new DomainError(
          `Зависимость артефакта вне репозитория: ${specifier} (из ${file})`,
          400,
        );
      if (withinPaths(target, stop)) continue;
      const path = resolveIn(target, file, specifier, kind === 'url');
      if (path && withinPaths(path, stop)) continue;
      const key = path ?? target;
      if (!found.has(key))
        found.set(key, { path: key, from: file, specifier, ...(path ? {} : { missing: true }) });
      if (found.size > limits.maxFiles) throw overflow(`${limits.maxFiles} файлов`);
      if (path && isSource(path) && !parsed.has(path)) {
        parsed.add(path);
        queue.push(path);
      }
    }
  }
  return [...found.values()];
}

/**
 * Зависимости, которые не закреплены артефактами и не защищены: их правка
 * изменила бы приёмку без нового ревью. Защита — protectedPaths и
 * generatedPaths компонента: обе граница кандидата отклоняет.
 */
export async function unguardedDependencies(
  repo: { path: string; protectedPaths: string[]; generatedPaths?: string[] },
  revision: string,
  pinned: string[],
  underTest: string[] = [],
  limits?: ClosureLimits,
) {
  const covered = [...repo.protectedPaths, ...(repo.generatedPaths ?? [])];
  const closure = await artifactClosure(repo.path, revision, pinned, underTest, limits);
  return closure.filter((d) => !pinned.includes(d.path) && !withinPaths(d.path, covered));
}

/** Объявленная реализация под тестом не накрывает закреплённый артефакт. */
export function assertUnderTest(pinned: string[], underTest: string[]) {
  const overlap = pinned.filter((p) => withinPaths(p, underTest));
  if (overlap.length)
    throw new DomainError(
      'underTest накрывает закреплённые артефакты — норматив не может быть реализацией под тестом: ' +
        overlap.join(', '),
      400,
    );
}

export const describeUnguarded = (deps: Dependency[]) =>
  deps.map((d) => `${d.path} (из ${d.from}${d.missing ? '; файла нет в Git' : ''})`).join(', ');

/** Текст отказа и предупреждения: какие файлы и два способа это исправить. */
export const unguardedMessage = (deps: Dependency[]) =>
  `Закреплённые артефакты импортируют файлы, которые не закреплены и не защищены: ${describeUnguarded(deps)}. Исполнитель мог бы ослабить приёмку правкой этих файлов без нового ревью. Добавьте их в artifacts контракта или в protectedPaths компонента; реализацию, которую приёмка проверяет, объявите в underTest`;
