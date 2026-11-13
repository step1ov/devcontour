import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  guideCopies,
  guideDigest,
  guideDrift,
  guideMarker,
  markGuide,
  refreshGuides,
  renderGuideBodies,
} from '../src/runner/guides.ts';
import { PAST_GUIDE_DIGESTS } from '../src/runner/guide-history.ts';
import { doctor, doctorReady, guideChecks, guideRepositories } from '../src/runner/doctor.ts';
import { setupProject } from '../src/runner/setup.ts';
import { loadConfig } from '../src/runner/config.ts';
import { emptyState, type Config } from '../src/core/model.ts';
import { command, git } from '../src/runner/process.ts';

const START = 'docs/devcontour-start.md';
const INTENT = 'docs/devcontour-intent.md';
const MEMORY = 'docs/devcontour-project-memory.md';
const METRICS = 'docs/devcontour-metrics.md';
const TEAM = 'docs/devcontour-team-sync.md';
const MAP = 'docs/devcontour-product-map.md';
const OLD = '# Прежняя версия руководства\n';

const temps: string[] = [];
async function temp(prefix: string) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}
test.after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

/** Репозиторий с полным набором актуальных копий, закоммиченных в Git. */
async function installed() {
  const root = await temp('devcontour-guides-');
  await mkdir(join(root, 'docs'));
  for (const [name, content] of await guideCopies())
    await writeFile(join(root, 'docs', name), content);
  // Заметки прогресса — тоже `docs/devcontour-*.md`, но не копия руководства.
  await writeFile(join(root, 'docs/devcontour-progress.md'), '# Прогресс\n');
  await git(root, 'init', '-q');
  await git(root, 'add', '.');
  await git(root, 'commit', '-q', '-m', 'bootstrap');
  return root;
}

const read = (root: string, path: string) => readFile(join(root, path), 'utf8');
const stateOf = (entries: { path: string; state: string }[], path: string) =>
  entries.find((e) => e.path === path)?.state;
const minimal = (repository: string, extra: Record<string, unknown> = {}) =>
  ({ repository, repositories: [], generatedPaths: [], ...extra }) as unknown as Config;

test('Guide copies carry a digest marker and rewrite links between installed guides', async () => {
  const copies = await guideCopies();
  assert.equal(copies.size, 16);
  for (const content of copies.values()) {
    const marker = guideMarker(content);
    assert.ok(marker);
    assert.equal(markGuide(marker.body), content);
  }
  assert.equal(guideMarker('# без метки\n'), undefined);
  const start = copies.get('devcontour-start.md')!;
  // Ссылка на перенесённое руководство ведёт на его копию рядом.
  assert.match(start, /\]\(devcontour-workspace-modes\.md\)/);
  assert.match(start, /\]\(devcontour-integration\.md\)/);
  assert.doesNotMatch(start, /\]\(docs\/workspace-modes\.md\)/);
  // Ссылка на неперенесённый документ становится указанием на справочник.
  assert.match(start, /\(справочник DevContour: docs\/start-examples\.md\)/);
});

test('Doctor names stale, edited, unmarked, missing and retired guide copies with a fix command', async () => {
  const root = await installed();
  const empty = await temp('devcontour-guides-none-');
  const config = minimal(root, { workspaceRoot: '/w' });
  // Свежая установка: всё совпадает.
  assert.ok((await guideDrift(root)).every((e) => e.state === 'current'));
  assert.deepEqual(
    (await guideChecks(config, '/d')).map((c) => [c.id, c.status]),
    [['guides:main', 'passed']],
  );
  // Репозиторий без копий вовсе не сверяется.
  assert.deepEqual(await guideDrift(empty), []);
  assert.deepEqual(await guideChecks(minimal(empty), '/d'), []);

  const current = (await guideCopies()).get('devcontour-intent.md')!;
  await writeFile(join(root, START), markGuide(OLD));
  await writeFile(join(root, INTENT), current + '\nСвоя правка продукта.\n');
  await writeFile(join(root, MEMORY), '# Копия прежней версии без метки\n');
  await unlink(join(root, METRICS));
  await writeFile(join(root, 'docs/devcontour-retired.md'), markGuide('# Снятое\n'));
  // Копия без метки, текст которой совпадает с текущим, — просто устаревшая.
  await writeFile(
    join(root, TEAM),
    guideMarker((await guideCopies()).get('devcontour-team-sync.md')!)!.body,
  );

  const drift = await guideDrift(root);
  assert.equal(stateOf(drift, START), 'stale');
  assert.equal(stateOf(drift, INTENT), 'edited');
  assert.equal(stateOf(drift, MEMORY), 'unmarked');
  assert.equal(stateOf(drift, METRICS), 'missing');
  assert.equal(stateOf(drift, TEAM), 'stale');
  assert.equal(stateOf(drift, 'docs/devcontour-retired.md'), 'retired');
  assert.equal(stateOf(drift, 'docs/devcontour-progress.md'), undefined);

  const [check] = await guideChecks(config, '/d');
  assert.equal(check?.status, 'degraded');
  assert.equal(check.id, 'guides:main');
  for (const path of [START, INTENT, MEMORY, METRICS, TEAM, 'docs/devcontour-retired.md'])
    assert.match(check.detail, new RegExp(path));
  assert.match(check.detail, /devcontour guides-refresh --workspace \/w/);
  assert.match(check.detail, /--replace-unmarked/);
  assert.doesNotMatch(check.detail, /devcontour-progress/);
  // Прежняя конфигурация без workspace: подсказка называет --data.
  const [legacy] = await guideChecks(minimal(root), '/legacy-data');
  assert.match(legacy.detail, /devcontour guides-refresh --data \/legacy-data/);
});

