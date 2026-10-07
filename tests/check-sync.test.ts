import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { CheckCorpus } from '../src/core/check-store.ts';
import { configSchema, type Config } from '../src/core/model.ts';
import { repositories } from '../src/core/repositories.ts';
import { canonical } from '../src/core/sync-model.ts';
import { syncGit } from '../src/runner/git-sync.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { adapters, type AgentAdapter } from '../src/runner/adapters.ts';
import { pinArtifacts } from '../src/runner/contract-artifacts.ts';
import { submitCase } from '../src/runner/checks.ts';
import { check, declaration, knap, oracle, reach, rejection } from './check-fixture.ts';

const git = (path: string, ...args: string[]) =>
  execFileSync('git', ['-C', path, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Sync Test',
      GIT_AUTHOR_EMAIL: 'sync@example.test',
      GIT_COMMITTER_NAME: 'Sync Test',
      GIT_COMMITTER_EMAIL: 'sync@example.test',
    },
  }).trim();
const zero = (v: number) => JSON.stringify({ items: [{ w: 0, v }], cap: 0 });
/** Запись Git-состояния: читается как типизированный JSON. */
const readRecord = <T>(path: string) => JSON.parse(readFileSync(path, 'utf8')) as T;
const receiptOf = (repo: string, taskId: string) =>
  readRecord<{ progress: { receiptId: string } }>(join(repo, '.devcontour/tasks', taskId + '.json'))
    .progress.receiptId;

interface Peer {
  name: string;
  repo: string;
  workspace: string;
  data: string;
  store: Store;
  h: DevContour;
  files: Record<string, string>;
  reject: boolean;
  scheduler: Scheduler;
  commit(): void;
  pull(): void;
}

/** Независимый clone: свой workspace, свой репозиторий компонента, своя БД. */
async function peer(
  root: string,
  name: string,
  source?: Peer,
  storage: Config['storage'] = 'component',
): Promise<Peer> {
  const base = join(root, name),
    workspace = join(base, 'workspace'),
    repo = join(base, 'product');
  mkdirSync(base);
  for (const [path, from] of [
    [workspace, source?.workspace],
    [repo, source?.repo],
  ] as const) {
    if (from) git(base, 'clone', '--no-local', from, path);
    else {
      mkdirSync(path);
      git(path, 'init', '-b', 'main');
      writeFileSync(join(path, '.gitignore'), '.devcontour-local/\n.reports/\n');
      if (path === repo) {
        mkdirSync(join(path, 'src'));
        copyFileSync(
          new URL('../packs/property/harness.mjs', import.meta.url),
          join(path, 'harness.mjs'),
        );
        writeFileSync(join(path, 'oracle.mjs'), oracle);
        writeFileSync(join(path, 'check.mjs'), check(120, { zeroWeights: false }));
        writeFileSync(join(path, 'src/knap.mjs'), knap.stub);
        writeFileSync(join(path, 'src/reach.mjs'), 'export function reach() { return []; }\n');
      } else writeFileSync(join(path, 'README.md'), 'Workspace.\n');
      git(path, 'add', '.');
      git(path, 'commit', '-m', 'baseline');
    }
    git(path, 'config', 'user.name', 'Sync Test');
    git(path, 'config', 'user.email', 'sync@example.test');
  }
  const c = configSchema.parse({
    version: 1,
    name: 'Check sync',
    repository: repo,
    workspaceRoot: workspace,
    storage,
    mode: 'demo',
    concurrency: 1,
    maxAttempts: 3,
    isolation: { mode: 'none' },
    roles: { backend: { runtime: 'demo' } },
    reviewer: { runtime: 'demo' },
    gates: [
      {
        id: 'properties',
        kind: 'test',
        command: ['node', 'check.mjs'],
        timeoutMs: 30000,
        report: { type: 'junit', path: '.reports/properties.xml' },
        property: {},
      },
    ],
    protectedPaths: ['check.mjs', 'harness.mjs', 'oracle.mjs'],
  });
  const data = join(workspace, '.devcontour-local');
  const store = new Store(
    join(data, 'state.sqlite'),
    storage === 'component' ? repositories(c) : undefined,
  );
  const h = new DevContour(store, c);
  const self: Peer = {
    name,
    repo,
    workspace,
    data,
    store,
    h,
    files: {},
    reject: false,
    scheduler: undefined as unknown as Scheduler,
    commit() {
      for (const path of [repo, workspace]) {
        git(path, 'add', '.devcontour');
        if (git(path, 'diff', '--cached', '--name-only'))
          git(path, 'commit', '-m', 'Sync development state');
      }
    },
    pull() {
      for (const path of [repo, workspace]) git(path, 'pull', '--ff-only');
    },
  };
  const writer: AgentAdapter = {
    name: 'demo',
    async execute(r) {
      if (r.review)
        return {
          data: self.reject
            ? rejection({
                property: 'knapsack-optimal',
                input: zero(5),
                expected: '5',
                actual: '0',
              })
            : { approved: true, summary: 'ok', findings: [] },
          log: '',
          command: ['reviewer'],
        };
      for (const [path, content] of Object.entries(self.files))
        writeFileSync(join(r.cwd, path), content);
      return Promise.resolve({
        data: { completed: true, summary: 'ok', discoveries: [] },
        log: '',
        command: [],
      });
    },
  };
  self.scheduler = new Scheduler(h, data, { ...adapters, demo: writer });
  await self.scheduler.init();
  return self;
}

