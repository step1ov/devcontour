import { test, expect, type APIRequestContext } from '@playwright/test';
import { useLiveCliGuard } from './live-cli-guard.ts';
import { ownDemo } from './fixtures/own-demo.ts';

// Предложение ответа ведущего (F37). Вопрос в продуктовой области
// (маркер `[demo:ask-product]`, fixture, не модель) получает минимум
// критичности: отвечает только оператор. Ведущий предлагает ответ через
// агентский API (`input_propose`), оператор подтверждает его одним нажатием
// в карточке задачи или в центре внимания — в запросе появляется ответ
// оператора. Свой учебный сервер в режиме `agent`: сценарий запускает очередь.

// Живые claude и codex под запретом: вызов из demo-пути роняет тест.
useLiveCliGuard();

const headers = { 'X-DevContour-Request': '1' };

async function agent(request: APIRequestContext, base: string, operation: string, input: unknown) {
  const response = await request.post(base + '/api/agent', { headers, data: { operation, input } });
  return { status: response.status(), body: (await response.json()) as Record<string, unknown> };
}

/** Своя доска с задачей, demo-исполнитель которой спрашивает оператора; ждёт вопроса. */
async function askingTask(request: APIRequestContext, base: string, title: string) {
  const board = (await (
    await request.post(base + '/api/boards', { headers, data: { title } })
  ).json()) as { id: string };
  const task = (await (
    await request.post(`${base}/api/boards/${board.id}/tasks`, {
      headers,
      data: {
        title,
        description: 'Наблюдаемый результат, для которого нужно решение [demo:ask-product].',
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
  expect(
    (await request.post(base + '/api/scheduler', { headers, data: { start: true } })).ok(),
  ).toBe(true);
  await expect
    .poll(
      async () => {
        const { requests } = (await agent(request, base, 'input_list', { taskId: task.id }))
          .body as { requests: { requestId: string; version: number }[] };
        return requests.length;
      },
      { timeout: 120000 },
    )
    .toBe(1);
  const { requests } = (await agent(request, base, 'input_list', { taskId: task.id })).body as {
    requests: { requestId: string; version: number; actor: string; floors: string[] }[];
  };
  expect(requests[0].actor).toBe('operator');
  expect(requests[0].floors).toEqual(['declared']);
  return { board: board.id, task: task.id, ...requests[0] };
}

/** Ведущий предлагает ответ вариантом JSON; сам ответить не может. */
async function propose(
  request: APIRequestContext,
  base: string,
  q: { requestId: string; version: number },
  text: string,
) {
  const answered = await agent(request, base, 'input_answer', {
    requestId: q.requestId,
    text,
    expectedVersion: q.version,
  });
  expect(answered.status).toBe(403);
  const proposed = await agent(request, base, 'input_propose', {
    requestId: q.requestId,
    text,
    optionId: 'json',
    reasoning: 'Зарегистрированный контракт задаёт JSON, и принятый файл уже его возвращает.',
    expectedVersion: q.version,
  });
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
}

async function lastAnswer(request: APIRequestContext, base: string, requestId: string) {
  const shown = (await agent(request, base, 'input_show', { requestId })).body as {
    answers: { text?: string; optionId: string | null; actor: { kind: string } }[];
  };
  return shown.answers.at(-1);
}

test.describe('Lead proposal for an operator question', () => {
  test.describe.configure({ mode: 'serial' });
  let demo: Awaited<ReturnType<typeof ownDemo>>;
  test.beforeAll(async () => {
    test.setTimeout(120000);
    demo = await ownDemo('input-propose');
  });
  test.afterAll(async () => {
    await demo?.close();
  });

  test('The operator confirms the lead proposal in the task card in one click', async ({
    page,
    request,
  }) => {
    test.slow();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const base = demo.url;
    const q = await askingTask(request, base, 'Предложение ведущего: карточка задачи');
    const text = 'Оставьте JSON, как в контракте.';
    await propose(request, base, q, text);
    await page.goto(`${base}/?tab=list&board=${q.board}&task=${q.task}`);
    const card = page
      .getByRole('complementary', { name: 'Детали задачи' })
      .getByRole('region', { name: 'Вопрос исполнителя' });
    await expect(card).toContainText('Нужен ответ');
    const proposal = card.locator('[data-input-proposal]');
    await expect(proposal).toContainText('Ведущий предлагает ответ (уточнение, вариант «JSON»)');
    await expect(proposal).toContainText(text);
    await expect(proposal).toContainText('Обоснование ведущего: Зарегистрированный контракт');
    // Ответить иначе — прежняя форма рядом.
    await expect(card.getByLabel('Ответ исполнителю')).toBeVisible();
    await proposal.getByRole('button', { name: 'Подтвердить ответ ведущего' }).click();
    await expect(card).toContainText('Ответ сохранён');
    await expect(card.locator('[data-input-answer]')).toContainText('оператор, вариант json');
    await expect(card.locator('[data-input-proposal]')).toHaveCount(0);
    const answer = await lastAnswer(request, base, q.requestId);
    expect(answer?.actor.kind).toBe('operator');
    expect(answer?.text).toBe(text);
    expect(answer?.optionId).toBe('json');
    expect(errors).toEqual([]);
  });

  test('The attention card offers «Подтвердить ответ ведущего» first and saves the operator answer', async ({
    page,
    request,
  }) => {
    test.slow();
    const base = demo.url;
    const q = await askingTask(request, base, 'Предложение ведущего: центр внимания');
    const text = 'JSON по контракту.';
    await propose(request, base, q, text);
    await page.goto(`${base}/?tab=attention`);
    const card = page.locator(`article[data-attention-key="input:${q.requestId}"]`);
    await expect(card).toBeVisible();
    await expect(card).toContainText('Ведущий предлагает ответ (вариант «JSON»)');
    const actions = card.getByRole('button', { name: /Подтвердить ответ ведущего|Ответить/ });
    await expect(actions.first()).toHaveText('Подтвердить ответ ведущего');
    await card.getByText('Ответ ведущего и обоснование').click();
    await expect(card).toContainText('Обоснование ведущего:');
    await card.getByRole('button', { name: 'Подтвердить ответ ведущего' }).click();
    await expect
      .poll(async () => (await lastAnswer(request, base, q.requestId))?.actor.kind)
      .toBe('operator');
    expect((await lastAnswer(request, base, q.requestId))?.text).toBe(text);
  });
});