test('Unmarked copies matching a past release text count as stale', async () => {
  const releases = (await git(resolve('.'), 'log', '--format=%H', '--grep=^build: release')).split(
    '\n',
  );
  const oldest = releases.at(-1);
  assert.ok(oldest, 'release commits are needed to rebuild a past copy');
  const past = await renderGuideBodies(async (source) => {
    const shown = await command(['git', 'show', `${oldest}:${source}`], resolve('.'));
    return shown.code === 0 ? shown.stdout : undefined;
  });
  const text = past.get('devcontour-start.md')!;
  assert.notEqual(text, guideMarker((await guideCopies()).get('devcontour-start.md')!)!.body);
  assert.ok(PAST_GUIDE_DIGESTS['devcontour-start.md']?.includes(guideDigest(text)));
  const root = await installed();
  await writeFile(join(root, START), text);
  assert.equal(stateOf(await guideDrift(root), START), 'stale');
  await writeFile(join(root, START), text + 'Правка продукта.\n');
  assert.equal(stateOf(await guideDrift(root), START), 'unmarked');
  // Совпадение засчитывается только под своим именем.
  await writeFile(join(root, INTENT), text);
  assert.equal(stateOf(await guideDrift(root), INTENT), 'unmarked');
});

test('CRLF checkouts classify like LF ones and refresh writes LF', async () => {
  const root = await installed();
  const crlf = (text: string) => text.replace(/\n/g, '\r\n');
  const copies = await guideCopies();
  await writeFile(join(root, INTENT), crlf(copies.get('devcontour-intent.md')!));
  await writeFile(join(root, START), crlf(markGuide(OLD)));
  await writeFile(join(root, MEMORY), crlf(copies.get('devcontour-project-memory.md')!) + 'x');
  const drift = await guideDrift(root);
  assert.equal(stateOf(drift, INTENT), 'current');
  assert.equal(stateOf(drift, START), 'stale');
  assert.equal(stateOf(drift, MEMORY), 'edited');
  const refreshed = await refreshGuides(root);
  assert.deepEqual(refreshed.written, [START]);
  assert.equal(await read(root, START), copies.get('devcontour-start.md'));
  assert.equal(await read(root, INTENT), crlf(copies.get('devcontour-intent.md')!));
});