async function contractFor(p: Peer) {
  const pinned = await pinArtifacts({ id: 'main', path: p.repo }, [
    { path: 'oracle.mjs', purpose: 'Эталоны' },
    { path: 'check.mjs', purpose: 'Генераторы и свойства' },
    { path: 'harness.mjs', purpose: 'Harness' },
  ]);
  return p.h.contract(
    'Knapsack',
    'Оптимум рюкзака по oracle.mjs.',
    { actor: 'agent', authorRuntime: 'codex', reviewerRuntime: 'claude' },
    'main',
    undefined,
    pinned.artifacts,
    declaration(),
  );
}

/** Задача доводится до done по реальному runner: отказ ревью, подтверждение, исправление. */
async function deliver(p: Peer, title: string) {
  const contract = p.store.read().contracts.at(-1) ?? (await contractFor(p));
  const board = p.h.createBoard(title, '', 'main');
  const t = p.h.addTask(board.id, {
    title,
    description: 'Оптимум рюкзака по договору проверки.',
    role: 'backend',
    contracts: [contract.id],
    acceptance: ['AC-optimal'],
    writePaths: ['src/'],
    properties: ['knapsack-optimal'],
  });
  p.h.approve(board.id, undefined, {
    actor: 'agent',
    authorRuntime: 'codex',
    reviewerRuntime: 'claude',
  });
  p.h.pause(false);
  p.files['src/knap.mjs'] = knap.zeroWeight;
  p.reject = true;
  await p.scheduler.drain();
  p.reject = false;
  const confirmed = await submitCase(p.h, p.data, {
    taskId: t.id,
    property: 'knapsack-optimal',
    input: zero(5),
    expected: '5',
    key: `case-${title.replace(/[^A-Za-z0-9]/g, '-')}`,
    origin: 'review',
  });
  assert.equal(confirmed.decision.outcome, 'confirmed', confirmed.decision.reason);
  p.files['src/knap.mjs'] = knap.correct;
  p.h.retry(t.id);
  await p.scheduler.drain();
  p.h.pause(true);
  const done = p.store.read().tasks.find((x) => x.id === t.id)!;
  assert.equal(done.status, 'done', done.failure);
  git(p.repo, 'merge', '--ff-only', 'devcontour/accepted');
  return { task: done, suite: confirmed.suite };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-check-sync-'));
  const peers: Peer[] = [];
  return {
    root,
    async create(name: string, source?: Peer, storage?: Config['storage']) {
      const p = await peer(root, name, source, storage);
      peers.push(p);
      return p;
    },
    async cleanup() {
      for (const p of peers) {
        await p.scheduler.stop();
        p.store.close();
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('AC20: an independent clone receives the accepted completion with the same task, check version, both phases and available SHA and blobs', async () => {
  const f = fixture();
  try {
    const a = await f.create('alice');
    syncGit(a.h, { member: 'alice' });
    const { task, suite } = await deliver(a, 'Optimal knapsack');
    syncGit(a.h);
    a.commit();
    const b = await f.create('bob', a);
    syncGit(b.h, { member: 'bob' });
    const restored = b.store.read().tasks.find((t) => t.id === task.id)!;
    assert.equal(restored.status, 'done');
    assert.equal(restored.resultSha, task.resultSha);
    assert.deepEqual(restored.checkVersion, task.checkVersion);
    const receipt = restored.sharedCompletion!.receipt;
    assert.deepEqual(receipt.checkVersion?.corpus, task.checkVersion);
    const run = a.store
      .read()
      .runs.findLast((r) => r.taskId === task.id && r.status === 'succeeded')!;
    assert.equal(receipt.checkVersion?.effective, run.checks?.effective);
    for (const phase of ['candidate', 'integration'] as const) {
      const entry = receipt.checks.find((c) => c.gate === 'properties' && c.phase === phase)!;
      assert.equal(entry.checks, run.checks?.effective);
      assert.equal(entry.property?.level, 'manifest');
      assert.deepEqual(entry.property?.manifest?.properties, ['knapsack-optimal']);
      assert.equal(entry.property?.manifest?.corpus?.cases, 1);
    }
    // Receipt обозначен импортированным: живой попытки во втором клоне нет.
    assert.equal(b.store.read().runs.length, 0);
    assert.ok(restored.sharedCompletion!.sourceCommit);
    // Корпус и его blob доступны независимому клону.
    const imported = new CheckCorpus(b.h).get(suite);
    const version = imported.versions[0];
    assert.equal(version.digest, task.checkVersion!.digest);
    assert.ok(git(b.repo, 'cat-file', 'blob', version.blob).includes('"expected":5'));
    git(b.repo, 'cat-file', '-e', `${receipt.candidateSha}^{commit}`);
  } finally {
    await f.cleanup();
  }
});

/** Вторая задача того же договора в клоне подтверждает свой случай на дефектном SHA. */
async function secondCase(p: Peer, title: string, v: number, defect: string) {
  const contract = p.store.read().contracts[0];
  const board = p.h.createBoard(title, '', 'main');
  const t = p.h.addTask(board.id, {
    title,
    description: 'Оптимум рюкзака по договору проверки.',
    role: 'backend',
    contracts: [contract.id],
    acceptance: ['AC-optimal'],
    writePaths: ['src/'],
    properties: ['knapsack-optimal'],
  });
  p.h.approve(board.id, undefined, {
    actor: 'agent',
    authorRuntime: 'codex',
    reviewerRuntime: 'claude',
  });
  const r = await submitCase(p.h, p.data, {
    taskId: t.id,
    property: 'knapsack-optimal',
    input: zero(v),
    key: `case-${p.name}-${v}`,
    sourceSha: defect,
  });
  assert.equal(r.decision.outcome, 'confirmed', r.decision.reason);
  return t;
}
const suiteFile = (p: Peer, id: string) => join(p.repo, '.devcontour/checks', id + '.json');
const snapshot = (p: Peer) => ({
  state: JSON.stringify(p.store.read()),
  suites: JSON.stringify(new CheckCorpus(p.h).all()),
  files: readdirSync(join(p.repo, '.devcontour/checks')).map((f) =>
    readFileSync(join(p.repo, '.devcontour/checks', f), 'utf8'),
  ),
});

test('AC21: independent additions merge three-way; a conflicting expectation or an invalid DAG rolls back without losing the baseline', async () => {
  const f = fixture();
  try {
    const a = await f.create('alice');
    syncGit(a.h, { member: 'alice' });
    const { task, suite } = await deliver(a, 'Optimal knapsack');
    const defect = a.store
      .read()
      .runs.find((r) => r.taskId === task.id && r.candidateSha)!.candidateSha!;
    syncGit(a.h);
    a.commit();
    const b = await f.create('bob', a);
    syncGit(b.h, { member: 'bob' });
    // Независимые добавки: каждая только в своей БД, Git ещё не видел вторую.
    const fromA = await secondCase(a, 'Alice second', 6, defect);
    const fromB = await secondCase(b, 'Bob second', 7, defect);
    syncGit(a.h);
    a.commit();
    for (const path of [b.repo, b.workspace]) git(path, 'pull', '--ff-only', '-q');
    syncGit(b.h);
    const merged = new CheckCorpus(b.h).get(suite);
    const inputs = Object.values(merged.cases).map(
      (c) => (JSON.parse(c.input) as { items: { v: number }[] }).items[0].v,
    );
    assert.deepEqual(inputs.sort(), [5, 6, 7], 'объединение сохранило случаи обоих клонов');
    const tasks = b.store.read().tasks;
    const boundA = tasks.find((t) => t.id === fromA.id)!.checkVersion!;
    const boundB = tasks.find((t) => t.id === fromB.id)!.checkVersion!;
    assert.notEqual(boundA.digest, boundB.digest);
    assert.ok(merged.versions.some((v) => v.digest === boundA.digest));
    assert.ok(merged.versions.some((v) => v.digest === boundB.digest));
    b.commit();
    git(a.repo, 'pull', '--ff-only', '-q', b.repo, 'main');
    git(a.workspace, 'pull', '--ff-only', '-q', b.workspace, 'main');
    syncGit(a.h);
    assert.equal(Object.keys(new CheckCorpus(a.h).get(suite).cases).length, 3);

    // Противоречивое ожидание в Git: тот же вход, другой ответ.
    const before = snapshot(b);
    const baseline = JSON.stringify(b.store.syncBaseline('main'));
    const file = suiteFile(b, suite);
    const record = JSON.parse(readFileSync(file, 'utf8')) as {
      data: { cases: { expected: string }[] };
    };
    record.data.cases[0] = { ...record.data.cases[0], expected: '99' };
    writeFileSync(file, canonical(record));
    git(b.repo, 'commit', '-qam', 'forged expected');
    assert.throws(() => syncGit(b.h), /Конфликт корпуса|не совпадает/);
    assert.deepEqual(snapshot(b).state, before.state);
    assert.deepEqual(snapshot(b).suites, before.suites);
    assert.equal(JSON.stringify(b.store.syncBaseline('main')), baseline);
    git(b.repo, 'reset', '-q', '--hard', 'HEAD~1');

    // Невалидный DAG в Git откатывает и корпус.
    const taskFile = join(b.repo, '.devcontour/tasks', fromB.id + '.json');
    const taskRecord = JSON.parse(readFileSync(taskFile, 'utf8')) as {
      data: { dependsOn: string[] };
    };
    taskRecord.data.dependsOn = [fromB.id];
    writeFileSync(taskFile, canonical(taskRecord));
    git(b.repo, 'commit', '-qam', 'cycle');
    assert.throws(() => syncGit(b.h), /Цикл|Постановка изменилась/);
    assert.deepEqual(snapshot(b).suites, before.suites);
    assert.equal(JSON.stringify(b.store.syncBaseline('main')), baseline);
  } finally {
    await f.cleanup();
  }
});

test('AC22: central, component and embedded storage keep the corpus with its owner; leases, commands and paths never reach Git', async () => {
  const f = fixture();
  try {
    for (const storage of ['component', 'central'] as const) {
      const p = await f.create(storage, undefined, storage);
      syncGit(p.h, { member: storage });
      const { suite } = await deliver(p, 'Optimal ' + storage);
      syncGit(p.h);
      const rows = (db: string) => {
        const d = new DatabaseSync(db, { readOnly: true });
        try {
          const table = d
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='local_workflow'")
            .get();
          return table
            ? (d
                .prepare("SELECT data FROM local_workflow WHERE namespace='check-suites'")
                .all() as { data: string }[])
            : [];
        } finally {
          d.close();
        }
      };
      const coordinator = rows(join(p.data, 'state.sqlite'));
      if (storage === 'component') {
        const component = rows(join(p.repo, '.devcontour-local', 'state.sqlite'));
        assert.equal(component.length, 1, 'корпус — в БД компонента');
        assert.ok(component[0].data.includes('"cap\\":0'));
        assert.equal(coordinator.length, 0, 'тела корпуса не в coordinator');
      } else assert.equal(coordinator.length, 1, 'central: корпус в единственной БД');
      // В Git — данные корпуса, но не операции, токены, команды и пути.
      const text = readFileSync(suiteFile(p, suite), 'utf8');
      assert.ok(text.includes('"expected": "5"'));
      for (const banned of [
        'token',
        'leaseUntil',
        'operations',
        'pending',
        '"command"',
        p.data,
        p.workspace,
      ])
        assert.equal(text.includes(banned), false, `${storage}: ${banned} не в Git`);
      const receipts = readdirSync(join(p.repo, '.devcontour/receipts')).map((x) =>
        readFileSync(join(p.repo, '.devcontour/receipts', x), 'utf8'),
      );
      for (const r of receipts) assert.equal(r.includes(p.data), false);
    }
  } finally {
    await f.cleanup();
  }
});

test('AC23: an old receipt keeps its level, an incomplete new one is refused, and the new format round-trips without losing fields', async () => {
  const f = fixture();
  try {
    const a = await f.create('alice');
    syncGit(a.h, { member: 'alice' });
    const { task } = await deliver(a, 'Optimal knapsack');
    syncGit(a.h);
    a.commit();
    // Round-trip: экспорт второго клона совпадает с исходным.
    const b = await f.create('bob', a);
    syncGit(b.h, { member: 'bob' });
    for (const dir of ['receipts', 'checks', 'tasks', 'contracts']) {
      const names = readdirSync(join(a.repo, '.devcontour', dir));
      for (const name of names)
        assert.equal(
          readFileSync(join(b.repo, '.devcontour', dir, name), 'utf8'),
          readFileSync(join(a.repo, '.devcontour', dir, name), 'utf8'),
          `${dir}/${name} без потерь`,
        );
    }
    // Новый receipt без версии проверок у задачи с договором проверки.
    const receiptId = receiptOf(a.repo, task.id);
    const strip = (p: Peer, change: (r: { data: Record<string, unknown> }) => void) => {
      const file = join(p.repo, '.devcontour/receipts', receiptId + '.json');
      const record = readRecord<{ data: Record<string, unknown> }>(file);
      change(record);
      writeFileSync(file, canonical(record));
      git(p.repo, 'commit', '-qam', 'tampered receipt');
    };
    const c = await f.create('carol', a);
    strip(c, (r) => delete r.data.checkVersion);
    assert.throws(() => syncGit(c.h, { member: 'carol' }), /без версии проверок/);
    assert.equal(c.store.read().tasks.length, 0, 'ничего не импортировано');
    // Ссылка на версию корпуса, которой нет в Git.
    const d = await f.create('dave', a);
    strip(d, (r) => {
      const v = r.data.checkVersion as { corpus: { digest: string } };
      v.corpus.digest = 'e'.repeat(64);
    });
    assert.throws(
      () => syncGit(d.h, { member: 'dave' }),
      /версия проверок не соответствует|которой нет в Git|Привязка корпуса/,
    );
    // Старый receipt задачи без договора проверки читается на прежнем уровне.
    const contract = a.store.read().contracts[0];
    const board = a.h.createBoard('Legacy', '', 'main');
    const legacy = a.h.addTask(board.id, {
      title: 'Legacy knapsack',
      description: 'Задача прежнего договора без области свойств.',
      role: 'backend',
      contracts: [contract.id],
      acceptance: ['AC-optimal'],
      writePaths: ['src/'],
    });
    a.h.approve(board.id, undefined, {
      actor: 'agent',
      authorRuntime: 'codex',
      reviewerRuntime: 'claude',
    });
    // Записи sync закоммичены в рабочую ветку: база прогонов переносится.
    git(a.repo, 'update-ref', 'refs/heads/devcontour/accepted', 'HEAD');
    a.h.pause(false);
    // Задача без области свойств проверяется всеми свойствами файла проверок.
    a.files['src/knap.mjs'] = knap.correct + '\n// legacy\n';
    a.files['src/reach.mjs'] = reach.correct;
    await a.scheduler.drain();
    a.h.pause(true);
    assert.equal(a.store.read().tasks.find((t) => t.id === legacy.id)!.status, 'done');
    git(a.repo, 'merge', '--ff-only', 'devcontour/accepted');
    syncGit(a.h);
    a.commit();
    const old = await f.create('erin', a);
    const legacyReceipt = receiptOf(old.repo, legacy.id);
    // Receipt прежнего формата: без версии проверок и манифеста свойств.
    const file = join(old.repo, '.devcontour/receipts', legacyReceipt + '.json');
    const record = readRecord<{
      data: { checkVersion?: unknown; checks: { checks?: unknown; property?: unknown }[] };
    }>(file);
    delete record.data.checkVersion;
    for (const c of record.data.checks) {
      delete c.checks;
      delete c.property;
    }
    writeFileSync(file, canonical(record));
    git(old.repo, 'commit', '-qam', 'receipt of the previous format');
    syncGit(old.h, { member: 'erin' });
    const restored = old.store.read().tasks.find((t) => t.id === legacy.id)!;
    assert.equal(restored.status, 'done');
    assert.equal(restored.sharedCompletion?.receipt.checkVersion, undefined);
  } finally {
    await f.cleanup();
  }
});
