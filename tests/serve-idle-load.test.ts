/**
 * F77: такт сервера при идущей очереди без работы не повторяет выдачу движка
 * и не пишет состояние; WAL усекается после сброса. F74: задержка основного
 * потока сервера не истекает его же живые попытки; текст истечения говорит,
 * что будет с попыткой.
 *
 * Каждый случай называет поломку, которую ловит.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { HarnessError } from 'devcontour-harness';
import { fixture, input } from './helpers.ts';
import { runtimeFixture } from './runner-fixture.ts';
import { Store, WAL_SIZE_LIMIT_BYTES } from '../src/core/store.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { executionOf } from '../src/harness/execution.ts';
import { HARNESS_EXPIRY_TAIL } from '../src/harness/projection.ts';

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

test('F77: такт сервера без перемен не повторяет выдачу движка и не пишет состояние; перемена данных и предел снова выдают', async () => {
  const f = await runtimeFixture();
  try {
    // Выдавать нечего: невыполненные задачи отменены, очередь идёт.
    for (const t of f.store.view().tasks)
      if (t.status !== 'done') f.h.cancel(t.id, 'нечего выдавать', 'host');
    f.h.pause(false);
    const engine = executionOf(f.h).engine as unknown as Record<string, unknown>;
    // Учёт бюджета по всем попыткам — дорогая часть выдачи (F77): её вызов
    // и есть выдача, дошедшая до движка.
    const budget = counting(engine, 'budgetBlocks');
    const parses = counting(Store.prototype, 'parseDocument');
    // Сериализации всего документа состояния (а не ключей кэша и строк).
    const stringify = JSON.stringify;
    const serialized = {
      count: 0,
      restore: () => (JSON.stringify = stringify),
    };
    JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
      if (value && typeof value === 'object' && 'tasks' in value && 'runs' in value)
        serialized.count++;
      return (stringify as (...a: unknown[]) => string)(value, ...rest);
    }) as typeof JSON.stringify;
    const closeDraft = counting(Store.prototype, 'closeDraft');
    const stateText = () =>
      (f.store as unknown as { db: DatabaseSync }).db
        .prepare('SELECT data FROM main.state WHERE id=1')
        .get() as { data: string };
    try {
      // Предел больше теста: здесь проверяется только реакция на перемены.
      f.scheduler.idleClaims.maxMs = 60_000;
      f.scheduler.start();
      await f.scheduler.tick();
      assert.equal(budget.count, 1, 'первый такт выдаёт');
      const revision = f.store.version();
      const text = stateText().data;
      const before = { parses: parses.count, serialized: serialized.count };
      for (let i = 0; i < 8; i++) await f.scheduler.tick();
      assert.equal(budget.count, 1, 'такты без перемен не дошли до выдачи движка');
      assert.ok(f.scheduler.idleClaims.skipped >= 8, 'шлюз пропустил выдачу каждого такта');
      assert.deepEqual(f.store.version(), revision, 'ревизия и счётчик сроков стоят');
      assert.equal(stateText().data, text, 'документ состояния не переписан');
      assert.equal(parses.count, before.parses, 'документ не разбирался заново');
      assert.equal(serialized.count, before.serialized, 'документ не сериализовался');
      assert.ok(closeDraft.count > 0, 'такты открывали транзакции движка (роль, recovery)');

      // Перемена данных (здесь — заголовок доски) снова открывает выдачу.
      const board = f.store.view().boards[0];
      f.h.editBoard(board.id, { title: board.title + ' (правка)' });
      await f.scheduler.tick();
      assert.equal(budget.count, 2, 'после записи данных выдача снова дошла до движка');
      await f.scheduler.tick();
      assert.equal(budget.count, 2, 'и снова стоит без перемен');

      // Предел: то, что зависит только от времени, выдача видит не позже него.
      f.scheduler.idleClaims.maxMs = 200;
      await f.scheduler.tick();
      await sleep(300);
      await f.scheduler.tick();
      assert.ok(budget.count >= 3, 'после предела выдача повторяется и без перемен');
    } finally {
      budget.restore();
      parses.restore();
      serialized.restore();
      closeDraft.restore();
    }
  } finally {
    await f.cleanup();
  }
});

test('F77: явный такт планировщика без интервала сервера (drain, запуск очереди) выдаёт всегда', async () => {
  const f = await runtimeFixture();
  try {
    for (const t of f.store.view().tasks)
      if (t.status !== 'done') f.h.cancel(t.id, 'нечего выдавать', 'host');
    f.h.pause(false);
    const engine = executionOf(f.h).engine as unknown as Record<string, unknown>;
    const budget = counting(engine, 'budgetBlocks');
    try {
      for (let i = 0; i < 3; i++) await f.scheduler.tick();
      assert.equal(budget.count, 3, 'без интервала шлюз не действует');
      assert.equal(f.scheduler.idleClaims.skipped, 0);
    } finally {
      budget.restore();
    }
  } finally {
    await f.cleanup();
  }
});

test('F77: WAL после сброса усекается до предела — накопленный журнал не остаётся на диске', () => {
  const f = fixture();
  try {
    const db = (f.store as unknown as { db: DatabaseSync }).db;
    assert.equal(
      (db.prepare('PRAGMA journal_size_limit').get() as { journal_size_limit: number })
        .journal_size_limit,
      WAL_SIZE_LIMIT_BYTES,
    );
    // Читатель с открытым снимком не даёт контрольной точке сбросить WAL:
    // пока он держит снимок, каждая запись большого документа растит файл.
    const reader = new DatabaseSync(f.store.file);
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM state').get();
    const chunk = 'x'.repeat(12 * 1024 * 1024);
    for (let i = 0; i < 7; i++)
      f.store.change('fixture.fill', (s) => {
        // Другой размер на каждой записи: строку того же размера SQLite
        // переписывает на месте, только изменившиеся страницы.
        (s as unknown as { filler: string }).filler = chunk + 'y'.repeat(i + 1);
      });
    const wal = f.store.file + '-wal';
    const grown = statSync(wal).size;
    assert.ok(grown > WAL_SIZE_LIMIT_BYTES, `WAL вырос: ${grown}`);
    reader.exec('COMMIT');
    reader.close();
    db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    // Следующая запись начинает WAL сначала и усекает файл до предела.
    f.store.change('fixture.small', (s) => {
      delete (s as unknown as { filler?: string }).filler;
    });
    const after = statSync(wal).size;
    assert.ok(after <= WAL_SIZE_LIMIT_BYTES, `WAL усечён: ${grown} → ${after}`);
  } finally {
    f.cleanup();
  }
});

/** Доска с готовой задачей и попытка, выданная владельцем `owner`. */
function claimed(f: ReturnType<typeof fixture>, owner: string) {
  const b = f.h.createBoard('Stall', '', 'main');
  f.h.addTask(b.id, input('Stalled writer'));
  f.h.approve(b.id);
  f.h.pause(false);
  const run = f.h.claim(owner)!;
  assert.ok(run, 'попытка выдана');
  return run;
}

