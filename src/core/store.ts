import { ComponentStorage, type ComponentLocation } from './component-storage.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { emptyState, type HarnessState, type AuditEvent } from './model.ts';
export class Store {
  private db: DatabaseSync;
  private components?: ComponentStorage;
  private transaction = false;
  onCommit?: () => void;
  projectionError?: string;
  constructor(path: string, locations?: ComponentLocation[], migrate = false) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    if (
      !locations?.length &&
      this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='owner'").get()
    ) {
      const owner = this.db.prepare('SELECT coordinator FROM owner WHERE id=1').get() as
        { coordinator: string } | undefined;
      if (owner) {
        this.db.close();
        throw new Error(
          'Это локальная база компонента; используйте coordinator: ' + owner.coordinator,
        );
      }
    }
    if (
      !locations?.length &&
      this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='state'").get()
    ) {
      const row = this.db.prepare('SELECT data FROM state WHERE id=1').get() as
        { data: string } | undefined;
      if (row && JSON.parse(row.data).componentLayout) {
        this.db.close();
        throw new Error('Для этой БД требуется component storage');
      }
    }
    this.db.exec(
      `PRAGMA journal_mode=${locations?.length ? 'DELETE' : 'WAL'}; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;`,
    );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);',
    );
    this.db
      .prepare('INSERT OR IGNORE INTO main.state (id,data) VALUES(1,?)')
      .run(JSON.stringify(emptyState()));
    if (locations?.length) {
      try {
        this.components = new ComponentStorage(this.db, locations, path);
        if (migrate) {
          this.db.exec('BEGIN IMMEDIATE');
          try {
            const raw = JSON.parse(
              (this.db.prepare('SELECT data FROM main.state WHERE id=1').get() as { data: string })
                .data,
            );
            if (!raw.componentLayout) {
              raw.changeSets ??= [];
              for (const task of raw.tasks) task.repositoryId ??= 'main';
              this.components.write(raw);
              const events = this.db
                .prepare('SELECT * FROM main.events ORDER BY id')
                .all() as unknown as { id: number; at: string; type: string; data: string }[];
              for (const event of events)
                this.components.event(event.id, event.at, event.type, JSON.parse(event.data), raw);
            }
            this.db.exec('COMMIT');
          } catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
          }
          this.db.exec('VACUUM main');
        }
        this.read();
      } catch (e) {
        this.db.close();
        throw e;
      }
    }
  }
  read(): HarnessState {
    if (this.transaction || !this.components) return this.readUnlocked();
    this.db.exec('BEGIN');
    try {
      const state = this.readUnlocked();
      this.db.exec('COMMIT');
      return state;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  private readUnlocked(): HarnessState {
    const row = this.db.prepare('SELECT data FROM main.state WHERE id=1').get() as { data: string };
    const raw = JSON.parse(row.data);
    const state = this.components ? this.components.read(raw) : raw;
    if (!this.components && state.componentLayout)
      throw new Error('Для этой БД требуется component storage');
    if (state.version !== 1) throw new Error('Unsupported state version');
    state.changeSets ??= [];
    for (const task of state.tasks) task.repositoryId ??= 'main';
    return state;
  }
  change<T>(type: string, action: (state: HarnessState) => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    this.transaction = true;
    let result: T;
    let changed = false;
    try {
      const state = this.read();
      const before = JSON.stringify(state);
      result = action(state);
      if (before === JSON.stringify(state)) {
        this.db.exec('COMMIT');
        this.transaction = false;
        return result;
      }
      if (this.components) this.components.write(state);
      else this.db.prepare('UPDATE main.state SET data=? WHERE id=1').run(JSON.stringify(state));
      if (type !== 'heartbeat') {
        const at = new Date().toISOString();
        const inserted = this.db
          .prepare('INSERT INTO main.events(at,type,data) VALUES(?,?,?)')
          .run(at, type, this.components ? 'null' : JSON.stringify(result ?? null));
        this.components?.event(Number(inserted.lastInsertRowid), at, type, result ?? null, state);
      }
      this.db.exec('COMMIT');
      changed = true;
      this.transaction = false;
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.transaction = false;
      throw error;
    }
    if (changed && type !== 'heartbeat') this.refreshProjection();
    return result!;
  }
  refreshProjection() {
    try {
      this.onCommit?.();
      this.projectionError = undefined;
    } catch (error) {
      this.projectionError = String(error);
    }
  }
  project(write: (state: HarnessState, events: AuditEvent[]) => void) {
    this.db.exec('BEGIN IMMEDIATE');
    this.transaction = true;
    try {
      write(this.read(), this.allEvents());
      this.db.exec('COMMIT');
      this.transaction = false;
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.transaction = false;
      throw error;
    }
  }
  allEvents(): AuditEvent[] {
    const rows = this.db.prepare('SELECT * FROM main.events ORDER BY id').all() as unknown as {
      id: number;
      at: string;
      type: string;
      data: string;
    }[];
    return this.components
      ? this.components.events(rows)
      : rows.map((e) => ({ ...e, data: JSON.parse(e.data) }));
  }
  events(after = 0): AuditEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM main.events WHERE id>? ORDER BY id DESC LIMIT 150')
      .all(after) as unknown as { id: number; at: string; type: string; data: string }[];
    return this.components
      ? this.components.events(rows)
      : rows.map((e) => ({ ...e, data: JSON.parse(e.data) }));
  }
  close() {
    this.db.close();
  }
  private syncSchema(owner?: string) {
    return owner && this.components ? this.components.schema(owner) : 'main';
  }
  syncBaseline(owner?: string): unknown {
    const schema = this.syncSchema(owner);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${schema}.git_sync (owner TEXT PRIMARY KEY, data TEXT NOT NULL)`,
    );
    const row = this.db
      .prepare(`SELECT data FROM ${schema}.git_sync WHERE owner=?`)
      .get(owner ?? '@workspace') as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  saveSyncBaseline(owner: string | undefined, value: unknown) {
    if (!this.transaction) throw new Error('Sync baseline requires a Store transaction');
    const schema = this.syncSchema(owner);
    this.syncBaseline(owner);
    this.db
      .prepare(`INSERT OR REPLACE INTO ${schema}.git_sync(owner,data) VALUES(?,?)`)
      .run(owner ?? '@workspace', JSON.stringify(value));
  }
}
