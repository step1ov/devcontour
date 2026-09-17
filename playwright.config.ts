import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4399',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    env: {
      GIT_AUTHOR_NAME: 'DevContour fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'DevContour fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
    command: `npm run devcontour -- demo --data .harness/e2e-${Date.now()} --port 4399`,
    url: 'http://127.0.0.1:4399/api/state',
    reuseExistingServer: false,
    timeout: 60000,
  },
});
