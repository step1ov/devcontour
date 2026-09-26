import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { restoreBackup } from '../src/runner/backup.ts';
import { complete, config, fixture, input } from './helpers.ts';

const rows = (path: string) => {
  const db = new DatabaseSync(path);
  try {
    return {
      data: (db.prepare('SELECT data FROM state WHERE id=1').get() as { data: string }).data,
      events: (db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n,
    };
  } finally {
    db.close();
  }
};

test('Запись сравнивает с прочитанной строкой, но не теряет ни изменений, ни нормализации', () => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-store-'));
  const path = join(root, 'state.sqlite');
  try {
    let store = new Store(path);
    const h = new DevContour(store, config());
    h.createBoard('Доска');
    const before = rows(path);
    // Ничего не изменилось — ни записи, ни события.
    store.change('noop', () => ({}));
    assert.deepEqual(rows(path), before);
    // Изменение записано ровно тем текстом, который читается обратно.
    store.change('rename', (s) => {
      s.boards[0].title = 'Новая доска';
      return {};
    });
    const after = rows(path);
    assert.equal(after.events, before.events + 1);
    assert.equal(after.data, JSON.stringify(store.read()));
    store.close();

    // Строка прежнего формата: чтение её нормализует, и пустое изменение не
    // принимает нормализованный текст за исходный.
    const db = new DatabaseSync(path);
    const legacy = JSON.parse(after.data);
    delete legacy.changeSets;
    legacy.pauseFailure = 'environment';
    db.prepare('UPDATE state SET data=? WHERE id=1').run(JSON.stringify(legacy));
    db.close();
    store = new Store(path);
    const events = rows(path).events;
    store.change('noop', () => ({}));
    assert.equal(rows(path).events, events, 'нормализация сама по себе не событие');
    store.change('rename', (s) => {
      s.boards[0].title = 'Ещё раз';
      return {};
    });
    const written = JSON.parse(rows(path).data);
    assert.deepEqual(written.changeSets, []);
    assert.equal('pauseFailure' in written, false);
    assert.deepEqual(written.pauseFailures, ['environment']);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Backup снимается на ходу и восстанавливается отдельно: история цела, владение снято, пропавший SHA назван', async () => {
  const f = fixture();
  const repo = mkdtempSync(join(tmpdir(), 'devcontour-backup-repo-'));
  try {
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@e',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'x',
    ]);
    const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    f.h.config.repository = repo;
    const b = f.h.createBoard('Доска');
    const kept = f.h.addTask(b.id, input('Результат в Git'));
    const lost = f.h.addTask(b.id, input('Результат потерян'));
    const running = f.h.addTask(b.id, input('Идёт работа'));
    f.h.approve(b.id);
    complete(f.h, kept.id);
    complete(f.h, lost.id);
    f.store.change('fixture.result', (s) => {
      s.tasks.find((t) => t.id === kept.id)!.resultSha = sha;
      s.tasks.find((t) => t.id === lost.id)!.resultSha = 'd'.repeat(40);
      return {};
    });
    const active = f.h.claim('owner')!;
    assert.equal(active.taskId, running.id);

    const out = join(f.root, 'backup.sqlite');
    f.store.backup(out);
    const events = f.store.eventCount();
    const target = join(f.root, 'restored');
    const report = await restoreBackup(out, target, f.h.config);
    assert.equal(report.events, events, 'история перенесена целиком');
    assert.equal(report.tasks, 3);
    assert.deepEqual(report.releasedOwnership, [active.id]);
    assert.deepEqual(report.missingResults, [
      { taskId: lost.id, repositoryId: 'main', sha: 'd'.repeat(40) },
    ]);
    assert.equal(report.ready, false);
    // Действующий workspace не тронут: его попытка по-прежнему владеет задачей.
    assert.equal(f.store.read().runs.find((r) => r.id === active.id)!.status, 'active');
    const restored = new Store(join(target, 'state.sqlite'));
    try {
      const run = restored.read().runs.find((r) => r.id === active.id)!;
      assert.equal(run.status, 'expired');
      assert.equal(restored.read().tasks.find((t) => t.id === running.id)!.status, 'failed');
    } finally {
      restored.close();
    }
    // В непустой каталог восстановление не пишет.
    await assert.rejects(restoreBackup(out, target, f.h.config), /не пуст/);
  } finally {
    f.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});
