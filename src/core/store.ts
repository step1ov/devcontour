import { ComponentStorage, type ComponentLocation } from './component-storage.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { emptyState, type DevContourState, type AuditEvent } from './model.ts';
/**
 * Пауза, записанная прежней версией, читается по её правилам.
 *
 * Обновление DevContour — не разрешение продолжать очередь. Прежняя версия
 * хранила одну причину в `pauseFailure`; если её не прочитать, список
 * блокировок выглядит пустым, и первое же восстановление снимает паузу, под
 * которой стоит отказ провайдера. Поэтому старая причина переносится в
 * список, а пауза рантайма, причины которой не записаны вовсе, получает
 * `unknown`: восстановление снимает только названную причину, а неизвестную
 * не называет никто — такую паузу снимает человек.
 *
 * Идемпотентно: повторное чтение ничего не меняет.
 */
function normalizePause(state: DevContourState & { pauseFailure?: unknown }) {
  const legacy = state.pauseFailure;
  delete state.pauseFailure;
  if (typeof legacy === 'string')
    state.pauseFailures = [
      ...new Set([
        ...(state.pauseFailures ?? []),
        legacy as NonNullable<typeof state.pauseFailures>[number],
      ]),
    ];
  if (state.paused && state.pauseReason === 'runtime' && !state.pauseFailures?.length)
    state.pauseFailures = ['unknown'];
}
export class Store {
  private db: DatabaseSync;
  private components?: ComponentStorage;
  private transaction = false;
  private savepoint = 0;
  private projectionPending = false;
  onCommit?: () => void;
  // Which projections onCommit writes: 'product' before a stack exists,
  // 'full' once the technical configuration adds the delivery journal.
  projectionKind?: 'product' | 'full';
  projectionError?: string;
  constructor(
    path: string,
    locations?: ComponentLocation[],
    migrate = false,
    journalMode?: 'DELETE',
  ) {
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
      `PRAGMA journal_mode=${journalMode ?? (locations?.length ? 'DELETE' : 'WAL')}; PRAGMA busy_timeout=20000; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;`,
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
  read(): DevContourState {
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
  private readUnlocked(): DevContourState {
    const row = this.db.prepare('SELECT data FROM main.state WHERE id=1').get() as { data: string };
    const raw = JSON.parse(row.data);
    const state = this.components ? this.components.read(raw) : raw;
    if (!this.components && state.componentLayout)
      throw new Error('Для этой БД требуется component storage');
    if (state.version !== 1) throw new Error('Unsupported state version');
    state.changeSets ??= [];
    for (const task of state.tasks) task.repositoryId ??= 'main';
    normalizePause(state);
    return state;
  }
  // Synchronous composition: local idempotency records and domain mutations commit together.
  atomic<T>(action: () => T): T {
    const outer = this.transaction;
    const point = 'nested_' + ++this.savepoint;
    const pending = this.projectionPending;
    this.db.exec(outer ? `SAVEPOINT ${point}` : 'BEGIN IMMEDIATE');
    this.transaction = true;
    let value: T;
    try {
      value = action();
      if (value && typeof (value as any).then === 'function')
        throw new Error('Store.atomic cannot await external work');
      this.db.exec(outer ? `RELEASE ${point}` : 'COMMIT');
    } catch (error) {
      this.db.exec(outer ? `ROLLBACK TO ${point}; RELEASE ${point}` : 'ROLLBACK');
      this.projectionPending = pending;
      this.transaction = outer;
      throw error;
    }
    this.transaction = outer;
    if (!outer && this.projectionPending) {
      this.projectionPending = false;
      this.refreshProjection();
    }
    return value;
  }
  change<T>(type: string, action: (state: DevContourState) => T): T {
    return this.atomic(() => {
      const state = this.read();
      const before = JSON.stringify(state);
      const result = action(state);
      if (before === JSON.stringify(state)) return result;
      if (this.components) this.components.write(state);
      else this.db.prepare('UPDATE main.state SET data=? WHERE id=1').run(JSON.stringify(state));
      if (type !== 'heartbeat') {
        const at = new Date().toISOString();
        const inserted = this.db
          .prepare('INSERT INTO main.events(at,type,data) VALUES(?,?,?)')
          .run(at, type, this.components ? 'null' : JSON.stringify(result ?? null));
        this.components?.event(Number(inserted.lastInsertRowid), at, type, result ?? null, state);
        this.projectionPending = true;
      }
      return result;
    });
  }
  localRecords<T>(namespace: string, owner?: string): Record<string, T> {
    const schema = this.syncSchema(owner);
    if (
      !this.db
        .prepare(
          `SELECT name FROM ${schema}.sqlite_master WHERE type='table' AND name='local_workflow'`,
        )
        .get()
    )
      return {};
    const rows = this.db
      .prepare(`SELECT key,data FROM ${schema}.local_workflow WHERE namespace=? AND owner=?`)
      .all(namespace, owner ?? '@workspace') as { key: string; data: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.data)]));
  }
  saveLocal(namespace: string, owner: string | undefined, key: string, value: unknown) {
    if (!this.transaction) throw new Error('Local workflow writes require an atomic transaction');
    const schema = this.syncSchema(owner);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${schema}.local_workflow (namespace TEXT NOT NULL, owner TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(namespace,owner,key))`,
    );
    this.db
      .prepare(`INSERT OR REPLACE INTO ${schema}.local_workflow VALUES(?,?,?,?)`)
      .run(namespace, owner ?? '@workspace', key, JSON.stringify(value));
  }
  refreshProjection() {
    try {
      this.onCommit?.();
      this.projectionError = undefined;
    } catch (error) {
      this.projectionError = String(error);
    }
  }
  // Проекции сериализуются между процессами. Без этого два процесса читают
  // состояние в разном возрасте и пишут одни и те же файлы: младший снимок
  // ложится поверх старшего, и запись, уже попавшая в журнал, из него исчезает.
  // База её сохраняет, но видимая история теряет событие до следующей проекции —
  // а журнал обещан append-only, и «почти всегда» тут не считается.
  //
  // Раньше эту сериализацию сняли ради «database is locked»: лок держался всё
  // время файловой записи. Причина была не в самой сериализации, а в коротком
  // ожидании — busy_timeout поднят до 20 секунд, и проекция запускается только
  // после настоящего изменения.
  project(write: (state: DevContourState, events: AuditEvent[]) => void) {
    this.db.exec('BEGIN IMMEDIATE');
    this.transaction = true;
    try {
      const state = this.read();
      const events = this.allEvents();
      // Снимок старше уже спроецированного писать нечего: его файлы легли бы
      // поверх более новых и стёрли бы из видимой истории событие, которое там
      // уже есть. Заодно это делает повторную проекцию бесплатной — лок
      // отпускается сразу, не дожидаясь файловой записи.
      const version = events.at(-1)?.id ?? 0;
      const projected = this.localRecords<number>('projection')['version'] ?? 0;
      if (version > projected || !events.length) {
        this.saveLocal('projection', undefined, 'version', version);
        write(state, events);
      }
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
