/**
 * T41: состояние, которого эта версия не знает, отклоняется до записи и до
 * выдачи — и неизвестная версия документа, и роль controller, записанная
 * более новым пакетом harness: живую роль другой версии этот движок не
 * перенимает, а поле роли, которого строгая схема не принимает, — отказ. Сценарии обновления и отката между двумя архивами —
 * `scripts/upgrade-check.mjs` (`--rollback` — T42). doctor называет версии
 * движка, записавшие состояние.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DevContour } from '../src/core/service.ts';
import { Store, readOnlyLocation } from '../src/core/store.ts';
import { harnessVersion } from '../src/harness/index.ts';
import { dataDoctor, doctor, doctorState, engineCheck } from '../src/runner/doctor.ts';
import { config, fixture, input } from './helpers.ts';
import { repositorySchema } from '../src/core/model.ts';

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

test('T41: живая роль controller более новой версии harness — ни выдачи, ни перехвата, база не меняется', () => {
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
      assert.equal(h.claim('this-process'), undefined, 'выдачи нет');
      assert.equal(h.leader('this-process'), false, 'роль другой версии не перенята');
      assert.equal(store.read().runs.length, 0, 'выдачи нет');
    } finally {
      store.close();
    }
    assert.equal(hash(f.file), before, 'база не изменилась');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('T41: роль controller с полем, которого движок не знает, — отказ до записи и выдачи', () => {
  // Более новый движок может записать в роль поле, которого строгая схема этой
  // версии не принимает: такое состояние не читается, а не переписывается.
  const f = stateWith((state) => {
    state.leader = {
      owner: 'newer-controller',
      leaseUntil: Date.now() + 60_000,
      engineVersion: '9.9.9-newer',
      futureField: true,
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
  assert.match(idle.detail, /попыток 4, .*без записанной версии: 1/);
  // Попытки ранних версий без записанной версии — не «нет попыток».
  const early = engineCheck({ runs: [run(), run(), run()] }, now).detail;
  assert.match(early, /попыток 3, без записанной версии: 3/);
  assert.doesNotMatch(early, /нет попыток|попыток нет|записаны версиями/);
  assert.match(engineCheck({ runs: [] }, now).detail, /попыток нет/);

  const other = { owner: 'c1', leaseUntil: now + 60_000, engineVersion: '9.9.9-other' };
  const blocked = engineCheck({ runs, leader: other }, now);
  assert.equal(blocked.status, 'blocked', 'живая роль другой версии не названа');
  assert.match(blocked.detail, /9\.9\.9-other, живая/);

  const expired = engineCheck({ runs, leader: { ...other, leaseUntil: now - 1 } }, now);
  assert.equal(expired.status, 'passed', 'истёкшая роль другой версии не мешает');
  const own = { owner: 'c1', leaseUntil: now + 60_000, engineVersion: harnessVersion };
  assert.equal(engineCheck({ runs, leader: own }, now).status, 'passed');
});

test('S4-R1-02: активную попытку прежней версии движка новый процесс не продолжает её token до истечения срока', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    f.h.addTask(b.id, input());
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('older-process')!;
    assert.ok(run, 'попытка выдана');
    f.h.heartbeat(run.id, run.token); // своя версия ведёт попытку
    // Попытку выдал движок прежней версии; срок не истёк.
    f.store.change('test.older-engine', (state) => {
      const r = state.runs.find((x) => x.id === run.id)!;
      (r as { engineVersion?: string }).engineVersion = '0.0.1-older';
      if (state.leader) (state.leader as { engineVersion?: string }).engineVersion = '0.0.1-older';
    });
    const before = JSON.stringify(f.store.read().runs.find((x) => x.id === run.id));
    assert.throws(() => f.h.heartbeat(run.id, run.token), /выдал движок 0\.0\.1-older/);
    assert.throws(() => f.h.phase(run.id, run.token, 'verifying'), /выдал движок 0\.0\.1-older/);
    assert.equal(
      JSON.stringify(f.store.read().runs.find((x) => x.id === run.id)),
      before,
      'попытка прежней версии изменена',
    );
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

// Снимок всего, что проверка данных могла бы изменить: схемы и строки всех
// таблиц каждой базы и отпечатки остальных файлов под корнями.
function snapshot(...roots: string[]) {
  const out: Record<string, unknown> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (lstatSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.sqlite')) {
        const db = new DatabaseSync(path, { readOnly: true });
        try {
          const tables = db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all() as {
            name: string;
            sql: string | null;
          }[];
          out[path] = {
            journal: (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string })
              .journal_mode,
            tables: tables.map((t) => ({
              ...t,
              rows: t.sql?.startsWith('CREATE TABLE')
                ? db.prepare(`SELECT * FROM "${t.name}"`).all()
                : undefined,
            })),
          };
        } finally {
          db.close();
        }
      } else if (!/-(wal|shm|journal)$/.test(name)) out[path] = hash(path);
    }
  };
  for (const root of roots) walk(root);
  return JSON.stringify(out);
}

function componentWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-data-doctor-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const repos = ['product', 'library'].map((id) => {
    const path = join(root, id);
    mkdirSync(path);
    return repositorySchema.parse({ id, name: id, path, gates: config().gates });
  });
  const c = config({ storage: 'component', workspaceRoot: workspace, repositories: repos });
  const store = new Store(join(workspace, 'state.sqlite'), repos);
  const h = new DevContour(store, c);
  for (const id of ['product', 'library']) {
    const b = h.createBoard('Board ' + id, '', id);
    h.addTask(b.id, { ...input('Task ' + id), repositoryId: id });
  }
  store.close();
  return { root, workspace, repos, config: c };
}

const editDocument = (file: string, edit: (state: Record<string, unknown>) => void) => {
  const db = new DatabaseSync(file);
  const row = db.prepare('SELECT data FROM main.state WHERE id=1').get() as { data: string };
  const state = JSON.parse(row.data) as Record<string, unknown>;
  edit(state);
  db.prepare('UPDATE main.state SET data=? WHERE id=1').run(JSON.stringify(state));
  db.close();
};

/** Живая роль controller другой версии: проверка `engine` её видит, если читает актуальное состояние. */
const liveForeignLeader = (db: DatabaseSync) => {
  const row = db.prepare('SELECT data FROM main.state WHERE id=1').get() as { data: string };
  const state = JSON.parse(row.data) as Record<string, unknown>;
  state.leader = { owner: 'x', leaseUntil: Date.now() + 60_000, engineVersion: '9.9.9-newer' };
  db.prepare('UPDATE main.state SET data=? WHERE id=1').run(JSON.stringify(state));
};
const engineStatus = (result: ReturnType<typeof dataDoctor>) =>
  result.checks.find((c) => c.id === 'engine')?.status;

