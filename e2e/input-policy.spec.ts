import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { setupDemo } from '../src/demo.ts';
import { loadConfig } from '../src/runner/config.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { serve } from '../src/server/http.ts';
import { useLiveCliGuard } from './live-cli-guard.ts';

// Порог вопросов исполнителя в панели («Ход работ» → «Вопросы исполнителя»).
// Свой учебный сервер в процессе теста: правка порога меняет конфигурацию,
// и общий демо-проект после неё был бы не тем, что ждут другие сценарии; а
// объявление в workspace.json требует workspaceRoot, которого у demo нет.
// Исполнители — учебный runtime `demo` (fixture, не модель).

useLiveCliGuard();

// Сценарии идут по порядку на одном сервере: второй и третий видят порог,
// применённый первым.
test.describe.configure({ mode: 'serial' });

const gitKeys = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const;

let root = '';
let data = '';
let registry = '';
let url = '';
let close: () => Promise<void> = async () => {};
const savedGit: Partial<Record<(typeof gitKeys)[number], string>> = {};

test.beforeAll(async () => {
  test.setTimeout(120000);
  for (const k of gitKeys) savedGit[k] = process.env[k];
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 'DevContour fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'DevContour fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  });
  root = realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-ui-input-policy-')));
  data = join(root, 'data');
  registry = join(root, 'workspace');
  mkdirSync(registry);
  await setupDemo(data, { checkoutRoot: join(root, 'checkouts') });
  // Реестр workspace — каталог, где сценарий объявления пишет workspace.json.
  const path = join(data, 'config.json');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...raw, workspaceRoot: registry }, null, 2) + '\n');
  const store = new Store(join(data, 'state.sqlite'));
  const h = new DevContour(store, loadConfig(path));
  const scheduler = new Scheduler(h, data);
  await scheduler.init();
  const app = await serve(h, scheduler, { port: 0 });
  url = app.url;
  close = async () => {
    await app.close();
    store.close();
  };
});

test.afterAll(async () => {
  await close();
  for (const k of gitKeys)
    if (savedGit[k] === undefined) delete process.env[k];
    else process.env[k] = savedGit[k];
  // Удаляется только свой временный каталог.
  if (root && root.startsWith(realpathSync(tmpdir()) + sep) && root.includes('input-policy-'))
    rmSync(root, { recursive: true, force: true });
});

const card = (page: Page) => page.getByRole('region', { name: 'Вопросы исполнителя' });
const configFile = () =>
  JSON.parse(readFileSync(join(data, 'config.json'), 'utf8')) as { inputPolicy?: unknown };

