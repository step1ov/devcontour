import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { digest } from '../src/core/service.ts';
import { recordsFromState } from '../src/core/sync-state.ts';
import { canonical } from '../src/core/sync-model.ts';
import { syncGit, assertTeamCheckout } from '../src/runner/git-sync.ts';
import { input } from './helpers.ts';
import { complete, edit, fixture, git, rewrite } from './git-sync-fixture.ts';

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

test('Синхронизация не возрождает задачу, отменённую в ревизии, которую другой clone уже принял', () => {
  const f = fixture();
  try {
    const a = f.create('alice'),
      board = a.h.createBoard('Release board', '', 'main');
    const kept = a.h.addTask(board.id, input('Kept task'));
    const dropped = a.h.addTask(board.id, input('Dropped task'));
    a.h.approve(board.id);
    a.h.cancel(dropped.id, 'Решено в другой задаче');
    complete(a, kept.id);
    syncGit(a.h, { member: 'alice' });
    a.commit();
    const b = f.create('bob', a);
    syncGit(b.h, { member: 'bob' });
    // Alice ещё не знает о приёмке и законно возвращает отменённую задачу.
    a.h.retry(dropped.id);
    syncGit(a.h);
    a.commit();
    // Bob тем временем принимает ревизию, затем получает коммит Alice.
    b.h.accept(board.id, git(b.repo, 'rev-parse', 'HEAD'));
    b.pull();
    const before = canonical(b.store.read());
    assert.throws(() => syncGit(b.h), /изменилась после приёмки/);
    assert.equal(canonical(b.store.read()), before);
  } finally {
    f.cleanup();
  }
});

test('Импорт одобрения постановки одним runtime следует настроенному правилу вендора ревью плана', () => {
  const f = fixture();
  try {
    // Постановку агент утверждает ревью плана: правило — `review.plan`.
    const sameVendor = {
      plan: { reviewer: { runtime: 'claude' as const }, vendor: 'same-vendor-allowed' as const },
    };
    const a = f.create('alice');
    a.h.config.review = sameVendor;
    const board = a.h.createBoard('Same-vendor board', '', 'main');
    const t = a.h.addTask(board.id, input());
    a.h.approve(board.id, undefined, {
      actor: 'agent',
      authorRuntime: 'claude',
      reviewerRuntime: 'claude',
    });
    syncGit(a.h, { member: 'alice' });
    a.commit();
    const b = f.create('bob', a),
      before = canonical(b.store.read());
    const rejected = (review: typeof b.h.config.review) => {
      b.h.config.review = review;
      assert.throws(() => syncGit(b.h, { member: 'bob' }), /Нет независимого согласования/);
      assert.equal(canonical(b.store.read()), before);
    };
    // Правило по умолчанию: ревьюер другого вендора.
    rejected(undefined);
    // Тот же ревьюер, но вендор должен отличаться.
    rejected({ plan: { reviewer: { runtime: 'claude' }, vendor: 'different-vendor' } });
    // Тот же вендор разрешён, но правило выбирает другого ревьюера.
    rejected({ plan: { reviewer: { runtime: 'codex' }, vendor: 'same-vendor-allowed' } });
    // Ревью контрактов задачу не утверждает: его правило не в счёт.
    rejected({ contract: { reviewer: { runtime: 'claude' }, vendor: 'same-vendor-allowed' } });

    b.h.config.review = sameVendor;
    syncGit(b.h, { member: 'bob' });
    const imported = b.store.read().tasks.find((x) => x.id === t.id)!;
    assert.equal(imported.status, 'ready');
    assert.equal(imported.approval?.actor, 'agent');
    assert.equal(imported.approval?.authorRuntime, 'claude');
    assert.equal(imported.approval?.reviewerRuntime, 'claude');

    // Правило читается при каждом импорте: возврат к другому вендору снова
    // отклоняет то же одобрение.
    const afterImport = canonical(b.store.read());
    b.h.config.review = { plan: { reviewer: { runtime: 'claude' }, vendor: 'different-vendor' } };
    assert.throws(() => syncGit(b.h, { member: 'bob' }), /Нет независимого согласования/);
    assert.equal(canonical(b.store.read()), afterImport);
  } finally {
    f.cleanup();
  }
});

test('Отмена, полученная синхронизацией, не наследует устаревшего актёра отмены ведущим', () => {
  const f = fixture();
  try {
    const a = f.create('alice'),
      board = a.h.createBoard('Release board', '', 'main');
    const shared = a.h.addTask(board.id, input('Shared task'));
    a.h.approve(board.id);
    syncGit(a.h, { member: 'alice' });
    a.commit();
    const b = f.create('bob', a);
    syncGit(b.h, { member: 'bob' });
    // У Bob устаревший актёр прежней отмены ведущим (повтор прежней версии его не снял).
    b.store.change('fixture.stale', (s) => {
      s.tasks.find((t) => t.id === shared.id)!.cancelledBy = 'host';
    });
    a.h.cancel(shared.id, 'Решено в другой задаче', 'operator');
    syncGit(a.h);
    a.commit();
    b.pull();
    syncGit(b.h);
    const task = b.store.read().tasks.find((t) => t.id === shared.id)!;
    assert.equal(task.status, 'cancelled');
    assert.equal(task.cancelledBy, undefined);
  } finally {
    f.cleanup();
  }
});

test('Впервые полученная приёмка сверяется с манифестом, а не со своими задачами', () => {
  const f = fixture();
  try {
    const a = f.create('alice'),
      board = a.h.createBoard('Release board', '', 'main');
    const kept = a.h.addTask(board.id, input('Kept task'));
    const dropped = a.h.addTask(board.id, input('Dropped task'));
    a.h.approve(board.id);
    a.h.cancel(dropped.id, 'Решено в другой задаче');
    complete(a, kept.id);
    syncGit(a.h, { member: 'alice' });
    a.commit();
    const b = f.create('bob', a);
    syncGit(b.h, { member: 'bob' });
    // Bob ещё не знает о приёмке: возвращает отменённую задачу и доводит её до done.
    b.h.retry(dropped.id);
    b.h.assign(dropped.id, 'bob');
    complete(b, dropped.id);
    // Alice принимает ревизию со снимком [kept] и публикует приёмку.
    a.h.accept(board.id, git(a.repo, 'rev-parse', 'HEAD'));
    syncGit(a.h);
    a.commit();
    b.pull();
    const before = canonical(b.store.read());
    assert.throws(() => syncGit(b.h), /расходится с манифестом приёмки/);
    assert.equal(canonical(b.store.read()), before);
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
