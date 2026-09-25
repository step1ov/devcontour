import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requirementProof, unprovenRequirements } from '../src/core/proof.ts';
import { junitSummary } from '../src/runner/gates.ts';
import { redactor } from '../src/runner/redaction.ts';
import type { Evidence } from '../src/core/model.ts';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { setupDemo } from '../src/demo.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { updateBase } from '../src/runner/base-update.ts';
import { git } from '../src/runner/process.ts';
import { acceptBoard } from '../src/runner/agent-control.ts';
import { requirementSnapshot, requirementReport } from '../src/runner/requirements.ts';
import { fixture, input } from './helpers.ts';
import { Workspace } from '../src/core/workspace.ts';
import { completion } from '../src/core/sync-state.ts';
import { adapters, cliArguments, type AgentRequest } from '../src/runner/adapters.ts';
import { isolation, claudeFileDenies, codexPermissions } from '../src/runner/isolation.ts';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function evidence(over: Partial<Evidence> = {}): Evidence {
  return {
    id: 'E1',
    runId: 'R1',
    kind: 'test',
    phase: 'integration',
    sha: SHA,
    gate: 'unit',
    passed: true,
    createdAt: new Date().toISOString(),
    command: ['npm', 'test'],
    exitCode: 0,
    log: '',
    digest: 'd',
    summary: 'ok',
    ...over,
  };
}
const link = { id: 'REQ-1', gate: 'unit', testId: 'cart.total.applies discount' };

test('Подтверждён только тот критерий, чей названный тест выполнился на принятом SHA', () => {
  const proof = requirementProof(
    link,
    [evidence({ tests: [{ id: link.testId, status: 'passed' }] })],
    SHA,
  );
  assert.equal(proof.level, 'testcase');
});

test('Зелёная проверка без связанного теста остаётся прежним, более слабым уровнем', () => {
  // История не переписывается: прежние задачи читаются на своём уровне, и он
  // называется прямо, а не выдаётся за подтверждённый сценарий.
  const proof = requirementProof({ id: 'REQ-1', gate: 'unit' }, [evidence()], SHA);
  assert.equal(proof.level, 'gate');
  assert.match(proof.reason, /не связан с конкретным тестом/);
});

test('Ни посторонний зелёный тест, ни пропуск, ни повтор, ни чужой SHA не подтверждают критерий', () => {
  const cases: [string, Evidence[], string | undefined, RegExp][] = [
    // Зелёная проверка есть, но заявленного теста в ней не было.
    [
      'посторонний тест',
      [evidence({ tests: [{ id: 'cart.total.other', status: 'passed' }] })],
      SHA,
      /не выполнялся/,
    ],
    [
      'пропущенный',
      [evidence({ tests: [{ id: link.testId, status: 'skipped' }] })],
      SHA,
      /skipped/,
    ],
    ['упавший', [evidence({ tests: [{ id: link.testId, status: 'failed' }] })], SHA, /failed/],
    [
      'повтор id',
      [
        evidence({
          tests: [
            { id: link.testId, status: 'passed' },
            { id: link.testId, status: 'passed' },
          ],
        }),
      ],
      SHA,
      /встречается/,
    ],
    [
      'обрезанный манифест',
      [evidence({ tests: [{ id: link.testId, status: 'passed' }], testsTruncated: true })],
      SHA,
      /обрезан/,
    ],
    [
      'другой SHA',
      [evidence({ sha: OTHER, tests: [{ id: link.testId, status: 'passed' }] })],
      SHA,
      /не выполнялась/,
    ],
    [
      'фаза кандидата',
      [evidence({ phase: 'candidate', tests: [{ id: link.testId, status: 'passed' }] })],
      SHA,
      /не выполнялась/,
    ],
    [
      'проверка не прошла',
      [evidence({ passed: false, tests: [{ id: link.testId, status: 'failed' }] })],
      SHA,
      /не прошла/,
    ],
    ['без манифеста', [evidence()], SHA, /не сообщила/],
    ['результат не принят', [evidence()], undefined, /не принят/],
  ];
  for (const [name, given, sha, reason] of cases) {
    const proof = requirementProof(link, given, sha);
    assert.equal(proof.level, 'none', name);
    assert.match(proof.reason, reason, name);
  }
});