test('Оператор меняет порог без правки JSON: применение видно в карточке и журнале', async ({
  page,
  request,
}) => {
  // Каждый текст, побывавший в области тревоги карточки, — до загрузки
  // панели: ложный «отказ» на мгновение после успешной правки тоже виден.
  await page.addInitScript(() => {
    const w = window as unknown as { __policyAlerts: string[] };
    w.__policyAlerts = [];
    new MutationObserver(() => {
      for (const node of document.querySelectorAll('[data-input-policy] [role="alert"]')) {
        const text = node.textContent ?? '';
        if (text && w.__policyAlerts.at(-1) !== text) w.__policyAlerts.push(text);
      }
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await page.goto(url + '/?tab=progress');
  const policy = card(page);
  // Действующее значение — в описании текущего порога, а не в вариантах выбора.
  await expect(policy.locator('[data-input-policy-threshold]')).toHaveText(
    '7 — по умолчанию (не задан в конфигурации)',
  );
  await expect(policy.locator('[data-input-policy-paths]')).toHaveText('нет');
  expect(
    (await new AxeBuilder({ page }).include('[data-input-policy]').analyze()).violations,
  ).toEqual([]);
  // Клавиатура: порог и пути — подписанные поля формы.
  const threshold = policy.getByLabel('Порог', { exact: true });
  await threshold.focus();
  await threshold.selectOption('11');
  await page.keyboard.press('Tab');
  await expect(policy.getByLabel('Критические пути', { exact: true })).toBeFocused();
  await page.keyboard.type('src/billing/');
  await page.keyboard.press('Tab');
  await expect(policy.getByRole('button', { name: 'Применить порог' })).toBeFocused();
  await page.keyboard.press('Enter');
  // Форма уступает место состоянию запроса, фокус — на нём, а не на body.
  const status = policy.locator('[data-input-policy-status]');
  await expect(status).toBeFocused();
  // Такт сервера применяет запрос: результат и «со следующей попытки».
  const outcome = policy.locator('[data-input-policy-outcome="applied"]');
  await expect(outcome).toContainText('Применено: порог 11');
  await expect(outcome).toContainText('config.applied');
  await expect(outcome).toContainText('со следующей попытки');
  await expect(outcome).toHaveAttribute('role', 'status');
  await expect(policy.locator('[data-input-policy-threshold]')).toHaveAttribute(
    'data-input-policy-threshold',
    '11',
  );
  await expect(policy.locator('[data-input-policy-threshold]')).toHaveText('11 — автономный режим');
  await expect(policy.locator('[data-input-policy-paths]')).toHaveText('src/billing/');
  // За всё время правки — ни одного отказа или ошибки в карточке.
  expect(
    await page.evaluate(() => (window as unknown as { __policyAlerts: string[] }).__policyAlerts),
  ).toEqual([]);
  expect(configFile().inputPolicy).toEqual({ threshold: 11, criticalPaths: ['src/billing/'] });
  // Журнал: событие config.applied операции порога из панели.
  const events = (await (await request.get(url + '/api/events?limit=20')).json()) as {
    items: { type: string; data?: { operation?: string } }[];
  };
  const applied = events.items.find((e) => e.type === 'config.applied');
  expect(applied?.data?.operation).toMatch(/^config-apply:inputPolicy:/);
  const journal = page.locator('[data-slot="card"]', {
    has: page.getByRole('heading', { name: /^Журнал/ }),
  });
  await journal.getByText(/Последние \d+ событий/).click();
  await expect(journal.getByText('config.applied', { exact: true }).first()).toBeVisible();
  await expect(journal).toContainText('Сервер применил конфигурацию');
});

test('Устаревший digest: сервер отказывает 409, карточка показывает ошибку и не пишет файл', async ({
  page,
}) => {
  // Панель «видела» другую конфигурацию: digest в сводке подменён.
  await page.route('**/api/summary*', async (route) => {
    const target = new URL(route.request().url());
    target.searchParams.delete('revision');
    const response = await route.fetch({ url: target.toString() });
    const state = (await response.json()) as { config: Record<string, unknown> };
    await route.fulfill({
      response,
      json: { ...state, config: { ...state.config, configDigest: 'a'.repeat(64) } },
    });
  });
  const before = readFileSync(join(data, 'config.json'), 'utf8');
  await page.goto(url + '/?tab=progress');
  const policy = card(page);
  await policy.getByLabel('Порог', { exact: true }).selectOption('3');
  await policy.getByRole('button', { name: 'Применить порог' }).click();
  const error = policy.getByRole('alert');
  await expect(error).toContainText('Порог не изменён');
  await expect(error).toContainText('config.json отличается');
  expect(readFileSync(join(data, 'config.json'), 'utf8')).toBe(before);
  await expect(policy.locator('[data-input-policy-threshold]')).toHaveAttribute(
    'data-input-policy-threshold',
    '11',
  );
});

/** Подмена полей `config` сводки: ревизия убирается, чтобы каждый ответ был полным. */
async function patchSummary(page: Page, patch: () => Record<string, unknown>) {
  await page.route('**/api/summary*', async (route) => {
    const target = new URL(route.request().url());
    target.searchParams.delete('revision');
    const response = await route.fetch({ url: target.toString() });
    const state = (await response.json()) as { config: Record<string, unknown> };
    await route.fulfill({ response, json: { ...state, config: { ...state.config, ...patch() } } });
  });
}

test('Слот занят другой операцией: карточка называет её вместо формы', async ({ page }) => {
  await patchSummary(page, () => ({
    configPending: {
      operation: 'contract-change:CC-9',
      requestedAt: new Date().toISOString(),
      appliedAt: new Date().toISOString(),
    },
  }));
  await page.goto(url + '/?tab=progress');
  const policy = card(page);
  const busy = policy.locator('[data-input-policy-busy]');
  await expect(busy).toContainText('contract-change:CC-9');
  await expect(busy).toContainText('применена, ещё не завершена');
  await expect(policy.getByRole('button', { name: 'Применить порог' })).toHaveCount(0);
});

test('Сервер отклонил применение: после ожидания — отказ, и он не пересчитывается', async ({
  page,
}) => {
  const operation = 'config-apply:inputPolicy:fake0001';
  let stage: 'before' | 'pending' | 'refused' | 'later' = 'before';
  // Запрос принят, затем такт сервера его отклоняет: файл остаётся с
  // отклонённым значением (расхождение), слот свободен.
  await page.route('**/api/config/input-policy', async (route) => {
    stage = 'pending';
    await route.fulfill({
      json: {
        status: 'requested',
        operation,
        digest: 'c'.repeat(64),
        inputPolicy: { threshold: 2 },
      },
    });
  });
  await patchSummary(page, () =>
    stage === 'pending'
      ? {
          configPending: {
            operation,
            requestedAt: new Date().toISOString(),
            keys: ['inputPolicy'],
          },
        }
      : stage === 'refused'
        ? {
            configPending: null,
            configDrift: { fileDigest: 'c'.repeat(64), reason: 'файл изменился' },
          }
        : stage === 'later'
          ? // Позже конфигурация совпала с записанным digest (например, правка
            // из CLI): решённый отказ не становится «применено».
            { configPending: null, configDrift: null, configDigest: 'c'.repeat(64) }
          : {},
  );
  await page.goto(url + '/?tab=progress');
  const policy = card(page);
  await policy.getByLabel('Порог', { exact: true }).selectOption('2');
  await policy.getByRole('button', { name: 'Применить порог' }).click();
  await expect(policy.locator('[data-input-policy-outcome="pending"]')).toContainText(
    'Порог 2 записан в config.json',
  );
  await expect(policy.locator('[data-input-policy-alert]')).toHaveText('');
  stage = 'refused';
  const refused = policy.locator('[data-input-policy-outcome="refused"]');
  await expect(refused).toContainText('Сервер не применил порог 2');
  await expect(refused).toHaveAttribute('role', 'alert');
  await expect(policy.locator('[data-input-policy-drift]')).toContainText('config-apply');
  // Позднейшая смена конфигурации не превращает решённый исход в другой.
  stage = 'later';
  await expect(policy.locator('[data-input-policy-drift]')).toHaveCount(0);
  await expect(policy.getByRole('button', { name: 'Применить порог' })).toBeVisible();
  await expect(refused).toContainText('Сервер не применил порог 2');
  await expect(policy.locator('[data-input-policy-outcome="applied"]')).toHaveCount(0);
});

test('config.json правлен и не применён: подсказка config-apply вместо формы', async ({ page }) => {
  const path = join(data, 'config.json');
  const before = readFileSync(path, 'utf8');
  const raw = JSON.parse(before) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...raw, concurrency: 3 }, null, 2) + '\n');
  try {
    await page.goto(url + '/?tab=progress');
    const policy = card(page);
    const drift = policy.locator('[data-input-policy-drift]');
    await expect(drift).toContainText('config.json отличается от действующей конфигурации');
    await expect(drift).toContainText('devcontour config-apply --keys');
    await expect(policy.getByRole('button', { name: 'Применить порог' })).toHaveCount(0);
  } finally {
    writeFileSync(path, before);
  }
  // Файл возвращён: форма снова доступна.
  await page.goto(url + '/?tab=progress');
  await expect(card(page).getByRole('button', { name: 'Применить порог' })).toBeVisible();
});

test('Порог объявлен в workspace.json: значение только для чтения и подсказка вместо формы', async ({
  page,
}) => {
  const file = join(registry, 'workspace.json');
  writeFileSync(file, JSON.stringify({ inputPolicy: { threshold: 9 } }));
  try {
    await page.goto(url + '/?tab=progress');
    const policy = card(page);
    const hint = policy.locator('[data-input-policy-declared]');
    await expect(hint).toContainText('объявлен в workspace.json');
    await expect(hint).toContainText('devcontour workspace-init --file <workspace.json>');
    await expect(hint).toContainText('devcontour config-apply --keys inputPolicy');
    // Действующее значение видно, формы, которая получила бы 409, нет.
    await expect(policy.locator('[data-input-policy-threshold]')).toHaveAttribute(
      'data-input-policy-threshold',
      '11',
    );
    await expect(policy.getByRole('button', { name: 'Применить порог' })).toHaveCount(0);
    await expect(policy.getByLabel('Порог', { exact: true })).toHaveCount(0);
    expect(
      (await new AxeBuilder({ page }).include('[data-input-policy]').analyze()).violations,
    ).toEqual([]);
  } finally {
    rmSync(file, { force: true });
  }
});
