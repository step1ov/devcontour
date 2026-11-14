// Аренда попыток и роли controller живого, но занятого сервера.
//
// Под нагрузкой хоста основной поток сервера не успевал продлить аренду: попытка
// с живым gate истекала как «отказ окружения», а повтор той же причины
// останавливал работу «до человека». Здесь основной поток блокируется по-настоящему
// (`Atomics.wait`), как синхронная работа сервера блокирует event loop, и
// проверяется, что: поток хранителя продлевает только своё и только не
// истёкшее; без него аренда теряется (контроль); зависший дольше предела
// процесс аренду теряет; планировщик сервера доводит идущую попытку через
// задержку; потеря аренды перегруженным сервером повторяется автоматически,
// а обычная потеря — по прежнему правилу.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, input, removeTestCheckoutRoot, testCheckoutRoot } from './helpers.ts';
import { demoPool, testDemo } from './demo-pool.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { adapters, type AgentRequest } from '../src/runner/adapters.ts';
import { repositories } from '../src/core/repositories.ts';
import { git } from '../src/runner/process.ts';
import { LeaseKeeper, runnerJobs } from '../src/runner/lease-keeper.ts';
import { renewOwnLeases } from '../src/runner/lease-keeper-worker.ts';
import { LATE_HEARTBEAT, hostStarved, repairDecision } from '../src/core/repair.ts';

const demos = demoPool(testDemo);
after(() => demos.close());

/** Заблокировать основной поток: event loop не исполняет ни таймеров, ни ввода. */
const block = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LEASE = 5000;

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-lease-keeper-'));
  const checkouts = testCheckoutRoot();
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(
    store,
    config({ checkoutRoot: checkouts, leaseMs: LEASE, concurrency: 4, maxAttempts: 10 }),
  );
  return {
    root,
    store,
    h,
    /** Выданная попытка готовой задачи. */
    claim(owner: string, title = 'Example task') {
      const board = h.createBoard('Board ' + title);
      h.addTask(board.id, input(title));
      h.approve(board.id);
      h.pause(false);
      return h.claim(owner)!;
    },
    run(id: string) {
      return store.read().runs.find((r) => r.id === id)!;
    },
    cleanup() {
      store.close();
      rmSync(root, { recursive: true, force: true });
      removeTestCheckoutRoot(checkouts);
    },
  };
}

test('Хранитель продлевает только свою живую и не истёкшую аренду', () => {
  const w = workspace();
  try {
    const mine = w.claim('server-a', 'Mine');
    const foreign = w.claim('server-b', 'Foreign');
    const lapsed = w.claim('server-a', 'Lapsed');
    assert.ok(w.h.leader('server-a'), 'роль controller у своего сервера');
    // Истёкшая аренда своей попытки: её не возвращает никто, кроме recovery.
    w.store.change('test.lapse', (s) => {
      s.runs.find((r) => r.id === lapsed.id)!.leaseUntil = Date.now() - 1;
    });
    const before = {
      mine: w.run(mine.id).leaseUntil,
      foreign: w.run(foreign.id).leaseUntil,
      lapsed: w.run(lapsed.id).leaseUntil,
    };
    const live = new Map([
      [mine.id, mine.token],
      [foreign.id, foreign.token],
      [lapsed.id, lapsed.token],
    ]);
    const now = Date.now() + 1000;
    const renewed = renewOwnLeases(w.store, 'server-a', live, LEASE, now);
    assert.deepEqual(renewed, { runs: [mine.id], controller: true });
    assert.equal(w.run(mine.id).leaseUntil, now + LEASE);
    assert.equal(w.run(foreign.id).leaseUntil, before.foreign, 'чужая попытка не продлевается');
    assert.equal(w.run(lapsed.id).leaseUntil, before.lapsed, 'истёкшая аренда не возвращается');
    assert.equal(w.store.view().leader?.leaseUntil, now + LEASE);

    // Токен не того job (попытку переняли) и роль чужого сервера — не продлеваются.
    const stale = renewOwnLeases(
      w.store,
      'server-a',
      new Map([[mine.id, 'other']]),
      LEASE,
      now + 2000,
    );
    assert.deepEqual(stale.runs, []);
    assert.deepEqual(renewOwnLeases(w.store, 'server-b', new Map(), LEASE).controller, false);
    // Журнал не растёт: продление — heartbeat.
    assert.equal(
      w.store.events().filter((e) => e.type === 'heartbeat').length,
      0,
      'продление не пишет событий',
    );
  } finally {
    w.cleanup();
  }
});

