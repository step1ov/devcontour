import { test, expect, type APIRequestContext, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspace } from '../src/runner/start.ts';
import { product } from '../tests/preparation-fixture.ts';
import { useLiveCliGuard } from './live-cli-guard.ts';

// Свой демо-сервер (playwright.config.ts): сценарии центра внимания
// запускают очередь, и общий демо-проект после них не тот, что ждут другие.
test.use({ baseURL: 'http://127.0.0.1:4389' });

// Интерфейс центра внимания (D05). Демо-сервер общий для спецификаций:
// каждый тест создаёт свои доску и задачу и находит свои карточки по
// `data-attention-key` (ключ предмета из своих id), а не считает все.
// Вопрос исполнителя задаёт demo-исполнитель с маркером `[demo:ask]` —
// fixture, не модель.

// Живые claude и codex под запретом: вызов из demo-пути роняет тест.
useLiveCliGuard();

const headers = { 'X-DevContour-Request': '1' };

async function agent(request: APIRequestContext, operation: string, input: unknown, base = '') {
  const response = await request.post(base + '/api/agent', {
    headers,
    data: { operation, input },
  });
  const body = (await response.json()) as Record<string, unknown>;
  expect(response.ok(), JSON.stringify(body)).toBe(true);
  return body;
}

async function taskState(request: APIRequestContext, id: string) {
  const state = (await (await request.get('/api/state')).json()) as {
    paused: boolean;
    tasks: { id: string; status: string; failureKind?: string }[];
  };
  return state.tasks.find((t) => t.id === id);
}

