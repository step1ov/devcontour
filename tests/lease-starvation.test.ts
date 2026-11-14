// Потеря аренды живым, но перегруженным сервером (F46).
//
// Под нагрузкой хоста основной поток сервера не успевал продлить аренду:
// попытка с живым gate истекала как «отказ окружения», а повтор той же
// причины останавливал работу «до человека». Здесь основной поток блокируется
// по-настоящему (`Atomics.wait`), как синхронная работа сервера блокирует
// event loop, и проверяется, что: монитор записывает задержку по монотонным
// часам, а сон машины и перевод часов — отдельно; сервер записывает задержку
// раньше, чем истекает свою попытку; такая потеря повторяется автоматически
// до предела отказов окружения, а обычная потеря и потеря во сне — по
// прежнему правилу.
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
import { LoopMonitor, type LoopGap } from '../src/runner/loop-monitor.ts';
import { LATE_HEARTBEAT, hostStarved, repairDecision } from '../src/core/repair.ts';

const demos = demoPool(testDemo);
after(() => demos.close());

/** Заблокировать основной поток: event loop не исполняет ни таймеров, ни ввода. */
const block = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LEASE = 5000;
const options = { budgetLeft: 10, maxAttempts: 10 };

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-lease-starvation-'));
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

test('Монитор меряет задержку монотонными часами, сон и перевод часов — отдельно', () => {
  let mono = 0,
    wall = 1_000_000;
  const stalls: LoopGap[] = [],
    jumps: LoopGap[] = [];
  const monitor = new LoopMonitor({
    leaseMs: 30_000,
    onStall: (g) => stalls.push(g),
    onClockJump: (g) => jumps.push(g),
    mono: () => mono,
    wall: () => wall,
  });
  assert.equal(monitor.stallMs, 10_000, 'порог — треть срока аренды');
  const step = (m: number, w: number) => {
    mono += m;
    wall += w;
    return monitor.check();
  };
  assert.equal(step(9_000, 9_000), undefined, 'задержка короче трети срока — не событие');
  assert.deepEqual(step(44_000, 44_100), {
    from: 1_009_000,
    to: 1_053_100,
    monoMs: 44_000,
    wallMs: 44_100,
  });
  assert.equal(stalls.length, 1);
  // Сон машины: монотонные часы стояли, стенные ушли на час.
  step(500, 3_600_000);
  // Перевод часов назад на минуту.
  step(1000, -59_000);
  assert.equal(jumps.length, 2);
  assert.equal(stalls.length, 1, 'сон и перевод часов — не перегрузка');
});

test('Монитор замечает настоящую блокировку event loop', () => {
  const stalls: LoopGap[] = [];
  const monitor = new LoopMonitor({
    leaseMs: 5000,
    onStall: (g) => stalls.push(g),
    onClockJump: () => assert.fail('скачка часов нет'),
  });
  block(2000);
  monitor.check();
  assert.equal(stalls.length, 1);
  assert.ok(stalls[0].monoMs >= 1990, String(stalls[0].monoMs));
});

test('Сервер записывает задержку раньше, чем истекает свою попытку, и повторяет её сам', async () => {
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
      const run = store.read().runs.find((r) => r.taskId === task.id && r.status === 'active');
      assert.ok(run, 'попытка идёт');
      await sleep(500);
      block(LEASE + 3000);
      // Первый такт после задержки — до любого другого таймера: задержка
      // записана уже синхронной частью такта, до recovery и истечения.
      const tick = scheduler.tick();
      assert.ok(
        store.events().some((e) => e.type === 'server.loop-stalled'),
        'такт записал задержку до recovery',
      );
      await tick;
      const deadline = Date.now() + 20_000;
      while (
        store.read().runs.find((r) => r.id === run.id)?.status === 'active' &&
        Date.now() < deadline
      )
        await sleep(100);
      const lost = store.read().runs.find((r) => r.id === run.id)!;
      assert.equal(lost.status, 'expired', 'без продления аренда истекла');
      const events = store.events();
      const stall = events.find((e) => e.type === 'server.loop-stalled');
      const expired = events.find((e) => e.type === 'runs.expired');
      assert.ok(stall && expired, 'задержка и истечение записаны');
      assert.ok(stall.id < expired.id, 'задержка записана до истечения');
      const data = stall.data as { owner: string; monoMs: number };
      assert.equal(data.owner, scheduler.owner);
      assert.ok(data.monoMs >= LEASE + 3000 - 50, String(data.monoMs));
      const decided = repairDecision(h, [{ id: task.id }], options);
      assert.equal(decided?.action, 'retry', decided?.reason);
      assert.equal(decided?.action === 'retry' && decided.hostStarved, true);
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

/** Разрыв основного потока владельца, внутрь которого пришёлся `leaseUntil`. */
function gap(
  w: ReturnType<typeof workspace>,
  type: 'server.loop-stalled' | 'server.clock-jump',
  owner: string,
  leaseUntil: number,
) {
  w.store.atomic(() =>
    w.store.appendEvent(
      type,
      {
        owner,
        from: new Date(leaseUntil - 20_000).toISOString(),
        to: new Date(leaseUntil + 1000).toISOString(),
        monoMs: type === 'server.loop-stalled' ? 21_000 : 500,
        wallMs: 21_000,
      },
      'lease',
    ),
  );
}

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
      gap(w, 'server.loop-stalled', owner, leaseUntil);
    // Задержка другого сервера в тот же момент ничего не доказывает.
    stall('server-b', w.run(first.id).leaseUntil);
    w.h.retry(first.taskId, undefined, 'recovery');
    const second = lose(w, 'server-a', false);
    const secondAt = w.run(second.id).leaseUntil;
    stall('server-b', secondAt);
    assert.equal(repairDecision(w.h, [{ id: first.taskId }], options)?.action, 'stop');
    // Задержка, кончившаяся до конца срока, — тоже нет.
    assert.equal(
      hostStarved(
        { ...w.run(second.id), failureKind: 'environment' },
        {
          stalls: [
            {
              owner: 'server-a',
              from: new Date(secondAt - 9000).toISOString(),
              to: new Date(secondAt - 1).toISOString(),
            },
          ],
          jumps: [],
        },
      ),
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

test('Опоздавшее продление после сна машины или перевода часов — не перегрузка', () => {
  const w = workspace();
  try {
    const first = lose(w, 'server-a', true, 'Slept');
    gap(w, 'server.clock-jump', 'server-a', w.run(first.id).leaseUntil);
    assert.equal(repairDecision(w.h, [{ id: first.taskId }], options)?.action, 'retry');
    w.h.retry(first.taskId, undefined, 'recovery');
    const second = lose(w, 'server-a', true);
    assert.ok(w.run(second.id).error?.startsWith(LATE_HEARTBEAT));
    gap(w, 'server.clock-jump', 'server-a', w.run(second.id).leaseUntil);
    const decided = repairDecision(w.h, [{ id: first.taskId }], options);
    assert.equal(decided?.action, 'stop', 'та же причина дважды — прежняя остановка');
    // Скачок часов другого сервера опоздавшее продление владельца не оправдывает.
    assert.equal(
      hostStarved(w.run(second.id) as Parameters<typeof hostStarved>[0], {
        stalls: [],
        jumps: [
          {
            owner: 'server-b',
            from: new Date(0).toISOString(),
            to: new Date(8.64e15).toISOString(),
          },
        ],
      }),
      true,
    );
  } finally {
    w.cleanup();
  }
});
