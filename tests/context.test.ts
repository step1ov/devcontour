import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { AgentContext } from '../src/application/context.ts';
import { specDigest, Harness } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { config, fixture, input } from './helpers.ts';
import { repositorySchema } from '../src/core/model.ts';
import { git } from '../src/runner/process.ts';

test('Bounded briefing pages preserve multilingual contracts, reject stale and foreign cursors, omit runtime secrets', () => {
  const f = fixture();
  try {
    const api = new AgentContext(f.h),
      board = f.h.createBoard('Test board');
    const contract = f.h.contract('API', 'Договор 😀 '.repeat(3000));
    const task = f.h.addTask(board.id, { ...input(), contracts: [contract.id] });
    let cursor: string | undefined;
    let text = '';
    do {
      const result = api.execute('task_briefing', { taskId: task.id, limit: 50, cursor }) as any;
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024);
      text += result.items
        .filter((s: any) => s.kind === 'contract')
        .map((s: any) => s.text)
        .join('');
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(text, contract.content);
    const first = api.execute('task_briefing', { taskId: task.id, limit: 1 }) as any;
    const other = f.h.addTask(board.id, input('Other task'));
    assert.throws(
      () => api.execute('task_briefing', { taskId: other.id, cursor: first.nextCursor }),
      /cursor/,
    );
    f.h.editTask(task.id, { ...task, title: 'Updated task' }, specDigest(task));
    assert.throws(
      () => api.execute('task_briefing', { taskId: task.id, cursor: first.nextCursor }),
      /изменился/,
    );
    f.h.approve(board.id);
    f.h.pause(false);
    const run = f.h.claim('secret-owner')!;
    const before = api.execute('project_overview', { repositoryId: 'main' }) as any;
    f.h.heartbeat(run.id, run.token);
    const after = api.execute('project_overview', { repositoryId: 'main' }) as any;
    assert.equal(before.revision, after.revision);
    const briefing = JSON.stringify(api.execute('task_briefing', { taskId: task.id }));
    assert.ok(!briefing.includes(run.token));
    assert.ok(!briefing.includes('secret-owner'));
    assert.throws(() => api.execute('project_overview', { repositoryId: 'absent' }), /репозиторий/);
  } finally {
    f.cleanup();
  }
});

test('Progress explains dependency, pause, assignment and attempt constraints without claiming work', () => {
  const f = fixture();
  try {
    const api = new AgentContext(f.h),
      b = f.h.createBoard('Execution');
    const a = f.h.addTask(b.id, input('First task')),
      child = f.h.addTask(b.id, input('Dependent task', [a.id]));
    f.h.approve(b.id);
    const progress = (api.execute('task_briefing', { taskId: child.id }) as any).progress;
    assert.deepEqual(progress.dependencies, [a.id]);
    assert.deepEqual(progress.reasons, ['dependencies_incomplete', 'queue_paused']);
    f.store.change('fixture', (s) => {
      s.team = { member: 'alice' };
      s.tasks[0].assignee = 'bob';
      s.tasks[0].attempt = 3;
    });
    const reasons = (api.execute('task_briefing', { taskId: a.id }) as any).progress.reasons;
    assert.ok(reasons.includes('assigned_to_another_member'));
    assert.ok(reasons.includes('attempts_exhausted'));
    assert.equal(f.store.read().runs.length, 0);
  } finally {
    f.cleanup();
  }
});

