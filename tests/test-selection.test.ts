/**
 * Day-to-day test tiers (scripts/test.mjs): the affected selection by import
 * closure and the slow tier. Both only narrow `npm test`; a change the
 * selection cannot place must widen to the full suite, never to nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectTests, workingChanges, type Change, type Repo } from '../scripts/affected-tests.ts';

const repo = (files: Record<string, string>): Repo => ({
  files: Object.keys(files),
  read: (path) => files[path],
});
const modified = (...paths: string[]): Change[] => paths.map((path) => ({ path, status: 'M' }));

const tree = {
  'src/core/model.ts': 'export const model = 1;\n',
  'src/core/graph.ts': "import { model } from './model.js';\nexport const graph = model;\n",
  'src/core/index.ts': "export * from './graph.ts';\n",
  'src/runner/run.ts': "import { graph } from '../core';\nexport const run = () => graph;\n",
  'src/runner/lazy.ts': "export const lazy = () => import('./late.ts');\n",
  'src/runner/late.ts': 'export const late = 1;\n',
  'src/runner/assets.ts':
    "export const root = new URL('../../tests/fixtures/data/', import.meta.url);\n" +
    // Product paths in product code are not files of this repository.
    "export const defaults = { writePaths: ['src/', 'src/core'] };\n",
  'src/cli.ts': "import { run } from './runner/run.ts';\nrun();\n",
  'src/web/App.tsx':
    "import { Button } from '@/ui/button.tsx';\nexport const App = () => <Button>{'</div>'}</Button>;\n",
  'src/web/ui/button.tsx': 'export const Button = (p: any) => <button {...p} />;\n',
  'src/web/orphan.ts': 'export const orphan = 1;\n',
  'tests/helpers.ts': "export { graph } from '../src/core/graph.ts';\n",
  'tests/fixtures/data/case.json': '{}\n',
  'tests/fixtures/stray.json': '{}\n',
  'tests/core.test.ts': "import { graph } from './helpers.ts';\ngraph;\n",
  'tests/cli.test.ts':
    // Spawns the CLI by path; mentions another module only in a string and a comment.
    "const cli = 'src/cli.ts';\n// import '../src/runner/late.ts'\nconst note = \"import '../src/web/orphan.ts'\";\n",
  'tests/lazy.test.ts': "import { lazy } from '../src/runner/lazy.ts';\nlazy;\n",
  'tests/assets.test.ts': "import { root } from '../src/runner/assets.ts';\nroot;\n",
  'tests/web.test.ts': "import { App } from '../src/web/App.tsx';\nApp;\n",
  'tests/fixture.test.ts':
    // A fixture product: these name its paths, not this repository's tree.
    "const files = { 'src': 1, 'src/': 2, 'tests': 3 };\nfiles;\n",
  'tests/boundaries.test.ts': "walk('src');\n",
};

test('Affected selection follows the import closure through specifier forms', () => {
  const pick = (...paths: string[]) => selectTests(repo(tree), modified(...paths));
  // .js → .ts twin, directory index, re-export through a test helper.
  assert.deepEqual(pick('src/core/model.ts').tests, [
    'tests/boundaries.test.ts',
    'tests/cli.test.ts',
    'tests/core.test.ts',
  ]);
  // A test that only spawns `src/cli.ts` by path reaches what the CLI imports.
  assert.ok(pick('src/runner/run.ts').tests.includes('tests/cli.test.ts'));
  // Dynamic import; a string or comment mentioning it is not an import.
  assert.deepEqual(pick('src/runner/late.ts').tests, [
    'tests/boundaries.test.ts',
    'tests/lazy.test.ts',
  ]);
  // JSX and the `@/` alias of src/web.
  assert.deepEqual(pick('src/web/ui/button.tsx').tests, [
    'tests/boundaries.test.ts',
    'tests/web.test.ts',
  ]);
  // A directory named by `new URL(…, import.meta.url)` in product code.
  assert.deepEqual(pick('tests/fixtures/data/case.json').tests, ['tests/assets.test.ts']);
  // The test file itself.
  assert.deepEqual(pick('tests/core.test.ts').tests, ['tests/core.test.ts']);
});

test('Product paths in fixtures and product code do not pull the whole tree', () => {
  const selection = selectTests(repo(tree), modified('src/web/orphan.ts'));
  assert.equal(selection.full, false);
  // Only the listed whole-tree test reads every src file.
  assert.deepEqual(selection.tests, ['tests/boundaries.test.ts']);
  const withoutWalk = Object.fromEntries(
    Object.entries(tree).filter(([path]) => path !== 'tests/boundaries.test.ts'),
  );
  const none = selectTests(repo(withoutWalk), modified('src/web/orphan.ts'));
  assert.deepEqual([none.full, none.tests], [false, []]);
  assert.match(none.changes[0].effect, /no node test reaches it/);
});

test('A change the selection cannot place widens to the full suite', () => {
  for (const path of [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'scripts/test.mjs',
    'vendor/harness/devcontour-harness-0.1.0.tgz',
    'packs/profiles/node.json',
    'docs/development.md',
  ]) {
    const selection = selectTests(repo(tree), modified('src/core/model.ts', path));
    assert.equal(selection.full, true, path);
    assert.match(selection.reason, /outside src\/ and tests\//);
  }
  const deleted = selectTests(repo(tree), [{ path: 'src/core/model.ts', status: 'D' }]);
  assert.equal(deleted.full, true);
  assert.match(deleted.reason, /deleted/);
  // A non-source file under tests/ that no test is seen to read.
  const stray = selectTests(repo(tree), modified('tests/fixtures/stray.json'));
  assert.equal(stray.full, true);
  assert.match(stray.reason, /no test is seen to reach tests\/fixtures\/stray\.json/);
  assert.deepEqual(selectTests(repo(tree), []), {
    full: false,
    reason: 'no changes',
    tests: [],
    changes: [],
  });
});

test('Depth keeps only tests within the given number of import hops', () => {
  const near = selectTests(repo(tree), modified('src/core/model.ts'), { depth: 2 });
  // core.test → helpers → graph → model is three hops; boundaries is whole-tree.
  assert.deepEqual(near.tests, ['tests/boundaries.test.ts']);
  const three = selectTests(repo(tree), modified('src/core/model.ts'), { depth: 3 });
  assert.deepEqual(three.tests, ['tests/boundaries.test.ts', 'tests/core.test.ts']);
});

test('Working changes cover commits since the merge base, the index, the worktree and untracked files', () => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-affected-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
      cwd: root,
      encoding: 'utf8',
    });
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  try {
    git('init', '-q', '-b', 'master');
    write('src/a.ts', '1');
    write('src/gone.ts', '1');
    write('src/staged.ts', '1');
    write('src/dirty.ts', '1');
    git('add', '-A');
    git('commit', '-qm', 'base');
    git('checkout', '-qb', 'topic');
    write('src/a.ts', '2');
    git('commit', '-qam', 'topic');
    // A commit on master after the branch point is not a change of the topic.
    git('checkout', '-q', 'master');
    write('src/master-only.ts', '1');
    git('add', '-A');
    git('commit', '-qm', 'master moves');
    git('checkout', '-q', 'topic');
    write('src/staged.ts', '2');
    git('add', 'src/staged.ts');
    write('src/dirty.ts', '2');
    git('rm', '-q', 'src/gone.ts');
    write('src/new.ts', '1');
    const { changes } = workingChanges(root, 'master');
    assert.deepEqual(
      changes.sort((a, b) => a.path.localeCompare(b.path)),
      [
        { status: 'M', path: 'src/a.ts' },
        { status: 'M', path: 'src/dirty.ts' },
        { status: 'D', path: 'src/gone.ts' },
        { status: 'A', path: 'src/new.ts' },
        { status: 'M', path: 'src/staged.ts' },
      ],
    );
  } finally {
    if (root.startsWith(join(tmpdir(), 'devcontour-affected-')))
      rmSync(root, { recursive: true, force: true });
  }
});

type Tiers = {
  slowFirst: string[];
  slowTests: Record<string, true | string[]>;
  slowPatterns: () => RegExp[];
};
// A plain .mjs module without declarations: typed here by its use.
const tiersModule: string = '../scripts/test-tiers.mjs';
const tiers = (await import(tiersModule)) as Tiers;
const testsDir = fileURLToPath(new URL('./', import.meta.url));
const sources = Object.fromEntries(
  readdirSync(testsDir)
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => [name.replace(/\.test\.ts$/, ''), readFileSync(join(testsDir, name), 'utf8')]),
);

test('Every slow tier entry names a test file and a test prefix that still exist', () => {
  for (const name of tiers.slowFirst) assert.ok(sources[name] !== undefined, name);
  for (const [name, entry] of Object.entries(tiers.slowTests)) {
    assert.ok(sources[name] !== undefined, `slow tier: no tests/${name}.test.ts`);
    if (entry === true) continue;
    assert.ok(entry.length, name);
    for (const prefix of entry) {
      const files = Object.keys(sources).filter((file) => sources[file].includes(prefix));
      assert.deepEqual(files, [name], `slow tier prefix «${prefix}»`);
    }
  }
});

test('Slow tier patterns match a name by its prefix only', () => {
  const patterns = tiers.slowPatterns();
  const prefix = Object.values(tiers.slowTests).flatMap((entry) =>
    entry === true ? [] : entry,
  )[0];
  const name = prefix + ' and the rest of its name';
  assert.ok(patterns.some((p) => p.test(name)));
  assert.ok(!patterns.some((p) => p.test('Повтор: ' + name)));
});

test('The full list runs every test file; the fast list leaves out only whole slow files', () => {
  const script = fileURLToPath(new URL('../scripts/test.mjs', import.meta.url));
  const list = (...args: string[]) =>
    execFileSync(process.execPath, [script, '--list', ...args], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((path) => path.slice(testsDir.length).replace(/\.test\.ts$/, ''))
      .sort();
  assert.deepEqual(list(), Object.keys(sources).sort());
  const whole = Object.keys(tiers.slowTests).filter((name) => tiers.slowTests[name] === true);
  assert.deepEqual(
    list('--fast'),
    Object.keys(sources)
      .filter((name) => !whole.includes(name))
      .sort(),
  );
});
