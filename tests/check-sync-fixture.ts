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
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { CheckCorpus } from '../src/core/check-store.ts';
import { configSchema, type Config } from '../src/core/model.ts';
import { repositories } from '../src/core/repositories.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { adapters, type AgentAdapter } from '../src/runner/adapters.ts';
import { pinArtifacts } from '../src/runner/contract-artifacts.ts';
import { submitCase } from '../src/runner/checks.ts';
import { check, declaration, knap, oracle, rejection } from './check-fixture.ts';

export const git = (path: string, ...args: string[]) =>
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
export const zero = (v: number) => JSON.stringify({ items: [{ w: 0, v }], cap: 0 });
/** Запись Git-состояния: читается как типизированный JSON. */
export const readRecord = <T>(path: string) => JSON.parse(readFileSync(path, 'utf8')) as T;
export const receiptOf = (repo: string, taskId: string) =>
  readRecord<{ progress: { receiptId: string } }>(join(repo, '.devcontour/tasks', taskId + '.json'))
    .progress.receiptId;

export interface Peer {
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
export async function peer(
  root: string,
  name: string,
  source?: Peer,
  storage: Config['storage'] | 'embedded' = 'component',
): Promise<Peer> {
  const embedded = storage === 'embedded';
  const base = join(root, name),
    repo = join(base, 'product'),
    // Embedded: workspace — корень единственного репозитория, одна SQLite.
    workspace = embedded ? repo : join(base, 'workspace');
  mkdirSync(base);
  for (const [path, from] of (embedded
    ? [[repo, source?.repo]]
    : [
        [workspace, source?.workspace],
        [repo, source?.repo],
      ]) as [string, string | undefined][]) {
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
    storage: embedded ? 'central' : storage,
    ...(embedded ? { workspaceMode: 'embedded' } : {}),
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
  const paths = embedded ? [repo] : [repo, workspace];
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
      for (const path of paths) {
        git(path, 'add', '.devcontour');
        if (git(path, 'diff', '--cached', '--name-only'))
          git(path, 'commit', '-m', 'Sync development state');
      }
    },
    pull() {
      for (const path of paths) git(path, 'pull', '--ff-only');
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

export async function contractFor(p: Peer) {
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
export async function deliver(p: Peer, title: string) {
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

export function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-check-sync-'));
  const peers: Peer[] = [];
  return {
    root,
    async create(name: string, source?: Peer, storage?: Config['storage'] | 'embedded') {
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

/** Вторая задача того же договора в клоне подтверждает свой случай на дефектном SHA. */
export async function secondCase(p: Peer, title: string, v: number, defect: string) {
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
export const stateDir = (p: Peer) =>
  p.h.config.workspaceMode === 'embedded' ? '.devcontour/components/main' : '.devcontour';
export const suiteFile = (p: Peer, id: string) => join(p.repo, stateDir(p), 'checks', id + '.json');
export const snapshot = (p: Peer) => ({
  state: JSON.stringify(p.store.read()),
  suites: JSON.stringify(new CheckCorpus(p.h).all()),
  files: readdirSync(join(p.repo, '.devcontour/checks')).map((f) =>
    readFileSync(join(p.repo, '.devcontour/checks', f), 'utf8'),
  ),
});
