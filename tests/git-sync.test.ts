import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/core/store.ts';
import { DevContour, digest, specDigest } from '../src/core/service.ts';
import { recordsFromState } from '../src/core/sync-state.ts';
import { canonical } from '../src/core/sync-model.ts';
import { syncGit, assertTeamCheckout } from '../src/runner/git-sync.ts';
import { repositories } from '../src/core/repositories.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { repositorySchema } from '../src/core/model.ts';
import { config, input } from './helpers.ts';

const git = (path: string, ...args: string[]) =>
  execFileSync('git', ['-C', path, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Sync Test',
      GIT_AUTHOR_EMAIL: 'sync@example.test',
      GIT_COMMITTER_NAME: 'Sync Test',
      GIT_COMMITTER_EMAIL: 'sync@example.test',
    },
  }).trim();
interface Peer {
  repo: string;
  workspace: string;
  store: Store;
  h: DevContour;
  commit(): void;
  pull(): void;
}
function peer(root: string, name: string, source?: Peer): Peer {
  const base = join(root, name),
    workspace = join(base, 'workspace'),
    repo = join(base, 'product');
  mkdirSync(base);
  for (const [path, from] of [
    [workspace, source?.workspace],
    [repo, source?.repo],
  ]) {
    if (from) git(base, 'clone', '--no-local', from, path!);
    else {
      mkdirSync(path!);
      git(path!, 'init', '-b', 'main');
      writeFileSync(join(path!, '.gitignore'), '.devcontour-local/\n');
      writeFileSync(join(path!, 'README.md'), 'A test repository.\n');
      git(path!, 'add', '.');
      git(path!, 'commit', '-m', 'baseline');
    }
    git(path!, 'config', 'user.name', 'Sync Test');
    git(path!, 'config', 'user.email', 'sync@example.test');
  }
  const c = config({ repository: repo, workspaceRoot: workspace, storage: 'component' });
  const store = new Store(join(workspace, '.devcontour-local/state.sqlite'), repositories(c));
  const h = new DevContour(store, c);
  return {
    repo,
    workspace,
    store,
    h,
    commit() {
      for (const path of [repo, workspace]) {
        git(path, 'add', '.devcontour');
        if (git(path, 'diff', '--cached', '--name-only'))
          git(path, 'commit', '-m', 'Sync development state');
      }
    },
    pull() {
      for (const path of [repo, workspace]) git(path, 'pull', '--ff-only');
    },
  };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-sync-'));
  const peers: ReturnType<typeof peer>[] = [];
  return {
    root,
    create(name: string, source?: ReturnType<typeof peer>) {
      const p = peer(root, name, source);
      peers.push(p);
      return p;
    },
    cleanup() {
      for (const p of peers) p.store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function edit(p: ReturnType<typeof peer>, id: string, changes: object) {
  const t = p.store.read().tasks.find((t) => t.id === id)!;
  p.h.editTask(id, { ...t, ...changes }, specDigest(t));
}
function rewrite(path: string, change: (value: any) => void) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  change(value);
  writeFileSync(path, canonical(value));
}

test('Requirement bindings sync between independent clones and remain in the component', () => {
  const f = fixture();
  try {
    const a = f.create('requirements-a');
    syncGit(a.h, { member: 'alice' });
    const board = a.h.createBoard('Requirement links', '', 'main');
    const text = '## REQ-search: Search\nSearch existing messages.';
    const requirements = [
      {
        id: 'REQ-search',
        source: 'docs/spec.md',
        text,
        digest: digest(text),
        gate: 'test',
        scenario: 'Search messages',
      },
    ];
    const task = a.h.addTask(board.id, { ...input(), requirements });
    syncGit(a.h);
    a.commit();
    const db = new DatabaseSync(join(a.workspace, '.devcontour-local/state.sqlite'));
    try {
      assert.ok(
        !JSON.stringify(db.prepare('SELECT data FROM state').all()).includes(
          'Search existing messages',
        ),
      );
    } finally {
      db.close();
    }
    const b = f.create('requirements-b', a);
    syncGit(b.h, { member: 'bob' });
    assert.deepEqual(
      b.store.read().tasks.find((t) => t.id === task.id)!.requirements,
      requirements,
    );
    assert.ok(
      readFileSync(join(b.repo, '.devcontour/tasks', task.id + '.json'), 'utf8').includes(
        'REQ-search',
      ),
    );
  } finally {
    f.cleanup();
  }
});
function complete(p: ReturnType<typeof peer>, id: string) {
  p.h.approve(p.store.read().boards[0].id);
  p.h.pause(false);
  const r = p.h.claim('worker')!;
  assert.equal(r.taskId, id);
  const sha = git(p.repo, 'rev-parse', 'HEAD');
  p.h.phase(r.id, r.token, 'integrating', { candidateSha: sha, integrationSha: sha });
  for (const phase of ['candidate', 'integration'] as const)
    for (const kind of ['test', 'review'] as const)
      p.h.evidence(r.id, r.token, {
        kind,
        phase,
        sha,
        gate: kind === 'test' ? 'test' : 'independent-review',
        passed: true,
        exitCode: 0,
        command: ['fixture'],
        log: '/private/local/log',
        digest: digest('verified fixture'),
        summary: 'fixture',
      });
  p.h.finish(r.id, r.token, sha);
  p.h.pause(true);
  return r;
}

test('Git state restores a new component DB; baselines and task bodies stay in their owner repository', () => {
  const f = fixture();
  try {
    const a = f.create('alice');
    const b = a.h.createBoard('Component board', '', 'main');
    const t = a.h.addTask(b.id, input('Private component task'));
    a.h.assign(t.id, 'alice');
    const report = syncGit(a.h, { member: 'alice' });
    assert.equal(report.status, 'synchronized');
    a.commit();
    assert.ok(readdirSync(join(a.repo, '.devcontour/tasks')).includes(t.id + '.json'));
    assert.ok(
      !readFileSync(join(a.workspace, '.devcontour/identity.json'), 'utf8').includes(t.title),
    );
    const main = new DatabaseSync(join(a.workspace, '.devcontour-local/state.sqlite'));
    assert.ok(!JSON.stringify(main.prepare('SELECT * FROM git_sync').all()).includes(t.title));
    main.close();
    const before = readFileSync(join(a.repo, '.devcontour/tasks', t.id + '.json'), 'utf8');
    assert.deepEqual(syncGit(a.h).changes, []);
    assert.equal(readFileSync(join(a.repo, '.devcontour/tasks', t.id + '.json'), 'utf8'), before);
    const bob = f.create('bob', a);
    syncGit(bob.h, { member: 'bob' });
    assert.equal(bob.store.read().tasks[0].id, t.id);
    assert.equal(bob.store.read().team?.member, 'bob');
    assert.deepEqual(bob.store.read().runs, []);
    assert.equal(bob.store.read().leader, undefined);
    assert.ok(
      !readFileSync(join(a.repo, '.devcontour/tasks', t.id + '.json'), 'utf8').includes(
        'leaseUntil',
      ),
    );
  } finally {
    f.cleanup();
  }
});

test('Two clones add tasks to the same board and merge different fields without losing either change', () => {
  const f = fixture();
  try {
    const a = f.create('alice'),
      board = a.h.createBoard('Shared board', '', 'main');
    const seed = a.h.addTask(board.id, input('Original task'));
    syncGit(a.h, { member: 'alice' });
    a.commit();
    const b = f.create('bob', a);
    syncGit(b.h, { member: 'bob' });
    const ta = a.h.addTask(board.id, input('Alice task'));
    const tb = b.h.addTask(board.id, input('Bob task'));
    assert.notEqual(ta.id, tb.id);
    edit(a, seed.id, { title: 'Title by Alice' });
    edit(b, seed.id, { description: 'Description supplied independently by Bob.' });
    syncGit(a.h);
    a.commit();
    b.pull();
    assert.throws(() => assertTeamCheckout(b.h), /context изменился/);
    syncGit(b.h);
    const state = b.store.read();
    assert.equal(state.tasks.length, 3);
    assert.equal(state.tasks.find((t) => t.id === seed.id)!.title, 'Title by Alice');
    assert.match(state.tasks.find((t) => t.id === seed.id)!.description, /Bob/);
    assert.deepEqual(
      new Set(state.boards[0].revisions[0].taskIds),
      new Set([seed.id, ta.id, tb.id]),
    );
    assertTeamCheckout(b.h);
    assert.deepEqual(syncGit(b.h).changes, []);
  } finally {
    f.cleanup();
  }
});

test('Conflicting edits require an explicit choice, and conflict detection leaves DB and files unchanged', () => {
  const f = fixture();
  try {
    const a = f.create('alice'),
      board = a.h.createBoard('Shared board', '', 'main');
    const t = a.h.addTask(board.id, input());
    syncGit(a.h, { member: 'alice' });
    a.commit();
    const b = f.create('bob', a);
    syncGit(b.h, { member: 'bob' });
    edit(a, t.id, { title: 'Title by Alice' });
    edit(b, t.id, { title: 'Title by Bob' });
    syncGit(a.h);
    a.commit();
    b.pull();
    const before = canonical(b.store.read());
    const file = join(b.repo, '.devcontour/tasks', t.id + '.json'),
      disk = readFileSync(file, 'utf8');
    const report = syncGit(b.h, { dryRun: true });
    assert.equal(report.status, 'conflict');
    assert.match(report.conflicts[0].reason, /title/);
    assert.throws(() => syncGit(b.h), /conflicts/);
    assert.equal(canonical(b.store.read()), before);
    assert.equal(readFileSync(file, 'utf8'), disk);
    syncGit(b.h, { resolutions: { ['main/tasks/' + t.id]: 'git' } });
    assert.equal(b.store.read().tasks[0].title, 'Title by Alice');
  } finally {
    f.cleanup();
  }
});

test('Peer completion needs a committed receipt and present Git result; it never restores a live run', () => {
  const f = fixture();
  try {
    const a = f.create('alice'),
      board = a.h.createBoard('Completed board', '', 'main');
    const task = a.h.addTask(board.id, input());
    complete(a, task.id);
    a.h.accept(board.id, git(a.repo, 'rev-parse', 'HEAD'));
    syncGit(a.h, { member: 'alice' });
    a.commit();
    const b = f.create('bob', a);
    syncGit(b.h, { member: 'bob' });
    const t = b.store.read().tasks[0];
    assert.equal(t.status, 'done');
    assert.ok(t.sharedCompletion?.sourceCommit);
    assert.equal(b.store.read().boards[0].revisions[0].status, 'accepted');
    assert.equal(b.store.read().runs.length, 0);
    assert.equal(t.activeRunId, undefined);
    assert.ok(
      !JSON.stringify(recordsFromState(b.h, b.store.read()).get('main')).includes('/private/local'),
    );
    assert.deepEqual(syncGit(b.h).changes, []);
    const corrected = b.h.correct(
      board.id,
      [task.id],
      'Change the accepted behavior for the next version.',
    );
    const replacement = b.store.read().tasks.find((t) => t.id === corrected.replacements[task.id])!;
    assert.equal(replacement.sharedCompletion, undefined);
    syncGit(b.h);
  } finally {
    f.cleanup();
  }
});

test('Broken receipts, absent commits, graph cycles, deleted history and forged done all roll back', () => {
  const f = fixture();
  try {
    const a = f.create('alice'),
      board = a.h.createBoard('Completed board', '', 'main');
    const t = a.h.addTask(board.id, input());
    complete(a, t.id);
    syncGit(a.h, { member: 'alice' });
    a.commit();
    const b = f.create('bob', a),
      before = canonical(b.store.read());
    const receipt = join(
      b.repo,
      '.devcontour/receipts',
      readdirSync(join(b.repo, '.devcontour/receipts'))[0],
    );
    const original = readFileSync(receipt, 'utf8');
    rewrite(receipt, (r) => {
      r.data.checks[0].passed = false;
    });
    assert.throws(() => syncGit(b.h, { member: 'bob' }), /Нет PASS/);
    assert.equal(canonical(b.store.read()), before);
    writeFileSync(receipt, original);
    rewrite(receipt, (r) => {
      r.data.resultSha = 'f'.repeat(40);
      r.data.checks
        .filter((c: any) => c.phase === 'integration')
        .forEach((c: any) => {
          c.sha = 'f'.repeat(40);
        });
    });
    assert.throws(() => syncGit(b.h, { member: 'bob' }));
    assert.equal(canonical(b.store.read()), before);
    writeFileSync(receipt, original);
    syncGit(b.h, { member: 'bob' });
    rmSync(join(b.repo, '.devcontour/tasks', t.id + '.json'));
    assert.throws(() => syncGit(b.h), /Удаление истории/);
    git(b.repo, 'restore', '.devcontour');
    const board2 = b.h.createBoard('Draft board', '', 'main');
    const first = b.h.addTask(board2.id, input('First task')),
      second = b.h.addTask(board2.id, input('Second task', [first.id]));
    syncGit(b.h);
    const file = join(b.repo, '.devcontour/tasks', first.id + '.json');
    rewrite(file, (r) => {
      r.data.dependsOn = [second.id];
    });
    assert.throws(() => syncGit(b.h), /Цикл/);
    rewrite(file, (r) => {
      r.data.dependsOn = [];
      r.progress.status = 'done';
    });
    assert.throws(() => syncGit(b.h), /Нет утверждённой постановки/);
  } finally {
    f.cleanup();
  }
});

test('Team member filters claims; sync rejects active work, branch switches and symlinks', () => {
  const f = fixture();
  try {
    const a = f.create('alice'),
      board = a.h.createBoard('Assigned board', '', 'main');
    const other = a.h.addTask(board.id, { ...input('Task for Bob'), assignee: 'bob' });
    const mine = a.h.addTask(board.id, { ...input('Task for Alice'), assignee: 'alice' });
    syncGit(a.h, { member: 'alice' });
    a.h.approve(board.id);
    a.h.pause(false);
    const run = a.h.claim('worker')!;
    assert.equal(run.taskId, mine.id);
    assert.equal(a.h.claim('worker'), undefined);
    assert.throws(() => syncGit(a.h), /приостановите/);
    a.h.pause(true);
    assert.throws(() => syncGit(a.h), /активные/);
    a.h.cancel(mine.id);
    syncGit(a.h);
    a.commit();
    git(a.repo, 'switch', '-c', 'feature/team');
    assert.throws(() => assertTeamCheckout(a.h), /context изменился/);
    assert.throws(() => syncGit(a.h), /Ветка изменилась/);
    syncGit(a.h, { allowBranchChange: true });
    a.h.assign(other.id, 'alice');
    const file = join(a.repo, '.devcontour/tasks', other.id + '.json');
    rmSync(file);
    symlinkSync(join(a.repo, 'README.md'), file);
    assert.throws(() => syncGit(a.h), /symlink/);
  } finally {
    f.cleanup();
  }
});

test('Real runner checks and integration survive Git transfer without reusing local workers', async () => {
  const f = fixture();
  let scheduler: Scheduler | undefined;
  try {
    const a = f.create('alice');
    writeFileSync(join(a.repo, '.gitignore'), '.devcontour-local/\n.reports/\n');
    writeFileSync(
      join(a.repo, 'verify.mjs'),
      `import {writeFileSync,readdirSync} from 'node:fs'; if (!readdirSync('deliverables').length) process.exit(1); writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite><testcase name="deliverable"/></testsuite>');`,
    );
    git(a.repo, 'add', '.gitignore', 'verify.mjs');
    git(a.repo, 'commit', '-m', 'Real test gate');
    syncGit(a.h, { member: 'alice' });
    const board = a.h.createBoard('Actual runner board', '', 'main');
    const task = a.h.addTask(board.id, input());
    a.h.approve(board.id);
    syncGit(a.h);
    a.commit();
    scheduler = new Scheduler(a.h, join(a.workspace, '.devcontour-local'));
    await scheduler.init();
    a.h.pause(false);
    await scheduler.drain();
    await scheduler.stop();
    const result = a.store.read().tasks[0];
    assert.equal(result.status, 'done', result.failure);
    git(a.repo, 'merge', '--ff-only', 'devcontour/accepted');
    syncGit(a.h);
    a.commit();
    const b = f.create('bob', a);
    syncGit(b.h, { member: 'bob' });
    const restored = b.store.read().tasks.find((t) => t.id === task.id)!;
    assert.equal(restored.status, 'done');
    assert.equal(restored.resultSha, result.resultSha);
    assert.equal(restored.sharedCompletion!.receipt.checks.length, 4);
    assert.equal(b.store.read().runs.length, 0);
  } finally {
    await scheduler?.stop();
    f.cleanup();
  }
});

test('Shared graph references component tasks without exporting their bodies into workspace Git or baseline', () => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-multi-sync-'));
  let store: Store | undefined;
  try {
    const workspace = join(root, 'workspace');
    const paths = ['workspace', 'library', 'product'].map((id) => join(root, id));
    for (const path of paths) {
      mkdirSync(path);
      git(path, 'init', '-b', 'main');
      writeFileSync(join(path, '.gitignore'), '.devcontour-local/\n');
      git(path, 'add', '.gitignore');
      git(path, 'commit', '-m', 'baseline');
    }
    const repos = ['library', 'product'].map((id) =>
      repositorySchema.parse({
        id,
        name: id,
        path: join(root, id),
        kind: id,
        gates: config().gates,
      }),
    );
    const c = config({
      workspaceRoot: workspace,
      repository: repos[1].path,
      repositories: repos,
      storage: 'component',
    });
    store = new Store(join(workspace, '.devcontour-local/state.sqlite'), repos);
    const h = new DevContour(store, c),
      board = h.createBoard('Joint change');
    const library = h.addTask(board.id, {
      ...input('Private library requirement'),
      repositoryId: 'library',
    });
    h.addTask(board.id, {
      ...input('Private product requirement', [library.id]),
      repositoryId: 'product',
    });
    h.addTask(board.id, {
      ...input('Joint acceptance'),
      repositoryId: 'product',
      scope: 'workspace',
      relatedRepositories: ['library', 'product'],
    });
    syncGit(h, { member: 'alice' });
    const workspaceRecords = readdirSync(join(workspace, '.devcontour/tasks'))
      .map((file) => readFileSync(join(workspace, '.devcontour/tasks', file), 'utf8'))
      .join('');
    assert.ok(!workspaceRecords.includes('Private library requirement'));
    assert.ok(!workspaceRecords.includes('Private product requirement'));
    assert.match(workspaceRecords, /Joint acceptance/);
    assert.ok(!canonical(store.syncBaseline()).includes('Private library requirement'));
    assert.match(canonical(store.syncBaseline('library')), /Private library requirement/);
    assert.equal(syncGit(h).changes.length, 0);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('An initially empty shared board keeps its Git owner after tasks are added', () => {
  const f = fixture();
  try {
    const a = f.create('alice'),
      board = a.h.createBoard('Initially empty board');
    syncGit(a.h, { member: 'alice' });
    a.h.addTask(board.id, input());
    syncGit(a.h);
    assert.equal(a.store.read().boards[0].scope, 'workspace');
    assert.ok(
      readFileSync(join(a.workspace, '.devcontour/boards', board.id + '.json'), 'utf8').includes(
        board.title,
      ),
    );
    assert.deepEqual(syncGit(a.h).changes, []);
  } finally {
    f.cleanup();
  }
});

test('An unresolved real Git merge conflict blocks synchronization before touching local state', () => {
  const f = fixture();
  try {
    const a = f.create('alice'),
      board = a.h.createBoard('Conflict board', '', 'main');
    const t = a.h.addTask(board.id, input());
    syncGit(a.h, { member: 'alice' });
    a.commit();
    const b = f.create('bob', a);
    syncGit(b.h, { member: 'bob' });
    edit(a, t.id, { title: 'Title from Alice' });
    syncGit(a.h);
    a.commit();
    edit(b, t.id, { title: 'Title from Bob' });
    syncGit(b.h);
    b.commit();
    assert.throws(() => git(b.repo, 'pull', '--no-rebase'));
    const before = canonical(b.store.read());
    assert.throws(() => syncGit(b.h), /Git merge conflicts/);
    assert.equal(canonical(b.store.read()), before);
  } finally {
    f.cleanup();
  }
});

test('CLI exposes sync, status and assignment against an explicit workspace', () => {
  const f = fixture();
  try {
    const a = f.create('alice'),
      board = a.h.createBoard('CLI board', '', 'main');
    const t = a.h.addTask(board.id, input());
    writeFileSync(join(a.workspace, '.devcontour-local/config.json'), JSON.stringify(a.h.config));
    const cli = (...args: string[]) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          ['--import', 'tsx', 'src/cli.ts', ...args, '--workspace', a.workspace],
          {
            cwd: new URL('../', import.meta.url).pathname,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 30000,
          },
        ),
      );
    assert.equal(cli('sync', '--member', 'alice').status, 'synchronized');
    cli('assign-task', '--task', t.id, '--member', 'alice');
    assert.equal(a.store.read().tasks[0].assignee, 'alice');
    assert.equal(cli('sync-status').changes.length, 1);
    cli('sync');
    assert.equal(cli('sync-status').changes.length, 0);
  } finally {
    f.cleanup();
  }
});
