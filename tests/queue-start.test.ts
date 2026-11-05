import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from './helpers.ts';
import { DevContour, SERVER_STOPPING, serverStopping } from '../src/core/service.ts';
import { executionOf } from '../src/harness/execution.ts';
import { Store } from '../src/core/store.ts';
import { git, command } from '../src/runner/process.ts';
import { startQueue } from '../src/runner/queue-start.ts';

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-queue-start-'));
  const repo = join(root, 'repo'),
    data = join(root, 'data');
  await mkdir(repo);
  await mkdir(data);
  await git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), 'Queue fixture');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'fixture');
  const c = config({ repository: repo });
  await writeFile(join(data, 'config.json'), JSON.stringify(c));
  const open = () => new DevContour(new Store(join(data, 'state.sqlite')), c);
  return { root, data, open };
}

/**
 * Работающий сервер в миниатюре: каждый такт продлевает роль controller и,
 * если `hold`, снова ставит снятую очередь на паузу — как такт, который нашёл
 * отставшую базу прогонов.
 */
function server(h: DevContour, hold: boolean) {
  h.leader('server');
  const timer = setInterval(() => {
    h.leader('server');
    if (hold && !h.store.read().paused)
      h.store.change('scheduler.error', (s) => {
        s.paused = true;
        return {
          error:
            'TaskFailure: База прогонов отстала от рабочей ветки: main — devcontour/accepted без 1 коммитов. Выполните devcontour base-update, иначе исполнитель получит дерево без подготовленной работы.',
        };
      });
  }, 60);
  return () => clearInterval(timer);
}

test('queue --start при работающем сервере, который снова остановил очередь, — отказ с причиной, а не успех', async () => {
  const w = await workspace();
  const serving = w.open();
  let stop = () => {};
  try {
    serving.pause(true);
    stop = server(serving, true);
    const cli = ['node', '--import', 'tsx', 'src/cli.ts'];
    const started = await command([...cli, 'queue', '--start', '--data', w.data], process.cwd());
    assert.notEqual(started.code, 0, 'очередь осталась на паузе — команда не успешна');
    const result = JSON.parse(started.stdout) as {
      paused: boolean;
      stopReason?: string;
      action?: string;
      error?: string;
    };
    assert.equal(result.paused, true);
    assert.match(result.stopReason ?? '', /base-update/);
    // Тот же вид остановки, что в API и панели: с подсказкой оператору.
    assert.match(result.action ?? '', /^Выполните devcontour base-update/);
    assert.match(result.error ?? '', /^Очередь осталась на паузе: .*base-update/);
  } finally {
    stop();
    serving.store.close();
    await rm(w.root, { recursive: true, force: true });
  }
});

test('queue --start подтверждает запуск тактами сервера, а без сервера отвечает своей записью', async () => {
  const w = await workspace();
  const serving = w.open();
  const cli = w.open();
  let stop = () => {};
  try {
    // Сервера нет: ждать нечего, ответ — записанное снятие паузы.
    serving.pause(true);
    assert.deepEqual(
      { ...(await startQueue(cli)), reason: undefined },
      { paused: false, reason: undefined, server: 'none' },
    );

    // Сервер работает и паузу не возвращает: запуск подтверждён его тактами.
    serving.pause(true);
    stop = server(serving, false);
    const running = await startQueue(cli, { pollMs: 20 });
    assert.equal(running.paused, false);
    assert.equal('server' in running && running.server, 'running');
    stop();

    // Сервер не делает тактов (завис): снятие записано, но не подтверждено.
    serving.pause(true);
    serving.leader('server');
    const silent = await startQueue(cli, { timeoutMs: 300, pollMs: 20 });
    assert.equal(silent.paused, false);
    assert.equal('server' in silent && silent.server, 'unconfirmed');
  } finally {
    stop();
    cli.store.close();
    serving.store.close();
    await rm(w.root, { recursive: true, force: true });
  }
});

test('queue --start из другого процесса, пока сервер останавливается, — отказ; после остановки или падения сервера — запуск', async () => {
  const w = await workspace();
  const serving = w.open();
  const other = w.open();
  const cliArgs = ['node', '--import', 'tsx', 'src/cli.ts', 'queue', '--start', '--data', w.data];
  try {
    // Сервер ведёт очередь и начал штатную остановку: пауза остановки стоит.
    serving.leader('server');
    serving.pause(false);
    serving.markStopping('server', true);
    serving.pause(true, 'shutdown');

    // Отдельный процесс CLI: отказ, пауза остановки осталась.
    const refused = await command(cliArgs, process.cwd());
    assert.notEqual(refused.code, 0);
    assert.match(refused.stdout + refused.stderr, new RegExp(SERVER_STOPPING));
    assert.equal(serving.store.read().paused, true);
    assert.equal(serving.store.read().pauseReason, 'shutdown');
    // Другое соединение с той же базой: тот же отказ (как отдельный MCP-сервер).
    await assert.rejects(startQueue(other), (e: Error) => e.message === SERVER_STOPPING);
    assert.equal(other.store.read().paused, true);

    // Сервер упал: роль не освобождена, но её срок истёк — отметка не держит.
    serving.store.update('test.lease-expired', (d) => {
      d.leader = { ...d.leader!, leaseUntil: Date.now() - 1 };
    });
    assert.equal(serverStopping(other.store, other.store.read().leader), false);
    const afterCrash = await command(cliArgs, process.cwd());
    assert.equal(afterCrash.code, 0, afterCrash.stderr);
    assert.equal(other.store.read().paused, false);

    // Новый сервер с прежней отметкой в базе: её владелец уже не держит роль.
    serving.leader('next-server');
    other.pause(true);
    assert.equal((await startQueue(other, { timeoutMs: 200, pollMs: 20 })).paused, false);

    // Штатная остановка нового сервера закончилась освобождением роли.
    other.pause(true);
    serving.markStopping('next-server', true);
    await assert.rejects(startQueue(other), (e: Error) => e.message === SERVER_STOPPING);
    // Останавливается и второй сервер, который очередь не ведёт: действующую
    // отметку ведущего он не заменяет и не снимает.
    assert.equal(other.markStopping('idle-server', true), false);
    assert.equal(other.markStopping('idle-server', false), false);
    await assert.rejects(startQueue(other), (e: Error) => e.message === SERVER_STOPPING);
    executionOf(serving).engine.release('next-server');
    serving.markStopping('next-server', false);
    assert.equal(serving.store.localRecord('server', undefined, 'stopping'), null);
    assert.deepEqual(
      { ...(await startQueue(other)), reason: undefined },
      { paused: false, reason: undefined, server: 'none' },
    );
  } finally {
    other.store.close();
    serving.store.close();
    await rm(w.root, { recursive: true, force: true });
  }
});
