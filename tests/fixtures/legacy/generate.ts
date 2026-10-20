/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any --
 * Генератор вызывает код прежней версии из другого checkout: его типов здесь
 * нет, модули загружаются по пути во время запуска.
 */
/**
 * Базы прежней версии DevContour для проверки совместимости (T35).
 *
 * Запускается из checkout прежней версии — состояние пишет её собственный код
 * (`DevContour`, `Store`, `LeadWorkflow`, `Workspace`, `CheckCorpus`,
 * `pinArtifacts`):
 *
 *   cd <checkout прежней версии>
 *   node --import tsx <этот файл> <checkout прежней версии> <ROOT>
 *   cp -R <ROOT>/. tests/fixtures/<вариант>/
 *   npx prettier --write tests/fixtures/<вариант>/{central,component/coordinator}/config.json
 *
 * `<ROOT>` — канонический путь (без символических ссылок) на платформе, где
 * открывается вариант: `tests/fixtures/legacy` — `/tmp/devcontour-legacy-fixture`
 * (Linux), `tests/fixtures/legacy-darwin` — `/private/tmp/devcontour-legacy-fixture`
 * (macOS, где `/tmp` — ссылка). На каноническом пути пути конфигурации — те
 * же, что дал бы загрузчик (`loadConfig` разрешает ссылки): digest политики
 * попыток совпадает с тем, что увидит загрузчик новой версии на этом месте.
 *
 * Выход повторяет tests/fixtures/legacy: central (`central/state.sqlite`,
 * `central/config.json`) и component (`component/coordinator/…` и база
 * компонента `component/app/.devcontour-local/state.sqlite`). Git-репозиторий
 * компонента лежит рядом как `app.git` (каталог `.git` нельзя хранить в
 * репозитории): тест возвращает его на место и восстанавливает рабочее дерево.
 * Абсолютные пути компонента входят в digest политики попыток прежней
 * версии, поэтому тест открывает копию по тому же пути тем же загрузчиком, а
 * не переписывает пути и digest.
 *
 * Где у прежней версии нет операции без живого исполнения (версия корпуса,
 * раунды ревью контракта), запись строится из её же типов и сохраняется её
 * методами (`CheckCorpus.save` + `adopt`, `Store.change`). Записи учёта
 * вызовов проверяются её схемой. Данные вымышленные; SHA принятых задач
 * условные, попытка в окне после update-ref ссылается на настоящие коммиты
 * компонента.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  realpathSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type Any = any;
const [baseline, out] = process.argv.slice(2) as [string, string];
const { Store } = await import(join(baseline, 'src/core/store.ts'));
const service = await import(join(baseline, 'src/core/service.ts'));
const { DevContour, specDigest, scopeDigest, dependencyDigest, contextDigest } = service;
const { effectiveChecks } = await import(join(baseline, 'src/core/checks.ts'));
const { configSchema } = await import(join(baseline, 'src/core/model.ts'));
const { usageSchema } = await import(join(baseline, 'src/core/usage.ts'));
const { LeadWorkflow } = await import(join(baseline, 'src/core/lead-workflow.ts'));
const { Workspace } = await import(join(baseline, 'src/core/workspace.ts'));
const store_ = await import(join(baseline, 'src/core/check-store.ts'));
const { CheckCorpus, corpusFile, caseId, canonicalJson } = store_;
const { pinArtifacts } = await import(join(baseline, 'src/runner/contract-artifacts.ts'));
const fx = await import(join(baseline, 'tests/check-fixture.ts'));

const sha = (c: string) => c.repeat(40);
const digest = (c: string) => c.repeat(64);
const sha256 = (text: string) =>
  execFileSync('shasum', ['-a', '256'], { input: text }).toString().split(' ')[0];
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd })
    .toString()
    .trim();

const unit = {
  id: 'test',
  kind: 'test',
  command: ['node', 'verify.mjs'],
  report: { type: 'junit', path: '.reports/junit.xml' },
};
function config(root: string) {
  const gates = [unit, fx.propertyGate()];
  return configSchema.parse({
    gates,
    version: 1,
    name: 'Legacy fixture v2',
    repository: join(root, 'app'),
    mode: 'demo',
    concurrency: 4,
    maxAttempts: 3,
    isolation: { mode: 'none' },
    roles: { qa: { runtime: 'demo' }, backend: { runtime: 'demo' } },
    reviewer: { runtime: 'demo' },
    workspaceGates: [
      {
        id: 'e2e',
        kind: 'test',
        repositoryId: 'app',
        command: ['node', 'e2e.mjs'],
        report: { type: 'junit', path: '.reports/e2e.xml' },
      },
    ],
    prices: [
      {
        runtime: 'codex',
        model: 'codex-model',
        effectiveAt: at(0),
        input: 1,
        output: 4,
        cacheRead: 0.1,
        cacheWrite: 1,
      },
    ],
    repositories: [{ id: 'app', name: 'App', path: join(root, 'app'), gates }],
  });
}

/** Git-проект компонента с закрепляемыми файлами договора проверки. */
function project(app: string) {
  mkdirSync(join(app, 'src'), { recursive: true });
  copyFileSync(join(baseline, 'packs/property/harness.mjs'), join(app, 'harness.mjs'));
  const files: Record<string, string> = {
    'oracle.mjs': fx.oracle,
    'check.mjs': fx.check(),
    'points.mjs': fx.points,
    'src/knap.mjs': fx.knap.stub,
    'src/reach.mjs': fx.reach.stub,
    '.gitignore': '.reports/\n.devcontour-local/\n',
  };
  for (const [path, content] of Object.entries(files)) writeFileSync(join(app, path), content);
  git(app, 'init', '-q', '-b', 'main');
  git(app, 'add', '-A');
  git(app, 'commit', '-qm', 'project');
  // Ветка интеграции, которую создал запуск прежней версии.
  git(app, 'branch', 'devcontour/accepted');
}

