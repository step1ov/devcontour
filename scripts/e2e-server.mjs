import { spawn } from 'node:child_process';

// node scripts/e2e-server.mjs <runner pid> -- <command...>
//
// Runs an e2e web server for the Playwright runner and stops it when the
// runner is gone. Playwright stops its servers on an orderly exit, but a runner
// killed outright (SIGKILL, a bounded launcher's timeout, a closed terminal)
// left both demo servers running for hours. The server stays in this process
// group, which Playwright signals as a whole on teardown.

const [runner, separator, command, ...args] = process.argv.slice(2);
if (!/^\d+$/.test(runner ?? '') || separator !== '--' || !command)
  throw new Error('usage: node scripts/e2e-server.mjs <runner pid> -- <command...>');

const child = spawn(command, args, { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.once('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
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
  if (alive(Number(runner))) return;
  console.error(`e2e-server: runner ${runner} exited; stopping the server`);
  // The whole group: the npm wrapper and the server under it.
  try {
    process.kill(0, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  setTimeout(() => child.kill('SIGKILL'), 5000).unref();
}, 2000).unref();
