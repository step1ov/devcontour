// Генераторы компонента (`repositories[].generators`, harness 0.1.0-alpha.49):
// конфигурация и её проверки, отказ постановки задачи по инструменту
// генератора, проекция в политику, производные записи в предложении ревью
// плана и сквозной сценарий на реальном Git. Модели не вызываются.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { executionDigest } from 'devcontour-harness';
import { closePrevious, config, fixture, input } from './helpers.ts';
import { demoPool, testDemo } from './demo-pool.ts';
import { configSchema, repositorySchema, type Config } from '../src/core/model.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { validateTaskContext, validateWorkflow } from '../src/core/workflow.ts';
import { approvalPolicyDigest, policyFromConfig } from '../src/harness/policy.ts';
import { reviewPlan } from '../src/runner/agent-control.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { updateBase } from '../src/runner/base-update.ts';
import { git } from '../src/runner/process.ts';
import { adapters, type AgentAdapter, type AgentRequest } from '../src/runner/adapters.ts';

const DATA = 'apps/admin/data/catalog.json';
const OUTPUT = 'apps/mobile/src/generated/catalog.ts';
const TOOL = 'apps/mobile/scripts/gen-catalog.mjs';
const unit = {
  id: 'unit',
  kind: 'test' as const,
  command: ['node', 'unit.mjs'],
  timeoutMs: 120000,
  report: { type: 'junit' as const, path: '.reports/unit.xml' },
};
const catalog = {
  id: 'catalog',
  command: ['node', TOOL],
  inputs: [DATA],
  outputs: [OUTPUT],
  tool: [TOOL],
};
const roles = {
  admin: { runtime: 'demo' as const, writePaths: ['apps/admin/'] },
  mobile: { runtime: 'demo' as const, writePaths: ['apps/mobile/'] },
};
const component = (extra: Record<string, unknown> = {}) => ({
  id: 'main',
  name: 'Monorepo',
  path: '/nonexistent/devcontour-generators/repo',
  gates: [unit],
  ...extra,
});
const withComponent = (extra: Record<string, unknown> = {}, overrides: Partial<Config> = {}) =>
  config({ roles, gates: [unit], repositories: [component(extra)] as never, ...overrides });

test('Конфигурация сохраняет generators компонента и проецирует их в политику; без поля ключа нет', () => {
  const c = withComponent({ generators: [catalog] });
  assert.deepEqual(c.repositories[0].generators, [{ ...catalog, timeoutMs: 120000 }]);
  validateWorkflow(c);
  assert.deepEqual(policyFromConfig(c).repositories[0].generators, [
    { ...catalog, timeoutMs: 120000 },
  ]);
  const plain = withComponent();
  assert.equal('generators' in plain.repositories[0], false);
  assert.equal('generators' in policyFromConfig(plain).repositories[0], false);
  // Ревью плана исполнение не запускает: генераторы в политику ревью не входят.
  assert.equal('generators' in policyFromConfig(c, { purpose: 'review' }).repositories[0], false);
  assert.throws(() => withComponent({ generators: [{ ...catalog, id: 'bad id' }] }));
  assert.throws(() =>
    withComponent({
      generators: Array.from({ length: 11 }, (_, i) => ({
        ...catalog,
        id: 'g' + i,
        outputs: ['out/' + i],
      })),
    }),
  );
  assert.throws(() => withComponent({ generators: [{ ...catalog, inputs: [] }] }));
});

test('Проверка конфигурации: повтор ID, пересечение выходов с входами, инструментом, защищёнными путями, файлом компонента и данными контура', () => {
  const refuses = (generators: unknown[], pattern: RegExp, extra: Record<string, unknown> = {}) =>
    assert.throws(
      () => validateWorkflow(withComponent({ generators, ...extra })),
      (e: Error) => {
        assert.match(e.message, /Компонент main/);
        assert.match(e.message, pattern);
        return true;
      },
    );
  refuses([catalog, { ...catalog, outputs: ['apps/mobile/src/other.ts'] }], /Повтор генератора/);
  refuses(
    [catalog, { ...catalog, id: 'second', outputs: ['apps/mobile/src/generated/'] }],
    /Выходы генераторов/,
  );
  refuses([{ ...catalog, outputs: [DATA] }], /пересекает вход/);
  refuses([{ ...catalog, outputs: ['apps/mobile/scripts/'] }], /пересекает инструмент/);
  refuses([{ ...catalog, outputs: ['package.json'] }], /защищённый путь/);
  refuses([{ ...catalog, outputs: ['.devcontour/catalog.ts'] }], /служебный каталог/);
  refuses([{ ...catalog, outputs: ['.devcontour-local/catalog.ts'] }], /\.devcontour-local/);
  refuses([{ ...catalog, outputs: ['devcontour.component.json'] }], /файл компонента/, {
    configFile: 'devcontour.component.json',
  });
  // Регистр путей не обходит проверку: файловая система macOS его не различает.
  refuses([{ ...catalog, outputs: ['Apps/Admin/Data/catalog.json'] }], /пересекает вход/);
  // Выход внутри generatedPaths допустим: исполнитель его не правит, а генератор пишет.
  validateWorkflow(
    withComponent({ generators: [catalog], generatedPaths: ['apps/mobile/src/generated/'] }),
  );
});

