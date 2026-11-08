import { test, expect } from '@playwright/test';
import { useLiveCliGuard } from './live-cli-guard.ts';
import { ownDemo } from './fixtures/own-demo.ts';

// Вопрос исполнителя в панели: demo-исполнитель задачи с маркером
// `[demo:ask]` останавливается вопросом (fixture, не модель); оператор
// отвечает в карточке; ведущий готовит и применяет ответ через агентский
// API; панель показывает раздельные состояния, «передано» — только после
// попытки с ответом; задача и доска принимаются. Сценарии режима
// согласования оператором идут на своём учебном сервере в этом режиме:
// применяет ответ оператор в панели, в том числе вопреки отклонённому ревью
// (маркер `[demo:reject-answer]` — demo-ревью ответа отклоняет его).

// Живые claude и codex под запретом: вызов из demo-пути роняет тест.
useLiveCliGuard();

const headers = { 'X-DevContour-Request': '1' };
type Request = import('@playwright/test').APIRequestContext;
type Page = import('@playwright/test').Page;

/** Операция агентского API (ведущий) на сервере `base` ('' — общий демо-сервер). */
async function agent(request: Request, operation: string, input: unknown, base = '') {
  const response = await request.post(base + '/api/agent', {
    headers,
    data: { operation, input },
  });
  const body = (await response.json()) as Record<string, unknown>;
  expect(response.ok(), JSON.stringify(body)).toBe(true);
  return body;
}

async function taskState(request: Request, id: string, base = '') {
  const state = (await (await request.get(base + '/api/state')).json()) as {
    tasks: { id: string; status: string; failureKind?: string; attempt: number }[];
  };
  return state.tasks.find((t) => t.id === id);
}

async function queue(request: Request, start: boolean, base = '') {
  expect((await request.post(base + '/api/scheduler', { headers, data: { start } })).ok()).toBe(
    true,
  );
}

/**
 * Своя доска с задачей, demo-исполнитель которой спрашивает; ждёт остановки
 * вопросом. `markers` — дополнительные маркеры demo в описании.
 */
async function askingTask(request: Request, title: string, base = '', markers = '') {
  const board = (await (
    await request.post(base + '/api/boards', { headers, data: { title } })
  ).json()) as { id: string };
  const task = (await (
    await request.post(`${base}/api/boards/${board.id}/tasks`, {
      headers,
      data: {
        title,
        description: `Наблюдаемый результат, для которого нужно решение [demo:ask]${markers}.`,
        // Роль без обязательного контракта: задача утверждается сразу.
        role: 'qa',
        repositoryId: 'main',
        acceptance: ['Результат проходит независимую проверку.'],
        dependsOn: [],
        contracts: [],
      },
    })
  ).json()) as { id: string };
  const approved = await request.post(`${base}/api/boards/${board.id}/approve`, {
    headers,
    data: {},
  });
  expect(approved.ok(), await approved.text()).toBe(true);
  await queue(request, true, base);
  await expect
    .poll(async () => (await taskState(request, task.id, base))?.failureKind, {
      timeout: 120000,
    })
    .toBe('needs-input');
  return { board: board.id, task: task.id };
}

/** Последняя ревизия доски принята. */
async function boardAccepted(request: Request, id: string, base = '') {
  const state = (await (await request.get(base + '/api/state')).json()) as {
    boards: { id: string; revisions: { status: string }[] }[];
  };
  return state.boards.find((b) => b.id === id)?.revisions.at(-1)?.status;
}

/** Оператор отвечает в карточке вариантом JSON. */
async function answerInPanel(page: Page, text: string) {
  const card = page
    .getByRole('complementary', { name: 'Детали задачи' })
    .getByRole('region', { name: 'Вопрос исполнителя' });
  await expect(card).toContainText('Нужен ответ');
  await card.getByLabel('JSON').check();
  await card.getByLabel('Ответ исполнителю').fill(text);
  await card.getByRole('button', { name: 'Сохранить ответ' }).click();
  await expect(card).toContainText('Ответ сохранён');
  return card;
}

