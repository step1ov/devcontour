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

test('A needs-answer disposition: the operator replies from the card and the request returns to the lead', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const ids = await taskOn(request, 'Нужен ответ');
  const agent = async (operation: string, input: Record<string, unknown>) => {
    const response = await request.post('/api/agent', { headers, data: { operation, input } });
    expect(response.ok()).toBe(true);
    return (await response.json()) as Record<string, unknown>;
  };
  /**
   * Обращения задачи во входящих ведущего, все страницы: демо общее, и
   * обращения других спецификаций могут занять первую страницу.
   */
  const inboxOf = async (taskId: string) => {
    type Request = { id: string; taskId: string; version: number; reopened?: { answerId: string } };
    const found: Request[] = [];
    let cursor: string | undefined;
    do {
      const page = (await agent('discussion_inbox', {
        limit: 50,
        ...(cursor ? { cursor } : {}),
      })) as { requests: Request[]; nextCursor?: string };
      found.push(...page.requests.filter((r) => r.taskId === taskId));
      cursor = page.nextCursor;
    } while (cursor);
    return found;
  };
  const region = await open(page, ids);
  const box = region.getByLabel('Сообщение', { exact: true });
  await box.fill('Добавить экспорт');
  await region.getByRole('button', { name: 'Предложить изменение' }).click();
  const requestItem = page.locator('li[data-message-kind="change-request"]');
  await expect(requestItem).toContainText('Ждёт обработки ведущим агентом');

  const [pending] = await inboxOf(ids.task);
  await agent('discussion_resolve', {
    requestId: pending.id,
    outcome: 'needs-answer',
    reason: 'В каком формате экспорт?',
    idempotencyKey: 'e2e-needs-answer-1',
    expectedVersion: pending.version,
  });
  const ask = page.locator('li[data-message-kind="disposition"]');
  await page.reload();
  await expect(ask).toContainText('обработка: нужен ответ');
  await expect(ask).toContainText('В каком формате экспорт?');
  await expect(requestItem.getByRole('link', { name: 'Ведущий агент ждёт ответа' })).toBeVisible();
  // Пока ответа нет, обращения во входящих ведущего нет.
  expect(await inboxOf(ids.task)).toEqual([]);

  await ask.getByRole('button', { name: 'Ответить' }).click();
  await expect(region.getByText('обращение вернётся ему на обработку')).toBeVisible();
  await expect(region.getByRole('button', { name: 'Предложить изменение' })).toHaveCount(0);
  await expect(box).toBeFocused();
  await box.fill('В CSV');
  await region.getByRole('button', { name: 'Ответить ведущему' }).click();
  await expect(region.getByRole('status')).toHaveText('Ответ передан ведущему агенту');
  const answer = page.locator('li[data-message-kind="note"]');
  await expect(answer).toContainText('В CSV');
  await expect(answer.getByRole('link', { name: 'Ответ на запрос ведущего' })).toBeVisible();
  await expect(requestItem).toContainText('Ответ передан — ждёт обработки ведущим агентом');
  await expect(ask.getByRole('button', { name: 'Ответить' })).toBeVisible();

  const [reopened] = await inboxOf(ids.task);
  expect(reopened?.id).toBe(pending.id);
  expect(reopened?.reopened?.answerId).toBeTruthy();
  expect(
    (await new AxeBuilder({ page }).include('section[aria-labelledby^="discussion-"]').analyze())
      .violations,
  ).toEqual([]);
  expect(errors).toEqual([]);
});
