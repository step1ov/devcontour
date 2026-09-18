import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { config, input } from './helpers.ts';
import { configSchema, repositorySchema, type Config, type Run } from '../src/core/model.ts';
import { environmentSchema, lifecycleSchema, toolProfileSchema } from '../src/core/integrations.ts';
import { Store } from '../src/core/store.ts';
import { DevContour, specDigest } from '../src/core/service.ts';
import { Workspace } from '../src/core/workspace.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { WorkspaceRunner } from '../src/runner/workspace.ts';
import { command, git } from '../src/runner/process.ts';
import {
  executionEnvironment,
  withEnvironment,
  cleanupEnvironment,
} from '../src/runner/environment.ts';
import { adapters, cliArguments, type AgentRequest } from '../src/runner/adapters.ts';
import { claudeMcp, codexTools } from '../src/runner/tools.ts';
import { ResourcePool, resourceDatabase, withResources } from '../src/runner/resources.ts';
import { snapshotDependencies, assertDependencies } from '../src/runner/dependencies.ts';
import { DeliveryRunner, GitLabAdapter, GitHubAdapter } from '../src/runner/forge.ts';
import { attachJournal } from '../src/runner/journal.ts';
import { doctor } from '../src/runner/doctor.ts';
import { importKnowledge } from '../src/runner/knowledge.ts';

