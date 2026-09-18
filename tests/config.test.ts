import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profile } from '../src/runner/packs.ts';
import { config } from './helpers.ts';
import { loadConfig } from '../src/runner/config.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('Every pinned profile has an executable test gate and mobile limits concurrency', async () => {
  for (const id of [
    'react-vite-admin',
    'next-product',
    'go-api',
    'mobile-maestro',
    'python-api',
    'nest-api',
    'react-native',
    'expo-mobile',
  ]) {
    const pack = await profile(id);
    assert.equal(pack.id, id);
    assert.equal(pack.digest.length, 64);
    assert.ok(pack.gates.some((g) => g.kind === 'test' && g.report?.type === 'junit'));
    if (['mobile-maestro', 'react-native', 'expo-mobile'].includes(id))
      assert.equal(pack.concurrency, 1);
  }
  await assert.rejects(profile('../secret'));
});
test('Local config rejects same-runtime self-review, demo adapters and escaping reports', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-config-'));
  try {
    const file = join(root, 'config.json');
    let c = config({ repository: root, mode: 'local' });
    writeFileSync(file, JSON.stringify(c));
    assert.throws(() => loadConfig(file), /Demo/);
    c = config({ repository: root });
    c.gates[0].report!.path = '../outside.xml';
    writeFileSync(file, JSON.stringify(c));
    assert.throws(() => loadConfig(file), /внутри worktree/);
    c = config({
      repository: root,
      mode: 'local',
      roles: {
        architect: { runtime: 'codex' },
        backend: { runtime: 'codex' },
        frontend: { runtime: 'codex' },
        qa: { runtime: 'codex' },
      },
      reviewer: { runtime: 'codex' },
    });
    writeFileSync(file, JSON.stringify(c));
    assert.throws(() => loadConfig(file), /другой runtime/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
