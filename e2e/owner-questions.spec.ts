import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspace } from '../src/runner/start.ts';

// Вопрос владельцу продуктового раздела: виден и отвечается на вкладке
// «Продукт» оболочки подготовки, рекомендованный вариант выделен, ответ —
// выбранный вариант; вопрос разработки на вкладке продукта не показан.

const headers = { 'X-DevContour-Request': '1' };

test('Owner question: answered in the product section with the recommended option highlighted', async ({
  page,
  request,
}) => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-ui-owner-q-'));
  const app = await startWorkspace(join(root, 'workspace'), { port: 0, workspaceMode: 'embedded' });
  const agent = async (operation: string, input: unknown = {}) => {
    const response = await request.post(app.url + '/api/agent', {
      headers,
      data: { operation, input },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return (await response.json()) as Record<string, unknown>;
  };
  try {
    await agent('preparation_create', { title: 'Каталог тренировок' });
    const changeId = String((await agent('preparation_status')).activeChangeId);
    const asked = (await agent('preparation_question', {
      changeId,
      add: [
        {
          text: 'Обещаем ли подбор программы по целям?',
          why: 'Критерий приёмки первого релиза',
          section: 'product',
          choices: [
            { label: 'Обещаем в первом релизе', consequence: 'Ещё две задачи до релиза' },
            { label: 'Убираем из постановки', consequence: 'Критерий переносится в следующий' },
          ],
          recommended: 1,
        },
        { text: 'Какой линтер ставить в репозиторий?', section: 'development' },
      ],
    })) as { questions: { id: string }[] };
    const [productQ, devQ] = asked.questions.map((q) => q.id);

    // Карточка центра внимания знает раздел и рекомендацию.
    const attention = (await (await request.get(app.url + '/api/attention')).json()) as {
      items: {
        sourceKey: string;
        section: string;
        actions: { id: string; choices?: { recommended?: boolean }[] }[];
      }[];
      counts: { bySection: Record<string, { operator: number }> };
    };
    const card = attention.items.find((i) => i.sourceKey === `prep:q:${changeId}:${productQ}`)!;
    expect(card.section).toBe('product');
    expect(card.actions.find((a) => a.id === 'answer')?.choices?.[1]?.recommended).toBe(true);
    expect(attention.counts.bySection.product.operator).toBe(1);
    expect(attention.counts.bySection.development.operator).toBe(1);

    await page.goto(`${app.url}/?change=${changeId}&stage=product#questions-product`);
    const block = page.locator('#questions-product');
    const question = page.locator(`li[data-question="${productQ}"]`);
    await expect(question).toContainText('Обещаем ли подбор программы по целям?');
    await expect(question).toContainText('Ещё две задачи до релиза');
    // Вопрос разработки — не в продуктовом разделе.
    await expect(page.locator(`li[data-question="${devQ}"]`)).toHaveCount(0);
    const recommended = question.locator('label[data-recommended]');
    await expect(recommended).toHaveCount(1);
    await expect(recommended).toContainText('Убираем из постановки');
    await expect(recommended).toContainText('Рекомендация ведущего');
    const submit = question.getByRole('button', { name: 'Ответить' });
    await expect(submit).toBeDisabled();
    // Владелец выбирает не рекомендацию: ответ — его выбор, а не рекомендация.
    await question
      .locator('label', { hasText: 'Обещаем в первом релизе' })
      .getByRole('radio')
      .check();
    await submit.click();
    await expect(question).toContainText('Отвечено');
    await expect(question).toContainText('Ваш ответ');
    await expect(block).toContainText('Обещаем в первом релизе');

    const status = (await agent('preparation_status', { changeId })) as {
      current: {
        questions: { id: string; status: string; answer?: { choice?: number; text: string } }[];
      };
    };
    const saved = status.current.questions.find((q) => q.id === productQ)!;
    expect(saved.status).toBe('answered');
    expect(saved.answer).toMatchObject({ choice: 0, text: 'Обещаем в первом релизе' });

    // Вопрос разработки отвечается на вкладке «Разработка».
    await page.goto(`${app.url}/?change=${changeId}&stage=development#questions-development`);
    const dev = page.locator(`li[data-question="${devQ}"]`);
    await expect(dev).toContainText('Какой линтер ставить в репозиторий?');
    await dev.getByLabel('Ваш ответ').fill('ESLint с конфигурацией проекта');
    await dev.getByRole('button', { name: 'Ответить' }).click();
    await expect(dev).toContainText('Отвечено');
    await expect(dev).toContainText('ESLint с конфигурацией проекта');
    // Решение ведущего по вопросу разработки видно в том же разделе.
    await agent('preparation_resolve', {
      changeId,
      questionId: devQ,
      statement: 'Ставим ESLint с конфигурацией проекта',
      rationale: 'Ответ владельца',
    });
    await page.reload();
    await expect(page.locator('#decisions-development')).toContainText(
      'Ставим ESLint с конфигурацией проекта',
    );
  } finally {
    await app.close();
    if (root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true });
  }
});
