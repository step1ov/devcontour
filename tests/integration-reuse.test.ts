// Перенос evidence кандидата на интеграцию (`integrationReuse: 'identical-tree'`
// политики harness) в DevContour: поле компонента, объявленная поддержка
// хоста, хранение записей `reusedEvidence`, деревья получателя и показ.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Engine,
  HarnessError,
  executionDigest,
  resultProblems,
  runResult,
  runResultSchema,
} from 'devcontour-harness';
import { config, input } from './helpers.ts';
import { demoPool, testDemo } from './demo-pool.ts';
import { configSchema, type Config } from '../src/core/model.ts';
import { DevContour, loadedDigest } from '../src/core/service.ts';
import { DevContourExecutionStore } from '../src/harness/store.ts';
import {
  devcontourHost,
  devcontourResultSink,
  projectionOptions,
  receiverContext,
  receiverTrees,
} from '../src/harness/host.ts';
import { approvalPolicyDigest, policyFromConfig } from '../src/harness/policy.ts';
import { validateWorkflow } from '../src/core/workflow.ts';
import { Store } from '../src/core/store.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { updateBase } from '../src/runner/base-update.ts';
import { git } from '../src/runner/process.ts';
import { adapters, type AgentRequest } from '../src/runner/adapters.ts';
import { panelRun, panelSummary } from '../src/application/panel.ts';
import { completion, validateReceipt } from '../src/core/sync-state.ts';
import { assertReusedTrees } from '../src/runner/git-sync.ts';
import { receiptSchema } from '../src/core/sync-model.ts';
import { receiptContext, receiptResult } from '../src/harness/receipt.ts';

const unit = {
  id: 'unit',
  kind: 'test' as const,
  command: ['node', 'unit.mjs'],
  timeoutMs: 120000,
  report: { type: 'junit' as const, path: '.reports/unit.xml' },
};
const roles = { admin: { runtime: 'demo' as const, writePaths: ['apps/admin/'] } };
const component = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: 'Component ' + id,
  path: '/nonexistent/devcontour-reuse/' + id,
  gates: [unit],
  ...extra,
});
const withComponents = (...repositories: ReturnType<typeof component>[]): Config =>
  config({ roles, gates: [unit], repositories: repositories as never });

test('integrationReuse workspace — поле политики только когда задано; digest без поля прежний (закреплён на 0.4.0-alpha.46)', () => {
  const pinned = (extra: Record<string, unknown> = {}) =>
    configSchema.parse({
      ...extra,
      version: 1,
      name: 'Pinned',
      repository: '/nonexistent/devcontour-pin/repo',
      checkoutRoot: '/nonexistent/devcontour-pin/checkouts',
      mode: 'demo',
      roles,
      reviewer: { runtime: 'demo' },
      gates: [unit],
      repositories: [
        {
          id: 'main',
          name: 'Monorepo',
          path: '/nonexistent/devcontour-pin/repo',
          gates: [unit],
        },
      ],
    });
  const plain = pinned();
  assert.equal('integrationReuse' in plain, false);
  assert.equal('integrationReuse' in policyFromConfig(plain), false);
  // Те же значения, что до поля (0.4.0-alpha.46, без integrationReuse).
  assert.equal(
    approvalPolicyDigest(plain),
    '74f3dbe6a290bd94d9a2ca43e91a61f6fd29cb9a24785e6b6646e0497aba8a2b',
  );
  assert.equal(
    executionDigest(policyFromConfig(plain)),
    '7daa68be47a250c40fe61c272a581e79c041f6b1a53dd2e2bfd6fd09e6d72bf2',
  );
  const reusing = pinned({ integrationReuse: 'identical-tree' });
  assert.equal(policyFromConfig(reusing).integrationReuse, 'identical-tree');
  assert.notEqual(
    executionDigest(policyFromConfig(reusing)),
    executionDigest(policyFromConfig(plain)),
  );
  // Прежняя форма конфигурации (без repositories) — поле верхнего уровня.
  const legacy = config({ integrationReuse: 'identical-tree' });
  assert.equal(policyFromConfig(legacy).integrationReuse, 'identical-tree');
  assert.throws(
    () => configSchema.parse({ ...plain, integrationReuse: 'always' }),
    /integrationReuse/,
  );
});