test('Приёмка спрашивает только те критерии, которые сами назвали свой тест', () => {
  const evidences = [evidence({ tests: [{ id: link.testId, status: 'passed' }] })];
  const full = {
    id: 'REQ-1',
    source: 'docs/spec.md',
    digest: 'f'.repeat(64),
    text: 'Скидка применяется к сумме корзины',
    gate: 'unit',
    scenario: 'Корзина со скидкой',
  };
  assert.deepEqual(unprovenRequirements([{ ...full, testId: link.testId }], evidences, SHA), []);
  assert.deepEqual(
    unprovenRequirements([full], evidences, SHA),
    [],
    'прежний уровень не спрашивается',
  );
  assert.equal(
    unprovenRequirements([{ ...full, testId: 'cart.total.missing' }], evidences, SHA).length,
    1,
  );
});

test('Манифест собирается из отчёта проверки с исходами каждого testcase', () => {
  const xml = `<?xml version="1.0"?>
<testsuite tests="3" failures="1" skipped="1">
  <testcase classname="cart.total" name="applies discount"/>
  <testcase classname="cart.total" name="rejects negative"><failure message="boom"/></testcase>
  <testcase classname="cart.total" name="pending"><skipped/></testcase>
</testsuite>`;
  const summary = junitSummary(xml);
  assert.deepEqual(summary.cases, [
    { id: 'cart.total.applies discount', status: 'passed' },
    { id: 'cart.total.rejects negative', status: 'failed' },
    { id: 'cart.total.pending', status: 'skipped' },
  ]);
  assert.equal(summary.truncated, false);
  // Повреждённый отчёт не даёт манифеста вовсе.
  assert.throws(() => junitSummary('<testsuite'), /Некорректный JUnit/);
});

test('Манифест на пределе размера помечается обрезанным и не подтверждает отсутствующий тест', () => {
  // Предел — 2000 testcases. На пределе список полон; за ним обрезан, и
  // отсутствие теста по такому списку не доказать.
  const report = (count: number) =>
    '<testsuite>' +
    Array.from({ length: count }, (_, i) => `<testcase name="case-${i}"/>`).join('') +
    '</testsuite>';
  const full = junitSummary(report(2000));
  assert.equal(full.cases.length, 2000);
  assert.equal(full.truncated, false);
  const over = junitSummary(report(2001));
  assert.equal(over.cases.length, 2000);
  assert.equal(over.truncated, true);
  assert.equal(over.tests, 2001, 'счётчик считает все выполненные testcases');
  const proof = requirementProof(
    { id: 'REQ-1', gate: 'unit', testId: 'case-2000' },
    [evidence({ tests: over.cases, testsTruncated: true })],
    SHA,
  );
  assert.equal(proof.level, 'none');
  assert.match(proof.reason, /обрезан/);
});

