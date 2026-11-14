import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { findOrphans } from '../scripts/orphans.mjs';
import { busyReason, describeLoad, waitForQuiet } from '../scripts/machine-load.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const MARK = 'DEVCONTOUR_CHECK_INVOCATION';
const row = (pid: number, ppid: number, command: string, mark?: string) => ({
  pid,
  ppid,
  start: 'Sat Nov 14 10:00:00 2026',
  command: mark ? `${command} ${MARK}=${mark}` : command,
  mark,
});
const demo = (run: string) => `npm run devcontour -- demo --data /tmp/devcontour-e2e-${run}/data`;

test('Orphan sweep takes only e2e servers and check processes that lost their owner', () => {
  const rows = [
    row(10, 1, 'node /Applications/Something.app/server'),
    row(11, 1, 'node ./node_modules/.bin/devcontour serve --port 4317 --workspace /work/product'),
    // A finished e2e run: its server hangs off init, the child goes with it.
    row(20, 1, demo('1794590582965')),
    row(21, 20, 'node --import tsx src/cli.ts demo --port 4400'),
    // A running e2e run: the server's parent is the Playwright runner.
    row(30, 300, demo('1794600000000')),
    row(300, 299, 'node node_modules/.bin/playwright test'),
    // A check killed outright: every root of its invocation hangs off init.
    row(40, 1, 'npm run test', 'dead-check'),
    row(41, 40, 'node scripts/test.mjs', 'dead-check'),
    row(42, 41, 'git fetch', undefined),
    // A running check: its step has the check as parent; a daemon it
    // started has init as parent, but the invocation still has a live root.
    row(50, 500, 'npm run test', 'live-check'),
    row(51, 1, 'git daemon', 'live-check'),
    row(500, 499, 'node scripts/check.mjs'),
  ];
  const orphans = findOrphans(rows, 999);
  assert.deepEqual(
    [...orphans.keys()].sort((a, b) => a - b),
    [20, 21, 40, 41, 42],
  );
  assert.match(orphans.get(21)?.why ?? '', /e2e demo server/);
  assert.match(orphans.get(42)?.why ?? '', /left by check dead-che/);
  assert.equal(findOrphans(rows, 20).has(20), false, 'never the sweeping process itself');
});

test('A busy machine is named by its cause; a quiet one passes', () => {
  const quiet = { busy: 0.3, pageoutsPerSecond: 0, swapFreeMb: 3000, load1: 30, cores: 10 };
  assert.equal(busyReason(quiet), undefined);
  assert.match(describeLoad(quiet), /cpu 30% busy of 10 cores.*swap free 3000 MB/);
  const busy = { ...quiet, busy: 0.9, swapFreeMb: 200, pageoutsPerSecond: 400 };
  const reason = busyReason(busy) ?? '';
  assert.match(reason, /cores 90% busy/);
  assert.match(reason, /swap free 200 MB/);
  assert.match(reason, /swapping 400 pages\/s/);
  assert.equal(
    busyReason({ ...quiet, swapFreeMb: undefined, pageoutsPerSecond: undefined }),
    undefined,
  );
});

test('The check waits for a quiet machine and runs anyway when it stays busy', async () => {
  const quiet = { busy: 0.2, pageoutsPerSecond: 0, swapFreeMb: 3000, load1: 3, cores: 10 };
  const busy = { ...quiet, busy: 0.95 };
  const lines: string[] = [];
  const samples = [busy, busy, quiet];
  const calmed = await waitForQuiet({
    waitMs: 60_000,
    intervalMs: 1,
    log: (line: string) => lines.push(line),
    measure: () => Promise.resolve(samples.shift() ?? quiet),
  });
  assert.equal(calmed.quiet, true);
  assert.equal(lines.filter((l) => /busy — cores 95% busy/.test(l)).length, 2);
  assert.match(lines.at(-1) ?? '', /^machine: quiet/);

  lines.length = 0;
  const stayed = await waitForQuiet({
    waitMs: 0,
    log: (line: string) => lines.push(line),
    measure: () => Promise.resolve(busy),
  });
  assert.equal(stayed.quiet, false);
  assert.deepEqual(lines.length, 1);
  assert.match(lines[0], /still busy .* The check runs anyway/);
});

test(
  'An e2e server stops when its Playwright runner is killed outright',
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'e2e-server-'));
    const runner = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const pidFile = join(root, 'server.pid');
    // Detached like Playwright's own web server: the wrapper signals its group.
    const wrapper = spawn(
      process.execPath,
      [
        join(source, 'scripts', 'e2e-server.mjs'),
        String(runner.pid),
        '--',
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`,
      ],
      { stdio: 'ignore', detached: true },
    );
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      for (let i = 0; i < 100 && !existsSync(pidFile); i++) await delay(100);
      const server = Number(await readFile(pidFile, 'utf8'));
      await delay(2500);
      assert.ok(alive(server), 'the server runs while its runner lives');
      runner.kill('SIGKILL');
      for (let i = 0; i < 100 && alive(server); i++) await delay(100);
      assert.equal(alive(server), false, 'the server stopped after its runner was killed');
      for (let i = 0; i < 50 && wrapper.exitCode === null && wrapper.signalCode === null; i++)
        await delay(100);
      assert.ok(wrapper.exitCode !== null || wrapper.signalCode !== null, 'the wrapper exited');
    } finally {
      runner.kill('SIGKILL');
      try {
        process.kill(-wrapper.pid!, 'SIGKILL');
      } catch {
        /* Already gone. */
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
