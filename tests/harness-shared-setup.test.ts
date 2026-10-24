// M01: файловая часть setup — общая операция установленного harness.
// Реальный пакет: отказ назначения приходит HarnessError с кодом и путём
// конфликта, которых собственный алгоритм DevContour не выдавал. Граница:
// шпион поверх настоящих функций (отдельный процесс с module mocks) — ответ
// плана и применения используется, отказ не включает локальный fallback.
// AC08: одна сессия WorkspaceAgent до и после setup читает актуальное хранилище.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HarnessError } from 'devcontour-harness';
import { setupProject } from '../src/runner/setup.ts';
import { chooseWorkspaceMode } from '../src/runner/workspace-mode.ts';
import { preparationStore } from '../src/runner/start.ts';
import { Preparation } from '../src/core/preparation.ts';
import { WorkspaceAgent } from '../src/application/preparation-agent.ts';
import { loadConfig } from '../src/runner/config.ts';
import { approvePreparation } from './preparation-fixture.ts';

async function temp() {
  return realpath(await mkdtemp(join(tmpdir(), 'devcontour-shared-setup-')));
}
async function product(dir: string) {
  await mkdir(join(dir, 'docs'), { recursive: true });
  await writeFile(join(dir, 'docs/spec.md'), '# Каталог\nПоиск товаров.');
  return dir;
}
// Отдельный процесс с module mocks: общий запуск suite этот флаг не передаёт.
// NODE_TEST_CONTEXT убирается, иначе вложенный runner отчитывается родителю, а не в stdout.
function spyRun(fixture: string) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(
    process.execPath,
    [
      '--experimental-test-module-mocks',
      '--disable-warning=ExperimentalWarning',
      '--import',
      'tsx',
      '--test',
      '--test-reporter=spec',
      fixture,
    ],
    { cwd: resolve('.'), env, encoding: 'utf8', timeout: 240_000 },
  );
}
const conflictOf = async (run: Promise<unknown>) => {
  try {
    await run;
  } catch (error) {
    return error;
  }
  assert.fail('setup должен отказать');
};