test('На настоящем прогоне приёмка требует именно названный тест', async () => {
  // Проверка идёт через реальный gate с отчётом JUnit: манифест собирается из
  // того, что действительно выполнилось, а не подставляется в evidence руками.
  const root = await mkdtemp(join(tmpdir(), 'devcontour-proof-'));
  await setupDemo(root);
  const config = loadConfig(join(root, 'config.json'));
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, config);
  try {
    store.change('fixture.reset', (s) => {
      s.tasks = [];
      s.boards = [];
      s.runs = [];
    });
    await mkdir(join(config.repository, 'docs'), { recursive: true });
    await writeFile(
      join(config.repository, 'docs/spec.md'),
      '## REQ-catalog: Catalogue\nList the catalogue.\n',
    );
    await git(config.repository, 'add', 'docs/spec.md');
    await git(config.repository, 'commit', '-m', 'Specify catalogue');
    await git(config.repository, 'update-ref', 'refs/heads/' + config.targetBranch, 'HEAD');
    const snapshot = requirementSnapshot(config.repository, 'docs/spec.md');
    const board = h.createBoard('Traceable catalogue');
    const task = h.addTask(board.id, {
      ...input(),
      requirements: [
        {
          ...snapshot.requirements[0],
          source: snapshot.source,
          gate: config.gates[0].id,
          scenario: 'Catalogue listing',
          testId: 'current-task-result',
        },
      ],
    });
    h.approve(board.id);
    const scheduler = new Scheduler(h, root);
    await scheduler.init();
    await updateBase(config, root);
    h.pause(false);
    await scheduler.drain();
    assert.equal(store.read().tasks[0].status, 'done');

    // Манифест пришёл из отчёта настоящей проверки.
    const run = store.read().runs.findLast((r) => r.taskId === task.id)!;
    const proved = run.evidence.find(
      (e) => e.gate === config.gates[0].id && e.phase === 'integration',
    )!;
    assert.deepEqual(
      proved.tests?.map((t) => t.id),
      ['dependency-artifacts', 'current-task-result'],
    );

    // Критерий называет тест, которого в отчёте нет: приёмка отказывает.
    store.change('fixture.rename', (s) => {
      s.tasks[0].requirements![0].testId = 'scenario-nobody-ran';
    });
    await assert.rejects(() => acceptBoard(h, board.id, 'codex'), /не подтверждён/);
    assert.equal(store.read().boards[0].revisions.at(-1)!.status, 'active');

    // Названный тест действительно выполнился — приёмка проходит.
    store.change('fixture.restore', (s) => {
      s.tasks[0].requirements![0].testId = 'current-task-result';
    });
    await acceptBoard(h, board.id, 'codex');
    assert.equal(store.read().boards[0].revisions.at(-1)!.status, 'accepted');

    const report = requirementReport(h, 'main');
    assert.equal(report.tasks[0].requirements[0].proof, 'testcase');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Ревьюер запускает проверки одинаково в обоих рантаймах и только по профилю', () => {
  // Возможности разошлись: codex получал shell по умолчанию, а claude-ревьюер
  // был ограничен чтением и не мог выполнить ни одной проверки — независимое
  // ревью сводилось к чтению diff. Право даётся явно и одинаково.
  const base = {
    runtime: 'claude' as const,
    mcp: {},
    claudeAllowedTools: [],
    codexShell: false,
    codexNetwork: false,
  };
  const request = (profile: typeof base & { claudeTools?: string[] }) =>
    cliArguments(
      'claude',
      {
        review: true,
        toolProfile: profile,
        prompt: 'p',
        cwd: '/tmp',
        artifactDir: '/tmp',
        task: {} as never,
        signal: new AbortController().signal,
        timeoutMs: 1000,
      } as never,
      '/tmp/schema.json',
      '/tmp/result.json',
    );

  const reading = request({ ...base, claudeTools: ['Read', 'Glob', 'Grep'] });
  const tools = reading[reading.indexOf('--tools') + 1];
  assert.equal(tools.includes('Bash'), false, 'без права проверок shell не даётся');
  assert.match(reading[reading.indexOf('--disallowedTools') + 1], /Bash/);

  const running = request({ ...base, claudeTools: ['Read', 'Glob', 'Grep', 'Bash'] });
  assert.match(running[running.indexOf('--tools') + 1], /Bash/, 'профиль дал право проверок');
  const denied = running[running.indexOf('--disallowedTools') + 1];
  assert.equal(denied.includes('Bash'), false);
  // Править проверяемый код нельзя в любом случае: это запрет инструмента,
  // а сверх него — сверка worktree и HEAD после ревью.
  for (const forbidden of ['Edit', 'Write', 'NotebookEdit'])
    assert.match(denied, new RegExp(forbidden));

  // Сверка worktree не видит записи за его пределами, чтения секретов и сети.
  // Shell ревьюера исполняется в песочнице ОС, как у codex read-only, и не
  // может из неё выйти или запуститься без неё.
  const settings = JSON.parse(running[running.indexOf('--settings') + 1]);
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.failIfUnavailable, true);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(settings.sandbox.network.allowedDomains, []);
  assert.deepEqual(settings.sandbox.filesystem.denyWrite, [realpathSync('/tmp')]);
  // Живой запуск показал, что песочница по умолчанию читает $HOME: каталоги
  // учётных данных закрываются явно.
  for (const path of ['.ssh', '.aws', '.config/gh', '.npmrc'])
    assert.ok(settings.sandbox.filesystem.denyRead.includes(join(homedir(), path)), path);
  // Настройки пользователя не подмешиваются и не ослабляют песочницу.
  assert.equal(running[running.indexOf('--setting-sources') + 1], '');
  // Без shell песочница Bash не нужна, но запреты файловых инструментов
  // действуют всегда: песочница Claude Code их не охватывает.
  const readingSettings = JSON.parse(reading[reading.indexOf('--settings') + 1]);
  assert.equal(readingSettings.sandbox, undefined, 'без shell песочница не нужна');
  assert.ok(
    readingSettings.permissions.deny.includes(`Read(/${join(homedir(), '.ssh')}/**)`),
    'Read закрыт для учётных данных и без shell',
  );

  // Codex: ревьюер пишет только во временный каталог, а без права проверок —
  // и без shell, в том числе когда профиля нет вовсе.
  const codex = (toolProfile?: object) => {
    const args = cliArguments(
      'codex',
      {
        review: true,
        toolProfile,
        prompt: 'p',
        cwd: '/tmp',
        artifactDir: '/tmp',
        task: {} as never,
        signal: new AbortController().signal,
        timeoutMs: 1000,
      } as never,
      '/tmp/schema.json',
      '/tmp/result.json',
    );
    return args.join(' ');
  };
  for (const argv of [codex(), codex({ ...base, runtime: 'codex', codexShell: false })]) {
    // Граница — профиль прав; флаг --sandbox codex заставил бы его игнорировать.
    assert.doesNotMatch(argv, /--sandbox/);
    assert.deepEqual(
      [...argv.matchAll(/"([^"]+)"="write"/g)].map((m) => m[1]).filter((p) => p !== ':tmpdir'),
      [],
    );
    assert.match(argv, /features\.shell_tool=false/);
  }
  // Профиль прав codex закрывает учётные данные и у ревьюера, и без профиля
  // инструментов; сеть ревьюеру закрыта.
  for (const argv of [codex(), codex({ ...base, runtime: 'codex', codexShell: true })]) {
    assert.match(argv, /default_permissions="devcontour"/);
    assert.ok(argv.includes(JSON.stringify(join(homedir(), '.ssh')) + '="none"'), argv);
    assert.match(argv, /network=\{enabled=false\}/);
  }
  const shell = codex({ ...base, runtime: 'codex', codexShell: true });
  assert.doesNotMatch(shell, /--sandbox/);
  // Ревьюер с shell не получает на запись ничего, кроме временного каталога.
  assert.deepEqual(
    [...shell.matchAll(/"([^"]+)"="write"/g)].map((m) => m[1]).filter((p) => p !== ':tmpdir'),
    [],
    'проверяемый каталог ревьюеру на запись закрыт',
  );
  assert.match(shell, /features\.shell_tool=true/);
});

