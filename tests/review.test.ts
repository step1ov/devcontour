import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectReview } from '../src/runner/review.ts';
import { validateExecution } from '../src/core/review.ts';

test('Review commands are observed from CLI events, never inferred from model claims', () => {
  const claim = JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'I ran npm test: exit 0' },
  });
  assert.equal(inspectReview('codex', claim).mode, 'diff-only');
  const event = (code: number | null) =>
    JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command: 'node --test',
        exit_code: code,
        aggregated_output: code === 0 ? 'tests 2 pass 2' : 'sandbox failed',
        status: code === 0 ? 'completed' : 'failed',
      },
    });
  assert.equal(inspectReview('codex', event(null)).mode, 'diff-only');
  assert.equal(inspectReview('codex', event(1)).mode, 'diff-only');
  const result = inspectReview('codex', claim + '\n' + event(0));
  assert.equal(result.mode, 'commands');
  assert.equal(result.commands[0].output, 'tests 2 pass 2');
  assert.equal(inspectReview('claude', event(0)).mode, 'diff-only');
  assert.throws(() => validateExecution(undefined));
  assert.throws(() => validateExecution({ commands: [], noCommandsReason: null }));
  assert.deepEqual(
    validateExecution({ commands: [], noCommandsReason: 'Sandbox unavailable' }).commands,
    [],
  );
});