test('M01 реальный пакет: отказы назначения — HarnessError PATH_CONFLICT с путём конфликта', async () => {
  const root = await temp();
  try {
    const repo = await product(join(root, 'shop'));
    // Symlink-предок назначения: путь конфликта — сам symlink.
    await symlink(join(root), join(repo, '.agents'));
    const linked = await conflictOf(setupProject({ repository: repo, profile: 'go-api' }));
    assert.ok(linked instanceof HarnessError, 'класс ошибки установленного пакета');
    assert.equal(linked.code, 'PATH_CONFLICT');
    assert.equal(linked.message, `Setup не пишет через symlink: ${join(repo, '.agents')}`);
    assert.deepEqual(linked.issues, [{ path: [join(repo, '.agents')], message: 'symlink' }]);
    await rm(join(repo, '.agents'));
    // Предок-файл: прежний алгоритм выпускал сырой ENOTDIR из lstat.
    await writeFile(join(repo, 'contracts'), 'not a directory');
    const file = await conflictOf(setupProject({ repository: repo, profile: 'go-api' }));
    assert.ok(file instanceof HarnessError);
    assert.equal(file.code, 'PATH_CONFLICT');
    assert.equal(file.message, `Родитель не является каталогом: ${join(repo, 'contracts')}`);
    assert.deepEqual(file.issues, [
      { path: [join(repo, 'contracts')], message: 'ancestor-not-directory' },
    ]);
    await rm(join(repo, 'contracts'));
    // Workspace через symlink — проверка назначения общей операцией.
    await mkdir(join(root, 'real-ws'));
    await symlink(join(root, 'real-ws'), join(root, 'ws-link'));
    const ws = await conflictOf(
      setupProject({ repository: repo, profile: 'go-api', workspace: join(root, 'ws-link') }),
    );
    assert.ok(ws instanceof HarnessError);
    assert.equal(ws.code, 'PATH_CONFLICT');
    assert.equal(ws.message, `Setup не пишет через symlink: ${join(root, 'ws-link')}`);
    // Ни один отказ не оставил файлов.
    assert.deepEqual(readdirSync(repo).sort(), ['docs']);
    assert.deepEqual(readdirSync(join(root, 'real-ws')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M01 граница: setup использует ответ плана и применения harness, отказ не уходит в fallback', () => {
  const result = spyRun('tests/fixtures/shared-boundary/setup-boundary.spy.ts');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^ℹ pass 4$/m);
  assert.match(result.stdout, /^ℹ fail 0$/m);
});

test('M01 AC02: в setup.ts нет прежнего файлового алгоритма — только вызовы общей операции', () => {
  const code = readFileSync('src/runner/setup.ts', 'utf8');
  for (const pattern of [
    /function (inspect|checkDestination|templateFiles)\b/,
    /\blstat\(|\breaddir\(|\bmkdir\(/,
    /flag: 'wx'|EEXIST|isSymbolicLink|isDirectory\(\)|isFile\(\)/,
    /from 'node:fs\/promises'[^;]*\b(lstat|readdir|mkdir)\b/,
  ])
    assert.doesNotMatch(code, pattern, String(pattern));
  for (const used of [
    'planFileWrites(',
    'applyFileWrites(',
    'listRegularFiles(',
    'checkDestination(',
  ])
    assert.ok(code.includes(used), used);
  assert.match(code, /from 'devcontour-harness';/);
});

test('AC08: одна сессия WorkspaceAgent до и после setup читает актуальное хранилище; повтор не создаёт другую БД', async () => {
  const root = await temp();
  try {
    for (const layout of ['separate', 'embedded'] as const) {
      const repo = await product(join(root, layout + '-shop'));
      const workspace = layout === 'embedded' ? repo : join(root, layout + '-ws');
      await mkdir(join(workspace, '.devcontour-local'), { recursive: true });
      chooseWorkspaceMode(workspace, layout);
      const data = join(workspace, '.devcontour-local');
      const early = preparationStore(data);
      try {
        approvePreparation(new Preparation(early));
      } finally {
        early.close();
      }
      const session = new WorkspaceAgent(data);
      const before = session.execute({ operation: 'preparation_status' });
      assert.equal(before.enabled, true);
      // До setup техническая конфигурация ещё не подключена.
      assert.throws(() => session.execute({ operation: 'project_context' }), /не подключена/);
      const result = await setupProject({ repository: repo, profile: 'go-api', workspace });
      const config = loadConfig(join(data, 'config.json'));
      assert.equal(config.workspaceMode, layout);
      assert.equal(config.storage, layout === 'embedded' ? 'central' : 'component');
      assert.equal(config.workspaceRoot, workspace);
      assert.equal(config.repository, repo);
      assert.equal(result.data, data);
      // Та же сессия после setup: подключённая конфигурация и прежняя подготовка.
      const context = session.execute({ operation: 'project_context' });
      assert.ok(Array.isArray(context.operations));
      assert.equal(session.execute({ operation: 'preparation_status' }).enabled, true);
      assert.deepEqual(
        session.execute({ operation: 'preparation_status' }).current,
        before.current,
        'та же история подготовки',
      );
      const databases = () =>
        readdirSync(root, { recursive: true })
          .map(String)
          .filter((p) => p.endsWith('.sqlite'))
          .sort();
      const dbs = databases();
      assert.deepEqual(
        (await setupProject({ repository: repo, profile: 'go-api', workspace })).created,
        [],
      );
      assert.deepEqual(databases(), dbs, 'повтор не создаёт другую БД');
      // Новая сессия тоже работает.
      const fresh = new WorkspaceAgent(data);
      assert.ok(Array.isArray(fresh.execute({ operation: 'project_context' }).operations));
    }
    // Отрицательный embedded+чужой корень: прежний отказ, второго хранилища нет.
    const single = await product(join(root, 'single'));
    chooseWorkspaceMode(single, 'embedded');
    const other = await product(join(root, 'other'));
    await assert.rejects(
      setupProject({ repository: other, profile: 'go-api', workspace: single }),
      /^Error: Embedded workspace должен совпадать с корнем репозитория$/,
    );
    assert.equal(existsSync(join(other, '.devcontour-local')), false);
    assert.equal(existsSync(join(single, '.devcontour-local/config.json')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
