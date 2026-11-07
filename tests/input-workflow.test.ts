// Задание ведущего доски с вопросом исполнителя: независимая задача идёт,
// зависимая ждёт, задание ждёт ответа (не падает и не чинит), после
// перезапуска — так же, после применения ответа — доводит доску.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { controlled, inputDemos, inputFixture, prepared } from './input-fixture.ts';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import { LeadWorkflow, WAITING_INPUT } from '../src/core/lead-workflow.ts';
import { AgentService } from '../src/application/agent.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { loadConfig } from '../src/runner/config.ts';

after(() => inputDemos.close());

test('Board job: A asks, B is independent, C depends on A — B finishes, C waits, the job waits for the answer across restarts and finishes after apply', async () => {
  const runtimes = controlled();
  const f = await inputFixture(runtimes);
  let h = f.h;
  let store = f.store;
  try {
    const { boardId, taskId: a } = f.askingTask('Asking A');
    const b = f.plainTask(boardId, 'Independent B');
    const c = f.plainTask(boardId, 'Dependent C', [a]);
    const job = new LeadWorkflow(h).start({ kind: 'board', id: boardId, authorRuntime: 'codex' });
    const lead = new LeadRunner(h, f.root, runtimes);
    await lead.tick(); // согласование (demo)
    await lead.tick(); // выдача
    await f.scheduler.drain();
    await lead.tick();
    await lead.tick();
    const status = (task: string) => store.read().tasks.find((t) => t.id === task)!.status;
    assert.equal(status(b), 'done');
    assert.equal(status(a), 'failed');
    assert.equal(status(c), 'ready');
    assert.equal(store.read().runs.filter((r) => r.taskId === a).length, 1, 'без повтора A');
    assert.equal(store.read().runs.filter((r) => r.taskId === c).length, 0);
    const [request] = f.service.list({ taskId: a }).requests;
    const saved = () => new LeadWorkflow(h).get(job.key, job.owner);
    assert.notEqual(saved().status, 'failed', saved().error);
    assert.equal(saved().history.filter((e) => e.event === WAITING_INPUT).length, 1);
    const view = new LeadWorkflow(h).view().find((j) => j.key === job.key)!;
    assert.deepEqual(view.waiting, { kind: 'input', requestIds: [request.requestId] });
    const status2 = new AgentService(h, f.root).execute({
      operation: 'workflow_status',
      input: job.owner ? { repositoryId: job.owner } : {},
    }) as { jobs: { key: string; waiting?: unknown }[] };
    assert.deepEqual(status2.jobs.find((j) => j.key === job.key)?.waiting, {
      kind: 'input',
      requestIds: [request.requestId],
    });
    // Перезапуск процесса: то же ожидание, без второй записи и без повтора.
    await f.scheduler.stop();
    store.close();
    store = new Store(join(f.root, 'state.sqlite'));
    h = new DevContour(store, loadConfig(join(f.root, 'config.json')));
    const restarted = new LeadRunner(h, f.root, runtimes);
    await restarted.tick();
    await restarted.tick();
    assert.notEqual(saved().status, 'failed', saved().error);
    assert.equal(saved().history.filter((e) => e.event === WAITING_INPUT).length, 1);
    assert.equal(store.read().runs.filter((r) => r.taskId === a).length, 1);
    // Ответ применён — задание доводит доску без вмешательства.
    const g = {
      ...f,
      h,
      store,
      service: new (await import('../src/application/input.ts')).InputService(h, f.root, runtimes),
    };
    const p = await prepared(g, request.requestId, 'lead');
    g.service.apply(p.apply, 'lead');
    const { Scheduler } = await import('../src/runner/scheduler.ts');
    const scheduler = new Scheduler(h, f.root, runtimes);
    await scheduler.init();
    try {
      await scheduler.drain();
      await restarted.tick();
      await scheduler.drain();
      await restarted.tick();
      await restarted.tick();
    } finally {
      await scheduler.stop();
    }
    assert.equal(status(a), 'done');
    assert.equal(status(c), 'done');
    assert.equal(saved().status, 'completed', saved().error);
  } finally {
    // Первый планировщик остановлен до перезапуска; если тест упал раньше — здесь.
    if (store === f.store) await f.scheduler.stop();
    store.close();
    f.release();
  }
});
