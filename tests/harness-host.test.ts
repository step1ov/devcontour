// Хост DevContour для движка harness: перевод конфигурации, основания,
// продуктовые условия, области бюджетов, согласование контрактов и
// коннекторы. Исполнение ещё идёт прежним путём; здесь движок harness ведёт
// задачу DevContour поверх адаптера хранилища от выдачи до доставки.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { runtimeAdapters } from '../src/harness/adapters.ts';
import {
  Engine,
  HarnessError,
  contextDigest,
  contextIssues,
  runResult,
  runResultSchema,
  selectReviewer,
  type ErrorCode,
} from 'devcontour-harness';
import { config, fixture, input } from './helpers.ts';
import { configSchema, type Config } from '../src/core/model.ts';
import { DevContour, loadedDigest, specDigest } from '../src/core/service.ts';
import { validateWorkflow } from '../src/core/workflow.ts';
import { DevContourExecutionStore } from '../src/harness/store.ts';
import {
  devcontourContextSource,
  devcontourHost,
  devcontourResultSink,
  devcontourWorkSource,
  projectionOptions,
  receiverContext,
} from '../src/harness/host.ts';
import { policyFromConfig } from '../src/harness/policy.ts';
import { orderOf } from '../src/harness/projection.ts';

const refused = (code: ErrorCode) => (e: unknown) => {
  assert.ok(e instanceof HarnessError, String(e));
  assert.equal(e.code, code, e.message);
  return true;
};

/** Движок harness над задачами DevContour: тот же Store, прежние формулы. */
function engineFor(h: DevContour) {
  const store = new DevContourExecutionStore(h.store, projectionOptions(h));
  const engine = new Engine({
    host: devcontourHost(h, store),
    policy: policyFromConfig(h.config),
    policyIdentity: loadedDigest(h.config),
  });
  return { store, engine };
}

/** Доска с утверждёнными задачами, как её готовит продукт. */
function board(f: ReturnType<typeof fixture>, titles = ['Task A']) {
  const { boardId } = f.h.importPlan({
    title: 'Release',
    description: 'Цель этапа',
    tasks: titles.map((t, i) => ({ ...input(t), key: 'k' + i, contracts: [] })),
  });
  f.h.approve(boardId);
  return { boardId, tasks: f.store.read().tasks };
}

/* ------------------------------------------------------------------ */
/* Политика                                                            */
/* ------------------------------------------------------------------ */

