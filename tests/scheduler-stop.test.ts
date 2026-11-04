import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { fixture } from './helpers.ts';
import { Scheduler } from '../src/runner/scheduler.ts';

/**
 * Штатная остановка сервера: `await scheduler.stop()`, затем закрытие
 * хранилища. Такт интервала, начатый до остановки и упавший после неё, писал
 * `scheduler.error` в уже закрытое хранилище — необработанный отказ процесса.
 * `stop` дожидается идущего такта, а сбой после остановки не записывается.
 */
test('Остановка планировщика дожидается идущего такта: сбой такта после stop не пишет в закрытое хранилище', async () => {
  const f = fixture();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  let closed = false;
  try {
    const scheduler = new Scheduler(f.h, f.root);
    let ticks = 0;
    let running = 0;
    let overlap = false;
    // Такт, который идёт дольше остановки и падает после неё.
    Object.assign(scheduler, {
      tick: async () => {
        ticks++;
        running++;
        if (running > 1) overlap = true;
        await sleep(400);
        running--;
        throw new Error('tick failed after stop');
      },
    });
    scheduler.start();
    // Повторный запуск (сервер запускает уже запущенный планировщик) — без
    // второго интервала.
    scheduler.start();
    for (let i = 0; i < 50 && !ticks; i++) await sleep(50);
    assert.equal(ticks, 1, 'такт начался');
    await scheduler.stop();
    assert.equal(running, 0, 'stop дождался идущего такта');
    f.cleanup();
    closed = true;
    await sleep(600);
    assert.deepEqual(unhandled, [], 'после stop нет записи в закрытое хранилище');
    assert.equal(overlap, false, 'такты не наложились');
    assert.equal(ticks, 1, 'после stop новых тактов нет');
  } finally {
    process.off('unhandledRejection', onUnhandled);
    if (!closed) f.cleanup();
  }
});
