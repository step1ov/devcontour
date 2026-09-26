import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { config, fixture, input } from './helpers.ts';
import { orderedGates, validateWorkflow } from '../src/core/workflow.ts';
import { BlockedError, taskInput, type Contract, type Task } from '../src/core/model.ts';
import { specDigest, DevContour } from '../src/core/service.ts';
import { ResourcePool, resourceKey, withResources } from '../src/runner/resources.ts';
import { pinContext, taskContext } from '../src/runner/context.ts';
import { git, command } from '../src/runner/process.ts';
import { setupDemo } from '../src/demo.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Store } from '../src/core/store.ts';
import { updateBase } from '../src/runner/base-update.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { adapters, type AgentRequest } from '../src/runner/adapters.ts';

const finding = {
  kind: 'debt' as const,
  title: 'Confirm legacy behaviour',
  path: 'legacy.ts',
  line: 12,
  observation: 'The legacy consumer has a separate data representation.',
  consequence: 'It can drift from the shared API.',
  reproduction: 'Compare the fixture output with the approved contract.',
};

test('Gate DAG sorts prerequisites and rejects unknown/cyclic dependencies; component graph fails closed', () => {
  const c = config(),
    gate = c.gates[0];
  assert.deepEqual(
    orderedGates([
      { ...gate, id: 'consumer', dependsOn: ['generate'] },
      { ...gate, id: 'generate' },
    ]).map((g) => g.id),
    ['generate', 'consumer'],
  );
  assert.throws(() => orderedGates([{ ...gate, dependsOn: ['absent'] }]), /Неизвестная/);
  assert.throws(() => orderedGates([{ ...gate, dependsOn: ['test'] }]), /Цикл/);
  c.repositories = [
    {
      id: 'a',
      name: 'A',
      kind: 'library',
      path: '/a',
      targetBranch: 'devcontour/accepted',
      gates: c.gates,
      protectedPaths: [],
      dependsOn: ['b'],
    },
    {
      id: 'b',
      name: 'B',
      kind: 'product',
      path: '/b',
      targetBranch: 'devcontour/accepted',
      gates: c.gates,
      protectedPaths: [],
      dependsOn: ['a'],
    },
  ];
  assert.throws(() => validateWorkflow(c), /Цикл/);
  c.repositories[1].dependsOn = ['missing'];
  assert.throws(() => validateWorkflow(c), /Неизвестный репозиторий/);
  assert.throws(() => taskInput.parse({ ...input(), writePaths: ['../outside'] }));
  assert.throws(() => taskInput.parse({ ...input(), writePaths: ['/outside'] }));
});

test('Discovered debt becomes a deduplicated draft with provenance; scope and context are approved specification', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Feature work');
    const t = f.h.addTask(b.id, { ...input(), writePaths: ['src/'] });
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('writer')!;
    const original = specDigest(t);
    assert.notEqual(original, specDigest({ ...t, writePaths: ['other/'] }));
    assert.notEqual(original, specDigest({ ...t, contextPacks: ['library'] }));
    const ids = f.h.discoveries(run.id, run.token, 'a'.repeat(40), [finding]);
    assert.equal(ids.length, 1);
    assert.equal(f.h.discoveries(run.id, run.token, 'b'.repeat(40), [finding]).length, 0);
    const created = f.store.read().tasks.find((t) => t.id === ids[0])!;
    assert.equal(created.status, 'draft');
    assert.equal(created.approvedDigest, undefined);
    assert.equal(created.finding?.sourceTaskId, t.id);
    assert.equal(created.finding?.verification, 'proposed');
    f.h.cancel(t.id);
    assert.throws(
      () => f.h.discoveries(run.id, run.token, 'a'.repeat(40), [finding]),
      /Устаревшая/,
    );
  } finally {
    f.cleanup();
  }
});