test('Конфигурация → политика: runtime, роли компонента, ревью и правило вендора, бюджеты; прежний demo self-review — явным правилом', () => {
  const demo = policyFromConfig(config());
  assert.equal(demo.mode, 'fixture');
  assert.equal(demo.roles.qa.writer.runtime, 'fixture');
  assert.equal(demo.review.code.reviewer.runtime, 'fixture');
  assert.equal(demo.review.code.vendor, 'same-vendor-allowed', 'demo ревьюер demo — как раньше');
  assert.equal(demo.roles.backend.requiresContract, true);
  assert.equal(demo.roles.qa.requiresContract, false);
  assert.equal(demo.repositories[0].targetRef, 'refs/heads/devcontour/accepted');

  const live = (overrides: Partial<Config>) =>
    configSchema.parse({
      ...config(),
      mode: 'local',
      roles: { backend: { runtime: 'claude', writePaths: ['src'] } },
      reviewer: { runtime: 'codex', model: 'gpt-x' },
      ...overrides,
    });
  const strict = policyFromConfig(live({}));
  assert.equal(strict.mode, 'live');
  assert.equal(strict.review.code.vendor, 'different-vendor', 'умолчание — другой вендор');
  assert.deepEqual(strict.review.code.reviewer, { runtime: 'codex', model: 'gpt-x' });
  assert.deepEqual(strict.roles.backend.writePaths, ['src']);

  // Один вендор: без разрешения конфигурация отклоняется, с разрешением — проходит.
  const same = { reviewer: { runtime: 'claude' as const } };
  assert.throws(() => validateWorkflow(live(same)), /same-vendor-allowed/);
  const allowed = live({ ...same, review: { code: { vendor: 'same-vendor-allowed' } } });
  validateWorkflow(allowed);
  const policy = policyFromConfig(allowed);
  const choice = selectReviewer(policy, 'code', policy.roles.backend.writer, 'backend');
  assert.ok(choice.ok && choice.sameVendor, 'явно разрешённый тот же вендор');

  // Роль компонента и ревьюер компонента — роли и ревью репозитория.
  const components = policyFromConfig(
    live({
      repositories: [
        {
          id: 'api',
          name: 'API',
          kind: 'product',
          path: '/tmp/api',
          targetBranch: 'devcontour/accepted',
          gates: config().gates,
          protectedPaths: ['.github/'],
          roles: { backend: { runtime: 'codex', writePaths: ['server'] } },
          reviewer: { runtime: 'claude' },
        },
      ],
    }),
  );
  const repo = components.repositories[0];
  assert.equal(repo.roles!.backend.writer.runtime, 'codex');
  assert.equal(repo.review!.reviewer.runtime, 'claude');

  const budgets = policyFromConfig(
    live({
      budgets: {
        task: { usd: 1 },
        board: { usd: 5 },
        workspace: { timeMs: 1000 },
        onUnknown: 'continue',
      },
    }),
  ).budgets!;
  assert.deepEqual(budgets, {
    work: { usd: 1 },
    group: { usd: 5 },
    total: { timeMs: 1000 },
    onUnknown: 'continue',
  });

  // Значение вне договора harness — явный отказ с названием поля.
  assert.throws(
    () =>
      policyFromConfig(
        live({ environment: { inherit: ['HARNESS_TOKEN'], values: {}, secrets: {} } }),
      ),
    (e: unknown) =>
      e instanceof HarnessError &&
      e.code === 'INVALID_INPUT' &&
      /environment\.inherit/.test(e.message),
  );
});