/** Срок строки аренды попытки. */
const rowUntil = (f: ReturnType<typeof fixture>, id: string) => f.store.attemptLeaseRow(id)?.until;
const setRowUntil = (f: ReturnType<typeof fixture>, id: string, until: number) =>
  (f.store as unknown as { db: DatabaseSync }).db
    .prepare(`UPDATE main.leases SET until=? WHERE kind='attempt' AND id=?`)
    .run(until, id);

/**
 * Монотонные и стенные часы монитора, которые тест двигает сам. Последняя
 * проверка монитора — `STALL_MS` назад: `stall()` двигает оба часа на
 * задержку, как при перегрузке (сон машины двигает только стенные).
 */
const STALL_MS = 118_000;
function clocks() {
  const c = { mono: 0, wall: Date.now() - STALL_MS };
  const from = c.wall;
  return {
    c,
    from,
    stall: () => {
      c.mono += STALL_MS;
      c.wall = from + STALL_MS;
    },
    clock: { mono: () => c.mono, wall: () => c.wall },
  };
}

test('F74: после задержки основного потока сервер продлевает свою живую попытку — продление движка проходит, истечение её не трогает', async () => {
  const f = fixture();
  const { from, stall, clock } = clocks();
  const scheduler = new Scheduler(f.h, f.root, undefined, { loopClock: clock });
  try {
    const run = claimed(f, scheduler.owner);
    scheduler.watchLeases();
    // Сервер простоял 118 с (как в пилоте): за это время срок попытки
    // (30 с) истёк, хотя её исполнитель жив. Конец срока — внутри задержки.
    stall();
    setRowUntil(f, run.id, from + 20_000);
    // Контроль: без проверки задержки перед чтением строки продление движка
    // отказывает — прежнее поведение, которое и теряло живую попытку.
    const watch = f.store.leaseWatch;
    f.store.leaseWatch = undefined;
    assert.throws(
      () => executionOf(f.h).engine.heartbeat(run.id, run.token),
      (e: unknown) => e instanceof HarnessError && e.code === 'LEASE_STALE',
    );
    f.store.leaseWatch = watch;
    const { engine } = executionOf(f.h);
    // Первым проснулось продление движка (интервал попытки): оно читает
    // строку аренды, проверка задержки — раньше.
    engine.heartbeat(run.id, run.token);
    assert.deepEqual(scheduler.extendedAfterStall, [run.id]);
    assert.ok(rowUntil(f, run.id)! > Date.now(), 'срок продлён');
    assert.deepEqual(engine.expire(), [], 'истечение такта не трогает продлённую попытку');
    assert.equal(f.store.view().runs.find((r) => r.id === run.id)?.status, 'active');
    // Задержка записана событием своей транзакцией сразу после продления.
    await new Promise((r) => setImmediate(r));
    const stalls = f.store.latestEvents(['server.loop-stalled'], 5);
    assert.equal(stalls.length, 1);
    assert.equal((stalls[0].data as { owner: string }).owner, scheduler.owner);
  } finally {
    await scheduler.stop();
    f.cleanup();
  }
});