test('Намеренно внесённый дефект ловится названным тестом: без этого нет ни done, ни приёмки', async () => {
  // Подтверждение уровня testcase ничего не стоит, если названный тест не
  // замечает сломанного поведения. Здесь тест настоящий: он вызывает то, что
  // написал исполнитель, и пишет в отчёт исход каждого testcase. Исполнитель
  // сначала вносит значимый дефект (вычитание вместо сложения), затем чинит.
  const root = await mkdtemp(join(tmpdir(), 'devcontour-oracle-'));
  await setupDemo(root);
  const config = loadConfig(join(root, 'config.json'));
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, config);
  try {
    store.change('fixture.reset', (s) => {
      s.tasks = [];
      s.boards = [];
      s.runs = [];
    });
    await mkdir(join(config.repository, 'docs'), { recursive: true });
    await writeFile(join(config.repository, 'docs/spec.md'), '## REQ-sum: Sum\nAdd two numbers.\n');
    await writeFile(
      join(config.repository, 'oracle.mjs'),
      `import { writeFile, mkdir } from 'node:fs/promises';
const cases = [];
const check = async (id, fn) => { try { await fn(); cases.push('<testcase name="'+id+'"/>'); } catch (e) { cases.push('<testcase name="'+id+'"><failure message="'+String(e.message).replace(/[<&"]/g,'')+'"/></testcase>'); } };
const { sum } = await import('./sum.mjs').catch(() => ({ sum: () => NaN }));
await check('sum-adds', () => { if (sum(2, 3) !== 5) throw new Error('sum(2,3)='+sum(2,3)); });
await check('sum-module-loads', () => { if (typeof sum !== 'function') throw new Error('no sum'); });
await mkdir('.reports', { recursive: true });
await writeFile(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite>'+cases.join('')+'</testsuite>');
process.exit(cases.some((c) => c.includes('<failure')) ? 1 : 0);
`,
    );
    await git(config.repository, 'add', '.');
    await git(config.repository, 'commit', '-m', 'Specify sum and its oracle');
    await git(config.repository, 'update-ref', 'refs/heads/' + config.targetBranch, 'HEAD');
    config.gates = [
      {
        ...config.gates[0],
        id: 'oracle',
        command: [process.execPath, 'oracle.mjs'],
        report: { type: 'junit', path: '.reports/oracle.xml' },
      },
    ];
    const snapshot = requirementSnapshot(config.repository, 'docs/spec.md');
    const board = h.createBoard('Sum with oracle');
    const task = h.addTask(board.id, {
      ...input(),
      requirements: [
        {
          ...snapshot.requirements[0],
          source: snapshot.source,
          gate: 'oracle',
          scenario: 'Two numbers are added',
          testId: 'sum-adds',
        },
      ],
    });
    h.approve(board.id);
    let body = 'export const sum = (a, b) => a - b;\n';
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
          await writeFile(join(r.cwd, 'sum.mjs'), body);
          return {
            data: { completed: true, summary: 'Implemented sum' },
            log: 'fixture',
            command: ['fixture'],
          };
        },
      },
    };
    const scheduler = new Scheduler(h, root, runtimes);
    await scheduler.init();
    await updateBase(config, root);
    h.pause(false);
    await scheduler.drain();

    // Дефект пойман: задача не done, отказ называет упавший сценарий, и
    // одобрившее ревью этого не отменяет.
    let state = store.read();
    assert.equal(state.tasks[0].status, 'failed');
    assert.equal(state.tasks[0].failureKind, 'gate');
    assert.match(state.tasks[0].failure!, /sum-adds/);
    await assert.rejects(() => acceptBoard(h, board.id, 'codex'));
    assert.notEqual(store.read().boards[0].revisions.at(-1)!.status, 'accepted');

    // Исправленная реализация проходит, и критерий подтверждён тем же тестом.
    body = 'export const sum = (a, b) => a + b;\n';
    h.retry(task.id);
    h.pause(false);
    await scheduler.drain();
    state = store.read();
    assert.equal(state.tasks[0].status, 'done', state.tasks[0].failure);
    await acceptBoard(h, board.id, 'codex');
    assert.equal(requirementReport(h, 'main').tasks[0].requirements[0].proof, 'testcase');
    await scheduler.stop();
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Задача без названного testcase не публикуется и не открывает зависимые', async () => {
  // Отказ при приёмке доски был поздним: задача уже получила done, её
  // результат лежал в целевой ветке, и зависимая задача работала поверх
  // неподтверждённого результата. Тест назван с момента утверждения.
  const root = await mkdtemp(join(tmpdir(), 'devcontour-admission-'));
  await setupDemo(root);
  const config = loadConfig(join(root, 'config.json'));
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, config);
  try {
    store.change('fixture.reset', (s) => {
      s.tasks = [];
      s.boards = [];
      s.runs = [];
    });
    await mkdir(join(config.repository, 'docs'), { recursive: true });
    await writeFile(
      join(config.repository, 'docs/spec.md'),
      '## REQ-catalog: Catalogue\nList the catalogue.\n',
    );
    await git(config.repository, 'add', 'docs/spec.md');
    await git(config.repository, 'commit', '-m', 'Specify catalogue');
    await git(config.repository, 'update-ref', 'refs/heads/' + config.targetBranch, 'HEAD');
    const before = await git(config.repository, 'rev-parse', config.targetBranch);
    const snapshot = requirementSnapshot(config.repository, 'docs/spec.md');
    const board = h.createBoard('Traceable catalogue');
    const task = h.addTask(board.id, {
      ...input(),
      requirements: [
        {
          ...snapshot.requirements[0],
          source: snapshot.source,
          gate: config.gates[0].id,
          scenario: 'Catalogue listing',
          testId: 'scenario-nobody-ran',
        },
      ],
    });
    const dependent = h.addTask(board.id, input('Dependent task', [task.id]));
    h.approve(board.id);
    const scheduler = new Scheduler(h, root);
    await scheduler.init();
    await updateBase(config, root);
    h.pause(false);
    await scheduler.drain();
    await scheduler.stop();

    const state = store.read();
    const first = state.tasks.find((t) => t.id === task.id)!;
    assert.equal(first.status, 'failed');
    assert.equal(first.failureKind, 'gate');
    assert.match(first.failure!, /scenario-nobody-ran/);
    assert.equal(first.resultSha, undefined);
    assert.equal(
      await git(config.repository, 'rev-parse', config.targetBranch),
      before,
      'целевая ветка не сдвинута',
    );
    assert.equal(
      state.runs.some((r) => r.taskId === dependent.id),
      false,
      'зависимая задача не выдавалась',
    );
    // Доменная приёмка тоже не обходит правило — ни в обход обёртки.
    assert.throws(() => h.accept(board.id, before), /выполнены|проверки|интеграцию/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Доменная приёмка требует названный testcase, а не только done', () => {
  // Обёртка приёмки проверяла сценарий, а сама доменная операция — нет.
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    f.store.change('fixture.done', (s) => {
      const task = s.tasks.find((x) => x.id === t.id)!;
      task.status = 'done';
      task.resultSha = SHA;
      task.requirements = [{ id: 'REQ-a', gate: 'unit', testId: 'named-case' }] as never;
      s.runs.push({
        id: 'R-fixture',
        taskId: t.id,
        status: 'succeeded',
        evidence: [evidence({ tests: [{ id: 'unrelated', status: 'passed' }] })],
      } as never);
    });
    assert.throws(() => f.h.accept(b.id, SHA), /named-case/);
    assert.notEqual(f.store.read().boards[0].revisions.at(-1)!.status, 'accepted');
  } finally {
    f.cleanup();
  }
});

