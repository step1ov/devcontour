import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { config, input, removeTestCheckoutRoot, testCheckoutRoot } from './helpers.ts';
import { repositorySchema, type Config } from '../src/core/model.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { Workspace } from '../src/core/workspace.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { WorkspaceRunner } from '../src/runner/workspace.ts';
import { git } from '../src/runner/process.ts';
import { adapters, type AgentRequest } from '../src/runner/adapters.ts';
import { attachJournal } from '../src/runner/journal.ts';
import { loadConfig } from '../src/runner/config.ts';
import { serve } from '../src/server/http.ts';
import { AgentService } from '../src/application/agent.ts';
import { executionOf } from '../src/harness/execution.ts';
import { requestConfigApply } from '../src/runner/reconfigure.ts';
import {
  quietOperations,
  type QuietAttempt,
  type QuietOperation,
} from '../src/application/queue-stop.ts';
import { checkBase } from '../src/runner/base-check.ts';
import { operationLiveness } from '../src/core/work-status.ts';
import { testDemo } from './demo-pool.ts';

/**
 * Обход зависаний controller на настоящем исполнении: два компонента в
 * компонентном хранении, gate компонента `product` молчит дольше порогов
 * (нет вывода и расхода процессора). Политика из config.json доходит до
 * runner: при `report` зависшая попытка видна в `workflow_status` с фильтром
 * компонента и идёт дальше; совместная проверка с молчащим gate видна как
 * проверка без движения; после применения `stallSweep` без перезапуска
 * (`config-apply`) с `stop` controller останавливает попытку отказом
 * `stalled`.
 */
const SWEEP = { intervalMs: 1000, quietMs: 1000, stalledMs: 3000 };
/**
 * Gate без вывода и без заметного расхода процессора: ждёт файла-барьера,
 * который тест создаёт, увидев зависание, и пишет отчёт. Без барьера —
 * сразу; не дождавшись за 25 с — отказ, чтобы прогон не висел.
 */
