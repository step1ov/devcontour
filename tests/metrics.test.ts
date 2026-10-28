import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, input } from './helpers.ts';
import { timed } from '../src/runner/timing.ts';
import { gateRechecks, workflowMetrics } from '../src/application/metrics.ts';
import type { Evidence, Run } from '../src/core/model.ts';

test('Metrics preserve failed and interrupted attempts, expose timing provenance and unknown cost', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Metrics board', '', 'main');
    f.h.addTask(b.id, input());
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('metrics-test')!;
    await assert.rejects(
      timed(f.h, run, 'candidate-test:required', async () => {
        throw new Error('Tool missing');
      }),
      /Tool missing/,
    );
    f.h.fail(run.id, run.token, 'Required gate unavailable');
    const local = workflowMetrics(f.h, 'main');
    assert.equal(local.counts.failed, 1);
    assert.equal(local.attempts[0].stages[0].outcome, 'failed');
    assert.equal(local.attempts[0].stages[0].incomplete, false);
    assert.equal(local.costUsd, null);
    assert.equal(workflowMetrics(f.h).attempts.length, 0);
    const event = f.store.allEvents().find((e) => e.type === 'run.timing.finished')!;
    assert.equal((event.data as any).timingId, local.attempts[0].stages[0].id);
    let cleaned = false;
    await timed(f.h, run, 'candidate-environment:cleanup', async () => {
      cleaned = true;
    });
    assert.equal(cleaned, true, 'Measurement must not prevent cleanup after a lost lease');
  } finally {
    f.cleanup();
  }
});

test('Метрики называют повторы провалов gates интеграции: flaky отдельно от подтверждённых', () => {
  const record = (id: string, passed: boolean, recheck?: Evidence['recheck']) =>
    ({
      id,
      runId: 'R-1',
      kind: 'test',
      phase: 'integration',
      sha: 'b'.repeat(40),
      gate: 'scale',
      passed,
      createdAt: new Date().toISOString(),
      command: ['node', 'scale.js'],
      exitCode: passed ? 0 : 1,
      log: '',
      digest: 'e'.repeat(64),
      summary: '',
      ...(recheck ? { recheck } : {}),
    }) as Evidence;
  const runs = [
    {
      id: 'R-1',
      taskId: 'T-1',
      evidence: [record('E-1', false), record('E-2', true, { of: 'E-1', outcome: 'flaky' })],
    },
    {
      id: 'R-2',
      taskId: 'T-2',
      evidence: [record('E-3', false), record('E-4', false, { of: 'E-3', outcome: 'confirmed' })],
    },
  ] as unknown as Run[];
  const result = gateRechecks(runs);
  assert.equal(result.flaky, 1);
  assert.equal(result.confirmed, 1);
  assert.deepEqual(result.items[0], {
    taskId: 'T-1',
    runId: 'R-1',
    gate: 'scale',
    evidenceId: 'E-2',
    of: 'E-1',
    outcome: 'flaky',
  });
  const f = fixture();
  try {
    assert.deepEqual(workflowMetrics(f.h, 'main').gateRechecks, {
      flaky: 0,
      confirmed: 0,
      items: [],
    });
  } finally {
    f.cleanup();
  }
});