async function ownTask(request: APIRequestContext, title: string, description: string) {
  const board = (await (
    await request.post('/api/boards', { headers, data: { title } })
  ).json()) as { id: string };
  const task = (await (
    await request.post(`/api/boards/${board.id}/tasks`, {
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
  return { board: board.id, task: task.id };
}

/** Своя задача, demo-исполнитель которой спрашивает оператора; ждёт остановки вопросом. */
async function askingTask(request: APIRequestContext, title: string) {
  const ids = await ownTask(
    request,
    title,
    // Вопрос в продуктовой области: отвечает оператор (порог критичности).
    'Наблюдаемый результат, для которого нужно решение [demo:ask-product].',
  );
  const approved = await request.post(`/api/boards/${ids.board}/approve`, { headers, data: {} });
  expect(approved.ok(), await approved.text()).toBe(true);
  expect((await request.post('/api/scheduler', { headers, data: { start: true } })).ok()).toBe(
    true,
  );
  await expect
    .poll(async () => (await taskState(request, ids.task))?.failureKind, { timeout: 60000 })
    .toBe('needs-input');
  const { requests } = (await agent(request, 'input_list', { taskId: ids.task })) as {
    requests: { requestId: string }[];
  };
  return { ...ids, requestId: requests[0].requestId };
}

const center = (page: Page) => page.locator('[aria-label="Центр внимания"]');
const cardOf = (page: Page, key: string) => page.locator(`article[data-attention-key="${key}"]`);
const liveStatus = (page: Page) => center(page).locator('[role="status"]').first();

/** Ведущий готовит, проверяет и применяет ответ через агентский API (как input.spec). */
async function leadApplies(request: APIRequestContext, requestId: string) {
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
  const target = (await agent(request, 'input_target', {
    requestId,
    contextDigest: context.contextDigest,
  })) as { version: number; targetDigest: string; problems: string[] };
  expect(target.problems).toEqual([]);
  const applied = await agent(request, 'input_apply', {
    requestId,
    answerDigest: context.answerDigest,
    expectedVersion: target.version,
    contextDigest: context.contextDigest,
    targetDigest: target.targetDigest,
  });
  expect(applied.applied).toBe(true);
}

test('D05-A: from the center to the executor question, an answer, the wait for apply and the new attempt', async ({
  page,
  request,
}) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const own = await askingTask(request, 'Центр внимания: вопрос исполнителя');
  const key = `input:${own.requestId}`;
  await page.goto('/?tab=attention');
  await expect(page.getByRole('heading', { level: 1, name: 'Внимание' })).toBeVisible();
  const operatorGroup = center(page).getByRole('region', { name: /Нужно ваше действие/ });
  const card = operatorGroup.locator(`article[data-attention-key="${key}"]`);
  await expect(card).toBeVisible();
  await expect(card).toContainText('Вопрос к вам');
  await expect(card).toContainText('Кто действует: Вы');
  await expect(card).toContainText('новое');

  // Ссылка ведёт к вопросу в карточке задачи; фокус — на вопросе.
  await card.getByRole('link', { name: 'Открыть вопрос' }).click();
  await expect(page).toHaveURL(new RegExp(`task=${own.task}`));
  const question = page
    .getByRole('complementary', { name: 'Детали задачи' })
    .getByRole('region', { name: 'Вопрос исполнителя' });
  await expect(question).toBeFocused();
  // «Назад» — на экран внимания, фокус на той же карточке; переход прочитал её.
  await page.goBack();
  await expect(cardOf(page, key)).toBeFocused();
  await expect(cardOf(page, key)).not.toContainText('новое');

  // Ответ в карточке: вариант и текст.
  await cardOf(page, key).getByRole('button', { name: 'Ответить' }).click();
  const form = cardOf(page, key).locator('form');
  await form.getByLabel('JSON').check();
  await form.getByLabel(/Ваш ответ/).fill('Оставьте JSON, как сейчас.');
  await form.getByRole('button', { name: 'Ответить' }).click();
  await expect(liveStatus(page)).toContainText('Ответ сохранён');
  // Дальше — ведущий: карточка в группе ведущего, без кнопок решения.
  const moved = cardOf(page, key);
  await expect(moved).toHaveAttribute('data-attention-actor', 'lead');
  await expect(moved).toContainText('Ведущий агент разберёт это сам');
  await expect(moved.getByRole('button', { name: 'Ответить' })).toHaveCount(0);

  // Ожидание применения видно в задаче; затем новая попытка.
  expect((await request.post('/api/scheduler', { headers, data: { start: false } })).ok()).toBe(
    true,
  );
  await leadApplies(request, own.requestId);
  await moved.getByRole('link', { name: 'Открыть вопрос' }).click();
  await expect(question).toContainText('Ответ применён, ждёт попытки');
  expect((await request.post('/api/scheduler', { headers, data: { start: true } })).ok()).toBe(
    true,
  );
  await expect
    .poll(async () => (await taskState(request, own.task))?.status, { timeout: 60000 })
    .toBe('done');
  await expect(question).toContainText('Передано в новую попытку');
  // Подтверждённое устранение убирает карточку из активного списка.
  await page.goto('/?tab=attention');
  await expect(center(page)).toBeVisible();
  await expect(cardOf(page, key)).toHaveCount(0);
  // История: решённое появление с временем решения.
  await center(page).getByRole('tab', { name: 'История' }).click();
  await expect(page).toHaveURL(/attention=history/);
  const row = center(page)
    .getByRole('list', { name: 'История центра внимания' })
    .locator(`[data-attention-history="${key}"]`);
  await expect(row.first()).toContainText(/Закрыто \d/);
  await expect(row.first().getByRole('button')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('D05-A before setup: a preparation question in the center, its link and an inline answer', async ({
  page,
  request,
}) => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-ui-attention-center-'));
  const app = await startWorkspace(join(root, 'workspace'), { port: 0, workspaceMode: 'embedded' });
  try {
    await agent(request, 'preparation_create', { title: 'Модерация чата' }, app.url);
    const status = await agent(request, 'preparation_status', {}, app.url);
    const changeId = String(status.activeChangeId);
    await agent(
      request,
      'preparation_question',
      {
        changeId,
        stage: 'product',
        add: [{ text: 'Кто модерирует чат ночью?', options: ['Бот', 'Дежурный'] }],
      },
      app.url,
    );
    await page.goto(app.url + '/');
    const link = page.getByRole('link', { name: /Нужно действие/ });
    await expect(link.locator('[data-attention-count]')).toHaveAttribute(
      'data-attention-count',
      '1',
    );
    await link.click();
    await expect(page).toHaveURL(/view=attention/);
    const card = page.locator(`article[data-attention-key^="prep:q:${changeId}:"]`);
    await expect(card).toContainText('Вопрос к вам');
    await expect(card).toContainText('Кто модерирует чат ночью?');

    await card.getByRole('link', { name: 'Открыть вопрос' }).click();
    // Этап «Продукт» — этап по умолчанию: адрес его не называет.
    await expect(page).toHaveURL(new RegExp(`change=${changeId}`));
    await expect(page).not.toHaveURL(/view=attention/);
    await expect(page.locator('#questions-product')).toBeFocused();

    await page.goBack();
    await expect(page).toHaveURL(/view=attention/);
    await card.getByRole('button', { name: 'Ответить' }).click();
    // Вариант без текста — достаточно для вопроса подготовки.
    await card.locator('form').getByLabel('Дежурный').check();
    await card.locator('form').getByRole('button', { name: 'Ответить' }).click();
    await expect(card).toHaveCount(0);
    await expect(page.getByText(/Ответ сохранён\. Ведущий агент превратит/)).toBeVisible();
    await page.getByRole('tab', { name: 'История' }).click();
    const row = page
      .getByRole('list', { name: 'История центра внимания' })
      .locator(`[data-attention-history^="prep:q:${changeId}:"]`);
    await expect(row).toContainText('Кто модерирует чат ночью?');
    await expect(row).toContainText(/Закрыто \d/);
  } finally {
    await app.close();
    if (root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true });
  }
});

test('D05-B: keyboard only; focus stays on a card that moves and goes to the next one when a card resolves', async ({
  page,
  request,
}) => {
  test.slow();
  const first = await askingTask(request, 'Клавиатура: первая');
  const second = await askingTask(request, 'Клавиатура: вторая');
  const keyA = `input:${first.requestId}`;
  const keyB = `input:${second.requestId}`;
  await page.goto('/');
  // Навигация — с клавиатуры: фокус на заголовке экрана.
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('link', { name: /Внимание/ })
    .focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Внимание' })).toBeFocused();

  // Форма открывается Enter, первый вариант в фокусе; Esc закрывает её и
  // возвращает фокус на кнопку.
  const answer = cardOf(page, keyB).getByRole('button', { name: 'Ответить' });
  await answer.focus();
  await page.keyboard.press('Enter');
  const form = cardOf(page, keyB).locator('form');
  await expect(form.getByRole('radio').first()).toBeFocused();
  // Enter в группе вариантов не отправляет форму.
  await page.keyboard.press('Space');
  await page.keyboard.press('Enter');
  await expect(form).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(form).toHaveCount(0);
  await expect(answer).toBeFocused();

  // Ответ целиком с клавиатуры: Ctrl+Enter отправляет. Карточка переходит
  // к ведущему и сохраняет фокус.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab');
  await expect(form.getByLabel(/Ваш ответ/)).toBeFocused();
  await page.keyboard.type('Ответ с клавиатуры.');
  await page.keyboard.press('Control+Enter');
  await expect(cardOf(page, keyB)).toHaveAttribute('data-attention-actor', 'lead');
  await expect(cardOf(page, keyB)).toBeFocused();

  // Карточка, решённая в другом месте, пока фокус в ней: фокус переходит к
  // следующей карточке группы, опрос не теряет его на body.
  const order = await center(page)
    .getByRole('region', { name: /Нужно ваше действие/ })
    .locator('article[data-attention-key]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-attention-key')!));
  const index = order.indexOf(keyA);
  expect(index).toBeGreaterThanOrEqual(0);
  const expected = order[index + 1] ?? order[index - 1];
  await cardOf(page, keyA).focus();
  const view = (await (await request.get(`/api/tasks/${first.task}/input`)).json()) as {
    current: { version: number };
  };
  const cancelled = await request.post(`/api/tasks/${first.task}/input/${first.requestId}/cancel`, {
    headers,
    data: { expectedVersion: view.current.version, reason: 'Снят в тесте' },
  });
  expect(cancelled.ok(), await cancelled.text()).toBe(true);
  await expect(cardOf(page, keyA)).toHaveCount(0);
  if (expected) await expect(cardOf(page, expected)).toBeFocused();
  else
    await expect(
      center(page).getByRole('heading', { name: 'Сейчас от вас ничего не требуется.' }),
    ).toBeFocused();
  await expect(liveStatus(page)).toContainText('решена');

  // Вкладки «Нужно действие» / «История» — стрелками.
  const activeTab = center(page).getByRole('tab', { name: 'Нужно действие' });
  await activeTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(center(page).getByRole('tab', { name: 'История' })).toBeFocused();
  await expect(center(page).getByRole('tab', { name: 'История' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Home');
  await expect(activeTab).toHaveAttribute('aria-selected', 'true');
});

/** Подменный ответ центра: свои карточки поверх формы настоящего ответа. */
function fakeView(items: Record<string, unknown>[], over: Record<string, unknown> = {}) {
  return {
    revision: 1,
    generatedAt: new Date().toISOString(),
    engineConnected: true,
    lead: { present: true, lastActivityAt: null },
    counts: {
      active: items.length,
      unread: items.filter((i) => i.actor === 'operator').length,
      byActor: { operator: { active: 0, unread: 0 }, lead: { active: 0, unread: 0 } },
    },
    items,
    ...over,
  };
}
function fakeItem(key: string, over: Record<string, unknown> = {}) {
  return {
    id: `${key}#o1`,
    sourceKey: key,
    occurrenceId: 'o1',
    sourceVersion: 'v1',
    source: 'changeset',
    category: 'decision',
    actor: 'operator',
    title: 'Принять изменение ' + key,
    reason: 'Изменение прошло совместную проверку.',
    impact: { tasks: 0, waiting: 0, boards: [], taskIds: [] },
    since: '2026-11-07T10:00:00.000Z',
    subject: { kind: 'changeset', id: key, href: '/?view=boards&tab=changesets' },
    evidence: [],
    actions: [
      { id: 'accept', kind: 'domain', label: 'Принять', input: 'confirm' },
      { id: 'open', kind: 'navigate', href: '/?view=boards&tab=changesets' },
    ],
    state: { read: false, acknowledged: false, unread: true },
    ...over,
  };
}
const isList = (url: URL) => url.pathname === '/api/attention';

test('D05-B: loading, error with retry, empty list and a lost connection that blocks actions', async ({
  page,
}) => {
  let mode: 'slow' | 'error' | 'empty' | 'items' | 'offline' = 'slow';
  let release!: () => void;
  const slow = new Promise<void>((resolve) => (release = resolve));
  await page.route(isList, async (route: Route) => {
    if (mode === 'slow') {
      await slow;
      return route.fulfill({ status: 500, json: { error: 'Сервер недоступен' } });
    }
    if (mode === 'error')
      return route.fulfill({ status: 500, json: { error: 'Сервер недоступен' } });
    if (mode === 'offline') return route.abort('internetdisconnected');
    return route.fulfill({
      json: fakeView(mode === 'empty' ? [] : [fakeItem('changeset:CHG-A')]),
    });
  });
  await page.goto('/?tab=attention');
  await expect(page.getByText('Загружаем действия…')).toBeVisible();
  mode = 'error';
  release();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Не удалось загрузить действия' }),
  ).toContainText('Сервер недоступен');
  mode = 'empty';
  await page.getByRole('button', { name: 'Повторить' }).click();
  await expect(
    page.getByRole('heading', { name: 'Сейчас от вас ничего не требуется.' }),
  ).toBeVisible();

  mode = 'items';
  const card = cardOf(page, 'changeset:CHG-A');
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Принять', exact: true })).toBeEnabled();
  mode = 'offline';
  await expect(center(page).getByRole('alert')).toContainText('Нет связи с сервером');
  await expect(card.getByRole('button', { name: 'Принять', exact: true })).toBeDisabled();
  await expect(card.getByRole('button', { name: /^Прочитано/ })).toBeDisabled();
  await expect(card.getByRole('link', { name: 'Открыть изменения' })).toBeVisible();
  await expect(card.getByRole('link', { name: 'Открыть изменения' })).toHaveAttribute(
    'href',
    '/?view=boards&tab=changesets',
  );
  mode = 'items';
  await expect(card.getByRole('button', { name: 'Принять', exact: true })).toBeEnabled();
  await expect(center(page).getByText('Нет связи с сервером')).toHaveCount(0);
});

test('D05-B / D04-C: a version conflict replaces the card, keeps the typed text and acts once', async ({
  page,
  request,
}) => {
  test.slow();
  const own = await askingTask(request, 'Конфликт версии');
  const key = `input:${own.requestId}`;
  await page.goto('/?tab=attention');
  await expect(cardOf(page, key)).toBeVisible();
  // Вкладка «застыла» на показанной версии: опрос возвращает прежний ответ.
  const frozen = (await (await request.get('/api/attention')).json()) as unknown;
  await page.route(isList, (route) => route.fulfill({ json: frozen }));
  await cardOf(page, key).getByRole('button', { name: 'Ответить' }).click();
  const form = cardOf(page, key).locator('form');
  await form.getByLabel('JSON').check();
  await form.getByLabel(/Ваш ответ/).fill('Ответ из устаревшей вкладки.');
  // Тем временем ответ дан из другой вкладки.
  const view = (await (await request.get(`/api/tasks/${own.task}/input`)).json()) as {
    current: { version: number };
  };
  const answered = await request.post(`/api/tasks/${own.task}/input/${own.requestId}/answer`, {
    headers,
    data: {
      text: 'Ответ из другой вкладки.',
      optionId: 'json',
      kind: 'clarification',
      expectedVersion: view.current.version,
      idempotencyKey: 'other-tab-' + own.requestId.slice(-12),
    },
  });
  expect(answered.ok(), await answered.text()).toBe(true);
  await form.getByRole('button', { name: 'Ответить' }).click();
  const alert = cardOf(page, key).getByRole('alert');
  await expect(alert).toContainText('Карточка изменилась, пока вы её читали');
  await expect(alert).toBeFocused();
  await expect(cardOf(page, key)).toHaveAttribute('data-attention-actor', 'lead');
  await expect(cardOf(page, key).locator('[data-attention-unsent]')).toContainText(
    'Ответ из устаревшей вкладки.',
  );
  // В обсуждении ровно один ответ — из другой вкладки.
  const thread = (await (
    await request.get(`/api/tasks/${own.task}/discussion?limit=50`)
  ).json()) as {
    messages: { kind: string; text: string }[];
  };
  const answers = thread.messages.filter((m) => m.kind === 'answer');
  expect(answers.map((m) => m.text)).toEqual(['Ответ из другой вкладки.']);
});

test('D05-B: an already resolved card is removed and focus moves to the next card', async ({
  page,
}) => {
  await page.route(isList, (route) =>
    route.fulfill({ json: fakeView([fakeItem('changeset:CHG-1'), fakeItem('changeset:CHG-2')]) }),
  );
  await page.route('**/api/attention/act', (route) =>
    route.fulfill({
      status: 409,
      json: { error: 'Карточка уже решена исходной сущностью', code: 'attention-resolved' },
    }),
  );
  await page.goto('/?tab=attention');
  await cardOf(page, 'changeset:CHG-1')
    .getByRole('button', { name: 'Принять', exact: true })
    .click();
  await expect(cardOf(page, 'changeset:CHG-1')).toHaveCount(0);
  await expect(cardOf(page, 'changeset:CHG-2')).toBeFocused();
  await expect(liveStatus(page)).toContainText('Уже решено');
});

test('D05-E: a lead item never shows a domain button, even if one reaches the panel', async ({
  page,
}) => {
  // Сервер снимает доменные действия с карточек ведущего; панель — второй
  // рубеж: подменный ответ с действием у карточки ведущего не даёт кнопки.
  await page.route(isList, (route) =>
    route.fulfill({
      json: fakeView([
        fakeItem('workflow:changeset:CHG-L', {
          actor: 'lead',
          category: 'technical',
          title: 'Восстановление изменения остановлено',
          actions: [
            { id: 'accept', kind: 'domain', label: 'Принять', input: 'confirm' },
            { id: 'handoff', kind: 'handoff', command: 'session_handoff' },
          ],
        }),
      ]),
    }),
  );
  await page.goto('/?tab=attention&who=lead');
  const card = cardOf(page, 'workflow:changeset:CHG-L');
  await expect(card).toContainText('Ведущий агент · техническое');
  await expect(card.getByRole('button', { name: 'Принять', exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Команда для ведущего' })).toBeVisible();
});

test('D05-E: a lead technical blocker is not an operator choice, and reading is not acting', async ({
  page,
  request,
}) => {
  const ids = await ownTask(
    request,
    'Обращение к ведущему',
    'Наблюдаемый результат для обращения.',
  );
  const posted = (await (
    await request.post(`/api/tasks/${ids.task}/discussion`, {
      headers,
      data: {
        kind: 'change-request',
        text: 'Поменяйте порядок полей в отчёте.',
        expectedVersion: 0,
        idempotencyKey: 'attention-e-' + ids.task.slice(-12),
      },
    })
  ).json()) as { message: { id: string } };
  const key = `discussion:cr:${posted.message.id}`;
  await page.goto('/?tab=attention&who=lead');
  const leadGroup = center(page).getByRole('region', { name: /Разбирает ведущий агент/ });
  const card = leadGroup.locator(`article[data-attention-key="${key}"]`);
  await expect(card).toBeVisible();
  await expect(card).toContainText('Ведущий агент · техническое');
  await expect(card).toContainText('Ведущий агент разберёт это сам');
  await expect(card).not.toContainText('Ваше решение');
  await expect(card).not.toContainText('Вопрос к вам');
  // Только переход, команда передачи и отметки: никакой скрытой кнопки решения.
  const names = await card
    .getByRole('button')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent ?? ''));
  for (const name of names)
    expect(name).toMatch(
      /^(Команда для ведущего|Прочитано: |Увидел: |Доказательства и подробности)/,
    );
  await expect(card.getByRole('link', { name: 'Открыть задачу' })).toBeVisible();

  // Чтение — не действие: отметки не меняют тред, задачу и очередь.
  const before = {
    thread: (
      (await (await request.get(`/api/tasks/${ids.task}/discussion?limit=50`)).json()) as {
        version: number;
      }
    ).version,
    task: (await taskState(request, ids.task))?.status,
    paused: ((await (await request.get('/api/state')).json()) as { paused: boolean }).paused,
  };
  const writes: string[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET') writes.push(new URL(r.url()).pathname);
  });
  await card.getByRole('button', { name: /^Прочитано: / }).click();
  await expect(card).not.toContainText('новое');
  await card.getByRole('button', { name: /^Увидел: / }).click();
  await expect(card).toContainText('вы видели');
  await page.waitForTimeout(3500);
  await expect(card).toBeVisible();
  expect(new Set(writes)).toEqual(new Set(['/api/attention/marks']));
  const after = {
    thread: (
      (await (await request.get(`/api/tasks/${ids.task}/discussion?limit=50`)).json()) as {
        version: number;
      }
    ).version,
    task: (await taskState(request, ids.task))?.status,
    paused: ((await (await request.get('/api/state')).json()) as { paused: boolean }).paused,
  };
  expect(after).toEqual(before);

  // Обзор не выдаёт карточку ведущего за решение автора, но считает её.
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Нужно ваше решение', exact: true }),
  ).toBeVisible();
  await expect(page.locator(`[data-attention-key="${key}"]`)).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: /Ведущий агент разбирает технических вопросов: \d+/ }),
  ).toBeVisible();
  await page.goto('/?tab=attention&who=lead');

  // Ведущего нет на связи: предупреждение с командой передачи.
  await page.route(isList, async (route) => {
    const real = (await (await route.fetch()).json()) as Record<string, unknown>;
    await route.fulfill({ json: { ...real, lead: { present: false, lastActivityAt: null } } });
  });
  await expect(leadGroup.getByText('Нужен ведущий агент: ему есть что разобрать.')).toBeVisible();
  await expect(card).toContainText('сейчас не на связи');
});

