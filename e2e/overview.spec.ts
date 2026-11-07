import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Главный экран автора продукта. Ошибку и длинные тексты подменяем ответом
// API: это проверка вёрстки и поведения экрана, а не живого пилота.

test('Обзор открывается первым, доступен с клавиатуры и на мобильном экране', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(
    page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Обзор' }),
  ).toHaveAttribute('aria-current', 'page');
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
            headline: 'Проверенную версию можно попробовать.',
            tryNow: {
              url: 'http://127.0.0.1:4400',
              changeSetTitle: long,
              release: 'r123456789abc',
              scenario: 'unconfirmed',
            },
            preview: { configured: true, canRollback: true },
            changes: [{ title: long, kind: 'changeset', status: 'verified' }],
            spend: { calls: 3, knownCostUsd: 0.42, unknownCalls: 2, complete: false },
            activity: { running: [], paused: true, doing: 'Выдача остановлена системой' },
            counts: { tasks: 3, done: 1, failed: 1, cancelled: 1 },
          }),
        }),
  );
  // Решения — карточки центра внимания: тот же ответ, что у экрана внимания.
  const item = (key: string, over: Record<string, unknown>) => ({
    id: `${key}#o1`,
    sourceKey: key,
    occurrenceId: 'o1',
    sourceVersion: 'v1',
    reason: long,
    impact: { tasks: 0, waiting: 0, boards: [], taskIds: [] },
    since: '2026-11-07T10:00:00.000Z',
    evidence: [],
    state: { read: false, acknowledged: false, unread: true },
    ...over,
  });
  await page.route(
    (url) => url.pathname === '/api/attention',
    (route) =>
      route.fulfill({
        json: {
          revision: 1,
          generatedAt: new Date().toISOString(),
          engineConnected: true,
          lead: { present: true, lastActivityAt: null },
          counts: {
            active: 3,
            unread: 2,
            byActor: { operator: { active: 2, unread: 2 }, lead: { active: 1, unread: 0 } },
          },
          items: [
            item('queue', {
              source: 'queue',
              category: 'access',
              actor: 'operator',
              title: 'Выдача остановлена: нужен доступ',
              subject: { kind: 'queue', id: 'queue', href: '/' },
              actions: [
                { id: 'resume', kind: 'domain', label: 'Запустить очередь', input: 'confirm' },
              ],
            }),
            item('changeset:CHG-1', {
              source: 'changeset',
              category: 'decision',
              actor: 'operator',
              title: `Примите «${long}»`,
              subject: {
                kind: 'changeset',
                id: 'CHG-1',
                href: '/?view=boards&tab=changesets#changeset-CHG-1',
              },
              actions: [{ id: 'accept', kind: 'domain', label: 'Принять', input: 'confirm' }],
            }),
            item('workflow:changeset:CHG-1', {
              source: 'board',
              category: 'technical',
              actor: 'lead',
              title: 'Автоматическое восстановление ChangeSet остановлено',
              subject: { kind: 'changeset', id: 'CHG-1', href: '/?view=boards&tab=changesets' },
              actions: [{ id: 'handoff', kind: 'handoff', command: 'session_handoff' }],
            }),
          ],
        },
      }),
  );
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Сервер недоступен');
  fail = false;
  await page.getByRole('button', { name: 'Повторить' }).click();
  // Заголовок дополнен центром внимания: доступ — первым.
  await expect(
    page.getByRole('heading', { name: /нужен внешний доступ или бюджет/ }),
  ).toBeVisible();
  // Виды решений различимы, неизвестная стоимость не выдана за итог.
  const decisions = page.getByRole('list', { name: 'Решения для вас' });
  for (const kind of ['Ваше решение', 'Нужен доступ'])
    await expect(decisions.getByText(kind, { exact: true })).toBeVisible();
  await expect(page.getByText(/стоимость неизвестна/)).toBeVisible();
  await expect(page.getByText('Работает, сценарий не подтверждён')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Открыть версию' })).toHaveAttribute(
    'href',
    'http://127.0.0.1:4400',
  );
  // Карточка ведущего агента не выдаётся за решение автора: только число и ссылка.
  await expect(decisions.locator('[data-attention-key="workflow:changeset:CHG-1"]')).toHaveCount(0);
  await expect(decisions.getByText(/Ведущий агент/)).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'Ведущий агент разбирает технических вопросов: 1' }),
  ).toHaveAttribute('href', /tab=attention&who=lead/);
  await expect(page.getByRole('link', { name: 'Все действия (2)' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