test('Refresh rewrites only untouched tool copies and keeps edited, unmarked and unrelated files', async () => {
  const root = await installed();
  const copies = await guideCopies();
  const edited = copies.get('devcontour-intent.md')! + '\nСвоя правка продукта.\n';
  await writeFile(join(root, START), markGuide(OLD));
  await writeFile(join(root, INTENT), edited);
  await writeFile(join(root, MEMORY), '# Копия прежней версии без метки\n');
  await unlink(join(root, METRICS));
  await writeFile(join(root, 'docs/devcontour-retired.md'), markGuide('# Снятое\n'));
  await git(root, 'add', '-A');
  await git(root, 'commit', '-q', '-m', 'older install');

  const first = await refreshGuides(root);
  assert.deepEqual(first.written.sort(), [METRICS, START].sort());
  assert.deepEqual(first.replacedUnmarked, []);
  assert.equal(await read(root, START), copies.get('devcontour-start.md'));
  assert.equal(await read(root, METRICS), copies.get('devcontour-metrics.md'));
  assert.equal(await read(root, INTENT), edited);
  assert.equal(await read(root, MEMORY), '# Копия прежней версии без метки\n');
  assert.equal(await read(root, 'docs/devcontour-progress.md'), '# Прогресс\n');
  assert.deepEqual(
    first.kept.map((k) => [k.path, k.state]).sort(),
    [
      ['docs/devcontour-retired.md', 'retired'],
      [INTENT, 'edited'],
      [MEMORY, 'unmarked'],
    ].sort(),
  );
  // Ничего не коммитится: копии лежат в рабочем дереве; временных файлов нет.
  assert.match(await git(root, 'status', '--porcelain'), /devcontour-start\.md/);
  assert.deepEqual(
    (await readdir(join(root, 'docs'))).filter((n) => n.endsWith('.tmp')),
    [],
  );

  // Копия без метки с локальной правкой не заменяется и по флагу.
  await writeFile(join(root, MEMORY), '# Копия без метки, правка не закоммичена\n');
  const dirty = await refreshGuides(root, { replaceUnmarked: true });
  assert.ok(!dirty.written.includes(MEMORY));
  assert.equal(await read(root, MEMORY), '# Копия без метки, правка не закоммичена\n');
  assert.match(dirty.kept.find((k) => k.path === MEMORY)!.reason, /не закоммичена/);

  // Неотслеживаемая копия без метки — тоже нет.
  await git(root, 'rm', '-q', '--cached', MEMORY);
  await git(root, 'commit', '-q', '-m', 'untrack');
  const untracked = await refreshGuides(root, { replaceUnmarked: true });
  assert.ok(!untracked.written.includes(MEMORY));

  // Закоммиченная без изменений — заменяется по флагу; прежний текст в Git.
  await git(root, 'add', '-A');
  await git(root, 'commit', '-q', '-m', 'keep');
  const replaced = await refreshGuides(root, { replaceUnmarked: true });
  assert.deepEqual(replaced.written, [MEMORY]);
  assert.deepEqual(replaced.replacedUnmarked, [MEMORY]);
  assert.equal(await read(root, MEMORY), copies.get('devcontour-project-memory.md'));
  assert.equal(await read(root, INTENT), edited);

  // Изменённую копию убрали — следующее обновление восстанавливает её.
  await unlink(join(root, INTENT));
  assert.deepEqual((await refreshGuides(root)).written, [INTENT]);
  const after = await guideDrift(root);
  assert.deepEqual(
    after.filter((e) => e.state !== 'current'),
    [{ path: 'docs/devcontour-retired.md', state: 'retired' }],
  );
});

test('Refresh never writes through symlinks or hard links', async () => {
  const root = await installed();
  const away = await temp('devcontour-guides-outside-');
  // Висячая ссылка наружу на месте отсутствующей копии.
  await unlink(join(root, METRICS));
  await symlink(join(away, 'created-by-refresh.md'), join(root, METRICS));
  // Ссылка на внешний файл с устаревшей меткой.
  await writeFile(join(away, 'intent.md'), markGuide(OLD));
  await unlink(join(root, INTENT));
  await symlink(join(away, 'intent.md'), join(root, INTENT));
  // Закоммиченная ссылка на внешний файл без метки (для --replace-unmarked).
  await writeFile(join(away, 'memory.md'), '# Без метки\n');
  await unlink(join(root, MEMORY));
  await symlink(join(away, 'memory.md'), join(root, MEMORY));
  // Жёсткая ссылка на внешний файл.
  await writeFile(join(away, 'team.md'), markGuide(OLD));
  await unlink(join(root, TEAM));
  await link(join(away, 'team.md'), join(root, TEAM));
  await git(root, 'add', '-A');
  await git(root, 'commit', '-q', '-m', 'links');
  // Каталог на месте копии.
  await unlink(join(root, MAP));
  await mkdir(join(root, MAP));

  const drift = await guideDrift(root);
  for (const path of [METRICS, INTENT, MEMORY, TEAM, MAP])
    assert.equal(stateOf(drift, path), 'not-a-file', path);
  const [check] = await guideChecks(minimal(root), '/d');
  assert.match(check.detail, /не обычные файлы/);

  const result = await refreshGuides(root, { replaceUnmarked: true });
  for (const path of [METRICS, INTENT, MEMORY, TEAM]) {
    assert.ok(!result.written.includes(path), path);
    assert.equal(result.kept.find((k) => k.path === path)?.state, 'not-a-file');
  }
  assert.deepEqual((await readdir(away)).sort(), ['intent.md', 'memory.md', 'team.md']);
  assert.equal(await read(away, 'intent.md'), markGuide(OLD));
  assert.equal(await read(away, 'memory.md'), '# Без метки\n');
  assert.equal(await read(away, 'team.md'), markGuide(OLD));
});

