/**
 * D53: аренда попыток — строка `leases`, а не поле документа состояния.
 * Каждый случай называет поломку, которую ловит.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  Engine,
  HarnessError,
  executionDigest,
  executionPolicySchema,
  standaloneHost,
} from 'devcontour-harness';
import { ROW_LEASE, Store } from '../src/core/store.ts';
import { DevContourExecutionStore } from '../src/harness/store.ts';
import { attemptOf } from '../src/harness/projection.ts';
import { specDigest } from '../src/core/service.ts';
import type { DevContourState, Task } from '../src/core/model.ts';

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-lease-row-')));
const refused = (code: string) => (e: unknown) => e instanceof HarnessError && e.code === code;

const policy = executionPolicySchema.parse({
  policyVersion: 1,
  repositories: [
    {
      id: 'app',
      path: '.',
      targetRef: 'refs/heads/devcontour/accepted',
      gates: [
        {
          id: 'test',
          kind: 'test',
          command: ['node', 'verify.mjs'],
          report: { type: 'junit', path: '.reports/junit.xml' },
        },
      ],
    },
  ],
  roles: { backend: { writer: { runtime: 'claude' } } },
  review: {
    code: { reviewer: { runtime: 'codex' } },
    plan: { reviewer: { runtime: 'codex' } },
    contract: { reviewer: { runtime: 'codex' } },
  },
});

/** Задача доски так, как её создаёт продукт (с утверждением). */
function seed(store: Store) {
  const task = {
    id: 'T-1',
    title: 'Добавить приветствие',
    description: 'Функция greet возвращает приветствие по имени.',
    role: 'backend',
    repositoryId: 'app',
    scope: 'component',
    dependsOn: [],
    acceptance: ['greet("Ada") возвращает Hello, Ada!'],
    contracts: [],
    contractDigests: {},
    writePaths: ['src'],
    status: 'ready',
    attempt: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    featureId: 'F-1',
  } as unknown as Task;
  task.approvedDigest = specDigest(task);
  task.approvedAt = '2026-01-01T00:01:00.000Z';
  task.approval = { actor: 'agent', authorRuntime: 'claude', reviewerRuntime: 'codex' };
  store.change('plan.imported', (s) => {
    s.tasks.push(task);
    s.boards.push({
      id: 'B-1',
      title: 'Доска',
      description: 'Цель доски',
      revisions: [
        {
          number: 1,
          status: 'active',
          reason: 'план',
          taskIds: ['T-1'],
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    return { boardId: 'B-1' };
  });
  store.change('scheduler.started', (s) => {
    s.paused = false;
    return {};
  });
}

type Layout = 'central' | 'component';

/** База и файл, где лежит документ попытки (у компонента — его база). */
function openStore(dir: string, layout: Layout) {
  if (layout === 'central') return new Store(join(dir, 'state.sqlite'));
  mkdirSync(join(dir, 'app'), { recursive: true });
  return new Store(join(dir, 'coordinator.sqlite'), [{ id: 'app', path: join(dir, 'app') }]);
}
const runFile = (dir: string, layout: Layout) =>
  layout === 'central'
    ? join(dir, 'state.sqlite')
    : join(dir, 'app', '.devcontour-local', 'state.sqlite');

/** Документ базы попытки как записан: без наложения строк. */
function stored(dir: string, layout: Layout) {
  const db = new DatabaseSync(runFile(dir, layout), { readOnly: true });
  try {
    const data = (db.prepare('SELECT data FROM state WHERE id=1').get() as { data: string }).data;
    const rows = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='leases'")
      .get()
      ? (db.prepare('SELECT id, token, until FROM leases').all() as {
          id: string;
          token: string;
          until: number;
        }[])
      : [];
    return { data, state: JSON.parse(data) as DevContourState, rows };
  } finally {
    db.close();
  }
}

/** Движок над адаптером DevContour с управляемыми часами. */
function engineOver(dir: string, layout: Layout) {
  const store = openStore(dir, layout);
  seed(store);
  const adapter = new DevContourExecutionStore(store, {
    policyDigest: () => executionDigest(policy),
  });
  const clock = { now: Date.now() };
  const standalone = standaloneHost(adapter, policy);
  const engine = new Engine({
    host: {
      ...standalone,
      basis: {
        ...standalone.basis,
        orderDigest: (work) => specDigest(store.read().tasks.find((t) => t.id === work.id)!),
      },
    },
    policy,
    now: () => clock.now,
  });
  assert.equal(engine.lead('controller-1'), true);
  return { store, adapter, engine, clock };
}

for (const layout of ['central', 'component'] as const) {
  test(`${layout}: heartbeat продлевает строку — документ, ревизия данных и журнал прежние`, () => {
    // Ловит F46: продление, которое переписывает документ состояния целиком
    // (и поднимает ревизию данных, сбрасывая кэши), — то, что задерживало
    // основной поток сервера на документе в десятки мегабайт.
    const dir = temp();
    const { store, adapter, engine, clock } = engineOver(dir, layout);
    const a = engine.claim('controller-1')!;
    const before = stored(dir, layout);
    assert.equal(
      before.state.runs.find((r) => r.id === a.id)?.leaseUntil,
      ROW_LEASE,
      'в документе — метка, срок в строке',
    );
    assert.deepEqual(
      before.rows.map((r) => [r.id, r.token, r.until]),
      [[a.id, a.token, a.leaseUntil]],
    );
    const version = store.version();
    const events = store.eventCount();
    clock.now += 10_000;
    engine.heartbeat(a.id, a.token);
    clock.now += 10_000;
    engine.heartbeat(a.id, a.token);
    const after = stored(dir, layout);
    assert.equal(after.data, before.data, 'документ не переписан');
    assert.equal(store.version().revision, version.revision, 'ревизия данных прежняя');
    assert.ok(store.version().lease > version.lease, 'растёт только счётчик сроков');
    assert.equal(store.eventCount(), events, 'продление не пишет событий');
    assert.equal(after.rows[0].until, clock.now + policy.leaseMs);
    assert.equal(
      store.read().runs.find((r) => r.id === a.id)?.leaseUntil,
      clock.now + policy.leaseMs,
      'чтение состояния накладывает срок строки',
    );
    assert.equal(
      store.readShared().state.runs.find((r) => r.id === a.id)?.leaseUntil,
      clock.now + policy.leaseMs,
      'readShared (панель) — тоже',
    );
    assert.equal(
      adapter.read((v) => v.attempt(a.id)?.leaseUntil),
      clock.now + policy.leaseMs,
    );
    adapter.close();
  });

  test(`${layout}: истёкшая аренда не продлевается; истечение и adopt — по сроку строки`, () => {
    // Ловит: продление после срока прежним token (ограждение держалось бы на
    // «никто ещё не истёк») и истечение по сроку документа, который больше
    // не продлевается (живая попытка истекла бы — потеря работы F46).
    const dir = temp();
    const { store, adapter, engine, clock } = engineOver(dir, layout);
    const a = engine.claim('controller-1')!;
    clock.now += 20_000;
    engine.heartbeat(a.id, a.token);
    clock.now = a.leaseUntil + 1_000;
    assert.deepEqual(engine.expire(), [], 'жива по строке');
    clock.now = a.leaseUntil + 20_000 + policy.leaseMs;
    assert.throws(() => engine.heartbeat(a.id, a.token), refused('LEASE_STALE'));
    assert.equal(
      store.atomic(() =>
        store.renewAttemptLease(a.id, a.token, a.owner, a.engineVersion!, clock.now + 1, clock.now),
      ),
      false,
      'строка с истёкшим сроком не продлевается',
    );
    const adopted = engine.adopt(a.id, 'controller-2');
    assert.throws(() => engine.heartbeat(a.id, a.token), refused('LEASE_STALE'), 'прежний token');
    engine.heartbeat(adopted.id, adopted.token);
    clock.now += policy.leaseMs * 2;
    assert.deepEqual(engine.expire(), [a.id]);
    assert.deepEqual(stored(dir, layout).rows, [], 'истечение удалило строку той же транзакцией');
    adapter.close();
  });

  test(`${layout}: первая запись переносит сроки активных попыток в строки с меткой; прежняя версия отказывает`, () => {
    // Ловит: миграцию без метки или вне её транзакции (процесс прежней
    // версии продлил бы срок в документе между шагами), метку, которую
    // прежняя версия не замечает (она истекла бы попытку по сроку документа),
    // и запись при открытии или чтении базы прежней версии.
    const dir = temp();
    const { adapter, engine } = engineOver(dir, layout);
    const a = engine.claim('controller-1')!;
    adapter.close();
    // Состояние прежней версии: срок в документе, строк нет.
    const db = new DatabaseSync(runFile(dir, layout));
    const state = JSON.parse(
      (db.prepare('SELECT data FROM state WHERE id=1').get() as { data: string }).data,
    ) as DevContourState;
    state.runs.find((r) => r.id === a.id)!.leaseUntil = a.leaseUntil + 7;
    db.prepare('UPDATE state SET data=? WHERE id=1').run(JSON.stringify(state));
    db.exec('DROP TABLE leases');
    db.close();
    const legacy = stored(dir, layout).state;
    assert.equal(attemptOf(legacy, legacy.runs[0]).leaseUntil, a.leaseUntil + 7);
    const opened = openStore(dir, layout);
    assert.equal(
      opened.read().runs[0].leaseUntil,
      a.leaseUntil + 7,
      'срок прежней версии читается',
    );
    assert.equal(stored(dir, layout).data, JSON.stringify(legacy), 'открытие и чтение не пишут');
    // Первая запись документа — изменение, не касающееся попытки.
    opened.change('board.renamed', (s) => {
      s.boards[0].title = 'Доска 2';
      return {};
    });
    opened.close();
    const migrated = stored(dir, layout);
    assert.equal(migrated.state.runs[0].leaseUntil, ROW_LEASE, 'метка поставлена');
    assert.deepEqual(
      migrated.rows.map((r) => [r.id, r.token, r.until]),
      [[a.id, a.token, a.leaseUntil + 7]],
    );
    // Проекция попытки прежней версии — та же строгая схема harness: метка
    // ей не годится, и любая операция над попытками отказывает до записи.
    assert.throws(() => attemptOf(migrated.state, migrated.state.runs[0]), /Попытка/);
    const reopened = openStore(dir, layout);
    assert.equal(reopened.read().runs[0].leaseUntil, a.leaseUntil + 7, 'новая версия видит срок');
    reopened.close();
  });

  test(`${layout}: шаг вниз копирует срок строки в документ и снимает метки и строки`, () => {
    // Ловит: откат без шага вниз (прежняя версия отказывала бы навсегда) и
    // шаг вниз, теряющий продлённый срок (живая попытка истекла бы сразу).
    const dir = temp();
    const { store, adapter, engine, clock } = engineOver(dir, layout);
    const a = engine.claim('controller-1')!;
    clock.now += 20_000;
    engine.heartbeat(a.id, a.token);
    assert.equal(store.stepDownLeases(), 1);
    const down = stored(dir, layout);
    assert.deepEqual(down.rows, []);
    assert.equal(down.state.runs[0].leaseUntil, clock.now + policy.leaseMs);
    assert.equal(
      attemptOf(down.state, down.state.runs[0]).leaseUntil,
      clock.now + policy.leaseMs,
      'прежняя версия читает попытку',
    );
    adapter.close();
  });
}

test('миграция с ошибкой откатывает и строки, и метку', () => {
  // Ловит: метку без строки после сбоя миграции — активная попытка осталась
  // бы без аренды, и её истёк бы первый же такт очереди.
  const dir = temp();
  const { adapter, engine } = engineOver(dir, 'central');
  const a = engine.claim('controller-1')!;
  adapter.close();
  const db = new DatabaseSync(join(dir, 'state.sqlite'));
  const state = JSON.parse(
    (db.prepare('SELECT data FROM state WHERE id=1').get() as { data: string }).data,
  ) as DevContourState;
  state.runs[0].leaseUntil = a.leaseUntil;
  db.prepare('UPDATE state SET data=? WHERE id=1').run(JSON.stringify(state));
  // Таблица с лишним столбцом: чтение строк проходит, вставка в миграции падает.
  db.exec(
    'DROP TABLE leases; CREATE TABLE leases (kind TEXT, id TEXT, token TEXT, owner TEXT, engine TEXT, until INTEGER, extra TEXT NOT NULL)',
  );
  db.close();
  const before = stored(dir, 'central').data;
  const store = new Store(join(dir, 'state.sqlite'));
  assert.throws(() =>
    store.change('board.renamed', (s) => {
      s.boards[0].title = 'Доска 2';
      return {};
    }),
  );
  store.close();
  assert.equal(stored(dir, 'central').data, before, 'ни изменения, ни метки — документ как был');
});
