import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setupDemo } from '../src/demo.ts';
import { demoPool } from './demo-pool.ts';
import { loadConfig } from '../src/runner/config.ts';
import { DevContour, digest, specDigest } from '../src/core/service.ts';
import { AgentService } from '../src/application/agent.ts';
import { Store } from '../src/core/store.ts';
import { repositories } from '../src/core/repositories.ts';
import { IntentService, type StoryGap } from '../src/runner/intent.ts';
import { parseIntent, renderIntent } from '../src/core/intent.ts';
import type { RequirementLink } from '../src/core/model.ts';
import {
  parseRequirements,
  requirementSnapshot,
  correctRequirements,
  requirementReport,
} from '../src/runner/requirements.ts';
import { updateBase } from '../src/runner/base-update.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { adapters, type AgentRequest } from '../src/runner/adapters.ts';
import { acceptBoard, reviewPlan } from '../src/runner/agent-control.ts';
import { git, command } from '../src/runner/process.ts';
import { syncGit } from '../src/runner/git-sync.ts';
import { input } from './helpers.ts';

const spec =
  '## REQ-list: Catalogue\nList products.\n## REQ-later: Export\nExport products.\n## REQ-out: Billing\nBilling is excluded.\n';
const definition = () => ({
  kind: 'component',
  title: 'Product catalogue',
  purpose: 'Help operators find products.',
  audience: ['Catalogue operators'],
  constraints: ['Keep access control'],
  nonGoals: ['No billing'],
  sources: ['docs/spec.md'],
  releases: [
    { id: 'mvp', title: 'First release' },
    { id: 'later', title: 'Later release' },
  ],
  stories: [
    {
      id: 'list',
      title: 'Operator lists products',
      releaseId: 'mvp',
      criteria: [
        {
          id: 'ac-list',
          text: 'Show the catalogue to the operator.',
          requirements: [{ source: 'docs/spec.md', id: 'REQ-list' }],
        },
      ],
    },
    {
      id: 'export',
      title: 'Operator exports products',
      releaseId: 'later',
      criteria: [
        {
          id: 'ac-export',
          text: 'Export the catalogue.',
          requirements: [{ source: 'docs/spec.md', id: 'REQ-later' }],
        },
      ],
    },
  ],
  exclusions: [
    {
      source: 'docs/spec.md',
      id: 'REQ-out',
      reason: 'Billing is outside the requested product scope.',
    },
  ],
});
const demos = demoPool(setupDemo);
after(() => demos.close());
async function fixture() {
  const seed = await demos.acquire();
  const root = seed.root;
  const config = loadConfig(join(root, 'config.json'));
  const store = new Store(join(root, 'state.sqlite')),
    h = new DevContour(store, config),
    intent = new IntentService(h);
  store.change('fixture.reset', (s) => {
    s.tasks = [];
    s.boards = [];
    s.runs = [];
  });
  await mkdir(join(config.repository, 'docs'), { recursive: true });
  await writeFile(join(config.repository, '.gitignore'), '.reports/\n.devcontour-local/\n');
  await writeFile(join(config.repository, 'docs/spec.md'), spec);
  await git(config.repository, 'add', 'docs/spec.md', '.gitignore');
  await git(config.repository, 'commit', '-m', 'Source requirements');
  const save = async (value = definition()) => {
    const result = intent.render({ repositoryId: 'main', definition: value });
    await writeFile(join(config.repository, 'INTENT.md'), result.markdown);
    await git(config.repository, 'add', 'INTENT.md');
    await git(config.repository, 'commit', '-m', 'Product intent');
    return result.markdown;
  };
  await save();
  // Fixture bootstrap precedes any runs; production refs are only advanced by the runner.
  await git(config.repository, 'update-ref', 'refs/heads/' + config.targetBranch, 'HEAD');
  return {
    root,
    config,
    store,
    h,
    intent,
    save,
    report: () => intent.report({ repositoryId: 'main', releaseId: 'mvp' }) as any,
    close: () => {
      store.close();
      seed.release();
      return Promise.resolve();
    },
  };
}
/** Отчёт покрытия в той мере, в какой его читают тесты исключённой работы. */
type Coverage = {
  coverageComplete: boolean;
  stories: {
    verified: boolean;
    taskIds: string[];
    excludedTasks: { id: string; reason: string }[];
    criteria: { requirements: { status: string }[] }[];
  }[];
};
/** Покрытие с задачами, привязанными к истории после приёмки (`task_story`). */
type Bound = Coverage & {
  stories: {
    unverifiedTaskIds: string[];
    boundTasks?: { id: string; boundAfterAcceptance: true; fresh: boolean }[];
  }[];
  invalidStoryBindings?: { taskId: string; id: string }[];
};
function links(f: Awaited<ReturnType<typeof fixture>>) {
  const binding = (f.intent.snapshot({ repositoryId: 'main', storyId: 'list' }) as any).stories[0]
    .requirement;
  const detailed = requirementSnapshot(f.config.repository, 'docs/spec.md').requirements[0];
  return [binding, { ...detailed, source: 'docs/spec.md' }].map((r) => ({
    ...r,
    gate: f.config.gates[0].id,
    scenario: 'Catalogue listing for the operator',
  }));
}