test('D05-C: 390 px, long unbroken texts and accessibility of the queue, history and overview', async ({
  page,
}) => {
  const long = 'x'.repeat(300);
  const words = 'Очень длинная причина без переносов '.repeat(8) + long;
  const items = [
    fakeItem('input:R-long', {
      source: 'input',
      category: 'question',
      title: 'Исполнитель спрашивает ' + long,
      reason: words,
      impact: { tasks: 1, waiting: 120, boards: [], taskIds: [] },
      subject: { kind: 'request', id: 'R-long', href: '/?view=boards&tab=list&task=T-1#input' },
      evidence: [
        { kind: 'message', id: 'M-' + long, href: '/?view=boards&tab=list&task=T-1#dm-M' },
      ],
      actions: [
        {
          id: 'answer',
          kind: 'domain',
          label: 'Ответить',
          input: 'text+option',
          prompt: words,
          choices: [
            { id: 'a', label: 'Вариант ' + long, hint: words, recommended: true },
            { id: 'b', label: 'Другой ' + long },
          ],
        },
      ],
    }),
    fakeItem('changeset:CHG-' + 'y'.repeat(40), {
      title: 'Примите «' + long + '»',
      reason: words,
      actions: [
        {
          id: 'deploy-preview',
          kind: 'domain',
          label: 'Выложить в preview ' + long,
          input: 'confirm',
        },
        { id: 'accept', kind: 'domain', label: 'Принять', input: 'confirm' },
      ],
    }),
    fakeItem('work:T-' + 'z'.repeat(40), {
      source: 'work',
      category: 'technical',
      actor: 'lead',
      title: 'Задача «' + long + '» остановлена',
      reason: words,
      subject: { kind: 'task', id: 'T-1', href: '/?view=boards&tab=list&task=T-1' },
      actions: [{ id: 'handoff', kind: 'handoff', command: 'session_handoff ' + long }],
    }),
  ];
  const history = items.map((i, n) => ({
    ...i,
    id: i.sourceKey + '#h',
    actions: [],
    resolvedAt: n === 1 ? null : '2026-11-07T11:00:00.000Z',
  }));
  let offline = false;
  await page.route(isList, (route) => {
    if (offline) return route.abort('internetdisconnected');
    if (route.request().url().includes('view=history'))
      return route.fulfill({
        json: {
          revision: 1,
          generatedAt: new Date().toISOString(),
          engineConnected: true,
          items: history,
          truncated: { count: 3 },
        },
      });
    return route.fulfill({
      json: fakeView(items, {
        lead: { present: false, lastActivityAt: null },
        truncated: { count: 7 },
      }),
    });
  });
  const fits = async () => {
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const overflow = await page
      .locator('[aria-label="Центр внимания"] article')
      .evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
    expect(overflow).toBe(0);
  };
  const axe = async () =>
    expect(
      (await new AxeBuilder({ page }).include('[aria-label="Центр внимания"]').analyze())
        .violations,
    ).toEqual([]);

  await page.goto('/?tab=attention');
  const question = cardOf(page, 'input:R-long');
  await question.getByRole('button', { name: 'Ответить' }).click();
  await expect(question.locator('form').getByRole('radio')).toHaveCount(2);
  await question.getByText('Вопрос полностью').click();
  await question.getByText('Доказательства и подробности').click();
  await expect(center(page)).toContainText('Нужен ведущий агент');
  await expect(center(page)).toContainText('Показаны первые 3 из 10');
  await axe();
  await page.setViewportSize({ width: 390, height: 844 });
  await fits();
  await axe();

  // Нет связи: строка устаревания тоже переносится.
  offline = true;
  await expect(center(page).getByText(/Нет связи с сервером/)).toBeVisible();
  await fits();
  await axe();
  offline = false;

  await center(page).getByRole('tab', { name: 'История' }).click();
  await expect(center(page).getByRole('list', { name: 'История центра внимания' })).toBeVisible();
  await expect(center(page)).toContainText('Время закрытия не записано');
  await expect(center(page)).toContainText('Показаны последние 100');
  await fits();
  await axe();

  // Голова очереди в обзоре — те же карточки, компактно.
  await page.goto('/');
  await expect(page.getByRole('list', { name: 'Решения для вас' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('D05-D: one toast per new occurrence, none for heartbeats, updates or lead items; a second tab marks read', async ({
  page,
  context,
  request,
}) => {
  test.slow();
  // Счётчик вставленных уведомлений — до загрузки панели.
  await context.addInitScript(() => {
    const w = window as unknown as { __toasts: string[] };
    w.__toasts = [];
    new MutationObserver((records) => {
      for (const r of records)
        for (const node of r.addedNodes)
          if (node instanceof HTMLElement) {
            const toasts = node.matches('[data-sonner-toast]')
              ? [node]
              : [...node.querySelectorAll<HTMLElement>('[data-sonner-toast]')];
            for (const t of toasts) w.__toasts.push(t.textContent ?? '');
          }
    }).observe(document, { childList: true, subtree: true });
  });
  const toasts = (p: Page) =>
    p.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts);
  const cycles = (n: number) => page.waitForTimeout(n * 3200);

  // Начальная загрузка с уже существующими карточками и heartbeat — тишина
  // о них (демо общее: новая чужая карточка за это время может уведомить).
  const existing = (
    (await (await request.get('/api/attention')).json()) as { items: { title: string }[] }
  ).items.map((i) => i.title);
  expect(existing.length).toBeGreaterThan(0);
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Нужно ваше решение', exact: true }),
  ).toBeVisible();
  await cycles(3);
  for (const text of await toasts(page))
    for (const old of existing) expect(text).not.toContain(old);

  // Новое появление карточки оператора — ровно одно уведомление.
  const own = await askingTask(request, 'Уведомление о новом вопросе');
  const key = `input:${own.requestId}`;
  // Демо общее: считаются уведомления, которые называют свою карточку
  // (несколько новых карточек — одно уведомление с их названиями).
  const title = 'Уведомление о новом вопросе';
  const ours = async (p: Page) => (await toasts(p)).filter((t) => t.includes(title));
  await expect.poll(async () => (await ours(page)).length, { timeout: 15000 }).toBe(1);
  expect((await ours(page))[0]).toMatch(/Нужно действие: |Новых действий: /);
  await cycles(3);
  expect((await ours(page)).length).toBe(1);

  // Вторая вкладка отмечает карточку прочитанной: значок первой падает после
  // штатного опроса, новых уведомлений нет ни в одной.
  const badge = page
    .getByRole('navigation', { name: 'Workspace' })
    .locator('[data-attention-count]');
  const before = Number((await badge.getAttribute('data-attention-count')) ?? '0');
  expect(before).toBeGreaterThan(0);
  const second = await context.newPage();
  await second.goto('/?tab=attention');
  await second
    .locator(`article[data-attention-key="${key}"]`)
    .getByRole('button', { name: /^Прочитано: / })
    .click();
  await expect(second.locator(`article[data-attention-key="${key}"]`)).not.toContainText('новое');
  if (before > 1)
    await expect(badge).toHaveAttribute('data-attention-count', String(before - 1), {
      timeout: 7000,
    });
  else await expect(badge).toHaveCount(0, { timeout: 7000 });
  expect((await ours(page)).length).toBe(1);
  expect(await ours(second)).toEqual([]);

  // Существенное обновление того же появления (ответ, затем исправление
  // ответа) и переход карточки к ведущему — без уведомлений.
  const input = async () =>
    (await (await request.get(`/api/tasks/${own.task}/input`)).json()) as {
      current: { version: number; answers: { messageRef?: string }[] };
    };
  const first = await request.post(`/api/tasks/${own.task}/input/${own.requestId}/answer`, {
    headers,
    data: {
      text: 'Первый ответ.',
      optionId: 'json',
      kind: 'clarification',
      expectedVersion: (await input()).current.version,
      idempotencyKey: 'toast-1-' + own.requestId.slice(-12),
    },
  });
  expect(first.ok(), await first.text()).toBe(true);
  const saved = await input();
  const corrected = await request.post(`/api/tasks/${own.task}/input/${own.requestId}/answer`, {
    headers,
    data: {
      text: 'Исправленный ответ.',
      optionId: 'json',
      kind: 'clarification',
      expectedVersion: saved.current.version,
      idempotencyKey: 'toast-2-' + own.requestId.slice(-12),
      ...(saved.current.answers.at(-1)?.messageRef
        ? { supersedes: saved.current.answers.at(-1)!.messageRef }
        : {}),
    },
  });
  expect(corrected.ok(), await corrected.text()).toBe(true);
  await cycles(3);
  expect((await ours(page)).length).toBe(1);
  expect(await ours(second)).toEqual([]);
  await second.close();
});

/* ------------------------------------------------------------------ */
/* Round 1: версия под открытой формой, исчезнувшая карточка, фокус     */
/* после отметок, «Открыть» уведомления, «Отметить всё», глубокие ссылки */
/* ------------------------------------------------------------------ */

/** Своя задача, обращение оператора и «нужен ответ» ведущего: карточка оператора S8. */
async function needsAnswer(request: APIRequestContext, title: string) {
  const ids = await ownTask(request, title, 'Наблюдаемый результат для обращения.');
  const posted = (await (
    await request.post(`/api/tasks/${ids.task}/discussion`, {
      headers,
      data: {
        kind: 'change-request',
        text: 'Добавьте экспорт отчёта.',
        expectedVersion: 0,
        idempotencyKey: 'na-cr-' + ids.task.slice(-12),
      },
    })
  ).json()) as { message: { id: string } };
  const inbox = (await agent(request, 'discussion_inbox', {})) as {
    requests: { id: string; taskId: string; version: number }[];
  };
  const pending = inbox.requests.find((r) => r.taskId === ids.task)!;
  await agent(request, 'discussion_resolve', {
    requestId: pending.id,
    outcome: 'needs-answer',
    reason: 'В каком формате экспорт?',
    idempotencyKey: 'na-res-' + ids.task.slice(-12),
    expectedVersion: pending.version,
  });
  return { ...ids, key: `discussion:na:${posted.message.id}`, title };
}
async function threadOf(request: APIRequestContext, taskId: string) {
  return (await (await request.get(`/api/tasks/${taskId}/discussion?limit=50`)).json()) as {
    version: number;
    messages: { author: string; kind: string; text: string }[];
  };
}
/** Ведущий дополняет обсуждение: версия карточки «нужен ответ» меняется, она остаётся у оператора. */
async function leadNote(request: APIRequestContext, taskId: string, text: string, n: number) {
  await agent(request, 'discussion_post', {
    taskId,
    kind: 'note',
    text,
    idempotencyKey: `lead-note-${n}-` + taskId.slice(-12),
    expectedVersion: (await threadOf(request, taskId)).version,
  });
}

test('B1/M4: a poll that changes the card under an open form never retargets it; toast «Открыть»; keyboard marks; a material update stays silent', async ({
  page,
  context,
  request,
}) => {
  test.slow();
  await context.addInitScript(() => {
    const w = window as unknown as { __toasts: string[] };
    w.__toasts = [];
    new MutationObserver((records) => {
      for (const r of records)
        for (const node of r.addedNodes)
          if (node instanceof HTMLElement) {
            const toasts = node.matches('[data-sonner-toast]')
              ? [node]
              : [...node.querySelectorAll<HTMLElement>('[data-sonner-toast]')];
            for (const t of toasts) w.__toasts.push(t.textContent ?? '');
          }
    }).observe(document, { childList: true, subtree: true });
  });
  const title = 'Версия под открытой формой';
  const ours = async () =>
    (await page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts)).filter(
      (t) => t.includes(title),
    );
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Нужно ваше решение', exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(3500);
  const own = await needsAnswer(request, title);

  // Новое появление вне экрана внимания — одно уведомление; «Открыть» ведёт к карточке.
  await expect.poll(async () => (await ours()).length, { timeout: 15000 }).toBe(1);
  await page
    .locator('[data-sonner-toast]')
    .filter({ hasText: title })
    .getByRole('button', { name: 'Открыть' })
    .click();
  await expect(page).toHaveURL(/tab=attention/);
  const card = cardOf(page, own.key);
  await expect(card).toBeFocused();
  await expect(card).toContainText('новое');

  // Отметки с клавиатуры: фокус не падает на body.
  await card.getByRole('button', { name: /^Прочитано: / }).focus();
  await page.keyboard.press('Enter');
  await expect(card.getByRole('button', { name: /^Увидел: / })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card).toBeFocused();
  await expect(card).toContainText('вы видели');

  // Существенное обновление вне экрана: карточка остаётся у оператора,
  // снова «новое», уведомления нет.
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('link', { name: 'Обзор' })
    .click();
  await leadNote(request, own.task, 'Уточнение ведущего: экспорт нужен ежедневно.', 1);
  await page.waitForTimeout(3 * 3200);
  expect((await ours()).length).toBe(1);
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('link', { name: /Внимание/ })
    .click();
  await expect(card).toContainText('новое');
  await expect(card).toHaveAttribute('data-attention-actor', 'operator');

  // Форма открыта, текст набран; ведущий снова дополняет обсуждение — опрос
  // (не заморожен) приносит новую версию. Форма не отправляется под ней.
  await card.getByRole('button', { name: 'Ответить' }).click();
  const form = card.locator('form');
  await form.getByLabel(/Ваш ответ/).fill('Ответ на первую версию.');
  await leadNote(request, own.task, 'Ещё уточнение ведущего.', 2);
  const changed = card.locator('[data-attention-changed]');
  await expect(changed).toContainText('Карточка изменилась, пока вы писали', { timeout: 10000 });
  await expect(form.getByRole('button', { name: 'Ответить' })).toBeDisabled();
  await expect(form.getByLabel(/Ваш ответ/)).toHaveValue('Ответ на первую версию.');
  const operatorNotes = async () =>
    (await threadOf(request, own.task)).messages.filter(
      (m) => m.author === 'operator' && m.kind === 'note',
    );
  expect(await operatorNotes()).toEqual([]);
  // Esc и повторное открытие не обходят выбор: версия, пришедшая, пока
  // форма закрыта, снова показывает «Карточка изменилась».
  await form.getByLabel(/Ваш ответ/).focus();
  await page.keyboard.press('Escape');
  await expect(form).toHaveCount(0);
  const versionOf = async () =>
    (
      (await (await request.get('/api/attention')).json()) as {
        items: { sourceKey: string; sourceVersion: string }[];
      }
    ).items.find((i) => i.sourceKey === own.key)?.sourceVersion;
  const before = await versionOf();
  await leadNote(request, own.task, 'Третье уточнение ведущего.', 3);
  await expect.poll(versionOf).not.toBe(before);
  await page.waitForTimeout(3500);
  await card.getByRole('button', { name: 'Ответить' }).click();
  await expect(changed).toBeVisible();
  await expect(form.getByRole('button', { name: 'Ответить' })).toBeDisabled();
  await expect(form.getByLabel(/Ваш ответ/)).toHaveValue('Ответ на первую версию.');
  expect(await operatorNotes()).toEqual([]);
  // Явный выбор новой версии с клавиатуры: фокус — в поле ответа, затем отправка.
  await changed.getByRole('button', { name: 'Ответить на новую версию' }).focus();
  await page.keyboard.press('Enter');
  await expect(form.getByLabel(/Ваш ответ/)).toBeFocused();
  await page.keyboard.press('Control+Enter');
  await expect(liveStatus(page)).toContainText('Ответ отправлен ведущему агенту');
  expect((await operatorNotes()).map((m) => m.text)).toEqual(['Ответ на первую версию.']);
});

test('M1 (r2): a new occurrence under an open form keeps the text, focuses it and says why', async ({
  page,
  request,
}) => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-ui-attention-occurrence-'));
  const app = await startWorkspace(join(root, 'workspace'), { port: 0, workspaceMode: 'embedded' });
  try {
    await agent(request, 'preparation_create', { title: 'Новая редакция под формой' }, app.url);
    const changeId = String(
      (await agent(request, 'preparation_status', {}, app.url)).activeChangeId,
    );
    const revise = async (expectedDigest: string | null, content: unknown) =>
      (await agent(
        request,
        'preparation_product',
        { changeId, expectedDigest, reason: 'Постановка', content },
        app.url,
      )) as { current: { product: { digest: string } } };
    const first = await revise(null, product);
    await agent(
      request,
      'preparation_submit',
      { changeId, stage: 'product', expectedDigest: first.current.product.digest },
      app.url,
    );
    const key = `prep:stage:${changeId}:product`;
    await page.goto(app.url + '/?view=attention');
    const card = cardOf(page, key);
    await card.getByRole('button', { name: 'Вернуть на доработку' }).click();
    await card
      .locator('form')
      .getByLabel(/Что доработать/)
      .fill('Уточните сценарий модерации.');
    // Новая редакция и её отправка — между двумя опросами (опрос на это
    // время отдаёт прежний ответ), затем опрос снова живой.
    const frozen = (await (await request.get(app.url + '/api/attention')).json()) as unknown;
    await page.route(isList, (route) => route.fulfill({ json: frozen }));
    const second = await revise(first.current.product.digest, {
      ...product,
      outcome: `${String(product.outcome)} Уточнено.`,
    });
    await agent(
      request,
      'preparation_submit',
      { changeId, stage: 'product', expectedDigest: second.current.product.digest },
      app.url,
    );
    await page.unroute(isList);
    const unsent = page.getByRole('group', { name: 'Ваш неотправленный текст' });
    await expect(unsent).toBeFocused({ timeout: 10000 });
    await expect(unsent.locator('[data-attention-unsent]')).toHaveText(
      'Уточните сценарий модерации.',
    );
    await expect(liveStatus(page)).toContainText('Появилась новая редакция');
    // Карточка новой редакции — без формы прежней.
    await expect(card.locator('form')).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Вернуть на доработку' })).toBeVisible();
  } finally {
    await app.close();
    if (root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true });
  }
});

