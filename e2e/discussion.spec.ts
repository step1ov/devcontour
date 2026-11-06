import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Обсуждение в карточке задачи: заметка и обращение к ведущему, один запрос
// на одно составленное сообщение, конфликт версии без потери текста, текст
// вместо разметки и узкий экран.

const headers = { 'X-DevContour-Request': '1' };
const conflict = 'Обсуждение изменилось — проверьте новые сообщения и отправьте снова';

/** Своя доска и задача: демо общее, другие спецификации меняют его доски. */
async function taskOn(request: APIRequestContext, title: string) {
  const board = (await (
    await request.post('/api/boards', { headers, data: { title: 'Обсуждение: ' + title } })
  ).json()) as { id: string };
  const task = (await (
    await request.post(`/api/boards/${board.id}/tasks`, {
      headers,
      data: {
        title,
        description: 'Наблюдаемый результат для проверки обсуждения.',
        role: 'backend',
        repositoryId: 'main',
        acceptance: ['Результат проходит независимую проверку.'],
        dependsOn: [],
        contracts: [],
      },
    })
  ).json()) as { id: string };
  return { board: board.id, task: task.id };
}
async function thread(request: APIRequestContext, taskId: string) {
  const page = (await (await request.get(`/api/tasks/${taskId}/discussion?limit=50`)).json()) as {
    messages: { text: string; kind: string; author: string; supersedes?: string }[];
    storage: string;
  };
  return page;
}
async function open(page: Page, ids: { board: string; task: string }) {
  await page.goto(`/?tab=list&board=${ids.board}&task=${ids.task}`);
  const region = page.getByRole('region', { name: 'Обсуждение' });
  await expect(region).toBeVisible();
  await expect(region.getByText('Сообщений пока нет.')).toBeVisible();
  return region;
}

