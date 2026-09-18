import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, input } from './helpers.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import { Store } from '../src/core/store.ts';
import { DevContour, specDigest } from '../src/core/service.ts';
import { setupDemo } from '../src/demo.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Workspace } from '../src/core/workspace.ts';
import { Scheduler } from '../src/runner/scheduler.ts';

test('Workflow enqueue is idempotent, expired owners are fenced and changed inputs become stale', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Durable workflow', '', 'main'),
      t = f.h.addTask(b.id, input());
    const flow = new LeadWorkflow(f.h),
      request = { kind: 'board', id: b.id, authorRuntime: 'codex', maxAttempts: 2 };
    const job = flow.start(request);
    assert.equal(flow.start(request).key, job.key);
    const first = flow.claim(job.key, 'main')!;
    assert.equal(flow.claim(job.key, 'main'), undefined);
    f.store.atomic(() => f.store.saveLocal('lead', 'main', job.key, { ...first, leaseUntil: 0 }));
    const replacement = flow.claim(job.key, 'main')!;
    assert.notEqual(first.token, replacement.token);
    assert.throws(() => flow.finish(first), /lease/);
    flow.finish(replacement);
    assert.equal(flow.get(job.key, 'main').stage, 1);
    f.h.editTask(
      t.id,
      { ...input(), description: 'A changed requirement invalidates pending work.' },
      specDigest(t),
    );
    assert.equal(flow.claim(job.key, 'main'), undefined);
    assert.equal(flow.get(job.key, 'main').status, 'stale');
    assert.notEqual(flow.start(request).key, job.key);
  } finally {
    f.cleanup();
  }
});

test('Atomic local event and domain changes roll back together', () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        f.store.atomic(() => {
          f.h.createBoard('Should roll back');
          f.store.saveLocal('signals', 'main', 'key', { received: true });
          throw new Error('Crash before commit');
        }),
      /Crash/,
    );
    assert.equal(f.store.read().boards.length, 0);
    assert.equal(f.store.allEvents().length, 0);
    assert.deepEqual(f.store.localRecords('signals', 'main'), {});
  } finally {
    f.cleanup();
  }
});

test('Removed workflow inputs become stale without starving unrelated jobs', async () => {
  const f = fixture();
  try {
    const flow = new LeadWorkflow(f.h);
    const jobs = ['Queued removal', 'Running removal', 'Unrelated board'].map((title) => {
      const board = f.h.createBoard(title, '', 'main');
      f.h.addTask(board.id, input());
      return flow.start({ kind: 'board', id: board.id, authorRuntime: 'codex' });
    });
    const running = flow.claim(jobs[1].key, 'main')!;
    f.store.change('fixture.remove', (s) => {
      s.boards = s.boards.filter((b) => b.id === jobs[2].id);
      const retained = new Set(s.boards[0].revisions.at(-1)!.taskIds);
      s.tasks = s.tasks.filter((t) => retained.has(t.id));
    });
    flow.fail(running, 'Subject removed during review');
    assert.equal(flow.get(running.key, 'main').status, 'stale');
    const runner = new LeadRunner(f.h, f.root);
    await runner.tick();
    await runner.stop();
    assert.equal(flow.get(jobs[0].key, 'main').status, 'stale');
    assert.equal(flow.get(jobs[2].key, 'main').stage, 1);
  } finally {
    f.cleanup();
  }
});