test('M1: a card removed by a poll under an open form keeps the text read-only, with focus on it', async ({
  page,
  request,
}) => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-ui-attention-unsent-'));
  const app = await startWorkspace(join(root, 'workspace'), { port: 0, workspaceMode: 'embedded' });
  try {
    await agent(request, 'preparation_create', { title: 'Неотправленный ответ' }, app.url);
    const changeId = String(
      (await agent(request, 'preparation_status', {}, app.url)).activeChangeId,
    );
    await agent(
      request,
      'preparation_question',
      { changeId, stage: 'product', add: [{ text: 'Кто получает отчёт?', options: [] }] },
      app.url,
    );
    await page.goto(app.url + '/?view=attention');
    const card = page.locator(`article[data-attention-key^="prep:q:${changeId}:"]`);
    await card.getByRole('button', { name: 'Ответить' }).click();
    await card
      .locator('form')
      .getByLabel(/Ваш ответ/)
      .fill('Руководитель отдела продаж.');
    // Ответ из другой вкладки решает вопрос; опрос убирает карточку.
    const items = (
      (await (await request.get(app.url + '/api/attention')).json()) as {
        items: { sourceKey: string; occurrenceId: string; sourceVersion: string }[];
      }
    ).items;
    const q = items.find((i) => i.sourceKey.startsWith(`prep:q:${changeId}:`))!;
    const answered = await request.post(app.url + '/api/attention/act', {
      headers,
      data: {
        sourceKey: q.sourceKey,
        occurrenceId: q.occurrenceId,
        expectedVersion: q.sourceVersion,
        action: 'answer',
        input: { text: 'Ответ из другой вкладки.' },
      },
    });
    expect(answered.ok(), await answered.text()).toBe(true);
    await expect(card).toHaveCount(0, { timeout: 10000 });
    const unsent = page.getByRole('group', { name: 'Ваш неотправленный текст' });
    await expect(unsent).toBeFocused();
    await expect(unsent).toContainText('решена или снята без вашего ответа');
    await expect(unsent.locator('[data-attention-unsent]')).toHaveText(
      'Руководитель отдела продаж.',
    );
    await unsent.getByRole('button', { name: 'Убрать текст' }).click();
    await expect(unsent).toHaveCount(0);

    // M3: выбор изменения в боковой навигации закрывает центр внимания.
    await page.getByRole('link', { name: /Нужно действие/ }).click();
    await expect(page.getByRole('heading', { name: 'Внимание', exact: true })).toBeFocused();
    await page
      .getByRole('navigation', { name: 'Изменения продукта' })
      .getByRole('button', { name: /Неотправленный ответ/ })
      .click();
    await expect(page.locator('[aria-label="Центр внимания"]')).toHaveCount(0);
    await expect(page).not.toHaveURL(/view=attention/);
    await expect(page.getByRole('list', { name: 'Этапы изменения' })).toBeVisible();
  } finally {
    await app.close();
    if (root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true });
  }
});

