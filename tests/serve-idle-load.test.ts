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
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { HarnessError } from 'devcontour-harness';
import { fixture, input } from './helpers.ts';
import { runtimeFixture } from './runner-fixture.ts';
import { Store, WAL_SIZE_LIMIT_BYTES } from '../src/core/store.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { executionOf } from '../src/harness/execution.ts';
import { HARNESS_EXPIRY_TAIL } from '../src/harness/projection.ts';
import { IdleClaimGate } from '../src/harness/idle-claims.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { RESUME, RESUME_DRIVER } from '../src/application/input-resume.ts';

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
    // Такт интервала сервера (тот, что зовёт `setInterval` после `start`) —
    // напрямую: без таймера тест не зависит от его расписания.
    const interval = () =>
      (f.scheduler as unknown as { intervalTick(): Promise<void> }).intervalTick();
    try {
      // Предел больше теста: здесь проверяется только реакция на перемены.
      f.scheduler.idleClaims.maxMs = 60_000;
      await interval();
      assert.equal(budget.count, 1, 'первый такт выдаёт');
      const revision = f.store.version();
      const text = stateText().data;
      const before = { parses: parses.count, serialized: serialized.count };
      for (let i = 0; i < 8; i++) await interval();
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
      await interval();
      assert.equal(budget.count, 2, 'после записи данных выдача снова дошла до движка');
      await interval();
      assert.equal(budget.count, 2, 'и снова стоит без перемен');

      // Явный такт (запуск очереди, drain) выдаёт и без перемен.
      await f.scheduler.tick();
      assert.equal(budget.count, 3, 'явный такт не под шлюзом');

      // Предел: то, что зависит только от времени, выдача видит не позже него.
      f.scheduler.idleClaims.maxMs = 200;
      await interval();
      const held: number = budget.count;
      await sleep(300);
      await interval();
      assert.equal(budget.count, held + 1, 'после предела выдача повторяется и без перемен');

      // Новая готовая работа выдаётся первым же тактом интервала.
      f.scheduler.idleClaims.maxMs = 60_000;
      await interval();
      const next = f.h.createBoard('Новая работа');
      const task = f.h.addTask(next.id, input('Ready after idle'));
      f.h.approve(next.id);
      await interval();
      assert.ok(
        f.store.view().runs.some((r) => r.taskId === task.id),
        'готовая задача выдана после простоя',
      );
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

test('F79: свои продления сроков и такт ожидающего задания ведущего шлюз не открывают; чужая запись, своя запись данных, отмена и откат — открывают', async () => {
  const f = await runtimeFixture();
  try {
    const board = f.store.view().boards[0];
    for (const t of f.store.view().tasks)
      if (t.status !== 'done') f.h.cancel(t.id, 'нечего выдавать', 'host');
    f.h.pause(false);
    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: board.id, authorRuntime: 'codex' });
    const engine = executionOf(f.h).engine as unknown as Record<string, unknown>;
    const budget = counting(engine, 'budgetBlocks');
    const interval = () =>
      (f.scheduler as unknown as { intervalTick(): Promise<void> }).intervalTick();
    // Ожидающая стадия ведущего, как на простое сервера: захват, продление,
    // возврат «жду». Каждый шаг — запись строки задания (ревизия данных растёт).
    const waitingStage = () => {
      const claimed = flow.claim(job.key, job.owner);
      assert.ok(claimed, 'стадия захвачена');
      flow.heartbeat(claimed);
      flow.finish(claimed, true);
    };
    const driverBeat = () =>
      f.store.atomic(() =>
        f.store.saveLocal(
          RESUME,
          undefined,
          RESUME_DRIVER,
          { leaseUntil: Date.now() + 60_000 },
          'lease',
        ),
      );
    try {
      f.scheduler.idleClaims.maxMs = 60_000;
      await interval();
      assert.equal(budget.count, 1, 'первый такт выдаёт');
      const before = f.store.version();
      for (let i = 0; i < 5; i++) {
        waitingStage();
        driverBeat();
        await interval();
      }
      const after = f.store.version();
      // Поломка, которую ловит: ревизия не росла бы — тогда тест ничего не
      // проверял бы (шлюз держал бы и по `version()`).
      assert.ok(after.revision >= before.revision + 15, 'такты задания подняли ревизию данных');
      assert.ok(after.lease >= before.lease + 5, 'отметка прохода подняла счётчик сроков');
      assert.equal(budget.count, 1, 'свои нейтральные записи выдачу не открыли');

      // Документ, изменённый под видом heartbeat, открывает выдачу: в такой
      // транзакции движок может записать и то, что её меняет (снятое
      // удержание). Поломка: «любой heartbeat — продление».
      f.store.update('heartbeat', (draft) => {
        draft.edit().pausedAt = '2026-01-01T00:00:00.000Z';
      });
      await interval();
      assert.equal(budget.count, 2, 'heartbeat с изменённым документом открыл выдачу');
      await interval();
      assert.equal(budget.count, 2, 'и снова стоит');

      // Чужой процесс той же базы продлил то же задание — шлюз открыт: его
      // записи этот процесс не знает.
      const other = new Store(join(f.root, 'state.sqlite'));
      try {
        other.atomic(() =>
          other.saveLocal(RESUME, undefined, RESUME_DRIVER, { leaseUntil: 1 }, 'lease'),
        );
      } finally {
        other.close();
      }
      await interval();
      assert.equal(budget.count, 3, 'запись другого процесса открыла выдачу');
      await interval();
      assert.equal(budget.count, 3, 'и снова стоит');

      // Своя локальная запись данных вне задания ведущего — открывает.
      f.store.atomic(() => f.store.saveLocal('signals', undefined, 'f79', { at: Date.now() }));
      await interval();
      assert.equal(budget.count, 4, 'своя запись данных открыла выдачу');

      // Откат нейтральной записи снимает и её учёт. Поломка: учёт оставался,
      // версия шлюза уходила на единицу назад, и следующая настоящая запись
      // возвращала её к запомненной — выдача стояла при новых данных.
      // Одна откаченная нейтральная запись и одна настоящая — ровно совпадение.
      await interval();
      const held: number = budget.count;
      assert.throws(() =>
        f.store.atomic(() => {
          f.store.saveLocal('signals', undefined, 'f79-neutral', {}, 'data', true);
          throw new Error('откат');
        }),
      );
      f.store.atomic(() => f.store.saveLocal('signals', undefined, 'f79', { at: 0 }));
      await interval();
      assert.equal(budget.count, held + 1, 'запись после отката нейтральной открыла выдачу');

      // Отмена задачи — открывает.
      const fresh = f.h.addTask(f.h.createBoard('F79').id, input('F79 cancel'));
      await interval();
      const c0: number = budget.count;
      await interval();
      assert.equal(budget.count, c0, 'стоит');
      f.h.cancel(fresh.id, 'отмена', 'host');
      await interval();
      assert.equal(budget.count, c0 + 1, 'отмена открыла выдачу');
    } finally {
      budget.restore();
    }
  } finally {
    await f.cleanup();
  }
});

