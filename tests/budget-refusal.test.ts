import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Config } from '../src/core/model.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { TaskFailure } from '../src/core/failure.ts';
import type { Price } from '../src/core/usage.ts';
import { budgetStatus } from '../src/core/budget.ts';
import { measuredExecute } from '../src/runner/usage.ts';
import { timed } from '../src/runner/timing.ts';
import type { AgentRequest } from '../src/runner/adapters.ts';
import { config, input } from './helpers.ts';

// Отдельный файл: регрессия отказа бюджета до вызова не зависит от новых
// API учёта и проверяема на прежних версиях.
const price: Price = {
  runtime: 'claude',
  model: 'cheap',
  effectiveAt: '2026-01-01T00:00:00.000Z',
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
};
const usage = () => ({
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reportedUsd: null,
  complete: true,
  source: 'claude-result' as const,
});
const request = {
  prompt: 'p',
  model: 'cheap',
  signal: new AbortController().signal,
} as AgentRequest;
function contour(overrides: Partial<Config>) {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-budget-refusal-'));
  const store = new Store(join(root, 'state.sqlite'));
  return {
    h: new DevContour(store, config({ prices: [price], ...overrides })),
    store,
    reopen: (next: Partial<Config>) => new DevContour(store, config({ prices: [price], ...next })),
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('B-F15: a call refused before the adapter leaves no history gap, and raising the limit resumes work', async () => {
  const f = contour({ budgets: { workspace: { usd: 3 }, onUnknown: 'stop' } });
  try {
    const b = f.h.createBoard('Budget board', '', 'main');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('w')!;
    await new Promise((done) => setTimeout(done, 20));
    // Другой вызов исчерпывает workspace после выдачи попытки.
    await measuredExecute(
      f.h,
      {
        name: 'claude',
        execute: async (r) => {
          await Promise.resolve();
          r.onUsage!(usage(), 'v', 'cheap');
          return { data: {}, log: '', command: [] };
        },
      },
      request,
      { repositoryId: 'main', stage: 'planning' },
    );
    // Реализация под замером отказана бюджетом до адаптера.
    let invoked = false;
    await assert.rejects(
      timed(f.h, run, 'implementation', () =>
        measuredExecute(
          f.h,
          {
            name: 'claude',
            execute: async () => {
              await Promise.resolve();
              invoked = true;
              return { data: {}, log: '', command: [] };
            },
          },
          request,
          { repositoryId: 'main', runId: run.id, stage: 'implementation' },
        ),
      ),
      (e: unknown) => e instanceof TaskFailure && e.kind === 'budget',
    );
    assert.equal(invoked, false);
    assert.ok(f.store.read().runs.find((r) => r.id === run.id)!.timings?.length);
    const raised = f.reopen({ budgets: { workspace: { usd: 100 }, onUnknown: 'stop' } });
    const status = budgetStatus(raised, raised.store.read(), { kind: 'workspace' })!;
    assert.equal(status.spent.uncoveredRuns, 0);
    assert.equal(status.state, 'within');
    assert.equal(t.id, f.store.read().runs.find((r) => r.id === run.id)!.taskId);
  } finally {
    f.cleanup();
  }
});
