import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineeringEvals } from '../src/runner/engineering-evals.ts';
import { compareEvaluations } from '../src/application/eval-comparison.ts';

test('Engineering corpus exercises real candidate/integration gates and detects a no-op writer', async () => {
  const baseline = await engineeringEvals();
  assert.equal(baseline.passed, true, JSON.stringify(baseline));
  assert.equal(baseline.budget.calls, 9);
  assert.ok(baseline.results.every((r) => r.candidateChecked && r.integrationChecked));
  const weak = await engineeringEvals(
    {},
    {
      name: 'demo',
      execute: async () => ({
        data: { completed: true, summary: 'No changes', tests: [], discoveries: [] },
        log: 'fixture',
        command: [],
      }),
    },
  );
  assert.equal(weak.passed, false);
  assert.ok(weak.results.every((r) => r.status === 'failed'));
  assert.equal(weak.budget.calls, 3);
  const report = compareEvaluations(baseline, baseline);
  assert.equal(report.passRateDelta, 0);
  assert.deepEqual(report.pairedCaseBootstrap95, [0, 0]);
  assert.equal(report.baseline.totalCostUsd, null);
  assert.throws(() => compareEvaluations(baseline, weak), /identical/);
  assert.throws(
    () =>
      compareEvaluations(baseline, {
        ...baseline,
        results: [baseline.results[0], baseline.results[0], baseline.results[2]],
      }),
    /Repeated/,
  );
  const incomplete = compareEvaluations(baseline, {
    ...baseline,
    results: baseline.results.map((r, i) => (i ? r : { ...r, status: 'unverified' })),
  });
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.passRateDelta, null);
  assert.equal(incomplete.pairedCaseBootstrap95, null);
});

test('Engineering limits and live opt-in remain explicit', async () => {
  const limited = await engineeringEvals({ maxCalls: 1 });
  assert.equal(limited.budget.calls, 0);
  assert.ok(limited.results.every((r) => r.status === 'unverified'));
  await assert.rejects(engineeringEvals({ runtime: 'codex' }), /explicit/);
  await assert.rejects(engineeringEvals({ model: 'model' }), /explicit/);
  await assert.rejects(engineeringEvals({ repetitions: 0 }));
});
