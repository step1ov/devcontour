/**
 * `scripts/copy-precheck.mjs` без настоящего Docker: `docker` в PATH — заглушка,
 * которая записывает, какой копию получил контейнер. События «во время
 * копирования» и свободное место подставляет модуль, загружаемый до скрипта
 * (`--import`): он оборачивает `cpSync` и `statfsSync` из `node:fs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';

const script = resolve('scripts/copy-precheck.mjs');

const hooks = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
const { HOOK_ROOT, HOOK_AFTER_COPY, HOOK_FREE_BYTES } = process.env;
if (HOOK_FREE_BYTES) {
  const real = fs.statfsSync;
  fs.statfsSync = (path, options) => ({ ...real(path, options), bsize: 1, bavail: Number(HOOK_FREE_BYTES) });
}
if (HOOK_AFTER_COPY) {
  const real = fs.cpSync;
  // Изменение во время копирования: после отпечатка оригинала, до копии.
  fs.cpSync = (src, dest, options) => {
    if (src !== HOOK_ROOT) return real(src, dest, options);
    const ws = join(HOOK_ROOT, 'ws');
    if (HOOK_AFTER_COPY === 'git') {
      // Другой агент создаёт worktree и обновляет index.
      fs.mkdirSync(join(ws, '.git', 'worktrees', 'other-agent'), { recursive: true });
      fs.writeFileSync(join(ws, '.git', 'worktrees', 'other-agent', 'HEAD'), 'ref: x');
      fs.writeFileSync(join(ws, '.git', 'index'), 'changed index');
      fs.writeFileSync(join(ws, 'src.txt'), 'edited by another agent');
      return real(src, dest, options);
    }
    for (let i = 0; i < 25; i++)
      fs.writeFileSync(join(ws, '.devcontour-local', 'artifacts', 'late-' + String(i).padStart(2, '0') + '.json'), '{}');
    real(src, dest, options);
    if (HOOK_AFTER_COPY === 'unmark') fs.rmSync(join(dirname(dest), '.dc-copy-precheck-owner'));
  };
}
syncBuiltinESMExports();
`;

// Заглушка docker: что лежит в каталоге данных копии на старте контейнера.
const fakeDocker = `#!/usr/bin/env node
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const args = process.argv.slice(2);
const mount = args[args.indexOf('-v') + 1];
const copy = mount.slice(0, mount.indexOf(':'));
const data = join(copy, 'ws', '.devcontour-local');
const files = Object.fromEntries(
  fs.readdirSync(data).filter((n) => fs.statSync(join(data, n)).isFile())
    .map((n) => [n, createHash('sha256').update(fs.readFileSync(join(data, n))).digest('hex')]),
);
fs.writeFileSync(process.env.FAKE_DOCKER_RECORD, JSON.stringify({ files }));
console.log(JSON.stringify({ scope: 'data-compatibility', compatible: true }));
`;

type Report = {
  copyChanged: string[];
  copyDataChanged: string[];
  originalUnchanged: boolean;
  compared: string[];
};
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-copy-precheck-')));
  const root = join(base, 'root'),
    ws = join(root, 'ws'),
    data = join(ws, '.devcontour-local'),
    temp = join(base, 'tmp'),
    bin = join(base, 'bin');
  for (const dir of [join(data, 'artifacts'), join(ws, '.git'), temp, bin])
    mkdirSync(dir, { recursive: true });
  writeFileSync(join(ws, '.git', 'index'), 'index');
  writeFileSync(join(ws, 'src.txt'), 'source');
  writeFileSync(
    join(data, 'config.json'),
    JSON.stringify({ workspaceRoot: ws, repository: ws, repositories: [] }),
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
  const run = (env: Record<string, string> = {}, extra: string[] = []) => {
    const r = spawnSync(
      process.execPath,
      [
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
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: bin + ':' + process.env.PATH,
          TMPDIR: temp,
          FAKE_DOCKER_RECORD: record,
          HOOK_ROOT: root,
          ...env,
        },
      },
    );
    const report = (r.status === 0 ? JSON.parse(r.stdout) : {}) as Report;
    return { ...r, report };
  };
  return { base, root, ws, data, temp, record, run };
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
    const seen = JSON.parse(readFileSync(f.record, 'utf8')) as { files: Record<string, string> };
    assert.deepEqual(seen.files, original, 'контейнер видит те же файлы и байты');
    assert.deepEqual(r.report.copyChanged, []);
    assert.deepEqual(r.report.copyDataChanged, []);
    assert.equal(r.report.originalUnchanged, true);
    assert.deepEqual(r.report.compared, ['ws/.devcontour-local']);
    assert.deepEqual(readdirSync(f.temp), [], 'временная копия удалена');
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test('copy-precheck: работа Git в R во время копирования (worktree, index, файлы) проверку не валит', () => {
  const f = fixture();
  try {
    const r = f.run({ HOOK_AFTER_COPY: 'git' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.report.originalUnchanged, true);
    assert.ok(existsSync(join(f.ws, '.git', 'worktrees', 'other-agent')), 'событие произошло');
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

test('copy-precheck: каталог без метки своего запуска не удаляется', () => {
  const f = fixture();
  try {
    const r = f.run({ HOOK_AFTER_COPY: 'unmark' });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /не удалён — в нём нет метки этого запуска/);
    const left = readdirSync(f.temp);
    assert.equal(left.length, 1);
    assert.ok(existsSync(join(f.temp, left[0], 'copy', 'ws', 'src.txt')));
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
