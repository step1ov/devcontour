import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { startWorkspace } from '../src/runner/start.ts';
import type { HomeView } from '../src/application/home.ts';

// Главная панели (`/`): плитки разделов с вопросами, что идёт и кто ждёт,
// ход работ и исполнение. Переходы — в разделы и «Назад» обратно; ссылки
// на этапы, доски и экраны открываются прямо, как раньше.

const SECTIONS = ['Продукт', 'Архитектура', 'Дизайн', 'Разработка'];
const TILES = ['Сейчас идёт / кто ждёт', 'Ход работ', 'Исполнение'];

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function axeClean(page: Page) {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

test('The bare address is the home: four section headings, progress and harness, axe clean on desktop and 390 px', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Главная' })).toBeVisible();
  for (const name of [...SECTIONS, ...TILES])
    await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
  // Каждая плитка — область с заголовком; одна ссылка «Открыть …» на плитку.
  for (const name of SECTIONS)
    await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
  // Демо без подготовки: этапов нет, и плитки говорят это прямо.
  await expect(
    page
      .getByRole('region', { name: 'Продукт', exact: true })
      .getByText('Подготовка не ведётся в панели.'),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Исполнение' })).toContainText(
    'devcontour-harness',
  );
  await expect(page.getByRole('region', { name: 'Исполнение' })).toContainText('Журнал: в порядке');
  await axeClean(page);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await noHorizontalScroll(page)).toBe(true);
  await axeClean(page);
  expect(errors).toEqual([]);
});

test('Home polls only /api/home with its etag, not the summary, preparation or overview', async ({
  page,
}) => {
  const polled: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith('/api/')) polled.push(url.pathname + url.search);
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Главная' })).toBeVisible();
  await page.waitForTimeout(7000);
  const homes = polled.filter((p) => p.startsWith('/api/home'));
  expect(homes.length).toBeGreaterThanOrEqual(3);
  expect(homes.slice(1).every((p) => p.includes('etag='))).toBe(true);
  for (const path of ['/api/summary', '/api/preparation', '/api/overview', '/api/state'])
    expect(polled.some((p) => p.startsWith(path))).toBe(false);
});

