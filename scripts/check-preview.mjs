import { spawn } from 'node:child_process';

// Use the full registry name: some local image stores resolve it while the
// short-name alias fails and unnecessarily starts a registry/credential lookup.
// Preview is mandatory in a full check. Resolve its external prerequisite
// before compiling and running the long integration suite, not midway through it.
const controller = new AbortController();
const interrupt = () => {
  process.exitCode = 130;
  controller.abort();
};
const terminate = () => {
  process.exitCode = 143;
  controller.abort();
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', terminate);

// Docker can wait for a credential helper that ignores SIGTERM. A synchronous
// exec timeout then keeps waiting. Bound the whole group, including the helper.
function docker(args, timeout = 30000) {
  controller.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let expired = false;
    const kill = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') reject(error);
      }
    };
    const timer = setTimeout(() => {
      expired = true;
      kill();
    }, timeout);
    const cleanup = () => {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', kill);
    };
    controller.signal.addEventListener('abort', kill, { once: true });
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-8192)));
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (code) => {
      cleanup();
      if (!expired && !controller.signal.aborted && code === 0) resolve();
      else
        reject(
          new Error(
            `docker ${args.join(' ')}: ${expired ? `timeout after ${timeout} ms` : `exit ${code}`}\n${stderr.trim()}`,
          ),
        );
    });
  });
}

try {
  await docker(['info', '--format', '{{.ServerVersion}}']);
  for (let attempt = 0; ; attempt++) {
    try {
      // Recheck the cache on retry: another process may have restored the tag.
      try {
        await docker(['image', 'inspect', 'docker.io/library/busybox:1.36']);
      } catch {
        controller.signal.throwIfAborted();
        await docker(['pull', '-q', 'docker.io/library/busybox:1.36'], 120000);
        await docker(['image', 'inspect', 'docker.io/library/busybox:1.36']);
      }
      break;
    } catch (error) {
      if (controller.signal.aborted || attempt === 2) throw error;
    }
  }
  console.log('Preview prerequisites: Docker and busybox:1.36 are available.');
} catch (error) {
  console.error(error.message);
  process.exitCode ||= 1;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', terminate);
}
