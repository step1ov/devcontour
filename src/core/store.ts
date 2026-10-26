import { ComponentStorage, type ComponentLocation } from './component-storage.ts';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
/** Приводит паузу прежнего формата к текущему; `true` — если что-то изменилось. */
function normalizePause(state: DevContourState & { pauseFailure?: unknown }) {
  const changed =
    'pauseFailure' in state ||
    (state.paused && state.pauseReason === 'runtime' && !state.pauseFailures?.length);
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
  return !!changed;
}
/** Служебные файлы журнала SQLite рядом с базой. */
export const journalFiles = (path: string) =>
  ['-wal', '-shm', '-journal'].map((suffix) => path + suffix);

/** База в режиме WAL: версии записи и чтения в заголовке файла (байты 18–19) равны 2. */
function walMode(path: string) {
  const header = Buffer.alloc(20);
  const fd = openSync(path, 'r');
  try {
    if (readSync(fd, header, 0, 20, 0) < 20) return false;
  } finally {
    closeSync(fd);
  }
  return header[18] === 2 && header[19] === 2;
}

/**
 * Адрес базы для соединения только для чтения. Даже такое соединение с базой
 * в режиме WAL создаёт рядом `-wal` и `-shm`, если их нет. База WAL без
 * служебных файлов журнала не имеет незавершённых записей и открытых
 * writers: она открывается как неизменяемая (`immutable=1`), без файлов
 * рядом. Есть файлы журнала — обычным соединением: чтение учитывает журнал.
 * Базу в режиме DELETE соединение только для чтения файлами не дополняет, а
 * writer между транзакциями файлов не оставляет: она открывается обычно, с
 * блокировками, — неизменяемое чтение допустило бы разорванное чтение.
 * Writer, начавший работу во время неизменяемого чтения, проверяет
 * вызывающий (`journalFiles`, отпечаток файла базы).
 */
export function readOnlyLocation(path: string): string | URL {
  if (journalFiles(path).some((f) => existsSync(f)) || !walMode(path)) return path;
  const url = pathToFileURL(resolve(path));
  url.searchParams.set('immutable', '1');
  return url;
}

