import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/runner/process.ts';
import { ProjectMemory } from '../src/application/memory.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { config } from './helpers.ts';
import { AgentContext } from '../src/application/context.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-memory-')),
    repo = join(root, 'repo');
  await mkdir(repo);
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Fixture');
  await git(repo, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repo, 'rules.md'), 'Pagination uses a cursor.\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'Initial source');
  const store = new Store(join(root, 'state.sqlite')),
    h = new DevContour(store, config({ repository: repo }));
  return {
    root,
    repo,
    h,
    store,
    memory: new ProjectMemory(h),
    cleanup: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test('Typed memory pins sources, rejects cross-owner links and excludes stale/conflicting derived summaries', async () => {
  const f = await fixture();
  try {
    const base = { repositoryId: 'main', subject: 'chat.pagination', sources: ['rules.md'] };
    const fact = f.memory.retain({
      ...base,
      kind: 'fact',
      text: 'Pagination uses a cursor.',
      entities: ['chat'],
    });
    const context = new AgentContext(f.h);
    const overview = context.execute('project_overview', { repositoryId: 'main' }) as any;
    const checkpoint = context.execute('checkpoint_save', {
      repositoryId: 'main',
      expectedRevision: overview.revision,
      summary: 'Cursor decision',
      nextStep: 'Use cursor pagination',
    }) as any;
    const summary = f.memory.retain({
      repositoryId: 'main',
      kind: 'summary',
      subject: 'chat.overview',
      text: 'Chat pagination overview',
      supports: [fact.id],
    });
    const first = f.memory.recall({ repositoryId: 'main', query: 'pagination' });
    assert.equal(first.records.length, 2);
    assert.ok(first.usedBytes <= 8000);
    assert.equal(first.usedBytes, Buffer.byteLength(JSON.stringify(first.records)));
    assert.equal(f.memory.recall({ repositoryId: 'main', maxBytes: 1 }).records.length, 0);
    assert.throws(
      () => f.memory.retain({ ...base, kind: 'summary', text: 'No source summary' }),
      /supports/,
    );
    assert.throws(
      () =>
        f.memory.retain({
          ...base,
          kind: 'fact',
          text: 'Invalid support',
          supports: ['00000000-0000-4000-8000-000000000001'],
        }),
      /владельцу/,
    );
    const conflict = f.memory.retain({ ...base, kind: 'fact', text: 'Pagination uses an offset.' });
    const disputed = f.memory.recall({ repositoryId: 'main' });
    assert.equal(disputed.records.length, 0);
    assert.equal(disputed.excluded.conflicting, 2);
    assert.equal(disputed.excluded.stale, 1);
    const replacement = f.memory.retain({
      ...base,
      kind: 'fact',
      text: 'Pagination uses a cursor.',
      supersedes: [fact.id, conflict.id],
    });
    assert.deepEqual(
      f.memory.recall({ repositoryId: 'main' }).records.map((r) => r.record.id),
      [replacement.id],
    );
    await writeFile(join(f.repo, 'rules.md'), 'Pagination uses an offset.\n');
    await git(f.repo, 'add', 'rules.md');
    await git(f.repo, 'commit', '-m', 'Change protocol');
    const changes = context.execute('checkpoint_changes', {
      repositoryId: 'main',
      checkpointId: checkpoint.checkpointId,
    }) as any;
    assert.ok(
      changes.items.some(
        (item: any) => item.kind === 'knowledge' || item.key?.startsWith('knowledge'),
      ),
    );
    assert.equal(f.memory.recall({ repositoryId: 'main' }).records.length, 0);
    const historical = f.memory.recall({ repositoryId: 'main', includeUncertain: true });
    assert.ok(historical.records.find((r) => r.record.id === summary.id)?.status === 'stale');
    f.memory.retain({
      repositoryId: 'main',
      kind: 'hypothesis',
      subject: 'performance',
      text: 'Possible index issue',
    });
    assert.equal(f.memory.recall({ repositoryId: 'main', query: 'index' }).records.length, 0);
    assert.equal(
      f.memory.recall({ repositoryId: 'main', query: 'index', includeUncertain: true }).records[0]
        .status,
      'ungrounded',
    );
  } finally {
    await f.cleanup();
  }
});
test('Memory survives independent Git clones and merges; source edits and owner changes stay visible', async () => {
  const f = await fixture();
  const stores: Store[] = [];
  try {
    f.memory.retain({
      repositoryId: 'main',
      kind: 'decision',
      subject: 'pagination',
      text: 'Use cursors',
      sources: ['rules.md'],
    });
    await git(f.repo, 'add', '.devcontour');
    await git(f.repo, 'commit', '-m', 'Share initial memory identity');
    const memories: ProjectMemory[] = [],
      paths: string[] = [];
    for (const name of ['alice', 'bob']) {
      const path = join(f.root, name);
      await git(f.root, 'clone', f.repo, path);
      await git(path, 'config', 'user.name', name);
      await git(path, 'config', 'user.email', name + '@example.invalid');
      const store = new Store(join(f.root, name + '.sqlite'));
      stores.push(store);
      paths.push(path);
      memories.push(new ProjectMemory(new DevContour(store, config({ repository: path }))));
    }
    const alice = memories[0].retain({
      repositoryId: 'main',
      kind: 'experience',
      subject: 'alice',
      text: 'Alice observed cursor behavior',
      sources: ['rules.md'],
    });
    const bob = memories[1].retain({
      repositoryId: 'main',
      kind: 'experience',
      subject: 'bob',
      text: 'Bob verified pagination response',
      sources: ['rules.md'],
    });
    for (const path of paths) {
      await git(path, 'add', '.devcontour');
      await git(path, 'commit', '-m', 'Append local knowledge');
    }
    await git(paths[0], 'fetch', paths[1], 'main');
    await git(paths[0], 'merge', '--no-edit', 'FETCH_HEAD');
    const records = memories[0].recall({ repositoryId: 'main' }).records;
    assert.equal(records.length, 3);
    assert.ok(records.some((r) => r.record.id === alice.id));
    assert.ok(records.some((r) => r.record.id === bob.id));
    const raw = JSON.parse(await readFile(alice.path, 'utf8'));
    raw.repositoryId = 'foreign';
    await writeFile(alice.path, JSON.stringify(raw));
    assert.throws(() => memories[0].recall({ repositoryId: 'main' }), /owner/);
    await rm(alice.path);
    await symlink(join(f.repo, 'rules.md'), alice.path);
    assert.throws(() => memories[0].recall({ repositoryId: 'main' }), /symlink/);
  } finally {
    stores.forEach((s) => s.close());
    await f.cleanup();
  }
});
