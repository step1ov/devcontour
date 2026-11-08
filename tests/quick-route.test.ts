import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { get } from 'node:http';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Preparation, validatePreparation } from '../src/core/preparation.ts';
import { preparationStore, startWorkspace } from '../src/runner/start.ts';
import { chooseWorkspaceMode } from '../src/runner/workspace-mode.ts';
import { planSetup, setupProject } from '../src/runner/setup.ts';
import {
  leadActivityAt,
  markQuickSetup,
  quickFacts,
  quickSetupApplied,
  quickSteps,
  type QuickFacts,
  type QuickStep,
} from '../src/runner/quick.ts';
import { loadConfig } from '../src/runner/config.ts';
import { approvePreparation, architecture, approveStage, product } from './preparation-fixture.ts';
import { withTestHome } from './helpers.ts';

const cli = resolve('src/cli.ts');
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Quick Test',
  GIT_AUTHOR_EMAIL: 'quick@example.test',
  GIT_COMMITTER_NAME: 'Quick Test',
  GIT_COMMITTER_EMAIL: 'quick@example.test',
};
const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env }).trim();
const temp = () => realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-quick-')));
/**
 * GET JSON по новому соединению без keep-alive. Нужен после `spawnSync`:
 * сервер работает в процессе теста, и синхронный дочерний процесс блокирует
 * его цикл событий вместе с клиентом. Под нагрузкой CLI идёт дольше
 * keep-alive сервера (5 с): после разблокировки `fetch` берёт из пула
 * прежний сокет, а просроченный таймер сервера закрывает его уже с
 * запросом внутри — `fetch failed`, `read ECONNRESET`. Новое соединение
 * не зависит от состояния пула.
 */
