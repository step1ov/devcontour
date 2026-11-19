/**
 * F83: простой сервера с идущей очередью, когда выдавать нечего. Ожидающая
 * стадия задания ведущего, такт очереди и опрос панели не разбирают
 * документ состояния заново; захват и возврат ожидающей стадии — тихие
 * записи, которые кэши панели не пересчитывают; счётчики простоя видны в
 * `GET /api/metrics`.
 *
 * Каждый случай называет поломку, которую ловит.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { complete, fixture, input } from './helpers.ts';
import { runtimeFixture } from './runner-fixture.ts';
import { controlled, inputDemos, inputFixture } from './input-fixture.ts';
import { Store } from '../src/core/store.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import { panelSummary } from '../src/application/panel.ts';
import { serve } from '../src/server/http.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { AttentionService } from '../src/application/attention.ts';

after(() => inputDemos.close());

/** Счётчик вызовов метода на прототипе на время теста. */
function counting<T extends object>(proto: T, name: string) {
  const target = proto as Record<string, unknown>;
  const original = target[name] as (...args: unknown[]) => unknown;
  const counter = { count: 0, restore: () => (target[name] = original) };
  target[name] = function (this: unknown, ...args: unknown[]) {
    counter.count++;
    return original.apply(this, args);
  };
  return counter;
}

/**
 * Доска на стадии 2: вторая задача ждёт первую, исполнителей нет — стадия
 * на каждом пробуждении отвечает «жду». Пауза ожидания нулевая: каждый такт
 * будит стадию (счёт пробуждений — `stats.wakes`).
 */
async function waitingBoard(f: ReturnType<typeof fixture>) {
  const b = f.h.createBoard('Idle parse', '', 'main');
  const first = f.h.addTask(b.id, input('First'));
  f.h.addTask(b.id, input('Second', [first.id]));
  const flow = new LeadWorkflow(f.h);
  const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
  const runner = new LeadRunner(f.h, f.root);
  for (let i = 0; i < 4 && flow.get(job.key, 'main').stage < 2; i++) await runner.tick();
  assert.equal(flow.get(job.key, 'main').stage, 2);
  runner.idleWait = { initialMs: 0, maxMs: 0 };
  // Первое пробуждение на стадии 2 может записать заметку ожидания.
  await runner.tick();
  return { first, flow, job, runner };
}

test('F83: пробуждения ожидающей стадии ведущего не разбирают документ — ни копией (read), ни новым снимком', async () => {
  const f = fixture();
  try {
    const { runner } = await waitingBoard(f);
    const reads = counting(Store.prototype, 'read');
    const parses = counting(Store.prototype, 'parseDocument');
    try {
      const wakes = runner.stats.wakes;
      for (let i = 0; i < 10; i++) await runner.tick();
      // Без пробуждений тест ничего бы не доказал.
      assert.equal(runner.stats.wakes - wakes, 10, 'каждый такт будил стадию');
      assert.equal(reads.count, 0, 'стадия читает замороженный снимок, а не копию');
      assert.equal(parses.count, 0, 'свои записи задания не делают снимок устаревшим');
    } finally {
      reads.restore();
      parses.restore();
    }
    await runner.stop();
  } finally {
    f.cleanup();
  }
});

test('F83: захват и возврат ожидающей стадии — тихие записи: ревизия растёт, видимая ревизия и сводка панели стоят; настоящая перемена видна', async () => {
  const f = fixture();
  try {
    const { first, runner } = await waitingBoard(f);
    const revision = f.store.revision();
    const visible = f.store.visibleRevision();
    const summary = panelSummary(f.h, f.root, {}) as { revision: string };
    for (let i = 0; i < 5; i++) await runner.tick();
    assert.ok(f.store.revision() >= revision + 10, 'захват и возврат пишут задание');
    assert.equal(f.store.visibleRevision(), visible, 'видимое не менялось');
    assert.deepEqual(panelSummary(f.h, f.root, { revision: summary.revision }), {
      revision: summary.revision,
      unchanged: true,
    });
    // Запись данных — видна, как и прежде.
    complete(f.h, first.id);
    assert.notEqual(f.store.visibleRevision(), visible, 'запись данных меняет видимую ревизию');
    await runner.stop();
  } finally {
    f.cleanup();
  }
});

