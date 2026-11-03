import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config, fixture } from './helpers.ts';
import { serve } from '../src/server/http.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { AgentContext } from '../src/application/context.ts';
import { git, command } from '../src/runner/process.ts';
import { queueStopView, type QueueStopView } from '../src/core/work-status.ts';

const STALE =
  'TaskFailure: База прогонов отстала от рабочей ветки: main — devcontour/accepted без 1 коммитов. Выполните devcontour base-update, иначе исполнитель получит дерево без подготовленной работы.';

test('Остановка очереди одинакова в /api/state, /api/preparation, сводке панели и агентском обзоре', async () => {
  const f = fixture();
  const scheduler = new Scheduler(f.h, f.root);
  const app = await serve(f.h, scheduler, { port: 0 });
  const get = async (path: string) =>
    (await (await fetch(app.url + path)).json()) as { queue?: QueueStopView };
  /** Один вид остановки во всех читателях — и он же возвращается. */
  const read = async () => {
    const state = (await get('/api/state')).queue;
    assert.ok(state, '/api/state несёт вид остановки');
    assert.deepEqual((await get('/api/preparation')).queue, state, '/api/preparation');
    assert.deepEqual((await get('/api/summary')).queue, state, 'сводка панели');
    const overview = new AgentContext(f.h).execute('project_overview', {}) as {
      queue?: QueueStopView;
    };
    assert.deepEqual(overview.queue, state, 'project_overview');
    return state;
  };
  try {
    // Исходная пауза: очередь ещё не запускали — не сбой.
    const initial = await read();
    assert.equal(initial.paused, true);
    assert.equal(initial.stopReason, 'Очередь ещё не запущена');
    assert.equal(initial.failed, undefined);
    assert.match(initial.action ?? '', /devcontour queue --start/);

    // Сбой диспетчера: отставшая база — причина из журнала и подсказка base-update.
    f.h.pause(false);
    f.h.store.change('scheduler.error', (s) => {
      s.paused = true;
      return { error: STALE };
    });
    const runtime = await read();
    assert.equal(runtime.reason, 'runtime');
    assert.equal(runtime.failed, true);
    assert.match(runtime.stopReason ?? '', /^База прогонов отстала от рабочей ветки/);
    assert.match(runtime.action ?? '', /devcontour base-update/);

    // Перенос базы: очередь ждёт проверки базы; причина — описание ожидания,
    // а не уже выполненный base-update.
    f.h.baseUpdated([{ repositoryId: 'main', from: 'a', to: 'b' }]);
    const baseCheck = await read();
    assert.equal(baseCheck.reason, 'base-check');
    assert.equal(baseCheck.failed, undefined);
    assert.match(baseCheck.stopReason ?? '', /^База прогонов перенесена \(main\)/);
    assert.doesNotMatch(baseCheck.stopReason ?? '', /Выполните devcontour base-update/);
    assert.ok(baseCheck.action);
    assert.ok(baseCheck.since, 'время остановки известно');

    // Пауза человека не выдаёт прежний сбой за причину.
    f.h.pause(false);
    f.h.store.change('scheduler.error', (s) => {
      s.paused = true;
      return { error: 'Error: снова' };
    });
    f.h.pause(true);
    const operator = await read();
    assert.equal(operator.reason, 'operator');
    assert.equal(operator.stopReason, 'Выдача остановлена человеком');
    assert.equal(operator.action, 'devcontour queue --start');

    // Штатная остановка сервера.
    f.h.pause(false);
    f.h.pause(true, 'shutdown');
    const shutdown = await read();
    assert.equal(shutdown.reason, 'shutdown');
    assert.equal(shutdown.stopReason, 'Сервер остановлен штатно');
    assert.match(shutdown.action ?? '', /devcontour serve/);

    // Обратный случай: очередь идёт — ни причины, ни подсказки.
    f.h.pause(false);
    assert.deepEqual(await read(), { paused: false });
  } finally {
    await app.close();
    await scheduler.stop();
    f.cleanup();
  }
});

test('Вид остановки: отказ провайдера и ожидание проверки базы в режимах агента и оператора', () => {
  const provider = queueStopView(
    { paused: true, pauseReason: 'runtime', pauseFailures: ['provider-auth'] },
    [],
  );
  assert.equal(provider.failed, true);
  assert.match(provider.stopReason ?? '', /провайдера моделей/);
  assert.match(provider.action ?? '', /Авторизуйте CLI исполнителя/);
  const unknown = queueStopView({ paused: true, pauseReason: 'runtime' }, []);
  assert.equal(unknown.failed, true);
  assert.match(unknown.stopReason ?? '', /после сбоя/);
  const waits = [
    { kind: 'base-check' as const, detail: 'Проверка базы не пройдена: test', at: '' },
  ];
  const agent = queueStopView({ paused: true, pauseReason: 'base-check', waits }, [], {
    approvalMode: 'agent',
  });
  const operator = queueStopView({ paused: true, pauseReason: 'base-check', waits }, [], {
    approvalMode: 'operator',
  });
  assert.equal(agent.stopReason, 'Проверка базы не пройдена: test');
  assert.equal(operator.stopReason, agent.stopReason);
  assert.match(agent.action ?? '', /Цикл ведущего проверит базу/);
  assert.equal(operator.action, 'Проверьте базу gates и выполните devcontour queue --start');
  assert.deepEqual(
    queueStopView({ paused: false, pauseReason: 'operator' }, [
      { id: 1, type: 'scheduler.error', data: { error: 'Error: старое' } },
    ]),
    { paused: false },
  );
});

test('CLI queue без флага называет причину остановки тем же текстом, что API', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-queue-stop-'));
  const repo = join(root, 'repo'),
    data = join(root, 'data');
  try {
    await mkdir(repo);
    await mkdir(data);
    await git(repo, 'init', '-b', 'main');
    await writeFile(join(repo, 'README.md'), 'Queue fixture');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'fixture');
    const c = config({ repository: repo });
    await writeFile(join(data, 'config.json'), JSON.stringify(c));
    const h = new DevContour(new Store(join(data, 'state.sqlite')), c);
    const cli = ['node', '--import', 'tsx', 'src/cli.ts', 'queue', '--data', data];
    try {
      h.pause(false);
      h.store.change('scheduler.error', (s) => {
        s.paused = true;
        return { error: STALE };
      });
      const expected = queueStopView(h.store.read(), h.store.events(), {
        approvalMode: c.approvalMode,
      });
      const stopped = await command(cli, process.cwd());
      assert.equal(stopped.code, 0, stopped.stderr);
      assert.deepEqual(JSON.parse(stopped.stdout), expected);
      assert.match((JSON.parse(stopped.stdout) as QueueStopView).stopReason ?? '', /base-update/);
      // Очередь идёт — причины нет.
      h.pause(false);
      const running = await command(cli, process.cwd());
      assert.deepEqual(JSON.parse(running.stdout), { paused: false });
    } finally {
      h.store.close();
    }
  } finally {
    if (root.startsWith(tmpdir()) && root.includes('devcontour-queue-stop-'))
      await rm(root, { recursive: true, force: true });
  }
});
