import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { fixture } from './helpers.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { serve } from '../src/server/http.ts';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import { AgentService, SERVER_STOPPING } from '../src/application/agent.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { startQueue } from '../src/runner/queue-start.ts';

/**
 * Штатная остановка сервера: `await scheduler.stop()`, затем закрытие
 * хранилища. Такт, начатый до остановки и закончившийся после неё, писал в
 * уже закрытое хранилище — необработанный отказ процесса. `stop` ставит паузу
 * остановки, дожидается идущего такта любого источника (интервал, HTTP-запуск
 * очереди), и сбой после остановки не записывается.
 */
const INTERVAL = 750;

/** Подменить сам такт (не обёртку `tick`): учёт тактов остаётся настоящим. */
/**
 * `onlyHttp` — медленный только такт HTTP-запуска очереди (вызов из
 * обработчика запроса виден в стеке): такты интервала сервера мгновенны и не
 * подменяют собой такт запроса.
 */
function slowTicks(scheduler: Scheduler, ms: number, fail: boolean, onlyHttp = false) {
  const seen = { ticks: 0, running: 0, overlap: false, http: 0 };
  Object.assign(scheduler, {
    tickOnce: async () => {
      if (onlyHttp) {
        if (!new Error().stack?.includes('server/http.ts')) return;
        seen.http++;
      }
      seen.ticks++;
      seen.running++;
      if (seen.running > 1) seen.overlap = true;
      await sleep(ms);
      seen.running--;
      if (fail) throw new Error('tick failed after stop');
    },
  });
  return seen;
}

async function catching<T>(run: (unhandled: unknown[]) => Promise<T>) {
  const unhandled: unknown[] = [];
  const on = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', on);
  try {
    return await run(unhandled);
  } finally {
    process.off('unhandledRejection', on);
  }
}

test('Остановка дожидается такта интервала; такт дольше интервала не накладывается; сбой после stop не пишет в закрытое хранилище', () =>
  catching(async (unhandled) => {
    const f = fixture();
    let closed = false;
    try {
      const scheduler = new Scheduler(f.h, f.root);
      // Такт идёт дольше двух интервалов: интервал срабатывает во время
      // него и не начинает второй.
      const seen = slowTicks(scheduler, 2.5 * INTERVAL, true);
      scheduler.start();
      // Повторный запуск (сервер запускает уже запущенный планировщик) — без
      // второго интервала.
      scheduler.start();
      for (let i = 0; i < 50 && !seen.ticks; i++) await sleep(50);
      assert.equal(seen.ticks, 1, 'такт начался');
      await sleep(2 * INTERVAL);
      assert.equal(seen.ticks, 1, 'интервал не начал второй такт поверх идущего');
      await scheduler.stop();
      assert.equal(seen.running, 0, 'stop дождался идущего такта');
      assert.equal(f.store.read().paused, true, 'очередь на паузе');
      f.cleanup();
      closed = true;
      await sleep(2 * INTERVAL);
      assert.deepEqual(unhandled, [], 'после stop нет записи в закрытое хранилище');
      assert.equal(seen.overlap, false, 'такты не наложились');
      assert.equal(seen.ticks, 1, 'после stop новых тактов нет');
    } finally {
      if (!closed) f.cleanup();
    }
  }));

test('Остановка дожидается такта HTTP-запуска очереди; во время остановки запуск очереди отклоняется', () =>
  catching(async (unhandled) => {
    const f = fixture();
    let closed = false;
    const scheduler = new Scheduler(f.h, f.root);
    const app = await serve(f.h, scheduler, { port: 0 });
    try {
      const post = (start: boolean) =>
        fetch(app.url + '/api/scheduler', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-DevContour-Request': '1' },
          body: JSON.stringify({ start }),
        });
      // Такты интервала сервера мгновенны; медленный — только такт запроса.
      const seen = slowTicks(scheduler, 1500, false, true);
      const started = post(true);
      for (let i = 0; i < 60 && seen.running === 0; i++) await sleep(25);
      assert.equal(seen.running, 1, 'такт запроса идёт');
      assert.equal(seen.http, 1);
      const stopping = scheduler.stop();
      // Запуск очереди во время остановки — явный отказ, а не снятие паузы.
      const refused = await post(true);
      assert.equal(refused.status, 409);
      assert.match(
        ((await refused.json()) as { error: string }).error,
        /Сервер останавливается: очередь не запускается/,
      );
      await stopping;
      assert.equal(seen.running, 0, 'stop дождался такта HTTP-запуска');
      assert.equal(f.store.read().paused, true, 'запуск очереди не снял паузу остановки');
      assert.equal(f.store.read().pauseReason, 'shutdown', 'пауза — остановки');
      assert.equal((await started).status, 200);
      await app.close();
      f.cleanup();
      closed = true;
      await sleep(2 * INTERVAL);
      assert.equal(seen.http, 1, 'отклонённый запуск такта не начал');
      assert.deepEqual(unhandled, []);
    } finally {
      if (!closed) {
        await app.close();
        f.cleanup();
      }
    }
  }));

