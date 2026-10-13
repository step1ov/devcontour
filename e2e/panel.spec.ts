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
  await page.waitForTimeout(9000);
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

test('A board switch that failed is loaded by the next successful poll instead of staying empty', async ({
  page,
}) => {
  await page.goto(base);
  const { board } = await target(page);
  const summary = (await (await page.request.get(`${base}/api/summary`)).json()) as {
    boards: { id: string; title: string; live: boolean; revisions: { status: string }[] }[];
  };
  const other = summary.boards.find(
    (b) =>
      b.title !== board &&
      /· копия \d+$/.test(b.title) &&
      b.live &&
      b.revisions.at(-1)!.status === 'active',
  )!;
  await page.getByRole('tab', { name: 'Список', exact: true }).click();
  await page
    .getByRole('button', { name: new RegExp(board) })
    .filter({ visible: true })
    .first()
    .click();
  await page.route('**/api/summary*', (route) =>
    route.fulfill({ status: 503, json: { error: 'стенд: сервер недоступен' } }),
  );
  await page
    .getByRole('button', { name: new RegExp(other.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
    .filter({ visible: true })
    .first()
    .click();
  await expect(page.getByRole('alert').filter({ hasText: 'Нет связи с сервером' })).toBeVisible();
  await page.unroute('**/api/summary*');
  // Задачи новой доски появляются без повторного клика.
  const own = (await (await page.request.get(`${base}/api/summary?board=${other.id}`)).json()) as {
    board: { revisions: { taskIds: string[] }[] };
    tasks: { id: string; title: string }[];
  };
  const first = own.tasks.find((t) => own.board.revisions.at(-1)!.taskIds.includes(t.id))!;
  await expect(
    page.locator('strong').filter({ hasText: first.title }).filter({ visible: true }).first(),
  ).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Нет связи с сервером' })).toHaveCount(0);
});

test('The dependency picker finds tasks on other boards through server search', async ({
  page,
}) => {
  await page.goto(base);
  const { title, board } = await target(page);
  const summary = (await (await page.request.get(`${base}/api/summary`)).json()) as {
    boards: { title: string; live: boolean; revisions: { status: string }[] }[];
  };
  const other = summary.boards.find(
    (b) => b.title !== board && b.live && b.revisions.at(-1)!.status === 'active',
  )!;
  await page.getByRole('tab', { name: 'Список', exact: true }).click();
  await page
    .getByRole('button', { name: new RegExp(other.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
    .filter({ visible: true })
    .first()
    .click();
  await page.getByRole('button', { name: 'Задача', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Найти задачу для зависимости').fill(title);
  await expect(
    dialog.getByLabel(new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))),
  ).toBeVisible();
});

test('Attempt numbers count the whole history, so they do not change when earlier pages open', async ({
  page,
}) => {
  // Первая страница — две последние из пяти попыток: номера 5 и 4, а не 2 и 1.
  await page.route(`**/api/tasks/${busyTask}?*`, (route) =>
    route.continue({ url: route.request().url().replace('limit=10', 'limit=2') }),
  );
  await page.goto(base);
  await openBusyTask(page);
  const attempts = page.getByRole('region', { name: 'Ход попыток' });
  await expect(attempts.locator('strong').first()).toHaveText('Попытка 5');
  await expect(attempts).not.toContainText('Попытка 1');
  await page.getByRole('button', { name: /Ранние попытки \(3\)/ }).click();
  await expect(attempts.locator('strong').first()).toHaveText('Попытка 5');
  await attempts.locator('summary').click();
  await expect(attempts).toContainText('Попытка 1');
  await expect(attempts.locator('strong').filter({ hasText: 'Попытка 5' })).toHaveCount(1);
});

test('A failed verification snapshot is retried by its own retry, not by reloading the history', async ({
  page,
}) => {
  let fail = true;
  await page.route('**/api/changesets/*', async (route) => {
    if (fail && route.request().url().includes('verification='))
      await route.fulfill({ status: 500, json: { error: 'стенд: отказ снимка' } });
    else await route.continue();
  });
  await page.goto(base);
  await page.getByRole('tab', { name: 'Изменения', exact: true }).click();
  const card = page.locator('article[id^="changeset-"]').first();
  await card.locator('summary', { hasText: 'История проверок' }).click();
  await card
    .getByRole('button', { name: /Снимок задач/ })
    .first()
    .click();
  const alert = card.getByRole('alert');
  await expect(alert).toContainText('Снимок задач не загрузился: стенд: отказ снимка');
  fail = false;
  await alert.getByRole('button', { name: 'Повторить' }).click();
  await expect(card.getByRole('list', { name: /Снимок задач проверки/ })).toBeVisible();
  await expect(alert).toHaveCount(0);
});

test('A late summary response of the same view does not replace a newer one', async ({ page }) => {
  await page.goto(base);
  await page.getByRole('tab', { name: 'Список', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Сейчас работают' })).toBeVisible();
  await page.waitForTimeout(2500);
  const create = (title: string) =>
    page.request.post(`${base}/api/boards`, {
      headers: { 'X-DevContour-Request': '1' },
      data: { title },
    });
  // Первая доска создана; опрос после неё (с прежним номером) получает полную
  // сводку — этот ответ задерживается. Пока он в пути, создаётся вторая доска,
  // и следующий опрос показывает обе.
  let held: (() => Promise<void>) | undefined;
  let armed = false;
  const captured = new Promise<void>((resolve) => {
    void page.route('**/api/summary*', async (route) => {
      if (!armed) return route.continue();
      armed = false;
      const response = await route.fetch();
      held = () => route.fulfill({ response });
      resolve();
    });
  });
  await create('Поздний ответ · первая');
  armed = true;
  await captured;
  await create('Поздний ответ · вторая');
  const second = page.getByRole('button', { name: /Поздний ответ · вторая/ }).filter({
    visible: true,
  });
  await expect(second.first()).toBeVisible();
  await held!();
  // Опоздавший ответ не должен вернуть экран к состоянию без второй доски.
  const samples: number[] = [];
  for (let i = 0; i < 30; i++) {
    samples.push(await second.count());
    await page.waitForTimeout(50);
  }
  expect(samples.every((n) => n > 0)).toBe(true);
});

test('A shortened change set description opens in full on request', async ({ page }) => {
  await page.goto(base);
  await page.getByRole('tab', { name: 'Изменения', exact: true }).click();
  const card = page
    .locator('article[id^="changeset-"]')
    .filter({ hasText: 'Обезличенное длинное' });
  await expect(card).not.toContainText('КОНЕЦ-ОПИСАНИЯ');
  await card.getByRole('button', { name: 'Показать описание полностью' }).click();
  await expect(card).toContainText('КОНЕЦ-ОПИСАНИЯ');
});

test('Review findings beyond the first page load on request', async ({ page }) => {
  await page.goto(base);
  await page.getByRole('tab', { name: 'Ход работ', exact: true }).click();
  const review = page.locator('li').filter({ hasText: 'Обезличенный контракт' }).first();
  await expect(review).toContainText('30 замечаний');
  await expect(review).toContainText('Находка стенда 20');
  await expect(review).not.toContainText('Находка стенда 21');
  await review.getByRole('button', { name: 'Ещё замечания (10)' }).click();
  await expect(review).toContainText('Находка стенда 30');
  await expect(review.getByRole('button', { name: /Ещё замечания/ })).toHaveCount(0);
});

test('A double click on "more findings" loads the page once and keeps every finding reachable', async ({
  page,
}) => {
  // Ответ задерживается: второй клик приходится на ещё идущую загрузку.
  await page.route('**/api/contract-attempts/*/findings*', async (route) => {
    await new Promise((r) => setTimeout(r, 600));
    await route.continue();
  });
  await page.goto(base);
  await page.getByRole('tab', { name: 'Ход работ', exact: true }).click();
  const review = page.locator('li').filter({ hasText: 'Обезличенный контракт' }).first();
  await review.getByRole('button', { name: 'Ещё замечания (10)' }).dblclick();
  await expect(review).toContainText('Находка стенда 30');
  await page.waitForTimeout(1500);
  const texts = await review.locator('li').allTextContents();
  const findings = texts.filter((t) => t.includes('Находка стенда'));
  expect(findings).toHaveLength(30);
  expect(new Set(findings).size).toBe(30);
});
