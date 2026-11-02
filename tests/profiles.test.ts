import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
  symlink,
  access,
  chmod,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { profile, resolveProfile, profilePin } from '../src/runner/packs.ts';
import { setupProject } from '../src/runner/setup.ts';
import { setupWorkspace } from '../src/runner/workspace-setup.ts';
import { loadConfig } from '../src/runner/config.ts';
import { preparationStore } from '../src/runner/preparation-store.ts';
import { git, command } from '../src/runner/process.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { adapters, type AgentRequest } from '../src/runner/adapters.ts';
import { input } from './helpers.ts';

const testGate = {
  id: 'tests',
  kind: 'test',
  command: ['python3', 'verify.py'],
  report: { type: 'junit', path: '.reports/tests.xml' },
};
async function json(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'devcontour-profiles-')));
  const repo = join(root, 'product');
  await mkdir(join(repo, 'docs'), { recursive: true });
  await mkdir(join(repo, 'profiles'));
  await writeFile(join(repo, 'docs/spec.md'), '# A tested Python service');
  await json(join(repo, 'profiles/stack.json'), {
    id: 'stack',
    version: '1.2.0',
    capabilities: ['python'],
    protectedPaths: ['verify.py'],
  });
  await json(join(repo, 'profiles/tests.json'), {
    id: 'checks',
    version: '2.0.0',
    gates: [testGate],
  });
  await json(join(repo, 'profiles/env.json'), {
    id: 'env',
    version: '1.0.0',
    environment: { values: { PROJECT_MARKER: 'product' } },
  });
  await json(join(repo, 'profiles/main.json'), {
    id: 'custom-api',
    version: '1.0.0',
    extends: ['./stack.json', './tests.json', './env.json'],
  });
  return { root, repo, close: () => rm(root, { recursive: true, force: true }) };
}

test('Local profiles compose stack/checks/environment read-only and keep legacy builtin pins', async () => {
  const f = await fixture();
  try {
    const selected = await profile('./profiles/main.json', f.repo);
    assert.equal(selected.environment!.values.PROJECT_MARKER, 'product');
    assert.deepEqual(
      selected.gates.map((g) => g.id),
      ['tests'],
    );
    assert.equal(selected.closure.length, 4);
    assert.equal(selected.source!.path, 'profiles/main.json');
    assert.ok(selected.protectedPaths.includes('profiles/tests.json'));
    assert.ok(selected.protectedPaths.includes('verify.py'));
    assert.equal(selected.digest, resolveProfile('./profiles/main.json', f.repo).digest);
    await assert.rejects(access(join(f.repo, '.reports')));
    const builtin = await profile('go-api');
    assert.equal(
      builtin.digest,
      createHash('sha256')
        .update(await readFile('packs/profiles/go-api.json'))
        .digest('hex'),
    );
    const shown = await command(
      [
        process.execPath,
        '--import',
        'tsx',
        'src/cli.ts',
        'profile-show',
        '--repository',
        f.repo,
        '--profile',
        './profiles/main.json',
      ],
      process.cwd(),
    );
    assert.equal(shown.code, 0, shown.stderr);
    assert.deepEqual(JSON.parse(shown.stdout).pin, profilePin(selected));
    await assert.rejects(access(join(f.repo, '.devcontour-local')));
    const expo = await profile('expo-mobile');
    assert.ok(expo.gates.some((g) => g.id === 'unit-tests'));
    assert.ok(expo.gates.some((g) => g.id === 'build-and-install'));
    assert.ok(expo.gates.some((g) => g.id === 'mobile-acceptance'));
    assert.equal(expo.concurrency, 1);
  } finally {
    await f.close();
  }
});

test('Profile resolution rejects escaping paths, symlinks, cycles, ambiguous composition and missing proof', async () => {
  const f = await fixture();
  const file = join(f.repo, 'profiles/bad.json');
  const invalid = async (extra: object, pattern: RegExp) => {
    await json(file, { id: 'bad', version: '1.0.0', ...extra });
    await assert.rejects(profile('./profiles/bad.json', f.repo), pattern);
  };
  try {
    await assert.rejects(profile('../outside.json', f.repo), /внутри/);
    await assert.rejects(profile('/tmp/outside.json', f.repo), /относительный/);
    await assert.rejects(profile('https://example.invalid/profile.json', f.repo), /относительный/);
    await symlink(join(f.repo, 'profiles/tests.json'), join(f.repo, 'profiles/link.json'));
    await assert.rejects(profile('./profiles/link.json', f.repo), /symlink/);
    await invalid({ extends: ['./bad.json'] }, /Цикл/);
    await invalid({ gates: [{ ...testGate, kind: 'check', report: undefined }] }, /JUnit/);
    await invalid({ gates: [{ ...testGate, report: undefined }] }, /JUnit/);
    await invalid(
      { gates: [{ ...testGate, report: { type: 'junit', path: '../out.xml' } }] },
      // Текст отказа — resolver harness (K10); прежде — ZodError relativePath.
      /Путь JUnit gate tests/,
    );
    await invalid({ gates: [{ ...testGate, dependsOn: ['unknown'] }] }, /Неизвестная/);
    await invalid({ extends: ['./tests.json'], gates: [testGate] }, /Повтор gate tests/);
    await invalid(
      { extends: ['./main.json'], environment: { values: { PROJECT_MARKER: 'override' } } },
      /Конфликт/,
    );
    await invalid({ extends: ['./tests.json'], approvalMode: 'agent' }, /Unrecognized/);
    await invalid({ extends: ['./tests.json'], concurrency: 5 }, /Too big/);
    await json(file, { id: 'diamond', version: '1.0.0', extends: ['./tests.json', './main.json'] });
    assert.equal((await profile('./profiles/bad.json', f.repo)).gates.length, 1);
    await writeFile(file, ' '.repeat(131073));
    await assert.rejects(profile('./profiles/bad.json', f.repo), /128 KiB/);
    await json(file, { id: 'no-test', version: '1.0.0' });
    await assert.rejects(
      setupProject({
        repository: f.repo,
        profile: './profiles/bad.json',
        workspace: join(f.root, 'control'),
      }),
      /JUnit/,
    );
    await assert.rejects(access(join(f.repo, 'AGENTS.md')));
  } finally {
    await f.close();
  }
});

