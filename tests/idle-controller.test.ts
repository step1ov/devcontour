import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { amplifyHistory, completedDemo } from './large-history.ts';
import { demoPool } from './demo-pool.ts';
import { Draft, Store, effectiveLeader } from '../src/core/store.ts';
import { controllerLeaseSchema } from 'devcontour-harness';
import { executionOf } from '../src/harness/execution.ts';
import { controllerOf } from '../src/harness/projection.ts';
import type { DevContourState } from '../src/core/model.ts';
import { config } from './helpers.ts';
import { DevContour } from '../src/core/service.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import { attachJournal } from '../src/runner/journal.ts';

/**
 * Работающий `serve` на паузе: такт очереди и ведущего цикла идут постоянно,
 * но ничего не происходит. Такой такт не переписывает и не разбирает документ
 * состояния, а пишет только продление роли controller — отдельную строку.
 * На большой истории документ весит мегабайты: полный разбор и запись на
 * каждом такте занимали ядро процессора и переписывали журнал WAL.
 */
const histories = demoPool(completedDemo);
after(() => histories.close());

async function idleWorkspace() {
  const seed = await histories.acquire();
  amplifyHistory(seed.root, {
    copies: 6,
    failedAttempts: 3,
    events: 200,
    changeSets: 3,
    verifications: 2,
  });
  const root = seed.root;
  const file = join(root, 'state.sqlite');
  // Счётчики записи — триггерами самой базы: считается любая запись любого
  // соединения, независимо от того, как хранилище устроено внутри.
  const probe = new DatabaseSync(file);
  probe.exec(`
    CREATE TABLE probe (what TEXT PRIMARY KEY, n INTEGER NOT NULL);
    INSERT INTO probe VALUES ('state', 0), ('events', 0);
    CREATE TRIGGER probe_state AFTER UPDATE ON state BEGIN
      UPDATE probe SET n = n + 1 WHERE what = 'state';
    END;
    CREATE TRIGGER probe_events AFTER INSERT ON events BEGIN
      UPDATE probe SET n = n + 1 WHERE what = 'events';
    END;
  `);
  const store = new Store(file);
  const h = new DevContour(store, loadConfig(join(root, 'config.json')));
  attachJournal(h);
  const scheduler = new Scheduler(h, root);
  const lead = new LeadRunner(h, root);
  const documentBytes = (
    probe.prepare('SELECT length(data) AS n FROM state WHERE id=1').get() as { n: number }
  ).n;
  return {
    store,
    h,
    scheduler,
    lead,
    documentBytes,
    writes() {
      const rows = probe.prepare('SELECT what, n FROM probe').all() as {
        what: string;
        n: number;
      }[];
      return Object.fromEntries(rows.map((r) => [r.what, r.n])) as Record<string, number>;
    },
    controller() {
      const row = probe.prepare('SELECT data FROM controller WHERE id=1').get() as
        { data: string | null } | undefined;
      return row?.data ? (JSON.parse(row.data) as { owner: string; leaseUntil: number }) : null;
    },
    async close() {
      await scheduler.stop();
      await lead.stop();
      store.close();
      probe.close();
      seed.release();
    },
  };
}

/** Сколько раз за `fn` документ целиком разобран и сериализован. */
async function documentWork(documentBytes: number, fn: () => Promise<void>) {
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const counts = { parsed: 0, serialized: 0 };
  const large = (text: unknown) => typeof text === 'string' && text.length >= documentBytes / 2;
  JSON.parse = ((text: string, reviver?: Parameters<typeof parse>[1]) => {
    if (large(text)) counts.parsed++;
    return parse(text, reviver);
  }) as typeof JSON.parse;
  JSON.stringify = ((...args: Parameters<typeof stringify>) => {
    const out = stringify(...args);
    if (large(out)) counts.serialized++;
    return out;
  }) as typeof JSON.stringify;
  try {
    await fn();
  } finally {
    JSON.parse = parse;
    JSON.stringify = stringify;
  }
  return counts;
}