test('Задача без области записи у себя и роли — весь репозиторий ("."); с областью роли — область роли', () => {
  const f = fixture();
  try {
    const { tasks } = board(f);
    const task = tasks[0];
    assert.deepEqual(orderOf(task, projectionOptions(f.h)).writeScope, ['.']);
    f.h.config.roles.qa = { ...f.h.config.roles.qa, writePaths: ['tests'] };
    assert.deepEqual(orderOf(task, projectionOptions(f.h)).writeScope, ['tests']);
  } finally {
    f.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* Основания и продуктовые условия                                     */
/* ------------------------------------------------------------------ */

test('Основания — прежние формулы: утверждённая задача выдаётся; изменённая постановка — APPROVAL_STALE; смена политики задачи гасит fenced-операции попытки', () => {
  const f = fixture();
  try {
    const { tasks } = board(f, ['Task A', 'Task B']);
    const { engine } = engineFor(f.h);
    assert.ok(engine.lead('controller'));
    engine.resume();
    const a = engine.claim('controller')!;
    assert.ok(a, 'утверждённая задача выдана движком');
    assert.equal(a.policyDigest, f.h.taskPolicyDigest(tasks.find((t) => t.id === a.workId)!));
    const run = f.store.read().runs.find((r) => r.id === a.id)!;
    assert.equal(run.taskId, a.workId, 'попытка записана в Run DevContour');
    // Политика задачи сменилась (команда gate) — прежняя попытка не продолжается.
    f.h.config.gates[0].command = ['node', 'other.mjs'];
    assert.throws(
      () =>
        engine.evidence(a.id, a.token, {
          kind: 'test',
          phase: 'candidate',
          sha: 'c'.repeat(40),
          gate: 'test',
          passed: true,
          command: ['fixture'],
          exitCode: 0,
          log: 'log',
          digest: 'e'.repeat(64),
          summary: 'ok',
        }),
      (e: unknown) => e instanceof HarnessError && /олитик/.test(e.message),
    );
    f.h.config.gates[0].command = ['node', 'verify.mjs'];
    // Постановка второй задачи изменилась после утверждения — выдачи нет.
    const other = tasks.find((t) => t.id !== a.workId)!;
    f.store.change('test.edit', (s) => {
      s.tasks.find((t) => t.id === other.id)!.description = 'Другая постановка задачи.';
    });
    assert.notEqual(
      specDigest(f.store.read().tasks.find((t) => t.id === other.id)!),
      other.approvedDigest,
    );
    assert.ok(
      engine
        .read((v) => engine.blockers(v.work(other.id)!, v))
        .some((b) => b.code === 'APPROVAL_STALE'),
      'изменённая постановка видна блокером',
    );
    engine.cancel(a.workId, 'освободить слот');
    assert.throws(() => engine.claim('controller'), refused('APPROVAL_STALE'));
  } finally {
    f.cleanup();
  }
});

test('Продуктовые условия хоста: задача другого участника, вне активной ревизии и при активной поставке не выдаётся; причина видна блокером', () => {
  const f = fixture();
  try {
    const { boardId, tasks } = board(f);
    const id = tasks[0].id;
    const { engine } = engineFor(f.h);
    engine.lead('controller');
    engine.resume();
    const blockers = () =>
      engine.read((v) => engine.blockers(v.work(id)!, v)).map((b) => b.message);
    // Назначена другому участнику.
    f.store.change('test.team', (s) => {
      s.team = { member: 'ann' };
      s.tasks[0].assignee = 'bob';
    });
    assert.equal(engine.claim('controller'), undefined);
    assert.ok(blockers().some((m) => /другому участнику/.test(m)));
    f.store.change('test.team', (s) => {
      s.tasks[0].assignee = 'ann';
    });
    // Активная поставка ChangeSet — барьер выдачи.
    f.store.change('test.delivery', (s) => {
      s.changeSets.push({
        id: 'CS-1',
        title: 'Набор',
        description: 'Поставка',
        boardIds: [boardId],
        createdAt: '2026-01-01T00:00:00.000Z',
        verifications: [],
        deliveries: [
          {
            id: 'D-1',
            verificationId: 'V-1',
            manifestDigest: 'a'.repeat(64),
            policyDigest: 'b'.repeat(64),
            token: 't',
            leaseUntil: Date.now() + 60_000,
            status: 'active',
            startedAt: '2026-01-01T00:00:00.000Z',
            components: {},
          },
        ],
      });
    });
    assert.equal(engine.claim('controller'), undefined, 'поставка держит выдачу');
    f.store.change('test.delivery', (s) => {
      s.changeSets[0].deliveries![0].status = 'delivered';
    });
    // Вне активной ревизии доски.
    f.store.change('test.revision', (s) => {
      s.boards[0].revisions[0].status = 'accepted';
    });
    assert.equal(engine.claim('controller'), undefined);
    assert.ok(blockers().some((m) => /нет в активной ревизии/.test(m)));
    f.store.change('test.revision', (s) => {
      s.boards[0].revisions[0].status = 'active';
    });
    assert.ok(engine.claim('controller'), 'без условий хоста задача выдаётся');
  } finally {
    f.cleanup();
  }
});

test('Согласование контракта — утверждённая редакция DevContour: та же — выдача без выдуманных раундов ревью; другая редакция или её нет — блокер', () => {
  const f = fixture();
  try {
    const contract = f.h.contract('API', 'GET /hello возвращает приветствие.');
    const { boardId } = f.h.importPlan({
      title: 'Release',
      description: 'Цель этапа',
      tasks: [{ ...input('Task A'), key: 'a', contracts: [contract.id] }],
    });
    f.h.approve(boardId);
    const id = f.store.read().tasks[0].id;
    const { engine } = engineFor(f.h);
    engine.lead('controller');
    engine.resume();
    assert.equal(
      engine.reviews('contract', contract.id).length,
      0,
      'раундов ревью в форме harness нет',
    );
    const blockers = () =>
      engine.read((v) => engine.blockers(v.work(id)!, v)).map((b) => b.message);
    assert.ok(!blockers().some((m) => /Контракт/.test(m)));
    // Подменённая редакция контракта в состоянии — задача закрепила другую.
    f.store.change('test.contract', (s) => {
      s.contracts[0].digest = 'c'.repeat(64);
    });
    assert.equal(engine.claim('controller'), undefined);
    assert.ok(blockers().some((m) => /закрепила другую редакцию/.test(m)));
    f.store.change('test.contract', (s) => {
      s.contracts = [];
    });
    assert.ok(blockers().some((m) => /не утверждён/.test(m)));
    f.store.change('test.contract', (s) => {
      s.contracts = [contract];
    });
    assert.ok(engine.claim('controller'), 'утверждённая редакция — выдача');
  } finally {
    f.cleanup();
  }
});

test('Области бюджетов: группа — доска задачи, состав — все ревизии; прежний вызов о доске получает задачи всех её ревизий', () => {
  const f = fixture();
  try {
    const { boardId, tasks } = board(f, ['Task A', 'Task B']);
    const { engine, store } = engineFor(f.h);
    const host = engine.host;
    store.read((v) => {
      assert.equal(host.budgets.groupOf(tasks[0].id, v), boardId);
      assert.deepEqual(host.budgets.members(boardId, v).sort(), tasks.map((t) => t.id).sort());
      const record = { id: 'u1', subjectId: boardId, stage: 'plan-review' } as never;
      assert.deepEqual(host.budgets.legacy(record, v), {
        groupId: boardId,
        workIds: tasks.map((t) => t.id),
      });
      const byTask = { id: 'u2', subjectId: tasks[1].id, stage: 'x' } as never;
      assert.deepEqual(host.budgets.legacy(byTask, v), { workId: tasks[1].id, groupId: boardId });
    });
  } finally {
    f.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* Коннекторы                                                          */
/* ------------------------------------------------------------------ */

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();

test('Источник контекста: закреплённый пакет роли — снимок с теми же байтами и прежним digest пакета; получатель ожидает этот снимок', async () => {
  const f = fixture();
  try {
    const repo = join(f.root, 'repo');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs/rules.md'), 'Правило: только чистые функции.\n');
    writeFileSync(join(repo, 'docs/guide.md'), 'Справка по стилю.\n');
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'docs');
    const revision = git(repo, 'rev-parse', 'HEAD');
    const { digest } = await import('../src/core/service.ts');
    const documents = [
      { file: 'docs/guide.md', content: 'Справка по стилю.' },
      { file: 'docs/rules.md', content: 'Правило: только чистые функции.' },
    ];
    const pack = {
      id: 'norms',
      version: '1',
      repositoryId: 'main',
      roles: ['qa'],
      files: ['docs/rules.md'],
      references: ['docs/guide.md'],
      revision,
      digest: digest({ id: 'norms', version: '1', documents }),
    };
    f.h.config = configSchema.parse({ ...f.h.config, repository: repo, contextPacks: [pack] });
    const { tasks } = board(f);
    const id = tasks[0].id;
    const { store } = engineFor(f.h);
    assert.deepEqual(orderOf(tasks[0], projectionOptions(f.h)).context, ['norms'], 'пакет роли');
    const snapshot = await devcontourContextSource(f.h, store).forTask(id);
    assert.deepEqual(contextIssues(snapshot), []);
    const source = snapshot.sources[0];
    assert.equal(source.hostDigest, pack.digest);
    assert.equal(source.revision, revision);
    assert.equal(source.files[0].content.data, 'Правило: только чистые функции.');
    assert.equal(source.references[0].path, 'docs/guide.md');
    const receiver = await receiverContext(f.h, store, id);
    assert.equal(receiver.contextDigest, contextDigest(snapshot));
    // Изменённый закреплённый пакет — отказ, а не другой снимок.
    f.h.config.contextPacks[0].digest = 'd'.repeat(64);
    await assert.rejects(devcontourContextSource(f.h, store).forTask(id), refused('NOT_READY'));
  } finally {
    f.cleanup();
  }
});

test('Движок harness ведёт задачу DevContour от выдачи до приёмки; получатель подтверждает результат; повтор доставки тот же; изменённая постановка — конфликт', async () => {
  const f = fixture();
  try {
    const { tasks } = board(f);
    const id = tasks[0].id;
    const { engine, store } = engineFor(f.h);
    engine.lead('controller');
    engine.resume();
    const a = engine.claim('controller')!;
    const [base, candidate, integration] = ['a', 'c', 'b'].map((c) => c.repeat(40)) as [
      string,
      string,
      string,
    ];
    engine.phase(a.id, a.token, 'verifying', { baseSha: base, candidateSha: candidate });
    engine.phase(a.id, a.token, 'integrating', { integrationSha: integration });
    for (const [phase, sha] of [
      ['candidate', candidate],
      ['integration', integration],
    ] as const)
      for (const gate of ['test', 'independent-review'])
        engine.evidence(a.id, a.token, {
          kind: gate === 'test' ? 'test' : 'review',
          phase,
          sha,
          gate,
          passed: true,
          command: ['fixture'],
          exitCode: 0,
          log: 'log',
          digest: 'e'.repeat(64),
          summary: 'ok',
        });
    engine.finish(a.id, a.token, integration);
    const task = f.store.read().tasks.find((t) => t.id === id)!;
    assert.equal(task.status, 'done');
    assert.equal(task.resultSha, integration);
    const result = runResultSchema.parse(
      JSON.parse(
        JSON.stringify(
          runResult(
            engine.read((v) => v.attempt(a.id)!),
            engine.version,
          ),
        ),
      ),
    );
    assert.equal(result.outcome, 'accepted');
    // Версия хоста — имя и версия установленного пакета DevContour (S3-R1-04).
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      name: string;
      version: string;
    };
    assert.equal(a.consumerVersion, `${pkg.name}@${pkg.version}`);
    assert.equal(result.inputs.consumerVersion, `${pkg.name}@${pkg.version}`);
    assert.equal(
      (f.store.read().runs.find((r) => r.id === a.id) as { consumerVersion?: string } | undefined)
        ?.consumerVersion,
      `${pkg.name}@${pkg.version}`,
    );
    const sink = devcontourResultSink(f.h, store);
    const first = await sink.deliver({ key: 'k1', result });
    assert.equal(first.status, 'delivered');
    assert.deepEqual(await sink.deliver({ key: 'k1', result }), first, 'повтор — тот же ответ');
    // Подделка у получателя отклоняется его собственными ожиданиями.
    const forged = runResultSchema.parse({ ...result, repositoryId: 'other' });
    await assert.rejects(sink.deliver({ key: 'k2', result: forged }), refused('INVALID_INPUT'));
    assert.equal(await devcontourWorkSource(f.h, store).revision(id), specDigest(task));
    f.store.change('test.edit', (s) => {
      s.tasks[0].title = 'Другое название задачи';
    });
    const conflict = await sink.deliver({ key: 'k3', result });
    assert.equal(conflict.status, 'conflict');
  } finally {
    f.cleanup();
  }
});

test('Живой runtime harness закрывает файлы контура DevContour и тогда, когда они появляются после старта вызова', async () => {
  // Каталог контура над worktree codex закрывает поэлементно: элемент, которого
  // нет в снимке, закрывается только по имени из перечня хоста.
  const f = fixture();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-late-entries-')));
  try {
    const controller = join(root, 'controller'),
      worktree = join(controller, 'worktrees', 'R1'),
      bin = join(root, 'bin');
    mkdirSync(worktree, { recursive: true });
    mkdirSync(bin);
    const argsFile = join(root, 'args.json');
    writeFileSync(
      join(bin, 'codex'),
      `#!/usr/bin/env node
const fs=require('fs');const a=process.argv.slice(2);
if(a.includes('--version')){console.log('codex 0.0.0');process.exit(0)}
fs.writeFileSync(process.env.ARGS_FILE,JSON.stringify(a));
const out=a.indexOf('--output-last-message');if(out>=0)fs.writeFileSync(a[out+1],'{}');
`,
      { mode: 0o755 },
    );
    const live = runtimeAdapters(f.h, policyFromConfig(f.h.config)).codex!;
    await live.invoke(
      {
        callId: 'c1',
        task: 'implement',
        binding: { runtime: 'codex' },
        cwd: worktree,
        prompt: 'p',
        session: { kind: 'fresh' },
        sandbox: {
          mode: 'os',
          writable: [worktree],
          denied: [controller],
          network: { domains: [] },
        },
        timeoutMs: 20_000,
        env: { PATH: bin + delimiter + (process.env.PATH ?? ''), ARGS_FILE: argsFile },
        artifactDir: join(root, 'call'),
      },
      new AbortController().signal,
    );
    const permissions = (JSON.parse(readFileSync(argsFile, 'utf8')) as string[]).find((a) =>
      a.startsWith('permissions.harness='),
    )!;
    for (const late of [
      'config.json',
      'journal',
      'decisions',
      'profiles',
      'doctor.json',
      'packs.lock.json',
      'workspace-selection.json',
    ])
      assert.ok(
        permissions.includes(`${JSON.stringify(join(controller, late))}="none"`),
        `${late} закрыт до появления`,
      );
    assert.ok(
      !permissions.includes(`${JSON.stringify(controller)}="none"`),
      'предок worktree открыт',
    );
  } finally {
    f.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Пауза и продолжение — путь harness: остановка не подменяет паузу человека, продолжение снимает классы отказов, ожидание базы и паузу операции, забрав её у операции', () => {
  const f = fixture();
  try {
    const at = () => f.store.read();
    f.h.pause(true);
    assert.deepEqual(f.h.pause(true, 'shutdown'), { paused: true, reason: 'operator' });
    assert.equal(at().pauseReason, 'operator', 'остановка поверх паузы человека её не подменяет');
    // Перенос базы: ожидание проверки базы; продолжение человека его снимает.
    f.h.pause(true, 'shutdown');
    f.h.baseUpdated([{ repositoryId: 'main', from: 'a'.repeat(40), to: 'b'.repeat(40) }]);
    assert.equal(at().waits?.[0]?.kind, 'base-check');
    const before = f.store.lastEventId();
    assert.deepEqual(f.h.pause(false), { paused: false, reason: undefined });
    assert.equal(at().paused, false);
    assert.equal(at().waits, undefined, 'ожидание проверки базы снято');
    assert.equal(at().pauseFailures, undefined);
    const started = f.store.events(before);
    assert.deepEqual(
      started.map((e) => [e.type, (e.data as { paused?: boolean }).paused]),
      [['scheduler.started', false]],
      'одно событие прежнего типа',
    );
    // Пауза человека поверх паузы операции забирает её у операции.
    assert.ok(f.h.operationPause('op-1'));
    assert.equal(at().pauseReason, 'reconfigure');
    f.h.pause(true);
    assert.equal(at().pauseOperation, undefined);
    assert.equal(f.h.operationResume('op-1'), undefined, 'операция чужую паузу не снимает');
    assert.equal(at().paused, true);
    // Продолжение человека снимает и паузу операции: она переходит к нему.
    f.h.pause(false);
    assert.ok(f.h.operationPause('op-2'));
    assert.deepEqual(f.h.pause(false), { paused: false, reason: undefined });
    assert.equal(at().pauseOperation, undefined);
    assert.equal(f.h.operationResume('op-2'), undefined);
    assert.equal(at().paused, false);
  } finally {
    f.cleanup();
  }
});

test('S3-R1-02: the write scope of a task is the effective role binding of its component, checked on a real staged diff', async () => {
  const { Scheduler } = await import('../src/runner/scheduler.ts');
  // writePaths роли компонента, роль компонента без области и явная область
  // задачи; глобальная qa с областью `global` заменена ролью компонента.
  const cases: {
    name: string;
    role: { runtime: 'demo'; writePaths?: string[] };
    task?: string[];
    allowed: string[];
    refused: string[];
  }[] = [
    {
      name: 'component role scope',
      role: { runtime: 'demo', writePaths: ['component'] },
      allowed: ['component/result'],
      refused: ['global/result'],
    },
    {
      name: 'override without scope',
      role: { runtime: 'demo' },
      allowed: ['component/result', 'elsewhere/result'],
      refused: [],
    },
    {
      name: 'explicit task scope',
      role: { runtime: 'demo', writePaths: ['component'] },
      task: ['component/own'],
      allowed: ['component/own/result'],
      refused: ['component/result'],
    },
  ];
  for (const c of cases)
    for (const [file, expected] of [
      ...c.allowed.map((p) => [p, 'allowed'] as const),
      ...c.refused.map((p) => [p, 'refused'] as const),
    ]) {
      const f = fixture();
      try {
        const path = join(f.root, 'app');
        mkdirSync(path, { recursive: true });
        const git = (...args: string[]) =>
          execFileSync(
            'git',
            ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
            { cwd: path, encoding: 'utf8' },
          ).trim();
        git('init', '-q');
        writeFileSync(join(path, 'initial'), 'initial');
        git('add', '.');
        git('commit', '-qm', 'initial');
        mkdirSync(join(path, file, '..'), { recursive: true });
        writeFileSync(join(path, file), 'change');
        git('add', '.');
        f.h.config.roles.qa.writePaths = ['global'];
        f.h.config.repositories = [
          {
            id: 'app',
            name: 'App',
            kind: 'product',
            path,
            targetBranch: 'devcontour/accepted',
            gates: f.h.config.gates,
            protectedPaths: [],
            roles: { qa: c.role },
          },
        ] as never;
        const b = f.h.createBoard('Scope');
        const t = f.h.addTask(b.id, {
          ...input(),
          repositoryId: 'app',
          ...(c.task ? { writePaths: c.task } : {}),
        });
        f.h.approve(b.id);
        const runner = (new Scheduler(f.h, f.root) as never as { runner: never }).runner as {
          engine: { read<T>(f: (v: { work(id: string): unknown }) => T): T; policy: never };
          assertScope(work: unknown, repo: unknown, cwd: string): Promise<void>;
        };
        const work = runner.engine.read((v) => v.work(t.id));
        const repo = (runner.engine.policy as { repositories: unknown[] }).repositories[0];
        let outcome = 'allowed';
        try {
          await runner.assertScope(work, repo, path);
        } catch (e) {
          assert.match(String(e), /област/i, `${c.name}: ${file}`);
          outcome = 'refused';
        }
        assert.equal(outcome, expected, `${c.name}: ${file}`);
      } finally {
        f.cleanup();
      }
    }
});

test('S3-R1-05: очередь записывает время готовности задачи при выдаче — после согласования и зависимости, завершённой в другом clone', async () => {
  const { Scheduler } = await import('../src/runner/scheduler.ts');
  const { complete, CANDIDATE, MERGED } = await import('./helpers.ts');
  const f = fixture();
  try {
    const b = f.h.createBoard('Waiting times');
    const first = f.h.addTask(b.id, input('First'));
    const second = f.h.addTask(b.id, input('Second', [first.id]));
    f.h.approve(b.id);
    complete(f.h, first.id);
    // Зависимость завершена в другом clone: её попыток здесь нет, есть receipt.
    const finishedAt = new Date(Date.now() + 60_000).toISOString();
    f.store.change('test.received', (s) => {
      const t = s.tasks.find((x) => x.id === first.id)!;
      const run = s.runs.find((r) => r.taskId === first.id)!;
      t.sharedCompletion = {
        receipt: {
          id: run.id,
          taskId: t.id,
          repositoryId: t.repositoryId,
          specDigest: t.approvedDigest!,
          policyDigest: run.policyDigest,
          candidateSha: CANDIDATE,
          resultSha: MERGED,
          finishedAt,
          runtime: run.runtime,
          reviewer: run.reviewer,
          requiredGates: ['test'],
          checks: [],
        },
        sourceCommit: 'a'.repeat(40),
      };
      s.runs = s.runs.filter((r) => r.taskId !== first.id);
    });
    f.h.pause(false);
    const scheduler = new Scheduler(f.h, f.root) as never as {
      runner: { execute: () => Promise<void>; tick(): Promise<void>; settled(): Promise<void> };
      stop(): Promise<void>;
    };
    // Граница выдачи: исполнения нет — ни моделей, ни gates, ни ref.
    scheduler.runner.execute = () => Promise.resolve();
    await scheduler.runner.tick();
    await scheduler.runner.settled();
    const run = f.store.read().runs.find((r) => r.taskId === second.id)!;
    const approvedAt = f.store.read().tasks.find((t) => t.id === second.id)!.approvedAt!;
    assert.deepEqual(run.wait, { approvedAt, readyAt: finishedAt });
    await scheduler.stop();
  } finally {
    f.cleanup();
  }
});