/**
 * Настоящие коммиты попытки в окне после update-ref: кандидат на ветке
 * попытки и его интеграция, уже продвинутая в ветку интеграции.
 */
function windowCommits(app: string) {
  git(app, 'checkout', '-q', '-b', 'devcontour/run-window', 'devcontour/accepted');
  writeFileSync(join(app, 'src/window.mjs'), "export const window = 'принято';\n");
  git(app, 'add', '-A');
  git(app, 'commit', '-qm', 'window: candidate');
  const candidate = git(app, 'rev-parse', 'HEAD');
  git(app, 'checkout', '-q', 'devcontour/accepted');
  git(app, 'merge', '-q', '--no-ff', '-m', 'window: integration', 'devcontour/run-window');
  const integration = git(app, 'rev-parse', 'HEAD');
  git(app, 'checkout', '-q', 'main');
  return { base: git(app, 'rev-parse', 'main'), candidate, integration };
}

function evidence(h: Any, run: Any, phase: 'candidate' | 'integration', sha: string) {
  for (const kind of ['test', 'review'] as const)
    h.evidence(run.id, run.token, {
      kind,
      phase,
      sha,
      gate: kind === 'test' ? 'test' : 'independent-review',
      passed: true,
      command: kind === 'test' ? ['node', 'verify.mjs'] : ['demo', 'review-code'],
      exitCode: 0,
      log: `artifacts/${run.id}/${phase}/${kind}.log`,
      digest: digest(kind === 'test' ? 'a' : 'b'),
      summary: kind === 'test' ? '3 tests, 0 failures' : 'Критерии выполнены',
      ...(kind === 'test'
        ? { tests: [{ id: 'greet.greets', status: 'passed' }] }
        : {
            inspection: {
              mode: 'diff-only',
              source: 'unavailable',
              commands: [],
              reason: 'Runtime не предоставил подтверждение выполненных команд.',
            },
          }),
    });
}

const usageBase = (id: string, extra: Record<string, unknown>) => ({
  id,
  repositoryId: 'app',
  stage: 'implementation',
  runtime: 'claude',
  model: 'claude-model',
  runtimeVersion: '1.0.0',
  startedAt: at(3),
  promptBytes: 1200,
  promptDigest: digest('c'),
  ...extra,
});
const fullUsage = (reportedUsd: number | null) => ({
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reportedUsd,
  complete: true,
  source: 'claude-result',
});
const noUsage = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reportedUsd: null,
  complete: false,
  source: 'unavailable',
};

