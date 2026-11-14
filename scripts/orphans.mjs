import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// Processes left behind by an earlier check or e2e run that was killed
// outright. They keep servers, git and fixture work going for hours and slow
// every later run: two e2e demo servers were found alive 17 hours after their
// run. The sweep before a check stops only what provably has no owner left:
// - an e2e demo server (its arguments name a devcontour-e2e-<time> run
//   directory) whose parent has exited: while its run lives, the parent chain
//   leads to the Playwright runner, never to init;
// - every process of a check invocation (DEVCONTOUR_CHECK_INVOCATION in its
//   environment, see check-processes.mjs) none of whose roots has a live
//   parent: the check process itself is the parent of its steps, so a running
//   check always has one.
// Descendants of either go with them. macOS only: elsewhere `ps` cannot show
// the environment the same way, and nothing is swept.

const MARK = 'DEVCONTOUR_CHECK_INVOCATION';
const E2E_DEMO = /\bdemo --data \S*devcontour-e2e-\d+[/\\]/;
const COLUMNS = 'pid=,ppid=,lstart=,stat=,command=';

const ps = (withEnvironment) =>
  new Promise((resolve, reject) =>
    execFile(
      '/bin/ps',
      [...(withEnvironment ? ['-Eww'] : ['-ww']), '-ax', '-o', COLUMNS],
      {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
        timeout: 15_000,
        maxBuffer: 64_000_000,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );

const lines = (stdout) =>
  stdout.split('\n').flatMap((line) => {
    const row = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return row && !row[4].startsWith('Z')
      ? [{ pid: Number(row[1]), ppid: Number(row[2]), start: row[3], text: row[5] }]
      : [];
  });

/**
 * Process rows from two `ps -o pid=,ppid=,lstart=,stat=,command=` listings,
 * one plain and one with -E. The environment is what -E appends after the
 * arguments: patterns are matched against each part separately, so a path in
 * an inherited variable never reads as an argument, nor an argument as the
 * invocation marker.
 */
export function parseRows(argvStdout, envStdout) {
  const environments = new Map(lines(envStdout).map((r) => [`${r.pid} ${r.start}`, r.text]));
  return lines(argvStdout).map(({ pid, ppid, start, text }) => {
    const full = environments.get(`${pid} ${start}`) ?? '';
    const environment = full.startsWith(text) ? full.slice(text.length) : '';
    const mark = new RegExp(`(?:^|\\s)${MARK}=(\\S+)`).exec(environment);
    return { pid, ppid, start, command: text, mark: mark?.[1] };
  });
}

/** Orphaned processes with their descendants: pid → { start, why }. */
export function findOrphans(rows, self = process.pid) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const ancestors = new Set();
  for (let pid = self; pid > 1 && !ancestors.has(pid); pid = byPid.get(pid)?.ppid ?? 0)
    ancestors.add(pid);
  const orphans = new Map();
  const add = (row, why) => {
    if (row.pid > 1 && !ancestors.has(row.pid) && !orphans.has(row.pid))
      orphans.set(row.pid, { start: row.start, why });
  };
  for (const row of rows)
    if (row.ppid === 1 && E2E_DEMO.test(row.command)) add(row, 'e2e demo server of a finished run');
  const marks = new Map();
  for (const row of rows) if (row.mark) marks.set(row.mark, [...(marks.get(row.mark) ?? []), row]);
  for (const [mark, members] of marks) {
    const pids = new Set(members.map((m) => m.pid));
    const roots = members.filter((m) => !pids.has(m.ppid));
    // A live check is the parent of its steps; when every root hangs off
    // init, the check that owned them is gone.
    if (roots.length && roots.every((r) => r.ppid === 1))
      for (const m of members) add(m, `left by check ${mark.slice(0, 8)}`);
  }
  for (let size = -1; size !== orphans.size;) {
    size = orphans.size;
    for (const row of rows) {
      const parent = orphans.get(row.ppid);
      if (parent && byPid.has(row.ppid)) add(row, parent.why);
    }
  }
  return orphans;
}

const snapshot = async () => parseRows(await ps(false), await ps(true));

/**
 * Stop orphans: SIGTERM, then SIGKILL after a grace. Every batch re-reads the
 * process list and signals only a process that is still an orphan there with
 * the same pid and start time. A failing process list stops the sweep without
 * a signal: the check goes on either way.
 */
export async function sweepOrphans({ log = console.error, graceMs = 3000, list = snapshot } = {}) {
  if (list === snapshot && process.platform !== 'darwin') return 0;
  const signal = async (name, chosen) => {
    const current = findOrphans(await list());
    let sent = 0;
    for (const [pid, { start }] of chosen)
      if (current.get(pid)?.start === start)
        try {
          process.kill(pid, name);
          sent++;
        } catch {
          /* Already exited. */
        }
    return sent;
  };
  try {
    const orphans = findOrphans(await list());
    if (!orphans.size) return 0;
    const reasons = new Map();
    for (const { why } of orphans.values()) reasons.set(why, (reasons.get(why) ?? 0) + 1);
    log(
      `orphans: stopping ${orphans.size} process(es) — ${[...reasons].map(([why, n]) => `${n} ${why}`).join('; ')}`,
    );
    await signal('SIGTERM', orphans);
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      await delay(200);
      const left = findOrphans(await list());
      if (![...orphans].some(([pid, { start }]) => left.get(pid)?.start === start))
        return orphans.size;
    }
    await signal('SIGKILL', orphans);
    return orphans.size;
  } catch (error) {
    log(`orphans: process list unavailable, sweep stopped (${error.message})`);
    return 0;
  }
}
