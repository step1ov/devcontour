import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('Plan → parallel execution → acceptance → correction → acceptance preserves prior revision', async ({
  page,
  request,
}) => {
  // Two full queue cycles run here: the default 60s budget leaves no margin and
  // any load on the machine turns a real pass into a timeout. test.slow()
  // stretches the test's own budget but not the waits inside it, and a full
  // demo cycle takes around forty seconds on an idle machine — so a fixed 45s
  // wait reported a working queue as broken whenever anything else was running.
  // The assertion is unchanged: the board still has to become acceptable.
  test.slow();
  const cycle = { timeout: 150_000 };
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Каталог продуктов', exact: true })).toBeVisible();
  await expect(page.getByText('Учебный режим · без вызовов моделей')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Что нужно для продолжения' })).toContainText(
    'Очередь на паузе',
  );
  await page.getByRole('button', { name: 'Запустить очередь' }).click();
  await expect(page.getByRole('button', { name: 'Принять доску' })).toBeVisible(cycle);
  await page.getByRole('button', { name: 'Принять доску' }).click();
  await expect(page.getByRole('button', { name: 'Создать корректировку' })).toBeVisible();
  const before = await (await request.get('/api/state')).json();
  const board = before.boards.find((b: any) => b.title === 'Каталог продуктов');
  const digest = board.revisions[0].snapshot.digest;
  await page.getByRole('button', { name: 'Создать корректировку' }).click();
  // Scope to the dialog: the graph node behind it carries the same task title
  // in its accessible label, and getByLabel does not filter aria-hidden.
  await page
    .getByRole('dialog')
    .getByLabel(/Зафиксировать API и состояния/)
    .check();
  await expect(page.getByText('Затронуто задач: 5')).toBeVisible();
  await page
    .getByLabel('Что и почему меняем')
    .fill('Добавить поиск по архивным продуктам и повторить приёмку.');
  await page.getByRole('button', { name: 'Создать ревизию 2' }).click();
  await expect(page.getByText('r2', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Утвердить план' })).toBeVisible();
  await page.getByRole('button', { name: 'Утвердить план' }).click();
  await expect(page.getByRole('button', { name: 'Принять доску' })).toBeVisible(cycle);
  await page.getByRole('button', { name: 'Принять доску' }).click();
  // Acceptance is confirmed by the correction action appearing; reading the API
  // before that races the click.
  await expect(page.getByRole('button', { name: 'Создать корректировку' })).toBeVisible();
  await page.getByRole('tab', { name: 'Ревизии', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Открыть ревизию 1' })).toBeVisible();
  const after = await (await request.get('/api/state')).json();
  const revised = after.boards.find((b: any) => b.id === board.id);
  expect(revised.revisions).toHaveLength(2);
  expect(revised.revisions[0].snapshot.digest).toBe(digest);
  expect(revised.revisions[1].status).toBe('accepted');
  expect(errors).toEqual([]);
});
test('Operator can create a board, tasks and dependency; invalid cycle is explained', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Создать доску', exact: true }).click();
  await page.getByLabel('Название', { exact: true }).fill('Проверка зависимостей');
  await page
    .getByLabel('Цель', { exact: true })
    .fill('Проверить ручное планирование через интерфейс.');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Создать доску', exact: true })
    .click();
  for (const title of ['Контракт сервиса', 'Экран сервиса']) {
    await page.getByRole('button', { name: 'Задача', exact: true }).click();
    await page.getByLabel('Название', { exact: true }).fill(title);
    await page
      .getByLabel('Описание результата')
      .fill('Создать наблюдаемый результат для проверки планирования.');
    await page.getByLabel('Критерии приёмки').fill('Результат проходит независимую проверку.');
    if (title === 'Экран сервиса')
      await page
        .getByRole('dialog')
        .getByLabel(/Контракт сервиса/)
        .check();
    await page.getByRole('button', { name: 'Сохранить черновик' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await page.getByRole('tab', { name: 'Список', exact: true }).click();
  await page.getByRole('button', { name: /Контракт сервиса.*Черновик/ }).click();
  await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel(/Экран сервиса/)
    .check();
  await page.getByRole('button', { name: 'Сохранить черновик' }).click();
  await expect(page.getByRole('alert')).toContainText('Цикл зависимостей');
  await page.getByRole('button', { name: 'Закрыть диалог' }).click();
});
test('Desktop and mobile views are accessible and do not overflow', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Доски' })
    .getByRole('button', { name: /Каталог продуктов/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Каталог продуктов', exact: true })).toBeVisible();
  const desktop = await new AxeBuilder({ page }).analyze();
  expect(desktop.violations).toEqual([]);
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: 'Список', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const mobile = await new AxeBuilder({ page }).analyze();
  expect(mobile.violations).toEqual([]);
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
});
test('Local API rejects foreign origins and malformed changes', async ({ request }) => {
  const foreign = await request.post('/api/boards', {
    headers: { Origin: 'https://attacker.example', 'X-DevContour-Request': '1' },
    data: { title: 'Injected board' },
  });
  expect(foreign.status()).toBe(403);
  const noHeader = await request.post('/api/boards', { data: { title: 'Injected board' } });
  expect(noHeader.status()).toBe(403);
  const malformed = await request.post('/api/boards', {
    headers: { 'X-DevContour-Request': '1' },
    data: { title: 'x' },
  });
  expect(malformed.status()).toBe(400);
  const arbitrary = await request.post('/api/evidence', {
    headers: { 'X-DevContour-Request': '1' },
    data: { passed: true },
  });
  expect(arbitrary.status()).toBe(404);
});