const makeRoot = () => mkdtemp(join(tmpdir(), 'devcontour-enterprise-'));
const step = (id: string, code: string) => ({
  id,
  command: [process.execPath, '-e', code],
  timeoutMs: 3000,
});
const testScript = `import{readFileSync,writeFileSync}from'node:fs'; const value=JSON.parse(readFileSync('value.json','utf8')); if(value<1)process.exit(1); writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase name="value"/></testsuite>');`;
async function fixture(components = true) {
  const root = await makeRoot(),
    workspace = join(root, 'workspace'),
    data = join(workspace, '.devcontour-local');
  await mkdir(workspace);
  const repos = [];
  for (const id of ['library', 'product']) {
    const path = join(root, id);
    await mkdir(path);
    await git(path, 'init', '-b', 'main');
    await writeFile(join(path, '.gitignore'), '.devcontour-local/\n.reports/\n.deps/\n');
    await writeFile(join(path, 'value.json'), '1');
    await writeFile(join(path, 'verify.mjs'), testScript);
    await writeFile(join(path, 'README.md'), 'Verified donor conventions.');
    await git(path, 'add', '.');
    await git(path, 'commit', '-m', 'baseline');
    repos.push(
      repositorySchema.parse({
        id,
        name: id,
        kind: id,
        path,
        dependsOn: id === 'product' ? ['library'] : [],
        protectedPaths: ['verify.mjs', '.gitignore'],
        gates: [
          {
            id: 'test',
            kind: 'test',
            command: [process.execPath, 'verify.mjs'],
            report: { type: 'junit', path: '.reports/test.xml' },
          },
        ],
      }),
    );
  }
  const c = config({
    repository: repos[0].path,
    repositories: repos,
    workspaceRoot: workspace,
    storage: components ? 'component' : 'central',
    runTimeoutMs: 60000,
    maxAttempts: 5,
    resourceDatabase: join(root, 'resources.sqlite'),
    workspaceGates: [
      {
        id: 'together',
        repositoryId: 'product',
        kind: 'test',
        command: [process.execPath, 'verify.mjs'],
        timeoutMs: 10000,
        report: { type: 'junit', path: '.reports/together.xml' },
        artifacts: [],
      },
    ],
  });
  const store = new Store(join(data, 'state.sqlite'), components ? repos : undefined),
    h = new DevContour(store, c);
  attachJournal(h);
  const runtime = {
    ...adapters,
    demo: {
      name: 'demo' as const,
      async execute(r: AgentRequest) {
        if (r.review)
          return {
            data: { approved: true, summary: 'Fixture review', findings: [] },
            log: 'fixture',
            command: ['fixture'],
          };
        if (r.task.repositoryId === 'product') {
          const paths = JSON.parse(r.execution!.env.DEVCONTOUR_COMPONENTS_JSON!);
          assert.equal(await readFile(join(paths.library, 'value.json'), 'utf8'), '2');
        }
        await writeFile(join(r.cwd, 'value.json'), '2');
        return {
          data: { completed: true, summary: 'Fixture implementation' },
          log: 'fixture',
          command: ['fixture'],
        };
      },
    },
  };
  const scheduler = new Scheduler(h, data, runtime);
  await scheduler.init();
  return {
    root,
    workspace,
    data,
    c,
    store,
    h,
    scheduler,
    close: async () => {
      await scheduler.stop();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('Execution environment is explicit, missing secrets fail and logs redact inherited credentials', async () => {
  const profile = environmentSchema.parse({
    inherit: ['REGISTRY'],
    secrets: { NPM_TOKEN: 'SOURCE_TOKEN' },
    values: { MODE: 'test' },
  });
  const e = executionEnvironment(
    [profile],
    { DEVCONTOUR_RUN_ID: 'r' },
    {
      PATH: process.env.PATH,
      REGISTRY: 'registry-private-token',
      SOURCE_TOKEN: 'hidden-secret',
      UNRELATED: 'must-not-pass',
    },
  );
  assert.equal(e.env.UNRELATED, undefined);
  assert.equal(e.env.NPM_TOKEN, 'hidden-secret');
  const r = await command(
    [process.execPath, '-e', 'console.log(process.env.NPM_TOKEN,process.env.REGISTRY)'],
    process.cwd(),
    e,
  );
  assert.equal(r.stdout.trim(), '[REDACTED] [REDACTED]');
  assert.throws(() => executionEnvironment([profile], {}, {}), /Не задана/);
  assert.throws(() => environmentSchema.parse({ values: { DEVCONTOUR_RUN_ID: 'spoof' } }));
});

test('Runtime profiles carry only explicit MCP definitions and reviewer has no editing/Bash tools', () => {
  const p = toolProfileSchema.parse({
    runtime: 'claude',
    claudeTools: ['Read', 'Bash', 'Edit'],
    claudeAllowedTools: ['Bash(npm run test:*)'],
    mcp: {
      gitlab: {
        transport: 'http',
        url: 'https://gitlab.invalid/mcp',
        bearerTokenEnv: 'READ_TOKEN',
        tools: ['get_project'],
      },
    },
  });
  const mcp = JSON.stringify(claudeMcp(p));
  assert.match(mcp, /\$\{READ_TOKEN\}/);
  const args = cliArguments(
    'claude',
    { review: true, toolProfile: p, mcpConfigPath: '/configured/mcp.json' } as AgentRequest,
    's',
    'r',
  );
  assert.ok(args.includes('Read,Glob,Grep'));
  assert.ok(args.includes('mcp__gitlab__get_project'));
  assert.ok(!args.some((s) => s.includes('Bash(npm')));
  assert.match(codexTools({ ...p, runtime: 'codex' }).join(' '), /enabled_tools.*get_project/);
});

test('Environment cleanup runs after setup failure and cancellation; cleanup failure retains resource ownership', async () => {
  const root = await makeRoot();
  try {
    const marker = join(root, 'marker');
    const l = lifecycleSchema.parse({
      setup: [
        step(
          'start',
          `require('fs').writeFileSync(${JSON.stringify(marker)},'running');process.exit(1)`,
        ),
      ],
      teardown: [step('stop', `require('fs').rmSync(${JSON.stringify(marker)},{force:true})`)],
    });
    await assert.rejects(
      withEnvironment(
        l,
        root,
        join(root, 'failed'),
        executionEnvironment([]),
        new AbortController().signal,
        async () => {},
      ),
      /start/,
    );
    await assert.rejects(readFile(marker));
    const abort = new AbortController();
    l.setup = [];
    await assert.rejects(
      withEnvironment(
        l,
        root,
        join(root, 'cancelled'),
        executionEnvironment([]),
        abort.signal,
        async () => {
          await writeFile(marker, 'running');
          abort.abort();
          abort.signal.throwIfAborted();
        },
      ),
    );
    await assert.rejects(readFile(marker));
    const c = config({
      resourceDatabase: join(root, 'pool.sqlite'),
      resources: [{ id: 'database', kind: 'service', value: 'fixture-db' }],
    });
    l.teardown = [step('failed-cleanup', 'process.exit(2)')];
    await assert.rejects(
      withResources(c, ['database'], 'fixture', new AbortController().signal, (signal) =>
        withEnvironment(
          l,
          root,
          join(root, 'orphan'),
          executionEnvironment([]),
          signal,
          async () => {},
        ),
      ),
      /Очистка/,
    );
    const pool = new ResourcePool(resourceDatabase(c));
    try {
      assert.equal(pool.list().length, 1);
    } finally {
      pool.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Component databases contain local specifications, snapshots and events; coordinator holds only links', async () => {
  const f = await fixture();
  try {
    const b = f.h.createBoard('Library private board', 'PRIVATE_BOARD_BODY', 'library');
    const a = f.h.addTask(b.id, {
      ...input('Library task'),
      repositoryId: 'library',
      description: 'PRIVATE_LIBRARY_SPECIFICATION',
    });
    assert.throws(
      () => f.h.editTask(a.id, { ...a, repositoryId: 'product' }, specDigest(a)),
      /Локальная доска/,
    );
    const p = f.h.createBoard('Product private board', '', 'product');
    f.h.addTask(p.id, {
      ...input('Product task', [a.id]),
      repositoryId: 'product',
      description: 'PRIVATE_PRODUCT_SPECIFICATION',
    });
    const common = f.h.createBoard('Cross project integration');
    f.h.addTask(common.id, {
      ...input('Shared migration'),
      repositoryId: 'product',
      scope: 'workspace',
      relatedRepositories: ['product', 'library'],
      description: 'SHARED_INTEGRATION_SPECIFICATION',
    });
    f.h.contract('Library internals', 'PRIVATE_LIBRARY_CONTRACT', { actor: 'operator' }, 'library');
    f.h.contract('Public API', 'SHARED_API_CONTRACT');
    f.h.approve(b.id);
    f.h.approve(p.id);
    f.h.pause(false);
    await f.scheduler.drain();
    assert.ok(
      f.store
        .read()
        .tasks.filter((t) => t.scope !== 'workspace')
        .every((t) => t.status === 'done'),
    );
    const w = new Workspace(f.h),
      change = w.create({
        title: 'Combined feature',
        description: 'Verify both repositories together.',
        boardIds: [b.id, p.id],
      });
    await new WorkspaceRunner(f.h, f.data).verify(change.id);
    w.accept(change.id);
    const db = new DatabaseSync(join(f.data, 'state.sqlite'), { readOnly: true });
    try {
      const raw =
        JSON.stringify(db.prepare('SELECT data FROM state').all()) +
        JSON.stringify(db.prepare('SELECT data FROM events').all());
      assert.doesNotMatch(
        raw,
        /PRIVATE_LIBRARY_SPECIFICATION|PRIVATE_PRODUCT_SPECIFICATION|PRIVATE_BOARD_BODY|PRIVATE_LIBRARY_CONTRACT/,
      );
      assert.match(raw, /SHARED_INTEGRATION_SPECIFICATION/);
      assert.match(raw, /SHARED_API_CONTRACT/);
      assert.equal((db.prepare('PRAGMA journal_mode').get() as any).journal_mode, 'delete');
    } finally {
      db.close();
    }
    const lib = new DatabaseSync(join(f.c.repositories[0].path, '.devcontour-local/state.sqlite'), {
      readOnly: true,
    });
    try {
      const raw =
        JSON.stringify(lib.prepare('SELECT data FROM state').all()) +
        JSON.stringify(lib.prepare('SELECT data FROM objects').all());
      assert.match(raw, /PRIVATE_LIBRARY_SPECIFICATION/);
      assert.doesNotMatch(raw, /PRIVATE_PRODUCT_SPECIFICATION/);
    } finally {
      lib.close();
    }
    for (const run of f.store.read().runs) {
      assert.ok(
        run.worktree!.startsWith(f.c.repositories.find((r) => r.id === run.repositoryId)!.path),
      );
    }
    const journal = await readFile(
      join(f.c.repositories[0].path, '.devcontour-local/journal/activity.md'),
      'utf8',
    );
    assert.match(journal, /PRIVATE_LIBRARY_SPECIFICATION/);
    assert.doesNotMatch(journal, /PRIVATE_PRODUCT_SPECIFICATION/);
    const restored = new Store(join(f.data, 'state.sqlite'), f.c.repositories);
    try {
      assert.equal(
        restored.read().changeSets[0].verifications[0].tasks[0].description,
        'PRIVATE_LIBRARY_SPECIFICATION',
      );
      assert.equal(restored.allEvents().length, f.store.allEvents().length);
    } finally {
      restored.close();
    }
  } finally {
    await f.close();
  }
});

test('A failure in one attached database rolls back updates across coordinator and all components', async () => {
  const f = await fixture();
  try {
    const b = f.h.createBoard('Tasks');
    const t = f.h.addTask(b.id, { ...input(), repositoryId: 'library' });
    const product = new DatabaseSync(join(f.c.repositories[1].path, '.devcontour-local/state.sqlite'));
    product.exec(
      "CREATE TRIGGER reject_update BEFORE UPDATE ON state BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
    );
    product.close();
    assert.throws(() =>
      f.h.editTask(
        t.id,
        { description: 'Rollback must preserve the original task.' },
        (f.store.read().tasks[0] as any).approvedDigest ?? 'bad-digest',
      ),
    );
    const before = f.store.read();
    assert.throws(
      () =>
        f.store.change('test.atomic', (s) => {
          s.tasks[0].description = 'Never committed';
          s.sequence += 10;
        }),
      /fixture failure/,
    );
    assert.deepEqual(f.store.read(), before);
  } finally {
    await f.close();
  }
});

test('Dependency artifacts are pinned and mutations are rejected independently of consumer gates', async () => {
  const f = await fixture(false);
  try {
    const library = f.c.repositories[0];
    library.dependencyBuild = [
      step(
        'build',
        "require('fs').mkdirSync('.deps',{recursive:true});require('fs').writeFileSync('.deps/library.tgz','built')",
      ),
    ];
    library.dependencyArtifacts = ['.deps/library.tgz'];
    const b = f.h.createBoard('Product dependency');
    const task = f.h.addTask(b.id, { ...input(), repositoryId: 'product' });
    const run = { id: 'dependency-fixture', taskId: task.id } as Run;
    const snapshots = await snapshotDependencies(
      f.c,
      f.data,
      run,
      task,
      [],
      new AbortController().signal,
    );
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].artifacts.length, 1);
    await writeFile(join(snapshots[0].path, '.deps/library.tgz'), 'modified');
    await assert.rejects(assertDependencies(snapshots), /artifact/);
  } finally {
    await f.close();
  }
});

test('Doctor detects absent prerequisites; donor import records source SHA and does not execute donor rules', async () => {
  const f = await fixture(false);
  try {
    f.c.repositories[0].preflight = [
      { id: 'missing', command: ['absent-devcontour-tool'], timeoutMs: 1000 },
    ];
    const result = await doctor(f.c, f.data);
    assert.equal(result.ready, false);
    assert.ok(
      result.checks.some((c) => c.status === 'blocked' && c.detail.includes('absent-devcontour-tool')),
    );
    const imported = await importKnowledge(f.workspace, f.c.repositories[0].path, ['README.md']);
    assert.equal(imported.status, 'unreviewed');
    assert.match(imported.revision, /^[a-f0-9]{40}$/);
    await writeFile(join(imported.destination, 'README.md'), 'edited draft');
    await assert.rejects(
      importKnowledge(f.workspace, f.c.repositories[0].path, ['README.md']),
      /изменён/,
    );
  } finally {
    await f.close();
  }
});

test('Manual handoff supports GitLab and GitHub; read-only observations require exact merged trees and CI SHA', async () => {
  const f = await fixture();
  let stage: 'absent' | 'published' | 'merged' = 'absent',
    wrongCI = true,
    sourceDrift = false,
    failedCI = false;
  const requests: string[] = [];
  const remoteSha: Record<string, string> = {};
  const server = createServer((req, res) => {
    requests.push(req.method!);
    res.setHeader('content-type', 'application/json');
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end('{}');
      return;
    }
    const path = new URL(req.url!, 'http://localhost').pathname;
    const id = path.includes('/api/v4/') ? 'library' : 'product';
    const c = f.store.read().changeSets[0]?.deliveries?.at(-1)?.components[id];
    const expected = wrongCI ? c?.sha : remoteSha[id];
    const mr = {
      iid: 7,
      state: stage === 'merged' ? 'merged' : 'opened',
      sha: sourceDrift ? '0'.repeat(40) : c?.sha,
      merge_commit_sha: remoteSha[id],
      web_url: 'https://forge.invalid/mr/7',
    };
    const pr = {
      number: 8,
      state: stage === 'merged' ? 'closed' : 'open',
      merged: stage === 'merged',
      head: { sha: c?.sha },
      merge_commit_sha: remoteSha[id],
      html_url: 'https://forge.invalid/pr/8',
    };
    let body: unknown;
    if (path.endsWith('/merge_requests')) body = stage === 'absent' ? [] : [mr];
    else if (path.includes('/merge_requests/')) body = mr;
    else if (path.endsWith('/pipelines')) body = stage === 'merged' ? [{ id: 9 }] : [];
    else if (path.includes('/pipelines/'))
      body = {
        id: 9,
        sha: expected,
        status: failedCI ? 'failed' : 'success',
        web_url: 'https://forge.invalid/pipeline/9',
      };
    else if (path.endsWith('/pulls')) body = stage === 'absent' ? [] : [pr];
    else if (path.includes('/pulls/')) body = pr;
    else if (path.endsWith('/check-runs'))
      body = {
        total_count: 1,
        check_runs: [
          {
            name: 'tests',
            head_sha: expected,
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://forge.invalid/checks/1',
          },
        ],
      };
    else if (path.endsWith('/status')) body = { total_count: 0, statuses: [] };
    else {
      res.writeHead(404);
      body = {};
    }
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    f.c.forgeConnections = {
      corp: { provider: 'gitlab', url },
      public: { provider: 'github', url },
    };
    for (const repo of f.c.repositories) {
      const remote = join(f.root, repo.id + '.git');
      await git(f.root, 'init', '--bare', remote);
      await git(repo.path, 'remote', 'add', 'origin', remote);
      await git(repo.path, 'push', 'origin', 'HEAD:refs/heads/main');
      repo.forge = {
        connection: repo.id === 'library' ? 'corp' : 'public',
        project: 'group/' + repo.id,
        remote: 'origin',
        targetBranch: 'main',
        requiredChecks: [],
      };
    }
    f.c.completionMode = 'remote';
    const b = f.h.createBoard('End to end feature');
    const lib = f.h.addTask(b.id, { ...input('Library upgrade'), repositoryId: 'library' });
    f.h.addTask(b.id, { ...input('Product upgrade', [lib.id]), repositoryId: 'product' });
    f.h.approve(b.id);
    f.h.pause(false);
    await f.scheduler.drain();
    f.h.pause(true);
    const w = new Workspace(f.h),
      c = w.create({
        title: 'Manual publication',
        description: 'Human publishes, forge adapters only observe.',
        boardIds: [b.id],
      });
    await new WorkspaceRunner(f.h, f.data).verify(c.id);
    assert.throws(() => w.accept(c.id), /локально/);
    const runner = new DeliveryRunner(f.h, f.data);
    const handoff = await runner.prepare(c.id);
    assert.equal('status' in handoff ? handoff.status : '', 'awaiting-human-push');
    assert.equal(requests.length, 0);
    let d = f.store.read().changeSets[0].deliveries![0];
    for (const repo of f.c.repositories)
      assert.equal(
        await git(
          repo.path,
          'ls-remote',
          '--heads',
          'origin',
          'refs/heads/' + d.components[repo.id].sourceBranch,
        ),
        '',
      );
    assert.equal((await runner.check(c.id)).status, 'waiting');
    for (const repo of f.c.repositories)
      await git(
        repo.path,
        'push',
        'origin',
        `${d.components[repo.id].sha}:refs/heads/${d.components[repo.id].sourceBranch}`,
      );
    stage = 'published';
    assert.equal((await runner.check(c.id)).status, 'waiting');
    for (const repo of f.c.repositories) {
      const source = d.components[repo.id].sha,
        base = await git(repo.path, 'rev-parse', 'HEAD');
      remoteSha[repo.id] = await git(
        repo.path,
        'commit-tree',
        await git(repo.path, 'rev-parse', `${source}^{tree}`),
        '-p',
        base,
        '-p',
        source,
        '-m',
        'Human merge',
      );
      await git(repo.path, 'push', 'origin', `${remoteSha[repo.id]}:refs/heads/main`);
    }
    stage = 'merged';
    assert.equal((await runner.check(c.id)).status, 'waiting');
    assert.throws(() => w.accept(c.id), /локально/);
    sourceDrift = true;
    await assert.rejects(runner.check(c.id), /другой SHA/);
    assert.throws(() => w.accept(c.id), /локально/);
    sourceDrift = false;
    wrongCI = false;
    failedCI = true;
    assert.equal((await runner.check(c.id)).status, 'waiting');
    failedCI = false;
    assert.equal((await runner.check(c.id)).status, 'delivered');
    assert.equal(w.accept(c.id).status, 'accepted');
    d = f.store.read().changeSets[0].deliveries![0];
    assert.notEqual(d.components.library.sha, d.components.library.mergedSha);
    assert.equal(d.components.library.tree, d.components.library.remoteTree);
    assert.ok(requests.length > 10);
    assert.ok(requests.every((m) => m === 'GET'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});

test('Explicit storage migration relocates historical local task bodies and preserves event identities', async () => {
  const f = await fixture(false);
  let reopened: Store | undefined;
  try {
    const b = f.h.createBoard('Old library board', 'LEGACY_LOCAL_BOARD', 'library');
    f.h.addTask(b.id, {
      ...input(),
      repositoryId: 'library',
      description: 'LEGACY_LOCAL_SPECIFICATION',
    });
    const before = f.store.read(),
      events = f.store.allEvents();
    await f.scheduler.stop();
    f.store.close();
    reopened = new Store(join(f.data, 'state.sqlite'), f.c.repositories, true);
    assert.deepEqual(reopened.read(), before);
    assert.deepEqual(reopened.allEvents(), events);
    const bytes = await readFile(join(f.data, 'state.sqlite'));
    assert.equal(bytes.includes(Buffer.from('LEGACY_LOCAL_SPECIFICATION')), false);
    assert.equal(bytes.includes(Buffer.from('LEGACY_LOCAL_BOARD')), false);
  } finally {
    reopened?.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('Killed writer is recovered through SQLite rollback journals without losing graph consistency', async () => {
  const f = await fixture();
  let closed = false;
  try {
    const b = f.h.createBoard('Durable library', '', 'library');
    f.h.addTask(b.id, {
      ...input(),
      repositoryId: 'library',
      description: 'Original durable specification.',
    });
    const before = f.store.read();
    await f.scheduler.stop();
    f.store.close();
    closed = true;
    const dbPath = join(f.data, 'state.sqlite'),
      libPath = join(f.c.repositories[0].path, '.devcontour-local/state.sqlite');
    const code = `const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.prepare('ATTACH DATABASE ? AS lib').run(process.argv[2]);db.exec(\"PRAGMA journal_mode=DELETE; PRAGMA lib.journal_mode=DELETE; BEGIN IMMEDIATE; UPDATE main.state SET data=json_set(data,'$.sequence',999999); UPDATE lib.state SET data=json_set(data,'$.tasks[0].description','Uncommitted corruption');\");process.kill(process.pid,'SIGKILL');`;
    const result = await command([process.execPath, '-e', code, dbPath, libPath], f.root);
    assert.notEqual(result.code, 0);
    const restored = new Store(dbPath, f.c.repositories);
    try {
      assert.deepEqual(restored.read(), before);
    } finally {
      restored.close();
    }
    assert.throws(() => new Store(libPath), /локальная база компонента/);
    assert.throws(() => new Store(dbPath), /component storage/);
    const check = new DatabaseSync(dbPath);
    try {
      assert.equal((check.prepare('PRAGMA journal_mode').get() as any).journal_mode, 'delete');
    } finally {
      check.close();
    }
  } finally {
    if (!closed) await f.close();
    else await rm(f.root, { recursive: true, force: true });
  }
});

test('Doctor uses component tool profiles and executes isolated preflight with teardown', async () => {
  const f = await fixture(false);
  try {
    const repo = f.c.repositories[0];
    repo.roles = {
      backend: { ...f.c.roles.backend, runtime: 'codex', toolProfile: 'private-read' },
    };
    f.c.toolProfiles['private-read'] = toolProfileSchema.parse({
      runtime: 'codex',
      environment: { secrets: { TOKEN: 'DEVCONTOUR_TEST_NONEXISTENT_SECRET_732' } },
    });
    let result = await doctor(f.c, f.data);
    assert.ok(
      result.checks.some((c) => c.id === 'tools:library:backend:write' && c.status === 'blocked'),
    );
    delete repo.roles;
    delete f.c.toolProfiles['private-read'];
    repo.preflight = [
      step(
        'verify-worktree',
        "if(!require('fs').existsSync('.ready'))process.exit(1); require('fs').writeFileSync('value.json','preflight must not modify checkout')",
      ),
    ];
    repo.lifecycle = lifecycleSchema.parse({
      setup: [step('start', "require('fs').writeFileSync('.ready','test')")],
      teardown: [step('stop', "require('fs').rmSync('.ready',{force:true})")],
    });
    result = await doctor(f.c, f.data, true);
    assert.ok(result.checks.some((c) => c.id === 'probe:library' && c.status === 'passed'));
    assert.equal(await readFile(join(repo.path, 'value.json'), 'utf8'), '1');
  } finally {
    await f.close();
  }
});

test('Cleanup recovery preserves component environment and rejects live owners and foreign directories', async () => {
  const f = await fixture();
  try {
    const { realpath } = await import('node:fs/promises');
    const repo = f.c.repositories[0],
      cwd = join(repo.path, '.devcontour-local/recovery');
    await mkdir(cwd, { recursive: true });
    repo.environment = environmentSchema.parse({ values: { CLEANUP_SCOPE: 'library' } });
    repo.lifecycle = lifecycleSchema.parse({
      teardown: [
        step(
          'cleanup',
          "if(process.env.CLEANUP_SCOPE!=='library')process.exit(2);require('fs').rmSync('.running',{force:true})",
        ),
      ],
    });
    const env = executionEnvironment([repo.environment], { DEVCONTOUR_REPOSITORY_ID: repo.id });
    const path = join(cwd, 'receipt/environment.json');
    await withEnvironment(
      repo.lifecycle,
      cwd,
      join(cwd, 'receipt'),
      env,
      new AbortController().signal,
      async () => {},
    );
    const receipt = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(join(cwd, '.running'), 'pending');
    receipt.status = 'active';
    await writeFile(path, JSON.stringify(receipt));
    const roots = [await realpath(join(repo.path, '.devcontour-local'))];
    await assert.rejects(cleanupEnvironment(path, f.c, roots), /ещё существует/);
    receipt.ownerPid = 2147483647;
    receipt.cwd = f.root;
    await writeFile(path, JSON.stringify(receipt));
    await assert.rejects(cleanupEnvironment(path, f.c, roots), /вне рабочих/);
    receipt.cwd = cwd;
    await writeFile(path, JSON.stringify(receipt));
    assert.equal((await cleanupEnvironment(path, f.c, roots)).status, 'cleaned');
    await assert.rejects(readFile(join(cwd, '.running')));
  } finally {
    await f.close();
  }
});
