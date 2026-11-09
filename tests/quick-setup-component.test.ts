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
import {
  DEFAULT_GATE_TIMEOUT_FLOOR_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  MAX_DERIVED_RUN_TIMEOUT_MS,
  chooseRunTimeout,
  packageRegistryDomains,
  planSetup,
  setupProject,
} from '../src/runner/setup.ts';
import { loadConfig } from '../src/runner/config.ts';
import { gateTimeoutCheck, installNetworkCheck, isInstallStep } from '../src/runner/doctor.ts';
import { validateWorkflow } from '../src/core/workflow.ts';
import { config, withTestHome } from './helpers.ts';

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

test('срок фазы попытки: умолчание, оценка фазы интеграции, предел, заданное значение', () => {
  // Короткие проверки укладываются в умолчание; каждая — не короче нижнего предела.
  const small = chooseRunTimeout({
    gates: [{ timeoutMs: 1 }, { timeoutMs: 60000 }, {}],
    floorMs: DEFAULT_GATE_TIMEOUT_FLOOR_MS,
  });
  assert.equal(small.source, 'default');
  assert.equal(small.ms, DEFAULT_RUN_TIMEOUT_MS);
  // 60 с (поднят предел) + 60 с + 120 с (умолчание схемы).
  assert.equal(small.gatesMs, 240000);
  // Фаза интеграции: проверки и повтор самой долгой (120 с).
  assert.equal(small.phaseMs, 360000);
  assert.match(small.reason, /умолчание: оценка фазы интеграции/);
  // Долгие проверки: оценка фазы с запасом 25%, до минуты, не меньше умолчания.
  const long = chooseRunTimeout({
    gates: [{ timeoutMs: 600000 }, { timeoutMs: 600000 }, { timeoutMs: 300000 }],
    floorMs: DEFAULT_GATE_TIMEOUT_FLOOR_MS,
  });
  assert.equal(long.source, 'gates');
  assert.equal(long.gatesMs, 1500000);
  assert.equal(long.phaseMs, 2100000);
  // 35 мин + 8,75 мин → 44 мин.
  assert.equal(long.ms, 2_640_000);
  assert.match(
    long.reason,
    /оценка фазы интеграции 35 мин: проверки по очереди 25 мин и повтор самой долгой 10 мин; проверки потребителей не учтены; запас 9 мин/,
  );
  // Большой срок позже прерывает зависший вызов модели: причина это называет.
  assert.match(
    long.reason,
    /ограничивает вызовы моделей и ревью: зависший вызов прервётся через 44 мин/,
  );
  // Одна доминирующая проверка: её повтор на интеграции тоже должен уместиться.
  const dominant = chooseRunTimeout({
    gates: [{ timeoutMs: 1_800_000 }, { timeoutMs: 60000 }, { timeoutMs: 60000 }],
    floorMs: DEFAULT_GATE_TIMEOUT_FLOOR_MS,
  });
  assert.equal(dominant.gatesMs, 1_920_000);
  assert.equal(dominant.phaseMs, 3_720_000);
  // 62 мин + 15,5 мин → 78 мин; без повтора было бы 40 мин, и повтор
  // 30-минутной проверки оборвался бы сроком фазы.
  assert.equal(dominant.ms, 4_680_000);
  assert.ok(dominant.ms > dominant.gatesMs + 1_800_000);
  // Известные сроки шагов подготовки входят в оценку.
  const prepared = chooseRunTimeout({
    gates: [{ timeoutMs: 600000 }],
    steps: [{ timeoutMs: 300000 }, {}],
  });
  assert.equal(prepared.phaseMs, 420000 + 1_200_000);
  assert.match(prepared.reason, /подготовка 7 мин/);
  // Предел вывода — два часа.
  const capped = chooseRunTimeout({ gates: [{ timeoutMs: 6_000_000 }, { timeoutMs: 3_000_000 }] });
  assert.equal(capped.ms, MAX_DERIVED_RUN_TIMEOUT_MS);
  assert.match(capped.reason, /ограничен 120 мин/);
  // Заданное значение сохраняется, даже если фаза дольше: план это называет.
  const existing = chooseRunTimeout({
    gates: [{ timeoutMs: 1_800_000 }],
    profileMs: 1_200_000,
    existingMs: 1_000_000,
  });
  assert.deepEqual(
    { ms: existing.ms, source: existing.source },
    { ms: 1_000_000, source: 'existing' },
  );
  assert.match(existing.reason, /сохранён.*оценка фазы интеграции 60 мин.*поднимите runTimeoutMs/);
  const profile = chooseRunTimeout({ gates: [{ timeoutMs: 60000 }], profileMs: 1_200_000 });
  assert.deepEqual(
    { ms: profile.ms, source: profile.source },
    { ms: 1_200_000, source: 'profile' },
  );
  assert.equal(profile.reason, 'задан профилем');
});