test('WAL: doctor --scope data не создаёт файлы журнала рядом с базой и читает состояние, которое есть только в журнале writer', () => {
  const f = stateWith(() => {});
  try {
    const listing = () => readdirSync(f.root).sort();
    // Режим WAL — по заголовку файла: любое соединение создало бы -wal и -shm.
    assert.deepEqual([...readFileSync(f.file).subarray(18, 20)], [2, 2], 'база в режиме WAL');
    const before = listing();
    assert.deepEqual(
      before.filter((n) => /-(wal|shm|journal)$/.test(n)),
      [],
      'база закрыта штатно',
    );
    const hashed = hash(f.file);
    const result = dataDoctor(config(), f.root);
    assert.equal(result.compatible, true, JSON.stringify(result.checks));
    assert.deepEqual(listing(), before, 'в каталоге данных не появилось ни одного файла');
    assert.equal(hash(f.file), hashed);
    // Writer держит базу, и его запись лежит только в журнале: проверка её
    // видит (журнал учтён), его файлы не трогаются.
    const writer = new DatabaseSync(f.file);
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    liveForeignLeader(writer);
    try {
      assert.equal(hash(f.file), hashed, 'запись не перенесена в файл базы');
      const open = listing();
      assert.ok(open.includes('state.sqlite-wal'), open.join(','));
      const live = dataDoctor(config(), f.root);
      assert.equal(engineStatus(live), 'blocked', JSON.stringify(live.checks));
      assert.deepEqual(listing(), open);
    } finally {
      writer.close();
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('WAL: writer, записавший и закрывший базу во время проверки данных, делает итог несовместимым (storage-quiet)', () => {
  const f = stateWith(() => {});
  const read: Store['read'] = Reflect.get(Store.prototype, 'read');
  try {
    // Writer открывает базу, пишет, переносит журнал в файл и закрывается
    // посреди проверки: файлов журнала после него нет, меняется сам файл.
    Store.prototype.read = function (this: Store) {
      const state = read.call(this);
      const writer = new DatabaseSync(f.file);
      liveForeignLeader(writer);
      writer.close();
      return state;
    };
    const result = dataDoctor(config(), f.root);
    assert.deepEqual(
      readdirSync(f.root).filter((n) => /-(wal|shm|journal)$/.test(n)),
      [],
      'файлов журнала после writer нет',
    );
    assert.equal(result.compatible, false, JSON.stringify(result.checks));
    assert.equal(result.checks.find((c) => c.id === 'storage-quiet')?.status, 'blocked');
  } finally {
    Store.prototype.read = read;
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('Полный doctor (CLI) читает базу только для чтения: база прежней версии без таблицы revision не получает DDL, строк и файлов журнала', () => {
  const f = stateWith(() => {});
  try {
    // База прежней версии: таблицы ревизии ещё нет.
    const db = new DatabaseSync(f.file);
    db.exec('DROP TABLE revision; PRAGMA wal_checkpoint(TRUNCATE);');
    db.close();
    writeFileSync(join(f.root, 'config.json'), JSON.stringify(config()));
    const listing = () => readdirSync(f.root).sort();
    const before = listing();
    assert.deepEqual(
      before.filter((n) => /-(wal|shm|journal)$/.test(n)),
      [],
    );
    const hashed = hash(f.file);
    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'doctor', '--data', f.root],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(r.stdout) as { checks: { id: string; status: string }[] };
    assert.equal(
      result.checks.find((c) => c.id === 'engine')?.status,
      'passed',
      'состояние прочитано: ' + r.stderr,
    );
    assert.equal(hash(f.file), hashed, 'файл базы не изменился');
    assert.deepEqual(listing(), [...before, 'doctor.json'].sort(), 'появился только отчёт doctor');
    const check = new DatabaseSync(f.file, { readOnly: true });
    try {
      assert.equal(
        check.prepare("SELECT name FROM sqlite_master WHERE name='revision'").get(),
        undefined,
      );
    } finally {
      check.close();
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('Полный doctor: база компонента ещё не создана — проверка engine по центральной базе не пропускается', () => {
  const w = componentWorkspace();
  try {
    editDocument(join(w.workspace, 'state.sqlite'), (s) => {
      s.leader = { owner: 'x', leaseUntil: Date.now() + 60_000, engineVersion: '9.9.9-newer' };
    });
    rmSync(join(w.root, 'library', '.devcontour-local', 'state.sqlite'));
    const { state, engine, check } = doctorState(w.config, w.workspace);
    assert.equal(state, undefined);
    assert.equal(check?.status, 'not-checked', JSON.stringify(check));
    assert.match(check.detail, /library/);
    assert.ok(engine, 'роль controller прочитана из центральной базы');
    assert.equal(engineCheck(engine).status, 'blocked', 'роль другой версии движка видна');
    assert.equal(
      existsSync(join(w.root, 'library', '.devcontour-local', 'state.sqlite')),
      false,
      'doctor базу не создал',
    );
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test('Полный doctor: база компонента ещё не создана — контракты центральной базы проверяются, остальные названы непроверенными', async () => {
  const w = componentWorkspace();
  const central = { id: 'C-central', title: 'Central', revisions: [] };
  try {
    editDocument(join(w.workspace, 'state.sqlite'), (s) => {
      s.contracts = [
        ...(s.contracts as unknown[]),
        central,
        { $devcontourComponentObject: 'product', id: 'x' },
      ];
    });
    rmSync(join(w.root, 'library', '.devcontour-local', 'state.sqlite'));
    const { engine, check } = doctorState(w.config, w.workspace);
    assert.deepEqual(engine?.contracts, [central], 'ссылки на базы компонентов отброшены');
    const result = await doctor(w.config, w.workspace, false, engine, check);
    assert.equal(
      result.checks.find((c) => c.id === 'contract-closure:unread')?.status,
      'not-checked',
      JSON.stringify(result.checks.map((c) => c.id)),
    );
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test('Полный doctor: writer, записавший базу во время неизменяемого чтения, — состояние перечитывается', () => {
  const f = stateWith(() => {});
  const read: Store['read'] = Reflect.get(Store.prototype, 'read');
  let writes = 0;
  try {
    Store.prototype.read = function (this: Store) {
      const state = read.call(this);
      if (!writes++) {
        const writer = new DatabaseSync(f.file);
        liveForeignLeader(writer);
        writer.close();
      }
      return state;
    };
    const { state, check } = doctorState(config(), f.root);
    assert.equal(check, undefined);
    assert.equal(
      (state?.leader as { engineVersion?: string } | undefined)?.engineVersion,
      '9.9.9-newer',
      'прочитана запись writer',
    );
    assert.equal(writes, 2, 'чтение повторено');
  } finally {
    Store.prototype.read = read;
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('Неизменяемым чтение открывает только базу WAL без файлов журнала; база DELETE — с блокировками', () => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-data-doctor-'));
  try {
    const file = join(root, 'state.sqlite');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE x(a); INSERT INTO x VALUES (1);');
    db.close();
    assert.equal(readOnlyLocation(file), file, 'база DELETE');
    const wal = new DatabaseSync(file);
    wal.exec('PRAGMA journal_mode=WAL;');
    wal.close();
    assert.equal(String(readOnlyLocation(file)), pathToFileURL(file).href + '?immutable=1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('S4-R3-01/02: doctor --scope data открывает базы только для чтения, проверяет версию каждого документа и ничего не создаёт', () => {
  const blocked = (result: ReturnType<typeof dataDoctor>, id: string, pattern: RegExp) => {
    assert.equal(result.compatible, false, JSON.stringify(result.checks));
    const c = result.checks.find((x) => x.id === id);
    assert.equal(c?.status, 'blocked', JSON.stringify(result.checks));
    assert.match(c.detail, pattern);
  };
  // Центральная база.
  const central = (edit: (state: Record<string, unknown>) => void) => {
    const f = stateWith(edit);
    return { ...f, run: () => dataDoctor(config(), f.root) };
  };
  const cases: [string, (state: Record<string, unknown>) => void, string?, RegExp?][] = [
    ['совместимая', () => {}],
    [
      'роль неизвестной формы',
      (state) => {
        state.leader = {
          owner: 'x',
          leaseUntil: Date.now() - 1,
          engineVersion: harnessVersion,
          futureField: 1,
        };
      },
      'execution-state',
      /futureField/,
    ],
    [
      'живая роль другой версии',
      (state) => {
        state.leader = {
          owner: 'x',
          leaseUntil: Date.now() + 60_000,
          engineVersion: '9.9.9-newer',
        };
      },
      'engine',
      /9\.9\.9-newer/,
    ],
    [
      'неизвестная версия документа',
      (state) => (state.version = 999),
      'state',
      /Unsupported state version/,
    ],
  ];
  for (const [name, edit, id, pattern] of cases) {
    const f = central(edit);
    try {
      const before = snapshot(f.root);
      const result = f.run();
      assert.equal(result.scope, 'data-compatibility');
      assert.equal('ready' in result, false, 'проверка данных не выдаёт себя за готовность среды');
      if (id) blocked(result, id, pattern!);
      else assert.equal(result.compatible, true, name + ': ' + JSON.stringify(result.checks));
      assert.equal(
        snapshot(f.root),
        before,
        name + ': ни одна таблица и ни один файл не изменились',
      );
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
  const empty = mkdtempSync(join(tmpdir(), 'devcontour-data-doctor-'));
  try {
    blocked(dataDoctor(config(), empty), 'storage', /не найдена/);
    assert.deepEqual(readdirSync(empty), [], 'отсутствующая база не создаётся');
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  // Coordinator и базы компонентов.
  const component = (
    name: string,
    edit: (w: ReturnType<typeof componentWorkspace>) => void,
    id?: string,
    pattern?: RegExp,
  ) => {
    const w = componentWorkspace();
    try {
      edit(w);
      const roots = [w.workspace, ...w.repos.map((r) => r.path)];
      const before = snapshot(...roots);
      const result = dataDoctor(w.config, w.workspace);
      if (id) blocked(result, id, pattern!);
      else assert.equal(result.compatible, true, name + ': ' + JSON.stringify(result.checks));
      assert.equal(
        snapshot(...roots),
        before,
        name + ': ни одна таблица и ни один файл не изменились',
      );
    } finally {
      rmSync(w.root, { recursive: true, force: true });
    }
  };
  const local = (w: ReturnType<typeof componentWorkspace>, id: string) =>
    join(w.repos.find((r) => r.id === id)!.path, '.devcontour-local', 'state.sqlite');
  component('совместимые базы компонентов', () => {});
  component(
    'неизвестная версия coordinator',
    (w) => editDocument(join(w.workspace, 'state.sqlite'), (s) => (s.version = 999)),
    'state',
    /Unsupported state version/,
  );
  for (const id of ['product', 'library'])
    component(
      'неизвестная версия базы компонента ' + id,
      (w) => editDocument(local(w, id), (s) => (s.version = 999)),
      'state',
      new RegExp('component database: ' + id),
    );
  component(
    'отсутствующая база компонента',
    (w) => rmSync(local(w, 'library')),
    'storage',
    /База компонента не найдена: library/,
  );
  component(
    'база компонента без владельца',
    (w) => {
      const db = new DatabaseSync(local(w, 'product'));
      db.exec('DELETE FROM owner');
      db.close();
    },
    'storage',
    /нет владельца: product/,
  );
});

test('S4-R4-01: пустая база компонента без реестра не скрывает неизвестную версию ни от проверки данных, ни от обычного чтения и записи', () => {
  // Начальное состояние штатного конструктора: базы и владелец созданы, доски
  // ещё нет, у coordinator нет реестра компонентов.
  const fresh = () => {
    const root = mkdtempSync(join(tmpdir(), 'devcontour-empty-component-'));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const repos = ['product', 'library'].map((id) => {
      const path = join(root, id);
      mkdirSync(path);
      return repositorySchema.parse({ id, name: id, path, gates: config().gates });
    });
    const c = config({ storage: 'component', workspaceRoot: workspace, repositories: repos });
    new Store(join(workspace, 'state.sqlite'), repos).close();
    const local = join(root, 'product', '.devcontour-local', 'state.sqlite');
    return { root, workspace, repos, config: c, local };
  };
  const cases: [string, (s: Record<string, unknown>) => void][] = [
    ['версия 999', (s) => (s.version = 999)],
    ['версии нет', (s) => delete s.version],
  ];
  for (const [name, edit] of cases) {
    const w = fresh();
    try {
      editDocument(w.local, edit);
      const roots = [w.workspace, ...w.repos.map((r) => r.path)];
      const before = snapshot(...roots);
      const result = dataDoctor(w.config, w.workspace);
      assert.equal(result.compatible, false, name + ': ' + JSON.stringify(result.checks));
      assert.match(
        result.checks.find((x) => x.id === 'state')?.detail ?? '',
        /component database: product/,
      );
      // Обычное открытие читает состояние и отказывает до первой операции.
      assert.throws(
        () => new Store(join(w.workspace, 'state.sqlite'), w.repos),
        /component database: product/,
        name + ': обычное открытие',
      );
      assert.equal(snapshot(...roots), before, name + ': отказ ничего не изменил');
      const after = new DatabaseSync(w.local, { readOnly: true });
      const document = JSON.parse(
        (after.prepare('SELECT data FROM main.state WHERE id=1').get() as { data: string }).data,
      ) as Record<string, unknown>;
      after.close();
      assert.equal(document.version, name === 'версия 999' ? 999 : undefined, name);
      const db = new DatabaseSync(join(w.workspace, 'state.sqlite'), { readOnly: true });
      const main = JSON.parse(
        (db.prepare('SELECT data FROM main.state WHERE id=1').get() as { data: string }).data,
      ) as { boards: unknown[] };
      db.close();
      assert.equal(main.boards.length, 0, name + ': доска не создана');
    } finally {
      rmSync(w.root, { recursive: true, force: true });
    }
  }
  // Положительный контроль: поддерживаемая версия.
  const w = fresh();
  try {
    assert.equal(dataDoctor(w.config, w.workspace).compatible, true);
    const store = new Store(join(w.workspace, 'state.sqlite'), w.repos);
    try {
      new DevContour(store, w.config).createBoard('First board', '', 'product');
    } finally {
      store.close();
    }
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});
