// `devcontour stop`: останавливается только сервер, который сам подтвердил
// pid и экземпляр из server.json; чужой процесс не трогается.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { command } from '../src/runner/process.ts';
import { processAlive } from '../src/runner/resources.ts';
import {
  dataIdentity,
  liveController,
  serverRecordPath,
  stopServer,
  type ServerRecord,
} from '../src/runner/server-record.ts';
import { fixture } from './helpers.ts';

const cli = ['node', '--import', 'tsx', resolve('src/cli.ts')];

async function until<T>(what: string, read: () => T | undefined, ms = 60000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Не дождались: ' + what);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const record = (root: string) =>
  existsSync(serverRecordPath(root))
    ? (JSON.parse(readFileSync(serverRecordPath(root), 'utf8')) as ServerRecord)
    : undefined;

test('The data root identity is the on-disk path whatever letter case the caller used', (t) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'devcontour-case-')));
  try {
    const data = join(dir, 'Data');
    mkdirSync(data);
    assert.equal(dataIdentity(data), data);
    const variant = join(dir, 'DATA');
    if (!existsSync(variant)) {
      t.skip('файловая система различает регистр букв: другой путь — другой каталог');
      return;
    }
    // Сервер и stop называют один каталог одинаково, даже если пути
    // переданы в разном регистре.
    assert.equal(dataIdentity(variant), data);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stop terminates the recorded workspace server and refuses a process that is not ours', async () => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-stop-')));
  const root = join(workspace, '.devcontour-local');
  const children: ChildProcess[] = [];
  const copy = realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-stop-copy-')));
  try {
    const server = spawn(
      cli[0],
      [
        ...cli.slice(1),
        'start',
        '--workspace',
        workspace,
        '--workspace-mode',
        'separate',
        '--port',
        '0',
      ],
      { stdio: 'ignore' },
    );
    children.push(server);
    const started = await until('server.json', () => record(root));
    assert.equal(started.pid, server.pid);
    const identity = (await (await fetch(new URL('/api/server', started.url))).json()) as {
      pid: number;
      instance: string;
      dataRoot: string;
    };
    assert.deepEqual(identity, { pid: server.pid, instance: started.instance, dataRoot: root });

    // Workspace скопирован вместе с записью (`cp -r`): pid и экземпляр
    // подтверждает сервер оригинала, но его каталог данных — не копии.
    cpSync(root, join(copy, '.devcontour-local'), { recursive: true });
    const copied = await command([...cli, 'stop', '--workspace', copy], process.cwd());
    assert.notEqual(copied.code, 0);
    assert.match(copied.stderr, new RegExp(`pid ${server.pid} не подтвердил`));
    assert.match(copied.stderr, /сервер другого каталога данных/);
    assert.ok(processAlive(server.pid!), 'сервер оригинала не остановлен по скопированной записи');

    // Чужой живой процесс под записанным pid: сервер по адресу его не подтверждает.
    const foreign = spawn('sleep', ['60'], { stdio: 'ignore' });
    children.push(foreign);
    writeFileSync(serverRecordPath(root), JSON.stringify({ ...started, pid: foreign.pid }));
    const refused = await command([...cli, 'stop', '--workspace', workspace], process.cwd());
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, new RegExp(`pid ${foreign.pid} не подтвердил`));
    assert.match(refused.stderr, /по адресу отвечает другой сервер/);
    assert.ok(processAlive(foreign.pid!), 'чужой процесс не остановлен');
    assert.ok(processAlive(server.pid!), 'сервер не остановлен по чужой записи');
    // Тот же pid, но по адресу никто не отвечает — тоже отказ.
    writeFileSync(
      serverRecordPath(root),
      JSON.stringify({ ...started, pid: foreign.pid, url: 'http://127.0.0.1:9' }),
    );
    const silent = await command([...cli, 'stop', '--workspace', workspace], process.cwd());
    assert.notEqual(silent.code, 0);
    assert.match(silent.stderr, /сервер не отвечает/);
    assert.ok(processAlive(foreign.pid!));

    // Настоящая запись: сервер останавливается штатно и удаляет её.
    writeFileSync(serverRecordPath(root), JSON.stringify(started));
    const exited = once(server, 'exit');
    const stopped = await command([...cli, 'stop', '--workspace', workspace], process.cwd());
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.deepEqual(JSON.parse(stopped.stdout), {
      status: 'stopped',
      pid: server.pid,
      url: started.url,
    });
    await exited;
    assert.equal(record(root), undefined);

    // Без записи — не запущен; запись завершившегося процесса — устаревшая.
    const none = await command([...cli, 'stop', '--workspace', workspace], process.cwd());
    assert.equal(none.code, 0, none.stderr);
    assert.equal((JSON.parse(none.stdout) as { status: string }).status, 'not-running');
    writeFileSync(serverRecordPath(root), JSON.stringify(started));
    const stale = await command([...cli, 'stop', '--workspace', workspace], process.cwd());
    assert.equal(stale.code, 0, stale.stderr);
    assert.match(
      (JSON.parse(stale.stdout) as { detail: string }).detail,
      /уже не работает; устаревшая запись/,
    );
    assert.equal(record(root), undefined);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(workspace, { recursive: true, force: true });
    rmSync(copy, { recursive: true, force: true });
  }
});

test('stop without a record refuses while a live controller lease holds the store (server started before the upgrade)', async () => {
  // Сервер прежней версии server.json не пишет, но держит роль controller.
  const f = fixture();
  try {
    assert.equal(f.h.leader('pre-upgrade-server'), true);
    const lease = liveController(f.root);
    assert.equal(lease?.owner, 'pre-upgrade-server');

    const refused = await command([...cli, 'stop', '--data', f.root], process.cwd());
    assert.notEqual(refused.code, 0, 'stop не выполнен: сервер работает');
    const result = JSON.parse(refused.stdout) as { status: string; owner: string; detail: string };
    assert.equal(result.status, 'running-unrecorded');
    assert.equal(result.owner, 'pre-upgrade-server');
    assert.match(result.detail, /остановите его вручную/);

    // Запись завершившегося процесса устарела, но роль живая — тоже отказ.
    const dead = spawn('true');
    await once(dead, 'exit');
    writeFileSync(
      serverRecordPath(f.root),
      JSON.stringify({ pid: dead.pid, url: 'http://127.0.0.1:9', instance: 'gone' }),
    );
    const stale = await stopServer(f.root);
    assert.equal(stale.status, 'running-unrecorded');
    assert.equal(existsSync(serverRecordPath(f.root)), false, 'устаревшая запись удалена');

    // Истёкшая роль — сервер не работает.
    assert.equal(liveController(f.root, (lease?.leaseUntil ?? 0) + 1), undefined);
  } finally {
    f.cleanup();
  }
});
