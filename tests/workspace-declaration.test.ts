import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/runner/config.ts';
import { git } from '../src/runner/process.ts';
import { setupWorkspace } from '../src/runner/workspace-setup.ts';

const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value) + '\n');

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
