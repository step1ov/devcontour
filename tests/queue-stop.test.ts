import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config, fixture, input } from './helpers.ts';
import { serve } from '../src/server/http.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { AgentService } from '../src/application/agent.ts';
import { baseWaitOf } from '../src/application/queue-stop.ts';
import { baseUpdateOperation } from '../src/runner/base-update.ts';
import { repositorySchema } from '../src/core/model.ts';
import { realpath } from 'node:fs/promises';
import { devcontourHooks } from '../src/harness/hooks.ts';
import { git, command } from '../src/runner/process.ts';
import { queueStopView, type QueueStopView } from '../src/core/work-status.ts';

const STALE =
  'TaskFailure: База прогонов отстала от рабочей ветки: main — devcontour/accepted без 1 коммитов. Выполните devcontour base-update, иначе исполнитель получит дерево без подготовленной работы.';
const START = 'devcontour queue --start';
const MANUAL_OR_WORKFLOW =
  'Если доска ведётся workflow — зарегистрируйте её через workflow_start; если вручную — devcontour queue --start; маршруты не смешивайте';

/**
 * Сервер панели над fixture и чтение вида остановки из всех мест, где его
 * отдают: `/api/state`, `/api/preparation`, сводка панели и агентские
 * `project_context`, `project_overview`, `workflow_status`. Байты совпадают.
 */
async function panel(f: ReturnType<typeof fixture>) {
  const scheduler = new Scheduler(f.h, f.root);
  const app = await serve(f.h, scheduler, { port: 0 });
  const get = async (path: string) =>
    (await (await fetch(app.url + path)).json()) as { queue?: QueueStopView };
  const agent = (operation: string) =>
    new AgentService(f.h).execute({ operation, input: {} }) as { queue?: QueueStopView };
  const read = async () => {
    const state = (await get('/api/state')).queue;
    assert.ok(state, '/api/state несёт вид остановки');
    const bytes = JSON.stringify(state);
    for (const [name, other] of [
      ['/api/preparation', (await get('/api/preparation')).queue],
      ['/api/summary', (await get('/api/summary')).queue],
      ['project_context', agent('project_context').queue],
      ['project_overview', agent('project_overview').queue],
      ['workflow_status', agent('workflow_status').queue],
    ] as const)
      assert.equal(JSON.stringify(other), bytes, name);
    return state;
  };
  return {
    read,
    close: async () => {
      await app.close();
      await scheduler.stop();
    },
  };
}

test('Остановка очереди одинакова во всех ответах: сбой, проверка базы, человек, ход', async () => {
  const f = fixture();
  const p = await panel(f);
  try {
    // Сбой диспетчера: отставшая база — причина из журнала и подсказка base-update.
    f.h.pause(false);
    f.h.store.change('scheduler.error', (s) => {
      s.paused = true;
      return { error: STALE };
    });
    const runtime = await p.read();
    assert.equal(runtime.reason, 'runtime');
    assert.equal(runtime.failed, true);
    assert.match(runtime.stopReason ?? '', /^База прогонов отстала от рабочей ветки/);
    assert.equal(
      runtime.action,
      'Выполните devcontour base-update (ведущий агент — с --by host), затем проверьте базу и ' +
        START,
    );

    // Перенос базы: очередь ждёт проверки базы; причина — описание ожидания,
    // а не уже выполненный base-update.
    f.h.baseUpdated([{ repositoryId: 'main', from: 'a', to: 'b' }]);
    const baseCheck = await p.read();
    assert.equal(baseCheck.reason, 'base-check');
    assert.equal(baseCheck.failed, undefined);
    assert.match(baseCheck.stopReason ?? '', /^База прогонов перенесена \(main\)/);
    assert.equal(baseCheck.action, 'Проверьте базу gates, затем выполните ' + START);
    assert.ok(baseCheck.since, 'время остановки известно');

    // Пауза человека не выдаёт прежний сбой за причину.
    f.h.pause(false);
    f.h.store.change('scheduler.error', (s) => {
      s.paused = true;
      return { error: 'Error: снова' };
    });
    f.h.pause(true);
    const operator = await p.read();
    assert.equal(operator.reason, 'operator');
    assert.equal(operator.stopReason, 'Выдача остановлена человеком');
    assert.equal(operator.action, START);

    // Обратный случай: очередь идёт — ни причины, ни подсказки.
    f.h.pause(false);
    assert.deepEqual(await p.read(), { paused: false });
  } finally {
    await p.close();
    f.cleanup();
  }
});