test('integrationReuse — поле workspace: с компонентами и без; поле в записи компонента политику не меняет', () => {
  const two = {
    ...withComponents(component('main'), component('lib')),
    integrationReuse: 'identical-tree' as const,
  };
  validateWorkflow(two);
  assert.equal(policyFromConfig(two).integrationReuse, 'identical-tree');
  const inComponent = withComponents(component('main', { integrationReuse: 'identical-tree' }));
  assert.equal('integrationReuse' in policyFromConfig(inComponent), false);
});

test('Хост DevContour объявляет integrationReuse: движок с такой политикой создаётся; хост без объявления — INVALID_INPUT', () => {
  const c = { ...withComponents(component('main')), integrationReuse: 'identical-tree' as const };
  const store = new Store(':memory:');
  try {
    const h = new DevContour(store, c);
    const execution = new DevContourExecutionStore(h.store, projectionOptions(h));
    const host = devcontourHost(h, execution);
    assert.deepEqual(host.capabilities, { integrationReuse: true });
    const policy = policyFromConfig(c);
    new Engine({ host, policy, policyIdentity: loadedDigest(c) });
    assert.throws(
      () =>
        new Engine({
          host: { ...host, capabilities: undefined },
          policy,
          policyIdentity: loadedDigest(c),
        }),
      (e: unknown) => e instanceof HarnessError && e.code === 'INVALID_INPUT',
    );
  } finally {
    store.close();
  }
});

type PanelView = {
  runs: { id: string; evidence: { gate: string; phase: string; reused?: true }[] }[];
  progress: { gates: { gate: string; passed: number; reused?: number }[] };
};
const view = (f: { h: DevContour; root: string }) =>
  panelSummary(f.h, f.root, {}) as unknown as PanelView;

const demos = demoPool(testDemo);
after(() => demos.close());

const CHECK = `import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('.reports', { recursive: true });
writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite><testcase name="unit-ok"></testcase></testsuite>');
`;

/**
 * Реальный Git: компонент с gate `unit` в файле компонента, задача роли admin
 * правит данные. `reuse` — `integrationReuse` в config.json workspace.
 */
async function reuseFixture(reuse: boolean) {
  const seed = await demos.acquire();
  const { root } = seed;
  const configPath = join(root, 'config.json');
  const demo = loadConfig(configPath);
  const repo = demo.repository;
  await mkdir(join(repo, 'apps/admin'), { recursive: true });
  await writeFile(join(repo, 'apps/admin/data.txt'), 'alpha\n');
  await writeFile(join(repo, 'unit.mjs'), CHECK);
  const gates = [{ ...unit, command: [process.execPath, 'unit.mjs'], timeoutMs: 60_000 }];
  await writeFile(
    join(repo, 'devcontour.component.json'),
    JSON.stringify(
      {
        name: demo.name,
        targetBranch: demo.targetBranch,
        gates,
        protectedPaths: [...demo.protectedPaths, 'unit.mjs'],
      },
      null,
      2,
    ),
  );
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'Data, check and component file');
  await git(repo, 'update-ref', 'refs/heads/' + demo.targetBranch, 'HEAD');
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  await writeFile(
    configPath,
    JSON.stringify(
      {
        ...raw,
        roles,
        gates,
        repositories: [{ id: 'main', path: repo, configFile: 'devcontour.component.json' }],
        // Поле workspace — верхний уровень config.json, как runTimeoutMs.
        ...(reuse ? { integrationReuse: 'identical-tree' } : {}),
      },
      null,
      2,
    ),
  );
  const c = loadConfig(configPath);
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, c);
  store.change('fixture.reset', (s) => {
    s.tasks = [];
    s.boards = [];
    s.runs = [];
  });
  const board = h.createBoard('Reuse release');
  const task = h.addTask(board.id, {
    ...input('Edit admin data'),
    role: 'admin',
    repositoryId: 'main',
    writePaths: ['apps/admin/'],
    gates: ['unit'],
  });
  h.approve(board.id);
  const runtimes = {
    ...adapters,
    demo: {
      name: 'demo' as const,
      async execute(r: AgentRequest) {
        if (r.review)
          return {
            data: { approved: true, summary: 'Looks fine', findings: [] },
            log: 'fixture',
            command: ['fixture'],
          };
        await writeFile(join(r.cwd, 'apps/admin/data.txt'), 'alpha\nbeta\n');
        return {
          data: { completed: true, summary: 'Added beta' },
          log: 'fixture',
          command: ['fixture'],
        };
      },
    },
  };
  const scheduler = new Scheduler(h, root, runtimes);
  await scheduler.init();
  await updateBase(c, root);
  h.pause(false);
  await scheduler.drain();
  await scheduler.stop();
  const done = store.read().tasks.find((t) => t.id === task.id)!;
  assert.equal(done.status, 'done', JSON.stringify([done.status, done.failure]));
  const run = store.read().runs.findLast((r) => r.taskId === task.id)!;
  const execution = new DevContourExecutionStore(h.store, projectionOptions(h));
  const engine = new Engine({
    host: devcontourHost(h, execution),
    policy: policyFromConfig(c),
    policyIdentity: loadedDigest(c),
  });
  const result = runResultSchema.parse(
    JSON.parse(
      JSON.stringify(
        runResult(
          engine.read((v) => v.attempt(run.id)!),
          engine.version,
        ),
      ),
    ),
  );
  return {
    h,
    store,
    execution,
    run,
    result,
    repo,
    root,
    cleanup: () => {
      store.close();
      seed.release();
    },
  };
}

