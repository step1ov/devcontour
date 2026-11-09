// `devcontour stop`: останавливается только сервер, который сам подтвердил
// pid и экземпляр из server.json; чужой процесс не трогается.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
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
  commandLineNamesServer,
  dataIdentity,
  liveController,
  manualStopSteps,
  serverRecordPath,
  stopServer,
  stopServerByPid,
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
    assert.equal(refused.code, 1);
    // Роль хранит только идентификатор владельца: pid оператор находит сам,
    // сигнал посылает сам — в фоне (nohup) терминала для Ctrl+C нет.
    assert.match(result.detail, /pid и хост роль не хранит/);
    assert.match(result.detail, /остановите его сами по шагам manualStop/);
    const steps = (JSON.parse(refused.stdout) as { manualStop: string[] }).manualStop;
    const text = steps.join('\n');
    assert.match(text, /ps -ax -o pid,command \| grep -F -- /);
    assert.ok(text.includes(f.root), 'поиск по пути workspace');
    assert.match(text, /lsof -nP -iTCP:<порт> -sTCP:LISTEN/);
    // Путь в командной строке бывает другим (относительный, ссылка, свой --data).
    assert.match(text, /относительным путём.*символическую ссылку.*--data вне.*realpath/);
    assert.match(text, /командной строке/);
    assert.match(text, /kill -TERM <pid>/);
    assert.match(text, /nohup/);
    assert.match(text, /devcontour stop .*not-running/);
    // Путь workspace — из каталога данных `.devcontour-local`, с кавычками для shell.
    assert.match(
      manualStopSteps("/srv/it's/.devcontour-local")[0] ?? '',
      /grep -F -- '\/srv\/it'\\''s' /,
    );

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

const hasLsof = spawnSync('lsof', ['-v'], { stdio: 'ignore' }).error === undefined;

test('stop --pid signals an unrecorded server only when the pid holds this database, listens and runs devcontour serve', async (t) => {
  if (!hasLsof) {
    t.skip('нет lsof: stop --pid отказывает, подтверждать нечем');
    return;
  }
  // Сервер прежней версии, запущенный через nohup: записи нет, терминала нет.
  // Вместо настоящего сервера — дочерний процесс теста: программа в каталоге
  // devcontour держит базу открытой и слушает порт. Роль controller держит фикстура.
  const f = fixture();
  const bin = mkdtempSync(join(tmpdir(), 'devcontour-fake-bin-'));
  const children: ChildProcess[] = [];
  const program = (dir: string, opensDatabase: boolean) => {
    mkdirSync(join(bin, dir), { recursive: true });
    const file = join(bin, dir, 'cli.js');
    writeFileSync(
      file,
      `const { DatabaseSync } = require('node:sqlite');
${opensDatabase ? `const db = new DatabaseSync(${JSON.stringify(join(f.root, 'state.sqlite'))});` : ''}
require('node:http').createServer().listen(0, '127.0.0.1', () => process.stdout.write('ready\\n'));`,
    );
    return file;
  };
  const real = program('node_modules/devcontour/lib', true);
  const blind = program('blind/devcontour', false);
  const other = program('node_modules/other-tool/lib', true);
  const fake = async (script: string, ...args: string[]) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    children.push(child);
    await once(child.stdout, 'data');
    return child;
  };
  const stop = (pid: number | undefined) =>
    command([...cli, 'stop', '--data', f.root, '--pid', String(pid)], process.cwd());
  try {
    const server = await fake(real, 'serve', '--port', '4999', '--data', f.root);
    const noDatabase = await fake(blind, 'serve', '--data', f.root);
    const lookalike = await fake(other, 'serve', '--data', f.root);
    const foreign = spawn('sleep', ['60'], { stdio: 'ignore' });
    children.push(foreign);

    // Роли controller нет — сигнала нет.
    const noLease = await stop(server.pid);
    assert.notEqual(noLease.code, 0);
    assert.match(noLease.stderr, /никто не держит/);
    assert.ok(processAlive(server.pid!));

    assert.equal(f.h.leader('pre-upgrade-server'), true);
    // Не сервер DevContour по argv, хотя базу держит и порт слушает.
    for (const [pid, why] of [
      [foreign.pid, /командная строка/],
      [lookalike.pid, /командная строка/],
      // argv сервера, но базу этот процесс не держит: живая роль — чужая.
      [noDatabase.pid, /не держит открытой базу/],
    ] as const) {
      const refused = await stop(pid);
      assert.notEqual(refused.code, 0);
      assert.match(refused.stderr, why);
      assert.match(refused.stderr, /Сигнал не послан/);
      assert.ok(processAlive(pid!));
    }
    // Живая запись называет другой pid — stop без --pid, этот процесс не трогается.
    writeFileSync(
      serverRecordPath(f.root),
      JSON.stringify({ pid: foreign.pid, url: 'http://127.0.0.1:9', instance: 'x' }),
    );
    const recorded = await stop(server.pid);
    assert.notEqual(recorded.code, 0);
    assert.match(recorded.stderr, new RegExp(`называет сервер этого workspace pid ${foreign.pid}`));
    assert.ok(processAlive(server.pid!));
    rmSync(serverRecordPath(f.root));
    const dead = spawn('true');
    await once(dead, 'exit');
    assert.match((await stop(dead.pid)).stderr, /не работает/);

    // Всё подтверждено: SIGTERM.
    const exited = once(server, 'exit');
    const stopped = await stop(server.pid);
    assert.equal(stopped.code, 0, stopped.stderr);
    const result = JSON.parse(stopped.stdout) as { status: string; pid: number; verified: string };
    assert.equal(result.status, 'stopped');
    assert.equal(result.pid, server.pid);
    assert.equal(result.verified, 'database-listener-command-line');
    const [, signal] = (await exited) as [number | null, NodeJS.Signals | null];
    assert.equal(signal, 'SIGTERM');
    for (const child of [foreign, noDatabase, lookalike])
      assert.ok(processAlive(child.pid!), 'остальные не тронуты');
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(bin, { recursive: true, force: true });
    f.cleanup();
  }
});

