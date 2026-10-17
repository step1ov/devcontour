import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { WORKSPACE_OWNER, digestOf } from 'devcontour-harness';
import { Store } from '../src/core/store.ts';
import { DevContourExecutionStore } from '../src/harness/store.ts';

// Базы, записанные кодом прежней версии (tests/fixtures/legacy/generate.ts).
// Новый код открывает их копии без setup, миграции и правки базы.
const fixtures = fileURLToPath(new URL('./fixtures/legacy/', import.meta.url));
const generatedAt = readFileSync(join(fixtures, 'ROOT'), 'utf8').trim();
const options = { policyDigest: () => digestOf('policy') };

/** Содержимое всех таблиц базы: по нему видно, что чтение ничего не записало. */
function dump(file: string) {
  const db = new DatabaseSync(file);
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((t) => t.name);
  const out = Object.fromEntries(
    tables
      .filter((t) => t !== 'revision')
      .map((t) => [t, db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()]),
  );
  db.close();
  return JSON.stringify(out);
}

function centralCopy() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-legacy-')));
  cpSync(join(fixtures, 'central'), root, { recursive: true });
  const file = join(root, 'state.sqlite');
  return { file, files: [file], open: () => new Store(file) };
}

/**
 * Копия component-базы на новом месте. Реестр компонентов и владелец базы
 * компонента хранят абсолютные пути; переносится только корень — так же
 * выглядел бы тот же workspace, открытый из другого каталога.
 */
function componentCopy() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-legacy-')));
  cpSync(join(fixtures, 'component'), root, { recursive: true });
  const coordinator = join(root, 'coordinator', 'state.sqlite');
  const local = join(root, 'app', '.devcontour-local', 'state.sqlite');
  const db = new DatabaseSync(coordinator);
  const row = db.prepare('SELECT data FROM state WHERE id=1').get() as { data: string };
  db.prepare('UPDATE state SET data=? WHERE id=1').run(row.data.split(generatedAt).join(root));
  db.close();
  const ldb = new DatabaseSync(local);
  ldb.prepare('UPDATE owner SET coordinator=? WHERE id=1').run(coordinator);
  ldb.close();
  return {
    file: coordinator,
    files: [coordinator, local],
    open: () => new Store(coordinator, [{ id: 'app', path: join(root, 'app') }]),
  };
}

for (const [name, copy] of [
  ['central', centralCopy],
  ['component', componentCopy],
] as const) {
  test(`T35 ${name}: база прежней версии читается адаптером без setup и записи; новые поля не выдумываются`, () => {
    const c = copy();
    const before = c.files.map(dump);
    const s = new DevContourExecutionStore(c.open(), options);
    const works = s.read((v) => v.works());
    const attempts = s.read((v) => v.attempts());
    const byTitle = (title: string) => {
      const w = works.find((x) => x.order.title === title);
      assert.ok(w, title);
      return w;
    };
    // Принятая задача: result SHA и evidence обеих фаз прежней попытки.
    const accepted = byTitle('Задача accepted');
    assert.equal(accepted.status, 'done');
    assert.equal(accepted.resultSha, '3'.repeat(40));
    const done = attempts.find((a) => a.workId === accepted.id && a.status === 'succeeded')!;
    assert.deepEqual(done.evidence.map((e) => `${e.phase}/${e.gate}`).sort(), [
      'candidate/independent-review',
      'candidate/test',
      'integration/independent-review',
      'integration/test',
    ]);
    // Прежняя попытка не получает сведений, которых у неё не было.
    for (const a of attempts) {
      assert.equal(a.engineVersion, undefined);
      assert.equal(a.consumerVersion, undefined);
      assert.equal(a.contextSnapshot, undefined);
      assert.equal(a.pinned, undefined);
      assert.equal(a.runtime, 'fixture', 'runtime demo прежней версии — fixture на границе');
    }
    // История отказов, ожидающая задача, активная и попытка в окне update-ref — как записаны.
    const failed = byTitle('Задача failed');
    assert.equal(failed.status, 'failed');
    assert.deepEqual(
      attempts.filter((a) => a.workId === failed.id).map((a) => a.failureKind),
      ['gate', 'review'],
    );
    assert.equal(byTitle('Задача pending').status, 'ready');
    const active = attempts.find((a) => a.workId === byTitle('Задача active').id)!;
    assert.equal(active.status, 'active');
    assert.ok(active.leaseUntil < Date.now(), 'срок владения истёк');
    const window = attempts.find((a) => a.workId === byTitle('Задача window').id)!;
    assert.equal(window.phase, 'integrating');
    assert.equal(window.integrationSha, '5'.repeat(40));
    // Граф доски — задачи активной ревизии; утверждения задач — согласование.
    const graphs = s.read((v) => v.graphs());
    assert.equal(graphs.length, 1);
    assert.equal(graphs[0].graph.orders.length, 5);
    assert.equal(graphs[0].approval?.digest, graphs[0].digest);
    // Пауза отказа рантайма прежнего формата читается по её правилам.
    const control = s.read((v) => v.control());
    assert.equal(control.paused, true);
    assert.equal(control.pauseReason, 'runtime');
    assert.deepEqual(control.pauseFailures, ['provider-auth']);
    // Учёт вызовов прежней формы: задача и доска вызова — поручение и группа.
    const calls = s.read((v) => v.locals('usage'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].owner, 'app');
    assert.equal(calls[0].value.workId, accepted.id);
    assert.equal(calls[0].value.groupId, graphs[0].id);
    assert.equal(calls[0].value.costUsd, 0.25);
    // События прежних версий в нейтральный поток не попадают и не теряются для хоста.
    assert.deepEqual(s.events(), []);
    assert.ok(s.store.allEvents().length > 10);
    assert.equal(
      s.read((v) => v.local('delivery', WORKSPACE_OWNER, 'nothing')),
      undefined,
    );
    s.close();
    assert.deepEqual(c.files.map(dump), before, 'чтение не записало ничего');
  });

  test(`T35 ${name}: запись прежних задач и попыток без изменений не меняет их записи (поля хоста сохранены)`, () => {
    const c = copy();
    const s = new DevContourExecutionStore(c.open(), options);
    const before = s.store.read();
    s.transact('run.phase', (tx) => {
      for (const w of tx.works()) tx.putWork(w);
      for (const a of tx.attempts()) tx.putAttempt(a);
    });
    const after = s.store.read();
    assert.deepEqual(after.tasks, before.tasks);
    assert.deepEqual(after.runs, before.runs);
    s.close();
  });
}