test('Intent format pins local sources, rejects ambiguous IDs and stale generated prose, and never writes files', async () => {
  const f = await fixture();
  try {
    const original = await readFile(join(f.config.repository, 'INTENT.md'), 'utf8');
    const doc = parseIntent(original);
    assert.equal(renderIntent(doc), original);
    assert.equal(parseRequirements(original).length, 2);
    assert.throws(
      () => parseIntent(original.replace('Product context:', 'Weakened context:')),
      /расходятся/,
    );
    assert.throws(
      () =>
        f.intent.render({
          repositoryId: 'main',
          definition: {
            ...definition(),
            stories: [definition().stories[0], definition().stories[0]],
          },
        }),
      /Повтор/,
    );
    assert.throws(() =>
      f.intent.render({
        repositoryId: 'main',
        definition: { ...definition(), sources: ['../elsewhere/spec.md'] },
      }),
    );
    assert.throws(() => f.intent.render({ definition: definition() }), /владельцу/);
    const changed = definition();
    changed.stories[0].criteria[0].requirements[0].id = 'REQ-absent';
    assert.throws(
      () => f.intent.render({ repositoryId: 'main', definition: changed }),
      /Неизвестное требование/,
    );
    const injected = definition();
    injected.purpose = 'Purpose\n## REQ-injected: fake\n```devcontour-intent';
    const rendered = f.intent.render({ repositoryId: 'main', definition: injected }).markdown;
    assert.equal(parseRequirements(rendered).length, 2);
    parseIntent(rendered);
    assert.equal(await readFile(join(f.config.repository, 'INTENT.md'), 'utf8'), original);
    await symlink('docs/spec.md', join(f.config.repository, 'link.md'));
    await git(f.config.repository, 'add', 'link.md');
    await git(f.config.repository, 'commit', '-m', 'Symlink fixture');
    const linked = definition();
    linked.sources = ['link.md'];
    linked.stories.forEach((s) =>
      s.criteria.forEach((c) =>
        c.requirements.forEach((r) => {
          r.source = 'link.md';
        }),
      ),
    );
    linked.exclusions.forEach((r) => {
      r.source = 'link.md';
    });
    assert.throws(
      () =>
        f.intent.render({
          repositoryId: 'main',
          definition: linked,
        }),
      /обычным Git-файлом/,
    );
  } finally {
    await f.close();
  }
});

test('Release audit finds undecomposed stories, forgotten REQs, missing sources and stale exclusions from the specification', async () => {
  const f = await fixture();
  try {
    let report = f.report();
    assert.equal(report.coverageComplete, false);
    assert.equal(report.stories[0].taskIds.length, 0);
    assert.equal(report.counts.stories, 1); // Future release is declared, not required now.
    assert.deepEqual(report.issues, []);
    await writeFile(
      join(f.config.repository, 'docs/spec.md'),
      spec + '## REQ-forgotten: Search\nSearch all products.\n',
    );
    // Uncommitted files do not change the release baseline.
    assert.deepEqual(f.report().issues, []);
    await git(f.config.repository, 'add', 'docs/spec.md');
    await git(f.config.repository, 'commit', '-m', 'New requirement');
    report = f.report();
    assert.ok(
      report.issues.some((x: any) => x.kind === 'unmapped-requirement' && x.id === 'REQ-forgotten'),
    );
    await writeFile(
      join(f.config.repository, 'docs/spec.md'),
      spec.replace('Billing is excluded.', 'Billing is now required.'),
    );
    await git(f.config.repository, 'add', 'docs/spec.md');
    await git(f.config.repository, 'commit', '-m', 'Change excluded requirement');
    assert.ok(f.report().issues.some((x: any) => x.kind === 'stale-exclusion'));
    await git(f.config.repository, 'rm', 'docs/spec.md');
    await git(f.config.repository, 'commit', '-m', 'Remove source');
    assert.equal(f.report().coverageComplete, false);
    assert.ok(f.report().issues.some((x: any) => x.kind === 'unavailable-source'));
  } finally {
    await f.close();
  }
});