test('A real Git board resumes after process replacement without duplicating review or acceptance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-lead-'));
  await setupDemo(root);
  const config = loadConfig(join(root, 'config.json'));
  let store = new Store(join(root, 'state.sqlite'));
  let h = new DevContour(store, config),
    lead = new LeadRunner(h, root);
  let scheduler: Scheduler | undefined;
  try {
    store.change('fixture.reset', (s) => {
      s.tasks = [];
      s.boards = [];
      s.runs = [];
    });
    const b = h.createBoard('Recoverable board', '', 'main');
    h.addTask(b.id, input());
    const flow = new LeadWorkflow(h),
      job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
    const claimed = flow.claim(job.key, 'main')!;
    // Simulate process death after the domain commit but before recording the stage receipt.
    await lead.execute(claimed, new AbortController().signal);
    store.atomic(() => store.saveLocal('lead', 'main', job.key, { ...claimed, leaseUntil: 0 }));
    store.close();
    store = new Store(join(root, 'state.sqlite'));
    h = new DevContour(store, config);
    lead = new LeadRunner(h, root);
    await lead.tick();
    await lead.tick();
    assert.equal(
      store
        .allEvents()
        .filter((e) => e.type === 'board.approved' && (e.data as any).boardId === b.id).length,
      1,
    );
    scheduler = new Scheduler(h, root);
    await scheduler.init();
    await scheduler.drain();
    assert.ok(store.read().tasks.every((t) => t.status === 'done'));
    await lead.tick();
    await lead.tick();
    assert.equal(new LeadWorkflow(h).get(job.key, 'main').status, 'completed');
    assert.equal(
      store
        .allEvents()
        .filter((e) => e.type === 'board.accepted' && (e.data as any).boardId === b.id).length,
      1,
    );
    assert.equal(store.read().boards.length, 1);
    const taskId = store.read().tasks[0].id;
    config.workspaceGates = [
      {
        id: 'integration',
        repositoryId: 'main',
        kind: 'test',
        timeoutMs: 10000,
        command: [
          process.execPath,
          '--input-type=module',
          '-e',
          `import fs from 'node:fs';import assert from 'node:assert/strict';const d=JSON.parse(fs.readFileSync('deliverables/${taskId}.json'));assert.equal(d.id,'${taskId}');fs.mkdirSync('.reports',{recursive:true});fs.writeFileSync('.reports/workspace.xml','<testsuite><testcase name="integrated-deliverable"/></testsuite>');`,
        ],
        report: { type: 'junit', path: '.reports/workspace.xml' },
        artifacts: [],
      },
    ];
    const change = new Workspace(h).create({
      title: 'Integrated result',
      description: 'Verify accepted board on its real Git snapshot.',
      boardIds: [b.id],
    });
    const sharedJob = new LeadWorkflow(h).start({
      kind: 'changeset',
      id: change.id,
      authorRuntime: 'codex',
    });
    await lead.tick();
    await lead.tick();
    await lead.tick();
    assert.equal(new LeadWorkflow(h).get(sharedJob.key).status, 'completed');
    assert.ok(store.read().changeSets[0].acceptance);
  } finally {
    await lead.stop();
    await scheduler?.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Operator policy never starts automatic review or resumes a queue', async () => {
  const f = fixture();
  try {
    f.h.config.approvalMode = 'operator';
    const b = f.h.createBoard('Operator workflow', '', 'main');
    f.h.addTask(b.id, input());
    const flow = new LeadWorkflow(f.h);
    flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
    const runner = new LeadRunner(f.h, f.root);
    await runner.tick();
    await runner.stop();
    assert.equal(flow.list('main')[0].attempts, 0);
    assert.equal(f.store.read().tasks[0].status, 'draft');
    assert.equal(f.store.read().paused, true);
  } finally {
    f.cleanup();
  }
});

test('Waiting cycles resume shutdown pauses but preserve explicit user pauses', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Paused workflow', '', 'main');
    f.h.addTask(b.id, input());
    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
    const runner = new LeadRunner(f.h, f.root);
    await runner.tick();
    await runner.tick();
    f.h.pause(true);
    f.h.pause(true, 'shutdown');
    await runner.tick();
    assert.equal(f.store.read().paused, true);
    f.h.pause(false);
    f.h.pause(true, 'shutdown');
    await runner.tick();
    assert.equal(f.store.read().paused, false);
    assert.equal(flow.get(job.key, 'main').stage, 2);
    assert.equal(flow.get(job.key, 'main').attempts, 0);
    await runner.stop();
  } finally {
    f.cleanup();
  }
});