test('Setup pins transitive local sources, preserves policy and never silently installs a changed profile', async () => {
  const f = await fixture();
  try {
    const options = {
      repository: f.repo,
      profile: './profiles/main.json',
      workspace: join(f.root, 'control'),
    };
    const first = await setupProject(options);
    const configPath = join(first.data, 'config.json');
    const c = loadConfig(configPath);
    assert.equal(c.packs[0].source!.repositoryId, 'main');
    assert.equal(c.environment, undefined);
    assert.equal(c.repositories[0].environment!.values.PROJECT_MARKER, 'product');
    assert.ok(c.repositories[0].protectedPaths.includes('profiles/tests.json'));
    const localFile = join(f.repo, 'devcontour.component.json');
    const local = JSON.parse(await readFile(localFile, 'utf8'));
    local.gates[0].timeoutMs = 3210;
    await json(localFile, local);
    await setupProject(options);
    assert.equal(loadConfig(configPath).repositories[0].gates[0].timeoutMs, 3210);
    await json(join(f.repo, 'profiles/tests.json'), {
      id: 'checks',
      version: '2.0.1',
      gates: [testGate],
    });
    // Правка вложенного профиля: чинится версией установленного, и отказ это говорит.
    const raise =
      /custom-api, версия 1\.0\.0 прежняя; поднимите version этого профиля .*workspace-init/;
    assert.throws(() => loadConfig(configPath), raise);
    await assert.rejects(setupProject(options), raise);
    assert.equal(JSON.parse(await readFile(localFile, 'utf8')).gates[0].timeoutMs, 3210);
  } finally {
    await f.close();
  }
});

test('Damaged lock keeps the generic refusal: raising the version would not explain it', async () => {
  const f = await fixture();
  try {
    const first = await setupProject({
      repository: f.repo,
      profile: './profiles/main.json',
      workspace: join(f.root, 'control'),
    });
    const lock = join(first.data, 'packs.lock.json');
    const pinned = JSON.parse(await readFile(lock, 'utf8')) as { packs: { version: string }[] };
    pinned.packs[0].version = '9.9.9';
    await json(lock, pinned);
    assert.throws(
      () => loadConfig(join(first.data, 'config.json')),
      /custom-api; проверьте обновление и lock-файл/,
    );
  } finally {
    await f.close();
  }
});

test('Independent component profiles with the same ID retain owner-local policies and pins survive Git clone', async () => {
  const f = await fixture();
  try {
    await git(f.repo, 'init', '-b', 'main');
    await git(f.repo, 'config', 'user.name', 'Profile fixture');
    await git(f.repo, 'config', 'user.email', 'fixture@example.invalid');
    await git(f.repo, 'add', '.');
    await git(f.repo, 'commit', '-m', 'Own profile');
    const library = join(f.root, 'library');
    await git(f.root, 'clone', '--no-local', f.repo, library);
    assert.equal(
      (await profile('./profiles/main.json', f.repo)).digest,
      (await profile('./profiles/main.json', library)).digest,
    );
    await json(join(library, 'profiles/env.json'), {
      id: 'env',
      version: '1.0.0',
      environment: { values: { PROJECT_MARKER: 'library' } },
    });
    const control = join(f.root, 'control');
    await mkdir(control);
    const registry = join(control, 'workspace.json');
    await json(registry, {
      version: 1,
      name: 'Mixed stacks',
      repositories: [
        { id: 'product', name: 'Product', path: f.repo, profile: './profiles/main.json' },
        {
          id: 'library',
          name: 'Library',
          path: library,
          kind: 'library',
          profile: './profiles/main.json',
        },
      ],
    });
    const result = await setupWorkspace(registry);
    const c = loadConfig(result.config);
    assert.equal(c.packs.length, 2);
    assert.equal(c.environment, undefined);
    assert.deepEqual(
      c.repositories.map((r) => r.environment!.values.PROJECT_MARKER),
      ['product', 'library'],
    );
    const central = await readFile(result.config, 'utf8');
    assert.ok(!central.includes('PROJECT_MARKER'));
    await json(join(library, 'profiles/env.json'), {
      id: 'env',
      version: '1.0.1',
      environment: { values: { PROJECT_MARKER: 'new' } },
    });
    const raise = /custom-api, версия 1\.0\.0 прежняя; поднимите version этого профиля/;
    assert.throws(() => loadConfig(result.config), raise);
    // Правка без смены версии остаётся отказом: пин защищает от тихой подмены.
    await assert.rejects(setupWorkspace(registry), raise);
    // Поднятая версия составного профиля — заявление «изменилось намеренно»,
    // и только она разрешает переписать lock. Правка вложенного профиля версию
    // составного не меняет, поэтому сама по себе установку не разрешает: автор
    // обязан объявить изменение там, где профиль установлен.
    await json(join(library, 'profiles/main.json'), {
      id: 'custom-api',
      version: '1.1.0',
      extends: ['./stack.json', './tests.json', './env.json'],
    });
    // Версия поднята: команды до обновления называют его, а не просят поднять снова.
    assert.throws(
      () => loadConfig(result.config),
      /custom-api, версия 1\.0\.0 → 1\.1\.0; примените обновление командой workspace-init/,
    );
    assert.equal((await setupWorkspace(registry)).status, 'profile-updated');
    assert.equal(
      loadConfig(result.config).repositories.find((r) => r.id === 'library')!.environment!.values
        .PROJECT_MARKER,
      'new',
    );
  } finally {
    await f.close();
  }
});