async function populate(store: Any, root: string, kind: 'central' | 'component') {
  const app = join(root, 'app');
  project(app);
  const loaded = config(root);
  const h = new DevContour(store, loaded);
  const approval = { actor: 'agent', authorRuntime: 'claude', reviewerRuntime: 'codex' };
  const taskId = (title: string) => store.read().tasks.find((t: Any) => t.title === title).id;
  const claimOf = (board: string, title: string) => {
    if (store.read().tasks.find((t: Any) => t.id === taskId(title)).status === 'draft')
      h.approve(board, [taskId(title)], approval);
    const run = h.claim('legacy-controller');
    if (run?.taskId !== taskId(title)) throw new Error('Выдана не та задача: ' + title);
    return run;
  };
  h.pause(false);

  // Договор проверки с закреплёнными файлами и две попытки его ревью
  // прежнего формата (contractAttempts): отклонённая и одобренная.
  const pinned = await pinArtifacts({ id: 'app', path: app }, [
    { path: 'oracle.mjs', purpose: 'Эталоны: полный перебор' },
    { path: 'check.mjs', purpose: 'Генераторы и свойства' },
    { path: 'harness.mjs', purpose: 'Harness генеративной проверки' },
  ]);
  const contract = h.contract(
    'Knapsack',
    'Оптимум рюкзака и полнота сумм по oracle.mjs.',
    undefined,
    'app',
    undefined,
    pinned.artifacts,
    fx.declaration(),
  );
  store.change('legacy.contract-attempts', (s: Any) => {
    s.contractAttempts = [1, 2].map((attempt) => ({
      id: `CA-legacy-${attempt}`,
      at: at(attempt),
      subject: contract.id,
      attempt,
      title: 'Knapsack',
      repositoryId: 'app',
      approved: attempt === 2,
      summary: attempt === 2 ? 'Обязательства измеримы' : 'Не задана область входов',
      findings:
        attempt === 2
          ? []
          : [{ severity: 'blocking', message: 'Нет границ входа', rule: 'domain' }],
      artifact: `reviews/contract-${contract.id}-${attempt}.json`,
      authorRuntime: 'claude',
      reviewerRuntime: 'codex',
    }));
    return {};
  });

  // Доска A: принятая, с историей отказов, ожидающая, активная, в окне.
  const { boardId } = h.importPlan({
    title: 'Релиз приветствий',
    description: 'Цель релиза: функции приветствия.',
    tasks: ['accepted', 'failed', 'pending', 'active', 'window'].map((key, i) => ({
      key,
      repositoryId: 'app',
      title: `Задача ${key}`,
      description: `Наблюдаемый результат задачи ${key} проверяется тестом.`,
      role: 'qa',
      dependsOn: i === 2 ? ['accepted'] : [],
      acceptance: [`Сценарий ${key} проверен тестом.`],
      contracts: [],
      writePaths: ['src'],
      gates: ['test'],
    })),
  });
  let run = claimOf(boardId, 'Задача accepted');
  h.phase(run.id, run.token, 'running', {
    baseSha: sha('1'),
    worktree: join(root, 'worktrees', run.id),
  });
  h.phase(run.id, run.token, 'verifying', { candidateSha: sha('2') });
  evidence(h, run, 'candidate', sha('2'));
  h.phase(run.id, run.token, 'integrating', { integrationSha: sha('3') });
  evidence(h, run, 'integration', sha('3'));
  h.finish(run.id, run.token, sha('3'));

  // Доска R и ChangeSet: одна принятая задача, проверки комбинации —
  // проваленная и прошедшая.
  const release = h.createBoard('Релиз B', 'Поставка релиза B.', 'app');
  h.addTask(release.id, {
    title: 'Задача release',
    description: 'Наблюдаемый результат задачи release проверяется тестом.',
    role: 'qa',
    repositoryId: 'app',
    acceptance: ['Сценарий release проверен тестом.'],
    contracts: [],
    writePaths: ['src'],
    gates: ['test'],
    dependsOn: [],
  });
  run = claimOf(release.id, 'Задача release');
  h.phase(run.id, run.token, 'running', { baseSha: sha('3') });
  h.phase(run.id, run.token, 'verifying', { candidateSha: sha('6') });
  evidence(h, run, 'candidate', sha('6'));
  h.phase(run.id, run.token, 'integrating', { integrationSha: sha('7') });
  evidence(h, run, 'integration', sha('7'));
  h.finish(run.id, run.token, sha('7'));
  const workspace = new Workspace(h);
  const cs = workspace.create({
    title: 'Поставка релиза B',
    description: 'Проверка комбинации репозиториев релиза B.',
    boardIds: [release.id],
  });
  const e2e = (passed: boolean) => ({
    gate: 'e2e',
    passed,
    command: ['node', 'e2e.mjs'],
    exitCode: passed ? 0 : 1,
    log: 'workspace-checks/e2e.log',
    digest: digest(passed ? 'e' : 'f'),
    summary: passed ? '2 tests, 0 failures' : '2 tests, 1 failure',
    artifacts: [],
    durationMs: 1500,
  });
  for (const passed of [false, true]) {
    const v = workspace.start(cs.id);
    workspace.manifest(cs.id, v.token, { app: { sha: sha('7'), tree: sha('8') } });
    workspace.evidence(cs.id, v.token, e2e(passed));
    if (passed) workspace.finish(cs.id, v.token);
    else workspace.fail(cs.id, v.token, 'Нет PASS: e2e');
  }

  // История отказов без свойства.
  run = claimOf(boardId, 'Задача failed');
  h.phase(run.id, run.token, 'running', { baseSha: sha('3') });
  h.fail(run.id, run.token, 'Нет PASS: candidate/test', false, 'gate');
  h.retry(taskId('Задача failed'));
  run = claimOf(boardId, 'Задача failed');
  h.phase(run.id, run.token, 'running', { baseSha: sha('3') });
  h.fail(run.id, run.token, 'Ревью отклонило результат', false, 'review');

  // Доска P: задача со свойством; два содержательных отказа по нему открывают
  // эпизод разбора (awaiting-lead).
  const props = h.createBoard('Свойства рюкзака', 'Оптимум рюкзака по договору проверки.', 'app');
  h.addTask(props.id, {
    title: 'Задача property',
    description: 'Оптимум рюкзака по договору проверки.',
    role: 'backend',
    repositoryId: 'app',
    contracts: [contract.id],
    acceptance: ['AC-optimal'],
    writePaths: ['src/'],
    properties: ['knapsack-optimal'],
    dependsOn: [],
  });
  for (const i of [1, 2]) {
    run = claimOf(props.id, 'Задача property');
    h.phase(run.id, run.token, 'running', { baseSha: sha('3') });
    h.fail(
      run.id,
      run.token,
      `Свойство knapsack-optimal нарушено на входе ${i}`,
      false,
      'gate',
      undefined,
      { bound: ['knapsack-optimal'], unbound: [] },
    );
    if (i === 1) h.retry(taskId('Задача property'));
  }

  // Корпус договора: подтверждённый случай, версия 1, принята задачей property.
  const corpus = new CheckCorpus(h);
  const propertyTask = store.read().tasks.find((t: Any) => t.id === taskId('Задача property'));
  const { suite } = corpus.suiteFor(propertyTask, 'knapsack-optimal');
  const input = canonicalJson({ items: [{ w: 0, v: 5 }], cap: 0 });
  const id = caseId('knapsack-optimal', input, suite.basis);
  suite.decisions.push({
    id: 'CD-legacy-1',
    key: 'legacy-case-1',
    property: 'knapsack-optimal',
    input,
    inputHash: sha256(input),
    outcome: 'confirmed',
    reason: 'Эталон и реализация различаются на исходном SHA дважды',
    source: { sha: sha('3') },
    observed: { expected: '5', actual: '0', equal: false, repeats: 2, durationsMs: [12, 11] },
    caseId: id,
    version: 1,
    origin: { kind: 'review', runtime: 'codex' },
    at: at(10),
  });
  suite.cases[id] = {
    id,
    property: 'knapsack-optimal',
    input,
    expected: '5',
    source: { kind: 'oracle', decision: 'CD-legacy-1', sha: sha('3') },
    addedAt: at(10),
  };
  const file = corpusFile(suite, [id], 1);
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: app, input: file })
    .toString()
    .trim();
  suite.versions.push({
    number: 1,
    digest: sha256(file),
    previous: null,
    cases: [id],
    blob,
    createdAt: at(10),
    reason: 'Подтверждённый контрпример ревью',
    decisions: ['CD-legacy-1'],
  });
  suite.pending.push({
    id: 'PA-legacy-1',
    version: 1,
    digest: sha256(file),
    tasks: [propertyTask.id],
    status: 'waiting',
    results: {},
    actor: 'agent',
    reason: 'Принять подтверждённый случай',
    requestedAt: at(10),
  });
  store.atomic(() => corpus.save(suite));
  corpus.adopt(suite.id, 'PA-legacy-1');

  // Активная попытка с истёкшим сроком и попытка в окне после update-ref.
  run = claimOf(boardId, 'Задача active');
  h.phase(run.id, run.token, 'running', { baseSha: sha('3') });
  const window = claimOf(boardId, 'Задача window');
  const commits = windowCommits(app);
  h.phase(window.id, window.token, 'running', { baseSha: commits.base });
  h.phase(window.id, window.token, 'verifying', { candidateSha: commits.candidate });
  evidence(h, window, 'candidate', commits.candidate);
  h.phase(window.id, window.token, 'integrating', { integrationSha: commits.integration });
  evidence(h, window, 'integration', commits.integration);
  store.change('legacy.expired', (s: Any) => {
    for (const r of s.runs) if (r.status === 'active') r.leaseUntil = Date.parse(at(30));
    return {};
  });
  h.approve(boardId, [taskId('Задача pending')], approval);

  // Задания ведущего: доска A на стадии 1 с живым (позже истёкшим) lease,
  // доска релиза — упавшая стадия.
  const lead = new LeadWorkflow(h);
  let job = lead.start({ kind: 'board', id: boardId, authorRuntime: 'claude' });
  job = lead.claim(job.key, job.owner);
  lead.finish(job);
  lead.claim(job.key, job.owner);
  const second = lead.start({ kind: 'board', id: release.id, authorRuntime: 'codex' });
  lead.fail(lead.claim(second.key, second.owner), 'Стадия согласования упала: ревью недоступно');

  // Учёт вызовов: сообщённая стоимость, оценка по тарифу, неизвестная,
  // ошибка, прерванный вызов и «идущий» вызов умершего процесса.
  const accepted = store.read().runs.find((r: Any) => r.status === 'succeeded');
  store.atomic(() => {
    const save = (r: Any) => {
      usageSchema.parse(r.usage);
      store.saveLocal('usage', 'app', r.id, r);
    };
    save(
      usageBase('call-reported', {
        runId: accepted.id,
        taskId: accepted.taskId,
        boardId,
        finishedAt: at(4),
        outcome: 'returned',
        durationMs: 60000,
        usage: fullUsage(0.25),
        costUsd: 0.25,
        costSource: 'provider-reported',
      }),
    );
    save(
      usageBase('call-estimated', {
        runtime: 'codex',
        model: 'codex-model',
        stage: 'candidate-review',
        runId: accepted.id,
        taskId: accepted.taskId,
        boardId,
        finishedAt: at(5),
        outcome: 'returned',
        durationMs: 30000,
        usage: { ...fullUsage(null), source: 'codex-turn-events' },
        costUsd: (1000 * 1 + 200 * 4) / 1e6,
        costSource: 'tariff-estimate',
        price: loaded.prices[0],
      }),
    );
    save(
      usageBase('call-unknown', {
        subjectId: boardId,
        boardId,
        stage: 'plan-review',
        finishedAt: at(6),
        outcome: 'returned',
        durationMs: 20000,
        usage: noUsage,
        costUsd: null,
        costSource: 'unknown',
      }),
    );
    save(
      usageBase('call-error', {
        runId: accepted.id,
        taskId: accepted.taskId,
        boardId,
        finishedAt: at(7),
        outcome: 'error',
        durationMs: 5000,
        usage: fullUsage(0.02),
        costUsd: 0.02,
        costSource: 'provider-reported',
      }),
    );
    save(
      usageBase('call-abandoned', {
        runId: accepted.id,
        taskId: accepted.taskId,
        boardId,
        outcome: 'abandoned',
        abandonedAt: at(9),
        durationUnknown: true,
        process: { id: 'dead-process', pid: 999999, startedAt: Date.parse(at(1)) },
        usage: noUsage,
        costUsd: null,
        costSource: 'unknown',
      }),
    );
    save(
      usageBase('call-active-dead', {
        taskId: taskId('Задача active'),
        boardId,
        outcome: 'active',
        process: { id: 'dead-process', pid: 999999, startedAt: Date.parse(at(1)) },
        elapsedMs: 4000,
        usage: noUsage,
        costUsd: null,
        costSource: 'unknown',
      }),
    );
  });

  // Пауза: в central — отказ рантайма прежнего формата, в component — человек.
  if (kind === 'component') h.pause(true, 'operator');
  writeFileSync(
    join(root, 'expected.json'),
    JSON.stringify(expectations(h, lead, corpus), null, 2) + '\n',
  );
  return h;
}