test('M2: «Отметить всё прочитанным» marks only the shown operator items and focuses the group heading', async ({
  page,
}) => {
  const items = [
    fakeItem('changeset:CHG-M1'),
    fakeItem('changeset:CHG-M2'),
    fakeItem('work:T-LEAD', { actor: 'lead', category: 'technical', actions: [] }),
  ];
  const sent: { sourceKey: string }[] = [];
  await page.route(isList, (route) => route.fulfill({ json: fakeView(items) }));
  await page.route('**/api/attention/marks', async (route) => {
    const body = route.request().postDataJSON() as { marks: { sourceKey: string }[] };
    sent.push(...body.marks);
    for (const m of body.marks) {
      const i = items.find((x) => x.sourceKey === m.sourceKey)!;
      i.state = { read: true, acknowledged: false, unread: false };
    }
    await route.fulfill({
      json: { marked: body.marks, ignored: [] },
    });
  });
  await page.goto('/?tab=attention');
  const markAll = center(page).getByRole('button', { name: 'Отметить всё прочитанным' });
  await markAll.focus();
  await page.keyboard.press('Enter');
  await expect(center(page).getByRole('heading', { name: /Нужно ваше действие/ })).toBeFocused();
  await expect(markAll).toHaveCount(0);
  expect(sent.map((m) => m.sourceKey).sort()).toEqual(['changeset:CHG-M1', 'changeset:CHG-M2']);
});