test('Пауза человека перед переносом базы называет ожидание проверки базы, а не только паузу', async () => {
  const f = fixture();
  const p = await panel(f);
  try {
    // Штатный маршрут: queue --pause, затем base-update. queue --start снимет
    // и паузу, и ожидание — поэтому подсказка: сначала проверить базу.
    f.h.pause(false);
    f.h.pause(true);
    f.h.baseUpdated([{ repositoryId: 'main', from: 'a', to: 'b' }]);
    const view = await p.read();
    assert.equal(view.reason, 'operator');
    assert.match(view.stopReason ?? '', /^База прогонов перенесена \(main\)/);
    assert.equal(
      view.action,
      'Проверьте базу gates, затем выполните ' +
        START +
        ' — он снимет и паузу человека, и ожидание',
    );
  } finally {
    await p.close();
    f.cleanup();
  }
});

test('Исходная и штатная паузы: подсказка зависит от режима и работы ведущего', async () => {
  const f = fixture();
  const p = await panel(f);
  try {
    // Режим агента без работы ведущего: исходная пауза — не сбой; очередь
    // запускают через workflow_start, а не ручным queue --start.
    assert.equal(f.h.config.approvalMode, 'agent');
    const initial = await p.read();
    assert.equal(initial.reason, 'not-started');
    assert.equal(initial.stopReason, 'Очередь ещё не запущена');
    assert.equal(initial.failed, undefined);
    assert.equal(initial.action, MANUAL_OR_WORKFLOW);

    // Штатная остановка после перезапуска, режим агента без работы ведущего.
    f.h.pause(false);
    f.h.pause(true, 'shutdown');
    const agentIdle = await p.read();
    assert.equal(agentIdle.reason, 'shutdown');
    assert.equal(agentIdle.stopReason, 'Сервер был остановлен штатно');
    assert.equal(agentIdle.action, MANUAL_OR_WORKFLOW);

    // С зарегистрированной работой её снимет цикл ведущего.
    const b = f.h.createBoard('Доска');
    f.h.addTask(b.id, input('Задача'));
    new LeadWorkflow(f.h).start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
    const agentBusy = await p.read();
    assert.match(agentBusy.action ?? '', /^Ничего не требуется: цикл ведущего продолжит выдачу/);

    // Режим оператора: цикл не продвигается, паузу снимает человек.
    f.h.config.approvalMode = 'operator';
    const operatorMode = await p.read();
    assert.equal(operatorMode.reason, 'shutdown');
    assert.equal(operatorMode.action, START);
  } finally {
    await p.close();
    f.cleanup();
  }
});

test('Отказ провайдера называет свою подсказку и при паузе человека поверх него', async () => {
  const f = fixture();
  const p = await panel(f);
  try {
    const b = f.h.createBoard('Доска');
    const t = f.h.addTask(b.id, input('Задача'));
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('test')!;
    assert.equal(run.taskId, t.id);
    // Путь отказа runner: движок ставит паузу с классом, затем хук `failed`
    // пишет `scheduler.error` (engine/runner.js harness).
    f.h.fail(run.id, run.token, 'Credit balance too low', false, 'provider-auth');
    const attempt = f.h.store.read().runs.find((r) => r.id === run.id)!;
    await devcontourHooks(f.h).failed?.({
      attempt,
      kind: 'provider-auth',
      message: 'Credit balance too low',
    } as never);
    assert.deepEqual(f.h.store.read().pauseFailures, ['provider-auth']);
    assert.ok(f.h.store.events().some((e) => e.type === 'scheduler.error'));
    const provider = await p.read();
    assert.equal(provider.reason, 'runtime');
    assert.equal(provider.failed, true);
    assert.match(provider.stopReason ?? '', /Credit balance too low/);
    assert.match(provider.action ?? '', /^Авторизуйте CLI исполнителя/);

    // Пауза человека поверх отказа не прячет класс отказа: выдача стоит из-за него.
    f.h.store.change('test.operator', (s) => {
      s.pauseReason = 'operator';
      s.pausedAt = new Date().toISOString();
    });
    const operator = await p.read();
    assert.equal(operator.reason, 'operator');
    assert.match(operator.action ?? '', /^Авторизуйте CLI исполнителя/);
  } finally {
    await p.close();
    f.cleanup();
  }
});

