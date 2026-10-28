import { test } from 'node:test';
import { testDemo } from './demo-pool.ts';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { loadConfig } from '../src/runner/config.ts';
import { config, input } from './helpers.ts';

/** Записать конфигурацию теста в config.json и загрузить её оттуда. */
function persisted(root: string, config: ReturnType<typeof loadConfig>) {
  const path = join(root, 'config.json');
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
  return loadConfig(path);
}
import { Scheduler } from '../src/runner/scheduler.ts';
import { adapters, reviewResult, reviewSchema, type AgentRequest } from '../src/runner/adapters.ts';
import { AgentService } from '../src/application/agent.ts';

// Реестр воспроизведений (без дублей, «наблюдено» только по журналу controller,
// передача следующей попытке), сопоставление команд, различающихся секретом,
// и короткий секрет в id запуска — гарантии runner harness:
// tests/reproductions.test.ts и tests/review-probe.test.ts пакета (S2-R1-06,
// S2-R2-05). Здесь — полный путь DevContour: маскирование ответа ревью и
// продуктовый брифинг ведущего по реестру задачи.

test('Схема ответа ревью требует класс входов, как у движка; ответ прежней формы без него разбирается', () => {
  const item = reviewSchema.properties.findings.items.properties.reproduction.anyOf[1] as {
    properties: Record<string, unknown>;
    required: string[];
  };
  assert.deepEqual(item.properties.inputClass, { type: ['string', 'null'] });
  assert.ok(item.required.includes('inputClass'), 'обязательное поле структурного ответа');
  const finding = (reproduction: Record<string, unknown>) => ({
    approved: false,
    summary: 's',
    findings: [{ severity: 'blocking', message: 'm', reproduction }],
  });
  const base = {
    property: 'REQ-1',
    input: '{}',
    expected: null,
    actual: null,
    command: null,
    executed: false,
    run: null,
  };
  const named = reviewResult.parse(finding({ ...base, inputClass: 'пустые входы' }));
  assert.equal(named.findings[0].reproduction?.inputClass, 'пустые входы');
  const legacy = reviewResult.parse(finding(base));
  assert.equal(legacy.findings[0].reproduction?.property, 'REQ-1', 'прежняя форма не отброшена');
});

test('Брифинг задачи ведущего показывает воспроизведения реестра задачи', () => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-repro-briefing-'));
  const store = new Store(join(root, 'state.sqlite'));
  try {
    const h = new DevContour(store, config());
    const board = h.createBoard('Search');
    const task = h.addTask(board.id, input('Search'));
    const other = h.addTask(board.id, input('Other'));
    const at = new Date().toISOString();
    store.change('test.reproductions', (s) => {
      s.reproductions = [task.id, task.id, other.id].map((taskId, i) => ({
        id: 'R-' + i,
        key: 'k-' + i,
        taskId,
        property: 'catalog-search',
        input: JSON.stringify({ q: String(i) }),
        inputHash: 'h-' + i,
        expected: null,
        actual: null,
        command: null,
        message: 'Пустой запрос ломает поиск',
        claimed: false,
        observed: false,
        status: 'proposed' as const,
        runs: [{ runId: 'run-' + i, sha: 'a'.repeat(40), contracts: {}, at }],
      }));
      return {};
    });
    const briefing = new AgentService(h).execute({
      operation: 'task_briefing',
      input: { taskId: task.id },
    }) as { items: { kind: string }[] };
    assert.equal(briefing.items.filter((x) => x.kind === 'reproduction').length, 2);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Review findings, summary and review.json are masked in every secret form', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-review-redaction-'));
  await testDemo(root);
  const config = loadConfig(join(root, 'config.json'));
  // Секрет с кавычкой: в review.json он экранирован как \".
  const secret = 'review"secret-4419';
  process.env.DEVCONTOUR_TEST_REVIEW_SECRET = secret;
  config.environment = {
    inherit: ['PATH', 'HOME'],
    values: {},
    secrets: { SECRET: 'DEVCONTOUR_TEST_REVIEW_SECRET' },
  };
  const store = new Store(join(root, 'state.sqlite'));
  // Правки конфигурации теста — через файл, как у настоящего запуска: процесс
  // с конфигурацией, изменённой в памяти, не вправе стать применённой.
  const h = new DevContour(store, persisted(root, config));
  const runtimes = {
    ...adapters,
    demo: {
      name: 'demo' as const,
      async execute(r: AgentRequest) {
        if (!r.review) return adapters.demo.execute(r);
        return {
          data: {
            approved: false,
            summary: 'Fails on ' + secret,
            discoveries: [],
            findings: [
              {
                severity: 'blocking',
                message: 'Reads file ' + secret,
                path: secret,
                line: null,
                rule: null,
                consequence: secret,
                evidence: 'cat ' + secret,
                reproduction: null,
              },
            ],
          },
          log: 'fixture',
          command: ['fixture', secret],
        };
      },
    },
  };
  const scheduler = new Scheduler(h, root, runtimes);
  const forms = [secret, JSON.stringify(secret).slice(1, -1)];
  const leaks = (text: string) => forms.filter((form) => text.includes(form));
  try {
    await scheduler.init();
    for (const t of store.read().tasks) if (t.status !== 'done') h.cancel(t.id);
    const board = h.createBoard('Review secret');
    const task = h.addTask(board.id, {
      title: 'Review secret',
      description: 'Ревьюер называет секрет.',
      role: 'qa',
      acceptance: ['catalog-search'],
    });
    h.approve(board.id);
    h.pause(false);
    await scheduler.drain();
    const run = store.read().runs.findLast((r) => r.taskId === task.id)!;
    const review = run.evidence.find((e) => e.kind === 'review')!;
    assert.ok(review, 'ревью записано');
    assert.deepEqual(leaks(JSON.stringify(review)), [], 'evidence ревью');
    assert.deepEqual(leaks(await readFile(review.log, 'utf8')), [], 'review.json');
    assert.deepEqual(leaks(run.error ?? ''), [], 'отказ попытки');
  } finally {
    delete process.env.DEVCONTOUR_TEST_REVIEW_SECRET;
    await scheduler.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