test('Заблокированный основной поток не теряет аренду живого job; без хранителя теряет', async () => {
  const w = workspace();
  try {
    const kept = w.claim('server-a', 'Kept');
    const control = w.claim('server-a', 'Control');
    const stalls: { ms: number; renewed: number }[] = [];
    const keeper = new LeaseKeeper({
      file: w.store.file,
      owner: 'server-a',
      leaseMs: LEASE,
      // Хранитель знает только job `kept`: `control` — та же попытка без него.
      live: () => [{ id: kept.id, token: kept.token }],
      onStall: (s) => stalls.push(s),
      stallMs: 1000,
      tickMs: 100,
    });
    try {
      await sleep(300);
      block(LEASE + 3000);
      await sleep(300);
      assert.ok(w.run(kept.id).leaseUntil > Date.now(), 'аренда живого job продлена потоком');
      assert.doesNotThrow(
        () => w.h.heartbeat(kept.id, kept.token),
        'опоздавший heartbeat проходит',
      );
      assert.ok(w.run(control.id).leaseUntil <= Date.now(), 'контроль: без потока аренда истекла');
      assert.throws(() => w.h.heartbeat(control.id, control.token), /Устаревшая попытка/);
      assert.deepEqual(w.h.expire(), [control.id], 'истекает только попытка без хранителя');
      assert.equal(stalls.length, 1, 'задержка основного потока замечена');
      assert.ok(stalls[0].ms >= LEASE + 3000 - 50);
      assert.ok(stalls[0].renewed >= 1, 'продления потока посчитаны');
    } finally {
      await keeper.stop();
    }
  } finally {
    w.cleanup();
  }
});

test('Зависший дольше предела процесс аренду теряет: другой controller её перенимает', async () => {
  const w = workspace();
  try {
    const run = w.claim('server-a');
    const keeper = new LeaseKeeper({
      file: w.store.file,
      owner: 'server-a',
      leaseMs: LEASE,
      live: () => [{ id: run.id, token: run.token }],
      stallMs: 1000,
      maxStallMs: 2500,
      tickMs: 100,
    });
    try {
      await sleep(300);
      block(LEASE + 4000);
      assert.ok(w.run(run.id).leaseUntil <= Date.now(), 'после предела поток не продлевает');
      assert.deepEqual(w.h.expire(), [run.id]);
    } finally {
      await keeper.stop();
    }
  } finally {
    w.cleanup();
  }
});

test('Сервер доводит попытку через блокировку event loop длиннее срока аренды', async () => {
  const seed = await demos.acquire();
  const configPath = join(seed.root, 'config.json');
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(configPath, JSON.stringify({ ...raw, leaseMs: LEASE }, null, 2));
  const store = new Store(join(seed.root, 'state.sqlite'));
  const release = new AbortController();
  try {
    const h = new DevContour(store, loadConfig(configPath));
    const repo = repositories(h.config)[0];
    await git(
      repo.path,
      'update-ref',
      `refs/heads/${repo.targetBranch}`,
      await git(repo.path, 'rev-parse', 'HEAD'),
    );
    const board = h.createBoard('Board');
    const task = h.addTask(board.id, input('Long implementation'));
    h.approve(board.id);
    h.pause(false);
    let invoked!: () => void;
    const started = new Promise<void>((r) => (invoked = r));
    const scheduler = new Scheduler(h, seed.root, {
      ...adapters,
      demo: {
        name: 'demo' as const,
        reviewProtocol: 1 as const,
        execute: async (request: AgentRequest) => {
          if (request.task?.id !== task.id || request.review) return adapters.demo.execute(request);
          invoked();
          // Работа идёт, пока её не отпустят: как долгий gate.
          return new Promise((_, reject) => {
            const end = () => reject(new Error('released'));
            request.signal.addEventListener('abort', end, { once: true });
            release.signal.addEventListener('abort', end, { once: true });
          });
        },
      },
    });
    await scheduler.init();
    scheduler.start();
    try {
      await started;
      const run = () =>
        store.read().runs.find((r) => r.taskId === task.id && r.status === 'active');
      const before = run();
      assert.ok(before, 'попытка идёт');
      assert.deepEqual(
        scheduler.liveAttempts().find((a) => a.id === before.id),
        { id: before.id, token: before.token },
        'живой job исполнителя harness виден хранителю',
      );
      await sleep(500);
      block(LEASE + 3000);
      // Опоздавшие интервалы: heartbeat job, роль controller, такт очереди с истечением.
      await sleep(2500);
      const after = store.read().runs.find((r) => r.id === before.id)!;
      assert.equal(after.status, 'active', after.error);
      assert.equal(after.error, undefined, 'продление не отказало');
      assert.ok(after.leaseUntil > Date.now());
      const stall = store
        .events()
        .filter((e) => e.type === 'server.loop-stalled')
        .map((e) => e.data as { owner: string; ms: number; renewed: number });
      assert.equal(stall.length, 1, 'задержка записана');
      assert.equal(stall[0].owner, scheduler.owner);
      assert.ok(stall[0].ms >= LEASE + 3000 - 50 && stall[0].renewed >= 1);
    } finally {
      release.abort();
      await scheduler.stop();
    }
  } finally {
    release.abort();
    store.close();
    seed.release();
  }
});

