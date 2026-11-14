import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Load of the machine a check runs on. The same tests ran up to nine times
// slower inside the check than alone when the machine was swapping and other
// programs held the cores: a check log has to say what load it ran under, and
// a check started on a busy machine waits for it to calm down first.

const cpuTimes = () =>
  cpus().reduce(
    (sum, { times }) => {
      const total = times.user + times.nice + times.sys + times.idle + times.irq;
      return { busy: sum.busy + total - times.idle, total: sum.total + total };
    },
    { busy: 0, total: 0 },
  );

// A hung system tool must not hang the check: these run beside its stages.
const read = (file, args) =>
  execFileSync(file, args, {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

/**
 * Share of memory available to programs, in percent; undefined where unknown.
 * Free swap is not a measure of pressure on macOS: it is the slack inside swap
 * files already allocated and stays low for hours after one spike.
 */
export function memoryAvailablePercent() {
  try {
    if (process.platform === 'darwin') {
      const level = Number(read('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_level']).trim());
      return Number.isFinite(level) && level > 0 ? level : undefined;
    }
    if (process.platform === 'linux') {
      const info = readFileSync('/proc/meminfo', 'utf8');
      const total = /MemTotal:\s+(\d+)/.exec(info);
      const available = /MemAvailable:\s+(\d+)/.exec(info);
      if (!total || !available) return undefined;
      return Math.round((100 * Number(available[1])) / Number(total[1]));
    }
  } catch {
    /* Unknown: the gate does not hold on it. */
  }
  return undefined;
}

/** Pages written to swap since boot; undefined where unknown. */
export function swapOuts() {
  try {
    if (process.platform === 'darwin') {
      const row = /Swapouts:\s+(\d+)/.exec(read('/usr/bin/vm_stat', []));
      return row ? Number(row[1]) : undefined;
    }
    if (process.platform === 'linux') {
      const row = /^pswpout (\d+)$/m.exec(readFileSync('/proc/vmstat', 'utf8'));
      return row ? Number(row[1]) : undefined;
    }
  } catch {
    /* Unknown. */
  }
  return undefined;
}

/**
 * One measurement over `ms`: the busy share of all cores (0..1), pages
 * swapped out per second, memory available, and the load average for
 * reference. The load average alone misleads on macOS: it stays near 30 on an
 * idle ten-core machine whose cores are three-quarters free.
 */
export async function measureLoad(ms = 5000, signal) {
  const cpu0 = cpuTimes();
  const out0 = swapOuts();
  const started = Date.now();
  await delay(ms, undefined, { signal });
  const cpu1 = cpuTimes();
  const out1 = swapOuts();
  const seconds = (Date.now() - started) / 1000;
  const total = cpu1.total - cpu0.total;
  return {
    busy: total > 0 ? (cpu1.busy - cpu0.busy) / total : 0,
    swapOutsPerSecond:
      out0 === undefined || out1 === undefined ? undefined : (out1 - out0) / seconds,
    memoryAvailablePercent: memoryAvailablePercent(),
    load1: loadavg()[0],
    cores: cpus().length,
  };
}

export function describeLoad(m) {
  const parts = [`cpu ${Math.round(m.busy * 100)}% busy of ${m.cores} cores`];
  if (m.swapOutsPerSecond !== undefined)
    parts.push(`swap-out ${Math.round(m.swapOutsPerSecond)} pages/s`);
  if (m.memoryAvailablePercent !== undefined)
    parts.push(`memory ${m.memoryAvailablePercent}% available`);
  parts.push(`load ${m.load1.toFixed(1)}`);
  return parts.join(', ');
}

/** Limits of a quiet machine: below them the check's timings mean something. */
export const QUIET = { maxBusy: 0.5, minMemoryAvailablePercent: 15, maxSwapOutsPerSecond: 50 };

/** Why the machine is not quiet, or undefined when it is. */
export function busyReason(m, limits = QUIET) {
  const reasons = [];
  if (m.busy > limits.maxBusy)
    reasons.push(`cores ${Math.round(m.busy * 100)}% busy (limit ${limits.maxBusy * 100}%)`);
  if (
    m.memoryAvailablePercent !== undefined &&
    m.memoryAvailablePercent < limits.minMemoryAvailablePercent
  )
    reasons.push(
      `memory ${m.memoryAvailablePercent}% available (limit ${limits.minMemoryAvailablePercent}%)`,
    );
  if (m.swapOutsPerSecond !== undefined && m.swapOutsPerSecond > limits.maxSwapOutsPerSecond)
    reasons.push(
      `swapping ${Math.round(m.swapOutsPerSecond)} pages/s (limit ${limits.maxSwapOutsPerSecond})`,
    );
  return reasons.length ? reasons.join(', ') : undefined;
}

/**
 * Wait up to `waitMs` for a quiet machine. It does not refuse: a release can
 * still be checked on a busy machine, and the log says so.
 */
export async function waitForQuiet({
  waitMs,
  log = console.error,
  measure = measureLoad,
  intervalMs = 30_000,
}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    // Without a wait the measurement only goes to the log: a short one.
    const m = await measure(waitMs > 0 ? 5000 : 1000);
    const reason = busyReason(m);
    if (!reason) {
      log(`machine: quiet (${describeLoad(m)})`);
      return { quiet: true, measurement: m };
    }
    if (Date.now() >= deadline) {
      log(
        `machine: busy — ${reason}. The check runs anyway; its timings and timeouts reflect this load. Close the programs that hold it (ps -axo pcpu,rss,comm -r | head).`,
      );
      return { quiet: false, measurement: m };
    }
    log(
      `machine: busy — ${reason}; waiting for it to calm down (until ${new Date(deadline).toISOString().slice(11, 19)}Z)`,
    );
    await delay(intervalMs);
  }
}

/**
 * The git the tests start, when it runs translated: an x86_64-only git on
 * Apple silicon starts in about 32 ms against 3.6 ms for a native one, and one
 * contract-change test starts git 172 times. Returns its path, or undefined.
 */
export function translatedGit(
  path = process.env.PATH ?? '',
  describe = (file) => read('/usr/bin/file', ['-b', file]),
) {
  try {
    if (process.platform !== 'darwin') return undefined;
    if (read('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64']).trim() !== '1') return undefined;
    for (const dir of path.split(delimiter)) {
      const file = dir && join(dir, 'git');
      if (!file || !existsSync(file)) continue;
      const real = realpathSync(file);
      return /\barm64/.test(describe(real)) ? undefined : real;
    }
  } catch {
    /* Unknown: nothing to say. */
  }
  return undefined;
}
