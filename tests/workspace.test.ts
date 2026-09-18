import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, input, fixture, complete } from './helpers.ts';
import { repositorySchema } from '../src/core/model.ts';
import { DevContour, specDigest } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { Workspace } from '../src/core/workspace.ts';
import { WorkspaceRunner } from '../src/runner/workspace.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { adapters, type AgentRequest } from '../src/runner/adapters.ts';
import { reserveRepositories } from '../src/runner/ownership.ts';
import { attachJournal } from '../src/runner/journal.ts';
import { setupWorkspace } from '../src/runner/workspace-setup.ts';
import { loadConfig } from '../src/runner/config.ts';
import { git } from '../src/runner/process.ts';
import { acceptBoard } from '../src/runner/agent-control.ts';

const localTest = `import {readFileSync,writeFileSync} from 'node:fs';
const n=JSON.parse(readFileSync('value.json','utf8'));
const ok=typeof n==='number';
writeFileSync(process.env.DEVCONTOUR_REPORT_PATH, '<testsuite><testcase name="numeric value">'+(ok?'':'<failure/>')+'</testcase></testsuite>');
process.exitCode=ok?0:1;`;
const combinedTest = `import {readFileSync,writeFileSync} from 'node:fs';
const paths=JSON.parse(process.env.DEVCONTOUR_COMPONENTS_JSON);
const manifest=JSON.parse(readFileSync(process.env.DEVCONTOUR_MANIFEST_PATH,'utf8'));
const actual=JSON.parse(readFileSync(paths.library+'/value.json','utf8'));
const expected=JSON.parse(readFileSync(paths.product+'/value.json','utf8'));
const ok=actual===expected && manifest.components.library.path===paths.library;
writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase name="product consumes library">'+(ok?'':'<failure message="incompatible library"/>')+'</testcase></testsuite>');
if(!ok) console.error('incompatible library',actual,expected);
process.exitCode=ok?0:1;`;
async function multiRepo() {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-workspace-'));
  const repos = [];
  for (const id of ['product', 'library']) {
    const path = join(root, id);
    await mkdir(path);
    await git(path, 'init', '-b', 'main');
    await git(path, 'config', 'user.email', 'fixture@example.invalid');
    await git(path, 'config', 'user.name', 'DevContour fixture');
    await writeFile(join(path, '.gitignore'), '.reports/\n');
    await writeFile(join(path, 'value.json'), '1');
    await writeFile(join(path, 'local.mjs'), localTest);
    if (id === 'product') await writeFile(join(path, 'integration.mjs'), combinedTest);
    await git(path, 'add', '.');
    await git(path, 'commit', '-m', 'fixture');
    repos.push(
      repositorySchema.parse({
        id,
        name: id,
        kind: id,
        path,
        gates: [
          {
            id: 'test-' + id,
            kind: 'test',
            command: [process.execPath, 'local.mjs'],
            report: { type: 'junit', path: '.reports/local.xml' },
          },
        ],
        protectedPaths: ['local.mjs', 'integration.mjs', '.gitignore'],
      }),
    );
  }
  const workspaceRoot = join(root, 'control');
  await mkdir(workspaceRoot);
  const c = config({
    repository: repos[0].path,
    repositories: repos,
    workspaceRoot,
    maxAttempts: 6,
    workspaceGates: [
      {
        id: 'product-e2e',
        repositoryId: 'product',
        kind: 'test',
        command: [process.execPath, 'integration.mjs'],
        report: { type: 'junit', path: '.reports/e2e.xml' },
        timeoutMs: 10000,
        artifacts: ['value.json'],
      },
    ],
  });
  const data = join(workspaceRoot, '.devcontour-local');
  const store = new Store(join(data, 'state.sqlite')),
    h = new DevContour(store, c);
  attachJournal(h);
  const runtimes = {
    ...adapters,
    demo: {
      name: 'demo' as const,
      async execute(r: AgentRequest) {
        if (r.review)
          return {
            data: { approved: true, summary: 'Explicit deterministic test reviewer', findings: [] },
            log: 'fixture',
            command: ['fixture'],
          };
        await writeFile(
          join(r.cwd, 'value.json'),
          r.task.repositoryId === 'library' || r.task.title.includes('fix') ? '2' : '3',
        );
        return {
          data: { completed: true, summary: 'Fixture edit' },
          log: 'fixture',
          command: ['fixture'],
        };
      },
    },
  };
  const scheduler = new Scheduler(h, data, runtimes),
    runner = new WorkspaceRunner(h, data);
  await scheduler.init();
  return {
    root,
    data,
    c,
    h,
    store,
    scheduler,
    runner,
    cleanup: async () => {
      await runner.stop();
      await scheduler.stop();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('Real multi-repo DAG, isolated ownership, failing then passing pinned integration and immutable diary', async () => {
  const f = await multiRepo();
  try {
    const b = f.h.createBoard('Shared library and product', 'End-to-end feature');
    assert.throws(
      () => f.h.addTask(b.id, { ...input(), repositoryId: 'missing' }),
      /репозиторий|repository/i,
    );
    const lib = f.h.addTask(b.id, { ...input('Library change'), repositoryId: 'library' });
    const product = f.h.addTask(b.id, {
      ...input('Product change', [lib.id]),
      repositoryId: 'product',
    });
    f.h.approve(b.id);
    const c = f.runner.workspace.create({
      title: 'Product capability',
      description: 'Use the new library behaviour',
      boardIds: [b.id],
    });
    assert.throws(() => f.runner.verify(c.id), /завершите/);
    f.h.pause(false);
    await f.scheduler.drain();
    assert.ok(
      f.store.read().tasks.every((t) => t.status === 'done'),
      JSON.stringify(f.store.read().tasks),
    );
    for (const task of f.store.read().tasks) {
      const r = f.c.repositories.find((r) => r.id === task.repositoryId)!;
      await git(r.path, 'merge-base', '--is-ancestor', task.resultSha!, r.targetBranch);
      assert.equal(await git(r.path, 'status', '--porcelain'), '');
      assert.ok(
        f.store
          .read()
          .runs.find((run) => run.taskId === task.id)!
          .evidence.some((e) => e.gate === 'test-' + r.id),
      );
    }
    await assert.rejects(
      reserveRepositories(f.c, join(f.root, 'competing-control')),
      /владел|workspace|управля/i,
    );
    const aliases = {
      ...f.c,
      repositories: [...f.c.repositories, { ...f.c.repositories[1], id: 'alias' }],
    };
    await assert.rejects(reserveRepositories(aliases, f.data), /Git|повтор|workspace/i);
    await assert.rejects(f.runner.verify(c.id), /exit=1/);
    assert.throws(() => f.runner.workspace.accept(c.id), /успешной/);
    assert.equal(f.store.read().changeSets[0].verifications[0].status, 'failed');
    const fixed = f.h.addTask(b.id, {
      ...input('Product fix', [product.id]),
      repositoryId: 'product',
    });
    f.h.approve(b.id, [fixed.id]);
    await f.scheduler.drain();
    await f.runner.verify(c.id);
    const verified = f.store.read().changeSets[0].verifications.at(-1)!;
    assert.equal(verified.status, 'passed');
    assert.equal(Object.keys(verified.manifest!).length, 2);
    assert.equal(verified.evidence[0].artifacts[0].digest.length, 64);
    f.c.approvalMode = 'operator';
    assert.equal(f.runner.workspace.accept(c.id).status, 'awaiting-operator');
    f.c.approvalMode = 'agent';
    assert.equal(f.runner.workspace.accept(c.id).status, 'accepted');
    const receipt = JSON.stringify(f.store.read().changeSets[0]);
    const diary = await readFile(join(f.c.workspaceRoot!, 'docs', 'journal', c.id + '.md'), 'utf8');
    assert.match(diary, /product-e2e: PASS/);
    assert.match(diary, /FAIL/);
    const accepted = await acceptBoard(f.h, b.id, 'codex');
    assert.equal(accepted.status, 'accepted');
    assert.equal(
      Object.keys(f.store.read().boards[0].revisions[0].snapshot!.repositories!).length,
      2,
    );
    f.h.correct(b.id, [lib.id], 'Change the shared library contract once more');
    const next = f.runner.workspace.create({
      title: 'Next capability',
      description: 'Continue with the next contract version',
      boardIds: [b.id],
      supersedes: c.id,
    });
    assert.equal(next.supersedes, c.id);
    assert.equal(JSON.stringify(f.store.read().changeSets[0]), receipt);
    assert.equal(
      await readFile(join(f.c.workspaceRoot!, 'docs', 'journal', c.id + '.md'), 'utf8'),
      diary,
    );
    assert.throws(() => f.runner.verify(c.id), /уже принят/);
    assert.equal(f.store.projectionError, undefined);
  } finally {
    await f.cleanup();
  }
});

test('Verification fences expired runs, stops task claims, checks gate coverage and rejects changed policy', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('A complete board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    complete(f.h, t.id);
    const w = new Workspace(f.h),
      c = w.create({
        title: 'Feature test',
        description: 'Verify a complete feature',
        boardIds: [b.id],
      });
    assert.throws(() => w.start(c.id), /workspaceGates/);
    f.h.config.workspaceGates = [{ ...f.h.config.gates[0], repositoryId: 'main', artifacts: [] }];
    const v = w.start(c.id);
    const extra = f.h.createBoard('Additional work');
    f.h.addTask(extra.id, input());
    f.h.approve(extra.id);
    assert.equal(f.h.claim('another-worker'), undefined);
    assert.throws(
      () => w.manifest(c.id, v.token, { other: { sha: 'a'.repeat(40), tree: 'b'.repeat(40) } }),
      /Manifest/,
    );
    w.manifest(c.id, v.token, { main: { sha: 'a'.repeat(40), tree: 'b'.repeat(40) } });
    assert.throws(() => w.finish(c.id, v.token), /PASS/);
    f.store.change('test.expire', (s) => {
      s.changeSets[0].verifications[0].leaseUntil = 0;
    });
    const retry = w.start(c.id);
    assert.throws(() => w.finish(c.id, v.token), /Устаревшая/);
    f.h.config.workspaceGates[0].command = ['changed-test'];
    assert.throws(() => w.heartbeat(c.id, retry.token), /политика/);
    w.fail(c.id, retry.token, 'changed policy');
    assert.equal(f.store.read().changeSets[0].verifications.at(-1)!.status, 'failed');
  } finally {
    f.cleanup();
  }
});

test('Workspace gates cannot change manifest or another component source', async () => {
  const f = await multiRepo();
  try {
    const b = f.h.createBoard('Already completed fixture');
    for (const r of f.c.repositories) {
      const t = f.h.addTask(b.id, { ...input(r.id + ' fixture task'), repositoryId: r.id });
      const sha = await git(r.path, 'rev-parse', r.targetBranch);
      f.store.change('fixture.completed', (s) => {
        const task = s.tasks.find((x) => x.id === t.id)!;
        task.status = 'done';
        task.resultSha = sha;
      });
    }
    const c = f.runner.workspace.create({
      title: 'Integrity checks',
      description: 'Tests must preserve the pinned components',
      boardIds: [b.id],
    });
    const gate = f.c.workspaceGates[0];
    gate.command = [
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(process.env.DEVCONTOUR_MANIFEST_PATH,'{}');require('node:fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase name="x"/></testsuite>')`,
    ];
    await assert.rejects(f.runner.verify(c.id), /manifest/);
    gate.command = [
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(JSON.parse(process.env.DEVCONTOUR_COMPONENTS_JSON).library+'/value.json','99');require('node:fs').writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase name="x"/></testsuite>')`,
    ];
    await assert.rejects(f.runner.verify(c.id), /исходники/);
    assert.throws(() => f.runner.workspace.accept(c.id), /успешной/);
  } finally {
    await f.cleanup();
  }
});

test('Workspace setup preserves policy on repeat and detects a competing controller', async () => {
  const f = await multiRepo();
  try {
    const path = join(f.c.workspaceRoot!, 'workspace.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        name: 'Example workspace',
        repositories: f.c.repositories.map((r) => ({ ...r, profile: 'react-vite-admin' })),
        workspaceGates: f.c.workspaceGates,
      }),
    );
    const created = await setupWorkspace(path, f.data);
    assert.equal(created.status, 'configured');
    const configPath = join(f.data, 'config.json'),
      c = loadConfig(configPath);
    c.approvalMode = 'operator';
    await writeFile(configPath, JSON.stringify(c));
    assert.equal((await setupWorkspace(path, f.data)).status, 'preserved');
    assert.equal(loadConfig(configPath).approvalMode, 'operator');
    await assert.rejects(
      setupWorkspace(path, join(f.root, 'another')),
      /workspace|владел|управля/i,
    );
  } finally {
    await f.cleanup();
  }
});