test('Исполнитель получает ту же границу: свой worktree на запись, контур и учётные данные закрыты', () => {
  const request = (runtime: 'claude' | 'codex', toolProfile?: object) =>
    cliArguments(
      runtime,
      {
        review: false,
        toolProfile,
        prompt: 'p',
        cwd: '/tmp',
        artifactDir: '/tmp',
        task: {} as never,
        signal: new AbortController().signal,
        timeoutMs: 1000,
        isolation: isolation({ write: ['/tmp'], controller: ['/var/devcontour-data'] }),
      } as never,
      '/tmp/schema.json',
      '/tmp/result.json',
    );
  const profile = { mcp: {}, claudeAllowedTools: [], codexShell: true, codexNetwork: false };
  const claude = request('claude', {
    ...profile,
    runtime: 'claude',
    claudeTools: ['Read', 'Bash'],
  });
  const sandbox = JSON.parse(claude[claude.indexOf('--settings') + 1]).sandbox;
  assert.deepEqual(sandbox.filesystem.allowWrite, [realpathSync('/tmp')]);
  assert.ok(sandbox.filesystem.denyRead.includes('/var/devcontour-data'));
  assert.equal(sandbox.filesystem.denyWrite, undefined, 'исполнитель пишет в свой worktree');
  // Без Bash песочница не нужна: писать исполнитель может только инструментами.
  const noShell = request('claude');
  const noShellSettings = JSON.parse(noShell[noShell.indexOf('--settings') + 1]);
  assert.equal(noShellSettings.sandbox, undefined);
  // Каталог контура — предок worktree: правило для него закрыло бы и сам
  // worktree, поэтому оно не ставится; закрыты учётные данные.
  assert.equal(
    noShellSettings.permissions.deny.some((r: string) => r.includes('/var/devcontour-data')),
    true,
    'каталог контура, не являющийся предком worktree, закрыт для Read',
  );

  const codex = request('codex', { ...profile, runtime: 'codex', codexNetwork: true }).join(' ');
  assert.doesNotMatch(codex, /--sandbox/);
  assert.ok(codex.includes('"/var/devcontour-data"="none"'), codex);
  assert.ok(codex.includes(JSON.stringify(realpathSync('/tmp')) + '="write"'), codex);
  assert.match(codex, /network=\{enabled=true\}/, 'сеть исполнителя — по профилю');
});

