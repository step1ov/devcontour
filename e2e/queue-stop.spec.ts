import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Баннер остановленной очереди в шапке экрана: причина и подсказка — тем же
// текстом, что в `/api/state`; пока очередь идёт, баннера нет.

test('Баннер называет причину остановки из /api/state', async ({ page, request }) => {
  const { queue } = (await (await request.get('/api/state')).json()) as {
    queue: { paused: boolean; stopReason?: string; action?: string };
  };
  await page.goto('/');
  const banner = page.getByRole('status', { name: 'Очередь остановлена' });
  if (queue.paused) {
    await expect(banner).toContainText(queue.stopReason!);
    if (queue.action) await expect(banner).toContainText(queue.action);
  } else await expect(banner).toHaveCount(0);
});

test('Баннер виден на каждом экране, пока очередь стоит, и исчезает, когда она идёт', async ({
  page,
}) => {
  const stopped = {
    paused: true,
    reason: 'base-check',
    stopReason:
      'Проверка базы не пройдена: test, lint. Исправьте базу и выполните base-update; ' +
      'длинная причина без пробелов '.repeat(4) +
      'x'.repeat(200),
    action: 'Проверьте базу gates и выполните devcontour queue --start',
    since: new Date().toISOString(),
  };
  let queue: object = stopped;
  // Ревизия из запроса убирается, чтобы каждый ответ сводки был полным и
  // подмена применялась.
  await page.route('**/api/summary*', async (route) => {
    const url = new URL(route.request().url());
    url.searchParams.delete('revision');
    const response = await route.fetch({ url: url.toString() });
    const state = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...state, queue } });
  });
  await page.goto('/');
  const banner = page.getByRole('status', { name: 'Очередь остановлена' });
  await expect(banner).toContainText('Проверка базы не пройдена: test, lint');
  await expect(banner).toContainText('Что сделать: ' + stopped.action);
  // Другой экран — тот же баннер.
  await page
    .getByRole('navigation', { name: 'Доски' })
    .getByRole('button', { name: /Каталог продуктов/ })
    .click();
  await expect(banner).toContainText('Проверка базы не пройдена');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  // Длинная причина не растягивает мобильный экран.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(banner).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  // Очередь пошла — баннер пропадает со следующим опросом.
  queue = { paused: false };
  await expect(banner).toHaveCount(0);
});