const getFresh = (url: string) =>
  new Promise<unknown>((resolveBody, reject) => {
    get(url, { agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) reject(new Error(`GET ${url}: ${res.statusCode} ${body}`));
        else {
          try {
            resolveBody(JSON.parse(body));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });

/** Существующий npm- или pnpm-репозиторий с собственными проверками и коммитом. */
function repository(root: string, manager: 'npm' | 'pnpm' = 'npm') {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'existing-app',
        private: true,
        scripts: { test: 'node --test', lint: 'node --check src/index.js' },
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(
    join(root, manager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml'),
    manager === 'npm'
      ? '{"name":"existing-app","lockfileVersion":3,"packages":{}}\n'
      : "lockfileVersion: '9.0'\n",
  );
  writeFileSync(join(root, 'src/index.js'), 'export const add = (a, b) => a + b;\n');
  writeFileSync(join(root, 'AGENTS.md'), '# Own rules\nKeep them.\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'existing project');
}

const intake = (repository: string, requestKey = 'quick-request-1') => ({
  requestKey,
  title: 'Сумма с отрицательными числами',
  repository,
  brief: 'add() должен корректно складывать отрицательные числа',
  criterion: 'add(-2, -3) возвращает -5',
});

/** Компактная цепочка: продукт, архитектура и неприменимость дизайна. */
function approveQuick(p: Preparation, changeId: string) {
  p.execute('preparation_product', {
    changeId,
    expectedDigest: null,
    reason: 'Компактная постановка',
    content: product,
  });
  approveStage(p, changeId, 'product');
  p.execute('preparation_architecture', {
    changeId,
    expectedDigest: null,
    reason: 'Существующий стек',
    content: architecture,
  });
  approveStage(p, changeId, 'architecture');
  p.execute('preparation_references', {
    changeId,
    expectedDigest: null,
    reason: 'Изменение без интерфейса',
    content: {
      applicable: false,
      reason: 'Изменение функции без интерфейса',
      summary: '',
      questions: [],
    },
  });
  approveStage(p, changeId, 'references');
}

const gates = [
  { id: 'install', kind: 'check', command: ['npm', 'ci'], timeoutMs: 600000 },
  {
    id: 'unit-tests',
    kind: 'test',
    command: [
      'node',
      '--test',
      '--test-reporter=junit',
      '--test-reporter-destination=.reports/junit.xml',
    ],
    timeoutMs: 240000,
    dependsOn: ['install'],
    report: { type: 'junit', path: '.reports/junit.xml' },
  },
];

function snapshot(root: string) {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (r === '.devcontour-local') continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path, r);
      else
        out[r] =
          createHash('sha256').update(readFileSync(path)).digest('hex') +
          ':' +
          statSync(path).mtimeMs;
    }
  };
  walk(root, '');
  return out;
}

test('D01-B: повтор поручения возвращает то же изменение; другой payload под ключом — отказ', () =>
  withTestHome(() => {
    const root = temp();
    const store = preparationStore(join(root, '.devcontour-local'));
    try {
      const operator = new Preparation(store, 'operator');
      const first = operator.execute('preparation_quick', intake(root));
      const again = operator.execute('preparation_quick', intake(root));
      assert.ok(first.enabled && again.enabled);
      assert.equal(again.activeChangeId, first.activeChangeId);
      assert.equal((again as { changeId?: string }).changeId, first.activeChangeId);
      const state = store.read().preparation!;
      assert.equal(state.changes.length, 1);
      assert.equal(state.changes[0].intake!.actor, 'operator');
      assert.throws(
        () =>
          operator.execute('preparation_quick', { ...intake(root), criterion: 'другое условие' }),
        /Ключ запроса уже использован/,
      );
      // Ведущий агент вводит своё поручение под своим ключом и своим происхождением.
      new Preparation(store).execute('preparation_quick', intake(root, 'lead-request-1'));
      assert.equal(store.read().preparation!.changes[1].intake!.actor, 'lead');
      assert.equal(store.read().preparation!.changes.length, 2);
      // Повтор после переключения активного изменения называет своё изменение.
      const replay = operator.execute('preparation_quick', intake(root)) as { changeId?: string };
      assert.equal(replay.changeId, state.changes[0].id);
      return Promise.resolve();
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }));

test('D01: предложение setup — CAS, проверка gates и неизменяемая история; расширение сохраняет ввод', () =>
  withTestHome(() => {
    const root = temp();
    const store = preparationStore(join(root, '.devcontour-local'));
    try {
      const p = new Preparation(store);
      const view = p.execute('preparation_quick', intake(root));
      const changeId = view.enabled ? view.activeChangeId! : '';
      assert.throws(
        () =>
          p.execute('preparation_setup', {
            changeId,
            expectedDigest: null,
            profile: 'npm-project',
            gates: [{ id: 'x', kind: 'test' }],
            reason: 'Неполный gate',
          }),
        /Gates предложения/,
      );
      p.execute('preparation_setup', {
        changeId,
        expectedDigest: null,
        profile: 'npm-project',
        gates,
        reason: 'Проверки проекта',
      });
      const first = store.read().preparation!.changes[0].setup![0];
      assert.throws(
        () =>
          p.execute('preparation_setup', {
            changeId,
            expectedDigest: null,
            profile: 'npm-project',
            reason: 'Повтор без digest',
          }),
        /изменилось/,
      );
      p.execute('preparation_setup', {
        changeId,
        expectedDigest: first.digest,
        profile: 'npm-project',
        reason: 'Gates профиля',
      });
      assert.equal(store.read().preparation!.changes[0].setup!.length, 2);
      // Подмена истории (например, пришедшая синхронизацией) отклоняется проверкой состояния.
      const before = store.read();
      const tampered = structuredClone(before);
      tampered.preparation!.changes[0].intake!.criterion = 'подменено';
      assert.throws(() => validatePreparation(tampered, before), /неизменяема/);
      const dropped = structuredClone(before);
      dropped.preparation!.changes[0].setup!.shift();
      assert.throws(() => validatePreparation(dropped, before), /setup|неизменяема/);
      // Обычное изменение без поручения не получает предложения setup.
      p.execute('preparation_create', { title: 'Полный маршрут' });
      const full = store.read().preparation!.activeChangeId!;
      assert.throws(
        () =>
          p.execute('preparation_setup', {
            changeId: full,
            expectedDigest: null,
            profile: 'npm-project',
            reason: 'Не тот маршрут',
          }),
        /быстрого изменения/,
      );
      p.execute('preparation_expand', {
        changeId,
        reason: 'Нужны два компонента и зависимые задачи',
      });
      const expanded = store.read().preparation!.changes[0];
      assert.equal(expanded.intake!.criterion, intake(root).criterion);
      assert.equal(expanded.setup!.length, 2);
      assert.match(expanded.expanded!.reason, /два компонента/);
      return Promise.resolve();
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }));

test('D01: факты embedded без ложной «чужой работы»; separate внутри репозитория — отказ', () =>
  withTestHome(async () => {
    const root = temp();
    repository(root);
    chooseWorkspaceMode(root, 'embedded');
    const facts = await quickFacts({ workspace: root, mode: 'embedded', repository: root });
    assert.equal(facts.ready, true, JSON.stringify(facts.diagnostics));
    assert.deepEqual(
      facts.diagnostics.map((d) => d.code),
      [],
    );
    assert.deepEqual(
      facts.profiles.map((x) => x.id),
      ['npm-project'],
    );
    assert.match(facts.profiles[0].digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(facts.facts.checks, ['test', 'lint']);
    // Версия npm из встроенного профиля harness — не требование DevContour.
    const binRoot = temp();
    const bin = join(binRoot, 'bin');
    mkdirSync(bin);
    for (const name of ['git', 'node'])
      symlinkSync(execFileSync('which', [name], { encoding: 'utf8' }).trim(), join(bin, name));
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho 10.0.0\n', { mode: 0o755 });
    const oldNpm = await quickFacts({
      workspace: root,
      mode: 'embedded',
      repository: root,
      env: { ...process.env, PATH: bin },
    });
    assert.equal(oldNpm.facts.tools.find((t) => t.name === 'npm')?.status, 'mismatch');
    assert.ok(!oldNpm.diagnostics.some((d) => d.code === 'tool-version-mismatch'));
    rmSync(binRoot, { recursive: true, force: true });
    // Проекция известного изменения — своя запись; чужой файл рядом — нет.
    mkdirSync(join(root, 'docs/changes/r-001.own'), { recursive: true });
    writeFileSync(join(root, 'docs/changes/README.md'), '# Changes\n');
    writeFileSync(join(root, 'docs/changes/r-001.own/product.md'), '# Own\n');
    const own = await quickFacts({
      workspace: root,
      mode: 'embedded',
      repository: root,
      changeKeys: ['r-001.own'],
    });
    assert.ok(!own.diagnostics.some((d) => d.code === 'dirty-checkout'));
    writeFileSync(join(root, 'docs/changes/notes.md'), 'user notes\n');
    const user = await quickFacts({
      workspace: root,
      mode: 'embedded',
      repository: root,
      changeKeys: ['r-001.own'],
    });
    assert.ok(user.diagnostics.some((d) => d.code === 'dirty-checkout'));
    rmSync(join(root, 'docs/changes/notes.md'));
    // Список изменений усечён: невидимые пути не считаются своими.
    for (let i = 0; i < 60; i++)
      writeFileSync(join(root, `docs/changes/r-001.own/extra-${i}.md`), String(i));
    const many = await quickFacts({
      workspace: root,
      mode: 'embedded',
      repository: root,
      changeKeys: ['r-001.own'],
    });
    assert.ok(many.diagnostics.some((d) => d.code === 'dirty-checkout'));
    rmSync(join(root, 'docs'), { recursive: true, force: true });
    // Чужая незакоммиченная правка остаётся предупреждением.
    writeFileSync(join(root, 'src/index.js'), 'export const add = (a, b) => a - b;\n');
    const dirty = await quickFacts({ workspace: root, mode: 'embedded', repository: root });
    assert.ok(dirty.diagnostics.some((d) => d.code === 'dirty-checkout'));

    const pnpm = temp();
    repository(pnpm, 'pnpm');
    const nested = join(pnpm, 'workspace');
    const separate = await quickFacts({ workspace: nested, mode: 'separate', repository: pnpm });
    assert.equal(separate.ready, false);
    assert.deepEqual(
      separate.diagnostics.map((d) => d.code),
      ['placement-separate'],
    );
    assert.deepEqual(
      separate.profiles.map((x) => x.id),
      ['pnpm-project'],
    );
    const elsewhere = temp();
    const embeddedElsewhere = await quickFacts({
      workspace: elsewhere,
      mode: 'embedded',
      repository: pnpm,
    });
    assert.deepEqual(
      embeddedElsewhere.diagnostics.map((d) => d.code),
      ['placement-embedded'],
    );
    for (const dir of [root, pnpm, elsewhere]) rmSync(dir, { recursive: true, force: true });
  }));

test('D01-D: план setup ничего не пишет, сохраняет файлы пользователя и называет конфликт', () =>
  withTestHome(async () => {
    const root = temp();
    repository(root);
    chooseWorkspaceMode(root, 'embedded');
    const before = snapshot(root);
    const plan = await planSetup({
      repository: root,
      workspace: root,
      profile: 'npm-project',
      quick: true,
      gates,
    });
    assert.deepEqual(snapshot(root), before);
    assert.equal(plan.status, 'plan');
    assert.equal(plan.refusal, undefined);
    const action = (rel: string) => plan.files.find((f) => f.path === join(root, rel))?.action;
    assert.equal(action('AGENTS.md'), 'preserve');
    assert.equal(action('.gitignore'), 'preserve');
    assert.equal(action('.devcontour-local/config.json'), 'create');
    // Путь через symlink — конфликт плана и отказ применения, без записи.
    symlinkSync(tmpdir(), join(root, '.agents'));
    const conflicted = await planSetup({
      repository: root,
      workspace: root,
      profile: 'npm-project',
      quick: true,
    });
    assert.ok(conflicted.files.some((f) => f.action === 'conflict'));
    assert.match(conflicted.refusal ?? '', /symlink/);
    rmSync(root, { recursive: true, force: true });
  }));

test('D7: setup быстрого изменения не привязывает к developer правила контрактов', () =>
  withTestHome(async () => {
    const root = temp();
    try {
      repository(root);
      chooseWorkspaceMode(root, 'embedded');
      await setupProject({
        repository: root,
        workspace: root,
        profile: 'npm-project',
        quick: true,
        gates,
      });
      const config = loadConfig(join(root, '.devcontour-local/config.json'));
      assert.deepEqual(Object.keys(config.roles), ['developer']);
      const bound = config.contextPacks.filter((pack) => pack.roles.includes('developer'));
      // Пакеты роли есть: своя инструкция, общий порядок работы и техника тестов.
      assert.deepEqual(bound.map((pack) => pack.id).sort(), [
        'developer',
        'technique-testing',
        'workflow',
      ]);
      const files = bound.flatMap((pack) => [...pack.files, ...(pack.references ?? [])]);
      assert.ok(files.includes('.agents/roles/developer.md'), files.join(', '));
      // Правила общих API и versioned контекста библиотек требуют контракт,
      // которого у задачи роли без контракта нет: к роли они не привязаны.
      assert.ok(!files.includes('.agents/context/contracts.md'), files.join(', '));
      for (const file of files)
        assert.doesNotMatch(
          readFileSync(join(root, file), 'utf8'),
          /Каждая библиотека поставляет versioned контекст/,
          file,
        );
      // Инструкция роли прямо говорит, что контракт задачи — её тесты.
      assert.match(
        readFileSync(join(root, '.agents/roles/developer.md'), 'utf8'),
        /контракт задачи — её тесты на критерий/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }));

test('D01-C: setup --change отклоняется до согласований и применяет ровно предложение после них', () =>
  withTestHome(async () => {
    const root = temp();
    repository(root, 'pnpm');
    const app = await startWorkspace(root, { port: 0, workspaceMode: 'embedded' });
    try {
      const response = await fetch(app.url + '/api/preparation/quick', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-devcontour-request': '1' },
        body: JSON.stringify(intake(root)),
      });
      assert.equal(response.status, 200);
      const repeat = await fetch(app.url + '/api/preparation/quick', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-devcontour-request': '1' },
        body: JSON.stringify(intake(root)),
      });
      assert.equal(repeat.status, 200);
      const store = preparationStore(join(root, '.devcontour-local'));
      let changeId: string;
      try {
        assert.equal(store.read().preparation!.changes.length, 1);
        changeId = store.read().preparation!.changes[0].id;
        assert.equal(store.read().preparation!.changes[0].intake!.actor, 'operator');
        new Preparation(store).execute('preparation_setup', {
          changeId,
          expectedDigest: null,
          profile: 'pnpm-project',
          gates,
          reason: 'Проверки проекта',
        });
      } finally {
        store.close();
      }
      // CLI quick-facts знает проекцию изменения: свои файлы не «чужая работа».
      // Команда без записи: база состояния побайтно прежняя.
      const stateBefore = readFileSync(join(root, '.devcontour-local', 'state.sqlite'));
      // Файл базы без права записи: команда, открывающая базу на запись, падает.
      chmodSync(join(root, '.devcontour-local', 'state.sqlite'), 0o444);
      const cliFacts = spawnSync(
        process.execPath,
        ['--import', 'tsx', cli, 'quick-facts', '--repository', root, '--workspace', root],
        { encoding: 'utf8', env: process.env },
      );
      assert.equal(cliFacts.status, 0, cliFacts.stderr);
      chmodSync(join(root, '.devcontour-local', 'state.sqlite'), 0o644);
      assert.ok(
        readFileSync(join(root, '.devcontour-local', 'state.sqlite')).equals(stateBefore),
        'quick-facts не пишет в базу',
      );
      assert.deepEqual(
        (JSON.parse(cliFacts.stdout) as QuickFacts).diagnostics.map((d) => d.code),
        [],
      );
      // CLI выше заблокировал цикл событий сервера — запрос по новому соединению.
      const view = (await getFresh(app.url + '/api/preparation/quick?change=' + changeId)) as {
        facts: QuickFacts;
        steps: QuickStep[];
        plan: { refusal?: string };
        lead: { present: boolean };
      };
      assert.equal(view.facts.ready, true, JSON.stringify(view.facts.diagnostics));
      // Проекция изменения в docs/changes и файлы start — свои записи, не чужая работа.
      assert.deepEqual(
        view.facts.diagnostics.map((d) => d.code),
        [],
      );
      assert.deepEqual(
        view.steps.map((s) => [s.id, s.state]),
        [
          ['connection', 'done'],
          ['decisions', 'current'],
          ['preparation', 'waiting'],
          ['execution', 'waiting'],
          ['result', 'waiting'],
        ],
      );
      assert.equal(view.plan.refusal, undefined);
      // Предложение setup только что записал ведущий: он присутствует.
      assert.equal(view.lead.present, true);

      const setup = (...extra: string[]) =>
        spawnSync(
          process.execPath,
          ['--import', 'tsx', cli, 'setup', '--change', changeId, '--workspace', root, ...extra],
          { encoding: 'utf8', env: process.env },
        );
      const early = setup();
      assert.notEqual(early.status, 0);
      assert.match(early.stderr, /согласуйте|продукт/i);
      assert.equal(existsSync(join(root, '.devcontour-local/config.json')), false);

      const approve = preparationStore(join(root, '.devcontour-local'));
      try {
        approveQuick(new Preparation(approve), changeId);
      } finally {
        approve.close();
      }
      const planned = setup('--plan');
      assert.equal(planned.status, 0, planned.stderr);
      assert.equal((JSON.parse(planned.stdout) as { status: string }).status, 'plan');
      assert.equal(existsSync(join(root, '.devcontour-local/config.json')), false);
      // Без digest показанного предложения или с чужим — отказ без записи.
      const blind = setup();
      assert.notEqual(blind.status, 0);
      assert.match(blind.stderr, /--proposal/);
      assert.notEqual(setup('--proposal', 'f'.repeat(64)).status, 0);
      assert.equal(existsSync(join(root, '.devcontour-local/config.json')), false);
      const applied = setup(
        '--proposal',
        (JSON.parse(planned.stdout) as { proposal: string }).proposal,
      );
      assert.equal(applied.status, 0, applied.stderr);
      const result = JSON.parse(applied.stdout) as { status: string; preserved: string[] };
      assert.equal(result.status, 'needs-agent-bootstrap');
      assert.ok(result.preserved.includes(join(root, 'AGENTS.md')));
      assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), '# Own rules\nKeep them.\n');
      const config = loadConfig(join(root, '.devcontour-local/config.json'));
      assert.deepEqual(
        config.repositories[0].gates.map((g) => g.id),
        ['install', 'unit-tests'],
      );
      assert.ok(config.protectedPaths.includes('pnpm-lock.yaml'));
      assert.equal(config.packs[0].id, 'pnpm-project');
      // Отметка применённого setup — этого изменения.
      assert.equal(quickSetupApplied(join(root, '.devcontour-local'), changeId), true);
      // Одна задача быстрого изменения: роль без обязательного контракта.
      assert.deepEqual(Object.keys(config.roles), ['developer']);
      assert.notEqual(config.roles.developer.requiresContract, true);
      // Правила и справка каждого пакета конфигурации уже в дереве: context-lock
      // после bootstrap закрепляет их по файлам.
      for (const pack of config.contextPacks)
        for (const file of [...pack.files, ...(pack.references ?? [])])
          assert.ok(existsSync(join(root, file)), file);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  }));

test('D01-E: шаги — проекция; без ведущего агента нет активного планирования, расширение останавливает быстрый маршрут', () => {
  const change = {
    id: 'PC-1',
    key: 'r-001.quick',
    title: 'Быстрое',
    createdAt: new Date().toISOString(),
    product: [],
    architecture: [],
    references: [],
    concept: [],
    design: [],
    activity: [],
    questions: [],
    decisions: [],
    intake: {
      ...intake('/tmp/x'),
      createdAt: new Date().toISOString(),
      actor: 'operator' as const,
    },
  };
  const steps = quickSteps({
    change,
    developmentReady: false,
    blocker: 'Нужна продуктовая постановка',
    configured: false,
    engineConnected: false,
    tasks: [],
    activeRuns: 0,
    paused: true,
  });
  assert.deepEqual(
    steps.map((s) => [s.id, s.state, s.actor ?? null]),
    [
      ['connection', 'current', 'operator'],
      ['decisions', 'waiting', 'lead'],
      ['preparation', 'waiting', 'lead'],
      ['execution', 'waiting', null],
      ['result', 'waiting', null],
    ],
  );
  const expanded = quickSteps({
    change: { ...change, expanded: { at: new Date().toISOString(), reason: 'Два компонента' } },
    developmentReady: false,
    blocker: '',
    configured: false,
    engineConnected: false,
    tasks: [],
    activeRuns: 0,
    paused: true,
  });
  assert.ok(expanded.every((s) => s.state === 'waiting' && /полным маршрутом/.test(s.detail)));
});

test('D01-C: setup --change проверяет согласования названного изменения, а не активного', () =>
  withTestHome(async () => {
    const root = temp();
    repository(root);
    const app = await startWorkspace(root, { port: 0, workspaceMode: 'embedded' });
    try {
      const store = preparationStore(join(root, '.devcontour-local'));
      let approved: string, quick: string, digest: string;
      try {
        const p = new Preparation(store);
        approved = approvePreparation(p);
        p.execute('preparation_quick', intake(root));
        quick = store.read().preparation!.activeChangeId!;
        p.execute('preparation_setup', {
          changeId: quick,
          expectedDigest: null,
          profile: 'npm-project',
          gates,
          reason: 'Проверки проекта',
        });
        digest = store.read().preparation!.changes.find((c) => c.id === quick)!.setup![0].digest;
        // Активным становится согласованное изменение; быстрое не согласовано.
        p.execute('preparation_activate', { changeId: approved });
      } finally {
        store.close();
      }
      const run = () =>
        spawnSync(
          process.execPath,
          [
            '--import',
            'tsx',
            cli,
            'setup',
            '--change',
            quick,
            '--proposal',
            digest,
            '--workspace',
            root,
          ],
          { encoding: 'utf8', env: process.env },
        );
      const refused = run();
      assert.notEqual(refused.status, 0, refused.stdout);
      assert.match(refused.stderr, /утверд|согласу|продукт/i);
      assert.equal(existsSync(join(root, '.devcontour-local/config.json')), false);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  }));

test('D01-E: «исполнитель работает» — только при идущей попытке; черновик и пауза — ход ведущего агента', () => {
  const change = {
    id: 'PC-2',
    key: 'r-002.quick',
    title: 'Быстрое',
    createdAt: new Date().toISOString(),
    product: [],
    architecture: [],
    references: [],
    concept: [],
    design: [],
    activity: [],
    questions: [],
    decisions: [],
    intake: {
      ...intake('/tmp/x'),
      createdAt: new Date().toISOString(),
      actor: 'operator' as const,
    },
  };
  const execution = (tasks: { status: string }[], activeRuns: number, paused: boolean) =>
    quickSteps({
      change,
      developmentReady: true,
      blocker: '',
      configured: true,
      engineConnected: true,
      tasks,
      activeRuns,
      paused,
    }).find((s) => s.id === 'execution')!;
  const draft = execution([{ status: 'draft' }], 0, true);
  assert.equal(draft.actor, 'lead');
  assert.doesNotMatch(draft.detail, /работает/);
  const paused = execution([{ status: 'ready' }], 0, true);
  assert.equal(paused.actor, 'lead');
  assert.match(paused.detail, /пауз/);
  const held = quickSteps({
    change,
    developmentReady: true,
    blocker: '',
    configured: true,
    engineConnected: true,
    tasks: [{ status: 'ready' }],
    activeRuns: 0,
    paused: true,
    pauseReason: 'base-check',
    baseWait: {
      needsOperator: true,
      detail: 'Перенос меняет AGENTS.md, .agents/roles/developer.md',
    },
  }).find((s) => s.id === 'execution')!;
  // Обычная проверка базы — дело контура: без кнопки и без «вашего подтверждения».
  const checking = quickSteps({
    change,
    developmentReady: true,
    blocker: '',
    configured: true,
    engineConnected: true,
    tasks: [{ status: 'ready' }],
    activeRuns: 0,
    paused: true,
    pauseReason: 'base-check',
    baseWait: { needsOperator: false, detail: 'Проверка базы' },
  }).find((s) => s.id === 'execution')!;
  assert.equal(checking.actor, undefined);
  assert.equal(checking.action, undefined);
  // Перенос контура в базу подтверждает человек, не ведущий агент.
  assert.equal(held.actor, 'operator');
  assert.match(held.detail, /подтверждени.*AGENTS\.md/);
  assert.equal(held.action, 'start-queue');
  const queued = execution([{ status: 'ready' }], 0, false);
  assert.equal(queued.actor, undefined);
  assert.doesNotMatch(queued.detail, /работает/);
  const running = execution([{ status: 'running' }], 1, false);
  assert.match(running.detail, /работает/);
  assert.equal(running.actor, undefined);
  assert.equal(execution([{ status: 'failed' }], 0, false).state, 'blocked');
  assert.equal(execution([{ status: 'done' }], 0, false).state, 'done');
  // Задачу держит вопрос исполнителя: это ожидание ответа того, кто
  // действует по вопросу, а не сбой, который разбирает ведущий агент.
  const asked = (
    questions: Record<string, 'operator' | 'lead'>,
    tasks = [{ id: 'T-1', status: 'failed' }],
  ) =>
    quickSteps({
      change,
      developmentReady: true,
      blocker: '',
      configured: true,
      engineConnected: true,
      tasks,
      questions,
      activeRuns: 0,
      paused: false,
    }).find((s) => s.id === 'execution')!;
  const operator = asked({ 'T-1': 'operator' });
  assert.equal(operator.state, 'current');
  assert.equal(operator.actor, 'operator');
  assert.match(operator.detail, /вопрос/);
  assert.doesNotMatch(operator.detail, /не прошла/);
  const lead = asked({ 'T-1': 'lead' });
  assert.equal(lead.state, 'current');
  assert.equal(lead.actor, 'lead');
  assert.match(lead.detail, /ответ/);
  // Рядом настоящий сбой другой задачи — разбор сбоя ведущим.
  const mixed = asked({ 'T-1': 'operator' }, [
    { id: 'T-1', status: 'failed' },
    { id: 'T-2', status: 'failed' },
  ]);
  assert.equal(mixed.state, 'blocked');
  assert.equal(mixed.actor, 'lead');
});

test('D01-C: setup --change — неактивное изменение и новый блокер репозитория отклоняются без записи', () =>
  withTestHome(async () => {
    const root = temp();
    repository(root);
    const app = await startWorkspace(root, { port: 0, workspaceMode: 'embedded' });
    try {
      const store = preparationStore(join(root, '.devcontour-local'));
      let quick: string, digest: string;
      try {
        const p = new Preparation(store);
        p.execute('preparation_quick', intake(root));
        quick = store.read().preparation!.activeChangeId!;
        approveQuick(p, quick);
        p.execute('preparation_setup', {
          changeId: quick,
          expectedDigest: null,
          profile: 'npm-project',
          gates,
          reason: 'Проверки проекта',
        });
        digest = store.read().preparation!.changes[0].setup![0].digest;
        p.execute('preparation_create', { title: 'Другое изменение' });
      } finally {
        store.close();
      }
      const run = () =>
        spawnSync(
          process.execPath,
          [
            '--import',
            'tsx',
            cli,
            'setup',
            '--change',
            quick,
            '--proposal',
            digest,
            '--workspace',
            root,
          ],
          { encoding: 'utf8', env: process.env },
        );
      // Согласовано, но активно другое изменение.
      const inactive = run();
      assert.notEqual(inactive.status, 0);
      assert.match(inactive.stderr, /активным/);
      const back = preparationStore(join(root, '.devcontour-local'));
      try {
        new Preparation(back).execute('preparation_activate', { changeId: quick });
      } finally {
        back.close();
      }
      // Второй lockfile после показа плана — блокер, перепроверенный при записи.
      writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
      git(root, 'add', 'pnpm-lock.yaml');
      git(root, 'commit', '-qm', 'second lockfile');
      const blocked = run();
      assert.notEqual(blocked.status, 0);
      assert.match(blocked.stderr, /Репозиторий не готов.*lockfile/);
      assert.equal(existsSync(join(root, '.devcontour-local/config.json')), false);
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  }));

test('D01-E: присутствие ведущего — по его записям, не только по журналу', () => {
  const base = {
    id: 'PC-3',
    key: 'r-003.quick',
    title: 'Быстрое',
    createdAt: '2026-11-06T10:00:00.000Z',
    product: [],
    architecture: [],
    references: [],
    concept: [],
    design: [],
    activity: [],
    questions: [],
    decisions: [],
  };
  assert.equal(leadActivityAt(base, []), null);
  const withSetup = {
    ...base,
    activity: [{ at: '2026-11-06T10:01:00.000Z', stage: 'product' as const, note: 'Начал' }],
    setup: [
      {
        number: 1,
        digest: 'a'.repeat(64),
        createdAt: '2026-11-06T10:05:00.000Z',
        profile: 'npm-project',
        reason: 'Проверки проекта',
      },
    ],
  };
  assert.equal(leadActivityAt(withSetup, []), '2026-11-06T10:05:00.000Z');
  assert.equal(
    leadActivityAt(withSetup, [{ createdAt: '2026-11-06T10:09:00.000Z' }]),
    '2026-11-06T10:09:00.000Z',
  );
  // Утверждение плана ведущим — тоже его действие.
  assert.equal(
    leadActivityAt(withSetup, [
      { createdAt: '2026-11-06T10:09:00.000Z', approvedAt: '2026-11-06T10:20:00.000Z' },
    ]),
    '2026-11-06T10:20:00.000Z',
  );
});

test('D01-E: сбой инспекции репозитория — причина в шаге, а не вечная проверка', () => {
  const change = {
    id: 'PC-4',
    key: 'r-004.quick',
    title: 'Быстрое',
    createdAt: new Date().toISOString(),
    product: [],
    architecture: [],
    references: [],
    concept: [],
    design: [],
    activity: [],
    questions: [],
    decisions: [],
    intake: {
      ...intake('/tmp/x'),
      createdAt: new Date().toISOString(),
      actor: 'operator' as const,
    },
  };
  const [connection] = quickSteps({
    change,
    developmentReady: false,
    blocker: '',
    factsError: 'git не найден',
    configured: false,
    engineConnected: false,
    tasks: [],
    activeRuns: 0,
    paused: true,
  });
  assert.equal(connection.state, 'blocked');
  assert.match(connection.detail, /не удалось проверить: git не найден/);
});

test('R4-m4: отметка setup у каждого изменения своя; прежняя отметка читается', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dc-quick-mark-'));
  try {
    assert.equal(quickSetupApplied(dir, 'C-1'), false);
    writeFileSync(
      join(dir, 'quick-setup.json'),
      JSON.stringify({ changeId: 'C-1', proposal: 'a'.repeat(64), at: '2026-11-06T00:00:00.000Z' }),
    );
    assert.equal(quickSetupApplied(dir, 'C-1'), true);
    markQuickSetup(dir, 'C-2', 'b'.repeat(64));
    assert.equal(quickSetupApplied(dir, 'C-1'), true, 'setup второго изменения не стирает первое');
    assert.equal(quickSetupApplied(dir, 'C-2'), true);
    assert.equal(quickSetupApplied(dir, 'C-3'), false);
  } finally {
    assert.ok(dir.includes('dc-quick-mark-'));
    rmSync(dir, { recursive: true, force: true });
  }
});
