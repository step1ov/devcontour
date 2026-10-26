/**
 * `scripts/copy-precheck.mjs` без настоящего Docker: `docker` в PATH — заглушка,
 * которая записывает свои аргументы и то, какую копию получил контейнер.
 * События «во время копирования», свободное место и временный каталог
 * подставляет модуль, загружаемый до скрипта (`--import`): он оборачивает
 * `cp`, `mkdtempSync` и `statfsSync` из `node:fs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const script = resolve('scripts/copy-precheck.mjs');

const hooks = `
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
const { HOOK_ROOT, HOOK_BASE, HOOK_AFTER_COPY, HOOK_FREE_BYTES, HOOK_MKDTEMP_OUTSIDE } = process.env;
const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { stdio: 'ignore' });
if (HOOK_FREE_BYTES) {
  const real = fs.statfsSync;
  fs.statfsSync = (path, options) => ({ ...real(path, options), bsize: 1, bavail: Number(HOOK_FREE_BYTES) });
}
if (HOOK_MKDTEMP_OUTSIDE) {
  // Каталог вне $TMPDIR/dc-copy-precheck-*: удалять его скрипт не должен.
  fs.mkdtempSync = () => {
    const dir = join(HOOK_BASE, 'outside-scratch');
    fs.mkdirSync(dir);
    return dir;
  };
}
if (HOOK_AFTER_COPY) {
  // Изменение во время копирования: после отпечатка оригинала, до копии.
  const real = fsp.cp;
  fsp.cp = async (src, dest, options) => {
    if (src !== HOOK_ROOT) return real(src, dest, options);
    const ws = join(HOOK_ROOT, 'ws'), repo = join(HOOK_ROOT, 'repo');
    const mode = HOOK_AFTER_COPY;
    if (mode === 'git') {
      // Другой агент создаёт worktree, обновляет index и правит рабочий файл.
      git(ws, 'worktree', 'add', '--detach', join(HOOK_BASE, 'wt-other'));
      git(ws, 'update-index', '--refresh');
      fs.writeFileSync(join(ws, 'src.txt'), 'edited by another agent');
    } else if (mode === 'component') {
      fs.writeFileSync(join(repo, 'devcontour.component.json'), '{"roles":{"x":{}}}');
    } else if (mode === 'profile') {
      fs.writeFileSync(join(repo, 'profiles', 'p.json'), '{"id":"p","changed":true}');
    } else if (mode === 'marker') {
      fs.writeFileSync(join(ws, 'devcontour.workspace.json'), '{"mode":"separate"}');
    } else if (mode === 'repo-data') {
      fs.writeFileSync(join(repo, '.devcontour-local', 'late.json'), '{}');
    } else if (mode === 'head') {
      git(ws, 'commit', '--allow-empty', '-qm', 'late');
    } else if (mode === 'data' || mode === 'unmark') {
      for (let i = 0; i < 25; i++)
        fs.writeFileSync(join(ws, '.devcontour-local', 'artifacts', 'late-' + String(i).padStart(2, '0') + '.json'), '{}');
    }
    await real(src, dest, options);
    if (mode === 'unmark') fs.rmSync(join(dirname(dest), '.dc-copy-precheck-owner'));
    if (mode === 'slow') {
      fs.writeFileSync(join(HOOK_BASE, 'copy-started'), '');
      await new Promise((r) => setTimeout(r, 60000));
    }
  };
}
syncBuiltinESMExports();
`;

// Заглушка docker: аргументы и файлы каталога данных копии на старте контейнера.
const fakeDocker = `#!/usr/bin/env node
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === 'rm') {
  // docker rm -f NAME: записать вызов и остановить «контейнер».
  fs.appendFileSync(process.env.FAKE_DOCKER_RECORD + '.rm', args.join(' ') + '\\n');
  try { process.kill(Number(fs.readFileSync(process.env.FAKE_DOCKER_RECORD + '.pid', 'utf8')), 'SIGKILL'); } catch {}
  process.exit(0);
}
const mount = args[args.indexOf('-v') + 1];
const copy = mount.slice(0, mount.indexOf(':'));
const data = join(copy, 'ws', '.devcontour-local');
const files = Object.fromEntries(
  fs.readdirSync(data).filter((n) => fs.statSync(join(data, n)).isFile())
    .map((n) => [n, createHash('sha256').update(fs.readFileSync(join(data, n))).digest('hex')]),
);
fs.writeFileSync(process.env.FAKE_DOCKER_RECORD, JSON.stringify({ args, files }));
if (process.env.FAKE_DOCKER_MODE === 'hang') {
  // Контейнер, который не завершается сам и SIGTERM клиента не слушает.
  fs.writeFileSync(process.env.FAKE_DOCKER_RECORD + '.pid', String(process.pid));
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else {
if (process.env.FAKE_DOCKER_MODE === 'write-db') {
  const db = new DatabaseSync(join(data, 'state.sqlite'));
  db.exec("INSERT INTO state VALUES (2, 'written by the container')");
  db.close();
}
console.log(JSON.stringify({ scope: 'data-compatibility', compatible: true }));
}
`;

type Report = {
  copy?: string;
  copyChanged: string[];
  copyDataChanged: string[];
  originalUnchanged: boolean;
  compared: string[];
};
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const gitInit = (dir: string) => {
  const git = (...a: string[]) =>
    execFileSync(
      'git',
      ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a],
      { stdio: 'ignore' },
    );
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, '.gitignore'), '/.devcontour-local/\n');
  git('add', '.');
  git('commit', '-qm', 'init');
};

function fixture(rootName = 'root') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-copy-precheck-')));
  const root = join(base, rootName),
    ws = join(root, 'ws'),
    repo = join(root, 'repo'),
    data = join(ws, '.devcontour-local'),
    temp = join(base, 'tmp'),
    bin = join(base, 'bin');
  for (const dir of [
    join(data, 'artifacts'),
    join(repo, '.devcontour-local'),
    join(repo, 'profiles'),
    temp,
    bin,
  ])
    mkdirSync(dir, { recursive: true });
  writeFileSync(join(ws, 'src.txt'), 'source');
  writeFileSync(join(ws, 'devcontour.workspace.json'), '{"mode":"embedded"}');
  writeFileSync(join(repo, 'devcontour.component.json'), '{}');
  writeFileSync(join(repo, 'profiles', 'p.json'), '{"id":"p"}');
  writeFileSync(join(repo, '.devcontour-local', 'state.json'), '{}');
  gitInit(ws);
  gitInit(repo);
  writeFileSync(
    join(data, 'config.json'),
    JSON.stringify({
      workspaceRoot: ws,
      repository: ws,
      repositories: [
        { id: 'main', path: ws },
        { id: 'api', path: repo, configFile: 'devcontour.component.json' },
      ],
      packs: [{ id: 'p', source: { repositoryId: 'api', path: 'profiles/p.json' } }],
    }),
  );
  // База WAL, закрытая штатно: файлов журнала рядом нет.
  const db = new DatabaseSync(join(data, 'state.sqlite'));
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE state (id INTEGER PRIMARY KEY, data TEXT); INSERT INTO state VALUES (1, '{}');",
  );
  db.close();
  assert.deepEqual(
    readdirSync(data).filter((n) => /-(wal|shm)$/.test(n)),
    [],
  );
  writeFileSync(join(base, 'devcontour-0.0.0.tgz'), 'archive');
  writeFileSync(join(base, 'hooks.mjs'), hooks);
  writeFileSync(join(bin, 'docker'), fakeDocker);
  chmodSync(join(bin, 'docker'), 0o755);
  const record = join(base, 'docker-record.json');
  const argv = (extra: string[]) => [
    '--import',
    join(base, 'hooks.mjs'),
    script,
    '--root',
    root,
    '--workspace',
    ws,
    '--archive',
    join(base, 'devcontour-0.0.0.tgz'),
    ...extra,
  ];
  const env = (extra: Record<string, string>) => ({
    ...process.env,
    PATH: bin + ':' + (process.env.PATH ?? ''),
    TMPDIR: temp,
    FAKE_DOCKER_RECORD: record,
    HOOK_ROOT: root,
    HOOK_BASE: base,
    ...extra,
  });
  const run = (extra: Record<string, string> = {}, flags: string[] = []) => {
    const r = spawnSync(process.execPath, argv(flags), { encoding: 'utf8', env: env(extra) });
    const report = (r.status === 0 ? JSON.parse(r.stdout) : {}) as Report;
    return { ...r, report };
  };
  const seen = () =>
    JSON.parse(readFileSync(record, 'utf8')) as { args: string[]; files: Record<string, string> };
  return { base, root, ws, repo, data, temp, record, run, seen, argv, env };
}

test('copy-precheck: контейнер получает копию каталога данных, побайтно равную оригиналу, без -wal и -shm', () => {
  const f = fixture();
  try {
    const original = Object.fromEntries(
      readdirSync(f.data)
        .filter((n) => n !== 'artifacts')
        .map((n) => [n, sha(join(f.data, n))]),
    );
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(f.seen().files, original, 'контейнер видит те же файлы и байты');
    assert.deepEqual(r.report.copyChanged, []);
    assert.deepEqual(r.report.copyDataChanged, []);
    assert.equal(r.report.originalUnchanged, true);
    assert.deepEqual(r.report.compared, [
      'repo/.devcontour-local',
      'repo/devcontour.component.json',
      'repo/profiles/p.json',
      'ws/.devcontour-local',
      'ws/devcontour.workspace.json',
      'repo@HEAD',
      'ws@HEAD',
    ]);
    assert.deepEqual(readdirSync(f.temp), [], 'временная копия удалена');
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('copy-precheck: контейнер запускается от пользователя хоста, пути передаются аргументами, а не текстом скрипта', () => {
  const f = fixture();
  try {
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    const { args } = f.seen();
    assert.equal(args[args.indexOf('--user') + 1], `${process.getuid!()}:${process.getgid!()}`);
    assert.deepEqual(args.slice(-4), ['precheck', 'devcontour-0.0.0.tgz', '--workspace', f.ws]);
    const body = args[args.indexOf('-c') + 1];
    assert.ok(!body.includes(f.ws), 'путь workspace не подставлен в скрипт');
    assert.ok(!body.includes('devcontour-0.0.0.tgz'), 'имя архива не подставлено в скрипт');
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('copy-precheck: R с двоеточием отклоняется до копирования', () => {
  const f = fixture('ro:ot');
  try {
    const r = f.run();
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--root содержит «:»/);
    assert.deepEqual(readdirSync(f.temp), []);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('copy-precheck: работа Git в R во время копирования (worktree, index, рабочий файл) проверку не валит', () => {
  const f = fixture();
  try {
    const r = f.run({ HOOK_AFTER_COPY: 'git' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.report.originalUnchanged, true);
    assert.ok(existsSync(join(f.base, 'wt-other')), 'событие произошло');
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

for (const [mode, path] of [
  ['component', 'repo/devcontour.component.json'],
  ['profile', 'repo/profiles/p.json'],
  ['marker', 'ws/devcontour.workspace.json'],
  ['repo-data', 'repo/.devcontour-local/late.json'],
  ['head', 'ws@HEAD'],
] as const)
  test(`copy-precheck: изменение входа проверки во время копирования (${path}) — отказ с этим путём`, () => {
    const f = fixture();
    try {
      const r = f.run({ HOOK_AFTER_COPY: mode });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /копия не совпала с оригиналом/);
      assert.ok(r.stderr.includes('\n  ' + path), r.stderr);
      assert.deepEqual(readdirSync(f.temp), []);
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  });

test('copy-precheck: расхождение каталога данных называет пути (не больше 20) и удаляет копию даже с --keep', () => {
  const f = fixture();
  try {
    const r = f.run({ HOOK_AFTER_COPY: 'data' }, ['--keep']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /копия не совпала с оригиналом/);
    assert.match(r.stderr, /ws\/\.devcontour-local\/artifacts\/late-00\.json/);
    assert.match(r.stderr, /late-19\.json/);
    assert.doesNotMatch(r.stderr, /late-20\.json/);
    assert.match(r.stderr, /и ещё 5/);
    assert.deepEqual(readdirSync(f.temp), [], 'копия удалена');
    assert.equal(existsSync(f.record), false, 'контейнер не запускался');
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('copy-precheck: --keep после завершённой проверки оставляет копию', () => {
  const f = fixture();
  try {
    const r = f.run({}, ['--keep']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.report.copy && existsSync(join(r.report.copy, 'ws', 'src.txt')));
    assert.equal(readdirSync(f.temp).length, 1);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('copy-precheck: запись контейнера в базу копии видна в copyDataChanged', () => {
  const f = fixture();
  try {
    const r = f.run({ FAKE_DOCKER_MODE: 'write-db' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.report.copyDataChanged, ['ws/.devcontour-local/state.sqlite']);
    assert.equal(r.report.originalUnchanged, true);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('copy-precheck: каталог без метки своего запуска не удаляется', () => {
  const f = fixture();
  try {
    const r = f.run({ HOOK_AFTER_COPY: 'unmark' });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /не удалён — это не каталог этого запуска/);
    const left = readdirSync(f.temp);
    assert.equal(left.length, 1);
    assert.ok(existsSync(join(f.temp, left[0], 'copy', 'ws', 'src.txt')));
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('copy-precheck: каталог вне $TMPDIR/dc-copy-precheck-* не удаляется, даже с меткой', () => {
  const f = fixture();
  try {
    const r = f.run({ HOOK_AFTER_COPY: 'data', HOOK_MKDTEMP_OUTSIDE: '1' });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /не удалён — это не каталог этого запуска/);
    assert.ok(existsSync(join(f.base, 'outside-scratch', '.dc-copy-precheck-owner')));
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('copy-precheck: при нехватке места отказ до копирования', () => {
  const f = fixture();
  try {
    const r = f.run({ HOOK_FREE_BYTES: String(1024 * 1024) });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /недостаточно места .* свободно 0\.0 ГБ/);
    assert.deepEqual(readdirSync(f.temp), [], 'копия не создавалась');
    assert.equal(existsSync(f.record), false);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('copy-precheck: SIGTERM во время копирования — копия удалена, код ненулевой, контейнер не запускался', async () => {
  const f = fixture();
  try {
    const child = spawn(process.execPath, f.argv([]), {
      env: f.env({ HOOK_AFTER_COPY: 'slow' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += String(c)));
    const exited = new Promise<number | null>((done) => child.on('close', (code) => done(code)));
    for (let i = 0; i < 300 && !existsSync(join(f.base, 'copy-started')); i++) await delay(50);
    assert.ok(existsSync(join(f.base, 'copy-started')), 'копирование началось');
    assert.equal(readdirSync(f.temp).length, 1, 'копия существует');
    child.kill('SIGTERM');
    const code = await exited;
    assert.equal(code, 143, stderr);
    assert.match(stderr, /прервано \(SIGTERM\)/);
    assert.deepEqual(readdirSync(f.temp), [], 'копия удалена');
    assert.equal(existsSync(f.record), false);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('copy-precheck: SIGTERM во время проверки — контейнер удалён (docker rm -f по имени) до удаления копии', async () => {
  const f = fixture();
  const pidFile = f.record + '.pid';
  try {
    const child = spawn(process.execPath, f.argv([]), {
      env: f.env({ FAKE_DOCKER_MODE: 'hang' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += String(c)));
    const exited = new Promise<number | null>((done) => child.on('close', (code) => done(code)));
    for (let i = 0; i < 300 && !existsSync(pidFile); i++) await delay(50);
    assert.ok(existsSync(pidFile), 'контейнер запущен: ' + stderr);
    const { args } = f.seen();
    const name = args[args.indexOf('--name') + 1];
    assert.match(name, /^dc-copy-precheck-[0-9a-f-]{36}$/);
    assert.ok(args.includes('--init'));
    child.kill('SIGTERM');
    assert.equal(await exited, 143, stderr);
    assert.equal(readFileSync(f.record + '.rm', 'utf8'), `rm -f ${name}\n`);
    assert.throws(
      () => process.kill(Number(readFileSync(pidFile, 'utf8')), 0),
      'контейнер остановлен',
    );
    assert.deepEqual(readdirSync(f.temp), [], 'копия удалена');
  } finally {
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
    } catch {
      /* уже остановлен */
    }
    rmSync(f.base, { recursive: true, force: true });
  }
});
