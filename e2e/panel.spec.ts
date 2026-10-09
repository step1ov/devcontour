import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';

// Панель на большой обезличенной истории: периодически опрашивается только
// ограниченная сводка, детали задачи загружаются по запросу, сбои загрузки
// деталей и опроса видны и восстанавливаются.
const port = 4397;
let server: ChildProcess | undefined;
let base = '';
let busyTask = '';
test.beforeAll(async () => {
  test.setTimeout(240_000);
  server = spawn(
    process.execPath,
    ['--import', 'tsx', 'e2e/fixtures/large-history-server.ts', String(port)],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  [base, busyTask] = await new Promise<[string, string]>((resolve, reject) => {
    let out = '';
    server!.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const ready = /READY (\S+) (\S+)/.exec(out);
      if (ready) resolve([ready[1], ready[2]]);
    });
    server!.on('exit', (code) => reject(new Error('стенд завершился: ' + code)));
  });
});
test.afterAll(async () => {
  if (!server) return;
  const exited = new Promise((r) => server!.once('exit', r));
  server.kill('SIGTERM');
  await exited;
});

/** Доска и заголовок задачи с пятью попытками — из сводки. */
async function target(page: Page) {
  const summary = (await (
    await page.request.get(`${base}/api/summary?task=${busyTask}`)
  ).json()) as {
    tasks: { id: string; title: string; boardId?: string }[];
    boards: { id: string; title: string }[];
  };
  const task = summary.tasks.find((t) => t.id === busyTask)!;
  return { title: task.title, board: summary.boards.find((b) => b.id === task.boardId)!.title };
}
async function openBusyTask(page: Page) {
  const { title, board } = await target(page);
  await page.getByRole('tab', { name: 'Граф', exact: true }).click();
  await page
    .getByRole('button', { name: new RegExp(board) })
    .filter({ visible: true })
    .first()
    .click();
  await page.getByRole('tab', { name: 'Список', exact: true }).click();
  await page.locator('strong', { hasText: title }).filter({ visible: true }).first().click();
}

test('Polling asks only for the bounded summary; unchanged polls are tiny and the full state is never polled', async ({
  page,
}) => {
  const polled: { path: string; bytes: number }[] = [];
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/api/')) return;
    const body = await response.body().catch(() => Buffer.alloc(0));
    polled.push({ path: url.pathname, bytes: body.length });
  });
  await page.goto(base);
  await expect(page.getByRole('region', { name: 'Сейчас работают' })).toBeVisible();
  await page.waitForTimeout(6000);
  expect(polled.some((p) => p.path === '/api/state')).toBe(false);
  const summaries = polled.filter((p) => p.path === '/api/summary');
  expect(summaries.length).toBeGreaterThanOrEqual(3);
  expect(Math.max(...summaries.map((s) => s.bytes))).toBeLessThan(256 * 1024);
  // Когда панель открыта и ничего не меняется, ответы — без тела.
  expect(summaries.slice(-3).every((s) => s.bytes < 1024)).toBe(true);
});

test('A task with a long history opens with its attempts loaded on request', async ({ page }) => {
  await page.goto(base);
  await openBusyTask(page);
  const attempts = page.getByRole('region', { name: 'Ход попыток' });
  await expect(attempts).toContainText('Попытка 5');
  await expect(attempts).toContainText('Попытка 1');
  await expect(attempts).toContainText('не прошла');
});

test('A failed detail load is shown with a retry, and the retry loads the attempts', async ({
  page,
}) => {
  let fail = true;
  await page.route(`**/api/tasks/${busyTask}?*`, async (route) => {
    if (fail) await route.fulfill({ status: 500, json: { error: 'стенд: отказ деталей' } });
    else await route.continue();
  });
  await page.goto(base);
  await openBusyTask(page);
  const alert = page.getByRole('alert').filter({ hasText: 'Детали задачи не загрузились' });
  await expect(alert).toContainText('стенд: отказ деталей');
  fail = false;
  await alert.getByRole('button', { name: 'Повторить' }).click();
  await expect(page.getByRole('region', { name: 'Ход попыток' })).toContainText('Попытка 5');
  await expect(alert).toHaveCount(0);
});

test('A polling failure is visible, keeps the shown state and clears after the next successful poll', async ({
  page,
}) => {
  await page.goto(base);
  await openBusyTask(page);
  await expect(page.getByRole('region', { name: 'Ход попыток' })).toContainText('Попытка 5');
  await page.route('**/api/summary*', (route) =>
    route.fulfill({ status: 503, json: { error: 'стенд: сервер недоступен' } }),
  );
  const alert = page.getByRole('alert').filter({ hasText: 'Нет связи с сервером' });
  await expect(alert).toContainText('стенд: сервер недоступен');
  // Показанное состояние не стёрто.
  await expect(page.getByRole('region', { name: 'Ход попыток' })).toContainText('Попытка 5');
  await page.unroute('**/api/summary*');
  await expect(alert).toHaveCount(0);
});
