import { checkProcesses } from './check-processes.mjs';
import { describeLoad, measureLoad, translatedGit, waitForQuiet } from './machine-load.mjs';
import { sweepOrphans } from './orphans.mjs';

// `npm run check` (release) and `npm run check:fast` (one fix).
//
// Each stage is a list of chains; the chains of one stage run concurrently,
// the steps of one chain in order, and the next stage starts after every chain
// of the previous one passed. The first failure stops the check: running steps
// get SIGTERM and nothing new starts.
//
// Release order constraints kept from the sequential form:
// - check:skill reads lib/ and refuses a build older than src/, so it follows
//   build:lib; it compares the tracked skill reference *before* build:assets
//   regenerates it, so a stale reference cannot be hidden by the generator.
// - The Node suite runs alone, at its full concurrency
//   (DEVCONTOUR_TEST_CONCURRENCY, default 4).
// - smoke-package packs lib/ and dist/ and needs only the build, but runs
//   after the Node suite, not beside it: on macOS beside the suite the freshly
//   installed package's first `devcontour help` hung for over 90 s at
//   _dyld_start (measured 2026-11-17) — the executables the suite creates
//   flood the system's exec assessment queue — while alone it passes.
// - test:e2e runs last, alone: beside the Node suite (at one file fewer) it
//   was measured to take twice as long, 30 instead of 15 minutes, and its
//   server start and full-workflow tests timed out, while the slower Node
//   suite cancelled any gain.
// lint, typecheck and the Docker preflight only read the tree (lint ignores
// lib/ and dist/), so they run beside the build.
//
// Output of concurrent steps: in a stage of several chains (the first stage
// of either check) every line carries its step name. A step alone in its
// stage inherits the check's stdio, so the Node suite's summary lines read as
// in a run of its own.
//
// Extra arguments go to the last step (test:affected for --fast: --base, --depth).
const release = [
  [['check:environment'], ['lint'], ['build:lib', 'check:skill', 'build:assets']],
  [['test']],
  [['smoke-package']],
  [['test:e2e']],
];
// Steps that start the CLI from lib/ instead of src/ through tsx
// (tests/cli-command.ts): build:lib ran in an earlier stage of the release
// check, and the built CLI starts about 0.17 s sooner on each of the suite's
// hundreds of CLI runs. check:fast does not build, so its tests keep tsx.
const builtCli = new Set(['test']);
const fast = [[['lint'], ['typecheck']], [['test:affected']]];

const args = process.argv.slice(2);
const isFast = args[0] === '--fast';
const extra = isFast ? args.slice(1) : args;
if (!isFast && extra.length) throw new Error('npm run check takes no arguments');
const stages = isFast ? fast : release;
const last = isFast ? stages.at(-1).at(-1).at(-1) : undefined;
// scripts/test.mjs reads it; a bad value fails here, before the build.
const configured = process.env.DEVCONTOUR_TEST_CONCURRENCY;
if (configured !== undefined && configured !== '') {
  const value = Number(configured);
  if (!(Number.isInteger(value) && value >= 1))
    throw new Error(`DEVCONTOUR_TEST_CONCURRENCY must be a positive integer, got ${configured}`);
}
// A step that exited may leave a descendant holding its output pipes; the
// check waits this long for the pipes to close, then stops reading them.
const CLOSE_GRACE_MS = 3000;
/** The step whose own failure stopped the check (not one stopped after it). */
let failed;

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const commands = {
  'smoke-package': [process.execPath, ['scripts/smoke-package.mjs']],
};
// The machine first. Processes left by a check or e2e run killed outright are
// stopped (scripts/orphans.mjs). A release check then waits for a quiet
// machine, up to DEVCONTOUR_CHECK_QUIET_WAIT_MIN minutes (default 10, 0 = no
// wait): under swapping and busy cores the same tests ran up to nine times
// slower than alone and timed out. While the check runs, a line every five
// minutes and a summary at the end say what load it ran under.
// DEVCONTOUR_CHECK_SWEEP=0 leaves other processes alone (the check's own tests
// run checks side by side).
// Until the stages start there is nothing of the check's own to clean up: an
// interrupt only names itself.
const interruptedEarly = (signal) => {
  console.error(`check${isFast ? ':fast' : ''}: interrupted before any step (${signal})`);
  process.exit(signal === 'SIGINT' ? 130 : 143);
};
process.once('SIGINT', interruptedEarly);
process.once('SIGTERM', interruptedEarly);
if (process.env.DEVCONTOUR_CHECK_SWEEP !== '0') await sweepOrphans();
const waitSetting = process.env.DEVCONTOUR_CHECK_QUIET_WAIT_MIN;
const waitMinutes =
  waitSetting === undefined || waitSetting === '' ? (isFast ? 0 : 10) : Number(waitSetting);
if (!(Number.isFinite(waitMinutes) && waitMinutes >= 0))
  throw new Error(
    `DEVCONTOUR_CHECK_QUIET_WAIT_MIN must be a number of minutes, got ${waitSetting}`,
  );
const loads = [(await waitForQuiet({ waitMs: waitMinutes * 60_000 })).measurement];
const slowGit = translatedGit();
if (slowGit)
  console.error(
    `machine: git ${slowGit} has no arm64 code and runs under Rosetta: every git call starts about nine times slower, and the tests make thousands. Put a native git first in PATH (/Library/Developer/CommandLineTools/usr/bin/git or Homebrew).`,
  );
