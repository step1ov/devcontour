import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync, existsSync, lstatSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { emptyState, type DevContourState, type AuditEvent } from './model.ts';

export interface ComponentLocation {
  id: string;
  path: string;
}
const marker = '$devcontourComponentObject';
export class ComponentStorage {
  readonly locations: { id: string; path: string; schema: string }[];
  constructor(
    readonly db: DatabaseSync,
    components: ComponentLocation[],
    readonly coordinator: string,
  ) {
    if (coordinator === ':memory:')
      throw new Error('Component storage требует файловую coordinator DB');
    if (components.length > 10)
      throw new Error('Локальный SQLite coordinator поддерживает до 10 компонентов (ATTACH limit)');
    if (new Set(components.map((r) => r.id)).size !== components.length)
      throw new Error('Повтор component ID');
    this.locations = components.map((repo, index) => {
      const root = realpathSync(repo.path),
        path = join(root, '.devcontour-local', 'state.sqlite');
      for (const p of [join(root, '.devcontour-local'), dirname(path), path])
        if (existsSync(p) && lstatSync(p).isSymbolicLink())
          throw new Error('Component storage не пишет через symlink');
      if (resolve(path) === realpathSync(coordinator))
        throw new Error('Coordinator DB должна находиться вне компонентов');
      mkdirSync(dirname(path), { recursive: true });
      const schema = 'component' + index;
      db.prepare(`ATTACH DATABASE ? AS ${schema}`).run(path);
      db.exec(`PRAGMA ${schema}.journal_mode=DELETE; PRAGMA ${schema}.synchronous=FULL; PRAGMA ${schema}.secure_delete=ON;
        CREATE TABLE IF NOT EXISTS ${schema}.state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ${schema}.events (id INTEGER PRIMARY KEY, at TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ${schema}.objects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ${schema}.owner (id INTEGER PRIMARY KEY CHECK(id=1), coordinator TEXT NOT NULL, repositoryId TEXT NOT NULL);`);
      const owner = db.prepare(`SELECT * FROM ${schema}.owner WHERE id=1`).get() as
        { coordinator: string; repositoryId: string } | undefined;
      if (
        owner &&
        (owner.coordinator !== realpathSync(coordinator) || owner.repositoryId !== repo.id)
      )
        throw new Error('База компонента принадлежит другому coordinator: ' + repo.id);
      const prior = db.prepare(`SELECT data FROM ${schema}.state WHERE id=1`).get() as
        { data: string } | undefined;
      if (
        !owner &&
        prior &&
        ['tasks', 'runs', 'boards', 'contracts'].some((key) => JSON.parse(prior.data)[key]?.length)
      )
        throw new Error(
          'Нельзя автоматически присоединить самостоятельную базу с задачами: ' + repo.id,
        );
      db.prepare(`INSERT OR IGNORE INTO ${schema}.owner VALUES(1,?,?)`).run(
        realpathSync(coordinator),
        repo.id,
      );
      db.prepare(`INSERT OR IGNORE INTO ${schema}.state VALUES(1,?)`).run(
        JSON.stringify(emptyState()),
      );
      return { id: repo.id, path, schema };
    });
  }
  schema(id: string) {
    const location = this.locations.find((c) => c.id === id);
    if (!location) throw new Error('Неизвестный компонент хранилища: ' + id);
    return location.schema;
  }
  private owner(value: any, state: DevContourState): string | undefined {
    if (!value || typeof value !== 'object') return;
    if (
      value.repositoryId &&
      value.scope !== 'workspace' &&
      'acceptance' in value &&
      'role' in value
    )
      return value.repositoryId;
    if (value.taskId)
      return state.tasks.find((t) => t.id === value.taskId && t.scope !== 'workspace')
        ?.repositoryId;
    if (value.repositoryId && 'content' in value && 'approvedAt' in value)
      return value.repositoryId;
    if (value.revisions && value.id) {
      if (value.scope === 'workspace') return;
      if (value.repositoryId) return value.repositoryId;
      const tasks = value.revisions
        .flatMap((r: any) => r.taskIds)
        .map((id: string) => state.tasks.find((t) => t.id === id));
      if (
        tasks.length &&
        tasks.every(
          (t: any) => t && t.scope !== 'workspace' && t.repositoryId === tasks[0].repositoryId,
        )
      )
        return tasks[0].repositoryId;
    }
    const entity = [...state.tasks, ...state.runs, ...state.boards, ...state.contracts].find(
      (x) => x.id === value.id || x.id === value.runId || x.id === value.boardId,
    );
    if (entity && entity !== value) return this.owner(entity, state);
    return;
  }
  private encode(value: unknown, state: DevContourState): string {
    return JSON.stringify(value, (_key, item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      // Only complete local entities are externalized; ID-only links stay common metadata.
      const complete =
        ('role' in item && 'acceptance' in item) ||
        ('taskId' in item && 'evidence' in item) ||
        'revisions' in item ||
        ('content' in item && 'approvedAt' in item);
      const owner = complete ? this.owner(item, state) : undefined;
      if (!owner) return item;
      const data = JSON.stringify(item),
        id = createHash('sha256').update(data).digest('hex');
      this.db
        .prepare(`INSERT OR IGNORE INTO ${this.schema(owner)}.objects(id,data) VALUES(?,?)`)
        .run(id, data);
      return { [marker]: owner, id };
    });
  }
  decode(data: string): any {
    return JSON.parse(data, (_key, item) => {
      if (!item || typeof item !== 'object' || !item[marker]) return item;
      const row = this.db
        .prepare(`SELECT data FROM ${this.schema(item[marker])}.objects WHERE id=?`)
        .get(item.id) as { data: string } | undefined;
      if (!row) throw new Error('Отсутствует локальный snapshot: ' + item.id);
      return JSON.parse(row.data);
    });
  }
  read(main: any): DevContourState {
    if (!main.componentLayout) {
      if (
        main.tasks.length ||
        main.runs.length ||
        main.boards.length ||
        main.contracts.length ||
        main.changeSets?.length
      )
        throw new Error('Нужна команда storage-migrate для прежней общей базы');
      if (
        this.locations.some((l) => {
          const s = JSON.parse(
            (
              this.db.prepare(`SELECT data FROM ${l.schema}.state WHERE id=1`).get() as {
                data: string;
              }
            ).data,
          );
          return s.tasks.length || s.runs.length || s.boards.length || s.contracts.length;
        })
      )
        throw new Error('Отсутствует реестр существующих локальных баз');
      return main;
    }
    const locations = main.componentLayout.locations as { id: string; path: string }[];
    if (
      JSON.stringify(locations) !==
      JSON.stringify(this.locations.map(({ id, path }) => ({ id, path })))
    )
      throw new Error('Реестр компонентов не совпадает с БД; нужна явная миграция состава');
    const merged = this.decode(JSON.stringify(main));
    const local = this.locations.map((l) =>
      JSON.parse(
        (this.db.prepare(`SELECT data FROM ${l.schema}.state WHERE id=1`).get() as { data: string })
          .data,
      ),
    );
    for (const key of ['tasks', 'runs', 'boards', 'contracts']) {
      const entries = [...merged[key], ...local.flatMap((s) => s[key])];
      const map = new Map(entries.map((item: any) => [item.id, item]));
      if (map.size !== entries.length) throw new Error('ID конфликтует между базами компонентов');
      merged[key] = main.componentLayout[key].map((id: string) => {
        const item = map.get(id);
        if (!item) throw new Error('Локальная запись недоступна: ' + id);
        return item;
      });
    }
    delete merged.componentLayout;
    return merged;
  }
  write(state: DevContourState) {
    const main: any = structuredClone(state),
      local = new Map(this.locations.map((l) => [l.id, emptyState()]));
    const layout: any = { locations: this.locations.map(({ id, path }) => ({ id, path })) };
    for (const key of ['tasks', 'runs', 'boards', 'contracts'] as const) {
      layout[key] = state[key].map((x) => x.id);
      main[key] = [];
      for (const value of state[key]) {
        const owner = this.owner(value, state);
        if (owner) (local.get(owner)![key] as any[]).push(value);
        else main[key].push(value);
      }
    }
    main.componentLayout = layout;
    this.db.prepare('UPDATE main.state SET data=? WHERE id=1').run(this.encode(main, state));
    for (const [id, value] of local)
      this.db
        .prepare(`UPDATE ${this.schema(id)}.state SET data=? WHERE id=1`)
        .run(JSON.stringify(value));
    const history = this.db.prepare('SELECT * FROM main.events').all() as unknown as {
      id: number;
      at: string;
      type: string;
      data: string;
    }[];
    for (const e of history) {
      const data = JSON.parse(e.data);
      if (!data?.componentEvent && !data?.[marker]) this.event(e.id, e.at, e.type, data, state);
    }
  }
  event(id: number, at: string, type: string, data: any, state: DevContourState) {
    const owner = this.owner(data, state);
    if (owner) {
      this.db
        .prepare(`INSERT OR REPLACE INTO ${this.schema(owner)}.events VALUES(?,?,?,?)`)
        .run(id, at, type, JSON.stringify(data));
      this.db
        .prepare('UPDATE main.events SET data=? WHERE id=?')
        .run(JSON.stringify({ componentEvent: owner }), id);
    } else
      this.db.prepare('UPDATE main.events SET data=? WHERE id=?').run(this.encode(data, state), id);
  }
  events(rows: { id: number; at: string; type: string; data: string }[]): AuditEvent[] {
    return rows.map((r) => {
      const data = JSON.parse(r.data);
      if (data?.componentEvent) {
        const row = this.db
          .prepare(`SELECT data FROM ${this.schema(data.componentEvent)}.events WHERE id=?`)
          .get(r.id) as { data: string } | undefined;
        if (!row) throw new Error('Локальное событие недоступно');
        return { ...r, data: JSON.parse(row.data) };
      }
      return { ...r, data: this.decode(r.data) };
    });
  }
}