test('A tile link opens its section; «Назад» returns home; «Главная» in the shell leads back', async ({
  page,
}) => {
  await page.goto('about:blank');
  await page.goto('/');
  const dev = page.getByRole('region', { name: 'Разработка', exact: true });
  await dev.getByRole('link', { name: /Открыть доски/ }).click();
  await expect(page).toHaveURL(/[?&]tab=kanban/);
  await expect(page).toHaveURL(/[?&]board=B-/);
  await expect(page.getByRole('heading', { level: 1, name: 'Главная' })).toHaveCount(0);
  // «Назад» строки пути — по записи самой панели: к главной.
  await page.getByRole('button', { name: 'Назад', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Главная' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);

  // «Главная» в навигации оболочки разработки.
  await page.goto('/?tab=changesets');
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('link', { name: 'Главная', exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Главная' })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/tab=changesets/);
  await expect(page.getByRole('heading', { name: 'Изменения', exact: true })).toBeVisible();
});

test('Deep links open their screens directly, not the home', async ({ page }) => {
  for (const [url, heading] of [
    ['/?tab=overview', 'Обзор'],
    ['/?tab=changesets', 'Изменения'],
    ['/?tab=contracts', 'Контракты'],
    ['/?tab=attention', 'Внимание'],
  ] as const) {
    await page.goto(url);
    await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Главная' })).toHaveCount(0);
  }
  // Обзор назван в адресе явно: перезагрузка не уводит на главную.
  await page.goto('/?tab=changesets');
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('link', { name: 'Обзор', exact: true })
    .click();
  await expect(page).toHaveURL(/[?&]tab=overview/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Обзор', exact: true }).first()).toBeVisible();
});

test('Before setup: bootstrap and preparation states; a question link focuses its stage questions; Back returns', async ({
  page,
  request,
}) => {
  const prefix = 'devcontour-e2e-home-';
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const app = await startWorkspace(join(root, 'workspace'), { port: 0, workspaceMode: 'embedded' });
  const send = async (operation: string, input: unknown) => {
    const response = await request.post(app.url + '/api/agent', {
      headers: { 'X-DevContour-Request': '1' },
      data: { operation, input },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json() as Promise<{ current: { id: string } }>;
  };
  try {
    await page.goto('about:blank');
    await page.goto(app.url + '/');
    const product = page.getByRole('region', { name: 'Продукт', exact: true });
    await expect(product.getByText(/Опишите продукт/)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Разработка', exact: true })).toContainText(
      'Не разрешена',
    );
    await expect(page.getByRole('region', { name: 'Исполнение' })).toContainText('Не подключено');
    await expect(page.getByRole('region', { name: 'Ход работ' })).toContainText(
      'Хода работ ещё нет',
    );
    await axeClean(page);
    // Ссылка плитки без изменения — этап «Продукт», не главная.
    await expect(product.getByRole('link', { name: /Открыть продукт/ })).toHaveAttribute(
      'href',
      '/?stage=product',
    );

    const created = await send('preparation_create', { title: 'Модерация чата' });
    await send('preparation_question', {
      changeId: created.current.id,
      stage: 'product',
      add: [{ text: 'Кто модерирует чат ночью?', options: ['Бот', 'Дежурный'] }],
    });
    await expect(page.getByText('Подготовка · Модерация чата')).toBeVisible();
    const question = product.getByRole('link', { name: 'Кто модерирует чат ночью?' });
    await expect(question).toBeVisible();
    await expect(product).toContainText('Вопросы: 1');
    await question.click();
    await expect(page).toHaveURL(/#questions-product$/);
    await expect(page.locator('#questions-product')).toBeFocused();
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1, name: 'Главная' })).toBeVisible();
    await expect(page).toHaveURL(app.url + '/');

    // Этап «Продукт» из ссылки плитки переживает перезагрузку.
    await product.getByRole('link', { name: /Открыть продукт/ }).click();
    await expect(page.getByRole('heading', { name: 'От запроса к разработке' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'От запроса к разработке' })).toBeVisible();
    // «Главная» в шапке подготовки.
    await page.getByRole('link', { name: 'Главная', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Главная' })).toBeVisible();
  } finally {
    await app.close();
    if (root.startsWith(realpathSync(tmpdir()) + sep) && root.includes(prefix))
      rmSync(root, { recursive: true, force: true });
  }
});

test('Route fixtures: exhausted budget, failing gate, startupError and long titles stay readable at 390 px', async ({
  page,
}) => {
  const long = 'Очень длинное название доски без пробелов '.repeat(6) + 'x'.repeat(200);
  await page.route('**/api/home*', async (route) => {
    const response = await route.fetch({ url: route.request().url().replace(/\?.*$/, '') });
    const home = (await response.json()) as HomeView & { etag: string };
    const harness = home.harness!;
    home.etag = 'fixture';
    home.startupError = 'Нет конфигурации: config.json не найден';
    home.sections.development.boards.top = [
      { id: 'B-long', title: long, phase: 'failed', href: '/?tab=kanban&board=B-long' },
    ];
    harness.budget = {
      state: 'exceeded',
      scope: 'workspace',
      limitUsd: 5,
      spentUsd: 7.25,
      unknownCalls: 2,
      complete: false,
      exceeded: 1,
      total: 1,
      asOf: home.generatedAt,
    };
    harness.gates = {
      failing: [{ gate: 'unit-tests-' + 'y'.repeat(120), failed: 3, passed: 1 }],
      total: 2,
      asOf: home.generatedAt,
    };
    harness.health.loopStalls1h = 4;
    await route.fulfill({ json: home });
  });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Нет конфигурации: config.json не найден');
  const harness = page.getByRole('region', { name: 'Исполнение' });
  await expect(harness).toContainText('исчерпан');
  await expect(harness).toContainText('$7.25 из $5.00');
  await expect(harness.getByRole('list', { name: 'Проверки с отказами' })).toContainText(
    'отказов 3',
  );
  await expect(harness).toContainText('Задержки цикла сервера за час: 4');
  await expect(page.getByRole('link', { name: long })).toBeVisible();
  await axeClean(page);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await noHorizontalScroll(page)).toBe(true);
  await axeClean(page);
});

test('Charts: overall progress, agent load and hourly attempts render from route fixtures, with summaries and data tables', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/home*', async (route) => {
    const response = await route.fetch({ url: route.request().url().replace(/\?.*$/, '') });
    const home = (await response.json()) as HomeView & { etag: string };
    const harness = home.harness!;
    const progress = home.progress!;
    home.etag = 'charts';
    const to = Date.parse('2026-11-19T12:00:00.000Z');
    const peaks = Array.from({ length: 96 }, (): [number, number, number, number] => [0, 0, 0, 0]);
    peaks[56] = [0, 2, 1, 0]; // 14:00 предыдущих суток: пик 3
    peaks[95] = [1, 0, 0, 0]; // сейчас 1
    const hourly = Array.from({ length: 24 }, (): [number, number] => [0, 0]);
    hourly[14] = [5, 2];
    harness.concurrency = 2;
    harness.load = {
      from: new Date(to - 24 * 3_600_000).toISOString(),
      to: new Date(to).toISOString(),
      bucketMs: 900_000,
      peaks,
      hourly,
      asOf: home.generatedAt,
    };
    progress.releases = [
      {
        id: 'r1',
        title: 'Первый релиз',
        tasks: 10,
        done: 7,
        failed: 0,
        criteria: 4,
        readiness: 'in-progress',
      },
      {
        id: 'r2',
        title: 'Второй релиз',
        tasks: 4,
        done: 1,
        failed: 1,
        criteria: 2,
        readiness: 'failed',
      },
    ];
    progress.releasesTotal = 2;
    await route.fulfill({ json: home });
  });
  await page.goto('/');
  const overall = page.getByRole('region', { name: 'Общий ход работ' });
  await expect(overall.getByRole('progressbar', { name: 'Выполнено задач' })).toBeVisible();
  await expect(overall.getByRole('progressbar', { name: 'Релиз r1 Первый релиз' })).toHaveAttribute(
    'aria-valuenow',
    '70',
  );
  const load = page.getByRole('figure', { name: /Нагрузка агентов за сутки/ });
  await expect(load).toContainText(/Пик 3 агента в \d\d:\d\d, сейчас 1; слотов 2\./);
  // Скрытая таблица данных: только интервалы с работой.
  await expect(load.locator('table tbody tr')).toHaveCount(2);
  const hourlyChart = page.getByRole('figure', { name: /Попытки по часам/ });
  await expect(hourlyChart).toContainText('Начато 5, со сбоем 2');
  await expect(hourlyChart.locator('table tbody tr')).toHaveCount(1);
  await axeClean(page);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await noHorizontalScroll(page)).toBe(true);
  await expect(load.locator('svg')).toBeVisible();
  await axeClean(page);
  expect(errors).toEqual([]);
});