test('An idle paused controller neither rewrites nor reparses the state document; it only renews its role row', async () => {
  const w = await idleWorkspace();
  try {
    assert.ok(w.documentBytes > 300_000, `документ большой: ${w.documentBytes} байт`);
    w.h.pause(true);
    // Первый такт: роль controller, применение конфигурации, редкие обходы.
    await w.scheduler.tick();
    await w.lead.tick();
    const role = w.controller();
    assert.equal(role?.owner, w.scheduler.owner, 'роль controller — отдельной строкой');
    const before = w.writes();
    const ticks = 20;
    const work = await documentWork(w.documentBytes, async () => {
      for (let i = 0; i < ticks; i++) {
        await w.scheduler.tick();
        await w.lead.tick();
      }
    });
    const after = w.writes();
    assert.equal(after.state - before.state, 0, 'документ состояния не переписывается');
    assert.equal(after.events - before.events, 0, 'журнал не растёт');
    assert.deepEqual(work, { parsed: 0, serialized: 0 }, 'документ не разбирается заново');
    // Роль продлевается — тем же процессом и с новым сроком.
    const renewed = w.controller();
    assert.equal(renewed?.owner, w.scheduler.owner);
    assert.ok(renewed.leaseUntil > role.leaseUntil, 'срок роли продлён');
    // Роль видна чтению состояния, как прежде.
    assert.deepEqual(w.store.read().leader, renewed);
    assert.deepEqual(w.store.view().leader, renewed);
  } finally {
    await w.close();
  }
});

function pair() {
  const dir = mkdtempSync(join(tmpdir(), 'devcontour-store-cache-'));
  const file = join(dir, 'state.sqlite');
  const a = new Store(file);
  const b = new Store(file);
  const raw = new DatabaseSync(file);
  const text = () =>
    (raw.prepare('SELECT data FROM state WHERE id=1').get() as { data: string }).data;
  return {
    a,
    b,
    raw,
    text,
    document: () => JSON.parse(text()) as Record<string, unknown>,
    close() {
      a.close();
      b.close();
      raw.close();
      // Только свой временный каталог.
      if (dir.startsWith(tmpdir()) && dir.includes('devcontour-store-cache-'))
        rmSync(dir, { recursive: true, force: true });
    },
  };
}
const fixture = (state: unknown) => (state as { fixture?: number }).fixture;
const setFixture = (value: number) => (state: unknown) =>
  ((state as { fixture?: number }).fixture = value);

test('The shared state snapshot follows every committed write and never a rolled-back one', () => {
  const p = pair();
  try {
    const first = p.a.view();
    assert.equal(p.a.view(), first, 'неизменная версия — тот же снимок');
    assert.throws(() => setFixture(1)(first), TypeError);
    // Запись другого Store той же базы.
    p.b.change('fixture', setFixture(1));
    assert.equal(fixture(p.a.view()), 1);
    // Запись другого соединения без счётчиков DevContour (прежняя версия, ручная правка).
    p.raw.exec(`UPDATE state SET data = json_set(data, '$.fixture', 2) WHERE id = 1`);
    assert.equal(fixture(p.a.view()), 2);
    assert.equal(fixture(p.a.read()), 2);
    // Откаченная транзакция не остаётся в снимке.
    assert.throws(() =>
      p.a.atomic(() => {
        p.a.change('fixture', setFixture(3));
        assert.equal(fixture(p.a.view()), 3, 'внутри транзакции видна её запись');
        throw new Error('rollback');
      }),
    );
    assert.equal(fixture(p.a.view()), 2);
    assert.equal(fixture(p.document()), 2);
    // Своя запись видна себе и другим.
    p.a.change('fixture', setFixture(4));
    assert.equal(fixture(p.a.view()), 4);
    assert.equal(fixture(p.b.view()), 4);
    assert.equal(fixture(p.document()), 4);
  } finally {
    p.close();
  }
});

test('The controller role lives in its own row: renewal leaves the document alone, a role written by an earlier version is read and moved out', () => {
  const p = pair();
  try {
    const now = Date.now();
    // Прежняя версия держала роль в документе.
    const legacy = { owner: 'earlier', leaseUntil: now + 60_000, engineVersion: '0.0.0' };
    p.raw
      .prepare(`UPDATE state SET data = json_set(data, '$.leader', json(?)) WHERE id = 1`)
      .run(JSON.stringify(legacy));
    assert.deepEqual(p.a.read().leader, legacy);
    assert.deepEqual(p.a.view().leader, legacy);
    // Новая роль: документ переписан без роли, роль — в своей строке.
    const next = { owner: 'current', leaseUntil: now + 120_000, engineVersion: '0.0.1' };
    p.a.update('heartbeat', (draft) => (draft.leader = next));
    // В документе — только метка роли, сама роль — в строке.
    assert.deepEqual(p.document().leader, { ...next, heldInRow: true }, 'роль ушла из документа');
    assert.deepEqual(p.b.read().leader, next);
    // Продление: документ не меняется ни на байт, меняется только строка роли.
    const before = p.text();
    const revision = p.a.version();
    const renewed = { ...next, leaseUntil: now + 180_000 };
    p.a.update('heartbeat', (draft) => (draft.leader = renewed));
    assert.equal(p.text(), before);
    assert.deepEqual(p.a.version(), revision, 'продление роли — не изменение данных');
    assert.deepEqual(p.b.view().leader, renewed);
    // Снятие роли.
    p.a.update('scheduler.released', (draft) => (draft.leader = undefined));
    assert.equal(p.b.read().leader, undefined);
    assert.equal('leader' in p.document(), false, 'метка снята вместе с ролью');
    const row = p.raw.prepare('SELECT data FROM controller WHERE id=1').get() as {
      data: string | null;
    };
    assert.equal(row.data, null);
  } finally {
    p.close();
  }
});

