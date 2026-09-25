import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupDemo } from '../src/demo.ts';
import { loadConfig } from '../src/runner/config.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { repositories } from '../src/core/repositories.ts';
import { IntentService } from '../src/runner/intent.ts';
import { parseIntent, renderIntent } from '../src/core/intent.ts';
import {
  parseRequirements,
  requirementSnapshot,
  correctRequirements,
  requirementReport,
} from '../src/runner/requirements.ts';
import { updateBase } from '../src/runner/base-update.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { adapters, type AgentRequest } from '../src/runner/adapters.ts';
import { acceptBoard } from '../src/runner/agent-control.ts';
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
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-intent-'));
  await setupDemo(root);
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
    close: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
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
