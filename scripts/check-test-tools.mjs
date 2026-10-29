import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';

// This worker starts with the same isolated environment as the test workers.
// No image pull, page navigation, model call or provider credential is needed.
for (const args of [
  ['info', '--format', '{{.ServerVersion}}'],
  ['compose', 'version'],
]) {
  execFileSync('docker', args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 5000,
    killSignal: 'SIGKILL',
  });
}
const browser = await chromium.launch({ headless: true, timeout: 10000 });
try {
  console.log(
    `Isolated test prerequisites: Docker, Compose and Chromium ${browser.version()} are available.`,
  );
} finally {
  await browser.close();
}
