import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspace } from '../src/runner/start.ts';
import { product, architecture } from '../tests/preparation-fixture.ts';

test('An empty workspace shows live product review, C1/C2 and separate operator approvals', async ({
  page,
  request,
}) => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-ui-stages-'));
  const app = await startWorkspace(join(root, 'workspace'), { port: 0, workspaceMode: 'embedded' });
  const send = async (operation: string, input: unknown) => {
    const response = await request.post(app.url + '/api/agent', {
      headers: { 'X-DevContour-Request': '1' },
      data: { operation, input },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  try {
    await page.goto(app.url);
    await expect(page.getByRole('heading', { name: 'От запроса к разработке' })).toBeVisible();
    await expect(page.getByText('Внутри репозитория', { exact: true })).toBeVisible();
    await page.getByLabel('Новое изменение').fill('Модерация чата');
    await page.getByRole('button', { name: 'Создать изменение', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Модерация чата' })).toBeVisible();
    const current = await (await request.get(app.url + '/api/preparation')).json();
    const changeId = current.current.id;
    const draft = await send('preparation_product', {
      changeId,
      expectedDigest: null,
      reason: 'Сценарии подготовлены',
      content: product,
    });
    await send('preparation_submit', {
      changeId,
      stage: 'product',
      expectedDigest: draft.current.product.digest,
    });
    await expect(
      page.getByRole('heading', { name: 'Утвердить продуктовую постановку' }),
    ).toBeVisible();
    await expect(page.getByText(product.problem, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Утвердить версию 1', exact: true }).click();
    await page.getByRole('button', { name: /2 Архитектура и стек/ }).click();
    await expect(
      page.getByText('Агент готовит архитектуру, сравнение стеков и диаграммы C1/C2.'),
    ).toBeVisible();
    const arch = await send('preparation_architecture', {
      changeId,
      expectedDigest: null,
      reason: 'Выбраны границы и технологии',
      content: architecture,
    });
    await send('preparation_submit', {
      changeId,
      stage: 'architecture',
      expectedDigest: arch.current.architecture.digest,
    });
    await expect(
      page.getByRole('heading', { name: 'Утвердить архитектуру и стек', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.c4-figure')).toHaveCount(2);

    await expect(page.locator('.c4-element').filter({ hasText: 'База чата' })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: 'test-results/preparation-architecture.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.getByLabel('Комментарий к решению').fill('Уточнить стратегию контрактных тестов');
    await page.getByRole('button', { name: 'Вернуть на доработку', exact: true }).click();
    await expect(
      page.getByText('Уточнить стратегию контрактных тестов', { exact: true }).first(),
    ).toBeVisible();
    const updated = await send('preparation_architecture', {
      changeId,
      expectedDigest: arch.current.architecture.digest,
      reason: 'Контрактные тесты уточнены',
      content: architecture,
    });
    await send('preparation_submit', {
      changeId,
      stage: 'architecture',
      expectedDigest: updated.current.architecture.digest,
    });
    await page.getByRole('button', { name: 'Утвердить версию 2', exact: true }).click();
    await page.getByRole('button', { name: /3 Разработка/ }).click();
    await expect(
      page.getByRole('heading', { name: 'Постановка и архитектура утверждены' }),
    ).toBeVisible();
    await expect(page.getByText(/Агент готовит репозитории, профили/)).toBeVisible();
    expect((await (await request.get(app.url + '/api/preparation')).json()).developmentReady).toBe(
      true,
    );

    // Architecture blocks edit in place, and sub-items are added and removed.
    await page.getByRole('button', { name: /2 Архитектура и стек/ }).click();
    const before = (await (await request.get(app.url + '/api/preparation')).json()).current
      .architecture.number;
    const stack = page.locator('#section-stack');
    await stack.getByRole('button', { name: 'Изменить' }).click();
    await stack.getByRole('button', { name: 'Добавить строку стека' }).click();
    await stack.getByLabel('Область').last().fill('Очередь задач');
    await stack.getByLabel('Выбор').last().fill('pg-boss поверх Postgres');
    await stack
      .getByLabel('Почему')
      .last()
      .fill('Не заводим второе хранилище ради редких публикаций.');
    await stack.getByLabel('Альтернативы').last().fill('Redis — лишняя зависимость на этом этапе.');
    await stack.getByRole('button', { name: 'Сохранить как новую версию' }).click();
    await expect(page.getByText('pg-boss поверх Postgres')).toBeVisible();
    const withStack = await (await request.get(app.url + '/api/preparation')).json();
    expect(withStack.current.architecture.number).toBe(before + 1);
    expect(
      withStack.current.architecture.content.stack.some(
        (s: { area: string }) => s.area === 'Очередь задач',
      ),
    ).toBe(true);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('The operator edits a section in the panel and the change reaches state and files', async ({
  page,
  request,
}) => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-ui-edit-'));
  const app = await startWorkspace(join(root, 'workspace'), { port: 0, workspaceMode: 'embedded' });
  try {
    await page.goto(app.url);
    await page.getByLabel('Новое изменение').fill('Модерация чата');
    await page.getByRole('button', { name: 'Создать изменение', exact: true }).click();
    const current = await (await request.get(app.url + '/api/preparation')).json();
    await request.post(app.url + '/api/agent', {
      headers: { 'X-DevContour-Request': '1' },
      data: {
        operation: 'preparation_product',
        input: {
          changeId: current.current.id,
          expectedDigest: null,
          reason: 'Сценарии подготовлены',
          content: product,
        },
      },
    });
    await expect(page.getByRole('heading', { name: 'Карта продукта' })).toBeVisible();

    // The section menu jumps instead of scrolling the whole page.
    await page.getByRole('navigation', { name: 'Разделы постановки' }).getByText('Каналы').click();
    await expect(page.getByRole('heading', { name: /Каналы \(/ })).toBeInViewport();

    // Editing a block saves a new revision through the same guarded operation.
    const problem = page.locator('#section-problem');
    await problem.getByRole('button', { name: 'Изменить' }).click();
    await problem.getByLabel('Проблема').fill('Переписанная в панели проблема.');
    await problem.getByRole('button', { name: 'Сохранить как новую версию' }).click();
    await expect(page.getByText('Версия 2')).toBeVisible();
    await expect(page.getByText('Переписанная в панели проблема.')).toBeVisible();

    const saved = await (await request.get(app.url + '/api/preparation')).json();
    expect(saved.current.product.number).toBe(2);
    expect(saved.current.product.content.problem).toBe('Переписанная в панели проблема.');

    // The projection follows the edit without a separate step.
    const file = join(root, 'workspace', 'docs', 'changes', saved.current.key, 'product.md');
    expect(readFileSync(file, 'utf8')).toContain('Переписанная в панели проблема.');

    // The operator can send their own draft for approval.
    await page.getByRole('button', { name: 'Отправить на утверждение' }).click();
    await expect(
      page.getByRole('heading', { name: 'Утвердить продуктовую постановку' }),
    ).toBeVisible();

    // A new feature is created from the panel and lands in the saved revision.
    await page.getByRole('button', { name: 'Добавить фичу' }).click();
    const form = page.locator('#section-features form');
    await form.getByLabel('Название').fill('Уведомления');
    await form.getByLabel('Результат для пользователя').fill('Пользователь получает напоминание.');
    await form.getByRole('checkbox').first().check();
    await form.getByLabel('Текст сценария 1').fill('Пользователь включает напоминания.');
    await form.getByLabel('Текст критерия 1').fill('Напоминание приходит в заданное время.');
    await form.getByRole('button', { name: 'Сохранить как новую версию' }).click();
    await expect(page.getByRole('heading', { name: 'Уведомления' })).toBeVisible();
    const withFeature = await (await request.get(app.url + '/api/preparation')).json();
    expect(
      withFeature.current.product.content.features.some(
        (f: { id: string }) => f.id === 'uvedomleniya',
      ),
    ).toBe(true);

    // The stage lives in the URL, so a reload keeps the reader in place.
    await page.getByRole('button', { name: /2 Архитектура и стек/ }).click();
    await expect(page).toHaveURL(/stage=architecture/);
    await page.reload();
    await expect(
      page.getByText('Архитектура будет прорабатываться после вашего утверждения'),
    ).toBeVisible();
    await page.goBack();
    await expect(page).not.toHaveURL(/stage=/);
    await page.getByRole('button', { name: /1 Продукт/ }).click();

    // Questions and decisions sit at the bottom and start folded when empty.
    const questions = page.getByRole('button', { name: /Открытые вопросы \(0\)/ });
    await expect(questions).toHaveAttribute('aria-expanded', 'false');
    await questions.click();
    await expect(page.getByText('Вопросов по этому этапу не было.')).toBeVisible();
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
