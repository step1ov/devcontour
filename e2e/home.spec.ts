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
  // Фокус не теряется на body: экран доски получил его на заголовке.
  await expect.poll(() => page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  expect(await page.title()).toBe('DevContour — рабочий граф');
  await page.getByRole('button', { name: 'Назад', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Главная' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Главная' })).toBeFocused();
  expect(await page.title()).toBe('DevContour · Главная');
  // «Вперёд» снова открывает доску.
  await page.goForward();
  await expect(page).toHaveURL(/[?&]tab=kanban/);

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
      {
        id: 'B-parked',
        title: 'Отложенная доска',
        phase: 'draft',
        href: '/?tab=kanban&board=B-parked',
        parked: { reason: 'Ждём решения по API', until: '2026-12-01T09:30:00.000Z', by: 'lead' },
      },
    ];
    home.sections.development.boards.parked = 1;
    home.sections.development.jobs.closed = 1;
    harness.budget = {
      state: 'exceeded',
      scope: 'workspace',
      limitUsd: 5,
      limitMs: 3_600_000,
      spentMs: 4_200_000,
      reason: 'Бюджет workspace исчерпан: время и сумма',
      spentUsd: 7.25,
      unknownCalls: 2,
      text: 'Бюджет workspace: исчерпан · ~$7.25',
      complete: false,
      exceeded: 1,
      total: 3,
      scopes: [
        {
          state: 'exceeded',
          scope: 'workspace',
          limitUsd: 5,
          limitMs: 3_600_000,
          spentMs: 4_200_000,
          reason: 'Бюджет workspace исчерпан: время и сумма',
          spentUsd: 7.25,
          unknownCalls: 2,
          text: 'Бюджет workspace: исчерпан · ~$7.25',
        },
        {
          state: 'undetermined',
          scope: 'board B-1',
          limitUsd: 3000,
          spentUsd: 1014.1558,
          unknownCalls: 227,
          reason: 'Бюджет доски не определён: у 1 попытки вызовы не записаны',
          text: 'Бюджет board B-1: не определён · ~$1014',
        },
      ],
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
  // Строка на область: красная — исчерпанная, янтарная — не определённая.
  const budgets = harness.getByRole('list', { name: 'Бюджеты' });
  const lines = budgets.getByRole('listitem');
  await expect(lines.nth(0)).toContainText('~$7.25 из $5 (145 %)');
  await expect(lines.nth(0)).toContainText('время 70 мин из 60 мин');
  await expect(lines.nth(0)).toContainText('у 2 вызовов стоимость неизвестна — сумма занижена');
  await expect(lines.nth(0)).toHaveClass(/text-destructive/);
  await expect(lines.nth(1)).toContainText(
    'Бюджет board B-1: не определён · ~$1014 из $3000 (34 %)',
  );
  await expect(lines.nth(1)).toHaveClass(/text-warning/);
  await expect(lines.nth(2)).toContainText('и ещё бюджетов: 1');
  // Точные суммы, секунды и текст расчёта — только в «подробнее».
  await expect(budgets).not.toContainText('1014.1558');
  const details = harness.getByText('подробнее', { exact: true });
  await expect(page.getByText('Бюджет workspace исчерпан: время и сумма')).toBeHidden();
  await details.click();
  await expect(
    page.getByText(/workspace: оценка \$7\.2500 из \$5\.00, время 4200 с/),
  ).toBeVisible();
  await expect(page.getByText(/board B-1: оценка \$1014\.1558/)).toContainText(
    'у 1 попытки вызовы не записаны',
  );
  await expect(harness.getByRole('list', { name: 'Проверки с отказами' })).toContainText(
    'отказов 3',
  );
  await expect(harness).toContainText('Задержки цикла сервера за час: 4');
  await expect(page.getByRole('link', { name: long })).toBeVisible();
  // Отложенная доска (F90): причина и срок вместо фазы «черновик».
  const boards = page.getByRole('list', { name: 'Живые доски' });
  const parked = boards.getByRole('listitem').filter({ hasText: 'Отложенная доска' });
  await expect(parked).toContainText(/отложена до 1 дек\.?,? \d\d:\d\d: Ждём решения по API/);
  const dev = page.getByRole('region', { name: 'Разработка', exact: true });
  await expect(dev).toContainText('досок отложено 1');
  await expect(dev).toContainText('заданий закрыто 1');
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
    peaks[95] = [2, 1, 0, 0]; // пик последнего интервала — не «сейчас»
    const hourly = Array.from({ length: 24 }, (): [number, number] => [0, 0]);
    hourly[14] = [5, 2];
    harness.concurrency = 2;
    harness.load = {
      from: new Date(to - 24 * 3_600_000).toISOString(),
      to: new Date(to).toISOString(),
      bucketMs: 900_000,
      peaks,
      hourly,
      current: 1,
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
    const gates = Array.from({ length: 24 }, (): [number, number, number] => [0, 0, 0]);
    gates[10] = [6, 3, 2];
    gates[20] = [4, 0, 0];
    harness.gateTrend = {
      from: new Date(to - 24 * 3_600_000).toISOString(),
      to: new Date(to).toISOString(),
      hourly: gates,
      asOf: home.generatedAt,
    };
    harness.spend = {
      days: Array.from({ length: 7 }, (_, i) => ({
        start: new Date(Date.parse('2026-11-13T00:00:00') + i * 86_400_000).toISOString(),
        date: `2026-11-${13 + i}`,
        usd: i === 5 ? 12.5 : i === 6 ? 2.5 : 0,
        calls: i >= 5 ? 4 : 0,
        unknown: i === 6 ? 3 : 0,
      })),
      beforeUsd: 35,
      beforeUnknown: 0,
      limitUsd: 100,
      asOf: home.generatedAt,
    };
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
  // Время пика — начало 57-го интервала в часовом поясе браузера; день
  // окна, отличный от сегодняшнего, назван (F92).
  const [peakAt, peakDay] = await page.evaluate(() => {
    const to = new Date('2026-11-19T12:00:00.000Z');
    const at = new Date(to.getTime() - 24 * 3_600_000 + 56 * 900_000);
    return [
      at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
      at.getDate() === to.getDate() ? '' : 'вчера ',
    ];
  });
  await expect(load).toContainText(`Пик 3 агента ${peakDay}в ${peakAt}, сейчас 1; слотов 2.`);
  // Столбики нарисованы: интервал пика — три сегмента стека, текущий — один.
  await expect(
    load.locator('svg g').nth(56).locator('rect[fill]:not([fill="transparent"])'),
  ).toHaveCount(2);
  await expect(load.locator('svg g').nth(56).locator('title')).toContainText(
    'пик 3 агента (принята 2, сбой 1)',
  );
  // Скрытая таблица данных: только интервалы с работой.
  await expect(load.locator('table tbody tr')).toHaveCount(2);
  await expect(load.locator('table tbody tr').first()).toContainText(`${peakAt}`);
  await expect(load.locator('table tbody tr').first().locator('td')).toHaveText([
    '3',
    '0',
    '2',
    '1',
    '0',
  ]);
  // Текущее значение — точкой у правого края, слоты — подписанной линией.
  await expect(load.locator('[data-current="1"]')).toBeVisible();
  await expect(load.getByText('слоты 2', { exact: true })).toBeVisible();
  const gateChart = page.getByRole('figure', { name: /Проверки по часам/ });
  await expect(gateChart).toContainText('Прошло 10, отказов 3, взято из кандидата 2');
  await expect(gateChart.locator('table tbody tr')).toHaveCount(2);
  await expect(gateChart.locator('table tbody tr').first().locator('td')).toHaveText([
    '6',
    '3',
    '2',
  ]);
  // Стек часа: отказ, прошло, взято — три сегмента.
  const segments = gateChart
    .locator('svg g')
    .nth(10)
    .locator('rect[fill]:not([fill="transparent"])');
  await expect(segments).toHaveCount(3);
  // Отказы — у основания, затем прошедшие и взятые; высоты — по шкале часа (11).
  const geometry = await segments.evaluateAll((rects) =>
    rects.map((r) => ({
      fill: r.getAttribute('fill'),
      y: Number(r.getAttribute('y')),
      height: Number(r.getAttribute('height')),
    })),
  );
  expect(geometry.map((g) => g.fill)).toEqual([
    'var(--status-failed)',
    'var(--status-done)',
    'var(--status-waiting)',
  ]);
  const scale = (v: number) => (v / 11) * 118 - 1.5;
  for (const [i, v] of [3, 6, 2].entries()) expect(geometry[i].height).toBeCloseTo(scale(v), 1);
  expect(geometry[0].y).toBeGreaterThan(geometry[1].y);
  expect(geometry[1].y).toBeGreaterThan(geometry[2].y);
  // Час без отказов — без красного сегмента.
  await expect(
    gateChart.locator('svg g').nth(20).locator('rect[fill="var(--status-failed)"]'),
  ).toHaveCount(0);
  const spendChart = page.getByRole('figure', { name: /Расход по дням/ });
  await expect(spendChart).toContainText('За неделю $15.00, всего $50.00 из предела $100 (50%)');
  await expect(spendChart).toContainText('стоимость неизвестна у 3 вызовов — суммы занижены');
  await expect(spendChart).toContainText('предел $100');
  await expect(spendChart.locator('table tbody tr')).toHaveCount(7);
  await expect(spendChart.locator('svg')).toBeVisible();
  // Предел — пунктир на шкале предела (вершина: предел выше суммы).
  const limitLine = spendChart.locator('svg line[stroke-dasharray]');
  await expect(limitLine).toHaveCount(1);
  expect(Number(await limitLine.getAttribute('y1'))).toBeCloseTo(2, 1);
  // Последний день: раньше 47.50, за день 2.50 — два сегмента стека.
  const lastDay = spendChart
    .locator('svg g')
    .nth(6)
    .locator('rect[fill]:not([fill="transparent"])');
  await expect(lastDay).toHaveCount(2);
  expect(Number(await lastDay.nth(0).getAttribute('height'))).toBeCloseTo(
    (47.5 / 100) * 118 - 1.5,
    1,
  );
  // Подпись дня — календарная дата сервера, не пересчёт в пояс браузера.
  await expect(spendChart.locator('table tbody tr').first().locator('th')).toContainText('13');
  await expect(spendChart.locator('table tbody tr').last().locator('td')).toHaveText([
    '2.50',
    '4',
    '3',
    '50.00',
  ]);
  // Кольца плиток — изображения с долей в доступном имени.
  await expect(
    page
      .getByRole('region', { name: 'Разработка', exact: true })
      .getByRole('img', { name: /^Задач выполнено: \d+ из \d+$/ }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: 'Исполнение' })
      .getByRole('img', { name: 'Слотов занято: 0 из 2' }),
  ).toBeVisible();
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

test('Rings and compact tiles: preparation tiles with rings and a one-line not-applicable design; map releases without counts', async ({
  page,
}) => {
  await page.route('**/api/home*', async (route) => {
    const response = await route.fetch({ url: route.request().url().replace(/\?.*$/, '') });
    const home = (await response.json()) as HomeView & { etag: string };
    home.etag = 'rings';
    home.preparation = true;
    const s = home.sections;
    s.product = { ...s.product, state: 'approved', revision: 3 };
    s.architecture = { ...s.architecture, state: 'in-review', revision: 2 };
    s.design = {
      ...s.design,
      state: 'not-applicable',
      facts: [],
      design: {
        steps: [
          { key: 'references', state: 'approved' },
          { key: 'concept', state: 'not-applicable' },
          { key: 'design', state: 'not-applicable' },
        ],
      },
    };
    home.progress!.releasesFrom = 'product-map';
    home.progress!.releases = [
      {
        id: 'r1',
        title: 'Карта',
        tasks: 4,
        done: 3,
        failed: 0,
        criteria: 0,
        readiness: 'in-progress',
        unit: 'features',
      },
      {
        id: 'r2',
        title: 'Потом',
        tasks: 0,
        done: 0,
        failed: 0,
        criteria: 0,
        readiness: 'unplanned',
        unit: 'features',
        measured: false,
      },
    ];
    home.progress!.releasesTotal = 2;
    home.progress!.releasesDone = 0;
    // Расход выше предела: столбик выше пунктира, сводка — больше 100 %.
    home.harness!.spend = {
      days: Array.from({ length: 7 }, (_, i) => ({
        start: new Date(Date.parse('2026-11-13T00:00:00') + i * 86_400_000).toISOString(),
        date: `2026-11-${13 + i}`,
        usd: i === 6 ? 20 : 0,
        calls: i === 6 ? 2 : 0,
        unknown: 0,
      })),
      beforeUsd: 30,
      beforeUnknown: 0,
      limitUsd: 40,
      asOf: home.generatedAt,
    };
    await route.fulfill({ json: home });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const product = page.getByRole('region', { name: 'Продукт', exact: true });
  await expect(product.getByRole('img', { name: 'Релизов готово: 0 из 2' })).toBeVisible();
  await expect(product.getByText('Утверждено · v3')).toBeVisible();
  const architecture = page.getByRole('region', { name: 'Архитектура', exact: true });
  await expect(architecture.getByRole('img', { name: 'Утверждено этапов: 0 из 1' })).toBeVisible();
  await expect(architecture.getByText('Ждёт вашего решения · v2')).toBeVisible();
  // Неприменимый дизайн — одна строка, без кольца.
  const design = page.getByRole('region', { name: 'Дизайн', exact: true });
  await expect(design).toContainText('Дизайн к продукту не применяется.');
  await expect(design.getByRole('img')).toHaveCount(0);
  const box = await design.boundingBox();
  expect(box!.height).toBeLessThan(60);
  // Плитки продукта и архитектуры — одной высоты.
  const [a, b] = await Promise.all([product.boundingBox(), architecture.boundingBox()]);
  expect(Math.abs(a!.height - b!.height)).toBeLessThan(1);
  const overall = page.getByRole('region', { name: 'Общий ход работ' });
  await expect(overall.getByRole('list', { name: 'Релизы карты продукта' })).toBeVisible();
  await expect(overall.getByRole('progressbar', { name: 'Релиз r1 Карта' })).toHaveAttribute(
    'aria-valuetext',
    '3 из 4 фич, в работе',
  );
  await expect(overall.getByRole('progressbar', { name: 'Релиз r2 Потом' })).toHaveAttribute(
    'aria-valuetext',
    'не начат; фичи этого релиза карта не считает',
  );
  const spend = page.getByRole('figure', { name: /Расход по дням/ });
  await expect(spend).toContainText('всего $50.00 из предела $40.00 (125%)');
  const limitY = Number(await spend.locator('svg line[stroke-dasharray]').getAttribute('y1'));
  const top = Number(
    await spend
      .locator('svg g')
      .nth(6)
      .locator('rect[fill]:not([fill="transparent"])')
      .last()
      .getAttribute('y'),
  );
  expect(top).toBeLessThan(limitY);
  await axeClean(page);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await noHorizontalScroll(page)).toBe(true);
  await axeClean(page);
});

test.describe('Charts in UTC', () => {
  test.use({ timezoneId: 'UTC' });
  test('Times outside today carry the day: peaks and axis ends of the 24 h charts (F92)', async ({
    page,
  }) => {
    await page.route('**/api/home*', async (route) => {
      const response = await route.fetch({ url: route.request().url().replace(/\?.*$/, '') });
      const home = (await response.json()) as HomeView & { etag: string };
      const harness = home.harness!;
      home.etag = 'charts-day';
      const to = Date.parse('2026-11-19T12:00:00.000Z');
      const from = new Date(to - 24 * 3_600_000).toISOString();
      const peaks = Array.from({ length: 96 }, (): [number, number, number, number] => [
        0, 0, 0, 0,
      ]);
      peaks[0] = [0, 2, 0, 0]; // вчера 12:00 — пик 2
      peaks[90] = [1, 0, 0, 0]; // сегодня 10:30
      const hourly = Array.from({ length: 24 }, (): [number, number] => [0, 0]);
      hourly[0] = [6, 0];
      hourly[23] = [1, 0];
      harness.concurrency = 2;
      harness.load = {
        from,
        to: new Date(to).toISOString(),
        bucketMs: 900_000,
        peaks,
        hourly,
        current: 1,
        asOf: home.generatedAt,
      };
      const gates = Array.from({ length: 24 }, (): [number, number, number] => [0, 0, 0]);
      gates[22] = [1, 2, 0]; // сегодня 10:00 — без дня
      harness.gateTrend = {
        from,
        to: new Date(to).toISOString(),
        hourly: gates,
        asOf: home.generatedAt,
      };
      await route.fulfill({ json: home });
    });
    await page.goto('/');
    const load = page.getByRole('figure', { name: /Нагрузка агентов за сутки/ });
    await expect(load).toContainText('Пик 2 агента вчера в 12:00, сейчас 1; слотов 2.');
    // Ось: левый край — вчера, правый — сегодня без дня.
    const axis = load.locator('div.justify-between span');
    await expect(axis).toHaveText(['вчера 12:00', '00:00', '12:00']);
    await expect(load.locator('table tbody tr').first().locator('th')).toHaveText(
      'вчера 12:00–12:15',
    );
    const hourlyChart = page.getByRole('figure', { name: /Попытки по часам/ });
    await expect(hourlyChart).toContainText('больше всего вчера в 12:00 (6)');
    await expect(hourlyChart.locator('table tbody tr').first().locator('th')).toHaveText(
      'вчера 12:00',
    );
    const gateChart = page.getByRole('figure', { name: /Проверки по часам/ });
    await expect(gateChart).toContainText('больше всего отказов в 10:00 (2)');
  });
});

test.describe('A browser in another time zone', () => {
  test.use({ timezoneId: 'America/Los_Angeles' });
  test('Spend days keep the server calendar date', async ({ page }) => {
    await page.route('**/api/home*', async (route) => {
      const response = await route.fetch({ url: route.request().url().replace(/\?.*$/, '') });
      const home = (await response.json()) as HomeView & { etag: string };
      home.etag = 'zone';
      // Полночь сервера в Москве (UTC+3): в Лос-Анджелесе это ещё 12 ноября.
      home.harness!.spend = {
        days: Array.from({ length: 7 }, (_, i) => ({
          start: new Date(Date.parse('2026-11-12T21:00:00.000Z') + i * 86_400_000).toISOString(),
          date: `2026-11-${13 + i}`,
          usd: 1,
          calls: 1,
          unknown: 0,
        })),
        beforeUsd: 0,
        beforeUnknown: 0,
        asOf: home.generatedAt,
      };
      await route.fulfill({ json: home });
    });
    await page.goto('/');
    const spend = page.getByRole('figure', { name: /Расход по дням/ });
    await expect(spend.locator('table tbody tr').first().locator('th')).toHaveText('пт, 13');
    await expect(spend.locator('table tbody tr').last().locator('th')).toHaveText('чт, 19');
  });
});