test('F83: пробуждение, которое само пишет данные (снятие паузы остановки), — не тихое: тихими считаются только записи задания', async () => {
  const f = fixture();
  try {
    const { runner } = await waitingBoard(f);
    // Пауза остановки сервера: стадия 2 её снимает (`pauseStep`).
    f.h.pause(true, 'shutdown');
    const raw = f.store.revision();
    const visible = f.store.visibleRevision();
    await runner.tick();
    assert.equal(f.store.view().paused, false, 'стадия сняла паузу');
    // Захват, снятие паузы, возврат: тихими учтены ровно две записи задания.
    assert.equal(f.store.revision() - raw, 3);
    assert.equal(f.store.visibleRevision() - visible, 1, 'снятие паузы видно панели');
    await runner.stop();
  } finally {
    f.cleanup();
  }
});

test('F83: номер, выданный посередине пробуждения, не достаётся другим данным — тихие записи после выдачи не вычитаются', async () => {
  const f = fixture();
  try {
    const { runner } = await waitingBoard(f);
    // Опрос панели между захватом и возвратом стадии.
    let middle: { revision: string } | undefined;
    const probe = runner as unknown as {
      execute(job: unknown, signal: AbortSignal): Promise<boolean>;
    };
    const execute = probe.execute.bind(runner);
    probe.execute = async (job, signal) => {
      const waiting = await execute(job, signal);
      middle = panelSummary(f.h, f.root, {});
      return waiting;
    };
    const visible = f.store.visibleRevision();
    await runner.tick();
    probe.execute = execute;
    assert.ok(middle, 'опрос был посередине');
    assert.ok(f.store.visibleRevision() > visible, 'записи после выдачи номера видимы');
    // Следующая запись данных — новый номер, а не номер из середины.
    f.h.createBoard('Another board', '', 'main');
    const after = panelSummary(f.h, f.root, { revision: middle.revision }) as {
      unchanged?: boolean;
      revision: string;
    };
    assert.notEqual(after.unchanged, true, 'другие данные — не «без изменений»');
    assert.notEqual(after.revision, middle.revision);
    // Без опроса посередине тихие пробуждения снова не меняют номер.
    const stable = f.store.visibleRevision();
    for (let i = 0; i < 3; i++) await runner.tick();
    assert.equal(f.store.visibleRevision(), stable);
    await runner.stop();
  } finally {
    f.cleanup();
  }
});