test('Projection failure never rolls back an already committed task event', () => {
  const f = fixture();
  try {
    f.store.onCommit = () => {
      throw new Error('read-only journal');
    };
    const b = f.h.createBoard('Persistent board');
    assert.ok(f.store.read().boards.some((x) => x.id === b.id));
    assert.match(f.store.projectionError!, /read-only/);
    assert.ok(f.store.allEvents().length);
  } finally {
    f.cleanup();
  }
});

test('Legacy single-repository state retains its approved spec digest after migration', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Legacy board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    const approved = f.store.read().tasks[0].approvedDigest;
    f.store.change('fixture.legacy', (s) => {
      Reflect.deleteProperty(s, 'changeSets');
      Reflect.deleteProperty(s.tasks[0], 'repositoryId');
    });
    const restored = f.store.read();
    assert.equal(restored.tasks[0].repositoryId, 'main');
    assert.deepEqual(restored.changeSets, []);
    assert.equal(specDigest(restored.tasks[0]), approved);
    f.h.pause(false);
    assert.equal(f.h.claim('legacy-worker')?.taskId, t.id);
  } finally {
    f.cleanup();
  }
});

test('Consumer impact executes prerequisites and affected product tests on real repository SHAs', async () => {
  const f = await multiRepo();
  try {
    // A third independent product has its own mandatory baseline check.
    const unrelated = join(f.root, 'unrelated');
    await mkdir(unrelated);
    await git(unrelated, 'init', '-b', 'main');
    await writeFile(join(unrelated, '.gitignore'), '.reports/\n');
    await writeFile(join(unrelated, 'value.json'), '1');
    await writeFile(join(unrelated, 'local.mjs'), localTest);
    await git(unrelated, 'add', '.');
    await git(unrelated, 'commit', '-m', 'independent product');
    await git(unrelated, 'branch', 'devcontour/accepted');
    f.c.repositories.push(
      repositorySchema.parse({
        id: 'unrelated',
        name: 'Unrelated',
        kind: 'product',
        path: unrelated,
        dependsOn: [],
        gates: f.c.repositories[0].gates,
        protectedPaths: ['local.mjs'],
      }),
    );
    f.c.repositories.find((r) => r.id === 'product')!.dependsOn = ['library'];
    f.c.repositories.find((r) => r.id === 'library')!.dependsOn = [];
    f.c.verificationMode = 'affected';
    f.c.workspaceGates[0].dependsOn = ['build-library'];
    f.c.workspaceGates.push(
      {
        id: 'build-library',
        repositoryId: 'library',
        kind: 'check',
        command: [process.execPath, '-e', "require('fs').writeFileSync('generated.txt','built')"],
        timeoutMs: 10000,
        artifacts: ['generated.txt'],
      },
      {
        id: 'unrelated-test',
        repositoryId: 'unrelated',
        kind: 'test',
        command: [process.execPath, 'local.mjs'],
        timeoutMs: 10000,
        report: { type: 'junit', path: '.reports/independent.xml' },
        artifacts: [],
      },
    );
    const w = new Workspace(f.h);
    // Verify initial compatible combination, using a real completed product task.
    const base = f.h.createBoard('Baseline product');
    f.h.addTask(base.id, { ...input('fix baseline'), repositoryId: 'product' });
    const lib = f.h.addTask(base.id, { ...input('Prepare library'), repositoryId: 'library' });
    f.h.approve(base.id);
    f.h.pause(false);
    await f.scheduler.drain();
    const initial = w.create({
      title: 'Initial baseline',
      description: 'Establish accepted baseline for all products.',
      boardIds: [base.id],
    });
    await f.runner.verify(initial.id);
    w.accept(initial.id);
    const first = f.store.read().changeSets.at(-1)!.verifications.at(-1)!;
    assert.equal(first.impact!.mode, 'all');
    assert.deepEqual(
      first.evidence.map((e) => e.gate),
      ['build-library', 'product-e2e', 'unrelated-test'],
    );
    // Change a manifest, not a .ts file: whole-component SHA comparison must still propagate.
    const libRepo = f.c.repositories.find((r) => r.id === 'library')!;
    await git(libRepo.path, 'merge', '--ff-only', libRepo.targetBranch);
    await writeFile(join(libRepo.path, 'package.json'), '{"name":"library","version":"2.0.0"}');
    await git(libRepo.path, 'add', 'package.json');
    await git(libRepo.path, 'commit', '-m', 'library manifest');
    await git(libRepo.path, 'update-ref', `refs/heads/${libRepo.targetBranch}`, 'HEAD');
    const next = w.create({
      title: 'Manifest update',
      description: 'Recheck library consumers after manifest change.',
      boardIds: [base.id],
      supersedes: initial.id,
    });
    await f.runner.verify(next.id);
    let v = f.store.read().changeSets.at(-1)!.verifications.at(-1)!;
    assert.deepEqual(v.impact!.changed, ['library']);
    assert.deepEqual(new Set(v.impact!.affected), new Set(['library', 'product']));
    assert.deepEqual(
      v.evidence.map((e) => e.gate),
      ['build-library', 'product-e2e'],
    );
    assert.equal(v.impact!.mode, 'affected');
    w.accept(next.id);
    // An actual breaking library change is caught by its unchanged consumer.
    await writeFile(join(libRepo.path, 'value.json'), '9');
    await git(libRepo.path, 'add', 'value.json');
    await git(libRepo.path, 'commit', '-m', 'incompatible library');
    await git(libRepo.path, 'update-ref', `refs/heads/${libRepo.targetBranch}`, 'HEAD');
    const broken = w.create({
      title: 'Breaking library',
      description: 'An unchanged consumer must reject incompatible values.',
      boardIds: [base.id],
      supersedes: next.id,
    });
    await assert.rejects(f.runner.verify(broken.id), /exit=1/);
    v = f.store.read().changeSets.at(-1)!.verifications.at(-1)!;
    assert.equal(v.status, 'failed');
    assert.equal(v.evidence.at(-1)!.gate, 'product-e2e');
    assert.throws(() => w.accept(broken.id), /Нет актуальной/);
    // Missing dependency declarations restore conservative verification for every product.
    f.c.repositories.find((r) => r.id === 'unrelated')!.dependsOn = undefined;
    const unknown = w.create({
      title: 'Incomplete graph',
      description: 'Unknown graph must not silently narrow verification.',
      boardIds: [base.id],
    });
    await assert.rejects(f.runner.verify(unknown.id));
    assert.equal(f.store.read().changeSets.at(-1)!.verifications.at(-1)!.impact!.mode, 'all');
    assert.equal(f.store.read().tasks.find((t) => t.id === lib.id)!.status, 'done');
  } finally {
    await f.cleanup();
  }
});