process.removeListener('SIGINT', interruptedEarly);
process.removeListener('SIGTERM', interruptedEarly);
// A sample still running when the check ends is cancelled, so no load line
// follows the outcome line and the process does not linger.
const sampling = new AbortController();
let measuring;
const sampler = setInterval(() => {
  if (measuring) return;
  measuring = measureLoad(5000, sampling.signal)
    .then((m) => {
      loads.push(m);
      if (loads.length % 5 === 1) console.error(`machine: ${describeLoad(m)}`);
    })
    .catch(() => {})
    .finally(() => (measuring = undefined));
}, 60_000);
sampler.unref();

const processes = checkProcesses();

/**
 * mode: 'inherit' (alone in its stage) or 'prefix' (beside others: every line
 * carries the step name).
 */
function step(name, rest, mode) {
  const [command, base] = commands[name] ?? [npm, ['run', '--silent', name]];
  const argv = [...base, ...(rest.length ? (commands[name] ? rest : ['--', ...rest]) : [])];
  const prefix = mode === 'prefix' ? `[${name}] ` : '';
  return new Promise((resolve) => {
    if (processes.stopping) return resolve(false);
    const started = Date.now();
    console.error(`${prefix}▶ ${name}`);
    const child = processes.spawn(command, argv, {
      cwd: new URL('../', import.meta.url),
      stdio: mode === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      ...(builtCli.has(name) ? { env: { ...process.env, DEVCONTOUR_TEST_CLI: 'lib' } } : {}),
    });
    if (!child) return resolve(false);
    const flushes = [];
    for (const [stream, out] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      let buffer = '';
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk) => {
        const lines = (buffer + chunk).split('\n');
        buffer = lines.pop();
        for (const line of lines) out.write(prefix + line + '\n');
      });
      const flush = () => {
        if (buffer) out.write(prefix + buffer + '\n');
        buffer = '';
      };
      stream?.on('end', flush);
      flushes.push(flush);
    }
    const closed = new Promise((done) => child.once('close', done));
    // The result is the step's own exit. Its output is complete when the pipes
    // close; a descendant that keeps them open after the exit must not hang
    // the check: past the grace the pipes are dropped, and the descendant
    // (marked like every check process) is stopped by the sweep at the end of
    // the check — a sweep now would also stop sibling steps.
    const finish = async (code, signal, error) => {
      const ok = code === 0;
      let timer;
      const open = await Promise.race([
        closed.then(() => false),
        new Promise((done) => (timer = setTimeout(() => done(true), CLOSE_GRACE_MS))),
      ]);
      clearTimeout(timer);
      if (open) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        for (const flush of flushes) flush();
      }
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const leak = open
        ? ' (a descendant kept its output open; stopped at the end of the check)'
        : '';
      const result = `${prefix}${ok ? '✔' : '✖'} ${name} ${seconds}s${ok ? '' : ` (${error ?? signal ?? code})`}${leak}`;
      console.error(result);
      resolve(ok);
    };
    // A step settles once: on its exit, or on an error that means it never ran
    // (a spawn failure may emit no exit at all).
    let settled = false;
    child.once('error', (error) => {
      console.error(`${prefix}${error.message}`);
      if (settled) return;
      settled = true;
      failed ??= name;
      void finish(undefined, undefined, error.code ?? 'error');
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      // A step stopped for a cause of the check's own (a failed spawn or
      // cleanup) did not fail by itself; the final line names the cause. An
      // unavailable process snapshot is only a warning and stops nothing.
      if (code !== 0 && !processes.cause) failed ??= name;
      void finish(code, signal);
    });
  });
}

const started = Date.now();
for (const chains of stages) {
  const mode = chains.length > 1 ? 'prefix' : 'inherit';
  const results = await Promise.all(
    chains.map(async (chain) => {
      for (const name of chain) {
        if (!(await step(name, name === last ? extra : [], mode))) {
          processes.stop('SIGTERM');
          return false;
        }
      }
      return true;
    }),
  );
  if (!results.every(Boolean)) {
    process.exitCode ||= 1;
    break;
  }
}
await processes.dispose();
clearInterval(sampler);
sampling.abort();
await measuring;
{
  const busy = loads.map((m) => m.busy);
  const out = loads.map((m) => m.swapOutsPerSecond).filter((v) => v !== undefined);
  const memory = loads.map((m) => m.memoryAvailablePercent).filter((v) => v !== undefined);
  const parts = [
    `cpu ${Math.round((100 * busy.reduce((a, b) => a + b, 0)) / busy.length)}% busy on average, ${Math.round(100 * Math.max(...busy))}% at most`,
  ];
  if (out.length) parts.push(`swap-out up to ${Math.round(Math.max(...out))} pages/s`);
  if (memory.length) parts.push(`memory available down to ${Math.min(...memory)}%`);
  console.error(`machine during the check (${loads.length} samples): ${parts.join(', ')}`);
}
const total = ((Date.now() - started) / 1000).toFixed(1);
// The only authoritative result besides the exit code: summary lines of a
// suite stopped part-way (`ℹ fail 0`, `N passed`) say nothing about the check.
// A stop no step's own exit caused (a spawn failure or a failed cleanup) is
// named, not left to the first step it happened to stop.
const cause = processes.cause;
const outcome = !process.exitCode
  ? `passed in ${total}s`
  : `${
      process.exitCode === 130 || process.exitCode === 143
        ? 'interrupted'
        : failed
          ? `failed in ${failed}${cause ? `: ${cause}` : ''}`
          : cause
            ? `failed: ${cause}`
            : 'failed'
    } (${total}s)`;
// Without ps at the end no leaked descendant was looked for: say so, as a
// note rather than a failure.
const leakNote = processes.leakCheckSkipped
  ? '; process leak check not performed (ps unavailable)'
  : '';
console.error(`check${isFast ? ':fast' : ''}: ${outcome}${leakNote}`);
