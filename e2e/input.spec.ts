import { test, expect } from '@playwright/test';
import { useLiveCliGuard } from './live-cli-guard.ts';

// Вопрос исполнителя в панели: demo-исполнитель задачи с маркером
// `[demo:ask]` останавливается вопросом (fixture, не модель); оператор
// отвечает в карточке; ведущий готовит и применяет ответ через агентский
// API; панель показывает раздельные состояния, «передано» — только после
// попытки с ответом; задача принимается.

// Живые claude и codex под запретом: вызов из demo-пути роняет тест.
useLiveCliGuard();

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

/** Своя доска с задачей, demo-исполнитель которой спрашивает; ждёт остановки вопросом. */
async function askingTask(request: Request, title: string) {
  const board = (await (
    await request.post('/api/boards', { headers, data: { title } })
  ).json()) as { id: string };
  const task = (await (
    await request.post(`/api/boards/${board.id}/tasks`, {
      headers,
      data: {
        title,
        description: 'Наблюдаемый результат, для которого нужно решение [demo:ask].',
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
  return { board: board.id, task: task.id };
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

test('A cancelled question leaves a retryable task: the retry button returns after «Снять вопрос»', async ({
  page,
  request,
}) => {
  test.slow();
  const { board, task } = await askingTask(request, 'Вопрос, который снимут');
  // Очередь «Хода работ»: задача с открытым вопросом ждёт ответа, а не в сбое.
  await page.goto(`/?tab=progress&board=${board}`);
  const queued = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole('heading', { name: /^Очередь \(/ }) })
    .locator('li')
    .filter({ hasText: 'Вопрос, который снимут' });
  await expect(queued).toHaveAttribute('data-input-waiting', '');
  await expect(queued).toContainText('Ждёт ответа');
  // Следующий шаг — тот же текст, что в карточке вопроса (inputNextText).
  await expect(queued).toContainText(/Дальше: (ответьте|ответит ведущий агент)/);
  await expect(queued).not.toContainText('Сбой');
  await page.goto(`/?tab=list&board=${board}&task=${task}`);
  const inspector = page.getByRole('complementary', { name: 'Детали задачи' });
  const card = inspector.getByRole('region', { name: 'Вопрос исполнителя' });
  await expect(card).toContainText('Нужен ответ');
  await expect(inspector.getByRole('button', { name: 'Повторить' })).toHaveCount(0);
  await card.getByRole('button', { name: 'Снять вопрос' }).click();
  await expect(card).toContainText('Вопрос снят');
  const retry = inspector.getByRole('button', { name: 'Повторить' });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect
    .poll(async () => (await taskState(request, task))?.status, { timeout: 60000 })
    .not.toBe('failed');
});

test('A rejected answer review shows the verdict and findings; apply needs the confirmation of that round', async ({
  page,
  request,
}) => {
  test.slow();
  const { board, task } = await askingTask(request, 'Отклонённый ответ');
  // Демо работает в режиме agent и одобряет ревью ответа: состояние карточки
  // оператора с отклонённым раундом подставляется в ответ сервера.
  const real = (await (await request.get(`/api/tasks/${task}/input`)).json()) as {
    current: Record<string, unknown>;
  };
  let round = 2;
  const view = () => ({
    ...real,
    approvalMode: 'operator',
    current: {
      ...real.current,
      state: 'review-rejected',
      lifecycle: 'answered',
      actor: 'operator',
      next: 'read the findings; apply only with explicit confirmation',
      answers: [
        {
          revision: 1,
          text: 'Produce YAML instead.',
          optionId: null,
          kind: 'clarification',
          actor: { kind: 'operator' },
          digest: 'a'.repeat(64),
          at: new Date().toISOString(),
        },
      ],
      reviews: [
        {
          round,
          approved: false,
          contextDigest: 'b'.repeat(64),
          summary: `Раунд ${round}: ответ меняет утверждённую приёмку`,
          at: new Date().toISOString(),
          findings: [{ severity: 'blocking', message: 'Ответ меняет утверждённую приёмку' }],
        },
      ],
    },
  });
  await page.route(`**/api/tasks/${task}/input`, (route) => route.fulfill({ json: view() }));
  const applied: unknown[] = [];
  await page.route(`**/api/tasks/${task}/input/*/apply`, async (route) => {
    applied.push(route.request().postDataJSON());
    await route.fulfill({ json: { applied: true } });
  });
  await page.goto(`/?tab=list&board=${board}&task=${task}`);
  const card = page
    .getByRole('complementary', { name: 'Детали задачи' })
    .getByRole('region', { name: 'Вопрос исполнителя' });
  await expect(card).toContainText('Ревью отклонило ответ');
  await expect(card.locator('[data-input-review]')).toContainText('отклонено');
  await expect(card.getByRole('list', { name: 'Находки ревью ответа' })).toContainText(
    'Ответ меняет утверждённую приёмку',
  );
  const apply = card.getByRole('button', { name: 'Применить ответ' });
  await expect(apply).toBeDisabled();
  const confirm = card.getByLabel(/Применить вопреки отклонённому ревью/);
  await confirm.check();
  await expect(apply).toBeEnabled();
  // Новый раунд, пока оператор читал: подтверждение снимается.
  round = 3;
  await expect(card).toContainText('Раунд 3');
  await expect(confirm).not.toBeChecked();
  await expect(apply).toBeDisabled();
  await confirm.check();
  await apply.click();
  await expect.poll(() => applied.length).toBe(1);
  expect(applied[0]).toMatchObject({ confirmRejectedRound: 3 });
});
