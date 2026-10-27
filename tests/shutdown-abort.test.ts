// Graceful shutdown reaches the runtime: the harness runner aborts the
// implementation call, the runtime ends it (a live CLI gets SIGTERM, not an
// orphaned process group), and the work returns to the queue with the attempt
// marked `interrupted: shutdown`. Covered for a host adapter wrapped by
// `fromAgentAdapter`, for the live CLI adapter inside the process, and for a
// real `serve` process receiving SIGTERM.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupDemo } from '../src/demo.ts';
import { demoPool } from './demo-pool.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { adapters, type AgentRequest } from '../src/runner/adapters.ts';
import { git } from '../src/runner/process.ts';
import { repositories } from '../src/core/repositories.ts';
import { input } from './helpers.ts';

const demos = demoPool(setupDemo);
after(() => demos.close());

const hung = (ms: number) => new Promise<'hung'>((r) => setTimeout(() => r('hung'), ms).unref());

/** Ready work on an approved board, target ref at HEAD, queue unpaused. */
async function readyTask(h: DevContour) {
  const repo = repositories(h.config)[0];
  await git(
    repo.path,
    'update-ref',
    `refs/heads/${repo.targetBranch}`,
    await git(repo.path, 'rev-parse', 'HEAD'),
  );
  const board = h.createBoard('Board');
  const task = h.addTask(board.id, input('Long implementation'));
  h.approve(board.id);
  h.pause(false);
  return task;
}

function assertRequeued(store: Store, taskId: string) {
  const task = store.read().tasks.find((t) => t.id === taskId)!;
  assert.equal(task.status, 'ready', task.failure);
  const runs = store.read().runs.filter((r) => r.taskId === taskId);
  assert.deepEqual(
    runs.map((r) => (r as { interrupted?: string }).interrupted),
    ['shutdown'],
  );
}

/**
 * Workspace whose writers are the live `codex` CLI, plus a fake `codex` on
 * PATH that sleeps until SIGTERM and records every PID it ran under.
 */
