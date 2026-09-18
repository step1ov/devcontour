import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupDemo } from '../src/demo.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { adapters, cliArguments, type AgentRequest } from '../src/runner/adapters.ts';
import { git, command } from '../src/runner/process.ts';
import { junitSummary } from '../src/runner/gates.ts';
import { input } from './helpers.ts';
import { acceptBoard } from '../src/runner/agent-control.ts';
import { ProjectMemory } from '../src/application/memory.ts';
async function runtimeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-runner-'));
  await setupDemo(root);
  const config = loadConfig(join(root, 'config.json'));
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, config);
  const scheduler = new Scheduler(h, root);
  await scheduler.init();
  return {
    root,
    config,
    store,
    h,
    scheduler,
    cleanup: async () => {
      await scheduler.stop();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test('Writer and both reviewers use the same memory snapshot despite a later knowledge correction', async () => {
  const f = await runtimeFixture();
  let scheduler: Scheduler | undefined;
  try {
    const task = f.store.read().tasks.find((t) => t.status === 'ready')!;
    const memory = new ProjectMemory(f.h);
    const record = memory.retain({
      repositoryId: 'main',
      kind: 'fact',
      subject: task.id,
      text: task.title + ' OriginalMemoryMarker',
      sources: ['README.md'],
    });
    const prompts: string[] = [];
    scheduler = new Scheduler(f.h, f.root, {
      ...adapters,
      demo: {
        ...adapters.demo,
        execute: async (request) => {
          if (request.task.id === task.id) {
            prompts.push(request.prompt);
            if (!request.review)
              memory.retain({
                repositoryId: 'main',
                kind: 'fact',
                subject: task.id,
                text: task.title + ' CorrectedMemoryMarker',
                sources: ['README.md'],
                supersedes: [record.id],
              });
          }
          return adapters.demo.execute(request);
        },
      },
    });
    await scheduler.init();
    f.h.pause(false);
    await scheduler.drain();
    const run = f.store.read().runs.find((r) => r.taskId === task.id)!;
    assert.equal(run.status, 'succeeded');
    assert.deepEqual(run.memory!.ids, [record.id]);
    assert.equal(prompts.length, 3);
    assert.ok(
      prompts.every(
        (p) => p.includes('OriginalMemoryMarker') && !p.includes('CorrectedMemoryMarker'),
      ),
    );
  } finally {
    await scheduler?.stop();
    await f.cleanup();
  }
});
test('Real git pipeline integrates concurrent siblings and verifies every candidate and merged SHA', async () => {
  const f = await runtimeFixture();
  try {
    f.h.pause(false);
    await f.scheduler.drain();
    const state = f.store.read();
    assert.ok(
      state.tasks.every((t) => t.status === 'done'),
      JSON.stringify(state.tasks),
    );
    const current = await git(f.config.repository, 'rev-parse', f.scheduler.target);
    for (const r of state.runs) {
      assert.equal(r.status, 'succeeded');
      assert.equal(r.evidence.length, 4);
      assert.notEqual(r.candidateSha, r.integrationSha);
      await git(f.config.repository, 'merge-base', '--is-ancestor', r.integrationSha!, current);
    }
    assert.equal(await git(f.config.repository, 'branch', '--show-current'), 'main');
    assert.equal(await git(f.config.repository, 'status', '--porcelain'), '');
    const b = state.boards[1];
    const firstTaskId = b.revisions[0].taskIds[0];
    const originalSha = state.tasks.find((t) => t.id === firstTaskId)!.resultSha;
    const unrelated = await git(
      f.config.repository,
      'commit-tree',
      await git(f.config.repository, 'rev-parse', `${current}^{tree}`),
      '-m',
      'Unintegrated test result',
    );
    f.store.change('fixture.unintegrated', (s) => {
      s.tasks.find((t) => t.id === firstTaskId)!.resultSha = unrelated;
    });
    await assert.rejects(acceptBoard(f.h, b.id, 'codex'), /merge-base/);
    assert.equal(f.store.read().boards[1].revisions[0].status, 'active');
    f.store.change('fixture.restore', (s) => {
      s.tasks.find((t) => t.id === firstTaskId)!.resultSha = originalSha;
    });
    f.config.approvalMode = 'operator';
    assert.equal((await acceptBoard(f.h, b.id, 'codex')).status, 'awaiting-operator');
    assert.equal(f.store.read().boards[1].revisions[0].status, 'active');
    f.config.approvalMode = 'agent';
    assert.equal((await acceptBoard(f.h, b.id, 'codex')).status, 'accepted');
    assert.equal(f.store.read().boards[1].revisions[0].acceptance?.actor, 'agent');
    f.h.correct(
      b.id,
      [b.revisions[0].taskIds[0]],
      'Change the search contract and rerun integration',
    );
    f.h.approve(b.id);
    await f.scheduler.drain();
    assert.ok(f.store.read().tasks.every((t) => t.status === 'done'));
  } finally {
    await f.cleanup();
  }
});
test('A missing required tool fails closed and never advances integration ref', async () => {
  const f = await runtimeFixture();
  try {
    const before = await git(f.config.repository, 'rev-parse', f.scheduler.target);
    f.config.gates[0].command = ['devcontour-tool-that-does-not-exist'];
    f.h.pause(false);
    await f.scheduler.drain();
    const failed = f.store.read().tasks.filter((t) => t.status === 'failed');
    assert.equal(failed.length, 1);
    assert.match(failed[0].failure!, /ENOENT/);
    assert.equal(await git(f.config.repository, 'rev-parse', f.scheduler.target), before);
    assert.ok(
      f.store
        .read()
        .runs.at(-1)!
        .evidence.some((e) => !e.passed),
    );
  } finally {
    await f.cleanup();
  }
});
test('A reviewer refusal blocks publication', async () => {
  const f = await runtimeFixture();
  try {
    const rejected = {
      ...adapters,
      demo: {
        name: 'demo' as const,
        async execute(r: AgentRequest) {
          if (r.review)
            return {
              data: {
                approved: false,
                summary: 'Missing acceptance criterion',
                findings: [{ severity: 'blocking', message: 'No expected behaviour' }],
              },
              log: 'rejected',
              command: ['fixture-review'],
            };
          return adapters.demo.execute(r);
        },
      },
    };
    const scheduler = new Scheduler(f.h, f.root, rejected);
    const before = await git(f.config.repository, 'rev-parse', scheduler.target);
    f.h.pause(false);
    await scheduler.drain();
    assert.equal(
      f.store
        .read()
        .tasks.find((t) => t.status === 'failed')
        ?.failure?.includes('ревью'),
      true,
    );
    assert.equal(await git(f.config.repository, 'rev-parse', scheduler.target), before);
  } finally {
    await f.cleanup();
  }
});
test('A reviewer that creates an untracked file cannot approve an unchanged candidate', async () => {
  const f = await runtimeFixture();
  try {
    const priorRuns = new Set(f.store.read().runs.map((r) => r.id));
    const scheduler = new Scheduler(f.h, f.root, {
      ...adapters,
      demo: {
        ...adapters.demo,
        async execute(r: AgentRequest) {
          const result = await adapters.demo.execute(r);
          if (r.review) await writeFile(join(r.cwd, 'reviewer-created.txt'), 'unexpected write');
          return result;
        },
      },
    });
    const before = await git(f.config.repository, 'rev-parse', scheduler.target);
    f.h.pause(false);
    await scheduler.drain();
    assert.equal(await git(f.config.repository, 'rev-parse', scheduler.target), before);
    const reviews = f.store
      .read()
      .runs.filter((r) => !priorRuns.has(r.id))
      .flatMap((r) => r.evidence)
      .filter((e) => e.kind === 'review');
    assert.ok(reviews.length);
    assert.ok(reviews.every((e) => !e.passed));
    assert.ok(reviews.every((e) => e.inspection?.mode === 'diff-only'));
  } finally {
    await f.cleanup();
  }
});
test('Changes to gate policy files are rejected before commit', async () => {
  const f = await runtimeFixture();
  try {
    const modified = {
      ...adapters,
      demo: {
        name: 'demo' as const,
        async execute(r: AgentRequest) {
          const result = await adapters.demo.execute(r);
          if (!r.review) await writeFile(join(r.cwd, 'verify.mjs'), 'process.exit(0)');
          return result;
        },
      },
    };
    const scheduler = new Scheduler(f.h, f.root, modified);
    f.h.pause(false);
    await scheduler.drain();
    assert.match(f.store.read().tasks.find((t) => t.status === 'failed')!.failure!, /защищённые/);
  } finally {
    await f.cleanup();
  }
});
test('Crash after Git publication is reconciled from persisted evidence without running models again', async () => {
  const f = await runtimeFixture();
  try {
    f.h.pause(false);
    await f.scheduler.drain();
    const last = f.store.read().runs.at(-1)!;
    f.store.change('test.crash', (s) => {
      const run = s.runs.find((r) => r.id === last.id)!;
      run.status = 'active';
      run.leaseUntil = 0;
      const t = s.tasks.find((t) => t.id === run.taskId)!;
      t.status = 'integrating';
      t.activeRunId = run.id;
      t.resultSha = undefined;
      return null;
    });
    await f.scheduler.tick();
    const recovered = f.store.read().runs.find((r) => r.id === last.id)!;
    assert.equal(recovered.status, 'succeeded');
    assert.notEqual(recovered.token, last.token);
    assert.equal(f.store.read().runs.length, 7);
  } finally {
    await f.cleanup();
  }
});
test('JUnit rejects empty/malformed reports and distinguishes skipped tests from pass', () => {
  assert.throws(() => junitSummary('<testsuite tests="999"/>'), /testcases/);
  assert.throws(() => junitSummary('not xml'));
  assert.throws(() => junitSummary('<!DOCTYPE xml><testsuite/>'));
  assert.deepEqual(
    junitSummary(
      '<testsuites><testsuite><testcase name="a"/><testcase name="b"><skipped/></testcase><testcase name="c"><failure/></testcase></testsuite></testsuites>',
    ),
    { tests: 3, failures: 1, skipped: 1 },
  );
});
test('CLI adapters use structured outputs, stdin prompts and restricted review permissions', () => {
  const r = { review: true, model: 'configured-model' } as AgentRequest;
  const codex = cliArguments('codex', r, 'schema.json', 'result.json');
  assert.ok(codex.includes('read-only'));
  assert.ok(codex.includes('configured-model'));
  assert.equal(codex.at(-1), '-');
  const claude = cliArguments('claude', r, 'schema.json', 'result.json');
  assert.ok(claude.includes('dontAsk'));
  assert.ok(claude.includes('Read,Glob,Grep'));
  assert.ok(claude.includes('Bash,Edit,Write,NotebookEdit'));
  assert.ok(!claude.includes('--dangerously-skip-permissions'));
});
test('Process timeout interrupts actual child processes', async () => {
  const r = await command([process.execPath, '-e', 'setInterval(()=>{},1000)'], process.cwd(), {
    timeoutMs: 80,
  });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.code, 0);
});