test('Постановка: задача, чья область записи задевает инструмент генератора с выходами вне её роли, отклоняется; владелец выходов правит инструмент', () => {
  const shared = { ...catalog, tool: ['scripts/gen-catalog.mjs'] };
  const c = withComponent(
    { generators: [shared] },
    {
      roles: {
        admin: { runtime: 'demo', writePaths: ['apps/admin/', 'scripts/'] },
        mobile: { runtime: 'demo', writePaths: ['apps/mobile/', 'scripts/'] },
        lead: { runtime: 'demo' },
      },
    },
  );
  const task = (role: string, writePaths?: string[]) =>
    ({
      ...input('Catalog'),
      role,
      repositoryId: 'main',
      ...(writePaths ? { writePaths } : {}),
    }) as Parameters<typeof validateTaskContext>[1];
  assert.throws(
    () => validateTaskContext(c, task('admin', ['scripts/'])),
    /инструмент генератора catalog .*вне области записи роли admin/s,
  );
  // Без своей области записи задача пишет всю область роли — и инструмент тоже.
  assert.throws(() => validateTaskContext(c, task('admin')), /генератора catalog/);
  // Правка данных — вход генератора: выход перестроит controller, отказа нет.
  validateTaskContext(c, task('admin', ['apps/admin/data/']));
  // Владелец выходов правит инструмент — выходы в его области.
  validateTaskContext(c, task('mobile', ['scripts/']));
  // Роль без области пишет весь репозиторий: выходы в её области.
  validateTaskContext(c, task('lead'));
  // История (импорт sync) не перепроверяется по генераторам, объявленным позже.
  validateTaskContext(c, task('admin', ['scripts/']), { history: true });
});

/** Fixture-ревьюер плана: одобряет и сохраняет предложение. */
function planReviewer(seen: unknown[]): Record<'codex' | 'claude', AgentAdapter> {
  const make = (name: 'codex' | 'claude'): AgentAdapter => ({
    name,
    execute(r) {
      seen.push(JSON.parse(readFileSync(join(r.artifactDir, 'proposal.json'), 'utf8')));
      return Promise.resolve({
        data: {
          approved: true,
          summary: 'Explicit test fixture',
          findings: [],
          previous: closePrevious(r.prompt),
        },
        log: 'Fixture only; no provider called',
        command: ['fixture'],
      });
    },
  });
  return { codex: make('codex'), claude: make('claude') };
}

test('Импорт плана: задача данных с общим test gate принимается, ревьюер плана видит производные записи генератора', async () => {
  const f = fixture();
  try {
    f.h.config = withComponent(
      { generators: [catalog] },
      { checkoutRoot: f.h.config.checkoutRoot, repository: f.h.config.repository },
    );
    f.h.config.mode = 'local';
    const { boardId } = f.h.importPlan({
      title: 'Catalog release',
      description: 'Новые позиции каталога',
      tasks: [
        {
          ...input('Catalog data'),
          role: 'admin',
          key: 'data',
          writePaths: ['apps/admin/data/'],
          gates: ['unit'],
          contracts: [],
        },
        {
          ...input('Mobile screen'),
          role: 'mobile',
          key: 'screen',
          writePaths: ['apps/mobile/src/screens/'],
          gates: ['unit'],
          contracts: [],
        },
      ],
    });
    const [data, screen] = f.store.read().tasks;
    const seen: { derivedWrites?: Record<string, unknown> }[] = [];
    await reviewPlan(f.h, f.root, boardId, 'claude', planReviewer(seen), () => {});
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].derivedWrites, {
      [data.id]: [{ generator: 'catalog', outputs: [OUTPUT] }],
    });
    assert.equal(screen.id in (seen[0].derivedWrites ?? {}), false);
  } finally {
    f.cleanup();
  }
});