test('stop --pid refuses without lsof proof or when the pid changes process during the checks', async () => {
  const f = fixture();
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  try {
    assert.equal(f.h.leader('pre-upgrade-server'), true);
    const argv = `node /opt/node_modules/devcontour/lib/cli.js serve --data ${f.root}`;
    const base = {
      commandLine: () => argv,
      startTime: () => 'Mon Nov  9 10:00:00 2026',
      openFiles: () => ({ files: [join(f.root, 'state.sqlite')], listening: true }),
    };
    await assert.rejects(
      stopServerByPid(f.root, child.pid!, { probe: { ...base, openFiles: () => undefined } }),
      /lsof недоступен/,
    );
    await assert.rejects(
      stopServerByPid(f.root, child.pid!, {
        probe: {
          ...base,
          openFiles: () => ({ files: [join(f.root, 'state.sqlite')], listening: false }),
        },
      }),
      /не слушает TCP-порт/,
    );
    let calls = 0;
    await assert.rejects(
      stopServerByPid(f.root, child.pid!, {
        probe: { ...base, startTime: () => (calls++ ? 'later' : 'earlier') },
      }),
      /сменил процесс/,
    );
    assert.ok(processAlive(child.pid!), 'сигнала не было');
  } finally {
    child.kill('SIGKILL');
    f.cleanup();
  }
});
test('the command line check parses argv structurally and refuses wrappers and lookalikes', () => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-cmdline-')));
  try {
    const root = join(workspace, '.devcontour-local');
    const ok = (cmd: string) => commandLineNamesServer(cmd, root);
    assert.ok(ok(`node ./node_modules/.bin/devcontour serve --port 4317 --workspace ${workspace}`));
    assert.ok(
      ok(
        `/usr/local/bin/node /x/node_modules/devcontour/lib/cli.js start --workspace=${workspace}/`,
      ),
    );
    assert.ok(ok(`node --import tsx /src/devcontour/src/cli.ts serve --data ${root}`));
    assert.ok(ok(`/opt/bin/devcontour serve --workspace ${workspace}`));
    for (const cmd of [
      `claude -p use devcontour to serve --workspace ${workspace}`,
      `vim notes-devcontour.md start --workspace ${workspace}`,
      `tmux new-session -d devcontour serve --workspace ${workspace}`,
      `ssh host devcontour serve --workspace ${workspace}`,
      `tail -f devcontour.log --workspace ${workspace} run`,
      `bash -c devcontour serve --workspace ${workspace}`,
      `sudo node ./node_modules/.bin/devcontour serve --workspace ${workspace}`,
      `env node ./node_modules/.bin/devcontour serve --workspace ${workspace}`,
      `npx devcontour serve --workspace ${workspace}`,
      `nohup node ./node_modules/.bin/devcontour serve --workspace ${workspace}`,
      `node -e x ./node_modules/.bin/devcontour serve --workspace ${workspace}`,
      `node ./node_modules/.bin/devcontour doctor --workspace ${workspace}`,
      `node ./node_modules/.bin/devcontour run --workspace ${workspace}`,
      `node ./node_modules/.bin/devcontour agent serve --workspace ${workspace}`,
      `node ./node_modules/.bin/devcontour serve --workspace ${workspace}-copy`,
      `node ./node_modules/.bin/devcontour serve --workspace .`,
      `node /x/other-tool/cli.js serve --workspace ${workspace}`,
      `node /x/devcontour-notes/cli.js serve --workspace ${workspace}`,
      `node ./node_modules/.bin/devcontour --workspace ${workspace} serve`,
    ])
      assert.ok(!ok(cmd), cmd);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
