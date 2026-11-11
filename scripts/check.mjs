import { closeSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkProcesses } from './check-processes.mjs';

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
// - smoke-package packs lib/ and dist/ and needs only the build, so it runs
//   beside the Node suite, which keeps its full concurrency
//   (DEVCONTOUR_TEST_CONCURRENCY, default 4). test:e2e runs after both: beside
//   the Node suite (at one file fewer) it was measured to take twice as long,
//   30 instead of 15 minutes, and its server start and full-workflow tests
//   timed out, while the slower Node suite cancelled any gain.
// lint, typecheck and the Docker preflight only read the tree (lint ignores
// lib/ and dist/), so they run beside the build.
//
// Output of concurrent steps: the first stage prefixes every line with its
// step name. Beside the Node suite, which streams unprefixed so its summary
// lines read as in a run of its own, smoke-package's output is held back and
// printed as one section when it ends (passed, failed or stopped). While it
// runs, the same output is written as it arrives to a log file named on its
// start line, so a hung step can be read while it hangs and its output
// survives a check killed outright; the log is removed after the section.
//
// Extra arguments go to the last step (test:affected for --fast: --base, --depth).
const release = [
  [['check:environment'], ['lint'], ['build:lib', 'check:skill', 'build:assets']],
  [['test'], ['smoke-package']],
  [['test:e2e']],
];
// The step that streams unprefixed when it runs beside others.
const live = 'test';
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
const processes = checkProcesses();

/**
 * mode: 'inherit' (alone in its stage), 'prefix' (every line carries the step
 * name), 'live' (piped through unchanged) or 'section' (held back and printed
 * at once when the step ends).
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
    });
    if (!child) return resolve(false);
    // A held-back section keeps stdout and stderr chunks in arrival order.
    const held = [];
    // Exclusive create: the check removes only a log it created itself.
    let log;
    if (mode === 'section') {
      const path = join(tmpdir(), `devcontour-check-${name}-${process.pid}-${started}.log`);
      try {
        log = { path, fd: openSync(path, 'wx') };
        console.error(`${prefix}  ${name} output is held until it ends; meanwhile: ${path}`);
      } catch (error) {
        console.error(`${prefix}  ${name} output is held until it ends (no log: ${error.message})`);
      }
    }
    const flushes = [];
    for (const [stream, out] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      let buffer = '';
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk) => {
        if (mode === 'section') {
          held.push([out, chunk]);
          if (log)
            try {
              writeSync(log.fd, chunk);
            } catch {
              /* The section still prints the output. */
            }
          return;
        }
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
      if (mode === 'section') {
        // One write to one stream, stdout and stderr chunks in arrival order:
        // the section cannot be split by the lines of a step that keeps
        // streaming, nor reordered against them when both streams share a file.
        const output = held.map(([, chunk]) => chunk).join('');
        process.stdout.write(
          `──── ${name} ────\n${output}${output && !output.endsWith('\n') ? '\n' : ''}${result}\n──── end of ${name} ────\n`,
        );
        if (log)
          try {
            closeSync(log.fd);
            unlinkSync(log.path);
          } catch {
            /* A log left behind is harmless. */
          }
      } else console.error(result);
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
      // A step stopped for a cause of the check's own (a failed process
      // snapshot) did not fail by itself; the final line names the cause.
      if (code !== 0 && !processes.cause) failed ??= name;
      void finish(code, signal);
    });
  });
}

const started = Date.now();
for (const chains of stages) {
  const parallel = chains.length > 1;
  const testStage = chains.some((c) => c.includes(live));
  const results = await Promise.all(
    chains.map(async (chain) => {
      for (const name of chain) {
        const mode = !parallel
          ? 'inherit'
          : !testStage
            ? 'prefix'
            : name === live
              ? 'live'
              : 'section';
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
const total = ((Date.now() - started) / 1000).toFixed(1);
// The only authoritative result besides the exit code: summary lines of a
// suite stopped part-way (`ℹ fail 0`, `N passed`) say nothing about the check.
// A stop no step's own exit caused (a process snapshot or spawn failure, or a
// failed cleanup) is named, not left to the first step it happened to stop.
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
console.error(`check${isFast ? ':fast' : ''}: ${outcome}`);
