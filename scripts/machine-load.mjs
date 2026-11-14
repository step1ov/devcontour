import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
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

/** Free swap in MB; undefined where it cannot be read or there is no swap. */
export function swapFreeMb() {
  try {
    if (process.platform === 'darwin') {
      const text = execFileSync('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' });
      const total = /total = ([\d.,]+)M/.exec(text);
      const free = /free = ([\d.,]+)M/.exec(text);
      if (!total || !free || Number(total[1].replace(',', '.')) === 0) return undefined;
      return Math.round(Number(free[1].replace(',', '.')));
    }
    if (process.platform === 'linux') {
      const info = readFileSync('/proc/meminfo', 'utf8');
      const total = /SwapTotal:\s+(\d+)/.exec(info);
      const free = /SwapFree:\s+(\d+)/.exec(info);
      if (!total || !free || Number(total[1]) === 0) return undefined;
      return Math.round(Number(free[1]) / 1024);
    }
  } catch {
    /* Unknown: the gate does not hold on it. */
  }
  return undefined;
}

/** Pages written to swap since boot (macOS vm_stat); undefined elsewhere. */
function pageouts() {
  if (process.platform !== 'darwin') return undefined;
  try {
    const text = execFileSync('/usr/bin/vm_stat', { encoding: 'utf8' });
    const row = /Pageouts:\s+(\d+)/.exec(text);
    return row ? Number(row[1]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One measurement over `ms`: the busy share of all cores (0..1), swap-outs
 * per second, free swap, and the load average for reference. The load average
 * alone misleads on macOS: it stays near 30 on an idle ten-core machine whose
 * cores are three-quarters free.
 */
export async function measureLoad(ms = 5000) {
  const cpu0 = cpuTimes();
  const out0 = pageouts();
  const started = Date.now();
  await delay(ms);
  const cpu1 = cpuTimes();
  const out1 = pageouts();
  const seconds = (Date.now() - started) / 1000;
  const total = cpu1.total - cpu0.total;
  return {
    busy: total > 0 ? (cpu1.busy - cpu0.busy) / total : 0,
    pageoutsPerSecond:
      out0 === undefined || out1 === undefined ? undefined : (out1 - out0) / seconds,
    swapFreeMb: swapFreeMb(),
    load1: loadavg()[0],
    cores: cpus().length,
  };
}

export function describeLoad(m) {
  const parts = [`cpu ${Math.round(m.busy * 100)}% busy of ${m.cores} cores`];
  if (m.pageoutsPerSecond !== undefined)
    parts.push(`swap-out ${Math.round(m.pageoutsPerSecond)} pages/s`);
  if (m.swapFreeMb !== undefined) parts.push(`swap free ${m.swapFreeMb} MB`);
  parts.push(`load ${m.load1.toFixed(1)}`);
  return parts.join(', ');
}

/** Limits of a quiet machine: below them the check's timings mean something. */
export const QUIET = { maxBusy: 0.5, minSwapFreeMb: 1024, maxPageoutsPerSecond: 50 };

/** Why the machine is not quiet, or undefined when it is. */
export function busyReason(m, limits = QUIET) {
  const reasons = [];
  if (m.busy > limits.maxBusy)
    reasons.push(`cores ${Math.round(m.busy * 100)}% busy (limit ${limits.maxBusy * 100}%)`);
  if (m.swapFreeMb !== undefined && m.swapFreeMb < limits.minSwapFreeMb)
    reasons.push(`swap free ${m.swapFreeMb} MB (limit ${limits.minSwapFreeMb} MB)`);
  if (m.pageoutsPerSecond !== undefined && m.pageoutsPerSecond > limits.maxPageoutsPerSecond)
    reasons.push(
      `swapping ${Math.round(m.pageoutsPerSecond)} pages/s (limit ${limits.maxPageoutsPerSecond})`,
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
} = {}) {
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
        `machine: still busy after ${Math.round(waitMs / 60000)} min — ${reason}. The check runs anyway; its timings and timeouts reflect this load. Close the programs that hold it (ps -axo pcpu,rss,comm -r | head).`,
      );
      return { quiet: false, measurement: m };
    }
    log(
      `machine: busy — ${reason}; waiting for it to calm down (until ${new Date(deadline).toISOString().slice(11, 19)}Z)`,
    );
    await delay(intervalMs);
  }
}
