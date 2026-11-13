import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDestination } from 'devcontour-harness';
import { git } from './process.ts';
import { PAST_GUIDE_DIGESTS } from './guide-history.ts';

/**
 * Копии руководств DevContour в продукте (`docs/devcontour-*.md`).
 *
 * Setup кладёт их в репозиторий, потому что продуктовый AGENTS.md ссылается на
 * них по имени. Без обновления долгоживущий продукт читал бы руководства той
 * версии, с которой его ставили, и шёл бы устаревшими маршрутами.
 *
 * Каждая копия начинается с метки: digest текста, который записал инструмент.
 * Метка отличает три случая без отдельного манифеста и без локального
 * состояния — копия едет в Git вместе с меткой и одинаково читается в любом
 * clone:
 *  - текст совпадает с меткой и с текущей версией — копия актуальна;
 *  - текст совпадает с меткой, но не с текущей версией — копия устарела, её
 *    можно заменить: это ровно то, что когда-то записал инструмент;
 *  - текст не совпадает с меткой — копию правили в продукте, замена потеряла
 *    бы правку, и обновление её не трогает.
 * Копии прежних версий метки не имеют (`unmarked`): их происхождение не
 * доказать, и заменяются они только по явному флагу и только закоммиченные
 * без локальных изменений — прежний текст остаётся в истории Git.
 */

const devcontourRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Источник в DevContour → имя копии в `docs/` продукта. */
export const GUIDES: ReadonlyMap<string, string> = new Map([
  ['START.md', 'devcontour-start.md'],
  ['docs/workspaces.md', 'devcontour-workspaces.md'],
  ['docs/engineering-context.md', 'devcontour-engineering.md'],
  ['docs/project-integration.md', 'devcontour-integration.md'],
  ...[
    'team-sync',
    'requirements',
    'lead-workflow',
    'staged-workflow',
    'workspace-modes',
    'project-memory',
    'metrics',
    'experiments',
    'agent-evals',
    'intent',
    'product-map',
    'mcp-and-profiles',
  ].map((name) => ['docs/' + name + '.md', 'devcontour-' + name + '.md'] as [string, string]),
]);

const MARKER = /^<!-- devcontour-guide sha256:([0-9a-f]{64}) -->\n/;
export const guideDigest = (text: string) => createHash('sha256').update(text).digest('hex');
const digest = guideDigest;
/**
 * Концы строк не различаются: checkout с CRLF (autocrlf, eol=crlf) и
 * исходники DevContour, полученные так же, дают тот же digest, что и LF.
 */
const lf = (text: string) => text.replace(/\r\n/g, '\n');

/** Копия с меткой: первая строка — digest текста под ней. */
export const markGuide = (body: string) =>
  `<!-- devcontour-guide sha256:${digest(body)} -->\n` + body;

/** Метка и текст под ней; без метки — `undefined`. */
export function guideMarker(text: string): { digest: string; body: string } | undefined {
  const normalized = lf(text);
  const match = MARKER.exec(normalized);
  return match ? { digest: match[1], body: normalized.slice(match[0].length) } : undefined;
}

/**
 * Тексты копий по источникам: ссылки на другие перенесённые руководства ведут
 * на их копии, остальные становятся указанием на справочник DevContour.
 * `read` — источник по пути относительно корня DevContour; генератор истории
 * (`scripts/guide-history.ts`) передаёт чтение из прежних релизов.
 */
