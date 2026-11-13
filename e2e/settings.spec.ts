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

// Экран «Настройки»: модели ролей. Свой учебный сервер в процессе теста:
// смена моделей меняет конфигурацию и утверждения общего демо-проекта.
// Исполнители — учебный runtime `demo`; модель codex названа только тарифом
// (fixture, вызова модели нет).

useLiveCliGuard();
test.describe.configure({ mode: 'serial' });

const gitKeys = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const;

let root = '';
let data = '';
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
  root = realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-ui-settings-')));
  data = join(root, 'data');
  await setupDemo(data, { checkoutRoot: join(root, 'checkouts') });
  const path = join(data, 'config.json');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  // Модель, которую workspace знает по тарифу.
  const prices = [
    {
      runtime: 'codex',
      model: 'EXAMPLE_CODEX_B',
      effectiveAt: '2026-01-01T00:00:00Z',
      input: 1,
      output: 4,
      cacheRead: 0.1,
      cacheWrite: 1,
    },
  ];
  // Каталог workspace с эскизом дизайна: эскиз открывается из панели и отдельно.
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, 'docs/design'), { recursive: true });
  writeFileSync(
    join(workspace, 'docs/design/sketch.html'),
    `<!doctype html><title>Эскиз</title><body><script>
      const probe = (path, init) =>
        fetch(path, init).then((r) => String(r.status), () => 'blocked');
      Promise.all([
        probe('/api/config/settings'),
        probe('/api/config/models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-DevContour-Request': '1' },
          body: JSON.stringify({ changes: [{ slot: 'writer:main:qa', binding: { runtime: 'codex' } }] }),
        }),
      ]).then((r) => { document.body.dataset.result = r.join('|'); });
    </script></body>`,
  );
  writeFileSync(path, JSON.stringify({ ...raw, prices, workspaceRoot: workspace }, null, 2) + '\n');
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
  if (root && root.startsWith(realpathSync(tmpdir()) + sep) && root.includes('ui-settings-'))
    rmSync(root, { recursive: true, force: true });
});

const models = (page: Page) => page.getByRole('region', { name: 'Модели ролей' });
const configFile = () =>
  JSON.parse(readFileSync(join(data, 'config.json'), 'utf8')) as {
    roles: Record<string, unknown>;
  };

test('Владелец меняет модель исполнителя: последствия до записи, подтверждение, применение', async ({
  page,
  request,
}) => {
  await page.goto(url + '/?tab=settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Настройки' })).toBeVisible();
  const card = models(page);
  const qa = card.locator('[data-model-slot="writer:main:qa"]');
  await expect(qa.locator('[data-model-current]')).toHaveText('demo · модель CLI по умолчанию');
  await expect(qa).toContainText('config.json');
  // Порог вопросов — на том же экране.
  await expect(page.getByRole('region', { name: 'Вопросы исполнителя' })).toBeVisible();
  expect((await new AxeBuilder({ page }).include('[data-settings]').analyze()).violations).toEqual(
    [],
  );
  const check = card.getByRole('button', { name: 'Проверить изменения' });
  await expect(check).toBeDisabled();
  await card.getByLabel('Тестировщик, исполнитель: runtime').selectOption('codex');
  // Модели — только известные workspace: CLI по умолчанию и модель тарифа.
  const model = card.getByLabel('Тестировщик, исполнитель: модель');
  await expect(model.locator('option')).toHaveText(['модель CLI по умолчанию', 'EXAMPLE_CODEX_B']);
  await model.selectOption('EXAMPLE_CODEX_B');
  await card.getByLabel('Тестировщик, исполнитель: уровень рассуждения').selectOption('low');
  await check.click();
  const effects = card.locator('[data-model-effects]');
  await expect(effects).toBeFocused();
  await expect(effects).toContainText('Тестировщик, исполнитель');
  await expect(card.locator('[data-model-effective]')).toContainText('main · Тестировщик');
  await expect(effects).toContainText('codex · EXAMPLE_CODEX_B · effort low');
  await expect(effects).toContainText('со следующей попытки');
  // Утверждённые задачи демо закреплены при прежних моделях: нужно подтверждение.
  await expect(card.locator('[data-model-reapproval]')).toContainText('утверждён заново');
  const apply = card.getByRole('button', { name: 'Применить модели' });
  await expect(apply).toBeDisabled();
  // Предпросмотр ничего не пишет.
  expect(configFile().roles.qa).toEqual({ runtime: 'demo' });
  await card.getByLabel(/Понимаю: \d+ задач потребуют повторного утверждения плана/).check();
  await apply.click();
  const status = card.locator('[data-model-status]');
  await expect(status).toBeFocused();
  const outcome = card.locator('[data-model-outcome="applied"]');
  await expect(outcome).toContainText('Применено');
  await expect(outcome).toContainText('config.applied');
  await expect(card.locator('[data-model-alert]')).toHaveText('');
  expect(configFile().roles.qa).toEqual({
    runtime: 'codex',
    model: 'EXAMPLE_CODEX_B',
    effort: 'low',
  });
  await expect(qa.locator('[data-model-current]')).toHaveText(
    'codex · EXAMPLE_CODEX_B · effort low',
  );
  const events = (await (await request.get(url + '/api/events?limit=20')).json()) as {
    items: { type: string; data?: { operation?: string } }[];
  };
  expect(events.items.find((e) => e.type === 'config.applied')?.data?.operation).toMatch(
    /^config-apply:models:/,
  );
});

test('Устаревший digest: отказ 409, ошибка в карточке, файл не изменён', async ({ page }) => {
  await page.route('**/api/config/settings', async (route) => {
    const response = await route.fetch();
    const state = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...state, configDigest: 'a'.repeat(64) } });
  });
  const before = readFileSync(join(data, 'config.json'), 'utf8');
  await page.goto(url + '/?tab=settings');
  const card = models(page);
  await card.getByLabel('Разработчик бэкенда, исполнитель: runtime').selectOption('codex');
  await card.getByRole('button', { name: 'Проверить изменения' }).click();
  const alert = card.locator('[data-model-alert]');
  await expect(alert).toContainText('Модели не изменены');
  await expect(alert).toContainText('обновите страницу');
  await expect(card.locator('[data-model-effects]')).toHaveCount(0);
  expect(readFileSync(join(data, 'config.json'), 'utf8')).toBe(before);
});

test('Эскиз дизайна, открытый отдельно, не может вызвать маршруты настроек', async ({ page }) => {
  const before = readFileSync(join(data, 'config.json'), 'utf8');
  await page.goto(url + '/api/design/file/docs/design/sketch.html');
  // Скрипт эскиза работает, но источник страницы непрозрачный (песочница CSP).
  expect(await page.evaluate(() => window.origin)).toBe('null');
  await expect(page.locator('body')).toHaveAttribute('data-result', 'blocked|blocked');
  expect(readFileSync(join(data, 'config.json'), 'utf8')).toBe(before);
});