test('Custom Python gate fails a no-op writer, then verifies candidate and integration; profile sources remain protected', async () => {
  const f = await fixture();
  let store: Store | undefined, scheduler: Scheduler | undefined;
  try {
    const result = await setupProject({
      repository: f.repo,
      profile: './profiles/main.json',
      data: join(f.root, 'data'),
    });
    await writeFile(join(f.repo, 'value.txt'), '1');
    await writeFile(
      join(f.repo, 'verify.py'),
      `import os, pathlib, sys, xml.etree.ElementTree as ET
ok = pathlib.Path('value.txt').read_text() == '2' and os.environ.get('PROJECT_MARKER') == 'product'
suite = ET.Element('testsuite')
case = ET.SubElement(suite, 'testcase', name='value and environment')
if not ok: ET.SubElement(case, 'failure', message='expected 2 and owner environment')
ET.ElementTree(suite).write(os.environ['DEVCONTOUR_REPORT_PATH'])
sys.exit(0 if ok else 1)
`,
    );
    await git(f.repo, 'init', '-b', 'main');
    await git(f.repo, 'config', 'user.name', 'Profile fixture');
    await git(f.repo, 'config', 'user.email', 'fixture@example.invalid');
    await git(f.repo, 'add', '.');
    await git(f.repo, 'commit', '-m', 'Python fixture');
    const c = loadConfig(join(result.data, 'config.json'));
    c.contextPacks = []; // The fixture isolates profile execution, not context-lock behaviour.
    c.maxAttempts = 3;
    store = new Store(join(result.data, 'state.sqlite'));
    const h = new DevContour(store, c);
    let mode = 'noop';
    const execute = async (r: AgentRequest) => {
      if (r.review)
        return {
          data: { approved: true, summary: 'Fixture reviewer', findings: [] },
          log: 'fixture',
          command: ['fixture'],
        };
      if (mode === 'fix') await writeFile(join(r.cwd, 'value.txt'), '2');
      if (mode === 'tamper') await writeFile(join(r.cwd, 'profiles/tests.json'), '{}');
      return {
        data: { completed: true, summary: 'Fixture writer' },
        log: 'fixture',
        command: ['fixture'],
      };
    };
    scheduler = new Scheduler(h, result.data, {
      ...adapters,
      claude: { name: 'claude', execute },
      codex: { name: 'codex', execute },
    });
    const board = h.createBoard('Python acceptance');
    const task = h.addTask(board.id, input());
    h.approve(board.id);
    await scheduler.init();
    h.pause(false);
    await scheduler.drain();
    assert.equal(store.read().tasks.find((t) => t.id === task.id)!.status, 'failed');
    mode = 'fix';
    h.retry(task.id);
    await scheduler.drain();
    assert.equal(store.read().tasks.find((t) => t.id === task.id)!.status, 'done');
    const run = store.read().runs.find((r) => r.status === 'succeeded')!;
    for (const phase of ['candidate', 'integration'])
      assert.ok(run.evidence.some((e) => e.phase === phase && e.gate === 'tests' && e.passed));
    mode = 'tamper';
    const nextBoard = h.createBoard('Protected profile');
    const next = h.addTask(nextBoard.id, input());
    h.approve(nextBoard.id);
    await scheduler.drain();
    assert.equal(store.read().tasks.find((t) => t.id === next.id)!.status, 'failed');
    assert.match(store.read().tasks.find((t) => t.id === next.id)!.failure!, /защищ|protected/i);
  } finally {
    await scheduler?.stop();
    store?.close();
    await f.close();
  }
});

test('A profile carries the instructions its stack needs, and the registry still wins', async () => {
  // Роли профиль объявлять умел, а знание — нет: файлы копировались в продукт
  // при setup, и библиотека не росла, потому что её некуда было положить так,
  // чтобы она сама приезжала в проект.
  const resolved = await profile('react-native');
  const design = resolved.contextPacks.find((p) => p.id === 'design-system');
  assert.ok(design, 'профиль приносит инструкции своей поверхности');
  assert.ok(design.files.includes('.agents/context/design-system.md'));
  assert.ok(design.roles.includes('ui-tokens'));

  // Надстройка уточняет пакет базового профиля, не отменяя остальные.
  const expo = await profile('expo-mobile');
  assert.ok(expo.contextPacks.some((p) => p.id === 'design-system'));
});

