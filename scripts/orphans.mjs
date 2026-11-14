import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// Processes left behind by an earlier check or e2e run that was killed
// outright. They keep servers, git and fixture work going for hours and slow
// every later run: two e2e demo servers were found alive 17 hours after their
// run. The sweep before a check stops only what provably has no owner left:
// - an e2e demo server (its command names a devcontour-e2e-<time> run
//   directory) whose parent has exited: while its run lives, the parent chain
//   leads to the Playwright runner, never to init;
// - every process of a check invocation (DEVCONTOUR_CHECK_INVOCATION, see
//   check-processes.mjs) none of whose roots has a live parent: the check
//   process itself is the parent of its steps, so a running check always has
//   one.
// Descendants of either go with them.

const MARK = 'DEVCONTOUR_CHECK_INVOCATION';
const E2E_DEMO = /\bdemo --data \S*devcontour-e2e-\d+[/\\]/;

const ps = () =>
  new Promise((resolve, reject) =>
    execFile(
      '/bin/ps',
      ['-Eww', '-ax', '-o', 'pid=,ppid=,lstart=,stat=,command='],
      {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
        timeout: 15_000,
        maxBuffer: 64_000_000,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );

/** Rows of `ps -Eww -o pid=,ppid=,lstart=,stat=,command=` (command includes the environment). */
export function parseRows(stdout) {
  return stdout.split('\n').flatMap((line) => {
    const row = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!row || row[4].startsWith('Z')) return [];
    const mark = new RegExp(`(?:^|\\s)${MARK}=(\\S+)`).exec(row[5]);
    return [
      {
        pid: Number(row[1]),
        ppid: Number(row[2]),
        start: row[3],
        command: row[5],
        mark: mark?.[1],
      },
    ];
  });
}

/** Orphaned processes with their descendants: pid → { start, why }. */
export function findOrphans(rows, self = process.pid) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const orphans = new Map();
  const add = (row, why) => {
    if (row.pid !== self && row.pid > 1 && !orphans.has(row.pid))
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

/**
 * Stop orphans: SIGTERM, then SIGKILL after a grace. Each signal goes only to
 * a process still found with the same pid and start time in a fresh snapshot.
 */
export async function sweepOrphans({ log = console.error, graceMs = 3000 } = {}) {
  let rows;
  try {
    rows = parseRows(await ps());
  } catch (error) {
    log(`orphans: process list unavailable, nothing swept (${error.message})`);
    return 0;
  }
  const orphans = findOrphans(rows);
  if (!orphans.size) return 0;
  const reasons = new Map();
  for (const { why } of orphans.values()) reasons.set(why, (reasons.get(why) ?? 0) + 1);
  log(
    `orphans: stopping ${orphans.size} process(es) — ${[...reasons].map(([why, n]) => `${n} ${why}`).join('; ')}`,
  );
  const signal = (name, current) => {
    const live = new Map(current.map((r) => [r.pid, r.start]));
    let sent = 0;
    for (const [pid, { start }] of orphans)
      if (live.get(pid) === start)
        try {
          process.kill(pid, name);
          sent++;
        } catch {
          /* Already exited. */
        }
    return sent;
  };
  signal('SIGTERM', rows);
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await delay(200);
    const current = parseRows(await ps());
    const left = current.filter((r) => orphans.get(r.pid)?.start === r.start);
    if (!left.length) return orphans.size;
    if (Date.now() >= deadline) break;
  }
  signal('SIGKILL', parseRows(await ps()));
  return orphans.size;
}
