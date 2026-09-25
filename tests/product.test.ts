import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, input } from './helpers.ts';
import { repositorySchema, type Repository } from '../src/core/model.ts';
import { intentDefinition, parseIntent } from '../src/core/intent.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { Workspace } from '../src/core/workspace.ts';
import { IntentService } from '../src/runner/intent.ts';
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
                scenario: 'Клиент показывает блокировку, которую применяет API.',
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
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-product-'));
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
      intent.render({ repositoryId: repo.id, definition: localDefinition }).markdown,
    );
    await commit(repo.path, 'Local product stories');
  }
  const save = async (definition = map()) => {
    await writeFile(join(control, 'INTENT.md'), intent.render({ definition }).markdown);
    await commit(control, 'Product map');
  };
  await save();
  await writeFile(join(root, 'config.json'), JSON.stringify(c));
  const scheduler = new Scheduler(h, root),
    runner = new WorkspaceRunner(h, root);
  await scheduler.init();
  const boards: string[] = [];
  const plan = () => {
    for (const repo of repos) {
      const board = h.createBoard('Сценарий блокировки ' + repo.id, '', repo.id);
      const snapshot = intent.snapshot({ repositoryId: repo.id, storyId: 'block' });
      if (!snapshot.stories) throw new Error('Expected stories');
      const local = requirementSnapshot(repo.path, 'spec.md').requirements[0];
      h.addTask(board.id, {
        ...input('Блокировка в ' + repo.id),
        repositoryId: repo.id,
        requirements: [snapshot.stories[0].requirement, { ...local, source: 'spec.md' }].map(
          (r) => ({ ...r, gate: 'local', scenario: 'Проверка ограничения участника.' }),
        ),
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
