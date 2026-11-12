import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Решения ведущего за владельца: ведущий записывает решение через агентский
// API, владелец видит его карточкой центра внимания с полным текстом,
// подтверждает или отменяет; отмена приходит ведущему обращением, тред
// задачи показывает бейдж и состояние.

const headers = { 'X-DevContour-Request': '1' };

async function taskOn(request: APIRequestContext, title: string) {
  const board = (await (
    await request.post('/api/boards', {
      headers,
      data: { title: 'Решения за владельца: ' + title },
    })
  ).json()) as { id: string };
  const task = (await (
    await request.post(`/api/boards/${board.id}/tasks`, {
      headers,
      data: {
        title,
        description: 'Наблюдаемый результат для проверки решений за владельца.',
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
async function agent(request: APIRequestContext, operation: string, input: unknown) {
  const response = await request.post('/api/agent', { headers, data: { operation, input } });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as Record<string, unknown>;
}
async function standIn(request: APIRequestContext, taskId: string, key: string, text: string) {
  const posted = (await agent(request, 'discussion_post', {
    taskId,
    kind: 'stand-in',
    text,
    standIn: {
      question: 'Сколько позиций в одном заказе?',
      impact: 'Модель данных заказа и экран корзины.',
    },
    idempotencyKey: key,
    expectedVersion: 0,
  })) as { message: { id: string } };
  return posted.message.id;
}
const cardOf = (page: Page, key: string) => page.locator(`article[data-attention-key="${key}"]`);

test('The owner confirms a stand-in from the attention card after reading it in full', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const ids = await taskOn(request, 'Подтверждение');
  // Длинное решение: на карточке видна выдержка, полный текст — открыт.
  const tail = 'Конец решения для проверки полного текста.';
  const decision = 'Один заказ — одна позиция. ' + 'Основание: короткий путь. '.repeat(14) + tail;
  const id = await standIn(request, ids.task, 'e2e-stand-in-confirm', decision);
  const key = `discussion:si:${id}`;

  await page.goto('/?tab=attention');
  const card = cardOf(page, key);
  await expect(card).toBeVisible();
  await expect(card).toContainText('Ведущий решил за вас');
  await expect(card).toContainText('Кто действует: Вы');
  const full = card.locator('details', { hasText: 'Решение полностью' });
  await expect(full).toHaveAttribute('open', '');
  await expect(full).toContainText(tail);
  await expect(card.getByRole('button', { name: 'Отменить решение' })).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).include(`article[data-attention-key="${key}"]`).analyze())
      .violations,
  ).toEqual([]);
  await card.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(cardOf(page, key)).toHaveCount(0);

  await page.goto(`/?tab=list&board=${ids.board}&task=${ids.task}`);
  const region = page.getByRole('region', { name: 'Обсуждение' });
  const item = region.locator('li[data-message-kind="stand-in"]');
  await expect(item).toContainText('решение за вас');
  await expect(item).toContainText('Сколько позиций в одном заказе?');
  await expect(item.getByRole('link', { name: 'Подтверждено вами' })).toBeVisible();
  await expect(region.getByText('вы подтвердили решение')).toBeVisible();
  expect(errors).toEqual([]);
});

test('The owner reverses a stand-in: the lead receives a change request and the thread shows its state', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const ids = await taskOn(request, 'Отмена');
  const id = await standIn(request, ids.task, 'e2e-stand-in-reverse', 'Один заказ — одна позиция.');
  const key = `discussion:si:${id}`;

  // Тред до решения: бейдж, вопрос, влияние и ожидание владельца.
  await page.goto(`/?tab=list&board=${ids.board}&task=${ids.task}`);
  const region = page.getByRole('region', { name: 'Обсуждение' });
  const item = region.locator('li[data-message-kind="stand-in"]');
  await expect(item).toContainText('решение за вас');
  await expect(item).toContainText('Модель данных заказа и экран корзины.');
  await expect(item).toContainText('Ждёт вашего подтверждения или отмены в центре внимания');

  await page.goto('/?tab=attention');
  const card = cardOf(page, key);
  await card.getByRole('button', { name: 'Отменить решение' }).click();
  const form = card.locator('form');
  await form.getByLabel(/Ваш ответ/).fill('В заказе несколько позиций.');
  await form.getByRole('button', { name: 'Отменить решение' }).click();
  await expect(cardOf(page, key)).toHaveCount(0);

  // Ведущий получает отмену обращением с вариантом владельца.
  type Inbox = { requests: { id: string; taskId: string; excerpt: string; version: number }[] };
  const found: Inbox['requests'] = [];
  let cursor: string | undefined;
  do {
    const inbox = (await agent(request, 'discussion_inbox', {
      limit: 50,
      ...(cursor ? { cursor } : {}),
    })) as Inbox & { nextCursor?: string };
    found.push(...inbox.requests.filter((r) => r.taskId === ids.task));
    cursor = inbox.nextCursor;
  } while (cursor);
  expect(found).toHaveLength(1);
  expect(found[0].excerpt).toContain('Взамен: В заказе несколько позиций.');

  await page.goto(`/?tab=list&board=${ids.board}&task=${ids.task}`);
  await expect(
    item.getByRole('link', { name: 'Отменено вами — ждёт обработки ведущим агентом' }),
  ).toBeVisible();
  const reversal = region.locator('li[data-message-kind="change-request"]');
  await expect(reversal).toContainText('вы отменили решение');
  await expect(reversal.getByRole('link', { name: 'К решению за вас' })).toBeVisible();
  await expect(reversal.getByRole('button', { name: 'Исправить' })).toHaveCount(0);

  // Ведущий просит ответа — тред называет это, а не «переделывает».
  await agent(request, 'discussion_resolve', {
    requestId: found[0].id,
    outcome: 'needs-answer',
    reason: 'Сколько позиций максимум?',
    idempotencyKey: 'e2e-stand-in-needs-answer',
    expectedVersion: found[0].version,
  });
  await page.reload();
  await expect(
    item.getByRole('link', { name: 'Отменено вами — ведущий агент просит ответа' }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