test('Имя, изменённое redaction или хешем, не подтверждает критерий', () => {
  // Redacted-имя `case-[REDACTED]` совпало бы с таким же testId постановки,
  // хотя теста с этим именем никто не запускал. Длинное имя заменяется
  // хешем: обрезка дала бы коллизии и ложные совпадения.
  const redact = redactor([
    'SYNTHETIC_PRIVATE_442211',
    'SYNTHETIC_MULTILINE_PRIVATE\nSECOND_LINE_1234',
  ]);
  const long = (tail: string) => 'p'.repeat(1001) + tail;
  const summary = junitSummary(
    '<testsuite>' +
      '<testcase name="case-SYNTHETIC_PRIVATE_442211"/>' +
      `<testcase name="${long('a')}"/><testcase name="${long('b')}"/>` +
      '<testcase classname="auth" name="multi"><failure><![CDATA[SYNTHETIC_MULTILINE_PRIVATE\nSECOND_LINE_1234]]></failure></testcase>' +
      '<testcase name="plain"/>' +
      '</testsuite>',
    redact,
  );
  const byId = new Map(summary.cases.map((c) => [c.id, c]));
  assert.equal(byId.get('case-[REDACTED]')?.opaque, true);
  assert.equal(byId.get('plain')?.opaque, undefined, 'обычное имя остаётся сопоставимым');
  const hashed = summary.cases.filter((c) => c.id.startsWith('sha256:'));
  assert.equal(hashed.length, 2);
  assert.notEqual(hashed[0].id, hashed[1].id, 'разные длинные имена не сливаются');
  assert.ok(hashed.every((c) => c.opaque && c.id.length <= 1000));
  // Многострочный секрет не остаётся ни целиком, ни частями.
  const text = JSON.stringify(summary);
  for (const piece of [
    'SYNTHETIC_MULTILINE_PRIVATE',
    'SECOND_LINE_1234',
    'SYNTHETIC_PRIVATE_442211',
  ])
    assert.equal(text.includes(piece), false, piece);

  const proof = requirementProof(
    { id: 'REQ-1', gate: 'unit', testId: 'case-[REDACTED]' },
    [evidence({ tests: summary.cases })],
    SHA,
  );
  assert.equal(proof.level, 'none');
  assert.match(proof.reason, /redaction/);
  assert.equal(
    requirementProof(
      { id: 'REQ-2', gate: 'unit', testId: 'plain' },
      [evidence({ tests: summary.cases })],
      SHA,
    ).level,
    'testcase',
  );
});

