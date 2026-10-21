/**
 * T41: состояние, которого эта версия не знает, отклоняется до записи и до
 * выдачи — и неизвестная версия документа, и роль controller, записанная
 * более новым пакетом harness (поле, которого строгая схема этой версии не
 * принимает). Сценарии обновления и отката между двумя архивами —
 * `scripts/upgrade-check.mjs` (`--rollback` — T42). doctor называет версии
 * движка, записавшие состояние.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { harnessVersion } from '../src/harness/index.ts';
import { engineCheck } from '../src/runner/doctor.ts';
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

test('doctor называет версию движка и версии, записавшие состояние; живая роль другой версии — блокировка', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const run = (engineVersion?: string) =>
    ({ ...(engineVersion ? { engineVersion } : {}) }) as never;
  const runs = [run('0.1.0-alpha.0.s3.15'), run(harnessVersion), run(), run(harnessVersion)];

  const idle = engineCheck({ runs }, now);
  assert.equal(idle.status, 'passed');
  assert.match(idle.detail, new RegExp(`devcontour-harness ${harnessVersion}`));
  assert.match(idle.detail, /роли controller нет/);
  assert.match(idle.detail, new RegExp(`0\\.1\\.0-alpha\\.0\\.s3\\.15, ${harnessVersion}`));

  const other = { owner: 'c1', leaseUntil: now + 60_000, engineVersion: '9.9.9-other' };
  const blocked = engineCheck({ runs, leader: other }, now);
  assert.equal(blocked.status, 'blocked', 'живая роль другой версии не названа');
  assert.match(blocked.detail, /9\.9\.9-other, живая/);

  const expired = engineCheck({ runs, leader: { ...other, leaseUntil: now - 1 } }, now);
  assert.equal(expired.status, 'passed', 'истёкшая роль другой версии не мешает');
  const own = { owner: 'c1', leaseUntil: now + 60_000, engineVersion: harnessVersion };
  assert.equal(engineCheck({ runs, leader: own }, now).status, 'passed');
});