test('A note, a change request and a correction: one message per composed text, text not markup', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const ids = await taskOn(request, 'Заметки и обращения');
  const region = await open(page, ids);
  await expect(
    region.getByText(
      'История хранится локально у владельца задачи и не переносится синхронизацией Git',
    ),
  ).toBeVisible();
  const box = region.getByLabel('Сообщение', { exact: true });
  const note = region.getByRole('button', { name: 'Заметка', exact: true });
  const change = region.getByRole('button', { name: 'Предложить изменение' });
  await expect(note).toHaveAccessibleDescription(/не меняет задачу и не запускает работу/);
  await expect(change).toHaveAccessibleDescription(/только новой ревизией/);
  await expect(note).toBeDisabled();

  // Двойной щелчок отправляет одну заметку; фокус возвращается в поле.
  await box.fill('Первая заметка');
  await note.dblclick();
  const items = region.getByRole('list', { name: 'Сообщения обсуждения' }).getByRole('listitem');
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText('Вы');
  await expect(items.first()).toContainText('заметка');
  await expect(box).toHaveValue('');
  await expect(box).toBeFocused();
  expect((await thread(request, ids.task)).messages.map((m) => m.text)).toEqual(['Первая заметка']);

  // Ответ потерян в сети после записи: текст остаётся, повтор с тем же
  // ключом возвращает прежнюю запись, а не вторую.
  let dropped = false;
  await page.route(`**/api/tasks/${ids.task}/discussion`, async (route) => {
    if (route.request().method() !== 'POST' || dropped) return route.fallback();
    dropped = true;
    await route.fetch();
    await route.abort('failed');
  });
  await box.fill('Заметка после сбоя сети');
  await note.click();
  await expect(region.getByRole('alert')).toContainText('Не отправлено');
  await expect(box).toHaveValue('Заметка после сбоя сети');
  await note.click();
  await expect(box).toHaveValue('');
  await expect(items).toHaveCount(2);
  expect((await thread(request, ids.task)).messages).toHaveLength(2);

  // HTML показывается текстом и не исполняется.
  const html = '<img src=x onerror="window.__discussionXss=1"><b>жирный</b>';
  await box.fill(html);
  await note.click();
  await expect(items).toHaveCount(3);
  await expect(items.nth(2)).toContainText(html);
  await expect(items.nth(2).locator('img, b')).toHaveCount(0);
  expect(await page.evaluate(() => (window as { __discussionXss?: number }).__discussionXss)).toBe(
    undefined,
  );

  // Обращение к ведущему — со своей меткой и ожиданием обработки.
  await box.fill('Добавить проверку отрицательных чисел');
  await change.click();
  const request4 = page.locator('li[data-message-kind="change-request"]');
  await expect(request4).toHaveCount(1);
  await expect(request4).toContainText('обращение к ведущему');
  await expect(request4).toContainText('Ждёт обработки ведущим агентом');
  await expect(box).toBeFocused();

  // Исправление — новая запись; прежняя зачёркнута и ведёт к новой.
  await items.first().getByRole('button', { name: 'Исправить' }).click();
  await expect(box).toHaveValue('Первая заметка');
  await expect(box).toBeFocused();
  await box.fill('Первая заметка, исправленная');
  await note.click();
  await expect(items).toHaveCount(5);
  await expect(items.first().locator('p').first()).toHaveClass(/line-through/);
  await items.first().getByRole('link', { name: 'Исправлено — к новой версии' }).click();
  await expect(items.nth(4)).toBeFocused();
  const stored = await thread(request, ids.task);
  expect(stored.storage).toBe('local');
  expect(stored.messages.map((m) => [m.author, m.kind])).toEqual([
    ['operator', 'note'],
    ['operator', 'note'],
    ['operator', 'note'],
    ['operator', 'change-request'],
    ['operator', 'note'],
  ]);
  expect(stored.messages[4].supersedes).toBeTruthy();

  expect(
    (await new AxeBuilder({ page }).include('section[aria-labelledby^="discussion-"]').analyze())
      .violations,
  ).toEqual([]);

  // Узкий экран: без горизонтальной прокрутки.
  await page.setViewportSize({ width: 390, height: 844 });
  await region.scrollIntoViewIfNeeded();
  await expect(change).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(
    (await new AxeBuilder({ page }).include('section[aria-labelledby^="discussion-"]').analyze())
      .violations,
  ).toEqual([]);
  expect(errors).toEqual([]);
});

test('A message from a second tab: the conflict re-reads the thread and keeps the typed text', async ({
  page,
  request,
}) => {
  const ids = await taskOn(request, 'Две вкладки');
  const first = await open(page, ids);
  const other = await page.context().newPage();
  const second = await open(other, ids);

  await first.getByLabel('Сообщение', { exact: true }).fill('Текст из первой вкладки');
  await second.getByLabel('Сообщение', { exact: true }).fill('Текст из второй вкладки');
  await second.getByRole('button', { name: 'Заметка', exact: true }).click();
  await expect(second.getByRole('listitem')).toHaveCount(1);

  await first.getByRole('button', { name: 'Заметка', exact: true }).click();
  await expect(first.getByRole('alert')).toHaveText(conflict);
  await expect(first.getByLabel('Сообщение', { exact: true })).toHaveValue(
    'Текст из первой вкладки',
  );
  await expect(first.getByRole('listitem')).toHaveCount(1);
  await expect(first.getByRole('listitem')).toContainText('Текст из второй вкладки');
  expect((await thread(request, ids.task)).messages).toHaveLength(1);

  // Повтор после чтения проходит; в истории обе записи по одному разу.
  await first.getByRole('button', { name: 'Заметка', exact: true }).click();
  await expect(first.getByRole('listitem')).toHaveCount(2);
  await expect(first.getByRole('alert')).toHaveCount(0);
  expect((await thread(request, ids.task)).messages.map((m) => m.text)).toEqual([
    'Текст из второй вкладки',
    'Текст из первой вкладки',
  ]);
  await other.close();
});