test('Refresh does not write into docs/ that is a symlink', async () => {
  const root = await temp('devcontour-guides-linked-');
  const away = await temp('devcontour-guides-outside-');
  for (const [name, content] of await guideCopies()) await writeFile(join(away, name), content);
  await writeFile(join(away, 'devcontour-start.md'), markGuide(OLD));
  await unlink(join(away, 'devcontour-metrics.md'));
  await symlink(away, join(root, 'docs'));
  const drift = await guideDrift(root);
  assert.ok(drift.length);
  assert.ok(drift.every((e) => e.state === 'not-a-file'));
  const result = await refreshGuides(root);
  assert.deepEqual(result.written, []);
  assert.equal(await read(away, 'devcontour-start.md'), markGuide(OLD));
  assert.ok(!(await readdir(away)).includes('devcontour-metrics.md'));
});

test('A repository without copies is neither checked nor refreshed; components keep their ids', async () => {
  const empty = await temp('devcontour-guides-none-');
  await mkdir(join(empty, 'docs'));
  await writeFile(join(empty, 'docs/devcontour-progress.md'), '# Прогресс\n');
  const result = await refreshGuides(empty);
  assert.equal(result.skipped, 'no-copies');
  assert.deepEqual(result.written, []);
  assert.deepEqual(await readdir(join(empty, 'docs')), ['devcontour-progress.md']);
  // Компоненты workspace: репозиторий setup и каждый компонент — со своим id.
  assert.deepEqual(
    guideRepositories(
      minimal('/w/app', {
        repositories: [
          { id: 'api', path: '/w/api' },
          { id: 'web', path: '/w/app' },
        ],
      }),
    ),
    [
      { id: 'api', path: '/w/api' },
      { id: 'web', path: '/w/app' },
    ],
  );
  assert.deepEqual(
    guideRepositories(minimal('/w/main', { repositories: [{ id: 'api', path: '/w/api' }] })),
    [
      { id: 'main', path: '/w/main' },
      { id: 'api', path: '/w/api' },
    ],
  );
});

test('Setup writes marked copies; doctor reports drift as degraded; the CLI refreshes and warns about pinned packs', async () => {
  const root = await temp('devcontour-guides-setup-');
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs/spec.md'), '# Каталог\nПоиск товаров в настоящей базе.');
  const setup = await setupProject({
    repository: root,
    profile: 'go-api',
    data: join(root, '.devcontour-local'),
  });
  assert.ok((await guideDrift(root)).every((e) => e.state === 'current'));
  await writeFile(join(root, START), markGuide(OLD));

  const config = loadConfig(join(setup.data, 'config.json'));
  const result = await doctor(config, setup.data, false, emptyState());
  const check = result.checks.find((c) => c.id === 'guides:main');
  assert.equal(check?.status, 'degraded');
  assert.match(check.detail, /devcontour-start\.md/);
  assert.equal(result.ready, doctorReady(result.checks.filter((c) => !c.id.startsWith('guides:'))));

  // Пакет контекста, который сам называет копию, закреплён по её тексту.
  const file = join(setup.data, 'config.json');
  const raw = JSON.parse(await readFile(file, 'utf8')) as {
    contextPacks: { id: string; references?: string[] }[];
  };
  raw.contextPacks[0].references = [...(raw.contextPacks[0].references ?? []), START];
  await writeFile(file, JSON.stringify(raw, null, 2) + '\n');

  const cli = await command(
    [process.execPath, '--import', 'tsx', 'src/cli.ts', 'guides-refresh', '--data', setup.data],
    resolve('.'),
  );
  assert.equal(cli.code, 0, cli.stderr);
  const output = JSON.parse(cli.stdout) as {
    repositories: { id: string; written: string[] }[];
    next: string[];
  };
  assert.deepEqual(
    output.repositories.map((r) => [r.id, r.written]),
    [['main', [START]]],
  );
  const next = output.next.join(' ');
  assert.match(next, /base-update/);
  assert.ok(next.includes(`${raw.contextPacks[0].id} (${START})`), next);
  assert.match(next, /context-lock/);
  assert.equal(await read(root, START), (await guideCopies()).get('devcontour-start.md'));
});
