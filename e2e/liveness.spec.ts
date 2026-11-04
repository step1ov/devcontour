import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Попытка без движения (обход зависаний controller) видна в ячейке «Сейчас»
// без запроса журнала: тихая — приглушённой подписью, зависшая при `report` —
// янтарём и в заголовке ячейки. Высота ячейки зарезервирована: появление
// подписи не сдвигает граф. Попытка подменяется в сводке панели (как
// остановка очереди в queue-stop.spec): реальное зависание ждало бы минуты.

type Liveness = {
  state: 'quiet' | 'stalled';
  since: string;
  lastMovementAt: string;
  idleMs: number;
  activity?: { kind: 'agent' | 'gate' | 'step' | 'command'; label: string };
  action?: 'stop' | 'report';
  attention: boolean;
};
const MIN = 60_000;

async function withRun(page: Page, liveness: () => Liveness | undefined) {
  await page.route('**/api/summary*', async (route) => {
    const url = new URL(route.request().url());
    url.searchParams.delete('revision');
    const response = await route.fetch({ url: url.toString() });
    const state = (await response.json()) as {
      runs: Record<string, unknown>[];
      tasks: { id: string; title: string }[];
      config: Record<string, unknown>;
    };
    const task = state.tasks[0];
    const now = new Date().toISOString();
    const l = liveness();
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
      timings: [{ id: 'T-1', stage: 'candidate-test:unit', startedAt: now }],
      ...(l ? { liveness: l } : {}),
    };
    await route.fulfill({
      response,
      json: {
        ...state,
        // Очередь идёт: остановка не занимает ячейку.
        paused: false,
        queue: { paused: false },
        runs: [...state.runs.filter((r) => r.status !== 'active'), run],
        config: { ...state.config, concurrency: 2 },
      },
    });
  });
}

const at = (idleMs: number) => {
  const now = Date.now();
  return {
    since: new Date(now).toISOString(),
    lastMovementAt: new Date(now - idleMs).toISOString(),
    idleMs,
  };
};

test('Ячейка «Сейчас» называет тихую и зависшую попытку, не сдвигая граф', async ({ page }) => {
  let liveness: Liveness | undefined;
  await withRun(page, () => liveness);
  await page.goto('/?tab=graph');
  await expect(page.getByRole('tab', { name: 'Граф', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const live = page.getByRole('region', { name: 'Сейчас работают' });
  const cell = page.getByRole('group', { name: 'Исполнители и причины ожидания' });
  await expect(live).toContainText('Работают: 1 из 2');
  const height = (await cell.boundingBox())!.height;
  const tabs = (await page.getByRole('tab', { name: 'Граф', exact: true }).boundingBox())!.y;

  // Тихая попытка: приглушённая подпись с последней командой, без янтаря.
  liveness = {
    state: 'quiet',
    ...at(4 * MIN),
    activity: { kind: 'gate', label: 'unit' },
    attention: false,
  };
  const note = cell.locator('[data-liveness]');
  await expect(note).toHaveAttribute('data-liveness', 'quiet');
  await expect(note).toContainText('без движения 4 мин · проверка unit');
  await expect(note).not.toHaveClass(/text-warning/);
  await expect(live.locator('[data-liveness-count]')).toHaveCount(0);

  // Зависшая при report: янтарь у подписи и счёт в заголовке ячейки.
  liveness = {
    state: 'stalled',
    ...at(12 * MIN),
    activity: { kind: 'agent', label: 'codex' },
    action: 'report',
    attention: true,
  };
  await expect(note).toHaveAttribute('data-liveness', 'stalled');
  await expect(note).toContainText('зависла 12 мин: проверьте среду · агент codex');
  await expect(note).toHaveClass(/text-warning/);
  await expect(live.locator('[data-liveness-count]')).toHaveText('зависших попыток: 1');
  // Подпись видна целиком в зарезервированной строке, а не обрезана фазами.
  const [n, c] = [(await note.boundingBox())!, (await cell.boundingBox())!];
  expect(n.x >= c.x - 1 && n.x + n.width <= c.x + c.width + 1).toBe(true);
  expect(
    await note.evaluate((e) => {
      const text = e.lastElementChild!;
      return text.scrollWidth <= text.clientWidth + 1;
    }),
  ).toBe(true);
  // Высота ячейки и положение вкладок не изменились.
  expect((await cell.boundingBox())!.height).toBe(height);
  expect((await page.getByRole('tab', { name: 'Граф', exact: true }).boundingBox())!.y).toBe(tabs);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  // Снимок для ручного разбора — только по явному запросу прогона.
  if (process.env.LIVENESS_SCREENSHOT)
    await page.screenshot({ path: process.env.LIVENESS_SCREENSHOT, fullPage: true });

  // Телефон: подпись видна, страница не прокручивается по горизонтали.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(note).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  if (process.env.LIVENESS_SCREENSHOT)
    await page.screenshot({
      path: process.env.LIVENESS_SCREENSHOT.replace(/\.png$/, '-phone.png'),
    });

  // Движение вернулось — подпись уходит со следующим опросом.
  liveness = undefined;
  await expect(note).toHaveCount(0);
});
