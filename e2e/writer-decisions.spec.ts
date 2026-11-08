import { test, expect, type APIRequestContext } from '@playwright/test';
import { useLiveCliGuard } from './live-cli-guard.ts';
import { ownDemo } from './fixtures/own-demo.ts';

// Решения исполнителя в карточке задачи: demo-исполнитель задачи с маркером
// `[demo:assume]` доводит работу до конца и записывает две развилки ниже
// порога вопросов (fixture, не модель); движок сохраняет их в попытке, и
// карточка показывает их рядом с результатом попытки. Свой сервер: сценарий
// запускает очередь, а общий демо-проект ждут другие спецификации.

useLiveCliGuard();
test.describe.configure({ mode: 'serial' });

const headers = { 'X-DevContour-Request': '1' };
let demo: Awaited<ReturnType<typeof ownDemo>>;

test.beforeAll(async () => {
  test.setTimeout(120000);
  demo = await ownDemo('decisions');
});
test.afterAll(async () => {
  await demo?.close();
});

async function status(request: APIRequestContext, id: string) {
  const state = (await (await request.get(demo.url + '/api/state')).json()) as {
    tasks: { id: string; status: string }[];
  };
  return state.tasks.find((t) => t.id === id)?.status;
}

test('An accepted attempt shows the decisions the writer took itself in the task card', async ({
  page,
  request,
}) => {
  test.slow();
  const board = (await (
    await request.post(demo.url + '/api/boards', {
      headers,
      data: { title: 'Решения исполнителя' },
    })
  ).json()) as { id: string };
  const add = async (title: string, description: string) =>
    (await (
      await request.post(`${demo.url}/api/boards/${board.id}/tasks`, {
        headers,
        data: {
          title,
          description,
          role: 'qa',
          repositoryId: 'main',
          acceptance: ['Результат проходит независимую проверку.'],
          dependsOn: [],
          contracts: [],
        },
      })
    ).json()) as { id: string };
  const assuming = await add(
    'Задача с решениями исполнителя',
    'Наблюдаемый результат, по пути к которому исполнитель решает сам [demo:assume].',
  );
  const plain = await add('Задача без решений', 'Наблюдаемый результат без развилок.');
  const approved = await request.post(`${demo.url}/api/boards/${board.id}/approve`, {
    headers,
    data: {},
  });
  expect(approved.ok(), await approved.text()).toBe(true);
  expect(
    (await request.post(demo.url + '/api/scheduler', { headers, data: { start: true } })).ok(),
  ).toBe(true);
  for (const id of [assuming.id, plain.id])
    await expect.poll(() => status(request, id), { timeout: 150000 }).toBe('done');

  await page.goto(`${demo.url}/?tab=list&board=${board.id}&task=${assuming.id}`);
  const inspector = page.getByRole('complementary', { name: 'Детали задачи' });
  const attempts = inspector.getByRole('region', { name: 'Ход попыток' });
  await expect(attempts).toContainText('принята');
  const decisions = attempts.getByRole('region', { name: 'Решения исполнителя' });
  await expect(decisions).toContainText('Решения исполнителя (2)');
  const items = decisions.locator('[data-writer-decision]');
  await expect(items).toHaveCount(2);
  // Вопрос — выбор — основание — серьёзность, в порядке записи движка.
  await expect(items.nth(0)).toContainText('Demo fixture: где хранить артефакт задачи?');
  await expect(items.nth(0)).toContainText('Выбор: deliverables/<id>.json, как у остальных задач');
  await expect(items.nth(0)).toContainText('Основание: Так его читает fixture-проверка verify.mjs');
  await expect(items.nth(0)).toContainText('серьёзность 2');
  await expect(items.nth(1)).toContainText('Demo fixture: нужен ли отступ в JSON?');
  await expect(items.nth(1)).toContainText('Выбор: Два пробела');
  await expect(items.nth(1)).toContainText('серьёзность 1');

  // Попытка без решений не рисует пустой список.
  await page.goto(`${demo.url}/?tab=list&board=${board.id}&task=${plain.id}`);
  const other = page
    .getByRole('complementary', { name: 'Детали задачи' })
    .getByRole('region', { name: 'Ход попыток' });
  await expect(other).toContainText('принята');
  await expect(other.getByRole('region', { name: 'Решения исполнителя' })).toHaveCount(0);
});
