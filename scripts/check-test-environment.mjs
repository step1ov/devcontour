import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkProcesses } from './check-processes.mjs';
import { testEnvironment } from './test-environment.mjs';

// All real Docker/browser cases in preview are in the slow tier. Its remaining
// fast cases use fixtures; an affected selection without preview needs neither.
export const requiresTestTools = (names, fast = false) =>
  !fast && names.includes('preview.test.ts');

/** Check executable tooling after isolation, before starting expensive tests. */
export async function checkTestEnvironment(env, { signal, timeoutMs = 20000 } = {}) {
  signal?.throwIfAborted();
  const processes = checkProcesses();
  const abort = () => {
    void processes.stop('SIGTERM');
  };
  signal?.addEventListener('abort', abort, { once: true });
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void processes.stop('SIGKILL');
  }, timeoutMs);
  try {
    return await new Promise((resolve, reject) => {
      const child = processes.spawn(
        process.execPath,
        [fileURLToPath(new URL('./check-test-tools.mjs', import.meta.url))],
        {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (chunk) => {
          output = (output + chunk).slice(-8192);
        });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0 && !expired && !signal?.aborted) resolve(output.trim());
        else
          reject(
            new Error(
              `Isolated test prerequisites failed${expired ? ` (timeout ${timeoutMs} ms)` : ''}:\n${output.trim()}`,
            ),
          );
      });
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    await processes.dispose();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const isolated = testEnvironment();
  try {
    console.log(await checkTestEnvironment(isolated.env));
  } catch (error) {
    console.error(error.message);
    process.exitCode ||= 1;
  } finally {
    isolated.cleanup();
  }
}
