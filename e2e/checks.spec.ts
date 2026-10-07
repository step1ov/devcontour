import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { spawn, type ChildProcess } from 'node:child_process';

// Карточка договора проверки на обезличенном стенде: задача дважды отказала
// по свойству, корпус больше одной страницы, разбор ждёт ведущего.
const port = 4398;
let server: ChildProcess | undefined;
let base = '';
test.beforeAll(async () => {
  test.setTimeout(180_000);
  server = spawn(
    process.execPath,
    ['--import', 'tsx', 'e2e/fixtures/checks-server.ts', String(port)],
    {
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  base = await new Promise<string>((resolve, reject) => {
    let out = '';
    server!.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const ready = /READY (\S+)/.exec(out);
      if (ready) resolve(ready[1]);
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

async function openTask(page: Page) {
  await page.goto(base + '/');
  await page
    .getByRole('navigation', { name: 'Доски' })
    .getByRole('button', { name: /Рюкзак: договор проверки/ })
    .click();
  await page.getByText('Оптимальный рюкзак').first().click();
  return page.getByRole('region', { name: 'Договор проверки' });
}

test('The check card shows version, coverage, corpus pages, failure history, recovery and who acts', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const card = await openTask(page);
  await expect(card).toContainText('манифест свойств');
  await expect(card).toContainText('knapsack-optimal');
  await expect(card).toContainText(/корпус KS-.* v25/);
  await expect(card).toContainText('подтверждено 25');
  await expect(card.getByTestId('check-next')).toContainText('Сейчас действует: Ведущий');
  await expect(card.getByTestId('check-recovery')).toContainText('ждёт разбора ведущего');
  await expect(card).toContainText(/knapsack-optimal: 2 отказ/);
  await expect(card).toContainText(/попытки 2 из 3/);
  const cases = card
    .getByRole('list', { name: 'Обязательные случаи корпуса' })
    .getByRole('listitem');
  await expect(cases).toHaveCount(10);
  await card.getByRole('button', { name: 'Показать ещё' }).click();
  await expect(cases).toHaveCount(20);
  await card.getByRole('button', { name: 'Показать ещё' }).click();
  await expect(cases).toHaveCount(25);
  await expect(card.getByRole('button', { name: 'Показать ещё' })).toHaveCount(0);
  // Опрашиваемое состояние не несёт входов корпуса.
  const state = await (await page.request.get(base + '/api/state')).text();
  expect(state).not.toContain('"cap":0,"items":[{"v":17,"w":0}]');
  const axe = await new AxeBuilder({ page }).include('[aria-label="Договор проверки"]').analyze();
  expect(axe.violations).toEqual([]);
  expect(errors).toEqual([]);
});

test('The check card reports loading and errors and fits a phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  let fail = true;
  await page.route('**/api/tasks/*/checks**', async (route) => {
    if (fail)
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"error":"стенд недоступен"}',
      });
    await new Promise((r) => setTimeout(r, 800));
    return route.continue();
  });
  const card = await openTask(page);
  await expect(card.getByRole('alert')).toContainText('стенд недоступен');
  fail = false;
  await card.getByRole('button', { name: 'Повторить' }).click();
  await expect(card).toContainText('Загрузка');
  await expect(card).toContainText('подтверждено 25');
  const overflow = await card.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(pageOverflow).toBeLessThanOrEqual(1);
});
