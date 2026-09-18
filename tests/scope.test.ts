import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { commandScope } from '../src/runner/scope.ts';
import { setupProject } from '../src/runner/setup.ts';
import { command } from '../src/runner/process.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { loadConfig } from '../src/runner/config.ts';

const cli = resolve('src/cli.ts');
const loader = import.meta.resolve('tsx');
const run = (cwd: string, ...args: string[]) =>
  command([process.execPath, '--import', loader, cli, ...args], cwd);

test('Product commands require scope; invalid or conflicting scope never silently selects demo', () => {
  for (const operation of [
    'serve',
    'run',
    'setup',
    'init',
    'plan',
    'import-plan',
    'export',
    'doctor',
    'queue',
    'changeset-create',
    'journal',
  ])
    assert.throws(() => commandScope([operation], operation), /В какой папке/);
  assert.equal(commandScope(['demo'], 'demo').workspace, undefined);
  assert.throws(
    () => commandScope(['serve', '--workspace', resolve('.')], 'serve'),
    /вне каталога/,
  );
  assert.equal(
    commandScope(['serve', '--workspace', '/tmp/project'], 'serve').data,
    join('/tmp/project', '.devcontour-local'),
  );
  assert.throws(() => commandScope(['serve', '--workspace', 'relative'], 'serve'), /абсолютный/);
  assert.throws(
    () => commandScope(['serve', '--workspace', '/tmp/a', '--data', '/tmp/b'], 'serve'),
    /не оба/,
  );
  assert.throws(() => commandScope(['serve', '--workspace'], 'serve'), /значение/);
  assert.throws(
    () => commandScope(['serve', '--workspace', '--port', '4317'], 'serve'),
    /значение/,
  );
  assert.throws(
    () => commandScope(['serve', '--workspace', '/tmp/a', '--workspace', '/tmp/b'], 'serve'),
    /один раз/,
  );
  assert.throws(() => commandScope(['demo', '--workspace', '/tmp/a'], 'demo'), /Demo/);
});

test('Bare CLI fails before creating demo files; two CLI sessions address separate workspace databases', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'devcontour-scope-')));
  try {
    const missing = await run(root, 'serve');
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /В какой папке/);
    assert.deepEqual(await readdir(root), []);
    const contexts = [];
    for (const name of ['shop', 'crm']) {
      const product = join(root, name),
        workspace = join(root, name + '-workspace');
      await mkdir(join(product, 'docs'), { recursive: true });
      await writeFile(join(product, 'docs', 'spec.md'), '# Product\nObservable scenario');
      const result = await run(
        root,
        'setup',
        '--repository',
        product,
        '--profile',
        'react-vite-admin',
        '--workspace',
        workspace,
      );
      assert.equal(result.code, 0, result.stderr);
      const setup = JSON.parse(result.stdout);
      assert.equal(setup.data, join(workspace, '.devcontour-local'));
      assert.equal(loadConfig(join(setup.data, 'config.json')).workspaceRoot, workspace);
      assert.match(
        await readFile(join(product, 'docs/devcontour-start.md'), 'utf8'),
        /devcontour-integration.md/,
      );
      assert.match(
        await readFile(join(product, 'docs/devcontour-integration.md'), 'utf8'),
        /Forge/,
      );
      assert.ok(
        JSON.parse(await readFile(join(product, 'devcontour.component.json'), 'utf8')).roles,
      );
      const planFile = join(workspace, 'plan.json');
      await writeFile(
        planFile,
        JSON.stringify({
          title: name + ' work',
          description: 'Independent project',
          tasks: [
            {
              key: 'qa',
              title: name + ' tests',
              description: 'A separate observable test outcome',
              role: 'qa',
              dependsOn: [],
              contracts: [],
              acceptance: ['Behaviour verified'],
            },
          ],
        }),
      );
      contexts.push({ workspace, planFile });
    }
    const results = await Promise.all(
      contexts.map((c) =>
        run(root, 'import-plan', '--file', c.planFile, '--workspace', c.workspace),
      ),
    );
    for (const r of results) assert.equal(r.code, 0, r.stderr);
    const states = await Promise.all(
      contexts.map((c) => run(root, 'export', '--workspace', c.workspace)),
    );
    assert.equal(JSON.parse(states[0].stdout).state.boards[0].title, 'shop work');
    assert.equal(JSON.parse(states[1].stdout).state.boards[0].title, 'crm work');
    await assert.rejects(readFile(join(root, 'shop', '.devcontour-local', 'config.json')));
    await assert.rejects(readFile(join(root, '.devcontour-local', 'demo', 'config.json')));
    const first = contexts[0];
    const config = loadConfig(join(first.workspace, '.devcontour-local', 'config.json'));
    assert.equal(config.storage, 'component');
    const store = new Store(
      join(first.workspace, '.devcontour-local', 'state.sqlite'),
      config.repositories,
    );
    const h = new DevContour(store, config);
    assert.equal(h.store.read().boards.length, 1);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Workspace setup preserves an existing scope and rejects a workspace inside the product', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'devcontour-workspace-start-')));
  try {
    const product = join(root, 'product'),
      workspace = join(root, 'workspace');
    await mkdir(join(product, 'docs'), { recursive: true });
    await writeFile(join(product, 'docs', 'spec.md'), '# Test project');
    await assert.rejects(
      setupProject({ repository: product, profile: 'react-vite-admin', workspace: product }),
      /вне репозитория/,
    );
    await assert.rejects(readFile(join(product, 'AGENTS.md')));
    const first = await setupProject({
      repository: product,
      profile: 'react-vite-admin',
      workspace,
    });
    const before = await readFile(join(first.data, 'config.json'), 'utf8');
    const second = await setupProject({
      repository: product,
      profile: 'react-vite-admin',
      workspace,
    });
    assert.equal(second.created.length, 0);
    assert.equal(await readFile(join(first.data, 'config.json'), 'utf8'), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
