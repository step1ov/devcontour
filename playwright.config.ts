import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { sharedGuardEnv, writeLiveCliGuard } from './e2e/live-cli-guard.ts';
// Демо-данные — во временном каталоге системы, рабочие деревья попыток —
// рядом с ними (не внутри каталога состояния: такой корень harness
// отклоняет) и не в кэше пользователя. Оба — в одном временном каталоге
// прогона.
const run = join(tmpdir(), `devcontour-e2e-${Date.now()}`);
const data = join(run, 'data');
const checkouts = join(run, 'checkouts');
// Живые `claude` и `codex` под запретом и у общего сервера: заглушки на PATH
// отказывают и отмечают вызов. Воркеры наследуют окружение раннера и находят
// тот же каталог (конфигурация в них вычисляется заново, с другим временем).
process.env[sharedGuardEnv] ??= join(run, 'cli-guard');
const guard = writeLiveCliGuard(process.env[sharedGuardEnv]);
// И у серверов, которые спецификации поднимают в своём процессе: воркеры
// наследуют PATH раннера с заглушками впереди.
if (!process.env.PATH?.startsWith(guard.bin + delimiter))
  process.env.PATH = guard.bin + delimiter + (process.env.PATH ?? '');
const env = {
  PATH: process.env.PATH,
  GIT_AUTHOR_NAME: 'DevContour fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'DevContour fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
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
  webServer: [
    {
      env,
      // Демо-данные — во временном каталоге системы, а не в проекте: каждый
      // прогон оставлял рабочие копии и репозитории в дереве, и IDE
      // переиндексировала их после каждого прогона.
      command: `npm run devcontour -- demo --data ${data} --checkout-root ${checkouts} --port 4399`,
      url: 'http://127.0.0.1:4399/api/state',
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      env,
      // Свой демо-сервер центра внимания: его сценарии запускают очередь, и
      // общий демо-проект после них уже не тот, что ждут другие сценарии.
      command: `npm run devcontour -- demo --data ${join(run, 'attention-data')} --checkout-root ${join(run, 'attention-checkouts')} --port 4389`,
      url: 'http://127.0.0.1:4389/api/state',
      reuseExistingServer: false,
      timeout: 60000,
    },
  ],
});
