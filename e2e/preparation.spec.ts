import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtempSync, rmSync } from 'node:fs';
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
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
