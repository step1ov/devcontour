import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, input, testCheckoutRoot } from './helpers.ts';
import { repositorySchema, type Repository } from '../src/core/model.ts';
import { intentDefinition, parseIntent } from '../src/core/intent.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { Workspace, changeSnapshot } from '../src/core/workspace.ts';
import { IntentService, scenarioGaps } from '../src/runner/intent.ts';
import { WorkspaceRunner } from '../src/runner/workspace.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { git, command } from '../src/runner/process.ts';
import { acceptBoard } from '../src/runner/agent-control.ts';
import { requirementSnapshot } from '../src/runner/requirements.ts';
import { AgentService } from '../src/application/agent.ts';
import { syncGit } from '../src/runner/git-sync.ts';
import { recordsFromState, stateFromRecords } from '../src/core/sync-state.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { LeadRunner } from '../src/runner/lead-workflow.ts';

const source =
  '## REQ-moderation: Ограничения участника\nБлокировка запрещает отправку сообщения.\n';
const localDefinition = {
  kind: 'component',
  title: 'Локальные правила модерации',
  purpose: 'Обеспечить корректную блокировку участника.',
  audience: ['Модераторы поддержки'],
  sources: ['spec.md'],
  releases: [{ id: 'mvp', title: 'Модерация' }],
  stories: [
    {
      id: 'block',
      title: 'Блокировка участника',
      releaseId: 'mvp',
      criteria: [
        {
          id: 'blocked',
          text: 'Участник не может отправлять сообщения после блокировки.',
          requirements: [{ source: 'spec.md', id: 'REQ-moderation' }],
        },
      ],
    },
  ],
};
const releaseScenario = 'Клиент показывает блокировку, которую применяет API.';
const sceneProof = { scenario: releaseScenario, testId: 'policy type' };
const map = () => {
  const definition = intentDefinition.parse({
    kind: 'workspace',
    title: 'Корпоративный чат',
    purpose: 'Помочь модератору ограничить нарушителя во всех клиентах.',
    product: {
      channels: [
        {
          id: 'admin',
          title: 'Админка',
          purpose: 'Управление участниками.',
          audience: ['Модераторы'],
          componentIds: ['web'],
        },
        {
          id: 'mobile',
          title: 'Мобильное приложение',
          purpose: 'Общение участников.',
          audience: ['Сотрудники'],
          componentIds: ['mobile-ui'],
        },
      ],
      components: [
        {
          id: 'web',
          title: 'Веб-интерфейс',
          kind: 'frontend',
          repositoryId: 'app',
          path: 'apps/admin',
          dependsOn: ['api'],
        },
        {
          id: 'mobile-ui',
          title: 'Мобильный интерфейс',
          kind: 'mobile',
          repositoryId: 'app',
          path: 'apps/mobile',
          dependsOn: ['api'],
        },
        {
          id: 'api',
          title: 'Библиотека чата',
          kind: 'library',
          repositoryId: 'chat',
          path: '.',
          dependsOn: [],
        },
      ],
      features: [
        {
          id: 'block',
          title: 'Блокировка участника',
          outcome: 'Ограничение действительно работает во всех клиентах.',
        },
        { id: 'export', title: 'Экспорт журнала', outcome: 'Модератор получает журнал изменений.' },
      ],
    },
    releases: [
      {
        id: 'mvp',
        title: 'Первая модерация',
        components: [
          { repositoryId: 'app', releaseId: 'mvp' },
          { repositoryId: 'chat', releaseId: 'mvp' },
        ],
        features: [
          {
            featureId: 'block',
            channels: [
              {
                channelId: 'admin',
                scope: 'included',
                stories: [
                  { repositoryId: 'app', storyId: 'block' },
                  { repositoryId: 'chat', storyId: 'block' },
                ],
              },
              {
                channelId: 'mobile',
                scope: 'included',
                stories: [
                  { repositoryId: 'app', storyId: 'block' },
                  { repositoryId: 'chat', storyId: 'block' },
                ],
              },
            ],
            checks: [
              {
                gate: 'moderation',
                scenario: releaseScenario,
              },
            ],
          },
          {
            featureId: 'export',
            channels: [
              {
                channelId: 'admin',
                scope: 'deferred',
                reason: 'После проверки сценария блокировки.',
              },
              {
                channelId: 'mobile',
                scope: 'not-applicable',
                reason: 'Журнал доступен только модератору в админке.',
              },
            ],
            checks: [],
          },
        ],
      },
    ],
  });
  if (definition.kind !== 'workspace') throw new Error('Expected workspace');
  definition.releases.push({
    ...structuredClone(definition.releases[0]),
    id: 'next',
    title: 'Следующий релиз',
  });
  return definition;
};
async function fixture(
  local: typeof localDefinition = localDefinition,
  initial?: ReturnType<typeof map>,
) {
  // Канонический путь: CLI читает config.json и раскрывает символические
  // ссылки (/var → /private/var на macOS); с другим путём у него была бы другая
  // политика совместной проверки, и проверка теста была бы для него неактуальна.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'devcontour-product-')));
  const repos: Repository[] = [];
  const commit = async (path: string, message: string) => {
    await git(path, 'add', '.');
    await git(path, 'commit', '-m', message);
  };
  for (const id of ['app', 'chat']) {
    const path = join(root, id);
    await mkdir(path);
    await git(path, 'init', '-b', 'main');
    await git(path, 'config', 'user.name', 'Product fixture');
    await git(path, 'config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(path, '.gitignore'), '.reports/\n.devcontour-local/\n');
    await writeFile(join(path, 'spec.md'), source);
    await writeFile(join(path, 'policy.json'), '{"canPost":false}');
    await writeFile(
      join(path, 'local.mjs'),
      `import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
assert.equal(typeof JSON.parse(readFileSync('policy.json')).canPost,'boolean');
writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase name="policy type"/></testsuite>');`,
    );
    if (id === 'app')
      await writeFile(
        join(path, 'joint.mjs'),
        `import {readFileSync,writeFileSync} from 'node:fs';
const paths=JSON.parse(process.env.DEVCONTOUR_COMPONENTS_JSON);
const allowed=id=>JSON.parse(readFileSync(paths[id]+'/policy.json')).canPost;
const ok=allowed('app')===false && allowed('chat')===false;
writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase name="moderation across clients">'+(ok?'':'<failure message="restriction not applied"/>')+'</testcase></testsuite>');
process.exitCode=ok?0:1;`,
      );
    await commit(path, 'Initial local requirements and real checks');
    repos.push(
      repositorySchema.parse({
        id,
        name: id,
        kind: id === 'app' ? 'product' : 'library',
        path,
        dependsOn: id === 'app' ? ['chat'] : [],
        gates: [
          {
            id: 'local',
            kind: 'test',
            command: [process.execPath, 'local.mjs'],
            report: { type: 'junit', path: '.reports/local.xml' },
          },
        ],
        protectedPaths: ['local.mjs', 'joint.mjs'],
      }),
    );
  }
  const control = join(root, 'control');
  await mkdir(control);
  await git(control, 'init', '-b', 'main');
  await git(control, 'config', 'user.name', 'Product fixture');
  await git(control, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(control, '.gitignore'), '.devcontour-local/\n');
  await commit(control, 'Workspace');
  const c = config({
    repository: repos[0].path,
    repositories: repos,
    workspaceRoot: control,
    // Рабочие деревья — во временном каталоге теста, а не в кэше пользователя.
    checkoutRoot: testCheckoutRoot(),
    approvalMode: 'agent',
    maxAttempts: 8,
    verificationMode: 'affected',
    workspaceGates: [
      {
        id: 'moderation',
        repositoryId: 'app',
        kind: 'test',
        command: [process.execPath, 'joint.mjs'],
        timeoutMs: 30000,
        report: { type: 'junit', path: '.reports/joint.xml' },
        artifacts: [],
      },
    ],
  });
  const store = new Store(join(root, 'state.sqlite')),
    h = new DevContour(store, c),
    intent = new IntentService(h);
  for (const repo of repos) {
    await writeFile(
      join(repo.path, 'INTENT.md'),
      intent.render({ repositoryId: repo.id, definition: local }).markdown,
    );
    await commit(repo.path, 'Local product stories');
  }
  const save = async (definition = map()) => {
    await writeFile(join(control, 'INTENT.md'), intent.render({ definition }).markdown);
    await commit(control, 'Product map');
  };
  await save(initial);
  await writeFile(join(root, 'config.json'), JSON.stringify(c));
  const scheduler = new Scheduler(h, root),
    runner = new WorkspaceRunner(h, root);
  await scheduler.init();
  const boards: string[] = [];
  // Связь со сценарием релиза получают задачи `linked` репозиториев;
  // остальные — только сценарий истории.
  const plan = (
    scenario: { scenario: string; testId?: string } = sceneProof,
    linked = repos.map((r) => r.id),
  ) => {
    for (const repo of repos) {
      const board = h.createBoard('Сценарий блокировки ' + repo.id, '', repo.id);
      const snapshot = intent.snapshot({ repositoryId: repo.id, storyId: 'block' });
      if (!snapshot.stories) throw new Error('Expected stories');
      const local = requirementSnapshot(repo.path, 'spec.md').requirements[0];
      h.addTask(board.id, {
        ...input('Блокировка в ' + repo.id),
        repositoryId: repo.id,
        requirements: [
          {
            ...snapshot.stories[0].requirement,
            gate: 'local',
            scenario: 'Проверка ограничения участника.',
          },
          // Сценарий релиза подтверждает названный testcase задачи релиза.
          {
            ...local,
            source: 'spec.md',
            gate: 'local',
            ...(linked.includes(repo.id)
              ? scenario
              : { scenario: 'Проверка ограничения участника.' }),
          },
        ],
      });
      boards.push(board.id);
      h.approve(board.id);
    }
  };
  const run = async () => {
    h.pause(false);
    await scheduler.drain();
    assert.ok(
      store.read().tasks.every((t) => t.status === 'done'),
      JSON.stringify(store.read().tasks.map((t) => t.failure)),
    );
  };
  const accept = async () => {
    for (const id of boards) await acceptBoard(h, id, 'codex');
  };
  const view = () => {
    const v = intent.productView();
    if (!v.available) throw new Error(v.reason);
    return v;
  };
  return {
    root,
    c,
    h,
    intent,
    runner,
    scheduler,
    store,
    repos,
    control,
    commit,
    save,
    plan,
    run,
    accept,
    boards,
    view,
    close: async () => {
      await scheduler.stop();
      await runner.stop();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('Product map separates monorepo channels and cross-repository features; rejects incomplete or unsafe declarations', async () => {
  const f = await fixture();
  try {
    const view = f.view();
    assert.equal(view.channels.length, 2);
    assert.equal(view.components.filter((c) => c.repositoryId === 'app').length, 2);
    assert.equal(view.features[0].status, 'unplanned');
    assert.equal(view.features[1].status, 'deferred');
    assert.equal(view.releaseAccepted, false);
    assert.ok(
      !JSON.stringify(view).includes('Участник не может отправлять сообщения после блокировки.'),
    );
    assert.ok(!JSON.stringify(view).includes('taskIds'));
    assert.deepEqual(
      new AgentService(f.h).execute({ operation: 'product_view', input: { releaseId: 'mvp' } }),
      view,
    );
    for (const mutate of [
      (d: any) => d.releases[0].features.pop(),
      (d: any) => d.releases[0].features[0].channels.pop(),
      (d: any) => (d.releases[0].features[0].channels[0].stories[0].storyId = 'absent'),
      (d: any) => (d.releases[0].features[0].checks[0].gate = 'absent'),
      (d: any) => (d.releases[0].features[0].checks = []),
      (d: any) => d.product.components[2].dependsOn.push('web'),
      (d: any) => (d.product.components[0].path = '../other'),
      (d: any) => (d.product.components[0].repositoryId = 'unknown'),
      (d: any) => d.releases[0].features[0].channels.forEach((a: any) => a.stories.pop()),
    ]) {
      const changed = map();
      mutate(changed);
      assert.throws(() => f.intent.render({ definition: changed }));
    }
    const markdown = await readFile(join(f.control, 'INTENT.md'), 'utf8');
    assert.throws(
      () => parseIntent(markdown.replace('## Возможности продукта', '## Другие возможности')),
      /расходятся/,
    );
    const cli = await command(
      [
        process.execPath,
        '--import',
        'tsx',
        'src/cli.ts',
        'product-view',
        '--release',
        'mvp',
        '--require-accepted',
        '--data',
        f.root,
      ],
      process.cwd(),
      { timeoutMs: 20000 },
    );
    assert.equal(cli.code, 1);
    assert.equal(JSON.parse(cli.stdout).releaseAccepted, false);
  } finally {
    await f.close();
  }
});

test('A product release needs every local board and real joint tests; acceptance stays distinct from task completion', async () => {
  const f = await fixture();
  try {
    f.plan();
    assert.equal(f.view().features[0].status, 'in-progress');
    const change = f.runner.workspace.create({
      title: 'Релиз модерации',
      description: 'Согласованная блокировка во всех клиентах.',
      boardIds: f.boards,
      releaseId: 'mvp',
    });
    assert.throws(() => f.runner.verify(change.id), /завершите/);
    await f.run();
    assert.equal(f.view().features[0].status, 'awaiting-verification');
    // A live unfinished task keeps the release uncovered, and the refusal names it.
    const late = f.h.createBoard('Поздняя правка', '', 'app');
    const pending = f.h.addTask(late.id, {
      ...input('Поздняя правка блокировки'),
      repositoryId: 'app',
      requirements: f.store.read().tasks.find((t) => t.repositoryId === 'app')!.requirements,
    });
    assert.equal(f.view().features[0].status, 'in-progress');
    assert.throws(
      () => f.runner.verify(change.id),
      (e: Error) =>
        /не покрыт/.test(e.message) &&
        e.message.includes('история app/block: не подтверждены задачи ' + pending.id),
    );
    // A cancelled task is not current work: it stays visible as excluded and
    // does not hold the release open.
    f.h.cancel(pending.id, 'Правка не нужна');
    assert.equal(f.view().features[0].status, 'awaiting-verification');
    const local = f.intent.report({ repositoryId: 'app', releaseId: 'mvp' }) as {
      coverageComplete: boolean;
      stories: { excludedTasks: { id: string; reason: string }[]; taskIds: string[] }[];
    };
    assert.equal(local.coverageComplete, true);
    assert.deepEqual(local.stories[0].excludedTasks, [{ id: pending.id, reason: 'cancelled' }]);
    assert.ok(!local.stories[0].taskIds.includes(pending.id));
    assert.throws(() => f.runner.verify(change.id), /примите/);
    await f.accept();
    assert.throws(() => new Workspace(f.h).start(change.id), /runner/);
    const partial = f.runner.workspace.create({
      title: 'Неполный релиз',
      description: 'Забыли доску библиотеки.',
      boardIds: [f.boards[0]],
      releaseId: 'mvp',
    });
    assert.throws(() => f.runner.verify(partial.id), /не включает задачу/);
    const original = f.c.workspaceGates[0].command;
    f.c.workspaceGates[0].command = [process.execPath, '-e', 'process.exit(1)'];
    await assert.rejects(f.runner.verify(change.id));
    assert.equal(f.view().features[0].status, 'awaiting-verification');
    f.c.workspaceGates[0].command = original;
    await f.runner.verify(change.id);
    const checked = f.view();
    assert.equal(checked.features[0].status, 'verified');
    assert.ok(checked.features[0].checks.every((c) => c.passed));
    assert.deepEqual(
      checked.features[0].checks.map((c) => [c.status, c.evidence.map((e) => e.testId)]),
      [['evidenced', ['policy type', 'policy type']]],
    );
    assert.equal(checked.releaseAccepted, false);
    const verification = f.store
      .read()
      .changeSets.find((c) => c.id === change.id)!
      .verifications.at(-1)!;
    assert.equal(verification.impact!.mode, 'all');
    assert.ok(verification.productRelease?.intentDigest);
    // A pending ChangeSet may be rebound by Git sync; its old proof belongs to the old release.
    f.store.change('fixture.rebind-release', (s) => {
      s.changeSets.find((c) => c.id === change.id)!.releaseId = 'next';
    });
    const next = f.intent.productView({ releaseId: 'next' });
    assert.ok(next.available && !next.verification && !next.releaseAccepted);
    assert.throws(() => f.runner.workspace.accept(change.id), /актуальной/);
    f.store.change('fixture.restore-release', (s) => {
      s.changeSets.find((c) => c.id === change.id)!.releaseId = 'mvp';
    });
    const evidence = structuredClone(f.store.read().runs[0].evidence);
    f.store.change('fixture.missing-proof', (s) => {
      s.runs[0].evidence = [];
    });
    assert.throws(() => f.runner.workspace.accept(change.id), /Покрытие/);
    f.store.change('fixture.restore-proof', (s) => {
      s.runs[0].evidence = evidence;
    });
    f.c.approvalMode = 'operator';
    assert.equal(f.runner.workspace.accept(change.id).status, 'awaiting-operator');
    assert.equal(f.view().releaseAccepted, false);
    f.runner.workspace.accept(change.id, { actor: 'operator' });
    assert.equal(f.view().features[0].status, 'accepted');
    const portable = recordsFromState(f.h, f.store.read());
    for (const records of portable.values())
      for (const record of Object.values(records))
        if (record.kind === 'changeset' && record.data.id === change.id)
          record.data.releaseId = 'different';
    assert.throws(
      () => stateFromRecords(f.h, f.store.read(), portable, new Map()),
      /Нельзя менять принятый ChangeSet/,
    );
    const receipt = structuredClone(
      f.store.read().changeSets.find((c) => c.id === change.id)!.acceptance,
    );
    const acceptedRef = 'refs/heads/' + f.repos[0].targetBranch;
    const parent = await git(f.repos[0].path, 'rev-parse', acceptedRef);
    const tree = await git(f.repos[0].path, 'rev-parse', parent + '^{tree}');
    const advanced = await git(
      f.repos[0].path,
      'commit-tree',
      tree,
      '-p',
      parent,
      '-m',
      'A later unverified combination',
    );
    await git(f.repos[0].path, 'update-ref', acceptedRef, advanced, parent);
    assert.equal(f.view().coverageComplete, true);
    assert.equal(f.view().releaseAccepted, false);
    assert.deepEqual(
      f.store.read().changeSets.find((c) => c.id === change.id)!.acceptance,
      receipt,
    );
  } finally {
    await f.close();
  }
});

test('A release scenario needs its own testcase or a recorded deferral; story coverage alone does not accept the release', async () => {
  const f = await fixture();
  try {
    // Истории покрыты принятыми задачами, но связь называет сценарий без
    // testcase: зелёный gate не доказывает, что сценарий кто-то проверил.
    f.plan({ scenario: releaseScenario });
    await f.run();
    await f.accept();
    const unmet = f.view();
    assert.equal(unmet.coverageComplete, false);
    assert.equal(unmet.features[0].checks[0].status, 'missing');
    assert.ok(
      unmet.issues.some(
        (i) =>
          i.includes('сценарий релиза block (gate moderation) без доказательства') &&
          i.includes(releaseScenario),
      ),
      JSON.stringify(unmet.issues),
    );
    const report = f.intent.report({ releaseId: 'mvp' }) as {
      coverageComplete: boolean;
      scenarios: { status: string }[] | null;
    };
    assert.equal(report.coverageComplete, false);
    assert.deepEqual(
      report.scenarios?.map((s) => s.status),
      ['missing'],
    );
    const change = f.runner.workspace.create({
      title: 'Релиз модерации',
      description: 'Сценарий без своего теста.',
      boardIds: f.boards,
      releaseId: 'mvp',
    });
    assert.throws(
      () => f.runner.verify(change.id),
      (e: Error) => /не покрыт/.test(e.message) && e.message.includes('testId'),
    );
    // Записанная причина отложить сценарий — явное решение, видимое в карте.
    const deferred = map();
    deferred.releases[0].features![0].checks[0].deferred =
      'Проверка на устройстве переносится в следующий релиз.';
    await f.save(deferred);
    const view = f.view();
    assert.equal(view.coverageComplete, true, JSON.stringify(view.issues));
    assert.equal(view.features[0].checks[0].status, 'deferred');
    assert.equal(view.features[0].checks[0].passed, false);
    // Отложенный сценарий не проверен: карта, отчёт и приёмка называют его.
    const listed = [
      {
        featureId: 'block',
        gate: 'moderation',
        scenario: releaseScenario,
        reason: 'Проверка на устройстве переносится в следующий релиз.',
      },
    ];
    assert.deepEqual(view.deferredScenarios, listed);
    assert.deepEqual(
      (f.intent.report({ releaseId: 'mvp' }) as { deferredScenarios: unknown }).deferredScenarios,
      listed,
    );
    await f.runner.verify(change.id);
    const accepted = f.runner.workspace.accept(change.id) as { deferredScenarios?: unknown };
    assert.deepEqual(accepted.deferredScenarios, listed);
    assert.equal(f.view().releaseAccepted, true);
    // Релиз без карты фич сценариев не объявляет: отчёт говорит об этом прямо.
    const legacy = map();
    delete legacy.product;
    for (const release of legacy.releases) delete release.features;
    await f.save(legacy);
    const plain = f.intent.report({ releaseId: 'mvp' }) as {
      scenarios: unknown;
      note: string;
    };
    assert.equal(plain.scenarios, null);
    assert.match(plain.note, /scenarios are not tracked/);
  } finally {
    await f.close();
  }
});

test('A release accepted under the earlier rule without proven scenarios is not accepted now, and its pending verification cannot be accepted', async () => {
  const f = await fixture();
  // Прежняя версия не знала сценариев: покрытие считалось по историям, а
  // сценарий не требовал testcase. Так записываются проверка и приёмка
  // прежней версии; затем правило возвращается.
  const proto = IntentService.prototype as unknown as {
    workspaceCoverage: (...args: unknown[]) => {
      issues: string[];
      components: { coverageComplete: boolean }[];
      scenarios: unknown[];
      complete: boolean;
    };
  };
  const current = proto.workspaceCoverage;
  proto.workspaceCoverage = function (this: unknown, ...args: unknown[]) {
    const coverage = current.apply(this, args);
    return {
      ...coverage,
      scenarios: [],
      complete: !coverage.issues.length && coverage.components.every((c) => c.coverageComplete),
    };
  };
  try {
    f.plan({ scenario: releaseScenario });
    await f.run();
    await f.accept();
    const create = (title: string) =>
      f.runner.workspace.create({
        title,
        description: 'Проверка прежней версии.',
        boardIds: f.boards,
        releaseId: 'mvp',
      });
    const pending = create('Проверен, но не принят');
    await f.runner.verify(pending.id);
    const old = create('Принят прежней версией');
    await f.runner.verify(old.id);
    f.runner.workspace.accept(old.id);
    assert.equal(f.view().releaseAccepted, true);
    proto.workspaceCoverage = current;
    assert.throws(
      () => f.runner.workspace.accept(pending.id),
      (e: Error) =>
        e.message.startsWith('Сценарии релиза не подтверждены') &&
        e.message.includes(releaseScenario),
    );
    const view = f.view();
    assert.equal(view.releaseAccepted, false);
    assert.equal(view.features[0].status, 'verified');
    assert.match(view.issues[0], /принят по прежнему правилу/);
    assert.ok(view.acceptanceOverridden);
    const cli = await command(
      [
        process.execPath,
        '--import',
        'tsx',
        'src/cli.ts',
        'product-view',
        '--release',
        'mvp',
        '--require-accepted',
        '--data',
        f.root,
      ],
      process.cwd(),
      { timeoutMs: 20000 },
    );
    assert.equal(cli.code, 1);
    assert.equal((JSON.parse(cli.stdout) as { releaseAccepted: boolean }).releaseAccepted, false);
  } finally {
    proto.workspaceCoverage = current;
    await f.close();
  }
});

test('Scenario evidence counts only for the feature whose stories the task serves, and one gate tracks several scenarios separately', async () => {
  const f = await fixture();
  try {
    const second = 'Модератор видит причину блокировки в журнале.';
    const scoped = map();
    const [block, exported] = scoped.releases[0].features!;
    // Два сценария на одном gate: каждый доказывается отдельно.
    block.checks.push({ gate: 'moderation', scenario: second });
    // Вторая фича обслуживается только историей библиотеки, а её сценарий
    // дословно совпадает со сценарием первой фичи.
    exported.channels[0] = {
      channelId: 'admin',
      scope: 'included',
      stories: [{ repositoryId: 'chat', storyId: 'block' }],
    };
    exported.checks = [{ gate: 'moderation', scenario: releaseScenario }];
    await f.save(scoped);
    // Сценарий связывает только задача приложения.
    f.plan(sceneProof, ['app']);
    await f.run();
    await f.accept();
    const view = f.view();
    const status = (featureId: string) =>
      view.features
        .find((x) => x.id === featureId)!
        .checks.map((c) => [c.scenario, c.status, c.evidence.map((e) => e.repositoryId)]);
    assert.deepEqual(status('block'), [
      [releaseScenario, 'evidenced', ['app']],
      [second, 'missing', []],
    ]);
    assert.deepEqual(status('export'), [[releaseScenario, 'missing', []]]);
    assert.equal(view.coverageComplete, false);
    assert.ok(view.issues.some((i) => i.includes('сценарий релиза export (gate moderation)')));
    assert.ok(view.issues.some((i) => i.includes(second)));
    // Повтор той же пары gate и сценария — ошибка карты.
    const repeated = map();
    repeated.releases[0].features![0].checks.push({
      gate: 'moderation',
      scenario: ' ' + releaseScenario,
    });
    assert.throws(() => f.intent.render({ definition: repeated }), /Повтор feature scenario/);
    // Доказательство сопоставляется по тексту, а не по gate: тот же текст на
    // другом gate фичи был бы доказан тем же testcase, и карта его отклоняет.
    const otherGate = map();
    otherGate.releases[0].features![0].checks.push({
      gate: 'release-acceptance',
      scenario: releaseScenario,
    });
    assert.throws(() => f.intent.render({ definition: otherGate }), /Повтор feature scenario/);
  } finally {
    await f.close();
  }
});

test('Scenario evidence is scoped by story, not by repository: another story of the same component does not prove the feature', async () => {
  // Вторая история в тех же репозиториях: фича export обслуживается ею, а
  // доказательство сценария несёт задача истории block того же репозитория.
  const local = structuredClone(localDefinition);
  local.stories.push({
    id: 'audit',
    title: 'Журнал блокировок',
    releaseId: 'mvp',
    criteria: [
      {
        id: 'audited',
        text: 'Блокировка видна в журнале модератора.',
        requirements: [{ source: 'spec.md', id: 'REQ-moderation' }],
      },
    ],
  });
  const scoped = map();
  const exported = scoped.releases[0].features![1];
  exported.channels[0] = {
    channelId: 'admin',
    scope: 'included',
    stories: [
      { repositoryId: 'app', storyId: 'audit' },
      { repositoryId: 'chat', storyId: 'audit' },
    ],
  };
  exported.checks = [{ gate: 'moderation', scenario: releaseScenario }];
  scoped.releases.pop();
  const f = await fixture(local, scoped);
  try {
    f.plan();
    await f.run();
    const view = f.view();
    const status = (featureId: string) =>
      view.features
        .find((x) => x.id === featureId)!
        .checks.map((c) => [c.status, [...new Set(c.evidence.map((e) => e.repositoryId))]]);
    assert.deepEqual(status('block'), [['evidenced', ['app', 'chat']]]);
    // Те же репозитории, тот же текст сценария, но другая история.
    assert.deepEqual(status('export'), [['missing', []]]);
  } finally {
    await f.close();
  }
});

test('A release scenario reworded or removed after acceptance needs the user to accept the release; the lead cannot', async () => {
  const second = 'Модератор видит причину блокировки в журнале.';
  const reworded = 'Модератор видит дату блокировки в журнале.';
  const reason = 'Журнал модератора — в следующем релизе.';
  const scoped = map();
  scoped.releases[0].features![0].checks.push({
    gate: 'moderation',
    scenario: second,
    deferred: reason,
  });
  const f = await fixture(localDefinition, scoped);
  try {
    f.plan();
    await f.run();
    await f.accept();
    const create = (title: string) =>
      f.runner.workspace.create({
        title,
        description: 'Приёмка объёма релиза.',
        boardIds: f.boards,
        releaseId: 'mvp',
      });
    const first = create('Первая приёмка');
    await f.runner.verify(first.id);
    assert.equal(f.runner.workspace.accept(first.id).status, 'accepted');
    // Образец объёма — сценарии, закреплённые в доказательстве принятой проверки.
    const proof = f.store
      .read()
      .changeSets.find((c) => c.id === first.id)!
      .verifications.at(-1)!.productRelease!;
    assert.deepEqual(
      proof.scenarios?.map((s) => s.scenario),
      [releaseScenario, second],
    );
    assert.deepEqual(f.view().unconfirmedScenarios, []);
    assert.equal(f.view().scopeReference?.changeSetId, first.id);
    // Обычный коммит INTENT переформулирует сценарий: объём релиза сузился
    // без решения пользователя.
    const changed = map();
    changed.releases[0].features![0].checks.push({
      gate: 'moderation',
      scenario: reworded,
      deferred: reason,
    });
    await f.save(changed);
    const expected = [
      {
        featureId: 'block',
        gate: 'moderation',
        scenario: second,
        change: 'changed',
        current: [reworded],
      },
    ];
    const view = f.view();
    assert.deepEqual(view.unconfirmedScenarios, expected);
    assert.equal(view.coverageComplete, true, JSON.stringify(view.issues));
    assert.ok(
      view.issues.some((i) => i.includes('без решения пользователя') && i.includes(first.id)),
      JSON.stringify(view.issues),
    );
    assert.ok(
      view.issues.some((i) => i.includes('изменён') && i.includes(second) && i.includes(reworded)),
    );
    const report = f.intent.report({ releaseId: 'mvp' }) as {
      unconfirmedScenarios: unknown;
      issues: string[];
    };
    assert.deepEqual(report.unconfirmedScenarios, expected);
    assert.ok(report.issues.some((i) => i.includes('без решения пользователя')));
    // Проверка идёт, но приёмку ведущего (agent) — и в режиме agent — заменяет
    // приёмка пользователя.
    const narrowed = create('Объём сужен');
    await f.runner.verify(narrowed.id);
    const lead = f.runner.workspace.accept(narrowed.id, { actor: 'agent' }) as {
      status: string;
      unconfirmedScenarios?: unknown;
    };
    assert.equal(lead.status, 'awaiting-operator');
    assert.deepEqual(lead.unconfirmedScenarios, expected);
    assert.equal(
      f.store.read().changeSets.find((c) => c.id === narrowed.id)!.acceptance,
      undefined,
    );
    assert.equal(f.view().releaseAccepted, false);
    // Карточка пользователя называет, что приёмка подтверждает сужение
    // объёма, — по доказательствам проверок в состоянии, без Git.
    const cards = new AgentService(f.h).execute({
      operation: 'attention_list',
      input: { actor: 'operator' },
    }) as { items: { sourceKey: string; reason: string }[] };
    const card = cards.items.find((i) => i.sourceKey === 'changeset:' + narrowed.id)!;
    assert.ok(
      card.reason.includes('подтверждаете сужение объёма релиза после приёмки ' + first.id) &&
        card.reason.includes(second) &&
        card.reason.includes(reworded),
      card.reason,
    );
    // Приёмка пользователя — решение: она становится новым образцом объёма.
    const confirmed = f.runner.workspace.accept(narrowed.id, { actor: 'operator' }) as {
      status: string;
      confirmedScenarioChanges?: unknown;
    };
    assert.equal(confirmed.status, 'accepted');
    assert.deepEqual(confirmed.confirmedScenarioChanges, expected);
    assert.deepEqual(f.view().unconfirmedScenarios, []);
    assert.equal(f.view().releaseAccepted, true);
    assert.equal(f.view().scopeReference?.changeSetId, narrowed.id);
    // Отсрочка сценария, проверенного в принятой карте, — тоже сужение.
    const postponed = map();
    postponed.releases[0].features![0].checks[0].deferred = 'Проверка на устройстве — позже.';
    postponed.releases[0].features![0].checks.push({
      gate: 'moderation',
      scenario: reworded,
      deferred: reason,
    });
    await f.save(postponed);
    assert.deepEqual(f.view().unconfirmedScenarios, [
      {
        featureId: 'block',
        gate: 'moderation',
        scenario: releaseScenario,
        change: 'deferred',
        reason: 'Проверка на устройстве — позже.',
      },
    ]);
    // Удалённый сценарий — то же сужение.
    await f.save(map());
    assert.deepEqual(f.view().unconfirmedScenarios, [
      { featureId: 'block', gate: 'moderation', scenario: reworded, change: 'removed' },
    ]);
    // Приёмка прежней версии сценариев не хранит: карту по digest находит
    // история Git workspace.
    f.store.change('fixture.legacy-proof', (s) => {
      delete s.changeSets.find((c) => c.id === narrowed.id)!.verifications.at(-1)!.productRelease!
        .scenarios;
    });
    assert.deepEqual(
      f.view().unconfirmedScenarios.map((u) => [u.scenario, u.change]),
      [[reworded, 'removed']],
    );
    // Карты той приёмки в истории нет: сверка невозможна, и карта говорит это прямо.
    f.store.change('fixture.lost-map', (s) => {
      s.changeSets
        .find((c) => c.id === narrowed.id)!
        .verifications.at(-1)!.productRelease!.intentDigest = 'f'.repeat(64);
    });
    const lost = f.view();
    assert.equal(lost.scopeReference?.found, false);
    assert.ok(lost.issues.some((i) => i.includes('не найдена в истории Git')));
    // Сверка невозможна — приёмка закрыта так же: решает пользователь, и его
    // приёмка закрепляет новый образец.
    const unverifiable = create('Объём не сверить');
    await f.runner.verify(unverifiable.id);
    const refused = f.runner.workspace.accept(unverifiable.id, { actor: 'agent' }) as {
      status: string;
      scopeUnverifiable?: boolean;
    };
    assert.equal(refused.status, 'awaiting-operator');
    assert.equal(refused.scopeUnverifiable, true);
    assert.equal(
      f.store.read().changeSets.find((c) => c.id === unverifiable.id)!.acceptance,
      undefined,
    );
    assert.equal(
      f.runner.workspace.accept(unverifiable.id, { actor: 'operator' }).status,
      'accepted',
    );
    const healed = f.view();
    assert.equal(healed.scopeReference?.changeSetId, unverifiable.id);
    assert.equal(healed.scopeReference?.found, true);
    assert.deepEqual(healed.unconfirmedScenarios, []);
    // CLI ведущего — тоже agent: обходного пути нет. Последний шаг: процесс
    // CLI закрепляет свою политику исполнения, после чего процесс теста
    // писать уже не может. Отсрочка проверенного в образце сценария.
    const deferredLast = map();
    deferredLast.releases[0].features![0].checks[0].deferred = 'Проверка на устройстве — позже.';
    await f.save(deferredLast);
    const viaCli = create('Приёмка через CLI');
    await f.runner.verify(viaCli.id);
    const cliExpected = [
      {
        featureId: 'block',
        gate: 'moderation',
        scenario: releaseScenario,
        change: 'deferred',
        reason: 'Проверка на устройстве — позже.',
      },
    ];
    assert.deepEqual(f.view().unconfirmedScenarios, cliExpected);
    const cliAccept = (...extra: string[]) =>
      command(
        [
          process.execPath,
          '--import',
          'tsx',
          'src/cli.ts',
          'changeset-accept',
          '--changeset',
          viaCli.id,
          ...extra,
          '--data',
          f.root,
        ],
        process.cwd(),
        { timeoutMs: 20000 },
      );
    // Без обязательного --author-runtime команда отказывает до приёмки.
    const bare = await cliAccept();
    assert.notEqual(bare.code, 0);
    assert.match(bare.stderr, /--author-runtime/);
    const cli = await cliAccept('--author-runtime', 'claude');
    assert.equal(cli.code, 0, cli.stderr);
    const out = JSON.parse(cli.stdout) as { status: string; unconfirmedScenarios: unknown };
    assert.equal(out.status, 'awaiting-operator', cli.stdout);
    assert.deepEqual(out.unconfirmedScenarios, cliExpected);
    assert.equal(f.store.read().changeSets.find((c) => c.id === viaCli.id)!.acceptance, undefined);
  } finally {
    await f.close();
  }
});

test('intent-render output round-trips: computed fields of the devcontour-intent block are accepted and recomputed', async () => {
  const f = await fixture();
  try {
    const block = (markdown: string) =>
      JSON.parse(/```devcontour-intent\n([\s\S]*?)\n```/.exec(markdown)![1]) as Record<
        string,
        unknown
      >;
    const workspace = await readFile(join(f.control, 'INTENT.md'), 'utf8');
    const rendered = block(workspace);
    assert.equal(rendered.version, 1);
    const again = new AgentService(f.h).execute({
      operation: 'intent_render',
      input: { definition: rendered },
    }) as { markdown: string };
    assert.equal(again.markdown, workspace);
    // Вычисляемое поле пересчитывается, а не берётся со входа.
    const stale = structuredClone(rendered) as {
      releases: { components: { intentDigest: string }[] }[];
    };
    stale.releases[0].components[0].intentDigest = '0'.repeat(64);
    assert.equal(f.intent.render({ definition: stale }).markdown, workspace);
    // Карта компонента: digest требований и sourceSha вычисляются от HEAD,
    // поэтому вывод равен генерации исходного определения сейчас.
    const component = block(await readFile(join(f.repos[0].path, 'INTENT.md'), 'utf8'));
    assert.ok(component.sourceSha);
    assert.equal(
      f.intent.render({ repositoryId: 'app', definition: component }).markdown,
      f.intent.render({ repositoryId: 'app', definition: localDefinition }).markdown,
    );
  } finally {
    await f.close();
  }
});

test('Missing release scenarios read as one hint line and one short line per scenario', () => {
  const missing = ['Первый сценарий.', 'Второй сценарий.', 'Третий сценарий.'].map((scenario) => ({
    featureId: 'block',
    gate: 'moderation',
    scenario,
    status: 'missing' as const,
    evidence: [],
  }));
  const lines = scenarioGaps(missing);
  assert.equal(lines.length, 4);
  assert.equal(lines.filter((l) => l.includes('testId')).length, 1);
  assert.match(lines[0], /без доказательства: 3/);
  for (const [i, s] of missing.entries()) {
    assert.ok(lines[i + 1].includes(s.scenario));
    assert.ok(lines[i + 1].length < 120, lines[i + 1]);
  }
  assert.deepEqual(scenarioGaps([{ ...missing[0], status: 'evidenced' }]), []);
});

test('requirements_testcases lists the testcase ids of the last gate record as testId must name them', async () => {
  const f = await fixture();
  try {
    f.plan();
    await f.run();
    const agent = new AgentService(f.h);
    const listed = agent.execute({
      operation: 'requirements_testcases',
      input: { gate: 'local', repositoryId: 'app' },
    }) as { found: boolean; taskId: string; testcases: { id: string; status: string }[] };
    assert.equal(listed.found, true);
    assert.deepEqual(listed.testcases, [{ id: 'policy type', status: 'passed' }]);
    assert.equal(f.store.read().tasks.find((t) => t.id === listed.taskId)!.repositoryId, 'app');
    const absent = agent.execute({
      operation: 'requirements_testcases',
      input: { gate: 'moderation' },
    }) as { found: boolean; testcases: unknown[] };
    assert.equal(absent.found, false);
    assert.deepEqual(absent.testcases, []);
  } finally {
    await f.close();
  }
});

test('Changing the product map after joint verification blocks acceptance and requires a new pinned verification', async () => {
  const f = await fixture();
  const lead = new LeadRunner(f.h, f.root);
  try {
    f.plan();
    await f.run();
    await f.accept();
    const change = f.runner.workspace.create({
      title: 'Первый релиз',
      description: 'Проверяем неизменность общей постановки.',
      boardIds: f.boards,
      releaseId: 'mvp',
    });
    await f.runner.verify(change.id);
    const oldProof = structuredClone(f.store.read().changeSets[0].verifications[0].productRelease);
    const changed = map();
    if (changed.kind !== 'workspace') throw new Error('Expected workspace');
    changed.product!.features[0].outcome += ' Сохранить понятное объяснение пользователю.';
    await f.save(changed);
    assert.equal(f.view().features[0].status, 'awaiting-verification');
    assert.throws(() => f.runner.workspace.accept(change.id), /карта изменилась/);
    const workflow = new LeadWorkflow(f.h);
    const job = workflow.start({ kind: 'changeset', id: change.id, authorRuntime: 'codex' });
    // Стадий три, но стадия вправе ответить «жду» — например, пока не истёк
    // lease прежней проверки, — и под нагрузкой полного прогона одного tick на
    // стадию не хватает. Ждём итога с дедлайном; failed и stale — итог, не
    // повод ждать дальше, и при отказе печатается история задания.
    const deadline = Date.now() + 60_000;
    let current = workflow.get(job.key);
    while (['queued', 'running'].includes(current.status) && Date.now() < deadline) {
      await lead.tick();
      current = workflow.get(job.key);
      if (['queued', 'running'].includes(current.status))
        await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(current.status, 'completed', JSON.stringify(current));
    assert.equal(f.view().releaseAccepted, true);
    assert.deepEqual(f.store.read().changeSets[0].verifications[0].productRelease, oldProof);
    await writeFile(join(f.repos[1].path, 'spec.md'), source + 'Новое обязательное условие.\n');
    await f.commit(f.repos[1].path, 'Change local requirement');
    assert.equal(f.view().releaseAccepted, false);
    assert.equal(f.view().coverageComplete, false);
  } finally {
    await lead.stop();
    await f.close();
  }
});

test('A release proof pins only its own tasks: other work in the component keeps it current, relevant changes invalidate it', async () => {
  // В компоненте есть история следующего релиза на тот же REQ: её задачи
  // явно назначены своей истории и не входят в покрытие этого релиза.
  const local = structuredClone(localDefinition);
  local.releases.push({ id: 'later', title: 'Аудит' });
  local.stories.push({
    ...structuredClone(local.stories[0]),
    id: 'audit',
    title: 'Аудит блокировки',
    releaseId: 'later',
    criteria: [{ ...structuredClone(local.stories[0].criteria[0]), id: 'audited' }],
  });
  const f = await fixture(local);
  try {
    f.plan();
    await f.run();
    await f.accept();
    const change = f.runner.workspace.create({
      title: 'Релиз модерации',
      description: 'Приёмка идёт, пока в компоненте работает следующий релиз.',
      boardIds: f.boards,
      releaseId: 'mvp',
    });
    await f.runner.verify(change.id);
    const check = () => {
      const s = f.store.read(),
        c = s.changeSets.find((x) => x.id === change.id)!,
        v = c.verifications.at(-1)!;
      f.intent.validate(v.productRelease!, changeSnapshot(s, c), v.manifest);
    };
    const stale = /Покрытие или проверки релиза изменились; нужна новая проверка/;
    check();
    // (a) Задача другой доски того же компонента проходит ready → running →
    // failed с попытками, выдачей и отказом: приёмка релиза от неё не зависит.
    const next = f.h.createBoard('Следующий релиз', '', 'app');
    const other = f.h.addTask(next.id, {
      ...input('Работа следующего релиза'),
      repositoryId: 'app',
    });
    check();
    for (const [status, extra] of [
      ['ready', {}],
      [
        'running',
        { attempt: 1, activeRunId: 'R-other', budgetBlock: { reason: 'лимит', at: '2026-01-01' } },
      ],
      ['failed', { attempt: 2, activeRunId: undefined, failure: 'Тест упал', neutralFailures: 1 }],
    ] as const) {
      f.store.change('fixture.other-work', (s) => {
        Object.assign(
          s.tasks.find((t) => t.id === other.id)!,
          { status, ...extra },
        );
      });
      check();
    }
    assert.ok(f.view().verification, 'чужая работа не снимает проверку релиза');
    const relevant = f.store
      .read()
      .tasks.find((t) => t.repositoryId === 'app' && t.id !== other.id)!;
    const mutate = (name: string, apply: (s: ReturnType<typeof f.store.read>) => void) => {
      const before = structuredClone(f.store.read());
      f.store.change('fixture.' + name, apply);
      assert.throws(check, stale, name);
      f.store.change('fixture.restore-' + name, (s) => {
        s.tasks = before.tasks;
        s.runs = before.runs;
        s.boards = before.boards;
      });
      check();
    };
    const task = (s: ReturnType<typeof f.store.read>) => s.tasks.find((t) => t.id === relevant.id)!;
    // (b) Поля задачи релиза, которые читают покрытие и приёмка.
    mutate('result-sha', (s) => (task(s).resultSha = 'f'.repeat(40)));
    mutate('status', (s) => (task(s).status = 'running'));
    mutate('requirements', (s) => (task(s).requirements![1].testId = 'other case'));
    mutate('story-bindings', (s) => {
      task(s).storyBindings = [
        { source: 'INTENT.md', id: 'REQ-intent-block', digest: 'x', boundAt: '2026-01-01' },
      ];
    });
    // (c) Новая успешная попытка задачи релиза с другим evidence.
    mutate('new-run', (s) => {
      const last = s.runs.findLast((r) => r.taskId === relevant.id && r.status === 'succeeded')!;
      s.runs.push({ ...structuredClone(last), id: last.id + '-again', evidence: [] });
    });
    // (d) Новая задача в выбранной доске — даже без новой ревизии и без связи
    // с историями релиза: её закрепляет состав доски, а не покрытие.
    mutate('board-task', (s) => {
      const added = {
        ...structuredClone(task(s)),
        id: relevant.id + '-added',
        requirements: undefined,
      };
      s.tasks.push(added);
      s.boards
        .find((b) => b.id === f.boards[0])!
        .revisions.at(-1)!
        .taskIds.push(added.id);
    });
    const detailed = relevant.requirements!.filter((r) => r.source !== 'INTENT.md');
    assert.equal(detailed.length, 1);
    // (iv) Контроль: задача невыбранной доски на тот же подробный REQ, но
    // явно назначенная истории другого релиза, покрытие этого не меняет.
    const audit = f.intent.snapshot({ repositoryId: 'app', storyId: 'audit' });
    if (!audit.stories) throw new Error('Expected stories');
    const assigned = f.h.addTask(next.id, {
      ...input('Аудит блокировки'),
      repositoryId: 'app',
      requirements: [
        { ...audit.stories[0].requirement, gate: 'local', scenario: 'Аудит.' },
        ...structuredClone(detailed),
      ],
    });
    check();
    f.store.change('fixture.assigned-running', (s) => {
      s.tasks.find((t) => t.id === assigned.id)!.status = 'running';
    });
    check();
    // (iii) Задача другой доски заменяет задачу релиза: та становится
    // исключённой — покрытие релиза изменилось.
    mutate('superseded', (s) => {
      const replacement = {
        ...structuredClone(s.tasks.find((t) => t.id === other.id)!),
        id: other.id + '-replacement',
        supersedes: relevant.id,
      };
      s.tasks.push(replacement);
      s.boards
        .find((b) => b.id === next.id)!
        .revisions.at(-1)!
        .taskIds.push(replacement.id);
    });
    // Вид и отчёт совместного gate доказательство не закрепляет: их смена
    // меняет договор проверки ChangeSet (`workspacePolicyDigest`), и прежняя
    // проверка перестаёт быть актуальной до проверки доказательства.
    const gate = structuredClone(f.c.workspaceGates[0]);
    f.c.workspaceGates[0] = { ...gate, kind: 'check' };
    try {
      assert.equal(f.view().verification, undefined);
      assert.throws(() => f.runner.workspace.accept(change.id), /актуальной/);
    } finally {
      f.c.workspaceGates[0] = gate;
    }
    assert.ok(f.view().verification);
    // (i) Живой неназначенный вклад: задача невыбранной доски несёт подробный
    // REQ истории релиза без своей связи REQ-intent — она входит в историю
    // (`belongs`), и прежняя проверка релиза больше не действует.
    const stray = f.h.createBoard('Сторонняя правка', '', 'app');
    const contributor = f.h.addTask(stray.id, {
      ...input('Сторонняя правка блокировки'),
      repositoryId: 'app',
      requirements: structuredClone(detailed),
    });
    assert.throws(check, stale, 'unassigned contributor');
    // (ii) Отменённая, она остаётся в отчёте истории исключённой — набор
    // задач релиза всё равно отличается от закреплённого: нужна новая проверка.
    f.h.cancel(contributor.id, 'Правка не нужна');
    const report = f.intent.report({ repositoryId: 'app', releaseId: 'mvp' }) as {
      stories: { excludedTasks: { id: string }[] }[];
    };
    assert.ok(report.stories[0].excludedTasks.some((t) => t.id === contributor.id));
    assert.throws(check, stale, 'cancelled contributor');
  } finally {
    await f.close();
  }
});

test('Git sync preserves product release binding across clones without importing release acceptance', async () => {
  const f = await fixture();
  let imported: Store | undefined;
  try {
    syncGit(f.h, { member: 'alice' });
    f.plan();
    const change = f.runner.workspace.create({
      title: 'Общий релиз',
      description: 'Переносим общую связь, не локальные проверки.',
      boardIds: f.boards,
      releaseId: 'mvp',
    });
    syncGit(f.h);
    for (const path of [f.control, ...f.repos.map((r) => r.path)])
      await f.commit(path, 'Share portable tasks');
    const control = join(f.root, 'cloned-control');
    await git(f.root, 'clone', '--no-local', f.control, control);
    const repos = [];
    for (const repo of f.repos) {
      const path = join(f.root, 'clone-' + repo.id);
      await git(f.root, 'clone', '--no-local', repo.path, path);
      repos.push({ ...repo, path });
    }
    imported = new Store(join(f.root, 'clone.sqlite'));
    const h = new DevContour(imported, {
      ...f.c,
      repository: repos[0].path,
      repositories: repos,
      workspaceRoot: control,
    });
    syncGit(h, { member: 'bob' });
    const received = imported.read().changeSets.find((c) => c.id === change.id)!;
    assert.equal(received.releaseId, 'mvp');
    assert.equal(received.acceptance, undefined);
    assert.deepEqual(received.verifications, []);
    assert.deepEqual(new IntentService(h).productView(), f.view());
  } finally {
    imported?.close();
    await f.close();
  }
});

test('Joint verification masks secrets in its JUnit copy, evidence, failure and verification error', async () => {
  const f = await fixture();
  // Секрет с кавычкой: в JUnit он появляется как XML-сущность, в JSON — как \".
  const secret = 'joint-secret"7781';
  process.env.DEVCONTOUR_TEST_JOINT_SECRET = secret;
  try {
    f.plan();
    const change = f.runner.workspace.create({
      title: 'Релиз с секретом',
      description: 'Совместная проверка видит секрет окружения.',
      boardIds: f.boards,
      releaseId: 'mvp',
    });
    await f.run();
    await f.accept();
    f.c.environment = {
      inherit: ['PATH', 'HOME'],
      values: {},
      secrets: { SECRET: 'DEVCONTOUR_TEST_JOINT_SECRET' },
    };
    const forms = [secret, secret.replace('"', '&quot;'), secret.replace('"', '\\"')];
    const leaks = (text: string) => forms.filter((form) => text.includes(form));
    const check = async (script: string) => {
      f.c.workspaceGates[0].command = [process.execPath, '-e', script];
      await assert.rejects(f.runner.verify(change.id));
      const verification = f.store
        .read()
        .changeSets.find((c) => c.id === change.id)!
        .verifications.at(-1)!;
      const evidence = verification.evidence.at(-1)!;
      const files = [evidence.log, evidence.log.replace(/\.log$/, '.xml')];
      for (const file of files) {
        const text = await readFile(file, 'utf8').catch(() => '');
        assert.deepEqual(leaks(text), [], file);
      }
      assert.deepEqual(leaks(JSON.stringify(evidence)), [], 'evidence');
      assert.deepEqual(leaks(verification.error ?? ''), [], 'verification.error');
      return evidence;
    };
    // Проваленный testcase с секретом в имени и сообщении.
    const failed = await check(
      `const fs=require('fs');fs.mkdirSync('.reports',{recursive:true});const s=process.env.SECRET.replace(/"/g,'&quot;');fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite tests="1" failures="1"><testcase name="'+s+'"><failure message="'+s+'"/></testcase></testsuite>');`,
    );
    assert.equal(failed.passed, false);
    // Отчёт ссылается на недоступный файл, названный секретом: путь — в
    // тексте ошибки чтения.
    await check(
      `const fs=require('fs'),p=require('path');fs.mkdirSync('.reports',{recursive:true});const t=p.join('.reports',process.env.SECRET);fs.writeFileSync(t,'<testsuite/>');fs.chmodSync(t,0);fs.rmSync(process.env.DEVCONTOUR_REPORT_PATH,{force:true});fs.symlinkSync(p.resolve(t),process.env.DEVCONTOUR_REPORT_PATH);`,
    );
  } finally {
    delete process.env.DEVCONTOUR_TEST_JOINT_SECRET;
    await f.close();
  }
});
