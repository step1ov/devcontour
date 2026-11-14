import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { findOrphans, parseRows, sweepOrphans } from '../scripts/orphans.mjs';
import type { ProcessRow } from '../scripts/orphans.mjs';
import { busyReason, describeLoad, waitForQuiet } from '../scripts/machine-load.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const MARK = 'DEVCONTOUR_CHECK_INVOCATION';
const START = 'Sat Nov 14 10:00:00 2026';
const row = (pid: number, ppid: number, command: string, mark?: string): ProcessRow => ({
  pid,
  ppid,
  start: START,
  command,
  mark,
});
const demo = (run: string) => `npm run devcontour -- demo --data /tmp/devcontour-e2e-${run}/data`;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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
    // The sweeping check and its own ancestors are never taken.
    row(60, 1, 'npm run check', 'old-mark'),
    row(61, 60, 'node scripts/check.mjs'),
  ];
  const orphans = findOrphans(rows, 61);
  assert.deepEqual(
    [...orphans.keys()].sort((a, b) => a - b),
    [20, 21, 40, 41, 42],
  );
  assert.match(orphans.get(21)?.why ?? '', /e2e demo server/);
  assert.match(orphans.get(42)?.why ?? '', /left by check dead-che/);
});

test('ps rows: the e2e pattern is read from arguments, the marker from the environment', () => {
  const line = (pid: number, ppid: number, text: string, stat = 'Ss') =>
    `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${START} ${stat}   ${text}`;
  const guard = 'DEVCONTOUR_E2E_CLI_GUARD=/tmp/devcontour-e2e-1794590582965/cli-guard';
  const argv = [
    line(70, 1, 'node server.js demo --data /work/data'),
    line(71, 1, `node -e "process.env.${MARK}='argv-only'"`),
    line(72, 1, demo('1794590582965')),
    line(73, 1, 'npm run test'),
    line(74, 1, 'npm run old', 'Z'),
  ].join('\n');
  const env = [
    // Only the inherited environment names an e2e run directory.
    line(70, 1, `node server.js demo --data /work/data ${guard} PATH=/bin`),
    line(71, 1, `node -e "process.env.${MARK}='argv-only'" HOME=/h`),
    line(72, 1, `${demo('1794590582965')} ${guard}`),
    line(73, 1, `npm run test ${MARK}=dead-check HOME=/h`),
  ].join('\n');
  const rows = parseRows(argv, env);
  assert.deepEqual(
    rows.map((r) => [r.pid, r.ppid, r.start, r.mark]),
    [
      [70, 1, START, undefined],
      [71, 1, START, undefined],
      [72, 1, START, undefined],
      [73, 1, START, 'dead-check'],
    ],
  );
  assert.equal(rows[0].command, 'node server.js demo --data /work/data');
  assert.deepEqual([...findOrphans(rows, 999).keys()].sort(), [72, 73]);
});

test('A busy machine is named by its cause; a quiet one passes', () => {
  const quiet = {
    busy: 0.3,
    swapOutsPerSecond: 0,
    memoryAvailablePercent: 53,
    load1: 30,
    cores: 10,
  };
  assert.equal(busyReason(quiet), undefined);
  assert.match(describeLoad(quiet), /cpu 30% busy of 10 cores.*memory 53% available/);
  const busy = { ...quiet, busy: 0.9, memoryAvailablePercent: 8, swapOutsPerSecond: 400 };
  const reason = busyReason(busy) ?? '';
  assert.match(reason, /cores 90% busy/);
  assert.match(reason, /memory 8% available/);
  assert.match(reason, /swapping 400 pages\/s/);
  assert.equal(
    busyReason({ ...quiet, memoryAvailablePercent: undefined, swapOutsPerSecond: undefined }),
    undefined,
  );
});

test('The check waits for a quiet machine and runs anyway when it stays busy', async () => {
  const quiet = {
    busy: 0.2,
    swapOutsPerSecond: 0,
    memoryAvailablePercent: 50,
    load1: 3,
    cores: 10,
  };
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
  assert.equal(lines.filter((l) => /busy — cores 95% busy.*waiting/.test(l)).length, 2);
  assert.match(lines.at(-1) ?? '', /^machine: quiet/);

  lines.length = 0;
  const stayed = await waitForQuiet({
    waitMs: 30,
    intervalMs: 20,
    log: (line: string) => lines.push(line),
    measure: () => Promise.resolve(busy),
  });
  assert.equal(stayed.quiet, false);
  assert.match(
    lines.at(-1) ?? '',
    /^machine: busy — cores 95% busy \(limit 50%\)\. The check runs anyway/,
  );
});

test('The sweep signals a process only while a fresh list still shows it orphaned', async () => {
  const victim = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const bystander = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore',
  });
  try {
    const orphaned = [row(victim.pid!, 1, demo('1794590582965'))];
    // The bystander looks orphaned in the first list only.
    const lists = [[...orphaned, row(bystander.pid!, 1, demo('1794590582966'))]];
    const log: string[] = [];
    const swept = await sweepOrphans({
      log: (l: string) => log.push(l),
      graceMs: 2000,
      list: () => Promise.resolve(lists.shift() ?? (alive(victim.pid!) ? orphaned : [])),
    });
    assert.equal(swept, 2);
    assert.match(log[0], /stopping 2 process\(es\) — 2 e2e demo server of a finished run/);
    for (let i = 0; i < 50 && alive(victim.pid!); i++) await delay(50);
    assert.equal(alive(victim.pid!), false, 'the orphan was stopped');
    assert.equal(alive(bystander.pid!), true, 'no longer orphaned: left alone');

    // A list that fails part-way stops the sweep without a signal.
    const failing = [orphaned];
    const later: string[] = [];
    assert.equal(
      await sweepOrphans({
        log: (l: string) => later.push(l),
        list: () =>
          failing.length
            ? Promise.resolve(failing.shift()!)
            : Promise.reject(new Error('ps timed out')),
      }),
      0,
    );
    assert.match(later.at(-1) ?? '', /process list unavailable, sweep stopped \(ps timed out\)/);
  } finally {
    victim.kill('SIGKILL');
    bystander.kill('SIGKILL');
  }
});

test(
  'An e2e server stops when its Playwright runner is killed outright, even one that ignores SIGTERM',
  { timeout: 40_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'e2e-server-'));
    const runner = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const pidFile = join(root, 'server.pid');
    // As under npm: a shell that exits on SIGTERM over a server that ignores it.
    const server = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
    // Detached like Playwright's own web server: the wrapper owns its group.
    const wrapper = spawn(
      process.execPath,
      [
        join(source, 'scripts', 'e2e-server.mjs'),
        String(runner.pid),
        '--',
        '/bin/sh',
        '-c',
        `"${process.execPath}" -e "${server.replace(/"/g, '\\"')}" & wait`,
      ],
      { stdio: 'ignore', detached: true },
    );
    try {
      for (let i = 0; i < 100 && !existsSync(pidFile); i++) await delay(100);
      const pid = Number(await readFile(pidFile, 'utf8'));
      await delay(2500);
      assert.ok(alive(pid), 'the server runs while its runner lives');
      runner.kill('SIGKILL');
      for (let i = 0; i < 150 && alive(pid); i++) await delay(100);
      assert.equal(alive(pid), false, 'the server stopped after its runner was killed');
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