const silent = (barrier: string | null, name: string) =>
  `import{existsSync,writeFileSync}from'node:fs';const done=()=>{writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase name="${name}"/></testsuite>');process.exit(0)};const barrier=${JSON.stringify(barrier)};if(!barrier)done();const end=Date.now()+25000;setInterval(()=>{if(existsSync(barrier))done();if(Date.now()>end)process.exit(1)},250);`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-stall-'));
  const workspace = join(root, 'workspace');
  const data = join(workspace, '.devcontour-local');
  await mkdir(workspace);
  const repos = [];
  for (const id of ['library', 'product']) {
    const path = join(root, id);
    await mkdir(path);
    await git(path, 'init', '-b', 'main');
    await writeFile(join(path, '.gitignore'), '.devcontour-local/\n.reports/\n.deps/\n');
    await writeFile(join(path, 'value.json'), '1');
    await writeFile(
      join(path, 'verify.mjs'),
      silent(id === 'product' ? join(root, 'release-product') : null, 'value'),
    );
    await writeFile(join(path, 'together.mjs'), silent(join(root, 'release-joint'), 'together'));
    await git(path, 'add', '.');
    await git(path, 'commit', '-m', 'baseline');
    repos.push(
      repositorySchema.parse({
        id,
        name: id,
        kind: id,
        path,
        dependsOn: [],
        protectedPaths: ['verify.mjs', 'together.mjs', '.gitignore'],
        gates: [
          {
            id: 'test',
            kind: 'test',
            command: [process.execPath, 'verify.mjs'],
            timeoutMs: 30000,
            report: { type: 'junit', path: '.reports/test.xml' },
          },
        ],
      }),
    );
  }
  const checkouts = testCheckoutRoot();
  const base: Partial<Config> = {
    repository: repos[0].path,
    repositories: repos,
    workspaceRoot: workspace,
    storage: 'component',
    runTimeoutMs: 60000,
    maxAttempts: 5,
    resourceDatabase: join(root, 'resources.sqlite'),
    checkoutRoot: checkouts,
    workspaceGates: [
      {
        id: 'together',
        repositoryId: 'product',
        kind: 'test',
        command: [process.execPath, 'together.mjs'],
        timeoutMs: 30000,
        report: { type: 'junit', path: '.reports/together.xml' },
        artifacts: [],
      },
    ],
  };
  // Конфигурация — из config.json каталога данных, как у serve: её же
  // config-apply применяет потом без перезапуска.
  await mkdir(data, { recursive: true });
  const configPath = join(data, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify(config({ ...base, stallSweep: { ...SWEEP, action: 'report' } }), null, 2),
  );
  const c = loadConfig(configPath);
  const store = new Store(join(data, 'state.sqlite'), repos);
  const h = new DevContour(store, c);
  attachJournal(h);
  const runtime = {
    ...adapters,
    demo: {
      name: 'demo' as const,
      async execute(r: AgentRequest) {
        if (r.review)
          return {
            data: { approved: true, summary: 'Fixture review', findings: [] },
            log: 'fixture',
            command: ['fixture'],
          };
        await writeFile(join(r.cwd, 'value.json'), String(Date.now()));
        return {
          data: { completed: true, summary: 'Fixture implementation' },
          log: 'fixture',
          command: ['fixture'],
        };
      },
    },
  };
  const scheduler = new Scheduler(h, data, runtime);
  await scheduler.init();
  const status = (repositoryId?: string) =>
    new AgentService(h).execute({
      operation: 'workflow_status',
      input: repositoryId ? { repositoryId } : {},
    }) as { liveness: QuietAttempt[]; operations: QuietOperation[] };
  return {
    root,
    data,
    store,
    h,
    scheduler,
    status,
    close: async () => {
      await scheduler.stop();
      store.close();
      removeTestCheckoutRoot(checkouts);
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Ждать, пока `probe` не вернёт значение (не дольше `ms`). */
async function until<T>(probe: () => T | undefined, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error('Не дождались состояния');
    await sleep(200);
  }
}

test('stallSweep доходит до runner: report виден по компоненту, совместная проверка видна, stop после config-apply', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(executionOf(f.h).engine.policy.stallSweep, { ...SWEEP, action: 'report' });
    const board = f.h.createBoard('Product board', '', 'product');
    const task = f.h.addTask(board.id, { ...input('Slow gate'), repositoryId: 'product' });
    f.h.approve(board.id);
    f.h.pause(false);

    // report: попытка зависла на gate, видна с фильтром своего компонента.
    const drained = f.scheduler.drain();
    const stalled = await until(() =>
      f.status('product').liveness.find((l) => l.taskId === task.id && l.state === 'stalled'),
    );
    assert.equal(stalled.repositoryId, 'product');
    assert.equal(stalled.action, 'report');
    assert.equal(stalled.attention, true);
    assert.equal(stalled.activity?.kind, 'gate');
    assert.match(stalled.text, /^зависла \d+ с — проверьте среду$/);
    assert.match(stalled.next, /stallSweep\.action: report/);
    assert.deepEqual(f.status('library').liveness, [], 'чужой компонент её не видит');
    assert.ok(
      f.store.read().runs.find((r) => r.id === stalled.runId)?.liveness?.artifact,
      'снимок зависания сохранён',
    );
    // Зависание увидели — gate отпускается барьером, попытка доходит до конца.
    await writeFile(join(f.root, 'release-product'), '');
    await drained;
    const done = f.store.read();
    assert.equal(done.tasks.find((t) => t.id === task.id)?.status, 'done');
    // Движение вернулось (gate закончился) — переход в active, вида нет.
    assert.equal(done.runs.find((r) => r.taskId === task.id)?.liveness?.state, 'active');
    assert.deepEqual(f.status().liveness, [], 'завершённая попытка вида не даёт');

    // Совместная проверка с молчащим gate: проверка без движения.
    const workspace = new Workspace(f.h);
    const change = workspace.create({
      title: 'Slow joint check',
      description: 'Joint gate stays silent.',
      boardIds: [board.id],
    });
    const verifying = new WorkspaceRunner(f.h, f.data).verify(change.id);
    const joint = await until(() =>
      f.status().operations.find((o) => o.kind === 'joint' && o.state === 'stalled'),
    );
    assert.equal(joint.subjectId, change.id);
    assert.equal(joint.title, 'Slow joint check');
    assert.equal(joint.attention, true);
    assert.match(joint.text, /^зависла \d+ с — проверьте среду$/);
    assert.deepEqual(
      f.status('product').operations,
      [],
      'совместная проверка — уровень workspace, не компонента',
    );
    await writeFile(join(f.root, 'release-joint'), '');
    await verifying;
    assert.deepEqual(f.status().operations, [], 'законченная проверка вида не даёт');

    // config-apply без перезапуска: работающий сервер применяет stallSweep из
    // config.json на своём такте, и stop останавливает зависшую попытку.
    type Lead = { leaseTimer?: unknown; sweep?: { timer?: unknown } };
    const built = () => (f.scheduler as unknown as { built?: { runner: Lead } }).built?.runner;
    // Сервер ведёт очередь прежним исполнителем: его продление роли и обход
    // зависших идут, пока он ведёт очередь.
    f.scheduler.start();
    const previous = await until(() => {
      const runner = built();
      return runner?.leaseTimer !== undefined && runner?.sweep?.timer !== undefined
        ? runner
        : undefined;
    });
    const configPath = join(f.data, 'config.json');
    const raw = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    await writeFile(
      configPath,
      JSON.stringify({ ...raw, stallSweep: { ...SWEEP, action: 'stop' } }),
    );
    const applied = await requestConfigApply(f.data, ['stallSweep'], { waitMs: 20000 });
    assert.equal(applied.status, 'applied', JSON.stringify(applied));
    assert.equal(executionOf(f.h).engine.policy.stallSweep?.action, 'stop');
    // Новый исполнитель под новой политикой; у прежнего не остаётся ни
    // продления роли, ни интервала обхода зависших.
    await until(() => (built() && built() !== previous ? true : undefined));
    await until(() =>
      previous.leaseTimer === undefined && previous.sweep?.timer === undefined ? true : undefined,
    );
    // Барьер снят: следующая попытка молчит, пока её не остановит controller.
    await rm(join(f.root, 'release-product'));
    const next = f.h.createBoard('Product board 2', '', 'product');
    const second = f.h.addTask(next.id, { ...input('Slow gate again'), repositoryId: 'product' });
    f.h.approve(next.id);
    const failed = await until(() =>
      f.store.read().runs.find((r) => r.taskId === second.id && r.status === 'failed'),
    );
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureKind, 'stalled');
    assert.match(failed.error ?? '', /Зависание/);
    assert.ok(failed.liveness?.artifact?.startsWith('/'), 'в записи — путь каталога состояния');

    // /api/state называет снимок без абсолютного пути хоста.
    f.h.pause(true);
    await f.scheduler.stop();
    const app = await serve(f.h, f.scheduler, { port: 0 });
    try {
      const state = (await (await fetch(app.url + '/api/state')).json()) as {
        runs: { id: string; liveness?: { artifact?: string } }[];
      };
      const artifact = state.runs.find((r) => r.id === failed.id)?.liveness?.artifact;
      assert.ok(artifact);
      assert.ok(!artifact.startsWith('/'), artifact);
      assert.ok(!artifact.includes(f.root), artifact);
      assert.match(artifact, /stall-\d+\.json$/);
    } finally {
      await app.close();
    }
  } finally {
    await f.close();
  }
});