test('Смена изоляции — другой договор исполнения: активный прогон отвергается, история читается', () => {
  // Раньше изоляция не входила в policy digest: прогон, начатый в песочнице,
  // продолжался после её снятия, и evidence не различало условия.
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('worker')!;
    const before = f.h.policyDigest('main');
    const workspace = new Workspace(f.h).policyDigest();
    f.h.config.isolation = { mode: 'none', domains: ['example.com'] };
    assert.notEqual(f.h.policyDigest('main'), before);
    assert.notEqual(new Workspace(f.h).policyDigest(), workspace);
    assert.throws(() => f.h.heartbeat(run.id, run.token));

    // Задача, завершённая прежней версией, записала договор без изоляции.
    // Её receipt восстанавливается по нему и ничего не выдаёт за песочницу.
    f.h.config.isolation = { mode: 'os', domains: [] };
    f.store.change('fixture.legacy-done', (s) => {
      const task = s.tasks.find((x) => x.id === t.id)!;
      const stored = s.runs.find((r) => r.id === run.id)!;
      Object.assign(stored, {
        status: 'succeeded',
        policyDigest: f.h.policyDigest('main', true),
        requiredGates: undefined,
        candidateSha: SHA,
        integrationSha: OTHER,
        finishedAt: new Date().toISOString(),
        runtime: 'codex',
        reviewer: 'claude',
        evidence: ['candidate', 'integration'].flatMap((phase) =>
          ['test', 'independent-review'].map((gate) =>
            evidence({
              kind: gate === 'test' ? 'test' : 'review',
              phase: phase as never,
              sha: phase === 'candidate' ? SHA : OTHER,
              gate,
              digest: 'a'.repeat(64),
            }),
          ),
        ),
      });
      task.status = 'done';
      task.resultSha = OTHER;
    });
    const receipt = completion(f.h, f.store.read(), f.store.read().tasks[0]);
    assert.equal(receipt.policyDigest, f.h.policyDigest('main', true));
    assert.deepEqual(receipt.requiredGates, ['test']);
  } finally {
    f.cleanup();
  }
});

test('Скрытое внутри рабочего каталога закрыто для файловых инструментов claude', () => {
  // Ревью плана идёт прямо в checkout, а база контура в embedded-режиме лежит
  // внутри него. Песочница Bash не охватывает Read/Edit: нужен явный запрет.
  // Предок рабочего каталога не закрывается: иначе закрылся бы и он сам.
  const checkout = realpathSync(tmpdir());
  const policy = isolation({
    write: [],
    controller: [join(checkout, '.devcontour-local'), join(checkout, '..')],
    readable: [checkout],
  });
  const denies = claudeFileDenies(policy, checkout);
  const inside = join(checkout, '.devcontour-local');
  assert.ok(denies.includes(`Read(/${inside}/**)`));
  assert.ok(denies.includes(`Edit(/${inside}/**)`));
  assert.ok(denies.includes(`Read(/${join(homedir(), '.ssh')}/**)`));
  assert.equal(
    denies.some((rule) => rule === `Read(/${realpathSync(join(checkout, '..'))}/**)`),
    false,
    'предок рабочего каталога не закрыт',
  );
});