test('M4: deep links reach the discussion message and the change', async ({ page, request }) => {
  const ids = await ownTask(request, 'Глубокие ссылки', 'Наблюдаемый результат для ссылок.');
  const posted = (await (
    await request.post(`/api/tasks/${ids.task}/discussion`, {
      headers,
      data: {
        kind: 'change-request',
        text: 'Сообщение для ссылки.',
        expectedVersion: 0,
        idempotencyKey: 'deep-link-' + ids.task.slice(-12),
      },
    })
  ).json()) as { message: { id: string } };
  await page.goto('/?tab=attention&who=lead');
  await cardOf(page, `discussion:cr:${posted.message.id}`)
    .getByRole('link', { name: 'Открыть задачу' })
    .click();
  await expect(page.locator(`#dm-${posted.message.id}`)).toBeFocused();

  // Карточка изменения ведёт к его записи на экране изменений.
  const change = (await (
    await request.post('/api/changesets', {
      headers,
      data: { title: 'Глубокая ссылка', description: 'Проверка ссылки', boardIds: [ids.board] },
    })
  ).json()) as { id: string };
  const href = `/?view=boards&tab=changesets#changeset-${change.id}`;
  await page.route(isList, (route) =>
    route.fulfill({
      json: fakeView([
        fakeItem(`changeset:${change.id}`, {
          subject: { kind: 'changeset', id: change.id, href },
        }),
      ]),
    }),
  );
  await page.goto('/?tab=attention');
  await cardOf(page, `changeset:${change.id}`)
    .getByRole('link', { name: 'Открыть изменения' })
    .click();
  await expect(page.locator(`[id="changeset-${change.id}"]`)).toBeFocused();
});

