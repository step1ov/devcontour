import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Главный экран автора продукта. Ошибку и длинные тексты подменяем ответом
// API: это проверка вёрстки и поведения экрана, а не живого пилота.

test('Обзор открывается первым, доступен с клавиатуры и на мобильном экране', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Обзор' })).toHaveAttribute('aria-selected', 'true');
  for (const name of ['Попробовать', 'Нужно ваше решение', 'Что изменилось', 'Расходы'])
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  // В demo preview не настроен: экран говорит это прямо, а не показывает пустоту.
  await expect(page.getByText(/Preview не настроен/)).toBeVisible();
  // Технические подробности — по раскрытию, с клавиатуры.
  const details = page.getByText('Подробности работы');
  await details.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Задач: \d+/)).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(errors).toEqual([]);
});

test('Обзор показывает ошибку с повтором и не ломается на длинных текстах', async ({ page }) => {
  let fail = true;
  const long = 'Очень длинное название изменения без пробелов '.repeat(12) + 'x'.repeat(300);
  await page.route('**/api/overview', (route) =>
    fail
      ? route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: '{"error":"Сервер недоступен"}',
        })
      : route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            headline: 'Нужно ваше решение по готовому изменению.',
            tryNow: {
              url: 'http://127.0.0.1:4400',
              changeSetTitle: long,
              release: 'r123456789abc',
              scenario: 'unconfirmed',
            },
            preview: { configured: true, canRollback: true },
            changes: [{ title: long, kind: 'changeset', status: 'verified' }],
            decisions: [
              {
                kind: 'product',
                title: `Принять «${long}»`,
                detail: long,
                action: { type: 'accept-changeset', changeSetId: 'CHG-1' },
                refs: ['CHG-1'],
              },
              {
                kind: 'technical',
                title: 'Автоматическое восстановление остановлено',
                detail: long,
              },
              {
                kind: 'access',
                title: 'Нужен доступ к провайдеру моделей',
                detail: 'Авторизуйте CLI.',
                action: { type: 'resume-queue' },
              },
            ],
            spend: { calls: 3, knownCostUsd: 0.42, unknownCalls: 2, complete: false },
            activity: { running: [], paused: true, doing: 'Выдача остановлена системой' },
            counts: { tasks: 3, done: 1, failed: 1, cancelled: 1 },
          }),
        }),
  );
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Сервер недоступен');
  fail = false;
  await page.getByRole('button', { name: 'Повторить' }).click();
  await expect(page.getByRole('heading', { name: /ваше решение по готовому/ })).toBeVisible();
  // Виды решений различимы, неизвестная стоимость не выдана за итог.
  for (const kind of ['Продуктовый выбор', 'Техническое исправление', 'Нужен внешний доступ'])
    await expect(page.getByText(kind, { exact: true })).toBeVisible();
  await expect(page.getByText(/стоимость неизвестна/)).toBeVisible();
  await expect(page.getByText('Работает, сценарий не подтверждён')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Открыть версию' })).toHaveAttribute(
    'href',
    'http://127.0.0.1:4400',
  );
  // Техническое исправление автору не предлагают выполнить кнопкой.
  const technical = page.getByRole('listitem').filter({ hasText: 'Техническое исправление' });
  await expect(technical.getByRole('button')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
