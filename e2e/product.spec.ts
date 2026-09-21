import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { intentDefinition } from '../src/core/intent.ts';
import type { ProductView } from '../src/core/product-map.ts';

test('Product UI presents application scope, release selection, repository navigation and read errors', async ({
  page,
}) => {
  const definition = intentDefinition.parse(
    JSON.parse(readFileSync('packs/example-product-intent.json', 'utf8')),
  );
  if (definition.kind !== 'workspace' || !definition.product)
    throw new Error('Product example required');
  const product = definition.product;
  let unavailable = false;
  const requests: string[] = [];
  await page.route('**/api/product*', async (route) => {
    requests.push(route.request().url());
    if (unavailable) {
      await route.fulfill({
        status: 400,
        json: { error: 'INTENT изменён: повторите генерацию карты' },
      });
      return;
    }
    const releaseId = new URL(route.request().url()).searchParams.get('release') ?? 'mvp';
    const view: ProductView = {
      available: true,
      title: definition.title,
      purpose: definition.purpose,
      channels: product.channels,
      components: product.components,
      releases: [
        { id: 'mvp', title: 'Первая модерация' },
        { id: 'next', title: 'Следующий этап' },
      ],
      releaseId,
      intentDigest: 'a'.repeat(64),
      coverageComplete: true,
      releaseAccepted: false,
      issues: [],
      features: definition.releases[0].features!.map((scope) => ({
        ...product.features.find((f) => f.id === scope.featureId)!,
        status: scope.featureId === 'block-member' ? 'awaiting-verification' : 'deferred',
        channels: scope.channels.map((a) => ({ ...a, covered: true, planned: true })),
        checks: scope.checks.map((c) => ({ ...c, passed: false })),
      })),
    };
    await route.fulfill({ json: view });
  });
  await page.goto('/');
  await page.getByRole('tab', { name: 'Продукт', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Система общения', exact: true })).toBeVisible();
  await expect(page.getByText('Ждёт сквозной проверки', { exact: true })).toBeVisible();
  await expect(page.getByText('Не применяется', { exact: true })).toBeVisible();
  await expect(page.getByText('Релиз принят на проверенной совместной версии.')).toHaveCount(0);
  await page.getByLabel('Продуктовый релиз').selectOption('next');
  await expect.poll(() => requests.some((url) => url.endsWith('?release=next'))).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'test-results/product-features.png', fullPage: true });
  await page.getByRole('button', { name: 'Приложения и компоненты', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'apps/admin', exact: false })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'product', exact: true }).first().click();
  await expect(page.getByRole('tab', { name: 'Общий граф', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  unavailable = true;
  await page.getByRole('tab', { name: 'Продукт', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('INTENT изменён');
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('Product UI explains a missing map without claiming product readiness', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Продукт', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Карта продукта ещё не подготовлена' }),
  ).toBeVisible();
  await expect(page.getByText('Релиз принят на проверенной совместной версии.')).toHaveCount(0);
});