test('Без generators digest согласования и исполнения компонента — прежние (закреплены на 0.4.0-alpha.44)', () => {
  const pinned = (extra: Record<string, unknown> = {}) =>
    configSchema.parse({
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
          generatedPaths: ['apps/mobile/src/generated/'],
          ...extra,
        },
      ],
    });
  assert.equal(
    approvalPolicyDigest(pinned()),
    'f6d0272d7f035c5c97ef924d34c05a1751bf4729e80408161c898079b1baaa13',
  );
  assert.equal(
    executionDigest(policyFromConfig(pinned())),
    'dfebf66c3ae7532eb4ab638f6c74ba3b81b2f3e09fc1f75e38619af90a1688d1',
  );
  // Генератор меняет исполнение — и согласование плана тоже.
  const generated = pinned({ generators: [catalog] });
  assert.notEqual(approvalPolicyDigest(generated), approvalPolicyDigest(pinned()));
  assert.notEqual(
    executionDigest(policyFromConfig(generated)),
    executionDigest(policyFromConfig(pinned())),
  );
});

const demos = demoPool(testDemo);
after(() => demos.close());

const GENERATOR = `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const data = JSON.parse(readFileSync('${DATA}', 'utf8'));
mkdirSync('apps/mobile/src/generated', { recursive: true });
writeFileSync('${OUTPUT}', 'export const catalog = ' + JSON.stringify(data) + ';\\n');
`;
const CHECK = `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const data = JSON.parse(readFileSync('${DATA}', 'utf8'));
assert.equal(readFileSync('${OUTPUT}', 'utf8'), 'export const catalog = ' + JSON.stringify(data) + ';\\n', 'generated catalog is stale');
mkdirSync('.reports', { recursive: true });
writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite><testcase name="catalog-in-sync"></testcase></testsuite>');
`;

test('Реальный Git: правка данных роли admin даёт коммит с перестроенным выходом в области mobile, общий gate зелёный', async () => {
  const seed = await demos.acquire();
  const { root } = seed;
  const loaded = loadConfig(join(root, 'config.json'));
  const repo = loaded.repository;
  // Процесс фиксирует происхождение конфигурации при создании; дальше тест
  // меняет загруженный объект, как conditional-gates.
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, loaded);
  await mkdir(join(repo, 'apps/admin/data'), { recursive: true });
  await mkdir(join(repo, 'apps/mobile/scripts'), { recursive: true });
  await writeFile(join(repo, DATA), JSON.stringify([{ id: 'a', title: 'Alpha' }]) + '\n');
  await writeFile(join(repo, TOOL), GENERATOR);
  await writeFile(join(repo, 'unit.mjs'), CHECK);
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'Catalog data, generator and check');
  // Выход закоммичен в согласии с данными: базовый SHA зелёный.
  execNode(repo, TOOL);
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'Generated catalog');
  await git(repo, 'update-ref', 'refs/heads/' + loaded.targetBranch, 'HEAD');
  const c = loaded;
  const gates = [{ ...unit, command: [process.execPath, 'unit.mjs'], timeoutMs: 60_000 }];
  c.roles = roles;
  c.gates = gates;
  c.repositories = [
    repositorySchema.parse({
      id: 'main',
      name: loaded.name,
      path: repo,
      targetBranch: loaded.targetBranch,
      gates,
      protectedPaths: [...loaded.protectedPaths, 'unit.mjs'],
      generators: [{ ...catalog, command: [process.execPath, TOOL] }],
    }),
  ];
  validateWorkflow(c);
  try {
    store.change('fixture.reset', (s) => {
      s.tasks = [];
      s.boards = [];
      s.runs = [];
    });
    const board = h.createBoard('Catalog release');
    const task = h.addTask(board.id, {
      ...input('Add catalog item'),
      role: 'admin',
      repositoryId: 'main',
      writePaths: ['apps/admin/data/'],
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
          await writeFile(
            join(r.cwd, DATA),
            JSON.stringify([
              { id: 'a', title: 'Alpha' },
              { id: 'b', title: 'Beta' },
            ]) + '\n',
          );
          return {
            data: { completed: true, summary: 'Added Beta' },
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
    const output = await git(repo, 'show', `${done.resultSha}:${OUTPUT}`);
    assert.match(output, /"Beta"/, 'выход перестроен в коммите задачи');
    const changed = (await git(repo, 'diff', '--name-only', `${done.resultSha}~1`, done.resultSha!))
      .split('\n')
      .filter(Boolean)
      .sort();
    assert.deepEqual(changed, [DATA, OUTPUT].sort(), 'один коммит: данные и выход');
    const stages = store
      .read()
      .runs.filter((r) => r.taskId === task.id)
      .flatMap((r) => (r.timings ?? []).map((t) => t.stage));
    assert.ok(stages.includes('generate:catalog'), stages.join(', '));
    assert.ok(stages.includes('integration-generate:catalog'), stages.join(', '));
  } finally {
    store.close();
    seed.release();
  }
});

function execNode(cwd: string, script: string) {
  // Генератор в seed — тот же скрипт, что исполнит controller.
  execFileSync(process.execPath, [script], { cwd });
}