test('While this version holds the role, an older version that reads the role from the document refuses before any write; after release it may lead', () => {
  const dir = mkdtempSync(join(tmpdir(), 'devcontour-store-cache-'));
  const file = join(dir, 'state.sqlite');
  const store = new Store(file);
  const h = new DevContour(store, config());
  const raw = new DatabaseSync(file);
  const text = () =>
    (raw.prepare('SELECT data FROM state WHERE id=1').get() as { data: string }).data;
  // Прежние версии читают роль только из документа строгой схемой движка
  // (`controllerOf` адаптера) и строки роли не знают.
  const earlier = () => controllerOf(JSON.parse(text()) as DevContourState);
  try {
    assert.equal(h.leader('current'), true);
    const document = JSON.parse(text()) as { leader?: unknown };
    assert.equal(
      controllerLeaseSchema.safeParse(document.leader).success,
      false,
      'метку роли строгая схема прежних версий не принимает',
    );
    assert.throws(earlier, /Роль controller/, 'прежняя версия отказывает до записи и выдачи');
    // Продление документ не трогает.
    const held = text();
    assert.equal(h.leader('current'), true);
    assert.equal(text(), held);
    // Снятие роли снимает метку: прежняя версия снова может вести очередь.
    executionOf(h).engine.release('current');
    assert.equal('leader' in (JSON.parse(text()) as object), false);
    assert.equal(earlier(), undefined, 'прежняя версия читает документ без роли');
  } finally {
    raw.close();
    store.close();
    if (dir.startsWith(tmpdir()) && dir.includes('devcontour-store-cache-'))
      rmSync(dir, { recursive: true, force: true });
  }
});

test('A role written into the document by an earlier version with a later lease than the row wins; a marker defers to the row', () => {
  const row = { owner: 'current', leaseUntil: 1_000 };
  const later = { owner: 'earlier', leaseUntil: 2_000 };
  assert.deepEqual(effectiveLeader(later, row), later);
  assert.deepEqual(effectiveLeader({ owner: 'earlier', leaseUntil: 500 }, row), row);
  assert.equal(effectiveLeader(undefined, null), undefined);
  const marker = { ...later, heldInRow: true } as typeof later;
  assert.deepEqual(effectiveLeader(marker, row), row);
  assert.equal(effectiveLeader(marker, null), undefined);
});

test('A nested part that set the role and failed leaves the role as it was', () => {
  const base = Object.freeze({ leader: undefined }) as never;
  const first = { owner: 'first', leaseUntil: 1 };
  const draft = new Draft(
    () => base,
    () => ({}) as never,
    first,
  );
  const mark = draft.mark();
  draft.leader = { owner: 'second', leaseUntil: 2 };
  draft.restore(mark);
  assert.deepEqual(draft.leader, first);
  // То же после копии документа для записи.
  draft.edit();
  const edited = draft.mark();
  draft.leader = undefined;
  draft.restore(edited);
  assert.deepEqual(draft.leader, first);
});

test('The shared panel snapshot shows the renewed role, not the one it cached', () => {
  const p = pair();
  try {
    p.a.update('heartbeat', (draft) => (draft.leader = { owner: 'c', leaseUntil: 1_000 }));
    assert.equal(p.a.readShared().state.leader?.leaseUntil, 1_000);
    p.b.update('heartbeat', (draft) => (draft.leader = { owner: 'c', leaseUntil: 2_000 }));
    assert.equal(p.a.readShared().state.leader?.leaseUntil, 2_000);
    assert.equal(p.a.readShared(() => false).state.leader?.leaseUntil, 2_000);
  } finally {
    p.close();
  }
});
