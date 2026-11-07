import { test, expect } from '@playwright/test';

// Вопрос исполнителя в панели: demo-исполнитель задачи с маркером
// `[demo:ask]` останавливается вопросом (fixture, не модель); оператор
// отвечает в карточке; ведущий готовит и применяет ответ через агентский
// API; панель показывает раздельные состояния, «передано» — только после
// попытки с ответом; задача принимается.

const headers = { 'X-DevContour-Request': '1' };
type Request = import('@playwright/test').APIRequestContext;

async function agent(request: Request, operation: string, input: unknown) {
  const response = await request.post('/api/agent', { headers, data: { operation, input } });
  const body = (await response.json()) as Record<string, unknown>;
  expect(response.ok(), JSON.stringify(body)).toBe(true);
  return body;
}

async function taskState(request: Request, id: string) {
  const state = (await (await request.get('/api/state')).json()) as {
    tasks: { id: string; status: string; failureKind?: string }[];
  };
  return state.tasks.find((t) => t.id === id);
}

test('The operator answers the writer question in the panel; the answer reaches the next attempt', async ({
  page,
  request,
}) => {
  test.slow();
  const board = (await (
    await request.post('/api/boards', { headers, data: { title: 'Вопрос исполнителя' } })
  ).json()) as { id: string };
  const task = (await (
    await request.post(`/api/boards/${board.id}/tasks`, {
      headers,
      data: {
        title: 'Задача с вопросом исполнителя',
        description: 'Наблюдаемый результат, для которого нужно решение [demo:ask].',
        // Роль без обязательного контракта: задача утверждается сразу.
        role: 'qa',
        repositoryId: 'main',
        acceptance: ['Результат проходит независимую проверку.'],
        dependsOn: [],
        contracts: [],
      },
    })
  ).json()) as { id: string };
  const approved = await request.post(`/api/boards/${board.id}/approve`, { headers, data: {} });
  expect(approved.ok(), await approved.text()).toBe(true);
  expect((await request.post('/api/scheduler', { headers, data: { start: true } })).ok()).toBe(
    true,
  );
  await expect
    .poll(async () => (await taskState(request, task.id))?.failureKind, { timeout: 60000 })
    .toBe('needs-input');

  await page.goto(`/?tab=list&board=${board.id}&task=${task.id}`);
  const inspector = page.getByRole('complementary', { name: 'Детали задачи' });
  const card = inspector.getByRole('region', { name: 'Вопрос исполнителя' });
  await expect(card).toContainText('Нужен ответ');
  await expect(card).toContainText('Demo fixture: какой формат артефакта');
  await expect(card).toContainText('рекомендует исполнитель');
  // Повтор задачи с вопросом не предлагается: продолжение — ответ.
  await expect(inspector.getByRole('button', { name: 'Повторить' })).toHaveCount(0);
  // В списке задача помечена ожиданием ответа.
  await expect(page.locator('[data-input-waiting]').first()).toBeVisible();

  await card.getByLabel('JSON').check();
  await card.getByLabel('Ответ исполнителю').fill('Оставьте JSON, как сейчас.');
  await card.getByRole('button', { name: 'Сохранить ответ' }).click();
  await expect(card).toContainText('Ответ сохранён');
  await expect(card.locator('[data-input-answer]')).toContainText('Оставьте JSON');
  // Ответ оператора — сообщение обсуждения задачи со ссылкой на версию ответа.
  const thread = inspector.getByRole('list', { name: 'Сообщения обсуждения' });
  await expect(thread).toContainText('ответ на вопрос, r1');
  await expect(thread).toContainText('Оставьте JSON, как сейчас.');
  // Режим agent: применять в панели нечего, следующий шаг — ведущего.
  await expect(card.getByRole('button', { name: 'Применить ответ' })).toHaveCount(0);
  await expect(card.locator('[data-input-next]')).toContainText('ведущий');

  // Ведущий: снимок, ревью (demo — детерминированное), цель, применение.
  // Очередь на паузе, чтобы увидеть «применён, ждёт попытки».
  const { requests } = (await agent(request, 'input_list', { taskId: task.id })) as {
    requests: { requestId: string }[];
  };
  const requestId = requests[0].requestId;
  const context = (await agent(request, 'input_context', { requestId })) as {
    contextDigest: string;
    answerDigest: string;
  };
  const review = await agent(request, 'input_review', {
    requestId,
    contextDigest: context.contextDigest,
    authorRuntime: 'codex',
  });
  expect(review.approved).toBe(true);
  await expect(card).toContainText('Контекст с ответом проверен');
  const target = (await agent(request, 'input_target', {
    requestId,
    contextDigest: context.contextDigest,
  })) as { version: number; targetDigest: string; problems: string[] };
  expect(target.problems).toEqual([]);
  expect((await request.post('/api/scheduler', { headers, data: { start: false } })).ok()).toBe(
    true,
  );
  const applied = await agent(request, 'input_apply', {
    requestId,
    answerDigest: context.answerDigest,
    expectedVersion: target.version,
    contextDigest: context.contextDigest,
    targetDigest: target.targetDigest,
  });
  expect(applied.applied).toBe(true);
  await expect(card).toContainText('Ответ применён, ждёт попытки');
  await expect(card).not.toContainText('Передано в новую попытку');

  expect((await request.post('/api/scheduler', { headers, data: { start: true } })).ok()).toBe(
    true,
  );
  await expect
    .poll(async () => (await taskState(request, task.id))?.status, { timeout: 60000 })
    .toBe('done');
  await expect(card).toContainText('Передано в новую попытку');
});