/** Ведущий: снимок контекста с ответом и раунд его ревью. */
async function prepare(request: Request, taskId: string, base: string) {
  const { requests } = (await agent(request, 'input_list', { taskId }, base)) as {
    requests: { requestId: string }[];
  };
  const requestId = requests[0].requestId;
  const context = (await agent(request, 'input_context', { requestId }, base)) as {
    contextDigest: string;
  };
  const review = () =>
    agent(
      request,
      'input_review',
      { requestId, contextDigest: context.contextDigest, authorRuntime: 'codex' },
      base,
    ) as Promise<{ approved: boolean; round: number }>;
  return { requestId, review };
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

  // Доска задач: задача с вопросом — в колонке «Ждут ответа», а не в
  // «В работе» среди разработки и сбоев.
  await page.goto(`/?tab=kanban&board=${board.id}&task=${task.id}`);
  const columns = page.getByLabel('Колонки задач');
  const waitingColumn = columns.getByRole('region', { name: 'Ждут ответа' });
  await expect(waitingColumn).toContainText('Задача с вопросом исполнителя');
  await expect(waitingColumn).toContainText('Ждёт ответа');
  await expect(columns.getByRole('region', { name: 'В работе' })).not.toContainText(
    'Задача с вопросом исполнителя',
  );

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
  // Приёмка доски после вопроса: попытка с ответом — обычный принятый
  // результат, доска принимается из панели.
  await page.getByRole('button', { name: 'Принять доску' }).click();
  await expect(page.getByRole('button', { name: 'Создать корректировку' })).toBeVisible();
  expect(await boardAccepted(request, board.id)).toBe('accepted');
});

test('A cancelled question leaves a retryable task: the retry button returns after «Снять вопрос»', async ({
  page,
  request,
}) => {
  test.slow();
  const { board, task } = await askingTask(request, 'Вопрос, который снимут');
  const before = (await agent(request, 'input_list', { taskId: task })) as {
    requests: { requestId: string }[];
  };
  expect(before.requests).toHaveLength(1);
  const attempt = (await taskState(request, task))!.attempt;
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
  // Сводка этапа считает её ожидающей ответа, а не «задачей со сбоем».
  await expect(page.locator('[data-stage-waiting-input]')).toContainText(
    /Ждут ответа на вопрос исполнителя: [1-9]/,
  );
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
  // Повтор — настоящая новая попытка: тот же demo-исполнитель снова
  // спрашивает, и это новый вопрос, а не прежний снятый.
  await expect
    .poll(async () => (await taskState(request, task))?.attempt, { timeout: 120000 })
    .toBeGreaterThan(attempt);
  await expect
    .poll(async () => (await taskState(request, task))?.failureKind, { timeout: 120000 })
    .toBe('needs-input');
  const after = (await agent(request, 'input_list', { taskId: task })) as {
    requests: { requestId: string; state: string }[];
  };
  const fresh = after.requests.filter((r) => r.requestId !== before.requests[0].requestId);
  expect(fresh).toHaveLength(1);
  expect(fresh[0].state).toBe('awaiting-answer');
  await expect(card).toContainText('Нужен ответ');
  await expect(retry).toHaveCount(0);
});

