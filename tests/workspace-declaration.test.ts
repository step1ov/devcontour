import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/runner/config.ts';
import { git } from '../src/runner/process.ts';
import {
  operationalCurrent,
  operationalDeclaration,
  setupWorkspace,
} from '../src/runner/workspace-setup.ts';

import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { repositories } from '../src/core/repositories.ts';
import { requestConfigApply, serveReconfigure } from '../src/runner/reconfigure.ts';

const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value) + '\n');

test('Workspace refuses effort outside codex before it writes any configuration', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'devcontour-declaration-')));
  try {
    const repo = join(root, 'product');
    const control = join(root, 'control');
    await mkdir(repo);
    await mkdir(control);
    await git(repo, 'init', '-b', 'main');
    const registryPath = join(control, 'workspace.json');
    await json(registryPath, {
      version: 1,
      name: 'Effort',
      repositories: [
        {
          id: 'product',
          name: 'Product',
          path: repo,
          profile: 'react-vite-admin',
          roles: { qa: { runtime: 'claude', effort: 'low' } },
        },
      ],
    });
    await assert.rejects(
      setupWorkspace(registryPath),
      /effort поддерживается только для codex: qa/,
    );
    assert.deepEqual(await readdir(control), ['workspace.json']);
    assert.deepEqual(await readdir(repo), ['.git']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Workspace declaration adds a tool profile with the component bindings that use it', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'devcontour-declaration-')));
  try {
    const repo = join(root, 'product');
    const control = join(root, 'control');
    await mkdir(repo);
    await mkdir(control);
    await git(repo, 'init', '-b', 'main');
    const componentPath = join(repo, 'devcontour.component.json');
    const registryPath = join(control, 'workspace.json');
    const bindings = (runtime: 'claude' | 'codex', toolProfile: string = runtime) =>
      Object.fromEntries(
        ['architect', 'backend', 'frontend', 'qa'].map((role) => [
          role,
          {
            runtime,
            toolProfile,
            reviewer: { runtime: 'codex' },
            ...(runtime === 'codex' ? { reviewVendor: 'same-vendor-allowed' } : {}),
          },
        ]),
      );
    const component = {
      name: 'Product',
      kind: 'product',
      targetBranch: 'devcontour/integration',
      gates: [
        {
          id: 'tests',
          kind: 'test',
          command: ['npm', 'test'],
          report: { type: 'junit', path: '.reports/tests.xml' },
        },
      ],
      roles: bindings('claude'),
      reviewer: { runtime: 'codex' },
    };
    const registry = {
      version: 1,
      name: 'Workspace declaration',
      repositories: [
        {
          id: 'product',
          name: 'Product',
          path: repo,
          profile: 'react-vite-admin',
          configFile: 'devcontour.component.json',
        },
      ],
      toolProfiles: { claude: { runtime: 'claude' } },
    };
    await json(componentPath, component);
    await json(registryPath, registry);
    const created = await setupWorkspace(registryPath);
    const configPath = created.config;
    const lockPath = join(created.data, 'packs.lock.json');
    const ownerPath = join(repo, '.git/devcontour-owner.json');
    const stored = JSON.parse(await readFile(configPath, 'utf8')) as ReturnType<typeof loadConfig>;
    stored.approvalMode = 'operator';
    await json(configPath, stored);
    const before = await readFile(configPath, 'utf8');
    const lockBefore = await readFile(lockPath, 'utf8');
    const ownerBefore = await readFile(ownerPath, 'utf8');

    // Both files change together; the saved runtime still knows only claude.
    const nextComponent = { ...component, roles: bindings('codex') };
    const nextRegistry = { ...registry, toolProfiles: { codex: { runtime: 'codex' } } };
    await json(componentPath, nextComponent);
    await json(registryPath, nextRegistry);
    assert.throws(() => loadConfig(configPath), /toolProfile: codex/);
    assert.equal((await setupWorkspace(registryPath)).status, 'declaration-updated');
    const updated = loadConfig(configPath);
    assert.deepEqual(Object.keys(updated.toolProfiles), ['codex']);
    assert.equal(updated.roles.backend.runtime, 'codex');
    assert.equal(updated.repositories[0].roles!.backend.toolProfile, 'codex');
    assert.equal(updated.approvalMode, 'operator');
    assert.equal(await readFile(lockPath, 'utf8'), lockBefore);
    assert.equal(await readFile(ownerPath, 'utf8'), ownerBefore);
    assert.equal((await setupWorkspace(registryPath)).status, 'preserved');

    // A new profile cannot mask an invalid old policy, changed pin or target.
    for (const invalid of ['old-policy', 'pin', 'target', 'new-profile', 'final-policy'] as const) {
      await writeFile(configPath, before);
      await writeFile(lockPath, lockBefore);
      await json(componentPath, nextComponent);
      await json(registryPath, nextRegistry);
      if (invalid === 'old-policy') await json(configPath, { ...stored, concurrency: 0 });
      if (invalid === 'pin') {
        const lock = JSON.parse(lockBefore) as { packs: Array<{ digest: string }> };
        lock.packs[0].digest = '0'.repeat(64);
        await json(lockPath, lock);
      }
      if (invalid === 'target')
        await json(componentPath, { ...nextComponent, targetBranch: 'devcontour/another' });
      if (invalid === 'new-profile')
        await json(registryPath, { ...registry, toolProfiles: { codex: { runtime: 'claude' } } });
      if (invalid === 'final-policy')
        await json(configPath, {
          ...stored,
          roles: {
            ...stored.roles,
            audit: { runtime: 'claude', toolProfile: 'claude', reviewer: { runtime: 'codex' } },
          },
        });
      const configBytes = await readFile(configPath, 'utf8');
      const lockBytes = await readFile(lockPath, 'utf8');
      const errors = {
        'old-policy': /concurrency/,
        pin: /Профиль изменился/,
        target: /управляет другая конфигурация/,
        'new-profile': /toolProfile: codex/,
        'final-policy': /toolProfile: claude/,
      };
      await assert.rejects(setupWorkspace(registryPath), errors[invalid], invalid);
      assert.equal(await readFile(configPath, 'utf8'), configBytes, invalid);
      assert.equal(await readFile(lockPath, 'utf8'), lockBytes, invalid);
      assert.equal(await readFile(ownerPath, 'utf8'), ownerBefore, invalid);
    }

    // Introducing an unused name must still be persisted, not false-preserved.
    await writeFile(configPath, before);
    await writeFile(lockPath, lockBefore);
    await json(componentPath, component);
    await json(registryPath, {
      ...registry,
      toolProfiles: { ...registry.toolProfiles, ...nextRegistry.toolProfiles },
    });
    assert.equal((await setupWorkspace(registryPath)).status, 'declaration-updated');
    assert.equal(loadConfig(configPath).toolProfiles.codex.runtime, 'codex');
    assert.equal((await setupWorkspace(registryPath)).status, 'preserved');

    // Profile names are arbitrary strings, including Object prototype names.
    for (const name of ['constructor', 'toString']) {
      await writeFile(configPath, before);
      await json(componentPath, { ...component, roles: bindings('codex', name) });
      await json(registryPath, { ...registry, toolProfiles: { [name]: { runtime: 'codex' } } });
      assert.equal((await setupWorkspace(registryPath)).status, 'declaration-updated');
      const custom = loadConfig(configPath);
      assert.deepEqual(Object.keys(custom.toolProfiles), [name]);
      assert.equal(custom.roles.backend.toolProfile, name);
      assert.equal((await setupWorkspace(registryPath)).status, 'preserved');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Workspace declaration carries budgets and prices; the declaration wins over a local edit, an undeclared key stays local', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'devcontour-declaration-')));
  try {
    const repo = join(root, 'product');
    const control = join(root, 'control');
    await mkdir(repo);
    await mkdir(control);
    await git(repo, 'init', '-b', 'main');
    const registryPath = join(control, 'workspace.json');
    const price = {
      runtime: 'codex',
      model: 'EXAMPLE_MODEL',
      effectiveAt: '2026-01-01T00:00:00Z',
      input: 1,
      output: 4,
      cacheRead: 0.1,
      cacheWrite: 1,
    };
    const registry = {
      version: 1,
      name: 'Budgets',
      repositories: [{ id: 'product', name: 'Product', path: repo, profile: 'react-vite-admin' }],
      budgets: { task: { usd: 25 }, onUnknown: 'continue' },
      prices: [price],
    };
    // Объявление проверяется той же схемой: неверный предел — отказ до записи.
    await json(registryPath, { ...registry, budgets: { task: {} } });
    await assert.rejects(setupWorkspace(registryPath), /usd или timeMs/);
    assert.deepEqual(await readdir(control), ['workspace.json']);

    await json(registryPath, registry);
    const created = await setupWorkspace(registryPath);
    const configPath = created.config;
    let loaded = loadConfig(configPath);
    assert.deepEqual(loaded.budgets, { task: { usd: 25 }, onUnknown: 'continue' });
    assert.deepEqual(loaded.prices, [price]);
    assert.equal((await setupWorkspace(registryPath)).status, 'preserved');

    // Локальная правка config.json действует до следующего workspace-init,
    // который возвращает объявление и называет заменённое.
    const stored = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    await json(configPath, { ...stored, budgets: { task: { usd: 100 }, onUnknown: 'continue' } });
    const updated = (await setupWorkspace(registryPath)) as {
      status: string;
      operational?: { replaced: string[]; note: string };
    };
    assert.equal(updated.status, 'declaration-updated');
    assert.deepEqual(updated.operational?.replaced, ['budgets']);
    assert.match(updated.operational?.note ?? '', /config-apply --keys budgets/);
    loaded = loadConfig(configPath);
    assert.deepEqual(loaded.budgets, { task: { usd: 25 }, onUnknown: 'continue' });

    // Реестр без этих ключей ими не управляет: локальные значения сохраняются.
    const undeclared = { ...registry, budgets: undefined, prices: undefined };
    await json(configPath, {
      ...(JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>),
      budgets: { workspace: { usd: 7 } },
    });
    await json(registryPath, undeclared);
    assert.equal((await setupWorkspace(registryPath)).status, 'preserved');
    loaded = loadConfig(configPath);
    assert.deepEqual(loaded.budgets, { workspace: { usd: 7 }, onUnknown: 'stop' });
    assert.deepEqual(loaded.prices, [price]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('A local config with one invalid operational key reports only that key as replaced', () => {
  const budgets = { task: { usd: 25 }, onUnknown: 'continue' as const };
  const current = operationalCurrent({ budgets, prices: [{ runtime: 'codex' }] });
  assert.deepEqual(current.budgets, budgets);
  // Объявление тех же budgets и любых prices: заменены только невалидные prices.
  assert.deepEqual(operationalDeclaration({ budgets, prices: [] }, current).differs, ['prices']);
});

test('Workspace declaration carries inputPolicy; the replaced local value reaches a running server by config-apply --keys inputPolicy', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'devcontour-declaration-input-')));
  let server: DevContour | undefined;
  try {
    const repo = join(root, 'product');
    const control = join(root, 'control');
    await mkdir(repo);
    await mkdir(control);
    await git(repo, 'init', '-b', 'main');
    const registryPath = join(control, 'workspace.json');
    const registry = {
      version: 1,
      name: 'Input policy',
      repositories: [{ id: 'product', name: 'Product', path: repo, profile: 'react-vite-admin' }],
      inputPolicy: { threshold: 4, criticalPaths: ['db/migrations'] },
    };
    // Та же схема, что в config.json: порог вне 1..11 — отказ до записи.
    await json(registryPath, { ...registry, inputPolicy: { threshold: 12 } });
    await assert.rejects(setupWorkspace(registryPath), /threshold/);
    assert.deepEqual(await readdir(control), ['workspace.json']);

    await json(registryPath, registry);
    const created = await setupWorkspace(registryPath);
    const configPath = created.config;
    assert.deepEqual(loadConfig(configPath).inputPolicy, registry.inputPolicy);
    assert.equal((await setupWorkspace(registryPath)).status, 'preserved');

    // Локальная правка порога заменяется объявлением при workspace-init.
    const stored = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    await json(configPath, { ...stored, inputPolicy: { threshold: 9 } });
    const updated = (await setupWorkspace(registryPath)) as {
      status: string;
      operational?: { replaced: string[]; note: string };
    };
    assert.equal(updated.status, 'declaration-updated');
    assert.deepEqual(updated.operational?.replaced, ['inputPolicy']);
    assert.match(updated.operational?.note ?? '', /config-apply --keys inputPolicy/);
    assert.deepEqual(loadConfig(configPath).inputPolicy, registry.inputPolicy);
    // Работающий сервер на этой конфигурации; новое объявление порога.
    const running = loadConfig(configPath);
    server = new DevContour(
      new Store(
        join(created.data, 'state.sqlite'),
        running.storage === 'component' ? repositories(running) : undefined,
      ),
      running,
    );
    assert.ok(server.leader('server'));
    server.recordConfig('server');
    const declared = { threshold: 3, criticalPaths: [] };
    await json(registryPath, { ...registry, inputPolicy: declared });
    const redeclared = (await setupWorkspace(registryPath)) as {
      operational?: { replaced: string[] };
    };
    assert.deepEqual(redeclared.operational?.replaced, ['inputPolicy']);
    // config-apply --keys inputPolicy: сервер применяет без перезапуска.
    let done = false;
    const pending = requestConfigApply(created.data, ['inputPolicy'], { waitMs: 5000 });
    pending.then(
      () => (done = true),
      () => (done = true),
    );
    while (!done) {
      server.leader('server');
      serveReconfigure(server, configPath, 'server');
      await new Promise((r) => setTimeout(r, 50));
    }
    const result = await pending;
    assert.equal(result.status, 'applied', JSON.stringify(result));
    assert.deepEqual(server.config.inputPolicy, declared);
  } finally {
    server?.store.close();
    await rm(root, { recursive: true, force: true });
  }
});
