/**
 * T41: состояние, которого эта версия не знает, отклоняется до записи и до
 * выдачи — и неизвестная версия документа, и роль controller, записанная
 * более новым пакетом harness (поле, которого строгая схема этой версии не
 * принимает). Сценарий обновления между двумя архивами —
 * `scripts/upgrade-check.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { config, fixture, input } from './helpers.ts';

const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

function stateWith(edit: (state: Record<string, unknown>) => void) {
  const f = fixture();
  const b = f.h.createBoard('Board');
  f.h.addTask(b.id, input());
  f.h.approve(b.id);
  f.h.pause(false);
  f.store.close();
  const file = join(f.root, 'state.sqlite');
  const db = new DatabaseSync(file);
  const row = db.prepare('SELECT data FROM main.state WHERE id=1').get() as { data: string };
  const state = JSON.parse(row.data) as Record<string, unknown>;
  edit(state);
  db.prepare('UPDATE main.state SET data=? WHERE id=1').run(JSON.stringify(state));
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  return { ...f, file };
}

test('T41: роль controller более новой версии harness — отказ до записи и выдачи', () => {
  const f = stateWith((state) => {
    state.leader = {
      owner: 'newer-controller',
      leaseUntil: Date.now() + 60_000,
      engineVersion: '9.9.9-newer',
    };
  });
  try {
    const before = hash(f.file);
    const store = new Store(f.file);
    try {
      const h = new DevContour(store, config());
      assert.throws(() => h.claim('this-process'), /Роль controller/);
      assert.throws(() => h.leader('this-process'), /Роль controller/);
      assert.equal(store.read().runs.length, 0, 'выдачи нет');
    } finally {
      store.close();
    }
    assert.equal(hash(f.file), before, 'база не изменилась');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('T41: неизвестная версия документа состояния — отказ до записи', () => {
  const f = stateWith((state) => {
    state.version = 2;
  });
  try {
    const before = hash(f.file);
    assert.throws(() => {
      const store = new Store(f.file);
      try {
        new DevContour(store, config()).claim('this-process');
      } finally {
        store.close();
      }
    }, /Unsupported state version/);
    assert.equal(hash(f.file), before, 'база не изменилась');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
