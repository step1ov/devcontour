// Актёры вмешательств в журнале harness (alpha.34): DevContour называет, кто
// повторил и отменил задачу, — человек в CLI и панели (`operator`), цикл
// ведущего (`recovery`), ведущий агент через API (`host`: не человек и не
// правило восстановления). Отчёт об эффекте делит вмешательства по ним.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { valueReportSchema } from 'devcontour-harness/contracts';
import { config, fixture, input } from './helpers.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import { AgentService } from '../src/application/agent.ts';
import { devcontourValueReport } from '../src/application/value-report.ts';
import { executionOf } from '../src/harness/execution.ts';
import { serve } from '../src/server/http.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { command } from '../src/runner/process.ts';

type Payload = { by?: string; reset?: boolean; hadAttempt?: boolean };
/** События harness типа `type` с актёром и поручением. */
const actors = (h: DevContour, type: string) =>
  executionOf(h)
    .store.events(0, 500)
    .filter((e) => e.type === type)
    .map((e) => ({
      workId: e.workId,
      by: (e as { payload?: Payload }).payload?.by,
    }));

/** Доска с задачами `titles`, упавшая первая задача — повтор доступен. */
function failedBoard(h: DevContour, titles = ['Failing task']) {
  const board = h.createBoard('Board', '', 'main');
  const ids = titles.map((t) => h.addTask(board.id, input(t)).id);
  h.approve(board.id);
  h.pause(false);
  const run = h.claim('test')!;
  h.fail(run.id, run.token, 'candidate/typecheck: error', false, 'gate');
  return { board: board.id, ids, failed: run.taskId };
}

test('actors: CLI retry и cancel — operator', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dc-actors-')));
  const data = join(root, 'data');
  try {
    await mkdir(data);
    const c = config();
    await writeFile(join(data, 'config.json'), JSON.stringify(c));
    let h = new DevContour(new Store(join(data, 'state.sqlite')), c);
    let ids: ReturnType<typeof failedBoard>;
    try {
      ids = failedBoard(h, ['Failing task', 'Waiting task']);
    } finally {
      h.store.close();
    }
    const cli = (...args: string[]) =>
      command(['node', '--import', 'tsx', 'src/cli.ts', ...args, '--data', data], process.cwd());
    const retried = await cli('retry', '--task', ids.failed);
    assert.equal(retried.code, 0, retried.stderr);
    const other = ids.ids.find((id) => id !== ids.failed)!;
    const cancelled = await cli('cancel', '--task', other, '--reason', 'out of scope now');
    assert.equal(cancelled.code, 0, cancelled.stderr);
    h = new DevContour(new Store(join(data, 'state.sqlite')), c);
    try {
      assert.deepEqual(actors(h, 'work.retried'), [{ workId: ids.failed, by: 'operator' }]);
      assert.deepEqual(actors(h, 'work.cancelled'), [{ workId: other, by: 'operator' }]);
    } finally {
      h.store.close();
    }
  } finally {
    assert.ok(root.startsWith(await realpath(tmpdir())) && root.includes('dc-actors-'));
    await rm(root, { recursive: true, force: true });
  }
});

test('actors: кнопки панели — operator, task_retry ведущего агента — host', async () => {
  const f = fixture();
  const app = await serve(f.h, new Scheduler(f.h, f.root), { port: 0 });
  try {
    const { failed, ids } = failedBoard(f.h, ['Failing task', 'Waiting task']);
    const post = (path: string) =>
      fetch(app.url + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DevContour-Request': '1' },
        body: '{}',
      });
    assert.equal((await post(`/api/tasks/${failed}/retry`)).status, 200);
    const other = ids.find((id) => id !== failed)!;
    assert.equal((await post(`/api/tasks/${other}/cancel`)).status, 200);
    assert.deepEqual(actors(f.h, 'work.retried'), [{ workId: failed, by: 'operator' }]);
    assert.deepEqual(actors(f.h, 'work.cancelled'), [{ workId: other, by: 'operator' }]);
    // Тот же повтор через агентский API: ведущий агент — актёр не назван.
    f.h.pause(false);
    const run = f.h.claim('test')!;
    assert.equal(run.taskId, failed);
    f.h.fail(run.id, run.token, 'candidate/typecheck: error again', false, 'gate');
    new AgentService(f.h, f.root).execute({ operation: 'task_retry', input: { taskId: failed } });
    assert.deepEqual(actors(f.h, 'work.retried'), [
      { workId: failed, by: 'operator' },
      { workId: failed, by: 'host' },
    ]);
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('actors: восстановление цикла ведущего — recovery; отчёт делит повторы по актёрам', async () => {
  const f = fixture();
  try {
    const { board, failed } = failedBoard(f.h);
    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: board, authorRuntime: 'codex', maxAttempts: 3 });
    const claimed = flow.claim(job.key, job.owner)!;
    f.store.atomic(() => f.store.saveLocal('lead', job.owner, job.key, { ...claimed, stage: 1 }));
    const waiting = await new LeadRunner(f.h, f.root).execute(
      flow.get(job.key, job.owner),
      new AbortController().signal,
    );
    assert.equal(waiting, true, 'цикл назначил повтор');
    assert.deepEqual(actors(f.h, 'work.retried'), [{ workId: failed, by: 'recovery' }]);
    // Второй отказ — повтор человеком из CLI-метода.
    f.h.pause(false);
    const run = f.h.claim('test')!;
    f.h.fail(run.id, run.token, 'candidate/typecheck: error again', false, 'gate');
    f.h.retry(failed, undefined, 'operator');
    const { report } = devcontourValueReport(f.h, {});
    const parsed = valueReportSchema.parse(report);
    const recorded = parsed.autonomy.actions.recorded;
    assert.ok(recorded, 'вмешательства записаны событиями');
    assert.deepEqual(recorded.retries, { operator: 1, recovery: 1, host: 0 });
    // Причина отказа попытки — событие attempt.diagnosed (не окружение — none).
    assert.ok(
      executionOf(f.h)
        .store.events(0, 500)
        .some((e) => e.type === 'attempt.diagnosed'),
    );
  } finally {
    f.cleanup();
  }
});