test('Checkpoints stay with their component and cannot bypass completion or write through symlinks', () => {
  const f = fixture();
  let store: Store | undefined;
  try {
    const workspace = join(f.root, 'workspace');
    mkdirSync(workspace);
    const repos = ['product', 'library'].map((id) => {
      const path = join(f.root, id);
      mkdirSync(path);
      return repositorySchema.parse({ id, name: id, path, gates: f.h.config.gates });
    });
    store = new Store(join(workspace, 'state.sqlite'), repos);
    const h = new Harness(
        store,
        config({ storage: 'component', workspaceRoot: workspace, repositories: repos }),
      ),
      api = new AgentContext(h);
    const b = h.createBoard('Library private board', '', 'library');
    const task = h.addTask(b.id, {
      ...input('Library private task'),
      repositoryId: 'library',
      description: 'Private implementation instructions.',
    });
    const global = api.execute('project_overview', {}) as any;
    assert.equal(global.items.length, 0);
    const save = (repositoryId?: string) => {
      const overview = api.execute('project_overview', { repositoryId }) as any;
      return api.execute('checkpoint_save', {
        repositoryId,
        expectedRevision: overview.revision,
        summary: 'Session summary',
        nextStep: 'Continue investigation',
      }) as any;
    };
    const common = save();
    const local = save('library');
    assert.ok(local.path.startsWith(join(realpathSync(repos[1].path), '.devcontour/checkpoints')));
    const shared = readFileSync(common.path, 'utf8');
    assert.ok(!shared.includes(task.id));
    assert.ok(!shared.includes('Private implementation'));
    assert.equal(
      (
        api.execute('checkpoint_changes', {
          checkpointId: local.checkpointId,
          repositoryId: 'library',
        }) as any
      ).total,
      0,
    );
    h.editTask(task.id, { ...task, title: 'Library revised task' }, specDigest(task));
    const changes = api.execute('checkpoint_changes', {
      checkpointId: local.checkpointId,
      repositoryId: 'library',
    }) as any;
    assert.ok(
      changes.items.some((c: any) => c.key === 'task/' + task.id && c.change === 'modified'),
    );
    assert.equal(h.store.read().tasks[0].status, 'draft');
    assert.throws(
      () =>
        api.execute('checkpoint_save', {
          repositoryId: 'library',
          expectedRevision: local.revision,
          summary: 'Stale',
          nextStep: 'Wrong',
        }),
      /изменился/,
    );
    assert.equal(readdirSync(join(repos[1].path, '.devcontour/checkpoints')).length, 1);
    mkdirSync(join(repos[0].path, '.devcontour'));
    symlinkSync(
      join(repos[1].path, '.devcontour/checkpoints'),
      join(repos[0].path, '.devcontour/checkpoints'),
    );
    assert.throws(() => save('product'), /symlink/);
  } finally {
    store?.close();
    f.cleanup();
  }
});

test('Checkpoint survives a real Git clone; unrelated identity and forged IDs are rejected', async () => {
  const f = fixture();
  try {
    const repo = join(f.root, 'original');
    mkdirSync(repo);
    f.h.config.repository = repo;
    const api = new AgentContext(f.h),
      board = f.h.createBoard('Git context');
    f.h.addTask(board.id, input());
    const overview = api.execute('project_overview', { repositoryId: 'main' }) as any;
    const cp = api.execute('checkpoint_save', {
      repositoryId: 'main',
      expectedRevision: overview.revision,
      summary: 'Portable session context',
      nextStep: 'Review the plan',
    }) as any;
    await git(repo, 'init', '-b', 'main');
    await git(repo, 'config', 'user.email', 'fixture@example.invalid');
    await git(repo, 'config', 'user.name', 'Fixture');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'Checkpoint');
    const clone = join(f.root, 'clone');
    await git(f.root, 'clone', repo, clone);
    f.h.config.repository = clone;
    assert.equal(
      (
        api.execute('checkpoint_changes', {
          repositoryId: 'main',
          checkpointId: cp.checkpointId,
        }) as any
      ).total,
      0,
    );
    assert.ok(existsSync(join(clone, '.devcontour/context-identity.json')));
    writeFileSync(
      join(clone, '.devcontour/context-identity.json'),
      JSON.stringify({ version: 1, id: '00000000-0000-4000-8000-000000000000' }),
    );
    assert.throws(
      () =>
        api.execute('checkpoint_changes', { repositoryId: 'main', checkpointId: cp.checkpointId }),
      /другому контуру/,
    );
    assert.throws(() =>
      api.execute('checkpoint_changes', { repositoryId: 'main', checkpointId: '../../state' }),
    );
    rmSync(join(clone, '.devcontour/checkpoints'), { recursive: true });
  } finally {
    f.cleanup();
  }
});
