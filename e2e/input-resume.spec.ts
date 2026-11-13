import { test, expect, type APIRequestContext } from '@playwright/test';
import { useLiveCliGuard } from './live-cli-guard.ts';
import { ownDemo } from './fixtures/own-demo.ts';

// Продолжение после ответа (режим agent): оператор отвечает в карточке
// задачи, и сервер сам доводит ответ — ревью (demo, fixture, не модель),
// цель, применение — без сессии ведущего. Карточка называет фазу прохода
// («Ответ принят — DevContour продолжает: …»), а остановку прохода — с тем,
// кто нужен. Фазы, которые сервер проходит за доли секунды, показывает
// подмена ответа `/api/tasks/:id/input`.

// Живые claude и codex под запретом: вызов из demo-пути роняет тест.
useLiveCliGuard();

const headers = { 'X-DevContour-Request': '1' };

async function agent(request: APIRequestContext, base: string, operation: string, input: unknown) {
  const response = await request.post(base + '/api/agent', { headers, data: { operation, input } });
  const body = (await response.json()) as Record<string, unknown>;
  expect(response.ok(), JSON.stringify(body)).toBe(true);
  return body;
}

test.describe('Continuation after an answer', () => {
  test.describe.configure({ mode: 'serial' });
  let demo: Awaited<ReturnType<typeof ownDemo>>;
  test.beforeAll(async () => {
    test.setTimeout(120000);
    demo = await ownDemo('input-resume');
  });
  test.afterAll(async () => {
    await demo?.close();
  });

  test('The task card names the server pass and its stop; the answer is applied without the lead', async ({
    page,
    request,
  }) => {
    test.slow();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const base = demo.url;
    const board = (await (
      await request.post(base + '/api/boards', { headers, data: { title: 'Продолжение' } })
    ).json()) as { id: string };
    const task = (await (
      await request.post(`${base}/api/boards/${board.id}/tasks`, {
        headers,
        data: {
          title: 'Продолжение после ответа',
          description: 'Наблюдаемый результат, для которого нужно решение [demo:ask-product].',
          role: 'qa',
          repositoryId: 'main',
          acceptance: ['Результат проходит независимую проверку.'],
          dependsOn: [],
          contracts: [],
        },
      })
    ).json()) as { id: string };
    expect(
      (await request.post(`${base}/api/boards/${board.id}/approve`, { headers, data: {} })).ok(),
    ).toBe(true);
    expect(
      (await request.post(base + '/api/scheduler', { headers, data: { start: true } })).ok(),
    ).toBe(true);
    await expect
      .poll(
        async () =>
          ((await agent(request, base, 'input_list', { taskId: task.id })) as { requests: [] })
            .requests.length,
        { timeout: 120000 },
      )
      .toBe(1);
    // Пауза держит выдачу, но не продолжение ответа.
    expect(
      (await request.post(base + '/api/scheduler', { headers, data: { start: false } })).ok(),
    ).toBe(true);

    // Фазы прохода словами оператора (подмена ответа карточки).
    let phase: Record<string, unknown> | undefined;
    await page.route(`**/api/tasks/${task.id}/input`, async (route) => {
      const response = await route.fetch();
      const view = (await response.json()) as { current: Record<string, unknown> | null };
      if (!phase || !view.current) return route.fulfill({ response, json: view });
      return route.fulfill({
        response,
        json: { ...view, current: { ...view.current, state: 'answer-saved', resume: phase } },
      });
    });
    phase = { phase: 'reviewing', auto: true, trigger: 'operator' };
    await page.goto(`${base}/?tab=list&board=${board.id}&task=${task.id}`);
    const card = page
      .getByRole('complementary', { name: 'Детали задачи' })
      .getByRole('region', { name: 'Вопрос исполнителя' });
    const line = card.locator('[data-input-resume]');
    await expect(line).toHaveAttribute('data-input-resume', 'reviewing');
    await expect(line).toHaveText(
      'Ответ принят — DevContour продолжает: проверка ответа (независимое ревью)',
    );
    // Строка «Дальше» с указанием ведущему не дублирует проход.
    await expect(card.locator('[data-input-next]')).toHaveCount(0);
    phase = {
      phase: 'failed',
      auto: false,
      trigger: 'operator',
      detail: 'reviewer is unavailable',
    };
    await expect(line).toHaveAttribute('data-input-resume', 'failed');
    await expect(line).toContainText('DevContour не смог проверить ответ: reviewer is unavailable');
    await expect(line).toContainText('Нужен ведущий агент');
    phase = undefined;
    await page.unroute(`**/api/tasks/${task.id}/input`);

    // Настоящий проход: ответ оператора применяется без сессии ведущего.
    await page.reload();
    await expect(card).toContainText('Нужен ответ');
    await card.getByLabel('JSON').check();
    await card.getByLabel('Ответ исполнителю').fill('Оставьте JSON, как в контракте.');
    await card.getByRole('button', { name: 'Сохранить ответ' }).click();
    await expect(card).toContainText('Ответ применён, ждёт попытки');
    await expect(line).toHaveCount(0);
    const { requests } = (await agent(request, base, 'input_list', { taskId: task.id })) as {
      requests: { state: string }[];
    };
    expect(requests[0].state).toBe('applied-awaiting-claim');
    expect(errors).toEqual([]);
  });
});