test('Real Git acceptance covers intent; criteria changes invalidate coverage and correction preserves history', async () => {
  const f = await fixture();
  const prompts: string[] = [];
  let replacement: string | undefined;
  const scheduler = new Scheduler(f.h, f.root, {
    ...adapters,
    demo: {
      name: 'demo',
      execute: async (r: AgentRequest) => {
        prompts.push(r.prompt);
        if (!r.review && replacement) await writeFile(join(r.cwd, 'INTENT.md'), replacement);
        return adapters.demo.execute(r);
      },
    },
  });
  try {
    const board = f.h.createBoard('Intent acceptance', '', 'main');
    const task = f.h.addTask(board.id, { ...input(), requirements: links(f) });
    f.h.approve(board.id);
    await scheduler.init();
    // Требование только что закоммичено в рабочую ветку: база прогонов должна
    // его содержать, иначе исполнитель ищет источник в дереве без него.
    await updateBase(f.config, f.root);
    f.h.pause(false);
    await scheduler.drain();
    assert.equal(f.store.read().tasks[0].status, 'done', f.store.read().tasks[0].failure);
    assert.equal(f.report().coverageComplete, true);
    assert.equal(f.report().releaseAccepted, false);
    assert.equal(prompts.length, 3);
    assert.ok(
      prompts.every((p) => p.includes('Keep access control') && p.includes('REQ-intent-list')),
    );
    await acceptBoard(f.h, board.id, 'codex');
    const history = f.store.read().boards[0].revisions[0].snapshot!.digest;
    const altered = definition();
    altered.stories[0].criteria[0].text = 'Show the catalogue with a result count.';
    replacement = await f.save(altered);
    assert.equal(f.report().coverageComplete, false);
    correctRequirements(f.h, board.id, 'Revise the visible acceptance criterion');
    const next = f.store.read().tasks.find((t) => t.supersedes === task.id)!;
    assert.equal(next.status, 'draft');
    f.h.approve(board.id);
    await updateBase(f.config, f.root);
    await scheduler.drain();
    assert.equal(f.store.read().tasks.find((t) => t.id === next.id)!.status, 'done');
    assert.equal(f.report().coverageComplete, true);
    assert.deepEqual((f.report() as Coverage).stories[0].excludedTasks, [
      { id: task.id, reason: 'superseded' },
    ]);
    assert.equal(f.store.read().boards[0].revisions[0].snapshot!.digest, history);
    // Matching task state alone cannot hide a missing test record.
    const proof = f.store.read().runs.find((r) => r.taskId === next.id)!.evidence;
    f.store.change('fixture.remove-proof', (s) => {
      s.runs.find((r) => r.taskId === next.id)!.evidence = [];
    });
    assert.equal(f.report().coverageComplete, false);
    f.store.change('fixture.restore-proof', (s) => {
      s.runs.find((r) => r.taskId === next.id)!.evidence = proof;
    });
    assert.equal(f.report().coverageComplete, true);
    const extraBoard = f.h.createBoard('Unassigned contribution', '', 'main');
    const extra = f.h.addTask(extraBoard.id, { ...input(), requirements: links(f).slice(1) });
    assert.equal(f.report().coverageComplete, false);
    assert.ok(f.report().stories[0].unverifiedTaskIds.includes(extra.id));
  } finally {
    await scheduler.stop();
    await f.close();
  }
});

