import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Попытка и проверка без движения (обход зависаний controller) видны без
// запроса журнала: в ячейке «Сейчас», на карточке и строке задачи и в
// инспекторе. Тихая — приглушённо, зависшая при `report` — янтарём и счётом в
// заголовке ячейки. Строки зарезервированы: появление подписи не меняет высоту.
// Пока попытка молчит, сервер ничего не пишет и опрос отвечает `unchanged`,
// поэтому минуты простоя панель досчитывает своими часами.
//
// Попытка подменяется только в полных ответах сводки (как остановка очереди в
// queue-stop.spec): номер данных остаётся, и ответы `unchanged` приходят как
// у настоящего сервера. Настоящее зависание ждало бы минуты.

type Liveness = {
  state: 'quiet' | 'stalled';
  since: string;
  lastMovementAt: string;
  idleMs: number;
  activity?: { kind: 'agent' | 'gate' | 'step' | 'command'; label: string };
  action?: 'stop' | 'report';
  attention: boolean;
};
type Operation = Liveness & {
  kind: 'joint' | 'base-check' | 'board-coverage';
  id: string;
  subjectId: string;
  title: string;
  repositoryId?: string;
};
const MIN = 60_000;
const at = (idleMs: number) => ({
  since: new Date().toISOString(),
  lastMovementAt: new Date(Date.now() - idleMs).toISOString(),
  idleMs,
});
const stalled = (): Liveness => ({
  state: 'stalled',
  ...at(12 * MIN),
  activity: { kind: 'agent', label: 'codex' },
  action: 'report',
  attention: true,
});

type Scenario = { run: boolean; liveness?: Liveness; operations?: Operation[] };
async function withSummary(page: Page, scenario: () => Scenario) {
  const counts = { full: 0, unchanged: 0 };
  await page.route('**/api/summary*', async (route) => {
    const response = await route.fetch();
    const state = (await response.json()) as {
      unchanged?: boolean;
      runs: Record<string, unknown>[];
      tasks: { id: string; title: string }[];
      config: Record<string, unknown>;
    };
    if (state.unchanged) {
      counts.unchanged++;
      return route.fulfill({ response, json: state });
    }
    counts.full++;
    const s = scenario();
    const task = state.tasks[0];
    const run = {
      id: 'RUN-liveness-e2e',
      taskId: task?.id ?? 'TASK-liveness',
      repositoryId: 'main',
      attempt: 1,
      status: 'active',
      phase: 'verifying',
      startedAt: new Date(Date.now() - 20 * MIN).toISOString(),
      runtime: 'demo',
      reviewer: 'demo',
      evidence: [],
      timings: [{ id: 'T-1', stage: 'candidate-test:unit', startedAt: new Date().toISOString() }],
      ...(s.liveness ? { liveness: s.liveness } : {}),
    };
    await route.fulfill({
      response,
      json: {
        ...state,
        // Очередь идёт: остановка не занимает ячейку.
        paused: false,
        queue: { paused: false },
        runs: [...state.runs.filter((r) => r.status !== 'active'), ...(s.run ? [run] : [])],
        operations: s.operations ?? [],
        config: { ...state.config, concurrency: 2 },
      },
    });
  });
  return counts;
}

const shot = async (page: Page, name: string) => {
  // Снимок для ручного разбора — только по явному запросу прогона.
  if (process.env.LIVENESS_SCREENSHOTS)
    await page.screenshot({ path: `${process.env.LIVENESS_SCREENSHOTS}/${name}.png` });
};