test('Реальный Git: integrationReuse при неподвижном target — gate интеграции взят из кандидата, получатель DevContour принимает результат', async () => {
  const f = await reuseFixture(true);
  try {
    const integration = f.run.evidence.filter(
      (e) => e.kind === 'test' && e.phase === 'integration' && e.gate === 'unit',
    );
    assert.equal(integration.length, 1, JSON.stringify(integration));
    const reused = integration[0];
    const candidate = f.run.evidence.findLast(
      (e) => e.kind === 'test' && e.phase === 'candidate' && e.gate === 'unit',
    )!;
    // Запись хранится в состоянии DevContour с полной ссылкой.
    assert.equal(reused.passed, true);
    assert.equal(reused.sha, f.run.integrationSha);
    assert.deepEqual(reused.reusedEvidence, {
      evidenceId: candidate.id,
      phase: 'candidate',
      sha: f.run.candidateSha,
      tree: await git(f.repo, 'rev-parse', `${f.run.candidateSha}^{tree}`),
    });
    // Gate на интеграции не исполнялся: стадии запуска нет.
    const stages = (f.run.timings ?? []).map((t) => t.stage);
    assert.ok(stages.includes('candidate-test:unit'), stages.join(', '));
    assert.equal(stages.includes('integration-test:unit'), false, stages.join(', '));
    // Событие попытки несёт ID записи кандидата (`attempt.gate.reusedFrom`).
    type GateEvent = { type: string; payload: { phase?: string; reusedFrom?: string } };
    const gateEvents = f.store
      .events()
      .flatMap((e) => (e.data as { harnessEvents?: GateEvent[] } | null)?.harnessEvents ?? [])
      .filter((e) => e.type === 'attempt.gate')
      .map((e) => e.payload);
    assert.ok(
      gateEvents.some((e) => e.phase === 'integration' && e.reusedFrom === candidate.id),
      JSON.stringify(gateEvents),
    );
    // Получатель DevContour: деревья своего Git, политика с integrationReuse.
    const sink = devcontourResultSink(f.h, f.execution);
    assert.equal((await sink.deliver({ key: 'k1', result: f.result })).status, 'delivered');
    // Панель: запись взята из кандидата и не считается запуском gate.
    const line = view(f).runs.find((r) => r.id === f.run.id)!;
    assert.equal(
      line.evidence.find((e) => e.phase === 'integration' && e.gate === 'unit')?.reused,
      true,
    );
    const row = view(f).progress.gates.find((g) => g.gate === 'unit')!;
    assert.equal(row.reused, 1);
    assert.equal(row.passed, 1, 'исполнен только gate кандидата');
    const detail = panelRun(f.h, f.run.id);
    assert.ok(
      detail.evidence.some(
        (e) =>
          (e as { reusedEvidence?: { evidenceId: string } }).reusedEvidence?.evidenceId ===
          candidate.id,
      ),
    );
  } finally {
    f.cleanup();
  }
});

