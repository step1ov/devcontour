import { test, expect } from '@playwright/test';

// Адрес панели: вид, доска и задача. Ссылка должна вести туда, куда
// указывает, а «Назад» — уходить со страницы, а не ходить по кругу.

const headers = { 'X-DevContour-Request': '1' };
type Request = import('@playwright/test').APIRequestContext;
/** Своя доска с задачами: демо общее, другие спецификации меняют его доски. */
async function boardWith(request: Request, title: string, tasks: string[]) {
  const board = (await (
    await request.post('/api/boards', { headers, data: { title } })
  ).json()) as {
    id: string;
  };
  const ids: string[] = [];
  for (const name of tasks)
    ids.push(
      (
        (await (
          await request.post(`/api/boards/${board.id}/tasks`, {
            headers,
            data: {
              title: name,
              description: 'Наблюдаемый результат для проверки ссылки на задачу.',
              role: 'backend',
              repositoryId: 'main',
              acceptance: ['Результат проходит независимую проверку.'],
              dependsOn: [],
              contracts: [],
            },
          })
        ).json()) as { id: string }
      ).id,
    );
  return { board: board.id, ids };
}

test('A view link without a board fills it in place: one Back leaves the panel', async ({
  page,
}) => {
  await page.goto('about:blank');
  await page.goto('/?tab=kanban');
  await expect(page).toHaveURL(/[?&]board=B-/);
  await expect(page).toHaveURL(/[?&]task=T-/);
  await page.goBack();
  await expect(page).toHaveURL('about:blank');
});

test('An unknown board in the link opens the current board instead of an empty screen', async ({
  page,
}) => {
  await page.goto('/?tab=list&board=B-00000000-0000-4000-8000-000000000000');
  await expect(page.getByText('Доска из ссылки не найдена')).toBeVisible();
  await expect(page).not.toHaveURL(/B-00000000-0000-4000-8000-000000000000/);
  await expect(page).toHaveURL(/[?&]board=B-/);
  await expect(page.getByRole('heading', { name: 'Создайте первую доску' })).toHaveCount(0);
});

test('A graph node chosen from the keyboard is the selected task everywhere', async ({
  page,
  request,
}) => {
  const { board } = await boardWith(request, 'Выбор узла с клавиатуры', [
    'Первая задача графа',
    'Вторая задача графа',
  ]);
  await page.goto(`/?tab=graph&board=${board}`);
  const nodes = page.locator('.react-flow__node');
  await expect(nodes.nth(1)).toBeVisible();
  const id = (await nodes.nth(1).getAttribute('data-id'))!;
  await nodes.nth(1).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`[?&]task=${id}`));
  const inspector = page.getByRole('complementary', { name: 'Детали задачи' });
  await expect(inspector).toContainText(id.slice(0, 10));
  // Следующие опросы не возвращают выбор к прежней задаче.
  await page.waitForTimeout(4000);
  await expect(page.locator('.react-flow__node.selected')).toHaveAttribute('data-id', id);
  await expect(page).toHaveURL(new RegExp(`[?&]task=${id}`));
});

test('A link to a cancelled task shows that task, not the first one of the board', async ({
  page,
  request,
}) => {
  const {
    board: id,
    ids: [, cancelledId],
  } = await boardWith(request, 'Ссылка на отменённую задачу', [
    'Живая задача по ссылке',
    'Отменённая задача по ссылке',
  ]);
  const board = { id };
  const cancelled = { id: cancelledId };
  expect(
    (await request.post(`/api/tasks/${cancelled.id}/cancel`, { headers, data: {} })).ok(),
  ).toBe(true);
  await page.goto(`/?tab=list&board=${board.id}&task=${cancelled.id}`);
  const inspector = page.getByRole('complementary', { name: 'Детали задачи' });
  await expect(
    inspector.getByRole('heading', { name: 'Отменённая задача по ссылке' }),
  ).toBeVisible();
  await expect(page.getByLabel(/Показать отменённые/)).toBeChecked();
  await expect(page).toHaveURL(new RegExp(`[?&]task=${cancelled.id}`));
});
