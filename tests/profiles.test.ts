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
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
      /Invalid|path|input/i,
    );
    await invalid({ gates: [{ ...testGate, dependsOn: ['unknown'] }] }, /Неизвестная/);
    await invalid({ extends: ['./tests.json'], gates: [testGate] }, /уникальны/);
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
    assert.throws(() => loadConfig(configPath), /Профиль изменился/);
    await assert.rejects(setupProject(options), /Профиль изменился/);
    assert.equal(JSON.parse(await readFile(localFile, 'utf8')).gates[0].timeoutMs, 3210);
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
    assert.throws(() => loadConfig(result.config), /Профиль изменился/);
    // Правка без смены версии остаётся отказом: пин защищает от тихой подмены.
    await assert.rejects(setupWorkspace(registry), /Профиль изменился/);
    // Поднятая версия составного профиля — заявление «изменилось намеренно»,
    // и только она разрешает переписать lock. Правка вложенного профиля версию
    // составного не меняет, поэтому сама по себе установку не разрешает: автор
    // обязан объявить изменение там, где профиль установлен.
    await json(join(library, 'profiles/main.json'), {
      id: 'custom-api',
      version: '1.1.0',
      extends: ['./stack.json', './tests.json', './env.json'],
    });
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