test('doctor предупреждает, когда проверки по очереди не укладываются в runTimeoutMs', () => {
  const base = config({
    gates: [
      { id: 'lint', kind: 'check', command: ['node', '--version'], timeoutMs: 30000 },
      {
        id: 'test',
        kind: 'test',
        command: ['node', '--test'],
        timeoutMs: 30000,
        report: { type: 'junit', path: '.reports/junit.xml' },
      },
    ],
  });
  assert.equal(gateTimeoutCheck({ ...base, runTimeoutMs: 100000 }), undefined);
  // Нижний предел поднимает каждую проверку до 60 с: 120 с больше 100 с.
  const warning = gateTimeoutCheck({ ...base, runTimeoutMs: 100000, gateTimeoutFloorMs: 60000 });
  assert.equal(warning?.status, 'degraded');
  assert.equal(warning?.id, 'gates:timeout');
  assert.match(warning?.detail ?? '', /компонента main по очереди займут до 2 мин/);
  assert.match(warning?.detail ?? '', /runTimeoutMs 1\.7 мин/);
  assert.match(warning?.detail ?? '', /нижняя граница/);
  // Совместные проверки workspace: 3 × 30 с укладываются в 150 с, пока
  // нижний предел не поднял каждую до 60 с; проверки компонента (2 × 60 с) —
  // укладываются, и предупреждение называет только workspace.
  const joint = config({
    gates: base.gates,
    workspaceGates: ['a', 'b', 'c'].map((id) => ({
      id: 'joint-' + id,
      repositoryId: 'main',
      kind: 'check' as const,
      command: ['node', '--version'],
      timeoutMs: 30000,
      artifacts: [],
    })),
  });
  assert.equal(gateTimeoutCheck({ ...joint, runTimeoutMs: 150000 }), undefined);
  const jointWarning = gateTimeoutCheck({
    ...joint,
    runTimeoutMs: 150000,
    gateTimeoutFloorMs: 60000,
  });
  assert.equal(jointWarning?.status, 'degraded');
  assert.match(jointWarning?.detail ?? '', /workspace \(совместные\) по очереди займут до 3 мин/);
  assert.doesNotMatch(jointWarning?.detail ?? '', /компонента main/);
});

test('быстрый setup пишет срок фазы по проверкам и сохраняет уже заданный срок', () =>
  withTestHome(async () => {
    const root = temp();
    try {
      repository(root);
      chooseWorkspaceMode(root, 'embedded');
      const longGates = [
        {
          id: 'install',
          kind: 'check',
          command: ['pnpm', 'install', '--frozen-lockfile'],
          timeoutMs: 600000,
        },
        { id: 'typecheck', kind: 'check', command: ['node', '--version'], timeoutMs: 600000 },
        {
          id: 'unit-tests',
          kind: 'test',
          command: ['node', '--test'],
          timeoutMs: 900000,
          report: { type: 'junit', path: '.reports/junit.xml' },
        },
      ];
      const input = {
        repository: root,
        workspace: root,
        profile: 'pnpm-project',
        quick: true,
        gates: longGates,
      };
      const plan = await planSetup(input);
      assert.equal(plan.refusal, undefined);
      // Проверки 35 мин и повтор самой долгой 15 мин: 50 мин + 12,5 → 63 мин.
      assert.equal(plan.runTimeout.gatesMs, 2_100_000);
      assert.equal(plan.runTimeout.phaseMs, 3_000_000);
      assert.deepEqual(
        { ms: plan.runTimeout.ms, source: plan.runTimeout.source },
        { ms: 3_780_000, source: 'gates' },
      );
      await setupProject(input);
      const configPath = join(root, '.devcontour-local/config.json');
      assert.equal(loadConfig(configPath).runTimeoutMs, 3_780_000);
      // Оператор задал свой срок: повторный setup его сохраняет и называет.
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      raw.runTimeoutMs = 3_000_000;
      writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');
      const again = await planSetup(input);
      assert.deepEqual(
        { ms: again.runTimeout.ms, source: again.runTimeout.source },
        { ms: 3_000_000, source: 'existing' },
      );
      await setupProject(input);
      assert.equal(loadConfig(configPath).runTimeoutMs, 3_000_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }));

test('срок фазы — по проверкам сохранённого файла компонента; без gates в файле — без проверок', () =>
  withTestHome(async () => {
    const root = temp();
    try {
      const longComponent = {
        ...committedComponent,
        gates: [
          { id: 'package-policy', kind: 'check', command: ['node', '--version'], timeoutMs: 60000 },
          {
            id: 'root-test',
            kind: 'test',
            command: ['node', '--test'],
            timeoutMs: 1_800_000,
            report: { type: 'junit', path: '.reports/junit.xml' },
          },
        ],
      };
      repository(root, {
        'devcontour.component.json': JSON.stringify(longComponent, null, 2) + '\n',
      });
      chooseWorkspaceMode(root, 'embedded');
      // Предложение короткое, но действует файл компонента: его 31 мин и повтор 30 мин.
      const plan = await planSetup({
        repository: root,
        workspace: root,
        profile: 'pnpm-project',
        quick: true,
        gates: proposal,
      });
      assert.equal(plan.refusal, undefined);
      assert.deepEqual(
        (plan.gates ?? []).map((g) => g.id),
        ['package-policy', 'root-test'],
      );
      assert.equal(plan.runTimeout.gatesMs, 1_860_000);
      assert.equal(plan.runTimeout.phaseMs, 3_660_000);
      assert.equal(plan.runTimeout.source, 'gates');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    const bare = temp();
    try {
      const withoutGates: Record<string, unknown> = { ...committedComponent };
      delete withoutGates.gates;
      repository(bare, {
        'devcontour.component.json': JSON.stringify(withoutGates, null, 2) + '\n',
      });
      chooseWorkspaceMode(bare, 'embedded');
      const plan = await planSetup({
        repository: bare,
        workspace: bare,
        profile: 'pnpm-project',
        quick: true,
        gates: proposal,
      });
      // План и срок — из одного источника: файл без gates, проверок нет.
      assert.deepEqual(plan.gates, []);
      assert.equal(plan.runTimeout.gatesMs, 0);
      assert.equal(plan.runTimeout.source, 'default');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  }));
