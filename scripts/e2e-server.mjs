import { execFileSync, spawn } from 'node:child_process';

// node scripts/e2e-server.mjs <runner pid> -- <command...>
//
// Runs an e2e web server for the Playwright runner and stops it when the
// runner is gone. Playwright stops its servers on an orderly exit, but a runner
// killed outright (SIGKILL, a bounded launcher's timeout, a closed terminal)
// left both demo servers running for hours. The server stays in this process
// group, which Playwright starts for it and signals as a whole on teardown.

const [runner, separator, command, ...args] = process.argv.slice(2);
if (!/^\d+$/.test(runner ?? '') || separator !== '--' || !command)
  throw new Error('usage: node scripts/e2e-server.mjs <runner pid> -- <command...>');

const group = (pid) => {
  try {
    return (
      execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 5000,
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
};
// The group is the server's own only when it is led by this process or the
// shell that started it (as under Playwright) and the runner is outside it.
// When either group is unknown, or started by hand in the runner's group,
// only the child is signalled: never the group of whoever started this.
const ownGroup = (() => {
  if (process.platform === 'win32') return false;
  const own = group(process.pid);
  const theirs = group(Number(runner));
  return (
    own !== undefined &&
    theirs !== undefined &&
    own !== theirs &&
    (Number(own) === process.pid || Number(own) === process.ppid)
  );
})();

const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
let stopping = false;
const stop = (signal) => {
  if (ownGroup)
    try {
      // The whole group: the npm wrapper, the server under it, and this process.
      process.kill(0, signal);
      return;
    } catch {
      /* Fall back to the child. */
    }
  child.kill(signal);
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(signal, () => (stopping ? undefined : child.kill(signal)));
child.once('exit', (code, signal) => {
  // npm may exit before the server under it: what is left of the group goes.
  if (stopping) stop('SIGKILL');
  process.exit(code ?? (signal ? 1 : 0));
});
child.once('error', (error) => {
  console.error(error.message);
  process.exit(1);
});

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
setInterval(() => {
  if (stopping || alive(Number(runner))) return;
  stopping = true;
  console.error(`e2e-server: runner ${runner} exited; stopping the server`);
  stop('SIGTERM');
  setTimeout(() => stop('SIGKILL'), 5000).unref();
}, 2000).unref();
