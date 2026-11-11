import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, input, testCheckoutRoot } from './helpers.ts';
import { repositorySchema, type Repository } from '../src/core/model.ts';
import { intentDefinition } from '../src/core/intent.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { IntentService } from '../src/runner/intent.ts';
import { WorkspaceRunner } from '../src/runner/workspace.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { git } from '../src/runner/process.ts';
import { acceptBoard } from '../src/runner/agent-control.ts';
import { requirementSnapshot } from '../src/runner/requirements.ts';

export const source =
  '## REQ-moderation: Ограничения участника\nБлокировка запрещает отправку сообщения.\n';
export const localDefinition = {
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
export const releaseScenario = 'Клиент показывает блокировку, которую применяет API.';
export const sceneProof = { scenario: releaseScenario, testId: 'policy type' };
export const map = () => {
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
export async function fixture(
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