test('Длинная ошибка диспетчера усечена одинаково во всех ответах', async () => {
  const f = fixture();
  const p = await panel(f);
  try {
    f.h.pause(false);
    f.h.store.change('scheduler.error', (s) => {
      s.paused = true;
      return { error: 'Error: ' + 'длинная причина '.repeat(1000) };
    });
    const view = await p.read();
    assert.equal(view.stopReason?.length, 2001, 'предел диагностики и «…»');
    assert.ok(view.stopReason?.endsWith('…'));
  } finally {
    await p.close();
    f.cleanup();
  }
});

test('Сбой такта, чьё событие ушло из окна журнала, не выдаётся за незапущенную очередь', () => {
  const view = queueStopView({ paused: true, pausedAt: new Date().toISOString() }, []);
  assert.equal(view.reason, 'runtime');
  assert.equal(view.failed, true);
  assert.match(view.stopReason ?? '', /сбоем диспетчера/);
  // Ошибка старше паузы относится к прошлой остановке.
  const old = queueStopView(
    { paused: true, pauseReason: 'runtime', pausedAt: '2026-11-03T10:00:00.000Z' },
    [
      {
        id: 1,
        at: '2026-11-03T09:00:00.000Z',
        type: 'scheduler.error',
        data: { error: 'Error: старое' },
      },
    ],
  );
  assert.doesNotMatch(old.stopReason ?? '', /старое/);
  assert.deepEqual(
    queueStopView({ paused: false, pauseReason: 'operator' }, [
      { id: 1, at: '', type: 'scheduler.error', data: { error: 'Error: старое' } },
    ]),
    { paused: false },
  );
});

test('Подсказка учитывает ожидание базы при отказе, применение конфигурации и работу ведущего', () => {
  const now = new Date().toISOString();
  const wait = (detail: string) => [{ kind: 'base-check' as const, detail, at: now }];
  const agent = { approvalMode: 'agent' as const, workflowActive: true };

  // Отказ и ожидание базы: продолжение снимет ожидание — базу проверяют до него.
  const provider = queueStopView(
    {
      paused: true,
      pauseReason: 'runtime',
      pausedAt: now,
      pauseFailures: ['provider-auth'],
      waits: wait('База прогонов перенесена (main): проверьте её гейтами и продолжите очередь'),
    },
    [],
  );
  assert.equal(
    provider.action,
    'Авторизуйте CLI исполнителя, пополните баланс или дождитесь сброса лимита, проверьте базу gates, затем ' +
      START,
  );

  // Применение конфигурации: паузу снимет операция, queue --start не предлагается
  // ни при отказе, ни при ожидании базы.
  for (const extra of [
    {},
    { pauseFailures: ['environment' as const] },
    { waits: wait('База прогонов перенесена (main)') },
  ]) {
    const view = queueStopView(
      { paused: true, pauseReason: 'reconfigure', pausedAt: now, ...extra },
      [],
      agent,
    );
    assert.equal(
      view.action,
      'Ничего не требуется: операция изменения контракта снимет паузу сама',
      JSON.stringify(extra),
    );
  }

  // Перенос базы ещё идёт: ожидания нет — подождать, а не запускать очередь.
  const updating = queueStopView({ paused: true, pauseReason: 'base-check', pausedAt: now }, []);
  assert.equal(updating.action, 'Идёт обновление базы — дождитесь его окончания');

  // Проверка базы провалилась в режиме агента: сначала исправить базу.
  const checkFailed = queueStopView(
    {
      paused: true,
      pauseReason: 'base-check',
      pausedAt: now,
      waits: wait('Проверка базы не пройдена: test. Исправьте базу и выполните base-update'),
    },
    [],
    agent,
  );
  assert.equal(
    checkFailed.action,
    'Исправьте базу и выполните devcontour base-update (ведущий агент — с --by host) — цикл ведущего проверит её снова',
  );
  assert.doesNotMatch(checkFailed.action ?? '', /queue --start/);

  // Отказ окружения при работе ведущего: один повтор цикл делает сам.
  const environment = queueStopView(
    { paused: true, pauseReason: 'runtime', pausedAt: now, pauseFailures: ['environment'] },
    [],
    agent,
  );
  assert.equal(
    environment.action,
    'Цикл ведущего один раз повторит задачу сам; если отказ повторится — устраните неисправность окружения, затем ' +
      START,
  );
  const environmentManual = queueStopView(
    { paused: true, pauseReason: 'runtime', pausedAt: now, pauseFailures: ['environment'] },
    [],
    { approvalMode: 'operator' },
  );
  assert.equal(environmentManual.action, 'Устраните неисправность окружения, затем ' + START);
});

