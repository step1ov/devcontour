import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  guideCopies,
  guideDrift,
  guideMarker,
  markGuide,
  refreshGuides,
} from '../src/runner/guides.ts';
import { guideChecks } from '../src/runner/doctor.ts';
import { setupProject } from '../src/runner/setup.ts';
import { command, git } from '../src/runner/process.ts';

const START = 'docs/devcontour-start.md';
const INTENT = 'docs/devcontour-intent.md';
const MEMORY = 'docs/devcontour-project-memory.md';
const METRICS = 'docs/devcontour-metrics.md';
const TEAM = 'docs/devcontour-team-sync.md';

/** Репозиторий с полным набором актуальных копий, закоммиченных в Git. */
async function installed() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'devcontour-guides-')));
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

test('Guide copies carry a digest marker of their own text', async () => {
  const copies = await guideCopies();
  assert.equal(copies.size, 16);
  for (const content of copies.values()) {
    const marker = guideMarker(content);
    assert.ok(marker);
    assert.equal(markGuide(marker.body), content);
  }
  assert.equal(guideMarker('# без метки\n'), undefined);
});

test('Doctor names stale, edited, unmarked, missing and retired guide copies with a fix command', async () => {
  const root = await installed();
  const empty = await realpath(await mkdtemp(join(tmpdir(), 'devcontour-guides-none-')));
  try {
    const config = { repository: root, repositories: [], workspaceRoot: '/w' };
    // Свежая установка: всё совпадает.
    assert.ok((await guideDrift(root)).every((e) => e.state === 'current'));
    assert.deepEqual(
      (await guideChecks(config)).map((c) => c.status),
      ['passed'],
    );
    // Репозиторий без копий вовсе не сверяется.
    assert.deepEqual(await guideDrift(empty), []);
    assert.deepEqual(await guideChecks({ ...config, repository: empty }), []);

    const current = (await guideCopies()).get('devcontour-intent.md')!;
    await writeFile(join(root, START), markGuide('# Прежняя версия руководства\n'));
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

    const [check] = await guideChecks(config);
    assert.equal(check?.status, 'degraded');
    assert.equal(check?.id, 'guides:' + root);
    for (const path of [START, INTENT, MEMORY, METRICS, TEAM, 'docs/devcontour-retired.md'])
      assert.match(check.detail, new RegExp(path));
    assert.match(check.detail, /devcontour guides-refresh --workspace \/w/);
    assert.match(check.detail, /--replace-unmarked/);
    assert.doesNotMatch(check.detail, /devcontour-progress/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(empty, { recursive: true, force: true });
  }
});

test('Refresh rewrites only untouched tool copies and keeps edited, unmarked and unrelated files', async () => {
  const root = await installed();
  try {
    const copies = await guideCopies();
    const edited = copies.get('devcontour-intent.md')! + '\nСвоя правка продукта.\n';
    await writeFile(join(root, START), markGuide('# Прежняя версия руководства\n'));
    await writeFile(join(root, INTENT), edited);
    await writeFile(join(root, MEMORY), '# Копия прежней версии без метки\n');
    await unlink(join(root, METRICS));
    await writeFile(join(root, 'docs/devcontour-retired.md'), markGuide('# Снятое\n'));
    await git(root, 'add', '-A');
    await git(root, 'commit', '-q', '-m', 'older install');

    const first = await refreshGuides(root);
    assert.deepEqual(first.written.sort(), [METRICS, START].sort());
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
    // Ничего не коммитится: копии лежат в рабочем дереве.
    assert.match(await git(root, 'status', '--porcelain'), /devcontour-start\.md/);

    // Копия без метки с локальной правкой не заменяется и по флагу.
    await writeFile(join(root, MEMORY), '# Копия без метки, правка не закоммичена\n');
    const dirty = await refreshGuides(root, { replaceUnmarked: true });
    assert.ok(!dirty.written.includes(MEMORY));
    assert.equal(await read(root, MEMORY), '# Копия без метки, правка не закоммичена\n');
    assert.match(dirty.kept.find((k) => k.path === MEMORY)!.reason, /не закоммичена/);

    // Закоммиченная без изменений — заменяется по флагу; прежний текст в Git.
    await git(root, 'add', '-A');
    await git(root, 'commit', '-q', '-m', 'keep');
    const replaced = await refreshGuides(root, { replaceUnmarked: true });
    assert.deepEqual(replaced.written, [MEMORY]);
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Setup writes marked copies and the guides-refresh CLI restores a stale one', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'devcontour-guides-setup-')));
  try {
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs/spec.md'), '# Каталог\nПоиск товаров в настоящей базе.');
    const setup = await setupProject({
      repository: root,
      profile: 'go-api',
      data: join(root, '.devcontour-local'),
    });
    assert.ok((await guideDrift(root)).every((e) => e.state === 'current'));
    await writeFile(join(root, START), markGuide('# Прежняя версия руководства\n'));
    const result = await command(
      [process.execPath, '--import', 'tsx', 'src/cli.ts', 'guides-refresh', '--data', setup.data],
      resolve('.'),
    );
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout) as {
      repositories: { written: string[] }[];
      next: string[];
    };
    assert.deepEqual(output.repositories[0]?.written, [START]);
    assert.match(output.next.join(' '), /base-update/);
    assert.equal(await read(root, START), (await guideCopies()).get('devcontour-start.md'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
