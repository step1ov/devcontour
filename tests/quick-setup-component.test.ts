import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseWorkspaceMode } from '../src/runner/workspace-mode.ts';
import { packageRegistryDomains, planSetup, setupProject } from '../src/runner/setup.ts';
import { loadConfig } from '../src/runner/config.ts';
import { installNetworkCheck, isInstallStep } from '../src/runner/doctor.ts';
import { validateWorkflow } from '../src/core/workflow.ts';
import { withTestHome } from './helpers.ts';

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Quick Test',
  GIT_AUTHOR_EMAIL: 'quick@example.test',
  GIT_COMMITTER_NAME: 'Quick Test',
  GIT_COMMITTER_EMAIL: 'quick@example.test',
};
const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env }).trim();
const temp = () => realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-quick-component-')));

/** pnpm-репозиторий; при `component` — с закоммиченным файлом компонента прежней настройки. */
function repository(root: string, extra: Record<string, string> = {}) {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'existing-app', private: true, scripts: { test: 'node --test' } }) +
      '\n',
  );
  writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  writeFileSync(join(root, 'src/index.js'), 'export const add = (a, b) => a + b;\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  for (const [file, text] of Object.entries(extra)) writeFileSync(join(root, file), text);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'existing project');
}

const committedComponent = {
  name: 'existing-app',
  gates: [
    { id: 'package-policy', kind: 'check', command: ['node', '--version'], timeoutMs: 60000 },
    {
      id: 'root-test',
      kind: 'test',
      command: ['node', '--test'],
      timeoutMs: 600000,
      report: { type: 'junit', path: '.reports/junit.xml' },
    },
  ],
  roles: {
    engine: {
      runtime: 'claude',
      toolProfile: 'claude',
      title: 'Движок',
      reviewer: { runtime: 'codex', toolProfile: 'codex' },
    },
  },
};

const proposal = [
  { id: 'install', kind: 'check', command: ['pnpm', 'install', '--frozen-lockfile'], timeoutMs: 1 },
  { id: 'typecheck', kind: 'check', command: ['node', '--version'], timeoutMs: 60000 },
  {
    id: 'unit-tests',
    kind: 'test',
    command: ['node', '--test'],
    timeoutMs: 60000,
    report: { type: 'junit', path: '.reports/junit.xml' },
  },
];