// Карточка с текстовым действием (форма с полем «Что доработать»).
const textItem = (key: string, over: Record<string, unknown> = {}) =>
  fakeItem(key, {
    actions: [
      { id: 'request-changes', kind: 'domain', label: 'Вернуть на доработку', input: 'text' },
      { id: 'open', kind: 'navigate', href: '/?view=boards&tab=changesets' },
    ],
    ...over,
  });

/** Второй репозиторий в сводке: на экране внимания появляется фильтр компонента. */
async function withSecondComponent(page: Page) {
  await page.route(
    (url) => url.pathname === '/api/summary',
    async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        config?: { repositories: Record<string, unknown>[] };
      };
      if (body.config && body.config.repositories.length === 1)
        body.config.repositories.push({
          ...body.config.repositories[0],
          id: 'second',
          name: 'Второй компонент',
        });
      await route.fulfill({ response, json: body });
    },
  );
}

test('Filter: an empty form opened on a card the component filter saw first stays open', async ({
  page,
}) => {
  await withSecondComponent(page);
  // Ответ фильтра опережает общий опрос: в общем списке карточки ещё нет.
  await page.route(isList, (route) =>
    route.fulfill({
      json: fakeView(
        new URL(route.request().url()).searchParams.get('component') === 'second'
          ? [textItem('changeset:CHG-F1')]
          : [],
      ),
    }),
  );
  await page.goto('/?tab=attention');
  await center(page).getByLabel('Компонент').selectOption('second');
  const card = cardOf(page, 'changeset:CHG-F1');
  await card.getByRole('button', { name: 'Вернуть на доработку' }).click();
  const field = card.locator('form').getByLabel(/Что доработать/);
  await expect(field).toBeFocused();
  // Следующий опрос не закрывает пустую форму показанной карточки.
  await page.waitForTimeout(3500);
  await expect(field).toBeFocused();
});