test('A story whose only linked tasks are cancelled is uncovered, and the cancelled work stays visible as excluded', async () => {
  const f = await fixture();
  try {
    const report = () => f.report() as Coverage;
    const board = f.h.createBoard('Abandoned plan', '', 'main');
    const task = f.h.addTask(board.id, { ...input(), requirements: links(f) });
    assert.equal(report().stories[0].criteria[0].requirements[0].status, 'unverified');
    f.h.cancel(task.id, 'Plan replaced');
    const story = report().stories[0];
    assert.equal(report().coverageComplete, false);
    assert.equal(story.verified, false);
    assert.deepEqual(story.taskIds, []);
    assert.deepEqual(story.excludedTasks, [{ id: task.id, reason: 'cancelled' }]);
    assert.equal(story.criteria[0].requirements[0].status, 'unplanned');
  } finally {
    await f.close();
  }
});

test('Workspace intent pins component releases and returns references without component task details', async () => {
  const f = await fixture();
  try {
    const control = join(f.root, 'control'),
      library = join(f.root, 'library');
    await mkdir(control);
    await git(control, 'init', '-b', 'main');
    await git(control, 'config', 'user.name', 'Intent fixture');
    await git(control, 'config', 'user.email', 'fixture@example.invalid');
    await git(f.root, 'clone', '--no-local', f.config.repository, library);
    f.config.workspaceRoot = control;
    const main = repositories(f.config)[0];
    f.config.repositories = [
      main,
      { ...main, id: 'library', name: 'Library', kind: 'library', path: library },
    ];
    const definition = {
      kind: 'workspace',
      title: 'Shared product release',
      purpose: 'Coordinate catalogue and library.',
      releases: [
        {
          id: 'mvp',
          title: 'Shared release',
          components: [
            { repositoryId: 'main', releaseId: 'mvp' },
            { repositoryId: 'library', releaseId: 'mvp' },
          ],
        },
      ],
    };
    const rendered = f.intent.render({ definition });
    await writeFile(join(control, 'INTENT.md'), rendered.markdown);
    await git(control, 'add', 'INTENT.md');
    await git(control, 'commit', '-m', 'Pin shared intent');
    const report = f.intent.report({ releaseId: 'mvp' }) as any;
    assert.equal(report.components.length, 2);
    assert.ok(report.components.every((c: any) => c.fresh));
    assert.equal(report.coverageComplete, false);
    assert.ok(!JSON.stringify(report).includes('Show the catalogue'));
    assert.ok(!JSON.stringify(report).includes('taskIds'));
    const next = parseIntent(await readFile(join(library, 'INTENT.md'), 'utf8')) as any;
    next.constraints.push('Library compatibility guarantee');
    await writeFile(join(library, 'INTENT.md'), renderIntent(next));
    await git(library, 'config', 'user.name', 'Intent fixture');
    await git(library, 'config', 'user.email', 'fixture@example.invalid');
    await git(library, 'add', 'INTENT.md');
    await git(library, 'commit', '-m', 'Revise library intent');
    assert.equal((f.intent.report({ releaseId: 'mvp' }) as any).components[1].fresh, false);
  } finally {
    await f.close();
  }
});