export async function renderGuideBodies(
  read: (source: string) => Promise<string | undefined> = (source) =>
    readFile(join(devcontourRoot, source), 'utf8'),
): Promise<Map<string, string>> {
  const bodies = new Map<string, string>();
  for (const [source, destination] of GUIDES) {
    const text = await read(source);
    if (text === undefined) continue;
    bodies.set(
      destination,
      lf(text).replace(
        /\[([^\]]+)\]\(([^)]+\.(?:md|json)(?:#[^)]*)?)\)/g,
        (match, label, target: string) => {
          if (/^(https?:|#)/.test(target)) return match;
          const [file, anchor] = target.split('#');
          const sourceRelative = relative(
            devcontourRoot,
            resolve(devcontourRoot, dirname(source), file),
          );
          const installed = GUIDES.get(sourceRelative);
          return installed
            ? '[' + label + '](' + installed + (anchor ? '#' + anchor : '') + ')'
            : label +
                ' (справочник DevContour: ' +
                sourceRelative +
                (anchor ? '#' + anchor : '') +
                ')';
        },
      ),
    );
  }
  return bodies;
}

/** Копии этой версии: имя в `docs/` → полный текст с меткой. */
export async function guideCopies(): Promise<Map<string, string>> {
  const copies = new Map<string, string>();
  for (const [name, body] of await renderGuideBodies()) copies.set(name, markGuide(body));
  return copies;
}

export type GuideState =
  /** Совпадает с текущей версией. */
  | 'current'
  /** Записана инструментом (эта метка или текст прошлого релиза) и не правилась. */
  | 'stale'
  /** Метка есть, текст под ней изменён в продукте. */
  | 'edited'
  /** Копия без метки, текст не совпадает ни с одним релизом. */
  | 'unmarked'
  /** Копии нет. */
  | 'missing'
  /** Копия с меткой, которую эта версия больше не поставляет. */
  | 'retired'
  /**
   * Не обычный файл: symlink, жёсткая ссылка, каталог или путь через symlink.
   * Инструмент через ссылки не читает и не пишет — запись ушла бы за
   * пределы репозитория или в чужой файл.
   */
  | 'not-a-file';

export interface GuideEntry {
  /** Путь относительно репозитория: `docs/devcontour-*.md`. */
  path: string;
  state: GuideState;
}

type Probe = { kind: 'absent' } | { kind: 'file'; text: string } | { kind: 'unsafe' };

/** Путь копии: отсутствует, обычный файл (с текстом) или небезопасен. */
async function probe(root: string, path: string): Promise<Probe> {
  const target = join(root, path);
  try {
    await checkDestination(target, { root });
  } catch {
    return { kind: 'unsafe' };
  }
  let stats;
  try {
    stats = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    throw error;
  }
  if (!stats.isFile() || stats.nlink > 1) return { kind: 'unsafe' };
  return { kind: 'file', text: await readFile(target, 'utf8') };
}

/** Есть ли что-то по пути (без следования по ссылке в конце). */
async function present(path: string) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function stateOf(found: Probe, name: string, expected: string): GuideState {
  if (found.kind === 'absent') return 'missing';
  if (found.kind === 'unsafe') return 'not-a-file';
  const text = lf(found.text);
  if (text === expected) return 'current';
  const marker = guideMarker(text);
  if (marker) return digest(marker.body) === marker.digest ? 'stale' : 'edited';
  // Копия без метки — из релиза до меток: совпадение с текстом какого-либо
  // релиза (или текущим) доказывает, что её не правили.
  const known = PAST_GUIDE_DIGESTS[name] ?? [];
  return text === guideMarker(expected)!.body || known.includes(digest(text))
    ? 'stale'
    : 'unmarked';
}

/**
 * Состояние копий в репозитории. Пустой список — копий нет вовсе (setup в
 * этот репозиторий их не клал или их убрали): отсутствие всех руководств не
 * расхождение, и обновление такой репозиторий не трогает.
 */
export async function guideDrift(repository: string): Promise<GuideEntry[]> {
  const root = await realpath(repository);
  const copies = await guideCopies();
  const entries: GuideEntry[] = [];
  let exists = false;
  for (const [name, expected] of copies) {
    const path = 'docs/' + name;
    const found = await probe(root, path);
    if (found.kind === 'file' || (found.kind === 'unsafe' && (await present(join(root, path)))))
      exists = true;
    entries.push({ path, state: stateOf(found, name, expected) });
  }
  // Лишние — только копии с меткой: прочие `docs/devcontour-*.md` (заметки
  // прогресса и т. п.) инструменту не принадлежат.
  let names: string[] = [];
  try {
    names = await readdir(join(root, 'docs'));
  } catch {
    /* Нет docs — нет и копий. */
  }
  for (const name of names.sort())
    if (/^devcontour-.*\.md$/.test(name) && !copies.has(name)) {
      const found = await probe(root, 'docs/' + name);
      if (found.kind === 'file' && guideMarker(found.text)) {
        exists = true;
        entries.push({ path: 'docs/' + name, state: 'retired' });
      }
    }
  return exists ? entries : [];
}

/** Расхождение копий одной строкой с командой исправления; без расхождения — `undefined`. */
export function guideDriftText(entries: GuideEntry[], target = '--workspace <W>') {
  const by = (state: GuideState) => entries.filter((e) => e.state === state).map((e) => e.path);
  const parts: string[] = [];
  const named = (label: string, paths: string[]) =>
    paths.length && parts.push(`${label}: ${paths.join(', ')}`);
  named('устарели', by('stale'));
  named('отсутствуют', by('missing'));
  named('копии без метки, не совпадающие ни с одним релизом', by('unmarked'));
  named('изменены в продукте', by('edited'));
  named('больше не поставляются', by('retired'));
  named('не обычные файлы (symlink или жёсткая ссылка)', by('not-a-file'));
  if (!parts.length) return undefined;
  const fixes: string[] = [];
  if (by('stale').length || by('missing').length)
    fixes.push(`обновите: devcontour guides-refresh ${target}`);
  if (by('unmarked').length)
    fixes.push(
      `копии без метки заменяются только явно: devcontour guides-refresh --replace-unmarked ${target} (файл должен быть закоммичен без локальных правок; правки продукта в нём будут заменены — прежний текст останется в Git)`,
    );
  if (by('edited').length)
    fixes.push(
      'изменённые копии обновление не трогает: перенесите правку в собственный документ, удалите копию и повторите guides-refresh',
    );
  if (by('retired').length) fixes.push('снятые копии удалите вручную, проверив ссылки AGENTS.md');
  if (by('not-a-file').length)
    fixes.push(
      'ссылки инструмент не читает и не пишет: замените их обычными файлами или удалите и повторите guides-refresh',
    );
  return `Копии руководств DevContour расходятся с установленной версией — ${parts.join('; ')}. Исправление: ${fixes.join('; ')}.`;
}

async function committedUnchanged(repository: string, path: string) {
  try {
    await git(repository, 'ls-files', '--error-unmatch', '--', path);
    return !(await git(repository, 'status', '--porcelain', '--', path)).trim();
  } catch {
    return false;
  }
}

/**
 * Записать копию: путь и предки проверяются заново (не symlink, внутри
 * репозитория), текст ложится во временный файл рядом и переносится rename —
 * оборванная запись не оставляет половину копии.
 */
async function writeCopy(root: string, path: string, content: string) {
  const target = join(root, path);
  const found = await probe(root, path);
  if (found.kind === 'unsafe') throw new Error('Путь копии стал небезопасным: ' + path);
  await mkdir(dirname(target), { recursive: true });
  await checkDestination(target, { root });
  const temp = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  await writeFile(temp, content, { flag: 'wx' });
  try {
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export interface GuideRefresh {
  repository: string;
  /** Копий в репозитории нет: обновление его не трогает. */
  skipped?: 'no-copies';
  written: string[];
  /** Заменённые по `--replace-unmarked`: правки продукта в них видны в git diff. */
  replacedUnmarked: string[];
  kept: { path: string; state: GuideState; reason: string }[];
}

const keptReason: Partial<Record<GuideState, string>> = {
  edited:
    'копию правили в продукте; перенесите правку в собственный документ, удалите копию и повторите',
  retired: 'эта версия руководство не поставляет; удалите вручную, проверив ссылки AGENTS.md',
  'not-a-file':
    'не обычный файл (symlink, жёсткая ссылка или путь через symlink); замените обычным файлом или удалите и повторите',
};

/**
 * Обновить копии в рабочем дереве репозитория, где они уже есть. Пишутся
 * только файлы набора этой версии в состояниях `stale` и `missing` (и
 * `unmarked` по явному флагу, если файл закоммичен без локальных изменений).
 * Изменённые, снятые и не обычные файлы остаются как есть и называются в
 * ответе. Ничего не коммитится.
 */
export async function refreshGuides(
  repository: string,
  options: { replaceUnmarked?: boolean } = {},
): Promise<GuideRefresh> {
  const root = await realpath(repository);
  const copies = await guideCopies();
  const entries = await guideDrift(root);
  const result: GuideRefresh = { repository, written: [], replacedUnmarked: [], kept: [] };
  if (!entries.length) return { ...result, skipped: 'no-copies' };
  for (const entry of entries) {
    if (entry.state === 'current') continue;
    const unmarked =
      entry.state === 'unmarked' &&
      !!options.replaceUnmarked &&
      (await committedUnchanged(root, entry.path));
    if (entry.state === 'stale' || entry.state === 'missing' || unmarked) {
      await writeCopy(root, entry.path, copies.get(entry.path.slice('docs/'.length))!);
      result.written.push(entry.path);
      if (unmarked) result.replacedUnmarked.push(entry.path);
    } else
      result.kept.push({
        ...entry,
        reason:
          keptReason[entry.state] ??
          (options.replaceUnmarked
            ? 'копия без метки не закоммичена или имеет локальные изменения; закоммитьте или отмените их и повторите'
            : 'копия без метки не совпадает ни с одним релизом; замените явно: --replace-unmarked'),
      });
  }
  return result;
}