test('Зависшая попытка видна в ячейке, строке и инспекторе; минуты идут без новых данных', async ({
  page,
}) => {
  let scenario: Scenario = { run: true };
  const counts = await withSummary(page, () => scenario);
  await page.clock.install();
  await page.goto('/?tab=graph');
  const live = page.getByRole('region', { name: 'Сейчас работают' });
  const cell = page.getByRole('group', { name: 'Исполнители и причины ожидания' });
  const inspector = page.getByRole('region', { name: 'Живость попытки' });
  await expect(live).toContainText('Работают: 1 из 2');
  // Попытка с движением: строка инспектора зарезервирована и спокойна.
  await expect(inspector).toHaveAttribute('data-liveness', 'active');
  await expect(inspector).toContainText('Попытка идёт, движение есть');
  const heights = async () => ({
    cell: (await cell.boundingBox())!.height,
    inspector: (await page
      .getByRole('complementary', { name: 'Детали задачи' })
      .locator('header')
      .boundingBox())!.height,
    tabs: (await page.getByRole('tab', { name: 'Граф', exact: true }).boundingBox())!.y,
  });
  const before = await heights();
  await page.goto('/?tab=kanban');
  const card = page.locator('button:has([data-live-line])').first();
  const cardBefore = (await card.boundingBox())!.height;
  await page.goto('/?tab=list');
  const row = page.locator('button:has([data-live-line])').first();
  const rowBefore = (await row.boundingBox())!.height;

  // Зависла при report: янтарь, счёт в заголовке, решение человека в инспекторе.
  scenario = { run: true, liveness: stalled() };
  await page.reload();
  await expect(row.locator('[data-liveness]')).toContainText('зависла 12 мин — проверьте среду');
  expect((await row.boundingBox())!.height).toBe(rowBefore);
  await page.goto('/?tab=kanban');
  await expect(card.locator('[data-liveness]')).toContainText('зависла 12 мин');
  expect((await card.boundingBox())!.height).toBe(cardBefore);
  await shot(page, 'card-stalled');
  await page.goto('/?tab=graph');
  const note = cell.locator('[data-liveness]');
  await expect(note).toHaveAttribute('data-liveness', 'stalled');
  await expect(note).toContainText('зависла 12 мин — проверьте среду · агент codex');
  await expect(note).toHaveClass(/text-warning/);
  await expect(live.locator('[data-liveness-count]')).toHaveText('зависших попыток: 1');
  await expect(inspector).toHaveAttribute('data-liveness', 'stalled');
  await expect(inspector).toContainText('зависла 12 мин — проверьте среду');
  await expect(inspector).toContainText('Нужно ваше решение. Проверьте среду исполнения');
  await expect(inspector).toContainText('подробности — в журнале задачи');
  // Внутренних имён в тексте панели нет.
  for (const region of [live, inspector])
    expect(await region.innerText()).not.toMatch(/controller|stallSweep|liveness|repairPolicy/);
  // Подпись видна целиком в зарезервированной строке.
  const [n, c] = [(await note.boundingBox())!, (await cell.boundingBox())!];
  expect(n.x >= c.x - 1 && n.x + n.width <= c.x + c.width + 1).toBe(true);
  expect(await heights()).toEqual(before);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await shot(page, 'live-cell-stalled');

  // Время идёт, данные не меняются: опрос отвечает unchanged, а минуты растут.
  const full = counts.full;
  const unchanged = counts.unchanged;
  await page.clock.fastForward('02:00');
  await expect(note).toContainText('зависла 14 мин — проверьте среду');
  await expect(inspector).toContainText('зависла 14 мин');
  await expect.poll(() => counts.unchanged).toBeGreaterThan(unchanged);
  expect(counts.full).toBe(full);

  // Телефон: подпись видна, страница не прокручивается по горизонтали.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(note).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await shot(page, 'live-cell-stalled-phone');

  // Движение вернулось — подпись уходит.
  await page.setViewportSize({ width: 1280, height: 720 });
  scenario = { run: true };
  await page.reload();
  await expect(cell.locator('[data-liveness]')).toHaveCount(0);
  await expect(inspector).toHaveAttribute('data-liveness', 'active');
});

test('Тихая попытка — приглушённая подпись без счёта', async ({ page }) => {
  await withSummary(page, () => ({
    run: true,
    liveness: {
      state: 'quiet',
      ...at(4 * MIN),
      activity: { kind: 'gate', label: 'unit' },
      attention: false,
    },
  }));
  await page.goto('/?tab=graph');
  const live = page.getByRole('region', { name: 'Сейчас работают' });
  const note = live.locator('[data-liveness]').first();
  await expect(note).toHaveAttribute('data-liveness', 'quiet');
  await expect(note).toContainText('без движения 4 мин · проверка unit');
  await expect(note).not.toHaveClass(/text-warning/);
  await expect(live.locator('[data-liveness-count]')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Живость попытки' })).toContainText(
    'Ничего не требуется',
  );
});

test('Проверка базы и совместная проверка без движения — своей строкой в ячейке', async ({
  page,
}) => {
  await withSummary(page, () => ({
    run: false,
    operations: [
      {
        kind: 'base-check',
        id: 'BK-1',
        subjectId: 'main',
        title: 'main',
        repositoryId: 'main',
        ...stalled(),
        activity: { kind: 'gate', label: 'test' },
      },
    ],
  }));
  await page.goto('/?tab=graph');
  const live = page.getByRole('region', { name: 'Сейчас работают' });
  const row = live.getByRole('list', { name: 'Проверки без движения' }).getByRole('listitem');
  await expect(row).toContainText('Проверка базы');
  await expect(row).toContainText('зависла 12 мин — проверьте среду · проверка test');
  await expect(live.locator('[data-liveness-count]')).toHaveText('зависших проверок: 1');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await shot(page, 'live-cell-base-check');
});
