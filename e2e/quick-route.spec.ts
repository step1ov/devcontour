import { test, expect, type Request } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { startWorkspace } from '../src/runner/start.ts';

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Quick UI',
  GIT_AUTHOR_EMAIL: 'quick-ui@example.invalid',
  GIT_COMMITTER_NAME: 'Quick UI',
  GIT_COMMITTER_EMAIL: 'quick-ui@example.invalid',
};
const prefix = 'devcontour-ui-quick-';

/** Существующий npm-репозиторий со своими проверками, правилами и коммитом. */
function repository() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  mkdirSync(join(root, 'src'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'existing-app',
        private: true,
        scripts: { test: 'node --test', lint: 'node --check src/index.js' },
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(
    join(root, 'package-lock.json'),
    '{"name":"existing-app","lockfileVersion":3,"packages":{}}\n',
  );
  writeFileSync(join(root, 'src/index.js'), 'export const add = (a, b) => a + b;\n');
  writeFileSync(join(root, 'AGENTS.md'), '# Own rules\nKeep them.\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { env });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'existing project');
  return root;
}
/** Удаляет только созданный этим тестом каталог во временной папке системы. */
function remove(root: string) {
  if (dirname(root) === realpathSync(tmpdir()) && basename(root).startsWith(prefix))
    rmSync(root, { recursive: true, force: true });
}

test('Quick change: one change per request key, five steps, facts, setup plan, restore after reload', async ({
  page,
  request,
}) => {
  const root = repository();
  const app = await startWorkspace(root, { port: 0, workspaceMode: 'embedded' });
  const brief = 'add() должна правильно складывать отрицательные числа';
  const criterion = 'add(-2, -3) возвращает -5';
  const quickBodies: Record<string, string>[] = [];
  const record = (r: Request) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/preparation/quick')
      quickBodies.push(r.postDataJSON() as Record<string, string>);
  };
  page.on('request', record);
  const changes = async () =>
    (
      (await (await request.get(app.url + '/api/preparation')).json()) as {
        changes: { id: string; title: string }[];
      }
    ).changes;
  try {
    await page.goto(app.url);
    const form = page.getByRole('form', { name: 'Быстрое изменение' });
    // Embedded workspace — корень репозитория: путь подставлен.
    await expect(form.getByLabel('Репозиторий (абсолютный путь)')).toHaveValue(root);
    // Примеры — только подсказка, а не значение.
    await expect(form.getByLabel('Что изменить')).toHaveValue('');
    await form.getByLabel('Что изменить').fill(brief);
    await form.getByLabel('Как проверить результат').fill(criterion);

    // Ответ потерян (сервер недоступен): текст остаётся, ошибка видна.
    await page.route('**/api/preparation/quick', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Сервер временно недоступен' }),
          })
        : route.fallback(),
    );
    await form.getByRole('button', { name: 'Начать быстрое изменение' }).click();
    await expect(form.getByRole('alert')).toContainText('Сервер временно недоступен');
    await expect(form.getByLabel('Что изменить')).toHaveValue(brief);
    await page.unroute('**/api/preparation/quick');
    const key = quickBodies[0].requestKey;
    expect(key).toMatch(/^[A-Za-z0-9_-]{8,80}$/);
    expect(quickBodies[0].title).toBe(brief);

    // Тот же ключ уже занят другим поручением: настоящий 409 сервера.
    const other = await request.post(app.url + '/api/preparation/quick', {
      headers: { 'X-DevContour-Request': '1' },
      data: {
        requestKey: key,
        title: 'Чужое поручение',
        repository: root,
        brief: 'Совсем другое поручение под тем же ключом',
        criterion: 'Другой критерий',
      },
    });
    expect(other.ok()).toBe(true);
    await form.getByRole('button', { name: 'Начать быстрое изменение' }).click();
    await expect(form.getByRole('alert')).toContainText('Ключ запроса уже использован');
    expect(quickBodies.at(-1)!.requestKey).toBe(key);
    await expect(form.getByLabel('Как проверить результат')).toHaveValue(criterion);

    // Перезагрузка не теряет набранное.
    await page.reload();
    const restored = page.getByRole('form', { name: 'Быстрое изменение' });
    await expect(restored.getByLabel('Что изменить')).toHaveValue(brief);
    await expect(restored.getByLabel('Как проверить результат')).toHaveValue(criterion);

    // Правка — другое поручение и новый ключ; двойной щелчок — одно изменение.
    await restored.getByLabel('Как проверить результат').fill(criterion + ' и add(2, 3) — 5');
    const sent = quickBodies.length;
    await restored.getByRole('button', { name: 'Начать быстрое изменение' }).dblclick();
    await expect(page.getByRole('region', { name: 'Быстрое изменение' })).toBeVisible();
    const keys = new Set(quickBodies.slice(sent).map((b) => b.requestKey));
    expect(keys.size).toBe(1);
    expect(keys.has(key)).toBe(false);
    const after = await changes();
    expect(after.filter((c) => c.title === brief)).toHaveLength(1);
    expect(after).toHaveLength(2);
    // Форма очищена после успеха.
    await expect(restored.getByLabel('Что изменить')).toHaveValue('');

    const route = page.getByRole('region', { name: 'Быстрое изменение' });
    const steps = route
      .getByRole('list', { name: 'Шаги быстрого изменения' })
      .getByRole('listitem');
    await expect(steps).toHaveCount(5);
    await expect(steps.nth(0)).toContainText('Подключение');
    await expect(steps.nth(0)).toContainText('Готово');
    await expect(steps.nth(4)).toContainText('Результат');
    await expect(route.getByText(criterion + ' и add(2, 3) — 5')).toBeVisible();
    const facts = route.getByRole('definition').filter({ hasText: 'package-lock.json' });
    await expect(facts).toBeVisible();
    await expect(route.getByText('test: node --test')).toBeVisible();
    await expect(route.getByText(/main · [0-9a-f]{12}/)).toBeVisible();
    // Ведущего агента нет: не изображаем работу, даём поручение.
    await expect(route.getByText('Нужен ведущий агент')).toBeVisible();
    await expect(route.getByLabel('Поручение ведущему агенту')).toHaveValue(
      new RegExp('preparation_setup'),
    );

    // Ведущий агент предлагает setup: план файлов без записи.
    const changeId = after.find((c) => c.title === brief)!.id;
    const proposed = await request.post(app.url + '/api/agent', {
      headers: { 'X-DevContour-Request': '1' },
      data: {
        operation: 'preparation_setup',
        input: {
          changeId,
          expectedDigest: null,
          profile: 'npm-project',
          gates: [
            { id: 'install', kind: 'check', command: ['npm', 'ci'], timeoutMs: 600000 },
            {
              id: 'unit-tests',
              kind: 'test',
              command: [
                'node',
                '--test',
                '--test-reporter=junit',
                '--test-reporter-destination=.reports/junit.xml',
              ],
              timeoutMs: 240000,
              dependsOn: ['install'],
              report: { type: 'junit', path: '.reports/junit.xml' },
            },
          ],
          reason: 'Проверки проекта: install и unit-тесты',
        },
      },
    });
    expect(proposed.ok(), await proposed.text()).toBe(true);
    const plan = route.getByRole('table', { name: 'План файлов setup' });
    await expect(plan).toBeVisible({ timeout: 20000 });
    await expect(plan.getByRole('row').filter({ hasText: 'AGENTS.md' })).toContainText(
      'сохранится',
    );
    await route.getByText(/^Новые файлы \(\d+\)$/).click();
    const created = route.getByRole('table', { name: 'Новые файлы setup' });
    await expect(created.getByRole('row').filter({ hasText: 'config.json' })).toContainText(
      'создастся',
    );
    await expect(route.getByText('npm ci')).toBeVisible();
    await expect(route.getByText(/файлы не записаны/)).toBeVisible();

    // Перезагрузка восстанавливает выбранное изменение и его маршрут.
    await page.reload();
    await expect(
      page.getByRole('region', { name: 'Быстрое изменение' }).getByRole('table', {
        name: 'План файлов setup',
      }),
    ).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: 'test-results/quick-route.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: 'test-results/quick-route-390.png', fullPage: true });
  } finally {
    page.off('request', record);
    // Панель опрашивает сервер; закрытие сервера ждёт занятые keep-alive
    // соединения, поэтому страница закрывается первой.
    await page.close();
    await app.close();
    remove(root);
  }
});