test('F83: тихие пробуждения не пересчитывают центр внимания — опрос с меткой отвечает «без изменений»', async () => {
  const f = fixture();
  const app = await serve(f.h, new Scheduler(f.h, f.root), { port: 0 });
  try {
    const { runner } = await waitingBoard(f);
    const get = async (path: string) => {
      const response = await fetch(app.url + path);
      assert.equal(response.status, 200, path);
      return (await response.json()) as {
        etag?: string;
        unchanged?: boolean;
        revision?: string | number;
      };
    };
    const first = await get('/api/attention');
    const summary = await get('/api/summary');
    const views = counting(AttentionService.prototype, 'view');
    try {
      for (let i = 0; i < 5; i++) await runner.tick();
      const again = await get(`/api/attention?etag=${first.etag}`);
      assert.equal(again.unchanged, true, 'метка прежняя');
      assert.equal(views.count, 0, 'центр внимания не пересчитывался');
      assert.equal((await get(`/api/summary?revision=${summary.revision}`)).unchanged, true);
    } finally {
      views.restore();
    }
    // Пересчитанный центр внимания (кэш истёк) называет тот же номер: номер
    // ответа — видимая ревизия, а не ревизия данных.
    const fresh = new AttentionService(f.store, f.h, { root: f.root }).view({}, new Map());
    assert.equal(fresh.revision, Number(first.revision));
    await runner.stop();
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('F83: такт очереди на идущей очереди не читает журнал сбоев такта; под паузой без причины — читает', async () => {
  const f = await runtimeFixture();
  try {
    for (const t of f.store.view().tasks)
      if (t.status !== 'done') f.h.cancel(t.id, 'нечего выдавать', 'host');
    f.h.pause(false);
    const interval = () =>
      (f.scheduler as unknown as { intervalTick(): Promise<void> }).intervalTick();
    await interval();
    const events = counting(Store.prototype, 'latestEvents');
    try {
      for (let i = 0; i < 5; i++) await interval();
      assert.equal(events.count, 0, 'идущая очередь: журнал не просматривается');
      // Пауза без причины может быть остановкой «база отстала» — её
      // распознаёт журнал сбоев такта.
      f.store.change('test.pause', (s) => {
        s.paused = true;
        s.pausedAt = new Date().toISOString();
        delete s.pauseReason;
      });
      await interval();
      assert.ok(events.count > 0, 'под паузой без причины журнал читается');
    } finally {
      events.restore();
    }
  } finally {
    await f.cleanup();
  }
});

test('F83: сводка вопросов исполнителя читает снимок, а не копию документа', async () => {
  const runtimes = controlled();
  const f = await inputFixture(runtimes);
  try {
    const { boardId, taskId } = f.askingTask('Asking task');
    const job = new LeadWorkflow(f.h).start({ kind: 'board', id: boardId, authorRuntime: 'codex' });
    const lead = new LeadRunner(f.h, f.root, runtimes);
    await lead.tick();
    await lead.tick();
    await f.scheduler.drain();
    await lead.tick();
    assert.equal(new LeadWorkflow(f.h).get(job.key, job.owner).stage, 2);
    const reads = counting(Store.prototype, 'read');
    try {
      const { requests } = f.service.list({ taskId });
      assert.equal(requests.length, 1, 'исполнитель спросил');
      f.service.list({});
      assert.equal(reads.count, 0, 'список вопросов не копирует документ');
    } finally {
      reads.restore();
    }
    await lead.stop();
  } finally {
    await f.cleanup();
  }
});

test('F83: GET /api/metrics называет счётчики шлюза выдачи, разборов документа и тактов ведущего, сам ничего не разбирая', async () => {
  const f = fixture();
  const scheduler = new Scheduler(f.h, f.root);
  const app = await serve(f.h, scheduler, { port: 0 });
  try {
    type Body = {
      pid: number;
      store: Record<string, number>;
      idleClaims: Record<string, number>;
      lead: Record<string, number>;
    };
    const metrics = async () => {
      const response = await fetch(app.url + '/api/metrics');
      assert.equal(response.status, 200);
      return (await response.json()) as Body;
    };
    f.store.view();
    const parses = counting(Store.prototype, 'parseDocument');
    let before: Body;
    try {
      before = await metrics();
      assert.equal(parses.count, 0, 'опрос счётчиков не разбирает документ');
    } finally {
      parses.restore();
    }
    assert.equal(before.pid, process.pid);
    assert.equal(before.idleClaims.maxMs, 30_000);
    // Счётчики — настоящие: копия документа, выдача под шлюзом (такт
    // сервера остановлен — шлюзом пользуется только тест: первая выдача
    // проходит, повтор без перемен — пропуск), такты цикла ведущего сервера
    // (каждую секунду).
    await scheduler.stop();
    f.store.read();
    const gate = scheduler.idleClaims;
    for (let i = 0; i < 2; i++)
      await gate.around(
        () => 0,
        () => Promise.resolve(gate.holds()),
      );
    await new Promise((r) => setTimeout(r, 1200));
    const after = await metrics();
    assert.ok(after.store.reads - before.store.reads >= 1, 'read учтён');
    assert.ok(after.store.parses - before.store.parses >= 1, 'разбор учтён');
    assert.equal(after.store.revision, f.store.revision());
    assert.equal(after.idleClaims.passed - before.idleClaims.passed, 1, 'выдача учтена');
    assert.equal(after.idleClaims.skipped - before.idleClaims.skipped, 1, 'пропуск учтён');
    assert.equal(after.store.visibleRevision, f.store.visibleRevision());
    assert.ok(after.lead.ticks > before.lead.ticks, 'такты ведущего учтены');
    assert.deepEqual(Object.keys(after.lead).sort(), ['held', 'ticks', 'wakes']);
  } finally {
    await app.close();
    f.cleanup();
  }
});