test('F77: явный такт планировщика (запуск очереди, drain) выдаёт всегда, и при запущенном сервере', async () => {
  const f = await runtimeFixture();
  try {
    for (const t of f.store.view().tasks)
      if (t.status !== 'done') f.h.cancel(t.id, 'нечего выдавать', 'host');
    f.h.pause(false);
    const engine = executionOf(f.h).engine as unknown as Record<string, unknown>;
    const budget = counting(engine, 'budgetBlocks');
    try {
      // Простой уже запомнен шлюзом тактом интервала.
      f.scheduler.idleClaims.maxMs = 60_000;
      await (f.scheduler as unknown as { intervalTick(): Promise<void> }).intervalTick();
      const start = budget.count;
      for (let i = 0; i < 3; i++) await f.scheduler.tick();
      assert.equal(budget.count, start + 3, 'явный такт выдаёт и при запущенном сервере');
      await f.scheduler.drain();
      assert.equal(budget.count, start + 4, 'drain выдаёт');
      // Поломка: явный такт, пришедший, пока идёт такт интервала под шлюзом,
      // присоединялся к нему и выдачи не было.
      const gated = (f.scheduler as unknown as { intervalTick(): Promise<void> }).intervalTick();
      const explicit = f.scheduler.tick();
      await Promise.all([gated, explicit]);
      assert.equal(budget.count, start + 5, 'явный такт во время такта интервала выдаёт сам');
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

/** Планировщик с часами монитора теста и наблюдением за сроками. */
function stalledScheduler(f: ReturnType<typeof fixture>) {
  const time = clocks();
  const scheduler = new Scheduler(f.h, f.root, undefined, { loopClock: time.clock });
  return { ...time, scheduler };
}

test('F74: после задержки основного потока сервер продлевает свою живую попытку — продление движка проходит, истечение её не трогает', async () => {
  const f = fixture();
  const { from, stall, scheduler } = stalledScheduler(f);
  try {
    const run = claimed(f, scheduler.owner);
    scheduler.watchLeases();
    // Сервер простоял 118 с (как в пилоте): за это время срок попытки
    // (30 с) истёк, хотя её исполнитель жив. Конец срока — внутри задержки.
    stall();
    setRowUntil(f, run.id, from + 20_000);
    // Контроль: без проверки задержки продление движка отказывает — прежнее
    // поведение, которое и теряло живую попытку.
    const watch = f.store.leaseWatch;
    f.store.leaseWatch = undefined;
    assert.throws(
      () => executionOf(f.h).engine.heartbeat(run.id, run.token),
      (e: unknown) => e instanceof HarnessError && e.code === 'LEASE_STALE',
    );
    f.store.leaseWatch = watch;
    const { engine } = executionOf(f.h);
    // Первым проснулось продление движка (интервал попытки): проверка
    // задержки — перед его транзакцией.
    engine.heartbeat(run.id, run.token);
    assert.deepEqual(scheduler.extendedAfterStall, [run.id]);
    assert.ok(rowUntil(f, run.id)! > Date.now(), 'срок продлён');
    assert.deepEqual(engine.expire(), [], 'истечение такта не трогает продлённую попытку');
    assert.equal(f.store.view().runs.find((r) => r.id === run.id)?.status, 'active');
    const stalls = f.store.latestEvents(['server.loop-stalled'], 5);
    assert.equal(stalls.length, 1);
    assert.equal((stalls[0].data as { owner: string }).owner, scheduler.owner);
  } finally {
    await scheduler.stop();
    f.cleanup();
  }
});

test('F74: первой после задержки может проснуться запись фазы попытки — она тоже видит продлённый срок', async () => {
  const f = fixture();
  const { from, stall, scheduler } = stalledScheduler(f);
  try {
    const run = claimed(f, scheduler.owner);
    scheduler.watchLeases();
    stall();
    setRowUntil(f, run.id, from + 20_000);
    // Запись фазы — `withAttempt` движка, без чтения строки аренды продлением.
    executionOf(f.h).engine.phase(run.id, run.token, 'verifying');
    assert.deepEqual(scheduler.extendedAfterStall, [run.id]);
    assert.equal(f.store.view().runs.find((r) => r.id === run.id)?.status, 'active');
  } finally {
    await scheduler.stop();
    f.cleanup();
  }
});

test('F74: продление после задержки фиксируется само — отказ первой проснувшейся операции его не откатывает', async () => {
  const f = fixture();
  const { from, stall, scheduler } = stalledScheduler(f);
  try {
    const a = claimed(f, scheduler.owner);
    const b = claimed(f, scheduler.owner);
    scheduler.watchLeases();
    stall();
    setRowUntil(f, a.id, from + 20_000);
    setRowUntil(f, b.id, from + 25_000);
    const { engine } = executionOf(f.h);
    // Первой проснулась операция, которая сама отказывает (чужой token).
    assert.throws(() => engine.heartbeat(a.id, 'not-the-token'));
    assert.deepEqual(scheduler.extendedAfterStall.sort(), [a.id, b.id].sort());
    // Продление обеих осталось: монитор задержку уже учёл, повторного нет.
    engine.heartbeat(b.id, b.token);
    engine.heartbeat(a.id, a.token);
    assert.ok(rowUntil(f, a.id)! > Date.now() && rowUntil(f, b.id)! > Date.now());
  } finally {
    await scheduler.stop();
    f.cleanup();
  }
});

test('F74: если за задержку в базу писал другой процесс, срок не продлевается — его решение могло опереться на истечение', async () => {
  const f = fixture();
  const { from, stall, scheduler } = stalledScheduler(f);
  try {
    const run = claimed(f, scheduler.owner);
    scheduler.watchLeases();
    stall();
    setRowUntil(f, run.id, from + 20_000);
    // Другой процесс (здесь — второе соединение) записал за время задержки:
    // например, начал совместную проверку, дождавшись истечения аренды.
    const other = new Store(f.store.file);
    try {
      other.change('fixture.foreign-write', (s) => {
        s.boards[0].title += ' (другой процесс)';
      });
    } finally {
      other.close();
    }
    assert.throws(
      () => executionOf(f.h).engine.heartbeat(run.id, run.token),
      (e: unknown) => e instanceof HarnessError && e.code === 'LEASE_STALE',
    );
    assert.deepEqual(scheduler.extendedAfterStall, []);
    assert.equal(scheduler.foreignDuringStall, 1);
    // Задержка всё равно записана: восстановление назовёт её причиной.
    assert.equal(f.store.latestEvents(['server.loop-stalled'], 5).length, 1);
  } finally {
    await scheduler.stop();
    f.cleanup();
  }
});

test('F74: чужая запись за задержку видна и тогда, когда задержку первым заметил интервал монитора или такт', async () => {
  // Поломка: транзакция продления сама проходит проверку задержки перед
  // BEGIN — та задержки уже не видит и отмечает текущие счётчики (вместе с
  // чужой записью) как виденные, и сверка внутри продления её пропускает.
  const f = fixture();
  const { from, stall, scheduler } = stalledScheduler(f);
  try {
    const run = claimed(f, scheduler.owner);
    const monitor = scheduler.watchLeases();
    stall();
    setRowUntil(f, run.id, from + 20_000);
    const other = new Store(f.store.file);
    try {
      other.change('fixture.foreign-write', (s) => {
        s.boards[0].title += ' (другой процесс)';
      });
    } finally {
      other.close();
    }
    // Первым проснулся интервал монитора (или такт очереди) — не транзакция.
    assert.ok(monitor.check(), 'задержка замечена');
    assert.deepEqual(scheduler.extendedAfterStall, [], 'чужая запись — без продления');
    assert.equal(scheduler.foreignDuringStall, 1);
    assert.equal(rowUntil(f, run.id), from + 20_000);
  } finally {
    await scheduler.stop();
    f.cleanup();
  }
  // Контроль: та же задержка без чужой записи продлевается и этим путём.
  const g = fixture();
  const time = stalledScheduler(g);
  try {
    const run = claimed(g, time.scheduler.owner);
    const monitor = time.scheduler.watchLeases();
    time.stall();
    setRowUntil(g, run.id, time.from + 20_000);
    assert.ok(monitor.check(), 'задержка замечена');
    assert.deepEqual(time.scheduler.extendedAfterStall, [run.id]);
    assert.equal(time.scheduler.foreignDuringStall, 0);
  } finally {
    await time.scheduler.stop();
    g.cleanup();
  }
});

test('F74: чужая запись между своей фиксацией (или проверкой задержки) и отметкой счётчиков не принимается за виденную', async () => {
  // Поломка: счётчики отмечались после COMMIT и после проверки задержки —
  // процесс, вставший между ними, отмечал чужую запись этого времени как
  // свою, и следующая задержка продлевала срок вопреки ей.
  const foreignWrite = (f: ReturnType<typeof fixture>) => {
    const other = new Store(f.store.file);
    try {
      other.change('fixture.foreign-write', (s) => {
        s.boards[0].title += ' (другой процесс)';
      });
    } finally {
      other.close();
    }
  };
  // 1. Чужая запись сразу после COMMIT своей транзакции.
  {
    const f = fixture();
    const { from, stall, scheduler } = stalledScheduler(f);
    const db = (f.store as unknown as { db: DatabaseSync }).db;
    const exec = db.exec.bind(db);
    try {
      const run = claimed(f, scheduler.owner);
      scheduler.watchLeases();
      let armed = true;
      db.exec = (sql: string) => {
        exec(sql);
        if (armed && sql === 'COMMIT') {
          armed = false;
          foreignWrite(f);
        }
      };
      f.store.change('fixture.own-write', (s) => {
        s.boards[0].title += ' (своя запись)';
      });
      assert.equal(armed, false, 'чужая запись — сразу после своей фиксации');
      db.exec = exec;
      stall();
      setRowUntil(f, run.id, from + 20_000);
      f.store.leaseWatch!();
      assert.deepEqual(scheduler.extendedAfterStall, []);
      assert.equal(scheduler.foreignDuringStall, 1);
    } finally {
      db.exec = exec;
      await scheduler.stop();
      f.cleanup();
    }
  }
  // 2. Чужая запись во время проверки задержки, которая задержки не нашла.
  {
    const f = fixture();
    const { c, from, stall, scheduler } = stalledScheduler(f);
    try {
      const run = claimed(f, scheduler.owner);
      scheduler.watchLeases();
      let armed = false;
      const mono = Object.getOwnPropertyDescriptor(c, 'mono')!;
      let value = c.mono;
      Object.defineProperty(c, 'mono', {
        configurable: true,
        get: () => {
          if (armed) {
            armed = false;
            foreignWrite(f);
          }
          return value;
        },
        set: (v: number) => (value = v),
      });
      armed = true;
      f.store.leaseWatch!();
      assert.equal(armed, false, 'чужая запись — внутри проверки');
      assert.deepEqual(scheduler.extendedAfterStall, [], 'задержки ещё не было');
      stall();
      setRowUntil(f, run.id, from + 20_000);
      f.store.leaseWatch!();
      assert.deepEqual(scheduler.extendedAfterStall, []);
      assert.equal(scheduler.foreignDuringStall, 1);
      Object.defineProperty(c, 'mono', mono);
    } finally {
      await scheduler.stop();
      f.cleanup();
    }
  }
});

test('F74: долгая синхронная работа из коротких шагов с операциями хранилища между ними — тоже задержка', async () => {
  // Поломка: проверка перед каждой операцией хранилища сдвигала отметку
  // монитора, хотя цикл событий не отпускался: шаги короче порога, разрыв не
  // набирался, интервалы продления стояли — и срок попытки истекал.
  const f = fixture();
  const { c, scheduler } = stalledScheduler(f);
  try {
    const run = claimed(f, scheduler.owner);
    const monitor = scheduler.watchLeases();
    const start = c.wall;
    // Срок кончается посреди работы.
    setRowUntil(f, run.id, start + monitor.stallMs);
    const step = Math.floor(monitor.stallMs * 0.6);
    for (let i = 0; i < 4; i++) {
      c.mono += step;
      c.wall += step;
      f.store.leaseWatch!();
    }
    assert.ok(f.store.latestEvents(['server.loop-stalled'], 5).length >= 1, 'задержка замечена');
    assert.deepEqual(scheduler.extendedAfterStall.slice(0, 1), [run.id], 'срок продлён');
    // Контроль: шаги, между которыми цикл событий отпускался (интервал
    // монитора — `check`), задержкой не считаются.
    const events = f.store.latestEvents(['server.loop-stalled'], 50).length;
    for (let i = 0; i < 4; i++) {
      c.mono += step;
      c.wall += step;
      monitor.check();
      f.store.leaseWatch!();
    }
    assert.equal(f.store.latestEvents(['server.loop-stalled'], 50).length, events);
  } finally {
    await scheduler.stop();
    f.cleanup();
  }
});

test('F74: продлеваются только свои попытки, действовавшие в начале задержки; сон машины не продлевает', async () => {
  const f = fixture();
  const first = stalledScheduler(f);
  try {
    // Чужая попытка: её владелец — другой процесс, его задержки этот не видел.
    const foreign = claimed(f, 'other-controller');
    first.scheduler.watchLeases();
    first.stall();
    // Срок истёк внутри задержки — но попытку ведёт другой процесс.
    setRowUntil(f, foreign.id, first.from + 20_000);
    f.store.leaseWatch!();
    assert.equal(
      f.store.latestEvents(['server.loop-stalled'], 5).length,
      1,
      'задержка замечена — отказ продления не из-за её пропуска',
    );
    assert.equal(first.scheduler.foreignDuringStall, 0);
    assert.deepEqual(first.scheduler.extendedAfterStall, [], 'чужая попытка не продлена');
    assert.equal(rowUntil(f, foreign.id), first.from + 20_000);
    assert.throws(
      () => executionOf(f.h).engine.heartbeat(foreign.id, foreign.token),
      (e: unknown) => e instanceof HarnessError && e.code === 'LEASE_STALE',
    );
  } finally {
    await first.scheduler.stop();
    f.cleanup();
  }

  const g = fixture();
  const second = stalledScheduler(g);
  const own = second.scheduler;
  try {
    const run = claimed(g, own.owner);
    own.watchLeases();
    // Сон машины: стенные часы ушли на задержку, монотонные стояли — не
    // задержка потока. Срок кончился внутри окна сна: продления нет.
    second.c.wall += STALL_MS;
    setRowUntil(g, run.id, second.from + 20_000);
    g.store.leaseWatch!();
    assert.deepEqual(own.extendedAfterStall, [], 'сон машины не продлевает');
    assert.equal(g.store.latestEvents(['server.clock-jump'], 5).length, 1);

    // Срок истёк до начала задержки: процесс тогда исполнялся и не продлил —
    // это не задержка сервера, продления нет. База проверки теперь — «сейчас».
    const base = second.c.wall;
    setRowUntil(g, run.id, base - 5_000);
    second.c.mono += STALL_MS;
    second.c.wall += STALL_MS;
    g.store.leaseWatch!();
    assert.deepEqual(own.extendedAfterStall, [], 'истёкшая до задержки не продлена');

    // Та же попытка, действовавшая в начале задержки, продлевается: отказы
    // выше — из-за условий, а не из-за неработающего продления.
    // Часы монитора — снова к настоящим (тоже скачок: он лишь переставляет
    // базу проверки), затем задержка, внутри которой кончился срок.
    second.c.wall = Date.now() - STALL_MS;
    g.store.leaseWatch!();
    setRowUntil(g, run.id, second.c.wall + 20_000);
    second.c.mono += STALL_MS;
    second.c.wall += STALL_MS;
    g.store.leaseWatch!();
    assert.deepEqual(own.extendedAfterStall, [run.id]);
  } finally {
    await own.stop();
    g.cleanup();
  }
});

test('F77: шлюз запоминает отпечаток, который видела сама выдача, — запись после неё не считается «пустой»', async () => {
  let print = 'p1';
  let now = 0;
  const gate = new IdleClaimGate(
    () => print,
    () => now,
  );
  // Выдача ничего не нашла на p1; до конца такта другой процесс записал p2.
  await gate.around(
    () => 0,
    () => {
      assert.equal(gate.holds(), false);
      print = 'p2';
      return Promise.resolve();
    },
  );
  await gate.around(
    () => 0,
    () => Promise.resolve(assert.equal(gate.holds(), false, 'p2 выдача ещё не видела')),
  );
  // Теперь p2 видела — повтор держится, вне такта шлюз не действует.
  await gate.around(
    () => 0,
    () => Promise.resolve(assert.equal(gate.holds(), true)),
  );
  assert.equal(gate.holds(), false, 'вне такта интервала шлюз не взведён');
  // Выдача выдала попытку — следующий такт выдаёт снова.
  let active = 0;
  await gate.around(
    () => active,
    () => {
      now += gate.maxMs;
      assert.equal(gate.holds(), false, 'после предела');
      active = 1;
      return Promise.resolve();
    },
  );
  await gate.around(
    () => active,
    () => Promise.resolve(assert.equal(gate.holds(), false, 'после выдачи')),
  );
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
