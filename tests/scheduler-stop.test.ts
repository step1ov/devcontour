import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { fixture } from './helpers.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { serve } from '../src/server/http.ts';

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