test('F74: продлеваются только свои попытки, действовавшие в начале задержки; сон машины не продлевает', async () => {
  const f = fixture();
  const first = clocks();
  const scheduler = new Scheduler(f.h, f.root, undefined, { loopClock: first.clock });
  try {
    // Чужая попытка: её владелец — другой процесс, его задержки этот не видел.
    const foreign = claimed(f, 'other-controller');
    scheduler.watchLeases();
    first.stall();
    // Срок истёк внутри задержки — но попытку ведёт другой процесс.
    setRowUntil(f, foreign.id, first.from + 20_000);
    f.store.leaseWatch!();
    assert.equal(
      f.store.latestEvents(['server.loop-stalled'], 5).length,
      1,
      'задержка замечена — отказ продления не из-за её пропуска',
    );
    assert.deepEqual(scheduler.extendedAfterStall, [], 'чужая попытка не продлена');
    assert.equal(rowUntil(f, foreign.id), first.from + 20_000);
    assert.throws(
      () => executionOf(f.h).engine.heartbeat(foreign.id, foreign.token),
      (e: unknown) => e instanceof HarnessError && e.code === 'LEASE_STALE',
    );
  } finally {
    await scheduler.stop();
    f.cleanup();
  }

  const g = fixture();
  const second = clocks();
  const own = new Scheduler(g.h, g.root, undefined, { loopClock: second.clock });
  try {
    const run = claimed(g, own.owner);
    own.watchLeases();
    // Срок истёк до начала задержки: процесс тогда исполнялся и не продлил —
    // это не задержка сервера, продления нет.
    second.stall();
    setRowUntil(g, run.id, second.from - 5_000);
    g.store.leaseWatch!();
    assert.deepEqual(own.extendedAfterStall, [], 'истёкшая до задержки не продлена');

    // Сон машины: стенные часы ушли, монотонные стояли — не задержка потока.
    setRowUntil(g, run.id, Date.now() - 1_000);
    second.c.wall += 600_000;
    g.store.leaseWatch!();
    assert.deepEqual(own.extendedAfterStall, [], 'сон машины не продлевает');
    // Та же попытка после настоящей задержки продлевается: отказы выше — из-за
    // условий, а не из-за неработающего продления.
    // Стенные часы монитора — снова к настоящим (это тоже скачок: базу
    // проверки он переставляет), затем задержка.
    second.c.wall = Date.now() - STALL_MS;
    g.store.leaseWatch!();
    setRowUntil(g, run.id, Date.now() - 60_000);
    second.c.mono += STALL_MS;
    second.c.wall += STALL_MS;
    g.store.leaseWatch!();
    assert.deepEqual(own.extendedAfterStall, [run.id]);
  } finally {
    await own.stop();
    g.cleanup();
  }
});

test('F74: текст истечения говорит, повторит ли попытку задание ведущего цикла', () => {
  for (const approvalMode of ['agent', 'operator'] as const) {
    const f = fixture();
    try {
      f.h.config = { ...f.h.config, approvalMode };
      const run = claimed(f, 'controller-x');
      setRowUntil(f, run.id, Date.now() - 1_000);
      const { engine } = executionOf(f.h);
      assert.deepEqual(engine.expire(), [run.id]);
      const s = f.store.view();
      const expired = s.runs.find((r) => r.id === run.id)!;
      const task = s.tasks.find((t) => t.id === run.taskId)!;
      for (const text of [expired.error, task.failure]) {
        assert.ok(text, approvalMode);
        assert.ok(
          !text.includes(HARNESS_EXPIRY_TAIL),
          `${approvalMode}: без «Повторите явно» движка`,
        );
        assert.match(text, /^Истёк срок владения; попытка не засчитана\./);
        assert.match(text, new RegExp(`devcontour retry --task ${run.taskId}`));
        if (approvalMode === 'agent') assert.match(text, /Задание ведущего цикла повторит её само/);
        else assert.match(text, /Повторите явно/);
      }
    } finally {
      f.cleanup();
    }
  }
});