test('Intent and task bindings survive an independent Git clone without centralizing component content', async () => {
  const f = await fixture();
  let cloneStore: Store | undefined;
  try {
    const workspace = join(f.root, 'workspace');
    await mkdir(workspace);
    await git(workspace, 'init', '-b', 'main');
    await git(workspace, 'config', 'user.name', 'Fixture');
    await git(workspace, 'config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(workspace, '.gitignore'), '.devcontour-local/\n');
    await git(workspace, 'add', '.gitignore');
    await git(workspace, 'commit', '-m', 'Workspace');
    f.config.workspaceRoot = workspace;
    syncGit(f.h, { member: 'alice' });
    const board = f.h.createBoard('Portable intent', '', 'main');
    const task = f.h.addTask(board.id, { ...input(), requirements: links(f) });
    syncGit(f.h);
    for (const path of [f.config.repository, workspace]) {
      await git(path, 'add', '.devcontour');
      await git(path, 'commit', '-m', 'Portable state');
    }
    const clone = join(f.root, 'clone'),
      clonedWorkspace = join(f.root, 'cloned-workspace');
    await git(f.root, 'clone', '--no-local', f.config.repository, clone);
    await git(f.root, 'clone', '--no-local', workspace, clonedWorkspace);
    cloneStore = new Store(join(f.root, 'clone.sqlite'));
    const h = new DevContour(cloneStore, {
      ...f.config,
      repository: clone,
      workspaceRoot: clonedWorkspace,
    });
    syncGit(h, { member: 'bob' });
    assert.deepEqual(
      cloneStore.read().tasks.find((t) => t.id === task.id)!.requirements,
      task.requirements,
    );
    assert.equal(
      (new IntentService(h).snapshot({ repositoryId: 'main', storyId: 'list' }) as any).stories[0]
        .requirement.digest,
      task.requirements![0].digest,
    );
    const shared = await git(
      workspace,
      'grep',
      '-l',
      'Show the catalogue',
      'HEAD',
      '--',
      '.devcontour',
    ).catch(() => '');
    assert.equal(shared, '');
    const check = await command(
      [
        process.execPath,
        '--import',
        'tsx',
        'src/cli.ts',
        'intent-report',
        '--repository-id',
        'main',
        '--release',
        'mvp',
        '--require-complete',
        '--data',
        f.root,
      ],
      process.cwd(),
      { timeoutMs: 15000 },
    );
    assert.equal(check.code, 1);
    assert.equal(JSON.parse(check.stdout).coverageComplete, false);
  } finally {
    cloneStore?.close();
    await f.close();
  }
});

test('Покрытие INTENT подтверждается тем же правилом testcase, что и отчёт требований', async () => {
  // INTENT проверял только зелёную проверку: при proof:none в отчёте
  // требований покрытие объявлялось полным, а критерий — verified.
  const f = await fixture();
  const scheduler = new Scheduler(f.h, f.root);
  try {
    const board = f.h.createBoard('Required testcase coverage', '', 'main');
    f.h.addTask(board.id, {
      ...input(),
      requirements: links(f).map((r) => ({ ...r, testId: 'current-task-result' })),
    });
    f.h.approve(board.id);
    await scheduler.init();
    await updateBase(f.config, f.root);
    f.h.pause(false);
    await scheduler.drain();
    assert.equal(f.store.read().tasks[0].status, 'done');
    // Названный тест выполнился: оба отчёта согласны, покрытие полное.
    assert.ok(
      requirementReport(f.h, 'main').tasks[0].requirements.every((r) => r.proof === 'testcase'),
    );
    assert.equal(f.report().coverageComplete, true);

    // Тот же результат и та же постановка, но в манифесте выполненных тестов
    // названного testcase нет. Постановку не трогаем: иначе покрытие
    // сломалось бы по изменению digest, а не по отсутствию доказательства.
    f.store.change('fixture.drop-testcase', (s) => {
      for (const run of s.runs)
        for (const e of run.evidence)
          if (e.tests) e.tests = e.tests.filter((t) => t.id !== 'current-task-result');
    });
    assert.ok(
      requirementReport(f.h, 'main').tasks[0].requirements.every((r) => r.proof === 'none'),
    );
    const report = f.report();
    assert.equal(report.coverageComplete, false);
    assert.equal(report.stories[0].criteria[0].verified, false);
  } finally {
    await scheduler.stop();
    await f.close();
  }
});

test('Утверждение отклоняет задачу с подробным REQ истории без связи с историей до вызова модели', async () => {
  const f = await fixture();
  try {
    const [story] = links(f) as RequirementLink[];
    const board = f.h.createBoard('Story binding at approval', '', 'main');
    const detailed = f.h.addTask(board.id, { ...input(), requirements: links(f).slice(1) });
    // Предупреждение плана — до ревью: ведущий исправит черновик сразу.
    const warned = new AgentService(f.h).execute({
      operation: 'task_create',
      input: { boardId: board.id, task: { ...input(), requirements: links(f).slice(1) } },
    }) as { taskId: string; storyGaps: StoryGap[] };
    assert.deepEqual(warned.storyGaps[0].candidates, [
      { storyId: 'list', source: 'INTENT.md', id: 'REQ-intent-list', digest: story.digest },
    ]);
    assert.equal(warned.storyGaps[0].kind, 'missing-story');
    assert.deepEqual(warned.storyGaps[0].requirementIds, ['REQ-list']);
    f.h.cancel(warned.taskId, 'Duplicate draft of the warning check');
    const imported = new AgentService(f.h).execute({
      operation: 'plan_import',
      input: {
        plan: {
          title: 'Imported unbound plan',
          description: 'Plan whose task lacks the story link',
          tasks: [{ ...input(), key: 'a', contracts: [], requirements: links(f).slice(1) }],
        },
      },
    }) as { boardId: string; storyGaps: StoryGap[]; storyWarning: string };
    assert.equal(imported.storyGaps.length, 1);
    assert.deepEqual(imported.storyGaps[0].requirementIds, ['REQ-list']);
    assert.match(imported.storyWarning, /REQ-intent-list/);
    const refusal = (e: unknown) => {
      const message = (e as Error).message;
      assert.match(message, new RegExp(detailed.id + ': REQ-list входит в критерии истории list'));
      assert.ok(message.includes('"id":"REQ-intent-list"'), message);
      assert.ok(message.includes(story.digest), message);
      return true;
    };
    assert.throws(() => f.h.approve(board.id), refusal);
    // Ревью плана отклоняет тот же план до модели.
    let calls = 0;
    const counting = {
      name: 'counting',
      execute: () => {
        calls++;
        return Promise.reject(new Error('model must not be called'));
      },
    };
    const runtimes = { codex: counting, claude: counting } as unknown as Parameters<
      typeof reviewPlan
    >[4];
    await assert.rejects(reviewPlan(f.h, f.root, board.id, 'codex', runtimes), refusal);
    assert.equal(calls, 0);
    assert.equal(f.store.read().tasks.find((t) => t.id === detailed.id)!.status, 'draft');
    // Устаревшая связь с историей — тот же отказ с текущим digest.
    const stale = links(f) as RequirementLink[];
    const earlier = 'Earlier text of the story before the map was revised.';
    stale[0] = { ...stale[0], text: earlier, digest: digest(earlier) };
    f.h.editTask(detailed.id, { ...input(), requirements: stale }, specDigest(detailed));
    assert.throws(() => f.h.approve(board.id), /REQ-intent-list устарела/);
    // REQ, не входящий ни в одну историю, связи с историей не требует.
    const excluded = requirementSnapshot(f.config.repository, 'docs/spec.md').requirements.find(
      (r) => r.id === 'REQ-out',
    )!;
    const current = f.store.read().tasks.find((t) => t.id === detailed.id)!;
    f.h.editTask(
      detailed.id,
      {
        ...input(),
        requirements: [
          {
            ...excluded,
            source: 'docs/spec.md',
            gate: f.config.gates[0].id,
            scenario: 'Billing stays out of scope',
          },
        ],
      },
      specDigest(current),
    );
    const other = f.h.createBoard('Story binding: unrelated requirement', '', 'main');
    f.h.addTask(other.id, { ...input(), requirements: links(f) });
    f.h.approve(other.id);
    f.h.approve(board.id);
    assert.ok(
      f.store
        .read()
        .tasks.filter((t) => t.id === detailed.id || t.id === warned.taskId)
        .every((t) => t.status !== 'draft'),
    );
  } finally {
    await f.close();
  }
});

test('Нечитаемая карта INTENT останавливает утверждение, а отсутствующая — нет', async () => {
  const f = await fixture();
  try {
    const detailedOnly = links(f).slice(1) as RequirementLink[];
    const board = f.h.createBoard('Unreadable intent map', '', 'main');
    f.h.addTask(board.id, { ...input(), requirements: detailedOnly });
    const markdown = await readFile(join(f.config.repository, 'INTENT.md'), 'utf8');
    await writeFile(
      join(f.config.repository, 'INTENT.md'),
      markdown.replace('Product context:', 'Weakened context:'),
    );
    await git(f.config.repository, 'commit', '-qam', 'Hand-edited intent prose');
    assert.throws(
      () => f.h.approve(board.id),
      /Карта INTENT INTENT\.md компонента main не читается/,
    );
    assert.match(
      (
        new AgentService(f.h).execute({
          operation: 'task_create',
          input: { boardId: board.id, task: { ...input(), requirements: detailedOnly } },
        }) as { storyWarning: string }
      ).storyWarning,
      /не читается/,
    );
    await git(f.config.repository, 'rm', '-q', 'INTENT.md');
    await git(f.config.repository, 'commit', '-m', 'No intent map');
    f.h.approve(board.id);
    assert.ok(f.store.read().tasks.every((t) => t.status === 'ready'));
  } finally {
    await f.close();
  }
});

test('task_story привязывает принятую задачу к истории без изменения постановки и теряет силу со сменой истории', async () => {
  const f = await fixture();
  const scheduler = new Scheduler(f.h, f.root);
  const agent = new AgentService(f.h);
  const reason = 'Work implements the story but was approved unbound';
  const bind = (taskIds: string[], storyId = 'list', repositoryId?: string) =>
    agent.execute({
      operation: 'task_story',
      input: { storyId, taskIds, reason, ...(repositoryId ? { repositoryId } : {}) },
    }) as { binding: { id: string } };
  const report = () => f.report() as Bound;
  const read = (id: string) => f.store.read().tasks.find((t) => t.id === id)!;
  try {
    // Задачи утверждены, когда карты INTENT ещё не было: так возникает
    // принятая работа без связи с историей.
    const all = links(f) as RequirementLink[];
    const detailedOnly = all.slice(1);
    await git(f.config.repository, 'rm', '-q', 'INTENT.md');
    await git(f.config.repository, 'commit', '-m', 'Intent not yet written');
    const board = f.h.createBoard('Unbound accepted work', '', 'main');
    const done = f.h.addTask(board.id, { ...input('Unbound A'), requirements: detailedOnly });
    const other = f.h.addTask(board.id, { ...input('Unbound B'), requirements: detailedOnly });
    const linked = f.h.addTask(board.id, { ...input('Linked'), requirements: all });
    f.h.approve(board.id);
    await git(f.config.repository, 'revert', '--no-edit', 'HEAD');
    await scheduler.init();
    await updateBase(f.config, f.root);
    f.h.pause(false);
    await scheduler.drain();
    for (const t of [done, other, linked])
      assert.equal(read(t.id).status, 'done', read(t.id).failure);
    const accepted = read(done.id);
    assert.equal(report().coverageComplete, false);
    assert.deepEqual(report().stories[0].unverifiedTaskIds.sort(), [done.id, other.id].sort());

    // Привязка из Git sync проверяется заново: запись к истории, в критерии
    // которой REQ задачи не входит, не действует и не уводит задачу из истории.
    f.store.change('fixture.foreign-binding', (s) => {
      s.tasks.find((t) => t.id === done.id)!.storyBindings = [
        {
          source: 'INTENT.md',
          id: 'REQ-intent-export',
          digest: 'e'.repeat(64),
          boundAt: accepted.createdAt,
        },
      ];
    });
    assert.ok(report().stories[0].taskIds.includes(done.id));
    assert.deepEqual(report().invalidStoryBindings, [{ taskId: done.id, id: 'REQ-intent-export' }]);
    f.store.change('fixture.drop-foreign-binding', (s) => {
      delete s.tasks.find((t) => t.id === done.id)!.storyBindings;
    });

    // Отказы: неизвестная история, REQ вне критериев, не выполненная задача,
    // задача со связью в постановке, задачи чужого компонента.
    assert.throws(() => bind([done.id], 'absent'), /Неизвестная история absent/);
    assert.throws(() => bind([done.id], 'export'), /REQ-list не входит в критерии истории export/);
    const draftBoard = f.h.createBoard('Unbound draft', '', 'main');
    const draft = f.h.addTask(draftBoard.id, { ...input(), requirements: detailedOnly });
    assert.throws(() => bind([done.id, draft.id]), /только выполненную задачу/);
    f.h.cancel(draft.id, 'Not part of the binding check');
    assert.throws(() => bind([linked.id]), /уже связана с историей в постановке/);
    const main = repositories(f.config)[0];
    f.config.repositories = [main, { ...main, id: 'library', name: 'Library' }];
    const shared = f.h.createBoard('Library work', '', 'library');
    const foreign = f.h.addTask(shared.id, { ...input(), repositoryId: 'library' });
    assert.throws(() => bind([done.id, foreign.id]), /одного компонента/);
    assert.throws(() => bind([done.id], 'list', 'library'), /одного компонента/);
    assert.throws(
      () =>
        f.h.bindStory({
          repositoryId: 'library',
          storyId: 'list',
          binding: { source: 'INTENT.md', id: 'REQ-intent-list', digest: all[0].digest },
          criteria: [JSON.stringify(['docs/spec.md', 'REQ-list'])],
          taskIds: [done.id],
          reason,
          actor: 'operator',
        }),
      /вне компонента library/,
    );
    f.h.cancel(foreign.id, 'Only used for the component check');
    f.config.repositories = [main];
    // В operator mode агент сам историю не подтверждает.
    f.config.approvalMode = 'operator';
    assert.throws(() => bind([other.id]), /выполняет оператор: devcontour task-story/);
    f.config.approvalMode = 'agent';
    assert.equal(read(done.id).storyBindings, undefined);
    assert.equal(read(other.id).storyBindings, undefined);

    // Оператор привязывает через CLI, агент в agent mode — через API.
    const cli = await command(
      [
        process.execPath,
        '--import',
        'tsx',
        'src/cli.ts',
        'task-story',
        '--story',
        'list',
        '--tasks',
        done.id,
        '--reason',
        reason,
        '--data',
        f.root,
      ],
      process.cwd(),
      { timeoutMs: 30000 },
    );
    assert.equal(cli.code, 0, cli.stderr);
    assert.equal((JSON.parse(cli.stdout) as { actor: string }).actor, 'operator');
    assert.equal(bind([other.id]).binding.id, 'REQ-intent-list');
    const bound = read(done.id);
    assert.equal(bound.approvedDigest, accepted.approvedDigest);
    assert.equal(specDigest(bound), accepted.approvedDigest);
    assert.deepEqual(bound.requirements, accepted.requirements);
    const journaled = f.store
      .events()
      .filter((e) => e.type === 'task.story')
      .map((e) => JSON.stringify(e.data));
    assert.equal(journaled.length, 2);
    assert.ok(
      journaled.some(
        (e) => e.includes(done.id) && e.includes(reason) && e.includes('"actor":"operator"'),
      ),
    );
    assert.ok(journaled.some((e) => e.includes(other.id) && e.includes('"actor":"agent"')));
    assert.equal(report().coverageComplete, true);
    assert.equal(report().stories[0].verified, true);
    assert.deepEqual(
      report()
        .stories[0].boundTasks?.map((t) => t.id)
        .sort(),
      [done.id, other.id].sort(),
    );
    assert.ok(report().stories[0].boundTasks?.every((t) => t.boundAfterAcceptance && t.fresh));
    assert.equal(report().invalidStoryBindings, undefined);
    // Привязка не заменяет доказательство: без записи теста подробной связи
    // история снова не подтверждена.
    const proof = f.store.read().runs.find((r) => r.taskId === done.id)!.evidence;
    f.store.change('fixture.remove-proof', (s) => {
      s.runs.find((r) => r.taskId === done.id)!.evidence = [];
    });
    assert.equal(report().stories[0].verified, false);
    f.store.change('fixture.restore-proof', (s) => {
      s.runs.find((r) => r.taskId === done.id)!.evidence = proof;
    });
    assert.equal(report().stories[0].verified, true);

    // Текст истории изменился: автор его не видел, привязка к прежнему
    // тексту историю больше не подтверждает, и повторная привязка этого не
    // обходит — нужна корректировка с повторным прогоном.
    const altered = definition();
    altered.stories[0].criteria[0].text = 'Show the catalogue with a result count.';
    await f.save(altered);
    assert.equal(report().coverageComplete, false);
    assert.ok(report().stories[0].unverifiedTaskIds.includes(done.id));
    assert.equal(report().stories[0].boundTasks?.[0].fresh, false);
    assert.throws(() => bind([done.id]), /уже привязана к истории list.*board_correct/);
    assert.equal(report().stories[0].verified, false);

    // Замена корректировкой привязку оригинала не наследует, а заменённый
    // оригинал больше не привязать.
    // Приёмка доски здесь не предмет проверки: ревизия помечается принятой.
    f.store.change('fixture.accept-revision', (s) => {
      s.boards.find((b) => b.id === board.id)!.revisions.at(-1)!.status = 'accepted';
    });
    const corrected = f.h.correct(board.id, [done.id], 'Re-run against the revised story text');
    const replacement = read(corrected.replacements[done.id]);
    assert.equal(replacement.status, 'draft');
    assert.equal(replacement.storyBindings, undefined);
    assert.throws(() => bind([done.id]), /заменена корректировкой/);
  } finally {
    await scheduler.stop();
    await f.close();
  }
});
