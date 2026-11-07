import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.ts';
import { Preparation } from '../src/core/preparation.ts';
import type { AttentionItem } from '../src/core/attention-model.ts';

/**
 * Полный дамп базы: все таблицы всех файлов `*.sqlite` каталога, строки по
 * rowid. Чтение центра внимания не должно менять ни одной строки.
 */
export function dumpDatabase(...paths: string[]) {
  const out: Record<string, unknown> = {};
  for (const path of paths) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];
      for (const { name } of tables)
        out[`${path}:${name}`] = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
    } finally {
      db.close();
    }
  }
  return JSON.stringify(out);
}

/** Время изменения файлов каталога данных, кроме самой базы и её журнала WAL. */
export function fileStamps(dir: string) {
  const out: Record<string, number> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const s = statSync(path);
      if (s.isDirectory()) walk(path);
      else if (!/state\.sqlite(-wal|-shm)?$/.test(name) && !/\.sqlite(-wal|-shm)$/.test(name))
        out[path] = s.mtimeMs;
    }
  };
  walk(dir);
  return out;
}

/** Хранилище подготовки до setup: только документ подготовки, без конфигурации. */
export function preparationFixture() {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-attention-'));
  const store = new Store(join(root, 'state.sqlite'));
  const p = new Preparation(store);
  p.execute('preparation_create', { title: 'Модерация чата' });
  const status = p.status();
  if (!status.enabled) throw new Error('Missing preparation');
  return {
    root,
    store,
    p,
    changeId: status.activeChangeId!,
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export const bySource = (items: AttentionItem[], source: AttentionItem['source']) =>
  items.filter((i) => i.source === source);
export const byKey = (items: AttentionItem[], key: string) =>
  items.find((i) => i.sourceKey === key);