/**
 * Digest, которые прежняя версия считает для записанного состояния: по ним
 * тест сверяет формулы новой версии (одинаковые входы — одинаковые digest),
 * в том числе для состояния, которого нет в самих записях (текущая версия
 * проверок задачи после принятия корпуса).
 */
function expectations(h: Any, lead: Any, corpus: Any) {
  const s = h.store.read();
  return {
    tasks: Object.fromEntries(
      s.tasks.map((t: Any) => {
        const policy = h.taskPolicyDigest(t);
        return [
          t.title,
          {
            policy,
            legacyPolicy: h.policyDigest(t.repositoryId, true),
            checks: effectiveChecks(t, policy),
            spec: specDigest(t),
            scope: scopeDigest(t),
            dependency: dependencyDigest(t),
            context: contextDigest(t),
          },
        ];
      }),
    ),
    workspacePolicy: new Workspace(h).policyDigest(),
    lead: Object.fromEntries(
      lead.list('app').map((job: Any) => [job.key, lead.input(job.kind, job.id).digest]),
    ),
    corpus: Object.fromEntries(
      s.tasks
        .filter((t: Any) => t.properties?.length)
        .map((t: Any) => {
          const { suite } = corpus.suiteFor(t, t.properties[0]);
          return [t.title, { suite: suite.id, basis: suite.basis }];
        }),
    ),
  };
}

