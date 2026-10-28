import { spawn } from 'node:child_process';

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
// - smoke-package packs lib/ and dist/; the Node and browser suites run last,
//   one after the other, as the heaviest steps that must not compete.
// lint, typecheck and the Docker preflight only read the tree (lint ignores
// lib/ and dist/), so they run beside the build.
//
// Extra arguments go to the last step (test:affected for --fast: --base, --depth).
const release = [
  [['check:environment'], ['lint'], ['build:lib', 'check:skill', 'build:assets']],
  [['smoke-package']],
  [['test']],
  [['test:e2e']],
];
const fast = [[['lint'], ['typecheck']], [['test:affected']]];

const args = process.argv.slice(2);
const isFast = args[0] === '--fast';
const extra = isFast ? args.slice(1) : args;
if (!isFast && extra.length) throw new Error('npm run check takes no arguments');
const stages = isFast ? fast : release;
const last = stages.at(-1).at(-1).at(-1);

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const commands = {
  'smoke-package': [process.execPath, ['scripts/smoke-package.mjs']],
};
const running = new Set();
const isGroup = new WeakSet();
let stopping = false;

function step(name, rest, prefix) {
  const [command, base] = commands[name] ?? [npm, ['run', '--silent', name]];
  const argv = [...base, ...(rest.length ? (commands[name] ? rest : ['--', ...rest]) : [])];
  return new Promise((resolve) => {
    if (stopping) return resolve(false);
    const started = Date.now();
    console.error(`${prefix}▶ ${name}`);
    const child = spawn(command, argv, {
      cwd: new URL('../', import.meta.url),
      stdio: prefix ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      // A concurrent step gets its own process group, so a stop after a
      // sibling failed reaches npm's children, not only npm. A step running
      // alone stays in the terminal's group and gets Ctrl-C directly.
      detached: !!prefix && process.platform !== 'win32',
    });
    running.add(child);
    if (prefix && process.platform !== 'win32') isGroup.add(child);
    // Concurrent steps: each line carries its step name.
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
      stream?.on('end', () => buffer && out.write(prefix + buffer + '\n'));
    }
    child.on('close', (code, signal) => {
      running.delete(child);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const ok = code === 0;
      console.error(
        `${prefix}${ok ? '✔' : '✖'} ${name} ${seconds}s${ok ? '' : ` (${signal ?? code})`}`,
      );
      resolve(ok);
    });
  });
}

const stop = (signal) => {
  stopping = true;
  for (const child of running)
    try {
      if (isGroup.has(child)) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // Already gone.
    }
};
process.once('SIGINT', () => ((process.exitCode = 130), stop('SIGINT')));
process.once('SIGTERM', () => ((process.exitCode = 143), stop('SIGTERM')));

const started = Date.now();
for (const chains of stages) {
  const parallel = chains.length > 1;
  const results = await Promise.all(
    chains.map(async (chain) => {
      for (const name of chain) {
        const prefix = parallel ? `[${name}] ` : '';
        if (!(await step(name, name === last ? extra : [], prefix))) {
          stop('SIGTERM');
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
const total = ((Date.now() - started) / 1000).toFixed(1);
console.error(
  `check${isFast ? ':fast' : ''}: ${process.exitCode ? 'FAILED' : 'passed'} in ${total}s`,
);
