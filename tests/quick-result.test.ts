import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { demoPool, testDemo } from './demo-pool.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { git } from '../src/runner/process.ts';
import { reapprove } from './helpers.ts';
import { quickDiff, quickResult } from '../src/runner/quick.ts';
import type { DevContourState } from '../src/core/model.ts';

const demos = demoPool(testDemo);
after(() => demos.close());

async function runtime() {
  const seed = await demos.acquire();
  const config = loadConfig(join(seed.root, 'config.json'));
  const store = new Store(join(seed.root, 'state.sqlite'));
  const h = new DevContour(store, config);
  const scheduler = new Scheduler(h, seed.root);
  await scheduler.init();
  return {
    config,
    store,
    h,
    scheduler,
    cleanup: async () => {
      await scheduler.stop();
      store.close();
      seed.release();
    },
  };
}

/** Привязка задач к изменению — только в копии состояния: проекция читает, не пишет. */
const bound = (state: DevContourState, taskIds: string[]) => {
  const copy = structuredClone(state);
  for (const t of copy.tasks)
    if (taskIds.includes(t.id))
      t.preparation = {
        changeId: 'PC-quick',
        productDigest: 'a'.repeat(64),
        architectureDigest: 'b'.repeat(64),
        referencesDigest: 'c'.repeat(64),
      };
  return copy;
};

test('D01-F: результат показывает настоящие доказательства двух фаз принятой задачи', async () => {
  const f = await runtime();
  try {
    f.h.pause(false);
    await f.scheduler.drain();
    const state = f.store.read();
    const task = state.tasks.find((t) => t.status === 'done')!;
    const [result] = quickResult(bound(state, [task.id]), 'PC-quick', []);
    assert.equal(result.status, 'done');
    assert.equal(result.resultSha, task.resultSha);
    const run = result.run!;
    assert.equal(run.status, 'succeeded');
    assert.ok(run.candidateSha && run.integrationSha && run.candidateSha !== run.integrationSha);
    // Обе фазы: gates и независимое review на своём SHA.
    for (const [phase, sha] of [
      [run.candidate, run.candidateSha],
      [run.integration, run.integrationSha],
    ] as const) {
      assert.ok(phase.some((e) => e.kind === 'test' && e.passed));
      assert.ok(phase.some((e) => e.kind === 'review' && e.passed));
      assert.ok(phase.every((e) => e.sha === sha));
    }
    await git(
      f.config.repository,
      'merge-base',
      '--is-ancestor',
      run.integrationSha,
      f.scheduler.target,
    );
    // Принятая задача — ещё не принятая доска: следующий шаг из состояния.
    // Демо принимает доску само (approvalMode agent): шаг называет поставку, а не публикацию.
    assert.equal(result.board?.state, 'accepted');
    assert.equal(
      state.boards.find((b) => b.id === result.board!.id)!.revisions.at(-1)!.status,
      'accepted',
    );
    assert.match(result.next ?? '', /ChangeSet/);
    assert.match(result.next ?? '', /вручную/);
    // До приёмки доски тот же результат называет её следующим шагом.
    const unaccepted = bound(state, [task.id]);
    for (const b of unaccepted.boards) for (const r of b.revisions) r.status = 'active';
    assert.match(quickResult(unaccepted, 'PC-quick', [])[0].next ?? '', /принимает доску/);
    const diff = await quickDiff(f.config.repository, run.baseSha!, run.integrationSha);
    assert.ok(diff.count > 0);
    assert.equal(
      diff.added,
      diff.files.reduce((n, x) => n + (x.added ?? 0), 0),
    );
    assert.ok(diff.files.every((x) => x.path && (x.added === null || x.added >= 0)));
    assert.equal(result.usage.calls, 0);
    assert.equal(result.usage.complete, false);
  } finally {
    await f.cleanup();
  }
});

test('D01-F: проваленный gate не доходит до принятия, результат честно пуст', async () => {
  const f = await runtime();
  try {
    const before = await git(f.config.repository, 'rev-parse', f.scheduler.target);
    f.config.gates[0].command = ['devcontour-tool-that-does-not-exist'];
    reapprove(f.h);
    f.h.pause(false);
    await f.scheduler.drain();
    const state = f.store.read();
    const failed = state.tasks.find((t) => t.status === 'failed')!;
    const [result] = quickResult(bound(state, [failed.id]), 'PC-quick', []);
    assert.equal(result.status, 'failed');
    assert.equal(result.resultSha, null);
    assert.equal(result.run!.integrationSha, null);
    assert.deepEqual(result.run!.integration, []);
    assert.ok(result.run!.candidate.some((e) => !e.passed));
    assert.equal(result.next, null);
    assert.equal(await git(f.config.repository, 'rev-parse', f.scheduler.target), before);
  } finally {
    await f.cleanup();
  }
});
