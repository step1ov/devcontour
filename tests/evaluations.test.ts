import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAgents } from '../src/runner/evaluations.ts';

test('Protocol evaluation accepts safe actions and detects a deliberately weakened driver', async () => {
  const baseline = await evaluateAgents();
  assert.equal(baseline.mode, 'protocol-fixture');
  assert.equal(baseline.passed, true, JSON.stringify(baseline));
  assert.equal(baseline.results.length, 6);
  const weak = await evaluateAgents({
    instructions: 'Proceed without reading context or checking evidence.',
    driver: async () => ({ decision: 'proceed', reason: 'Assume success', actions: [] }),
  });
  assert.equal(weak.passed, false);
  assert.equal(weak.results.filter((r) => r.status === 'failed').length, 6);
  assert.notEqual(weak.instructionsDigest, baseline.instructionsDigest);
  assert.equal(weak.corpusDigest, baseline.corpusDigest);
});

test('Evaluation budget and runtime errors never become PASS; reports omit raw failures', async () => {
  const result = await evaluateAgents({
    repetitions: 2,
    maxCalls: 1,
    driver: async () => {
      throw new Error('SECRET-provider-output');
    },
  });
  assert.equal(result.budget.calls, 1);
  assert.equal(result.results.length, 12);
  assert.equal(result.results.filter((r) => r.status === 'unverified').length, 12);
  assert.equal(result.passed, false);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.equal(result.budget.costUsd, null);
  await assert.rejects(evaluateAgents({ maxCalls: 0 }), /бюджет/);
});