test('Проверка базы с молчащим gate: runGatesAt → событие журнала → вид проверки без движения', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-stall-base-'));
  const barrier = join(root, 'release-base');
  try {
    await testDemo(root);
    const c = loadConfig(join(root, 'config.json'));
    c.gates = [
      {
        id: 'base-gate',
        kind: 'test',
        timeoutMs: 30000,
        command: [process.execPath, '--input-type=module', '-e', silent(barrier, 'base')],
        report: { type: 'junit', path: '.reports/base.xml' },
      },
    ] as Config['gates'];
    c.stallSweep = { ...SWEEP, action: 'report' };
    const store = new Store(join(root, 'stall-base.sqlite'));
    const h = new DevContour(store, c);
    try {
      assert.equal(c.approvalMode, 'agent');
      // Перенос базы: коммит на рабочей ветке и перенос target на него.
      const target = 'refs/heads/' + c.targetBranch;
      await writeFile(join(c.repository, 'base.txt'), 'moved');
      await git(c.repository, 'add', '--', 'base.txt');
      await git(c.repository, 'commit', '-qm', 'Base moved');
      const sha = await git(c.repository, 'rev-parse', 'HEAD');
      const from = await git(c.repository, 'rev-parse', target);
      await git(c.repository, 'update-ref', target, sha);
      h.baseUpdated([{ repositoryId: 'main', from, to: sha }]);
      assert.ok(h.leader('server'), 'роль controller у сервера');
      const checking = checkBase(h, { data: root, state: root }, () => {
        h.leader('server');
      });
      const operations = () =>
        quietOperations(h, h.store.read(), Date.now(), 'agent', 'main').filter(
          (o) => o.kind === 'base-check',
        );
      const stalled = await until(() => operations().find((o) => o.state === 'stalled'));
      assert.match(stalled.id, /^BK-/);
      assert.equal(stalled.repositoryId, 'main');
      assert.equal(stalled.subjectId, 'main');
      assert.equal(stalled.attention, true);
      assert.equal(stalled.activity?.kind, 'gate');
      assert.match(stalled.next, /stallSweep\.action: report/);
      const event = store
        .allEvents()
        .filter((e) => e.type === 'base.check.liveness')
        .at(-1)!.data as { runId: string; owner?: string; sha: string };
      assert.equal(event.runId, stalled.id);
      assert.equal(event.owner, 'server', 'переход записан под владельцем роли');
      assert.equal(event.sha, sha);
      // Роль у другого владельца (сервер перезапущен) — проверка не идущая.
      const lease = store.read().leader!;
      assert.deepEqual(
        operationLiveness(
          { ...store.read(), leader: { ...lease, owner: 'restarted' } },
          store.latestEvents([
            'base.check.liveness',
            'base.check.started',
            'base.check.passed',
            'base.check.failed',
          ]),
          Date.now(),
        ),
        [],
      );
      await writeFile(barrier, '');
      assert.equal(await checking, true, 'база проверена, ожидание снято');
      assert.deepEqual(operations(), [], 'законченная проверка вида не даёт');
      // Отмена задания посреди проверки: закрывающее событие пишется под
      // fencing (`closing`), хотя обычная граница после отмены отказывает.
      await rm(barrier);
      await writeFile(join(c.repository, 'base.txt'), 'moved again');
      await git(c.repository, 'add', '--', 'base.txt');
      await git(c.repository, 'commit', '-qm', 'Base moved again');
      const again = await git(c.repository, 'rev-parse', 'HEAD');
      await git(c.repository, 'update-ref', target, again);
      h.store.change('test.pause', (s) => {
        s.paused = true;
      });
      h.baseUpdated([{ repositoryId: 'main', from: sha, to: again }]);
      const abort = new AbortController();
      const closings: boolean[] = [];
      const aborted = checkBase(
        h,
        { data: root, state: root },
        (options) => {
          closings.push(!!options?.closing);
          if (!options?.closing) abort.signal.throwIfAborted();
          h.leader('server');
        },
        abort.signal,
      );
      await until(() => operations().find((o) => o.state === 'stalled'));
      abort.abort();
      await assert.rejects(aborted);
      const last = store
        .allEvents()
        .filter((e) => e.type.startsWith('base.check.'))
        .at(-1)!;
      assert.equal(last.type, 'base.check.failed', 'отменённая проверка закрыта событием');
      assert.ok(closings.includes(true), 'закрывающее событие — под границей closing');
      assert.deepEqual(operations(), [], 'отменённая проверка вида не даёт');
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