test('Пока сервер останавливается (раньше планировщика), запуск очереди из панели и агента отклоняется', () =>
  catching(async (unhandled) => {
    const f = fixture();
    const scheduler = new Scheduler(f.h, f.root);
    const app = await serve(f.h, scheduler, { port: 0 });
    // Остановка ведущего цикла идёт до остановки планировщика: задержка
    // открывает окно, в котором планировщик ещё не stopping.
    // Сам метод прототипа: вызывается ниже через `call` со своим `this`.
    const original = Object.getOwnPropertyDescriptor(LeadRunner.prototype, 'stop')!.value as (
      this: LeadRunner,
    ) => Promise<void>;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    LeadRunner.prototype.stop = async function (this: LeadRunner) {
      await held;
      return original.call(this);
    };
    let closing: Promise<void> | undefined;
    try {
      const post = (path: string, body: unknown) =>
        fetch(app.url + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-DevContour-Request': '1' },
          body: JSON.stringify(body),
        });
      f.h.pause(false);
      closing = app.close();
      await sleep(50);
      assert.equal(scheduler.stopping, false, 'окно: планировщик ещё не останавливается');
      const panel = await post('/api/scheduler', { start: true });
      assert.equal(panel.status, 409);
      assert.match(((await panel.json()) as { error: string }).error, new RegExp(SERVER_STOPPING));
      const agent = await post('/api/agent', { operation: 'queue_set', input: { paused: false } });
      assert.equal(agent.status, 409);
      assert.match(JSON.stringify(await agent.json()), new RegExp(SERVER_STOPPING));
      release();
      await closing;
      closing = undefined;
      assert.equal(f.store.read().paused, true);
      assert.equal(f.store.read().pauseReason, 'shutdown');
      assert.deepEqual(unhandled, []);
    } finally {
      LeadRunner.prototype.stop = original;
      release();
      await (closing ?? Promise.resolve());
      f.cleanup();
    }
  }));

test('Пока сервер останавливается, запуск очереди из другого процесса (своё соединение с базой) отклоняется; после остановки — проходит', () =>
  catching(async (unhandled) => {
    const f = fixture();
    const scheduler = new Scheduler(f.h, f.root);
    const app = await serve(f.h, scheduler, { port: 0 });
    // Другой процесс — CLI `queue --start` или отдельный MCP-сервер: своё
    // соединение с той же базой, без памяти процесса сервера.
    const other = new DevContour(new Store(f.store.file), f.h.config);
    const original = Object.getOwnPropertyDescriptor(LeadRunner.prototype, 'stop')!.value as (
      this: LeadRunner,
    ) => Promise<void>;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    LeadRunner.prototype.stop = async function (this: LeadRunner) {
      await held;
      return original.call(this);
    };
    let closing: Promise<void> | undefined;
    try {
      f.h.pause(false);
      assert.equal(f.h.leader(scheduler.owner), true, 'сервер ведёт очередь');
      closing = app.close();
      await sleep(50);
      // Окно до остановки планировщика: пауза остановки ещё не стоит.
      assert.equal(scheduler.stopping, false);
      other.pause(true);
      await assert.rejects(startQueue(other), (e: Error) => e.message === SERVER_STOPPING);
      await assert.rejects(
        new AgentService(other, f.root).run({ operation: 'queue_set', input: { paused: false } }),
        (e: Error) => e.message === SERVER_STOPPING,
      );
      assert.equal(other.store.read().paused, true);
      release();
      await closing;
      closing = undefined;
      // Остановка закончилась: роль освобождена, отметка снята — запуск проходит.
      assert.equal(other.store.read().leader, undefined);
      assert.equal(other.store.localRecord('server', undefined, 'stopping'), null);
      assert.deepEqual(
        { ...(await startQueue(other)), reason: undefined },
        { paused: false, reason: undefined, server: 'none' },
      );
      assert.deepEqual(unhandled, []);
    } finally {
      LeadRunner.prototype.stop = original;
      release();
      await (closing ?? Promise.resolve());
      other.store.close();
      f.cleanup();
    }
  }));
