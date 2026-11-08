// `devcontour stop`: останавливается только сервер, который сам подтвердил
// pid и экземпляр из server.json; чужой процесс не трогается.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
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
import { serverRecordPath, type ServerRecord } from '../src/runner/server-record.ts';

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

test('stop terminates the recorded workspace server and refuses a process that is not ours', async () => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-stop-')));
  const root = join(workspace, '.devcontour-local');
  const children: ChildProcess[] = [];
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
    };
    assert.deepEqual(identity, { pid: server.pid, instance: started.instance });

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
  }
});