async function runnerFixture() {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-context-'));
  await setupDemo(root);
  const c = loadConfig(join(root, 'config.json')),
    store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, c);
  const scheduler = new Scheduler(h, root);
  await scheduler.init();
  return {
    root,
    c,
    store,
    h,
    scheduler,
    async cleanup() {
      await scheduler.stop();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('Pinned role/library documents are selected reproducibly, delivered to writer and reviewer and persisted with each run', async () => {
  const f = await runnerFixture();
  try {
    await mkdir(join(f.c.repository, 'instructions'));
    await writeFile(
      join(f.c.repository, 'instructions/common.md'),
      'Use approved domain contracts.',
    );
    await writeFile(
      join(f.c.repository, 'instructions/library.md'),
      'Library accepts only canonical identifiers.',
    );
    await git(f.c.repository, 'add', 'instructions');
    await git(f.c.repository, 'commit', '-m', 'instructions');
    f.c.contextPacks = [
      {
        id: 'common',
        version: '1.0',
        repositoryId: 'main',
        roles: ['architect', 'backend', 'frontend', 'qa'],
        files: ['instructions/common.md'],
        references: [],
      },
      {
        id: 'library',
        version: '1.0',
        repositoryId: 'main',
        roles: [],
        files: ['instructions/library.md'],
        references: [],
      },
    ];
    f.c.contextPacks = await pinContext(f.c);
    const t = f.store.read().tasks[0];
    const without = await taskContext(f.c, t);
    assert.match(without.text, /approved domain/);
    assert.doesNotMatch(without.text, /canonical identifiers/);
    const withLibrary = await taskContext(f.c, { ...t, contextPacks: ['library'] });
    assert.match(withLibrary.text, /canonical identifiers/);
    await writeFile(
      join(f.c.repository, 'instructions/common.md'),
      'Uncommitted malicious replacement',
    );
    assert.match((await taskContext(f.c, t)).text, /approved domain/);
    f.c.contextPacks[0].digest = '0'.repeat(64);
    await assert.rejects(taskContext(f.c, t), /digest/);
    f.c.contextPacks = await pinContext(f.c);
    const requests: AgentRequest[] = [];
    const runtimes = {
      ...adapters,
      demo: {
        name: 'demo' as const,
        async execute(r: AgentRequest) {
          requests.push(r);
          return adapters.demo.execute(r);
        },
      },
    };
    const scheduler = new Scheduler(f.h, f.root, runtimes);
    // Инструкции только что закоммичены в рабочую ветку: пока база прогонов их
    // не содержит, исполнитель получил бы дерево без закреплённого контекста.
    await updateBase(f.c, f.root);
    f.h.pause(false);
    await scheduler.drain();
    assert.ok(f.store.read().tasks.every((t) => t.status === 'done'));
    assert.ok(requests.some((r) => r.review));
    assert.ok(requests.every((r) => r.prompt.includes('Use approved domain contracts.')));
    assert.ok(
      f.store
        .read()
        .runs.slice(2)
        .every((r) => r.context?.[0].digest === f.c.contextPacks[0].digest),
    );
    const snapshot = JSON.parse(
      await readFile(
        join(f.root, 'artifacts', f.store.read().runs[2].id, 'implementation/context.json'),
        'utf8',
      ),
    );
    assert.match(snapshot.text, /approved domain/);
  } finally {
    await f.cleanup();
  }
});

test('Unknown context/resources and unpinned instructions cannot silently run', async () => {
  const f = await runnerFixture();
  try {
    const b = f.h.createBoard('Invalid configuration');
    assert.throws(
      () => f.h.addTask(b.id, { ...input(), contextPacks: ['missing'] }),
      /Неизвестный context/,
    );
    assert.throws(
      () => f.h.addTask(b.id, { ...input(), resources: ['missing'] }),
      /Неизвестный ресурс/,
    );
    f.c.contextPacks = [
      {
        id: 'pending',
        version: '1',
        repositoryId: 'main',
        roles: ['architect'],
        files: ['missing.md'],
        references: [],
      },
    ];
    f.h.pause(false);
    await f.scheduler.drain();
    assert.match(f.store.read().tasks.find((t) => t.status === 'failed')!.failure!, /context-lock/);
  } finally {
    await f.cleanup();
  }
});

test('Role and task write scopes reject an otherwise passing implementation before integration', async () => {
  const f = await runnerFixture();
  try {
    f.c.roles.architect.writePaths = ['allowed/'];
    f.h.pause(false);
    await f.scheduler.drain();
    assert.match(f.store.read().tasks.find((t) => t.status === 'failed')!.failure!, /вне области/);
    assert.equal(f.store.read().runs.find((r) => r.status === 'failed')!.candidateSha, undefined);
  } finally {
    await f.cleanup();
  }
});

test('Generated files are protected and implementation discoveries enter the existing board automatically', async () => {
  const f = await runnerFixture();
  try {
    const runtimes = {
      ...adapters,
      demo: {
        name: 'demo' as const,
        async execute(r: AgentRequest) {
          const value = await adapters.demo.execute(r);
          return r.review
            ? value
            : { ...value, data: { ...(value.data as object), discoveries: [finding] } };
        },
      },
    };
    f.h.pause(false);
    await new Scheduler(f.h, f.root, runtimes).drain();
    assert.equal(f.store.read().tasks.filter((t) => t.finding).length, 1);
    assert.equal(f.store.read().tasks.find((t) => t.finding)!.status, 'draft');
  } finally {
    await f.cleanup();
  }
  const g = await runnerFixture();
  try {
    // A registry is optional; use a registered repository here to declare generated paths.
    g.c.repositories = [
      {
        id: 'main',
        name: 'Main',
        kind: 'product',
        path: g.c.repository,
        targetBranch: g.c.targetBranch,
        gates: g.c.gates,
        protectedPaths: g.c.protectedPaths,
        generatedPaths: ['deliverables/'],
      },
    ];
    g.h.pause(false);
    await g.scheduler.drain();
    assert.match(g.store.read().tasks.find((t) => t.status === 'failed')!.failure!, /защищённые/);
  } finally {
    await g.cleanup();
  }
});

test('Ordered codegen runs from its cwd before a real test in candidate and integration', async () => {
  const f = await runnerFixture();
  try {
    await git(f.c.repository, 'merge', '--ff-only', f.scheduler.target);
    await mkdir(join(f.c.repository, 'tools'));
    await writeFile(
      join(f.c.repository, 'tools/generate.mjs'),
      "import {writeFileSync} from 'node:fs'; writeFileSync('../generated-marker', 'ready');",
    );
    await writeFile(
      join(f.c.repository, 'check-marker.mjs'),
      "import {readFileSync,writeFileSync} from 'node:fs'; if(JSON.parse(process.env.DEVCONTOUR_RESOURCES_JSON)[0].value!=='SIMULATOR-A') process.exit(2); if(readFileSync('generated-marker','utf8')!=='ready') process.exit(1); writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite><testcase name=\"generated\"/></testsuite>');",
    );
    await git(f.c.repository, 'add', 'tools', 'check-marker.mjs');
    await git(f.c.repository, 'commit', '-m', 'codegen fixture');
    await git(f.c.repository, 'update-ref', f.scheduler.target, 'HEAD');
    f.c.resources = [device];
    f.c.resourceDatabase = join(f.root, 'resource-pool.sqlite');
    f.c.gates = [
      {
        id: 'consumer',
        resources: ['phone'],
        kind: 'test',
        command: [process.execPath, 'check-marker.mjs'],
        timeoutMs: 10000,
        dependsOn: ['codegen'],
        report: { type: 'junit', path: '.reports/consumer.xml' },
      },
      {
        id: 'codegen',
        kind: 'check',
        command: [process.execPath, 'generate.mjs'],
        cwd: 'tools',
        timeoutMs: 10000,
      },
    ];
    f.h.pause(false);
    await f.scheduler.drain();
    assert.ok(
      f.store.read().tasks.every((t) => t.status === 'done'),
      JSON.stringify(f.store.read().tasks),
    );
    assert.deepEqual(
      f.store
        .read()
        .runs[2].evidence.filter((e) => e.kind === 'test')
        .map((e) => e.gate),
      ['codegen', 'consumer', 'codegen', 'consumer'],
    );
  } finally {
    await f.cleanup();
  }
});

const device = { id: 'phone', kind: 'device' as const, value: 'SIMULATOR-A' };
test('A host resource is exclusive across processes and aliases; TTL alone cannot steal ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-resource-')),
    path = join(root, 'resources.sqlite');
  const pool = new ResourcePool(path);
  try {
    assert.equal(pool.tryAcquire([device], 'workspace-a', 'token-a', 5000), true);
    const source = `import {ResourcePool} from ${JSON.stringify(new URL('../src/runner/resources.ts', import.meta.url).href)}; const p = new ResourcePool(process.argv[1]); console.log(p.tryAcquire([{id:'another-name',kind:'device',value:'simulator-a'}],'workspace-b','token-b',5000)); p.close();`;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', source, path],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (b) => (output += b));
    const [code] = await once(child, 'close');
    assert.equal(code, 0);
    assert.match(output, /false/);
    const db = new DatabaseSync(path);
    db.prepare('UPDATE leases SET expires=0').run();
    db.close();
    assert.equal(pool.tryAcquire([device], 'workspace-b', 'token-b', 5000), false);
    assert.throws(() => pool.clearAbandoned(resourceKey(device), 'token-a'), /ещё работает/);
    pool.release('wrong-token');
    assert.equal(pool.list().length, 1);
    pool.release('token-a');
    assert.equal(pool.tryAcquire([device], 'workspace-b', 'token-b', 5000), true);
  } finally {
    pool.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Resource acquisition is all-or-nothing; cancellation and failure release only owned leases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-resource-')),
    path = join(root, 'resources.sqlite');
  const c = config({
    resources: [device, { id: 'port', kind: 'port', value: '4327' }],
    resourceDatabase: path,
  });
  const pool = new ResourcePool(path);
  try {
    pool.tryAcquire([device], 'other-workspace', 'other-token', 5000);
    assert.equal(pool.tryAcquire(c.resources, 'us', 'us-token', 5000), false);
    assert.equal(pool.list().length, 1);
    const aborted = AbortSignal.timeout(100);
    await assert.rejects(
      withResources(c, ['phone'], 'waiting', aborted, async () => {
        throw new Error('must not execute');
      }),
    );
    assert.equal(pool.list()[0].token, 'other-token');
    pool.release('other-token');
    await assert.rejects(
      withResources(
        c,
        ['phone', 'port'],
        'failure',
        new AbortController().signal,
        async (_signal, resources) => {
          assert.equal(resources.length, 2);
          assert.equal(pool.list().length, 2);
          throw new Error('failed gate');
        },
      ),
      /failed gate/,
    );
    assert.equal(pool.list().length, 0);
  } finally {
    pool.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI context-lock pins committed instructions, context-show resolves task selection and a running queue blocks policy updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-context-cli-'));
  const repo = join(root, 'repo'),
    data = join(root, 'data');
  await mkdir(repo);
  await mkdir(data);
  try {
    await git(repo, 'init', '-b', 'main');
    await writeFile(join(repo, 'guide.md'), 'Use the canonical SDK contract.');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'guide');
    const c = config({
      repository: repo,
      contextPacks: [
        {
          id: 'sdk',
          version: '1',
          repositoryId: 'main',
          roles: ['qa'],
          files: ['guide.md'],
          references: [],
        },
      ],
    });
    await writeFile(join(data, 'config.json'), JSON.stringify(c));
    const store = new Store(join(data, 'state.sqlite')),
      h = new DevContour(store, c);
    const b = h.createBoard('SDK consumer');
    const t = h.addTask(b.id, input());
    store.close();
    const cli = ['node', '--import', 'tsx', 'src/cli.ts'];
    const locked = await command([...cli, 'context-lock', '--data', data], process.cwd());
    assert.equal(locked.code, 0, locked.stderr);
    assert.match(JSON.parse(locked.stdout).packs[0].digest, /^[a-f0-9]{64}$/);
    const shown = await command(
      [...cli, 'context-show', '--task', t.id, '--data', data],
      process.cwd(),
    );
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(JSON.parse(shown.stdout).text, /canonical SDK/);
    await command([...cli, 'queue', '--start', '--data', data], process.cwd());
    const rejected = await command([...cli, 'context-lock', '--data', data], process.cwd());
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /приостановите очередь/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('A pack names its references instead of inlining them, and pins them all the same', async () => {
  const f = await runnerFixture();
  try {
    await mkdir(join(f.c.repository, 'standards'), { recursive: true });
    await writeFile(join(f.c.repository, 'standards/rules.md'), 'Короткие правила на каждый день.');
    await writeFile(
      join(f.c.repository, 'standards/reference.md'),
      '# Справка\n' + 'подробности. '.repeat(400),
    );
    await git(f.c.repository, 'add', 'standards');
    await git(f.c.repository, 'commit', '-m', 'standards');
    f.c.contextPacks = [
      {
        id: 'standards',
        version: '1.0',
        repositoryId: 'main',
        roles: ['backend'],
        files: ['standards/rules.md'],
        references: ['standards/reference.md'],
      },
    ];
    f.c.contextPacks = await pinContext(f.c);
    const pinned = f.c.contextPacks[0].digest;

    const ctx = await taskContext(f.c, { role: 'backend', repositoryId: 'main' } as never);
    // Правила вкладываются, справка называется: библиотека стандартов на сотни
    // килобайт в промпт не помещается, а выбросить её — значит потерять именно
    // те детали, ради которых её писали.
    assert.match(ctx.text, /Короткие правила на каждый день/);
    assert.doesNotMatch(ctx.text, /подробности\. подробности/);
    assert.match(ctx.text, /- standards\/reference\.md/);

    // Справка закреплена наравне с правилами: её правка делает пин недействительным.
    await writeFile(join(f.c.repository, 'standards/reference.md'), '# Справка\nдругое\n');
    await git(f.c.repository, 'add', 'standards');
    await git(f.c.repository, 'commit', '-m', 'reference changed');
    assert.notEqual((await pinContext(f.c))[0].digest, pinned);
  } finally {
    await f.cleanup();
  }
});

test('Пакет, закрепивший старую редакцию утверждённого контракта, задачу не выдаёт', async () => {
  const f = await runnerFixture();
  try {
    await mkdir(join(f.c.repository, 'docs'));
    await writeFile(join(f.c.repository, 'docs/contract.md'), 'Причина привязана к максимуму.\n');
    await git(f.c.repository, 'add', 'docs');
    await git(f.c.repository, 'commit', '-m', 'contract v1');
    f.c.contextPacks = [
      {
        id: 'engine',
        version: '1.0',
        repositoryId: 'main',
        roles: ['architect', 'backend', 'frontend', 'qa'],
        files: ['docs/contract.md'],
        references: [],
      },
    ];
    f.c.contextPacks = await pinContext(f.c);
    // Контракт исправлен и утверждён, пакет не перезакреплён.
    await writeFile(join(f.c.repository, 'docs/contract.md'), 'Причина привязана к цели.\n');
    await git(f.c.repository, 'commit', '-qam', 'contract v2');
    const approved = {
      id: 'C-1',
      title: 'Контракт',
      content: 'Причина привязана к цели.\n',
      source: 'docs/contract.md',
      digest: 'd',
    } as Contract;
    const t = f.store.read().tasks[0];
    await assert.rejects(taskContext(f.c, t, [approved]), (e: Error) => {
      assert.ok(e instanceof BlockedError, 'не провал задачи, а блокировка до context-lock');
      assert.match(e.message, /context-lock/);
      assert.match(e.message, /C-1/);
      return true;
    });
    // Контракт без файла-источника и контракт другого файла не мешают.
    await taskContext(f.c, t, [{ ...approved, source: undefined }]);
    await taskContext(f.c, t, [{ ...approved, source: 'docs/other.md' }]);
    // Перезакрепление снимает блокировку.
    f.c.contextPacks = await pinContext(f.c);
    assert.match((await taskContext(f.c, t, [approved])).text, /привязана к цели/);
  } finally {
    await f.cleanup();
  }
});