test('Получатель отклоняет запись, взятую из кандидата, без деревьев, при несовпавших деревьях и под политикой без integrationReuse', async () => {
  const f = await reuseFixture(true);
  try {
    const context = await receiverContext(f.h, f.execution, f.result.workOrderId);
    const trees = (await receiverTrees(f.h, f.result))!;
    assert.ok(trees && trees.candidate === trees.result, JSON.stringify(trees));
    assert.deepEqual(resultProblems(f.result, { ...context, trees }), []);
    const reject = (problems: string[]) =>
      assert.ok(
        problems.some((p) => /кандидат|дерев/i.test(p)),
        JSON.stringify(problems),
      );
    reject(resultProblems(f.result, context));
    reject(resultProblems(f.result, { ...context, trees: { ...trees, result: 'f'.repeat(40) } }));
    const without = { ...context.policy };
    delete without.integrationReuse;
    reject(resultProblems(f.result, { ...context, policy: without, trees }));
    // Подменённое дерево записи: деревья получателя ему не равны.
    const forged = structuredClone(f.result);
    for (const e of forged.evidence)
      if (e.reusedEvidence) e.reusedEvidence = { ...e.reusedEvidence, tree: 'e'.repeat(40) };
    reject(resultProblems(forged, { ...context, trees: (await receiverTrees(f.h, forged))! }));
    const sink = devcontourResultSink(f.h, f.execution);
    await assert.rejects(
      sink.deliver({ key: 'k2', result: forged }),
      (e: unknown) => e instanceof HarnessError && e.code === 'INVALID_INPUT',
    );
  } finally {
    f.cleanup();
  }
});

test('Реальный Git: без integrationReuse gate интеграции исполняется, записей reusedEvidence нет', async () => {
  const f = await reuseFixture(false);
  try {
    assert.equal('integrationReuse' in policyFromConfig(f.h.config), false);
    assert.equal(
      f.run.evidence.some((e) => e.reusedEvidence),
      false,
    );
    const stages = (f.run.timings ?? []).map((t) => t.stage);
    assert.ok(stages.includes('integration-test:unit'), stages.join(', '));
    assert.equal(await receiverTrees(f.h, f.result), undefined, 'Git получателя не вызывается');
    const sink = devcontourResultSink(f.h, f.execution);
    assert.equal((await sink.deliver({ key: 'k1', result: f.result })).status, 'delivered');
    const row = view(f).progress.gates.find((g) => g.gate === 'unit')!;
    assert.equal(row.passed, 2);
    assert.equal('reused' in row, false);
  } finally {
    f.cleanup();
  }
});

test('Receipt Git sync переносит отметку «взято из кандидата» сведением: получатель сверяет дерево result SHA, harness её не видит', async () => {
  const f = await reuseFixture(true);
  try {
    const s = f.store.read();
    const task = s.tasks.find((t) => t.id === f.run.taskId)!;
    const receipt = receiptSchema.parse(completion(f.h, s, task));
    const tree = await git(f.repo, 'rev-parse', `${task.resultSha}^{tree}`);
    const marked = receipt.checks.filter((c) => c.reused);
    assert.equal(marked.length, 1, JSON.stringify(receipt.checks));
    assert.equal(marked[0].kind, 'test');
    assert.equal(marked[0].phase, 'integration');
    assert.deepEqual(marked[0].reused, { sha: f.run.candidateSha, tree });
    // Получатель harness отметку не получает: запись — обычная проверка.
    const context = receiptContext(f.h, task, s.contracts, () => undefined, {});
    assert.equal(
      receiptResult(receipt, context).evidence.some((e) => e.reusedEvidence),
      false,
    );
    validateReceipt(f.h, receipt, task, s.contracts);
    // Подменённое дерево или SHA кандидата — несогласованный receipt.
    const forge = (reused: { sha: string; tree: string }) => ({
      ...receipt,
      checks: receipt.checks.map((c) => (c.reused ? { ...c, reused } : c)),
    });
    // Дерево сверяет синхронизация Git этого клона.
    assertReusedTrees(f.repo, receipt);
    assert.throws(
      () => assertReusedTrees(f.repo, forge({ sha: f.run.candidateSha!, tree: 'e'.repeat(40) })),
      /дерево reused/,
    );
    assert.throws(
      () => validateReceipt(f.h, forge({ sha: 'd'.repeat(40), tree }), task, s.contracts),
      /отметка reused/,
    );
    // Отметка у чужой записи (кандидат) схемой не принимается.
    assert.throws(() =>
      receiptSchema.parse({
        ...receipt,
        checks: receipt.checks.map((c) =>
          c.phase === 'candidate' && c.kind === 'test' ? { ...c, reused: { sha: c.sha, tree } } : c,
        ),
      }),
    );
  } finally {
    f.cleanup();
  }
});

test('Receipt без integrationReuse отметки не несёт', async () => {
  const f = await reuseFixture(false);
  try {
    const s = f.store.read();
    const task = s.tasks.find((t) => t.id === f.run.taskId)!;
    assert.equal(
      completion(f.h, s, task).checks.some((c) => 'reused' in c),
      false,
    );
  } finally {
    f.cleanup();
  }
});