async function liveWorkspace() {
  const seed = await demos.acquire();
  const configPath = join(seed.root, 'config.json');
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
    roles: Record<string, Record<string, unknown>>;
  };
  for (const role of Object.keys(raw.roles))
    raw.roles[role] = { ...raw.roles[role], runtime: 'codex' };
  writeFileSync(configPath, JSON.stringify(raw, null, 2));
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-shutdown-abort-')));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const pids = join(dir, 'pids'),
    terminated = join(dir, 'terminated');
  writeFileSync(
    join(bin, 'codex'),
    `#!/usr/bin/env node
const fs = require('fs');
if (process.argv.includes('--version')) { console.log('codex 0.0.0'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n');
process.on('SIGTERM', () => { fs.appendFileSync(${JSON.stringify(terminated)}, process.pid + '\\n'); process.exit(143); });
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
  const read = (file: string) =>
    existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number) : [];
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  return {
    seed,
    path: bin + delimiter + (process.env.PATH ?? ''),
    alive,
    /** Every CLI that started (the seed's own ready work runs alongside) got SIGTERM and is gone. */
    assertTerminated() {
      const started = read(pids).sort();
      assert.ok(started.length, 'the live CLI started');
      assert.deepEqual(read(terminated).sort(), started, 'every CLI received SIGTERM');
      assert.deepEqual(started.filter(alive), [], 'no CLI is left running');
    },
    async waitStarted() {
      const deadline = Date.now() + 40_000;
      while (!read(pids).length && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 100));
      return read(pids);
    },
    cleanup() {
      // Only PIDs the fake itself recorded: a regression must not leave an orphan.
      for (const pid of read(pids)) if (alive(pid)) process.kill(pid, 'SIGKILL');
      const temp = realpathSync(tmpdir());
      if (dir.startsWith(temp + sep) && dir.includes('devcontour-shutdown-abort-'))
        rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('Shutdown aborts a host adapter wrapped by fromAgentAdapter and requeues its work', async () => {
  const seed = await demos.acquire();
  const config = loadConfig(join(seed.root, 'config.json'));
  const store = new Store(join(seed.root, 'state.sqlite'));
  const h = new DevContour(store, config);
  // Releases the adapter after a failed check so a regression fails instead of hanging.
  const release = new AbortController();
  try {
    const task = await readyTask(h);
    let invoked!: () => void;
    const started = new Promise<void>((r) => (invoked = r));
    let aborted = false;
    const scheduler = new Scheduler(h, seed.root, {
      ...adapters,
      demo: {
        name: 'demo' as const,
        reviewProtocol: 1 as const,
        execute: async (request: AgentRequest) => {
          if (request.task?.id !== task.id || request.review) return adapters.demo.execute(request);
          invoked();
          return new Promise((_, reject) => {
            const end = () => reject(new Error('aborted'));
            request.signal.addEventListener('abort', () => ((aborted = true), end()), {
              once: true,
            });
            release.signal.addEventListener('abort', end, { once: true });
          });
        },
      },
    });
    await scheduler.init();
    scheduler.start();
    await started;
    const stopped = await Promise.race([
      scheduler.stop().then(() => 'stopped' as const),
      hung(15_000),
    ]);
    if (stopped === 'hung') {
      release.abort();
      await scheduler.stop();
    }
    assert.equal(stopped, 'stopped', 'stop() waits for an adapter that never sees the abort');
    assert.ok(aborted, 'the adapter received the runner abort signal');
    assertRequeued(store, task.id);
  } finally {
    release.abort();
    store.close();
    seed.release();
  }
});

test('Shutdown terminates a live CLI implementation call and requeues its work', async () => {
  const live = await liveWorkspace();
  const saved = process.env.PATH;
  // The live adapter takes PATH from the runner environment (process.env).
  process.env.PATH = live.path;
  const store = new Store(join(live.seed.root, 'state.sqlite'));
  try {
    const h = new DevContour(store, loadConfig(join(live.seed.root, 'config.json')));
    const task = await readyTask(h);
    const scheduler = new Scheduler(h, live.seed.root);
    await scheduler.init();
    scheduler.start();
    assert.ok((await live.waitStarted()).length, 'the live CLI started');
    const stopped = await Promise.race([
      scheduler.stop().then(() => 'stopped' as const),
      hung(15_000),
    ]);
    assert.equal(stopped, 'stopped');
    live.assertTerminated();
    assertRequeued(store, task.id);
  } finally {
    process.env.PATH = saved;
    store.close();
    live.cleanup();
    live.seed.release();
  }
});

test('SIGTERM to serve terminates the live CLI child and requeues its work', async () => {
  const live = await liveWorkspace();
  let taskId: string;
  {
    const store = new Store(join(live.seed.root, 'state.sqlite'));
    try {
      const h = new DevContour(store, loadConfig(join(live.seed.root, 'config.json')));
      taskId = (await readyTask(h)).id;
    } finally {
      store.close();
    }
  }
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const serve = spawn(
    process.execPath,
    ['--import', 'tsx', cli, 'serve', '--data', live.seed.root, '--port', '0'],
    { env: { ...process.env, PATH: live.path }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  serve.stdout.on('data', (d) => (output += d));
  serve.stderr.on('data', (d) => (output += d));
  const exited = new Promise<number | null>((r) => serve.once('exit', (code) => r(code)));
  try {
    assert.ok((await live.waitStarted()).length, 'the live CLI started: ' + output);
    serve.kill('SIGTERM');
    const code = await Promise.race([exited, hung(20_000)]);
    assert.equal(code, 0, 'serve exits after SIGTERM: ' + output);
    live.assertTerminated();
    const store = new Store(join(live.seed.root, 'state.sqlite'));
    try {
      assertRequeued(store, taskId);
    } finally {
      store.close();
    }
  } finally {
    if (serve.exitCode === null && serve.signalCode === null) serve.kill('SIGKILL');
    await exited;
    live.cleanup();
    live.seed.release();
  }
});