test('Codex закрывает содержимое скрытого каталога, а не сам каталог над открытым путём', async () => {
  // `none` у codex запрещает и метаданные: закрытый целиком каталог контура
  // над worktree ломал realpath, и `git status` и `node` в worktree падали.
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'devcontour-codex-')));
  try {
    const controller = join(root, 'controller'),
      source = join(root, 'source'),
      worktree = join(controller, 'worktrees', 'R1');
    await mkdir(join(controller, 'worktrees', 'R2'), { recursive: true });
    await mkdir(worktree, { recursive: true });
    await mkdir(join(source, '.git'), { recursive: true });
    await writeFile(join(controller, 'state.sqlite'), 'db');
    await writeFile(join(source, 'SOURCE.txt'), 'src');
    const argv = codexPermissions(
      isolation({
        write: [worktree],
        controller: [controller, source],
        readable: [join(source, '.git')],
      }),
      false,
    ).join(' ');
    const level = (path: string) =>
      new RegExp(`${JSON.stringify(path).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}="(\\w+)"`).exec(
        argv,
      )?.[1];
    assert.equal(level(controller), undefined, 'предок worktree не закрыт целиком');
    assert.equal(level(join(controller, 'state.sqlite')), 'none');
    assert.equal(level(join(controller, 'worktrees', 'R2')), 'none', 'чужой worktree закрыт');
    assert.equal(level(worktree), 'write');
    assert.equal(level(join(source, 'SOURCE.txt')), 'none');
    assert.equal(level(join(source, '.git')), 'read');
    // База и журналы контура закрыты и тогда, когда появятся после старта.
    for (const late of ['state.sqlite-wal', 'artifacts', 'dependencies'])
      assert.equal(level(join(controller, late)), 'none', late);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Широкое разрешение профиля и скрытое внутри открытого не открывают контур', async () => {
  // Ревью в embedded checkout: база контура внутри открытого cwd. У codex
  // правило none для неё терялось. У claude широкий Read из профиля
  // перекрывал режим прав для каталога контура над worktree.
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'devcontour-bounds-')));
  try {
    const checkout = join(root, 'checkout');
    const controller = join(checkout, '.devcontour-local');
    await mkdir(join(controller, 'worktrees', 'R1'), { recursive: true });
    await writeFile(join(controller, 'state.sqlite'), 'db');
    await writeFile(join(controller, 'journal.txt'), 'log');

    // Codex, embedded review: checkout открыт, база внутри — закрыта.
    const embedded = codexPermissions(
      isolation({ write: [], controller: [controller], readable: [checkout] }),
      false,
    ).join(' ');
    assert.ok(embedded.includes(`${JSON.stringify(controller)}="none"`), embedded);

    // Claude, исполнитель в worktree под каталогом контура с Read в профиле.
    const worktree = join(controller, 'worktrees', 'R1');
    const argv = cliArguments(
      'claude',
      {
        review: false,
        toolProfile: {
          runtime: 'claude',
          mcp: {},
          claudeTools: ['Read', 'Edit'],
          claudeAllowedTools: ['Read', 'Bash(npm test)'],
          codexShell: false,
          codexNetwork: false,
        },
        prompt: 'p',
        cwd: worktree,
        artifactDir: root,
        task: {} as never,
        signal: new AbortController().signal,
        timeoutMs: 1000,
        isolation: isolation({ write: [worktree], controller: [controller], readable: [] }),
      } as never,
      '/tmp/schema.json',
      '/tmp/result.json',
    );
    const allowed = argv[argv.indexOf('--allowedTools') + 1].split(',');
    assert.equal(allowed.includes('Read'), false, 'широкий Read снят');
    assert.ok(allowed.includes('Bash(npm test)'), 'прочие разрешения профиля сохранены');
    const deny = JSON.parse(argv[argv.indexOf('--settings') + 1]).permissions.deny as string[];
    for (const file of ['state.sqlite', 'journal.txt'])
      assert.ok(deny.includes(`Read(/${join(controller, file)})`), file);
    assert.equal(
      deny.some((rule) => rule.startsWith(`Read(/${worktree}`)),
      false,
      'свой worktree не закрыт',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