test('Форма job исполнителя harness читается; другая форма — пустой список', () => {
  assert.deepEqual(runnerJobs({ jobs: new Map([['a', { token: 't' }]]) }), [
    { id: 'a', token: 't' },
  ]);
  assert.deepEqual(runnerJobs({ jobs: [['a', { token: 't' }]] }), []);
  assert.deepEqual(runnerJobs({ jobs: new Map([['a', { other: 't' }]]) }), []);
  assert.deepEqual(runnerJobs(undefined), []);
});

/** Попытка истекает; `late` — её job опоздал с продлением (живой владелец). */
function lose(w: ReturnType<typeof workspace>, owner: string, late: boolean, title?: string) {
  const run = title ? w.claim(owner, title) : w.h.claim(owner)!;
  w.store.change('test.lapse', (s) => {
    s.runs.find((r) => r.id === run.id)!.leaseUntil = Date.now() - 1;
  });
  if (late)
    try {
      w.h.heartbeat(run.id, run.token);
      assert.fail('продление истёкшей аренды должно отказать');
    } catch (error) {
      w.h.heartbeatFailed(run.id, run.token, (error as Error).message);
    }
  assert.deepEqual(w.h.expire(), [run.id]);
  return run;
}

const options = { budgetLeft: 10, maxAttempts: 10 };

test('Потеря аренды перегруженным сервером повторяется сама до предела отказов окружения', () => {
  const w = workspace();
  try {
    const first = lose(w, 'server-a', true, 'Starved');
    const task = first.taskId;
    assert.ok(w.run(first.id).error?.startsWith(LATE_HEARTBEAT), w.run(first.id).error);
    const one = repairDecision(w.h, [{ id: task }], options);
    assert.equal(one?.action, 'retry');
    assert.equal(one?.action === 'retry' && one.hostStarved, true);
    // Вторая такая же потеря — не «неисправность окружения для человека».
    w.h.retry(task, undefined, 'recovery');
    lose(w, 'server-a', true);
    const two = repairDecision(w.h, [{ id: task }], options);
    assert.equal(two?.action, 'retry', two?.reason);
    // Предел отказов окружения harness остаётся: постоянная перегрузка
    // всё равно останавливает работу.
    w.h.retry(task, undefined, 'recovery');
    lose(w, 'server-a', true);
    const three = repairDecision(w.h, [{ id: task }], options);
    assert.equal(three?.action, 'stop');
    assert.match(three.reason, /отказов окружения/);
  } finally {
    w.cleanup();
  }
});

test('Истечение без опоздавшего продления и без задержки владельца — прежняя остановка', () => {
  const w = workspace();
  try {
    const first = lose(w, 'server-a', false, 'Plain');
    assert.equal(repairDecision(w.h, [{ id: first.taskId }], options)?.action, 'retry');
    w.h.retry(first.taskId, undefined, 'recovery');
    lose(w, 'server-a', false);
    const second = repairDecision(w.h, [{ id: first.taskId }], options);
    assert.equal(second?.action, 'stop');
    assert.match(second.reason, /одна и та же причина 2 раз/);
  } finally {
    w.cleanup();
  }
});

test('Задержка, записанная сервером-владельцем, отличает его потерю аренды от чужой', () => {
  const w = workspace();
  try {
    const first = lose(w, 'server-a', false, 'Stalled');
    const stall = (owner: string, leaseUntil: number) =>
      w.store.atomic(() =>
        w.store.appendEvent(
          'server.loop-stalled',
          {
            owner,
            from: new Date(leaseUntil - 20_000).toISOString(),
            to: new Date(leaseUntil + 1000).toISOString(),
            ms: 21_000,
            renewed: 0,
          },
          'lease',
        ),
      );
    // Задержка другого сервера в тот же момент ничего не доказывает.
    stall('server-b', w.run(first.id).leaseUntil);
    w.h.retry(first.taskId, undefined, 'recovery');
    const second = lose(w, 'server-a', false);
    const secondAt = w.run(second.id).leaseUntil;
    stall('server-b', secondAt);
    assert.equal(repairDecision(w.h, [{ id: first.taskId }], options)?.action, 'stop');
    // Задержка, кончившаяся до конца срока, — тоже нет.
    assert.equal(
      hostStarved({ ...w.run(second.id), failureKind: 'environment' }, [
        {
          owner: 'server-a',
          from: new Date(secondAt - 9000).toISOString(),
          to: new Date(secondAt - 1).toISOString(),
        },
      ]),
      false,
    );
    // Задержка самого владельца в момент конца срока — перегрузка хоста.
    stall('server-a', secondAt);
    const decided = repairDecision(w.h, [{ id: first.taskId }], options);
    assert.equal(decided?.action, 'retry', decided?.reason);
    assert.equal(decided?.action === 'retry' && decided.hostStarved, true);
  } finally {
    w.cleanup();
  }
});