test('CLI queue без флага печатает причину и подсказку', async () => {
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
      const stopped = await command(cli, process.cwd());
      assert.equal(stopped.code, 0, stopped.stderr);
      const view = JSON.parse(stopped.stdout) as QueueStopView;
      assert.equal(view.paused, true);
      assert.equal(view.reason, 'runtime');
      assert.equal(view.stopReason, STALE.replace(/^TaskFailure: /, ''));
      assert.equal(
        view.action,
        'Выполните devcontour base-update (ведущий агент — с --by host), затем проверьте базу и ' +
          START,
      );
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

test('R4-M1: ожидание после base-update без workflow ждёт человека; с workflow — контур, кроме удержания и провала', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dc-basewait-')));
  try {
    const path = join(root, 'repo');
    await mkdir(path);
    await git(path, 'init', '-q', '-b', 'work');
    await writeFile(join(path, 'base.txt'), 'base');
    await git(path, 'add', '.');
    await git(path, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'base', '--no-gpg-sign');
    await git(path, 'branch', 'devcontour/accepted');
    await writeFile(join(path, 'prep.txt'), 'prepared');
    await git(path, 'add', '.');
    await git(path, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'prep', '--no-gpg-sign');
    const data = join(root, 'data');
    await mkdir(data);
    const h = new DevContour(
      new Store(join(data, 'state.sqlite')),
      config({
        repositories: [
          repositorySchema.parse({ id: 'main', name: 'main', path, gates: config().gates }),
        ],
        checkoutRoot: join(root, 'checkouts'),
      }),
    );
    try {
      assert.equal(h.config.approvalMode ?? 'agent', 'agent');
      // Ручной маршрут: ведущий переносит базу, workflow не зарегистрирован.
      await baseUpdateOperation(h, data, { by: 'host' });
      const state = h.store.read();
      assert.equal(state.pauseReason, 'base-check');
      assert.ok(state.baseMoves);
      assert.equal(
        baseWaitOf(h, state)?.needsOperator,
        true,
        'без workflow ожидание не снимет никто, кроме человека',
      );
      // Workflow ведёт доску — обычную проверку базы выполнит цикл ведущего.
      const b = h.createBoard('Доска');
      h.addTask(b.id, input('Задача'));
      new LeadWorkflow(h).start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
      assert.equal(baseWaitOf(h, h.store.read())?.needsOperator, false);
      // Удержание переноса контура и провал проверки — снова человек.
      const withDetail = (detail: string) => {
        const s = h.store.read();
        return {
          ...s,
          waits: s.waits!.map((w) => (w.kind === 'base-check' ? { ...w, detail } : w)),
        };
      };
      assert.equal(
        baseWaitOf(h, withDetail('Перенос базы меняет приёмку или настройку контура: AGENTS.md'))
          ?.needsOperator,
        true,
      );
      assert.equal(
        baseWaitOf(h, withDetail('Проверка базы не пройдена: unit-tests'))?.needsOperator,
        true,
      );
      h.config.approvalMode = 'operator';
      assert.equal(baseWaitOf(h, h.store.read())?.needsOperator, true);
    } finally {
      h.store.close();
    }
  } finally {
    assert.ok(root.startsWith(await realpath(tmpdir())) && root.includes('dc-basewait-'));
    await rm(root, { recursive: true, force: true });
  }
});

test('Пауза ведущего агента через queue_set записана за ним, а не за человеком', async () => {
  const f = fixture();
  try {
    f.h.pause(false);
    const agent = new AgentService(f.h, f.root);
    const set = (await agent.run({ operation: 'queue_set', input: { paused: true } })) as {
      queue: QueueStopView;
    };
    assert.equal(set.queue.reason, 'operator');
    assert.equal(set.queue.by, 'lead');
    assert.equal(set.queue.stopReason, 'Выдача остановлена ведущим агентом (queue_set)');
    const journal = f.h.store
      .events()
      .filter((e) => e.type === 'scheduler.paused')
      .at(-1);
    assert.equal((journal?.data as { by?: string }).by, 'lead');
    // Новая пауза человека — его решение: отметка ведущего снята.
    f.h.pause(true);
    const human = queueStopView(f.h.store.read(), f.h.store.events());
    assert.equal(human.stopReason, 'Выдача остановлена человеком');
    assert.equal(human.by, undefined);
    // Снятие паузы тоже снимает отметку.
    await agent.run({ operation: 'queue_set', input: { paused: true } });
    f.h.pause(false);
    assert.equal(f.h.store.read().pauseActor, undefined);
  } finally {
    f.cleanup();
  }
});

test('Пауза ведущего поверх паузы человека не переписывает решение человека', async () => {
  const f = fixture();
  try {
    f.h.pause(false);
    f.h.pause(true);
    const human = f.h.store.read();
    const agent = new AgentService(f.h, f.root);
    const set = (await agent.run({ operation: 'queue_set', input: { paused: true } })) as {
      queue: QueueStopView;
    };
    assert.equal(set.queue.stopReason, 'Выдача остановлена человеком');
    assert.equal(set.queue.by, undefined);
    const after = f.h.store.read();
    assert.equal(after.pauseActor, undefined);
    assert.equal(after.pausedAt, human.pausedAt, 'время решения человека прежнее');
    // Пауза ведущего поверх своей же — его новая пауза, отметка остаётся.
    f.h.pause(false);
    await agent.run({ operation: 'queue_set', input: { paused: true } });
    await agent.run({ operation: 'queue_set', input: { paused: true } });
    assert.equal(queueStopView(f.h.store.read(), []).by, 'lead');
  } finally {
    f.cleanup();
  }
});

test('Удержанный перенос базы: действие — подтверждение оператора в «Внимании», а не queue --start ведущего', async () => {
  const f = fixture();
  try {
    const { BASE_HELD_DETAIL } = await import('../src/runner/base-check.ts');
    const { HELD_BASE_ACTION } = await import('../src/core/work-status.ts');
    f.h.pause(false);
    await new AgentService(f.h, f.root).run({ operation: 'queue_set', input: { paused: true } });
    f.h.store.change('fixture', (s) => {
      s.waits = [
        {
          kind: 'base-check',
          detail: `${BASE_HELD_DETAIL} (main:contracts/api.md): gates этой базы его не подтверждают.`,
          at: new Date().toISOString(),
        },
      ];
      return {};
    });
    for (const mode of ['agent', 'operator'] as const) {
      const view = queueStopView(f.h.store.read(), [], {
        approvalMode: mode,
        workflowActive: true,
      });
      assert.equal(view.action, HELD_BASE_ACTION);
      assert.match(view.action ?? '', /«Подтвердить и запустить» в «Внимании»/);
      assert.doesNotMatch(view.action ?? '', /^Проверьте базу gates, затем выполните/);
    }
  } finally {
    f.cleanup();
  }
});
