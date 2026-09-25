import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Сценарий с двумя полными циклами очереди на незагруженной машине идёт
  // около сорока секунд; под посторонней нагрузкой — заметно дольше.
  // test.slow() умножает именно этот бюджет.
  timeout: 90000,
  reporter: [['list'], ['html', { open: 'never' }]],
  // Панель узнаёт результат опросом состояния, а не мгновенно: стандартные
  // пять секунд на утверждение — это терпение к одному опросу, и под любой
  // нагрузкой состоявшаяся приёмка выглядела ненайденной кнопкой.
  expect: { timeout: 20000 },
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
    // Демо-данные — во временном каталоге системы, а не в проекте: каждый
    // прогон оставлял рабочие копии и репозитории в дереве, и IDE
    // переиндексировала их после каждого прогона.
    command: `npm run devcontour -- demo --data ${join(tmpdir(), `devcontour-e2e-${Date.now()}`)} --port 4399`,
    url: 'http://127.0.0.1:4399/api/state',
    reuseExistingServer: false,
    timeout: 60000,
  },
});