export class Store {
  private db: DatabaseSync;
  /** Файл БД: его каталог — локальный корень, который не должен попадать в Git. */
  readonly file: string;
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
    /**
     * Только чтение: существующая база открывается соединением только для
     * чтения — без каталогов, PRAGMA режима журнала, DDL, начальных строк и
     * присвоения владельца базам компонентов. Отсутствующая база — отказ.
     */
    readonly readOnly = false,
  ) {
    this.file = path;
    if (readOnly) {
      if (path === ':memory:' || !existsSync(path))
        throw new Error('База состояния не найдена: ' + path);
      this.db = new DatabaseSync(readOnlyLocation(path), { readOnly: true });
    } else {
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
      this.db = new DatabaseSync(path);
    }
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
    if (readOnly) {
      this.db.exec('PRAGMA busy_timeout=20000;');
      if (
        !this.db
          .prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name='state'")
          .get() ||
        !this.db.prepare('SELECT 1 FROM main.state WHERE id=1').get()
      ) {
        this.db.close();
        throw new Error('В базе нет состояния: ' + path);
      }
      if (locations?.length) {
        try {
          this.components = new ComponentStorage(this.db, locations, path, true);
        } catch (e) {
          this.db.close();
          throw e;
        }
      }
      return;
    }
    this.db.exec(
      `PRAGMA journal_mode=${journalMode ?? (locations?.length ? 'DELETE' : 'WAL')}; PRAGMA busy_timeout=20000; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;`,
    );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS revision (id INTEGER PRIMARY KEY CHECK(id=1), n INTEGER NOT NULL, lease INTEGER NOT NULL DEFAULT 0); INSERT OR IGNORE INTO revision (id,n) VALUES(1,0);',
    );
    // Таблица ревизии первой редакции не имела счётчика сроков владения.
    if (
      !(this.db.prepare('PRAGMA main.table_info(revision)').all() as { name: string }[]).some(
        (c) => c.name === 'lease',
      )
    )
      this.db.exec('ALTER TABLE main.revision ADD COLUMN lease INTEGER NOT NULL DEFAULT 0');
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
              // Локальные записи компонентов (вызовы моделей, решения ведущего)
              // переезжают в их базы вместе с состоянием: иначе после миграции
              // они не читались бы, и расход компонента обнулился бы.
              if (
                this.db
                  .prepare(
                    "SELECT name FROM main.sqlite_master WHERE type='table' AND name='local_workflow'",
                  )
                  .get()
              ) {
                const rows = this.db
                  .prepare(
                    "SELECT namespace,owner,key,data FROM main.local_workflow WHERE owner != '@workspace'",
                  )
                  .all() as { namespace: string; owner: string; key: string; data: string }[];
                for (const row of rows) {
                  // Записи владельца, которого нет среди компонентов, остаются.
                  if (!locations.some((l) => l.id === row.owner)) continue;
                  const schema = this.components.schema(row.owner);
                  this.db.exec(
                    `CREATE TABLE IF NOT EXISTS ${schema}.local_workflow (namespace TEXT NOT NULL, owner TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(namespace,owner,key))`,
                  );
                  this.db
                    .prepare(`INSERT OR REPLACE INTO ${schema}.local_workflow VALUES(?,?,?,?)`)
                    .run(row.namespace, row.owner, row.key, row.data);
                  this.db
                    .prepare(
                      'DELETE FROM main.local_workflow WHERE namespace=? AND owner=? AND key=?',
                    )
                    .run(row.namespace, row.owner, row.key);
                }
              }
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
    // Компонентное хранение читает несколько баз — одним снимком; внутри
    // `snapshot()` или транзакции записи используется уже открытый.
    if (!this.components) return this.readUnlocked();
    return this.atomicRead(() => this.readUnlocked());
  }
  /** Согласованное чтение: ревизия и состояние из одного снимка БД. */
  private reading = false;
  /**
   * Когда началось текущее чтение: снимок БД не старше этого момента. Всё,
   * что истекло позже, могло быть продлено записью, которой снимок не видит.
   */
  private readStartedAt = 0;
  private atomicRead<T>(read: () => T): T {
    if (this.transaction || this.reading) return read();
    this.readStartedAt = Date.now();
    this.db.exec('BEGIN');
    this.reading = true;
    try {
      const value = read();
      this.db.exec('COMMIT');
      return value;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.reading = false;
    }
  }
  private readUnlocked(): DevContourState {
    return this.load().state;
  }
  /**
   * Состояние вместе с текстом строки, из которой оно прочитано. `text`
   * возвращается, только если чтение ничего не нормализовало: тогда он равен
   * сериализации состояния, и запись сравнивает с ним, не сериализуя всё
   * состояние ещё раз. Сериализация большого состояния — основная цена каждой
   * записи, включая heartbeat.
   */
  private load(): { state: DevContourState; text?: string } {
    const row = this.db.prepare('SELECT data FROM main.state WHERE id=1').get() as { data: string };
    // Строка прежних версий может не иметь полей, которые тип считает
    // обязательными; ниже они восполняются.
    const raw = JSON.parse(row.data) as DevContourState & { componentLayout?: unknown };
    const state: DevContourState & { componentLayout?: unknown; changeSets?: unknown[] } = this
      .components
      ? this.components.read(raw)
      : raw;
    if (!this.components && state.componentLayout)
      throw new Error('Для этой БД требуется component storage');
    if (state.version !== 1) throw new Error('Unsupported state version');
    let normalized = !state.changeSets;
    state.changeSets ??= [];
    for (const task of state.tasks)
      if (!task.repositoryId) {
        task.repositoryId = 'main';
        normalized = true;
      }
    if (normalizePause(state)) normalized = true;
    return { state, text: this.components || normalized ? undefined : row.data };
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
      this.cached = undefined;
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
      const loaded = this.load();
      const state = loaded.state;
      const before = loaded.text ?? JSON.stringify(state);
      const result = action(state);
      const after = JSON.stringify(state);
      if (before === after) return result;
      if (this.components) this.components.write(state);
      else this.db.prepare('UPDATE main.state SET data=? WHERE id=1').run(after);
      // Heartbeat продлевает только сроки владения (lease): ревизия данных от
      // них не растёт, иначе каждый опрос панели видел бы «изменение». Сроки
      // ведёт отдельный счётчик — по нему кэш узнаёт, что они продлены.
      this.bump(type === 'heartbeat' ? 'lease' : 'data');
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
  /**
   * Событие журнала в открытой транзакции, когда документ не изменился:
   * `change` такое событие не пишет. Нужно транзакциям исполнения, у которых
   * есть только событие или локальная запись с событием. Путь записи — тот же,
   * что у `change`: central — `main.events`, component — событие компонента.
   */
  appendEvent(type: string, data: unknown, revision: 'data' | 'lease' = 'data') {
    if (!this.transaction) throw new Error('Store.appendEvent требует открытой транзакции');
    if (type === 'heartbeat') throw new Error('heartbeat не пишет событие журнала');
    const at = new Date().toISOString();
    const inserted = this.db
      .prepare('INSERT INTO main.events(at,type,data) VALUES(?,?,?)')
      .run(at, type, this.components ? 'null' : JSON.stringify(data ?? null));
    if (this.components)
      this.components.event(
        Number(inserted.lastInsertRowid),
        at,
        type,
        data ?? null,
        this.load().state,
      );
    // Событие о сроках владения (роль controller) — как heartbeat: видимые
    // данные не меняются, растёт только счётчик сроков.
    this.bump(revision);
    this.projectionPending = true;
    return Number(inserted.lastInsertRowid);
  }
  /** Номер последнего события журнала (0 — журнал пуст). */
  lastEventId(): number {
    const row = this.db.prepare('SELECT max(id) AS n FROM main.events').get() as {
      n: number | null;
    };
    return row.n ?? 0;
  }
  /** События журнала с номером больше `after`, по возрастанию, не больше `limit`. */
  eventsAfter(after: number, limit: number): AuditEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM main.events WHERE id>? ORDER BY id LIMIT ?')
      .all(after, limit) as unknown as { id: number; at: string; type: string; data: string }[];
    return this.components
      ? this.components.events(rows)
      : rows.map((e) => ({ ...e, data: JSON.parse(e.data) as unknown }));
  }
  /**
   * Все локальные записи пространства у всех владельцев: coordinator и базы
   * компонентов. Владелец `@workspace` возвращается как `undefined`.
   */
  localEntries<T>(namespace: string): { owner: string | undefined; key: string; value: T }[] {
    const schemas = ['main', ...(this.components?.locations.map((l) => l.schema) ?? [])];
    return schemas.flatMap((schema) => {
      if (
        !this.db
          .prepare(
            `SELECT name FROM ${schema}.sqlite_master WHERE type='table' AND name='local_workflow'`,
          )
          .get()
      )
        return [];
      const rows = this.db
        .prepare(
          `SELECT owner,key,data FROM ${schema}.local_workflow WHERE namespace=? ORDER BY owner,key`,
        )
        .all(namespace) as { owner: string; key: string; data: string }[];
      return rows.map((r) => ({
        owner: r.owner === '@workspace' ? undefined : r.owner,
        key: r.key,
        value: JSON.parse(r.data) as T,
      }));
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
    this.bump('data');
  }
  private bump(kind: 'data' | 'lease') {
    this.db
      .prepare(`UPDATE main.revision SET ${kind === 'data' ? 'n=n+1' : 'lease=lease+1'} WHERE id=1`)
      .run();
  }
  /**
   * Ревизия данных: растёт при каждой записи состояния и каждой локальной
   * записи, в том числе из других процессов той же БД. Продление lease
   * (heartbeat) ведёт отдельный счётчик `lease`: сроки владения меняются
   * часто, а видимые данные — нет.
   */
  revision(): number {
    return this.version().revision;
  }
  version(): { revision: number; lease: number } {
    const row = this.db.prepare('SELECT n, lease FROM main.revision WHERE id=1').get() as {
      n: number;
      lease: number;
    };
    return { revision: row.n, lease: row.lease };
  }
  private cached?: { revision: number; lease: number; readAt: number; state: DevContourState };
  /**
   * Состояние только для чтения, разобранное один раз на версию данных. Для
   * проекций, которые опрашиваются часто. Объект заморожен целиком: изменение
   * не может испортить кэш. Внутри транзакции записи кэш не используется —
   * она может откатиться.
   *
   * Продление lease (heartbeat лидера, попыток, операций) данных не меняет, а
   * случается постоянно; перечитывать из-за него всё состояние незачем.
   * Поэтому по умолчанию кэш перечитывается при любом изменении сроков, а
   * вызывающий, которому важны только некоторые сроки, передаёт `leaseStale`:
   * кэш со старыми сроками остаётся, пока эта проверка не скажет, что
   * показанный по нему срок уже мог истечь.
   */
  readShared(leaseStale?: (state: Readonly<DevContourState>, readAt: number) => boolean): {
    revision: number;
    lease: number;
    /**
     * Когда началось текущее чтение: lease, истёкший позже, мог быть продлён
     * записью, которой этот снимок не видит.
     */
    snapshotAt: number;
    state: Readonly<DevContourState>;
  } {
    return this.atomicRead(() => {
      const version = this.version();
      if (this.transaction)
        return { ...version, snapshotAt: Date.now(), state: deepFreeze(this.readUnlocked()) };
      const cached = this.cached;
      const fresh =
        cached?.revision === version.revision &&
        (cached.lease === version.lease ||
          (leaseStale !== undefined && !leaseStale(cached.state, cached.readAt)));
      // Время кэша — начало чтения, а не его конец: снимок мог открыться до
      // продления lease другим процессом и разобраться уже после старого
      // срока. Такой срок кэш считает истёкшим после чтения и перечитывает.
      if (!fresh)
        this.cached = {
          ...version,
          readAt: this.reading ? this.readStartedAt : Date.now(),
          state: deepFreeze(this.readUnlocked()),
        };
      const { revision, lease, state } = this.cached!;
      return { revision, lease, snapshotAt: this.readStartedAt, state };
    });
  }
  /** Согласованное чтение нескольких значений из одного снимка БД. */
  snapshot<T>(read: () => T): T {
    return this.atomicRead(read);
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
  /** Страница журнала: новые сначала, строго раньше `before`. */
  eventsPage(before: number | undefined, limit: number): AuditEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM main.events WHERE id<? ORDER BY id DESC LIMIT ?')
      .all(before ?? Number.MAX_SAFE_INTEGER, limit) as unknown as {
      id: number;
      at: string;
      type: string;
      data: string;
    }[];
    return this.components
      ? this.components.events(rows)
      : rows.map((e) => ({ ...e, data: JSON.parse(e.data) as unknown }));
  }
  events(after = 0): AuditEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM main.events WHERE id>? ORDER BY id DESC LIMIT 150')
      .all(after) as unknown as { id: number; at: string; type: string; data: string }[];
    return this.components
      ? this.components.events(rows)
      : rows.map((e) => ({ ...e, data: JSON.parse(e.data) }));
  }
  /**
   * Согласованная копия базы в новый файл. SQLite снимает её в одной
   * транзакции чтения, поэтому работающий сервер не нужно останавливать.
   * Компонентное хранение распределено по нескольким базам, и копия одной из
   * них не была бы согласованной: такой случай отклоняется явно.
   */
  backup(out: string) {
    if (this.components)
      throw new Error('Backup компонентного хранения не поддерживается: базы копируются вместе');
    this.db.prepare('VACUUM main INTO ?').run(out);
  }
  eventCount() {
    return (this.db.prepare('SELECT count(*) AS n FROM main.events').get() as { n: number }).n;
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

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