test('setup называет сохранённый файл компонента и его проверки вместо предложения', () =>
  withTestHome(async () => {
    const root = temp();
    try {
      repository(root, {
        'devcontour.component.json': JSON.stringify(committedComponent, null, 2) + '\n',
      });
      chooseWorkspaceMode(root, 'embedded');
      const input = {
        repository: root,
        workspace: root,
        profile: 'pnpm-project',
        quick: true,
        gates: proposal,
      };
      const plan = await planSetup(input);
      assert.equal(plan.refusal, undefined);
      const componentPath = join(root, 'devcontour.component.json');
      assert.equal(plan.files.find((f) => f.path === componentPath)?.action, 'preserve');
      assert.equal(plan.component?.action, 'preserve');
      assert.equal(plan.component?.precedence, true);
      assert.match(
        plan.component?.note ?? '',
        /devcontour\.component\.json.*действуют его проверки/,
      );
      // Действующие проверки — из файла компонента, а не из предложения.
      assert.deepEqual(
        (plan.gates ?? []).map((g) => g.id),
        ['package-policy', 'root-test'],
      );
      const applied = await setupProject(input);
      assert.ok(applied.preserved.includes(componentPath));
      assert.deepEqual(
        (applied.gates ?? []).map((g) => g.id),
        ['package-policy', 'root-test'],
      );
      assert.match(applied.next[0] ?? '', /действуют его проверки/);
      // Файл компонента не тронут, и действует именно он.
      assert.deepEqual(JSON.parse(readFileSync(componentPath, 'utf8')), committedComponent);
      const config = loadConfig(join(root, '.devcontour-local/config.json'));
      assert.deepEqual(
        config.repositories[0].gates.map((g) => g.id),
        ['package-policy', 'root-test'],
      );
      // Роли файла называют профили инструментов: setup их создаёт, и
      // конфигурация применима.
      assert.deepEqual(config.toolProfiles.claude?.runtime, 'claude');
      assert.deepEqual(config.toolProfiles.codex?.runtime, 'codex');
      assert.doesNotThrow(() => validateWorkflow(config));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }));

test('без файла компонента план называет его создание и проверки предложения', () =>
  withTestHome(async () => {
    const root = temp();
    try {
      repository(root);
      chooseWorkspaceMode(root, 'embedded');
      const plan = await planSetup({
        repository: root,
        workspace: root,
        profile: 'pnpm-project',
        quick: true,
        gates: proposal,
      });
      const componentPath = join(root, 'devcontour.component.json');
      assert.equal(plan.files.find((f) => f.path === componentPath)?.action, 'create');
      assert.equal(plan.component?.precedence, false);
      assert.deepEqual(
        (plan.gates ?? []).map((g) => g.id),
        ['install', 'typecheck', 'unit-tests'],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }));

test('нечитаемый файл компонента — отказ плана, а не молчаливое применение', () =>
  withTestHome(async () => {
    const root = temp();
    try {
      repository(root, { 'devcontour.component.json': '{ broken' });
      chooseWorkspaceMode(root, 'embedded');
      const input = { repository: root, workspace: root, profile: 'pnpm-project', quick: true };
      const plan = await planSetup(input);
      assert.match(plan.refusal ?? '', /devcontour\.component\.json не читается/);
      await assert.rejects(setupProject(input), /не читается/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }));

test('pnpm и npm setup открывают песочнице реестр пакетов, в том числе из .npmrc', () =>
  withTestHome(async () => {
    const root = temp();
    try {
      repository(root);
      chooseWorkspaceMode(root, 'embedded');
      const input = { repository: root, workspace: root, profile: 'pnpm-project', quick: true };
      // План показывает сетевую политику песочницы до применения.
      const plan = await planSetup(input);
      assert.deepEqual(plan.isolation, { domains: ['registry.npmjs.org'] });
      assert.deepEqual(plan.toolProfiles, {});
      await setupProject(input);
      const config = loadConfig(join(root, '.devcontour-local/config.json'));
      assert.equal(config.isolation.mode, 'os');
      assert.deepEqual(config.isolation.domains, ['registry.npmjs.org']);
      assert.equal(await installNetworkCheck(config), undefined);
      // Конфигурация без доменов: doctor предупреждает о gate установки.
      const closed = { ...config, isolation: { mode: 'os' as const, domains: [] } };
      const warning = await installNetworkCheck(closed);
      assert.equal(warning?.status, 'degraded');
      assert.match(warning?.detail ?? '', /main:install/);
      assert.match(warning?.detail ?? '', /registry\.npmjs\.org/);
      assert.equal(
        await installNetworkCheck({ ...closed, isolation: { mode: 'none', domains: [] } }),
        undefined,
      );
      // Домены есть, но не реестр из .npmrc — тоже предупреждение.
      writeFileSync(join(root, '.npmrc'), 'registry=https://npm.example.test/\n');
      const stale = await installNetworkCheck(config);
      assert.match(stale?.detail ?? '', /npm\.example\.test/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    const mirror = temp();
    try {
      writeFileSync(
        join(mirror, '.npmrc'),
        'registry=https://npm.example.test/repo/\n@acme:registry=https://acme.example.test\n@env:registry=${PRIVATE_REGISTRY}\n',
      );
      assert.deepEqual(
        await packageRegistryDomains(mirror, {
          capabilities: ['npm'],
          gates: [{ command: ['npm', 'ci'] }],
        }),
        { domains: ['npm.example.test', 'acme.example.test'], skipped: [] },
      );
      writeFileSync(join(mirror, '.npmrc'), '@acme:registry=https://acme.example.test\n');
      assert.deepEqual(
        (await packageRegistryDomains(mirror, { gates: [{ command: ['pnpm', 'install'] }] }))
          .domains,
        ['registry.npmjs.org', 'acme.example.test'],
      );
      // Профиль без npm/pnpm сеть не открывает.
      assert.deepEqual(
        (
          await packageRegistryDomains(mirror, {
            capabilities: ['go'],
            gates: [{ command: ['go'] }],
          })
        ).domains,
        [],
      );
    } finally {
      rmSync(mirror, { recursive: true, force: true });
    }
  }));

test('локальные адреса реестра не открываются песочнице автоматически, план их называет', () =>
  withTestHome(async () => {
    const root = temp();
    try {
      repository(root, {
        '.npmrc': [
          'registry=http://localhost:4873/',
          '@a:registry=http://127.0.0.1:4873/',
          '@b:registry=http://10.1.2.3/',
          '@c:registry=http://[::1]:4873/',
          '@d:registry=http://169.254.1.1/',
          '@e:registry=http://registry.local/',
          '@f:registry=http://dev.localhost/',
          '@g:registry=https://npm.example.test/',
          '@h:registry=http://localhost.:4873/',
          '@i:registry=https://npm.example.test./',
        ].join('\n'),
      });
      chooseWorkspaceMode(root, 'embedded');
      const input = { repository: root, workspace: root, profile: 'pnpm-project', quick: true };
      const plan = await planSetup(input);
      assert.deepEqual(plan.isolation.domains, ['npm.example.test']);
      assert.deepEqual(plan.isolation.skipped, [
        'localhost',
        '127.0.0.1',
        '10.1.2.3',
        '[::1]',
        '169.254.1.1',
        'registry.local',
        'dev.localhost',
      ]);
      assert.match(plan.isolation.note ?? '', /вручную/);
      await setupProject(input);
      const config = loadConfig(join(root, '.devcontour-local/config.json'));
      assert.deepEqual(config.isolation.domains, ['npm.example.test']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }));

test('doctor находит установку зависимостей в любом месте argv', () => {
  for (const command of [
    ['npm', 'ci'],
    ['pnpm', '--filter', 'x', 'install'],
    ['corepack', 'pnpm', 'install'],
    ['npm', '--prefix', 'web', 'ci'],
    ['yarn'],
    ['yarn', 'install', '--frozen-lockfile'],
    ['/usr/local/bin/pnpm', 'i'],
  ])
    assert.ok(isInstallStep(command), command.join(' '));
  for (const command of [
    ['npm', 'test'],
    ['pnpm', 'run', 'lint'],
    ['yarn', 'test'],
    ['node', '--test'],
  ])
    assert.ok(!isInstallStep(command), command.join(' '));
});

test('файл компонента, не проходящий схему, — отказ плана и применения с причиной', () =>
  withTestHome(async () => {
    const root = temp();
    try {
      repository(root, {
        'devcontour.component.json': JSON.stringify({ ...committedComponent, gates: 'all' }) + '\n',
      });
      chooseWorkspaceMode(root, 'embedded');
      const input = { repository: root, workspace: root, profile: 'pnpm-project', quick: true };
      const plan = await planSetup(input);
      assert.match(plan.refusal ?? '', /devcontour\.component\.json не подходит конфигурации/);
      assert.match(plan.refusal ?? '', /gates/);
      await assert.rejects(setupProject(input), /не подходит конфигурации/);
      assert.equal(existsSync(join(root, '.devcontour-local/config.json')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    const noJunit = temp();
    try {
      repository(noJunit, {
        'devcontour.component.json':
          JSON.stringify({ ...committedComponent, gates: [committedComponent.gates[0]] }) + '\n',
      });
      chooseWorkspaceMode(noJunit, 'embedded');
      const plan = await planSetup({
        repository: noJunit,
        workspace: noJunit,
        profile: 'pnpm-project',
        quick: true,
      });
      assert.match(plan.refusal ?? '', /Нужен test gate с JUnit/);
    } finally {
      rmSync(noJunit, { recursive: true, force: true });
    }
  }));

test('конфигурация со ссылкой роли на несуществующий toolProfile не загружается', () =>
  withTestHome(async () => {
    const root = temp();
    try {
      repository(root, {
        'devcontour.component.json': JSON.stringify(committedComponent, null, 2) + '\n',
      });
      chooseWorkspaceMode(root, 'embedded');
      await setupProject({
        repository: root,
        workspace: root,
        profile: 'pnpm-project',
        quick: true,
      });
      const path = join(root, '.devcontour-local/config.json');
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { toolProfiles?: unknown };
      // Прежний setup писал пустые toolProfiles: такую конфигурацию doctor отклоняет.
      raw.toolProfiles = {};
      writeFileSync(path, JSON.stringify(raw, null, 2) + '\n');
      // doctor и любая другая команда начинают с загрузки конфигурации: ссылка
      // на несуществующий профиль — отказ загрузки, а не «ready».
      assert.throws(() => loadConfig(path), /Неизвестный или несовместимый toolProfile: claude/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }));
