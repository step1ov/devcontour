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
import type { QuietAttempt, QuietOperation } from '../src/application/queue-stop.ts';

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
/** Gate без вывода и без расхода процессора: ждёт и пишет отчёт. */
const silent = (ms: number, name: string) =>
  `import{writeFileSync}from'node:fs';setTimeout(()=>writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase name="${name}"/></testsuite>'),${ms});`;

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
    await writeFile(join(path, 'verify.mjs'), silent(id === 'product' ? 6500 : 0, 'value'));
    await writeFile(join(path, 'together.mjs'), silent(6500, 'together'));
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
    await verifying;
    assert.deepEqual(f.status().operations, [], 'законченная проверка вида не даёт');

    // config-apply без перезапуска: работающий сервер применяет stallSweep из
    // config.json на своём такте, и stop останавливает зависшую попытку.
    const configPath = join(f.data, 'config.json');
    const raw = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    await writeFile(
      configPath,
      JSON.stringify({ ...raw, stallSweep: { ...SWEEP, action: 'stop' } }),
    );
    f.scheduler.start();
    const applied = await requestConfigApply(f.data, ['stallSweep'], { waitMs: 20000 });
    assert.equal(applied.status, 'applied', JSON.stringify(applied));
    assert.equal(executionOf(f.h).engine.policy.stallSweep?.action, 'stop');
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