test.describe('approvalMode operator', () => {
  test.describe.configure({ mode: 'serial' });
  let demo: Awaited<ReturnType<typeof ownDemo>>;
  test.beforeAll(async () => {
    test.setTimeout(120000);
    demo = await ownDemo('input-operator', { approvalMode: 'operator' });
  });
  test.afterAll(async () => {
    await demo?.close();
  });

  test('The operator applies a reviewed answer in the panel and accepts the board', async ({
    page,
    request,
  }) => {
    test.slow();
    const base = demo.url;
    const { board, task } = await askingTask(request, 'Ответ применяет оператор', base);
    await page.goto(`${base}/?tab=list&board=${board}&task=${task}`);
    const card = await answerInPanel(page, 'Оставьте JSON, как сейчас.');
    // Подготовка и ревью контекста — шаг ведущего и в режиме оператора.
    await expect(card.locator('[data-input-next]')).toContainText('ведущий');
    const { requestId, review } = await prepare(request, task, base);
    expect((await review()).approved).toBe(true);
    // Применение ведущим в этом режиме запрещено: применяет оператор.
    const refused = await request.post(base + '/api/agent', {
      headers,
      data: {
        operation: 'input_apply',
        input: {
          requestId,
          answerDigest: 'a'.repeat(64),
          expectedVersion: 1,
          contextDigest: 'b'.repeat(64),
          targetDigest: 'c'.repeat(64),
        },
      },
    });
    expect(refused.ok()).toBe(false);
    expect(await refused.text()).toContain('применяет оператор в панели');
    await expect(card).toContainText('Контекст с ответом проверен');
    await expect(card.locator('[data-input-next]')).toContainText('примените ответ');
    // Очередь на паузе, чтобы увидеть «применён, ждёт попытки».
    await queue(request, false, base);
    await card.getByRole('button', { name: 'Применить ответ' }).click();
    await expect(card).toContainText('Ответ применён, ждёт попытки');
    await expect(card).not.toContainText('Передано в новую попытку');
    await queue(request, true, base);
    await expect
      .poll(async () => (await taskState(request, task, base))?.status, { timeout: 120000 })
      .toBe('done');
    await expect(card).toContainText('Передано в новую попытку');
    // Приёмку доски в этом режиме подтверждает оператор в панели.
    await page.getByRole('button', { name: 'Принять доску' }).click();
    await expect(page.getByRole('button', { name: 'Создать корректировку' })).toBeVisible();
    expect(await boardAccepted(request, board, base)).toBe('accepted');
  });

  test('A rejected answer review: apply needs the confirmation of the shown round, a new round resets it', async ({
    page,
    request,
  }) => {
    test.slow();
    const base = demo.url;
    const { board, task } = await askingTask(
      request,
      'Отклонённый ответ',
      base,
      ' [demo:reject-answer]',
    );
    await page.goto(`${base}/?tab=list&board=${board}&task=${task}`);
    const card = await answerInPanel(page, 'Оставьте JSON, как сейчас.');
    const { requestId, review } = await prepare(request, task, base);
    const first = await review();
    expect(first).toMatchObject({ approved: false, round: 1 });
    await expect(card).toContainText('Ревью отклонило ответ');
    await expect(card.locator('[data-input-review]')).toContainText('раунд 1: отклонено');
    await expect(card.getByRole('list', { name: 'Находки ревью ответа' })).toContainText(
      'ответ меняет утверждённую приёмку',
    );
    const apply = card.getByRole('button', { name: 'Применить ответ' });
    await expect(apply).toBeDisabled();
    const confirm = card.getByLabel(/Применить вопреки отклонённому ревью/);
    await confirm.check();
    await expect(apply).toBeEnabled();
    // Новый раунд, пока оператор читал: подтверждение снимается.
    expect(await review()).toMatchObject({ approved: false, round: 2 });
    await expect(card.locator('[data-input-review]')).toContainText('раунд 2: отклонено');
    await expect(confirm).not.toBeChecked();
    await expect(apply).toBeDisabled();
    // Подтверждение прежнего раунда сервер не принимает.
    const { current } = (await (await request.get(`${base}/api/tasks/${task}/input`)).json()) as {
      current: { version: number };
    };
    const stale = await request.post(`${base}/api/tasks/${task}/input/${requestId}/apply`, {
      headers,
      data: { expectedVersion: current.version, confirmRejectedRound: 1 },
    });
    expect(stale.status()).toBe(409);
    expect(await stale.text()).toContain('раунд ревью — 2');
    await queue(request, false, base);
    await confirm.check();
    await apply.click();
    await expect(card).toContainText('Ответ применён, ждёт попытки');
    await queue(request, true, base);
    await expect
      .poll(async () => (await taskState(request, task, base))?.status, { timeout: 120000 })
      .toBe('done');
    await expect(card).toContainText('Передано в новую попытку');
  });
});