function legacyRuntimePause(file: string) {
  const db = new DatabaseSync(file);
  const raw = JSON.parse((db.prepare('SELECT data FROM state WHERE id=1').get() as Any).data);
  raw.paused = true;
  raw.pauseReason = 'runtime';
  raw.pauseFailure = 'provider-auth';
  delete raw.pauseFailures;
  db.prepare('UPDATE state SET data=? WHERE id=1').run(JSON.stringify(raw));
  db.close();
}

/** Каталог вывода: тот же канонический путь, по которому тест открывает копию. */
const ROOT = out;
if (realpathSync(dirname(ROOT)) !== dirname(ROOT))
  throw new Error('Каталог вывода — канонический путь: ' + realpathSync(dirname(ROOT)));

/**
 * Репозиторий компонента — рядом как `app.git`, рабочее дерево не хранится
 * (его восстанавливает тест). Удаляются только файлы, которые Git отслеживает.
 */
function packRepository(root: string) {
  const app = join(root, 'app');
  const tracked = git(app, 'ls-files', '-z').split('\0').filter(Boolean);
  renameSync(join(app, '.git'), join(root, 'app.git'));
  const hooks = join(root, 'app.git', 'hooks');
  for (const f of readdirSync(hooks)) if (f.endsWith('.sample')) unlinkSync(join(hooks, f));
  rmdirSync(hooks);
  for (const f of tracked) unlinkSync(join(app, f));
  rmdirSync(join(app, 'src'));
}

const centralRoot = join(out, 'central');
mkdirSync(join(centralRoot, 'app'), { recursive: true });
const croot = centralRoot;
const central = new Store(join(croot, 'state.sqlite'), undefined, false, 'DELETE');
// Конфигурация прежней версии рядом с базой: `devcontour serve --data <копия>`.
writeFileSync(join(croot, 'config.json'), JSON.stringify(config(croot), null, 2) + '\n');
await populate(central, croot, 'central');
central.close();
legacyRuntimePause(join(croot, 'state.sqlite'));
packRepository(croot);

const componentRoot = join(out, 'component');
mkdirSync(join(componentRoot, 'app'), { recursive: true });
mkdirSync(join(componentRoot, 'coordinator'), { recursive: true });
const root = componentRoot;
const component = new Store(join(root, 'coordinator', 'state.sqlite'), [
  { id: 'app', path: join(root, 'app') },
]);
writeFileSync(
  join(root, 'coordinator', 'config.json'),
  JSON.stringify({ ...config(root), storage: 'component' }, null, 2) + '\n',
);
await populate(component, root, 'component');
component.close();
packRepository(root);
writeFileSync(join(out, 'ROOT'), ROOT + '\n');
console.log('legacy fixtures written to', out);