test('Focus: a new occurrence under an open empty form focuses the new card', async ({ page }) => {
  let occurrence = 'o1';
  await page.route(isList, (route) =>
    route.fulfill({
      json: fakeView([
        textItem('changeset:CHG-N1', {
          id: `changeset:CHG-N1#${occurrence}`,
          occurrenceId: occurrence,
        }),
        fakeItem('changeset:CHG-N2'),
      ]),
    }),
  );
  await page.goto('/?tab=attention');
  const card = cardOf(page, 'changeset:CHG-N1');
  await card.getByRole('button', { name: 'Вернуть на доработку' }).click();
  await expect(card.locator('form').getByLabel(/Что доработать/)).toBeFocused();
  occurrence = 'o2';
  await expect(card.locator('form')).toHaveCount(0, { timeout: 10000 });
  await expect(card).toBeFocused();
});

test('Filter: an error of the previous component is not shown after choosing another one', async ({
  page,
}) => {
  await withSecondComponent(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(isList, async (route) => {
    const component = new URL(route.request().url()).searchParams.get('component');
    if (component === 'main')
      return route.fulfill({ status: 500, json: { error: 'Сбой компонента main' } });
    if (component === 'second') await held;
    return route.fulfill({ json: fakeView([fakeItem('changeset:CHG-E1')]) });
  });
  await page.goto('/?tab=attention');
  const select = center(page).getByLabel('Компонент');
  await select.selectOption('main');
  const error = center(page).getByRole('alert').filter({ hasText: 'Сбой компонента main' });
  await expect(error).toBeVisible();
  await select.selectOption('second');
  // Ответ второго компонента задержан; проверка — раньше его тайм-аута (10 с),
  // который сам заменил бы текст ошибки.
  await expect(
    center(page).getByRole('heading', { name: 'Загружаем карточки компонента…' }),
  ).toBeVisible({ timeout: 3000 });
  await expect(
    center(page).getByRole('alert').filter({ hasText: 'Не удалось загрузить карточки компонента' }),
  ).toHaveCount(0, { timeout: 3000 });
  release();
  await expect(cardOf(page, 'changeset:CHG-E1')).toBeVisible();
});
