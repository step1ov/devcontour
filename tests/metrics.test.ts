import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, input } from './helpers.ts';
import { timed } from '../src/runner/timing.ts';
import { workflowMetrics } from '../src/application/metrics.ts';

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