test('A profile sets how long one attempt may take, and layers take the larger limit', async () => {
  // Пятнадцати минут хватает на правку, но не на реализацию с нуля: агент
  // упирается в предел посреди работы, и попытка расходуется впустую. Сколько
  // нужно — знает стек, а не контур.
  const root = await mkdtemp(join(tmpdir(), 'devcontour-timeout-'));
  try {
    await writeFile(
      join(root, 'base.json'),
      JSON.stringify({
        id: 'base',
        version: '1.0.0',
        runTimeoutMs: 1_200_000,
        gates: [
          {
            id: 'acceptance',
            kind: 'test',
            command: ['npm', 'test'],
            timeoutMs: 240000,
            report: { type: 'junit', path: '.reports/junit.xml' },
          },
        ],
      }),
    );
    await writeFile(
      join(root, 'leaf.json'),
      JSON.stringify({
        id: 'leaf',
        version: '1.0.0',
        extends: ['./base.json'],
        runTimeoutMs: 2_700_000,
      }),
    );
    const resolved = await profile('./leaf.json', root);
    assert.equal(resolved.runTimeoutMs, 2_700_000, 'надстройка вправе попросить больше времени');

    await writeFile(
      join(root, 'quiet.json'),
      JSON.stringify({
        id: 'quiet',
        version: '1.0.0',
        gates: [
          {
            id: 'acceptance',
            kind: 'test',
            command: ['npm', 'test'],
            timeoutMs: 240000,
            report: { type: 'junit', path: '.reports/junit.xml' },
          },
        ],
      }),
    );
    assert.equal((await profile('./quiet.json', root)).runTimeoutMs, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Хранилище подготовки открывается, пока профиль ждёт обновления', async () => {
  // workspace-init с --workspace сначала проверяет подготовку. Открытие её
  // хранилища загружало всю конфигурацию со сверкой профиля, и поднятая версия
  // профиля делала недоступной ту самую команду, которая его обновляет.
  const workspace = await mkdtemp(join(tmpdir(), 'devcontour-prep-'));
  const root = join(workspace, '.devcontour-local');
  try {
    await mkdir(root);
    const stale = {
      version: 1,
      name: 'Pilot',
      repository: workspace,
      storage: 'central',
      packs: [{ id: 'pilot', version: '1.3.0', capabilities: [] }],
    };
    await json(join(root, 'config.json'), stale);
    assert.throws(() => loadConfig(join(root, 'config.json')));
    const store = preparationStore(root);
    store.close();
    // Компонентному хранению список репозиториев нужен, и сломанная
    // конфигурация по-прежнему видна сразу.
    await json(join(root, 'config.json'), { ...stale, storage: 'component' });
    assert.throws(() => preparationStore(root));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Обновление профиля называет значения, которые переопределяет файл компонента', async () => {
  // Файл компонента сильнее профиля. Поднятая версия профиля с новым гейтом
  // сообщала «profile-updated», а гейт до конфигурации не доходил: файл
  // компонента хранил прежний список. Теперь команда называет расхождение.
  const f = await fixture();
  try {
    await git(f.repo, 'init', '-b', 'main');
    await git(f.repo, 'config', 'user.name', 'Profile fixture');
    await git(f.repo, 'config', 'user.email', 'fixture@example.invalid');
    await git(f.repo, 'add', '.');
    await git(f.repo, 'commit', '-m', 'Own profile');
    const control = join(f.root, 'control');
    await mkdir(control);
    const registry = join(control, 'workspace.json');
    await json(registry, {
      version: 1,
      name: 'Component file',
      repositories: [
        {
          id: 'product',
          name: 'Product',
          path: f.repo,
          profile: './profiles/main.json',
          configFile: 'devcontour.component.json',
        },
      ],
    });
    const ownGate = { ...testGate, id: 'component-own' };
    await json(join(f.repo, 'devcontour.component.json'), {
      name: 'Product',
      kind: 'product',
      gates: [ownGate],
      environment: { values: { PROJECT_MARKER: 'product' } },
    });
    const result = await setupWorkspace(registry);
    await json(join(f.repo, 'profiles/tests.json'), {
      id: 'checks',
      version: '2.1.0',
      gates: [testGate, { ...testGate, id: 'profile-new' }],
    });
    await json(join(f.repo, 'profiles/main.json'), {
      id: 'custom-api',
      version: '1.1.0',
      extends: ['./stack.json', './tests.json', './env.json'],
    });
    const updated = await setupWorkspace(registry);
    assert.equal(updated.status, 'profile-updated');
    assert.deepEqual('shadowed' in updated ? updated.shadowed : undefined, [
      { repositoryId: 'product', file: 'devcontour.component.json', keys: ['gates'] },
    ]);
    assert.match('warning' in updated ? String(updated.warning) : '', /gates/);
    // Сам файл компонента по-прежнему решает: обновление ничего не подменяет.
    assert.deepEqual(
      loadConfig(result.config).repositories[0].gates.map((g) => g.id),
      ['component-own'],
    );
  } finally {
    await f.close();
  }
});

test('workspace-init хранит компонент с файлом ссылкой, и поле, удалённое из файла, не действует из копии', async () => {
  // Прежняя версия записывала в config.json полную копию полей компонента.
  // Удалённый из файла prepare продолжал действовать из копии.
  const f = await fixture();
  try {
    await git(f.repo, 'init', '-b', 'main');
    await git(f.repo, 'config', 'user.name', 'Profile fixture');
    await git(f.repo, 'config', 'user.email', 'fixture@example.invalid');
    await git(f.repo, 'add', '.');
    await git(f.repo, 'commit', '-m', 'Own profile');
    const control = join(f.root, 'control');
    await mkdir(control);
    const registry = join(control, 'workspace.json');
    await json(registry, {
      version: 1,
      name: 'Component copy',
      repositories: [
        {
          id: 'product',
          name: 'Product',
          path: f.repo,
          profile: './profiles/main.json',
          configFile: 'devcontour.component.json',
        },
      ],
    });
    const componentPath = join(f.repo, 'devcontour.component.json');
    const component: Record<string, unknown> = {
      name: 'Product',
      kind: 'product',
      gates: [testGate],
      prepare: [{ id: 'install', command: ['python3', '-V'] }],
    };
    await json(componentPath, component);
    const { config: configPath } = await setupWorkspace(registry);
    // config.json прежней версии: рядом со ссылкой — копия полей компонента.
    const stored = JSON.parse(await readFile(configPath, 'utf8')) as { repositories: unknown[] };
    stored.repositories = loadConfig(configPath).repositories.map((r) => ({ ...r }));
    await json(configPath, stored);

    delete component.prepare;
    await json(componentPath, component);
    assert.equal(loadConfig(configPath).repositories[0].prepare, undefined);

    // workspace-init убирает копию: остаётся ссылка с ролями профиля.
    assert.equal((await setupWorkspace(registry)).status, 'declaration-updated');
    const refreshed = JSON.parse(await readFile(configPath, 'utf8')) as {
      repositories: Record<string, unknown>[];
    };
    assert.deepEqual(Object.keys(refreshed.repositories[0]).sort(), [
      'configFile',
      'id',
      'path',
      'roles',
    ]);
    assert.equal(loadConfig(configPath).repositories[0].prepare, undefined);
    assert.equal((await setupWorkspace(registry)).status, 'preserved');

    // Обратный случай: поле, добавленное в файл, действует без workspace-init.
    await json(componentPath, { ...component, prepare: [{ id: 'again', command: ['true'] }] });
    assert.deepEqual(
      loadConfig(configPath).repositories[0].prepare?.map((s) => s.id),
      ['again'],
    );
  } finally {
    await f.close();
  }
});

async function componentWorkspace(component: Record<string, unknown>, registryEntry = {}) {
  const f = await fixture();
  // Первая версия профиля без окружения: его добавит следующая.
  await json(join(f.repo, 'profiles/main.json'), {
    id: 'custom-api',
    version: '1.0.0',
    extends: ['./stack.json', './tests.json'],
  });
  await git(f.repo, 'init', '-b', 'main');
  await git(f.repo, 'config', 'user.name', 'Profile fixture');
  await git(f.repo, 'config', 'user.email', 'fixture@example.invalid');
  await git(f.repo, 'add', '.');
  await git(f.repo, 'commit', '-m', 'Own profile');
  const control = join(f.root, 'control');
  await mkdir(control);
  const registry = join(control, 'workspace.json');
  const entry = {
    id: 'product',
    name: 'Product',
    path: f.repo,
    profile: './profiles/main.json',
    configFile: 'devcontour.component.json',
    ...registryEntry,
  };
  await json(registry, { version: 1, name: 'Completion', repositories: [entry] });
  const componentPath = join(f.repo, 'devcontour.component.json');
  await json(componentPath, { name: 'Product', kind: 'product', gates: [testGate], ...component });
  const read = async () =>
    JSON.parse(await readFile(componentPath, 'utf8')) as Record<string, unknown>;
  const bumpProfile = async (version: string, values: Record<string, string>) => {
    await json(join(f.repo, 'profiles/env.json'), {
      id: 'env',
      version,
      environment: { values },
    });
    await json(join(f.repo, 'profiles/main.json'), {
      id: 'custom-api',
      version,
      extends: ['./stack.json', './tests.json', './env.json'],
    });
  };
  return { f, registry, entry, componentPath, read, bumpProfile };
}

test('Обновление профиля дописывает в файл компонента новое поле профиля, но не трогает поле файла', async () => {
  // Поля компонента берутся только из его файла. Окружение, добавленное
  // новой версией профиля, иначе не применялось, а workspace-init сообщал
  // profile-updated.
  const w = await componentWorkspace({});
  try {
    const { config: configPath } = await setupWorkspace(w.registry);
    assert.equal(loadConfig(configPath).repositories[0].environment, undefined);
    await w.bumpProfile('1.1.0', { PROJECT_MARKER: 'profile' });
    const updated = await setupWorkspace(w.registry);
    assert.equal(updated.status, 'profile-updated');
    assert.deepEqual('added' in updated ? updated.added : undefined, [
      { repositoryId: 'product', file: 'devcontour.component.json', keys: ['environment'] },
    ]);
    // Перекрытым названо только то, что в файле уже было: новый файл
    // профиля защищён профилем, а список путей файла его не содержит.
    assert.deepEqual('shadowed' in updated ? updated.shadowed : undefined, [
      { repositoryId: 'product', file: 'devcontour.component.json', keys: ['protectedPaths'] },
    ]);
    assert.deepEqual((await w.read()).environment, {
      inherit: [],
      values: { PROJECT_MARKER: 'profile' },
      secrets: {},
    });
    assert.equal(
      loadConfig(configPath).repositories[0].environment?.values.PROJECT_MARKER,
      'profile',
    );

    // Обратный случай: своё значение файла не перезаписывается — профиль
    // перекрыт, и это названо.
    await json(w.componentPath, {
      ...(await w.read()),
      environment: { values: { PROJECT_MARKER: 'component' } },
    });
    await w.bumpProfile('1.2.0', { PROJECT_MARKER: 'profile-2' });
    const shadowed = await setupWorkspace(w.registry);
    assert.equal(shadowed.status, 'profile-updated');
    assert.ok(!('added' in shadowed));
    assert.deepEqual('shadowed' in shadowed ? shadowed.shadowed : undefined, [
      {
        repositoryId: 'product',
        file: 'devcontour.component.json',
        keys: ['environment', 'protectedPaths'],
      },
    ]);
    assert.equal(
      loadConfig(configPath).repositories[0].environment?.values.PROJECT_MARKER,
      'component',
    );
  } finally {
    await w.f.close();
  }
});

test('Поле компонента, объявленное реестром, попадает в файл компонента, а своё значение файла остаётся', async () => {
  const w = await componentWorkspace({});
  try {
    const { config: configPath } = await setupWorkspace(w.registry);
    // Реестр объявил preflight и артефакты сборки, которых в файле нет.
    const preflight = [{ id: 'tools', command: ['python3', '-V'] }];
    await json(w.registry, {
      version: 1,
      name: 'Completion',
      repositories: [{ ...w.entry, preflight, dependencyArtifacts: ['dist'] }],
    });
    const updated = await setupWorkspace(w.registry);
    assert.equal(updated.status, 'declaration-updated');
    assert.deepEqual('added' in updated ? updated.added : undefined, [
      {
        repositoryId: 'product',
        file: 'devcontour.component.json',
        keys: ['dependencyArtifacts', 'preflight'],
      },
    ]);
    const loaded = loadConfig(configPath).repositories[0];
    assert.deepEqual(
      loaded.preflight?.map((s) => s.id),
      ['tools'],
    );
    assert.deepEqual(loaded.dependencyArtifacts, ['dist']);
    assert.equal((await setupWorkspace(w.registry)).status, 'preserved');

    // Обратный случай: файл объявил свой preflight — значение реестра его не
    // заменяет, и повторный workspace-init ничего не дописывает.
    await json(w.componentPath, {
      ...(await w.read()),
      preflight: [{ id: 'own', command: ['true'] }],
    });
    await json(w.registry, {
      version: 1,
      name: 'Completion',
      repositories: [
        {
          ...w.entry,
          preflight: [{ id: 'registry', command: ['true'] }],
          dependencyArtifacts: ['dist'],
        },
      ],
    });
    assert.equal((await setupWorkspace(w.registry)).status, 'preserved');
    assert.deepEqual(
      loadConfig(configPath).repositories[0].preflight?.map((s) => s.id),
      ['own'],
    );
  } finally {
    await w.f.close();
  }
});

test('Дописать в файл компонента с незафиксированной правкой workspace-init отказывается', async () => {
  const w = await componentWorkspace({});
  try {
    const { config: configPath } = await setupWorkspace(w.registry);
    await git(w.f.repo, 'add', 'devcontour.component.json');
    await git(w.f.repo, 'commit', '-m', 'Component config');
    // Оператор правит файл и не фиксирует правку.
    await json(w.componentPath, { ...(await w.read()), generatedPaths: ['build'] });
    const before = await readFile(w.componentPath, 'utf8');
    const configBefore = await readFile(configPath, 'utf8');
    await json(w.registry, {
      version: 1,
      name: 'Completion',
      repositories: [{ ...w.entry, dependencyArtifacts: ['dist'] }],
    });
    await assert.rejects(
      setupWorkspace(w.registry),
      /devcontour\.component\.json\) изменён и не зафиксирован.*dependencyArtifacts/,
    );
    assert.equal(await readFile(w.componentPath, 'utf8'), before);
    assert.equal(await readFile(configPath, 'utf8'), configBefore);
    // Правка зафиксирована — дописывание проходит.
    await git(w.f.repo, 'commit', '-am', 'Generated paths');
    assert.equal((await setupWorkspace(w.registry)).status, 'declaration-updated');
    assert.deepEqual((await w.read()).dependencyArtifacts, ['dist']);
  } finally {
    await w.f.close();
  }
});

test('dependencyStore, объявленный реестром, попадает в файл компонента и действует; своё значение файла остаётся', async () => {
  const dependencyStore = { manager: 'pnpm' };
  const w = await componentWorkspace({}, { dependencyStore });
  try {
    const installed = await setupWorkspace(w.registry);
    // Вместе с ним установка дописывает пути, которые защищает профиль.
    assert.deepEqual('added' in installed ? installed.added : undefined, [
      {
        repositoryId: 'product',
        file: 'devcontour.component.json',
        keys: ['dependencyStore', 'protectedPaths'],
      },
    ]);
    assert.match('addedNote' in installed ? String(installed.addedNote) : '', /APPROVAL_STALE/);
    assert.match('addedNote' in installed ? String(installed.addedNote) : '', /base-update/);
    assert.equal(
      ((await w.read()).dependencyStore as { manager?: string } | undefined)?.manager,
      'pnpm',
    );
    assert.equal(
      loadConfig(installed.config).repositories[0].dependencyStore?.lockfile,
      'pnpm-lock.yaml',
    );

    // Обратный случай: файл объявил своё хранилище — реестр его не заменяет.
    await json(w.componentPath, {
      ...(await w.read()),
      dependencyStore: { manager: 'pnpm', lockfile: 'app/pnpm-lock.yaml' },
    });
    assert.equal((await setupWorkspace(w.registry)).status, 'preserved');
    assert.equal(
      loadConfig(installed.config).repositories[0].dependencyStore?.lockfile,
      'app/pnpm-lock.yaml',
    );
  } finally {
    await w.f.close();
  }
});

test('Отказ после записи файлов компонентов возвращает их все', async () => {
  // Два компонента получают дописанные ключи, затем запись config.json
  // отказывает: оба файла должны вернуться к прежнему содержимому.
  const a = await componentWorkspace({});
  const b = await fixture();
  try {
    await git(b.repo, 'init', '-b', 'main');
    await git(b.repo, 'config', 'user.name', 'Profile fixture');
    await git(b.repo, 'config', 'user.email', 'fixture@example.invalid');
    await git(b.repo, 'add', '.');
    await git(b.repo, 'commit', '-m', 'Library');
    const libraryFile = join(b.repo, 'devcontour.component.json');
    await json(libraryFile, { name: 'Library', kind: 'library', gates: [testGate] });
    const library = {
      id: 'library',
      name: 'Library',
      path: b.repo,
      profile: './profiles/main.json',
      configFile: 'devcontour.component.json',
    };
    const registry = (extra: Record<string, unknown>) =>
      json(a.registry, {
        version: 1,
        name: 'Completion',
        repositories: [
          { ...a.entry, ...extra },
          { ...library, ...extra },
        ],
      });
    await registry({});
    const { data, config: configPath } = await setupWorkspace(a.registry);
    const before = [await readFile(a.componentPath, 'utf8'), await readFile(libraryFile, 'utf8')];
    const configBefore = await readFile(configPath, 'utf8');
    await registry({ dependencyArtifacts: ['dist'] });
    // Каталог данных только для чтения: config.json не записать.
    await chmod(data, 0o555);
    try {
      await assert.rejects(setupWorkspace(a.registry), /EACCES|permission denied/i);
    } finally {
      await chmod(data, 0o755);
    }
    assert.deepEqual(
      [await readFile(a.componentPath, 'utf8'), await readFile(libraryFile, 'utf8')],
      before,
      'оба файла компонентов возвращены',
    );
    assert.equal(await readFile(configPath, 'utf8'), configBefore);
    // Причина устранена — повтор дописывает оба файла.
    assert.equal((await setupWorkspace(a.registry)).status, 'declaration-updated');
    assert.deepEqual((await a.read()).dependencyArtifacts, ['dist']);
    assert.deepEqual(
      (JSON.parse(await readFile(libraryFile, 'utf8')) as Record<string, unknown>)
        .dependencyArtifacts,
      ['dist'],
    );
  } finally {
    await a.f.close();
    await b.close();
  }
});

test('Профиль с effort не на codex не загружается, а правка с новой версией возвращает установку', async () => {
  const f = await fixture();
  try {
    await git(f.repo, 'init', '-b', 'main');
    await git(f.repo, 'config', 'user.name', 'Profile fixture');
    await git(f.repo, 'config', 'user.email', 'fixture@example.invalid');
    await git(f.repo, 'add', '.');
    await git(f.repo, 'commit', '-m', 'Own profile');
    const control = join(f.root, 'control');
    await mkdir(control);
    const registry = join(control, 'workspace.json');
    const roles = { qa: { runtime: 'codex', reviewer: { runtime: 'claude' } } };
    await json(registry, {
      version: 1,
      name: 'Effort',
      repositories: [
        { id: 'product', name: 'Product', path: f.repo, profile: './profiles/main.json', roles },
      ],
    });
    const result = await setupWorkspace(registry);
    const main = {
      id: 'custom-api',
      extends: ['./stack.json', './tests.json', './env.json'],
    };
    // Реестр заменяет роль целиком, но поле профиля всё равно остаётся отказом.
    await json(join(f.repo, 'profiles/main.json'), {
      ...main,
      version: '1.0.0',
      roles: { qa: { runtime: 'claude', effort: 'low' } },
    });
    assert.throws(() => loadConfig(result.config), /effort поддерживается только для codex: qa/);
    await json(join(f.repo, 'profiles/main.json'), {
      ...main,
      version: '1.1.0',
      roles: { qa: { runtime: 'claude' } },
    });
    assert.throws(() => loadConfig(result.config), /версия 1\.0\.0 → 1\.1\.0/);
    assert.equal((await setupWorkspace(registry)).status, 'profile-updated');
    assert.equal(loadConfig(result.config).packs[0].version, '1.1.0');
  } finally {
    await f.close();
  }
});

test('workspace-init переносит правила ревью, а панель и doctor видят действующие gates и роли компонента', async () => {
  // Файл компонента сильнее профиля и верхнего уровня config.json. Копии
  // верхнего уровня (gates, protectedPaths, роли единственного компонента)
  // устаревали: панель читала список gates, по которому контур уже не
  // работал, а роли показывали прежних ревьюеров. Правила ревью задавались
  // только ручной правкой config.json.
  const f = await fixture();
  try {
    await git(f.repo, 'init', '-b', 'main');
    await git(f.repo, 'config', 'user.name', 'Profile fixture');
    await git(f.repo, 'config', 'user.email', 'fixture@example.invalid');
    await git(f.repo, 'add', '.');
    await git(f.repo, 'commit', '-m', 'Own profile');
    const control = join(f.root, 'control');
    await mkdir(control);
    const registry = join(control, 'workspace.json');
    const declared = {
      version: 1,
      name: 'Review rules',
      repositories: [
        {
          id: 'product',
          name: 'Product',
          path: f.repo,
          profile: './profiles/main.json',
          configFile: 'devcontour.component.json',
        },
      ],
    };
    await json(registry, declared);
    const componentPath = join(f.repo, 'devcontour.component.json');
    const component: { gates: unknown[]; roles: Record<string, Record<string, unknown>> } & Record<
      string,
      unknown
    > = {
      name: 'Product',
      kind: 'product',
      gates: [{ ...testGate, id: 'component-own' }],
      // Ревьюер компонента проверяет его роли без своего ревьюера: копия роли
      // на верхнем уровне обязана нести его, а не общий codex.
      reviewer: { runtime: 'claude' },
      roles: {
        backend: {
          runtime: 'claude',
          reviewer: { runtime: 'claude' },
          reviewVendor: 'same-vendor-allowed',
          requiresContract: true,
        },
        architect: { runtime: 'codex' },
        frontend: { runtime: 'codex' },
        qa: { runtime: 'codex' },
        // Роль только компонента на верхний уровень не копируется.
        mobile: { runtime: 'codex', reviewer: { runtime: 'claude' }, title: 'Мобильный' },
      },
    };
    await json(componentPath, component);
    const { config: configPath } = await setupWorkspace(registry);
    assert.deepEqual(
      (JSON.parse(await readFile(configPath, 'utf8')) as { reviewer: unknown }).reviewer,
      { runtime: 'claude' },
      'установка копирует ревьюера единственного компонента',
    );

    // config.json прежней версии: копии верхнего уровня записаны и устарели.
    const stale = JSON.parse(await readFile(configPath, 'utf8'));
    stale.gates = [testGate];
    stale.protectedPaths = ['stale/'];
    stale.roles.backend = { runtime: 'claude', reviewer: { runtime: 'codex' } };
    stale.reviewer = { runtime: 'codex' };
    await json(configPath, stale);
    // Компонент добавил gate без повторного workspace-init.
    component.gates.push({ ...testGate, id: 'component-new' });
    await json(componentPath, component);
    // Панель и doctor читают загруженную конфигурацию: в ней действует компонент.
    const loaded = loadConfig(configPath);
    assert.deepEqual(
      loaded.gates.map((g) => g.id),
      ['component-own', 'component-new'],
    );
    assert.ok(!loaded.protectedPaths.includes('stale/'));

    // workspace-init обновляет и сами копии в файле.
    assert.equal((await setupWorkspace(registry)).status, 'declaration-updated');
    const refreshed = JSON.parse(await readFile(configPath, 'utf8')) as {
      gates: { id: string }[];
      protectedPaths: string[];
      roles: Record<string, { reviewer: { runtime: string }; reviewVendor?: string }>;
      reviewer: { runtime: string };
    };
    assert.deepEqual(
      refreshed.gates.map((g) => g.id),
      ['component-own', 'component-new'],
    );
    assert.ok(!refreshed.protectedPaths.includes('stale/'));
    assert.equal(refreshed.roles.backend.reviewer.runtime, 'claude');
    assert.equal(refreshed.roles.backend.reviewVendor, 'same-vendor-allowed');
    assert.equal(refreshed.roles.qa.reviewer.runtime, 'claude', 'ревьюер компонента');
    // Верхнеуровневый reviewer при единственном компоненте — тоже копия:
    // прежняя версия оставляла в нём ревьюера, которого контур уже не вызывает.
    assert.deepEqual(refreshed.reviewer, { runtime: 'claude' });
    assert.ok(!('mobile' in refreshed.roles), 'роль компонента не стала общей');
    assert.equal((await setupWorkspace(registry)).status, 'preserved');
    // Устаревшая копия одного reviewer — тоже повод обновить файл.
    await json(configPath, { ...refreshed, reviewer: { runtime: 'codex' } });
    assert.equal((await setupWorkspace(registry)).status, 'declaration-updated');
    assert.deepEqual(loadConfig(configPath).reviewer, { runtime: 'claude' });
    assert.equal((await setupWorkspace(registry)).status, 'preserved');

    // Правила ревью объявляются реестром и переносятся workspace-init.
    const review = {
      code: { vendor: 'same-vendor-allowed' },
      plan: { reviewer: { runtime: 'claude' }, vendor: 'same-vendor-allowed' },
      contract: { reviewer: { runtime: 'claude' }, vendor: 'same-vendor-allowed' },
    };
    await json(registry, { ...declared, review });
    assert.equal((await setupWorkspace(registry)).status, 'declaration-updated');
    assert.deepEqual(loadConfig(configPath).review, review);
    assert.equal((await setupWorkspace(registry)).status, 'preserved');
    // Реестр без review правилами не управляет: выбор в config.json остаётся.
    await json(registry, declared);
    assert.equal((await setupWorkspace(registry)).status, 'preserved');
    assert.deepEqual(loadConfig(configPath).review, review);
    // Реестр, объявивший один вид, заменяет только его: plan и contract,
    // выбранные раньше, не стираются.
    const code = { reviewer: { runtime: 'claude' }, vendor: 'same-vendor-allowed' };
    await json(registry, { ...declared, review: { code } });
    assert.equal((await setupWorkspace(registry)).status, 'declaration-updated');
    assert.deepEqual(loadConfig(configPath).review, { ...review, code });

    // Объявление проверяется до записи: неизвестное правило и ревьюер того же
    // вендора без явного разрешения отклоняются, config.json не меняется.
    const before = await readFile(configPath, 'utf8');
    await json(registry, { ...declared, review: { code: { vendor: 'any-vendor' } } });
    await assert.rejects(setupWorkspace(registry));
    delete component.roles.backend.reviewVendor;
    await json(componentPath, component);
    await json(registry, { ...declared, review: { code: { vendor: 'different-vendor' } } });
    await assert.rejects(setupWorkspace(registry), /вендора/);
    assert.equal(await readFile(configPath, 'utf8'), before);
  } finally {
    await f.close();
  }
});
