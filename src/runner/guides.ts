import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from './process.ts';

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
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/** Копия с меткой: первая строка — digest текста под ней. */
export const markGuide = (body: string) =>
  `<!-- devcontour-guide sha256:${digest(body)} -->\n` + body;

/** Метка и текст под ней; без метки — `undefined`. */
export function guideMarker(text: string): { digest: string; body: string } | undefined {
  const match = MARKER.exec(text);
  return match ? { digest: match[1], body: text.slice(match[0].length) } : undefined;
}

/**
 * Текст копии по источнику: ссылки на другие перенесённые руководства ведут на
 * их копии, остальные становятся указанием на справочник DevContour.
 */
async function guideBody(source: string) {
  const text = await readFile(join(devcontourRoot, source), 'utf8');
  return text.replace(
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
        : label + ' (справочник DevContour: ' + sourceRelative + (anchor ? '#' + anchor : '') + ')';
    },
  );
}

/** Копии этой версии: имя в `docs/` → полный текст с меткой. */
export async function guideCopies(): Promise<Map<string, string>> {
  const copies = new Map<string, string>();
  for (const [source, destination] of GUIDES)
    copies.set(destination, markGuide(await guideBody(source)));
  return copies;
}

export type GuideState =
  /** Совпадает с текущей версией. */
  | 'current'
  /** Записана инструментом прежней версии и не правилась. */
  | 'stale'
  /** Метка есть, текст под ней изменён в продукте. */
  | 'edited'
  /** Копия прежней версии без метки, текст отличается от текущего. */
  | 'unmarked'
  /** Копии нет. */
  | 'missing'
  /** Копия с меткой, которую эта версия больше не поставляет. */
  | 'retired';

export interface GuideEntry {
  /** Путь относительно репозитория: `docs/devcontour-*.md`. */
  path: string;
  state: GuideState;
}

async function readText(path: string) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function stateOf(text: string | undefined, expected: string): GuideState {
  if (text === undefined) return 'missing';
  if (text === expected) return 'current';
  const marker = guideMarker(text);
  if (!marker)
    // Копия прежней версии без метки, текст которой совпадает с текущим:
    // замена добавит только метку.
    return text === guideMarker(expected)!.body ? 'stale' : 'unmarked';
  return digest(marker.body) === marker.digest ? 'stale' : 'edited';
}

/**
 * Состояние копий в репозитории. Пустой список — копий нет вовсе (setup в
 * этот репозиторий их не клал): отсутствие всех руководств не расхождение.
 */
export async function guideDrift(repository: string): Promise<GuideEntry[]> {
  const copies = await guideCopies();
  const entries: GuideEntry[] = [];
  for (const [name, expected] of copies)
    entries.push({
      path: 'docs/' + name,
      state: stateOf(await readText(join(repository, 'docs', name)), expected),
    });
  // Лишние — только копии с меткой: прочие `docs/devcontour-*.md` (заметки
  // прогресса и т. п.) инструменту не принадлежат.
  let names: string[] = [];
  try {
    names = await readdir(join(repository, 'docs'));
  } catch {
    /* Нет docs — нет и копий. */
  }
  for (const name of names.sort())
    if (/^devcontour-.*\.md$/.test(name) && !copies.has(name)) {
      const text = await readText(join(repository, 'docs', name));
      if (text !== undefined && guideMarker(text))
        entries.push({ path: 'docs/' + name, state: 'retired' });
    }
  return entries.every((e) => e.state === 'missing') ? [] : entries;
}

/** Расхождение копий одной строкой с командой исправления; без расхождения — `undefined`. */
export function guideDriftText(entries: GuideEntry[], workspaceHint = '--workspace <W>') {
  const by = (state: GuideState) => entries.filter((e) => e.state === state).map((e) => e.path);
  const parts: string[] = [];
  const named = (label: string, paths: string[]) =>
    paths.length && parts.push(`${label}: ${paths.join(', ')}`);
  named('устарели', by('stale'));
  named('отсутствуют', by('missing'));
  named('копии прежней версии без метки', by('unmarked'));
  named('изменены в продукте', by('edited'));
  named('больше не поставляются', by('retired'));
  if (!parts.length) return undefined;
  const fixes: string[] = [];
  if (by('stale').length || by('missing').length)
    fixes.push(`обновите: devcontour guides-refresh ${workspaceHint}`);
  if (by('unmarked').length)
    fixes.push(
      `копии без метки заменяются только явно: devcontour guides-refresh --replace-unmarked ${workspaceHint} (файл должен быть закоммичен без локальных правок — прежний текст останется в Git)`,
    );
  if (by('edited').length)
    fixes.push(
      'изменённые копии обновление не трогает: перенесите правку в собственный документ, удалите копию и повторите guides-refresh',
    );
  if (by('retired').length) fixes.push('снятые копии удалите вручную, проверив ссылки AGENTS.md');
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
 * Обновить копии в рабочем дереве репозитория. Пишутся только файлы набора
 * этой версии в состояниях `stale` и `missing` (и `unmarked` по явному флагу,
 * если файл закоммичен без локальных изменений). Изменённые в продукте и
 * снятые копии остаются как есть и называются в ответе. Ничего не коммитится.
 */
export async function refreshGuides(
  repository: string,
  options: { replaceUnmarked?: boolean } = {},
) {
  const copies = await guideCopies();
  const entries = await guideDrift(repository);
  const written: string[] = [];
  const kept: { path: string; state: GuideState; reason: string }[] = [];
  for (const entry of entries.length
    ? entries
    : [...copies.keys()].map((name) => ({ path: 'docs/' + name, state: 'missing' as const }))) {
    const replace =
      entry.state === 'stale' ||
      entry.state === 'missing' ||
      (entry.state === 'unmarked' &&
        options.replaceUnmarked &&
        (await committedUnchanged(repository, entry.path)));
    if (replace) {
      const target = join(repository, entry.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, copies.get(entry.path.slice('docs/'.length))!);
      written.push(entry.path);
    } else if (entry.state !== 'current')
      kept.push({
        ...entry,
        reason:
          entry.state === 'edited'
            ? 'копию правили в продукте; перенесите правку в собственный документ, удалите копию и повторите'
            : entry.state === 'retired'
              ? 'эта версия руководство не поставляет; удалите вручную, проверив ссылки AGENTS.md'
              : options.replaceUnmarked
                ? 'копия без метки не закоммичена или имеет локальные изменения; закоммитьте или отмените их и повторите'
                : 'копия прежней версии без метки; замените явно: --replace-unmarked',
      });
  }
  return { repository, written, kept };
}
