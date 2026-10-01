import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupDemo } from '../src/demo.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { adapters, type AgentRequest } from '../src/runner/adapters.ts';
import { ReviewProbes, probeSpec } from '../src/runner/review-probe.ts';
import { AgentService } from '../src/application/agent.ts';

test('Review reproductions form a deduplicated task registry, observed only through the controller log, and reach the next attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-repro-'));
  await setupDemo(root);
  const config = loadConfig(join(root, 'config.json'));
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, config);
  const requests: AgentRequest[] = [];
  const command = [process.execPath, '-e', 'process.exit(1)'];
  const exhausted = [process.execPath, '-e', 'process.exit(2)'];
  // Ревьюер с именем codex получает инструмент проверок, запускает через него
  // воспроизведение и каждый раз отклоняет с тем же входом.
  const runtimes = {
    ...adapters,
    demo: {
      name: 'codex' as const,
      async execute(r: AgentRequest) {
        requests.push(r);
        if (!r.review) return adapters.demo.execute(r);
        const path = r.probe!.args[r.probe!.args.indexOf('--spec') + 1];
        const spec = probeSpec.parse(JSON.parse(await readFile(path, 'utf8')));
        await new ReviewProbes(spec).run({ argv: command });
        // Та же запись журнала, но команда не запускалась: бюджет исчерпан.
        await new ReviewProbes({ ...spec, deadline: Date.now() }).run({ argv: exhausted });
        const finding = (message: string, reproduction: unknown) => ({
          severity: 'blocking',
          message,
          path: null,
          line: null,
          rule: 'acceptance',
          consequence: null,
          evidence: null,
          reproduction,
        });
        return {
          data: {
            approved: false,
            summary: 'Fails on an empty catalog',
            discoveries: [],
            findings: [
              finding('Empty query crashes', {
                property: 'catalog-search',
                input: '{"q":""}',
                expected: '{"items":[],"total":0}',
                actual: 'TypeError',
                command,
                executed: true,
              }),
              // Гипотеза: запуска не было, и журнал контура его не видел.
              finding('Unicode query may break', {
                property: 'catalog-search',
                input: '{"q":"é"}',
                expected: null,
                actual: null,
                command: [process.execPath, '-e', '0'],
                executed: true,
              }),
              finding('Large query may time out', {
                property: 'catalog-search',
                input: '{"q":"large"}',
                expected: null,
                actual: null,
                command: exhausted,
                executed: true,
              }),
              finding('Naming is unclear', null),
            ],
          },
          log: 'fixture',
          command: [],
        };
      },
    },
  };
  const scheduler = new Scheduler(h, root, runtimes);
  try {
    await scheduler.init();
    for (const t of store.read().tasks) if (t.status !== 'done') h.cancel(t.id);
    const board = h.createBoard('Search');
    const task = h.addTask(board.id, {
      title: 'Search',
      description: 'Поиск по каталогу.',
      role: 'qa',
      acceptance: ['catalog-search'],
    });
    h.approve(board.id);
    h.pause(false);
    await scheduler.drain();
    // Повтор после отклонения запускает ведущий.
    h.retry(task.id);
    h.pause(false);
    await scheduler.drain();

    const attempts = store.read().runs.filter((r) => r.taskId === task.id);
    assert.equal(attempts.length, 2);
    const registry = (store.read().reproductions ?? []).filter((r) => r.taskId === task.id);
    // Один вход — одна запись, сколько бы попыток её ни встретили.
    assert.equal(registry.length, 3);
    const empty = registry.find((r) => r.input === '{"q":""}')!;
    assert.equal(empty.runs.length, attempts.length);
    assert.equal(empty.claimed, true);
    assert.equal(empty.observed, true, 'запуск подтверждён журналом контура');
    const unicode = registry.find((r) => r.input === '{"q":"é"}')!;
    assert.equal(unicode.claimed, true);
    assert.equal(unicode.observed, false, 'слова модели без запуска — гипотеза');
    assert.equal(empty.status, 'proposed');
    // Запись журнала с исчерпанным бюджетом — не наблюдение запуска.
    assert.equal(registry.find((r) => r.input === '{"q":"large"}')!.observed, false);

    // Следующая попытка исполнителя видит входы, на которых задача ломалась.
    const writers = requests.filter((r) => !r.review && r.task.id === task.id);
    assert.doesNotMatch(writers[0].prompt, /Reproductions recorded/);
    assert.match(writers[1].prompt, /Reproductions recorded.*\{\\"q\\":\\"\\"\}/s);

    // Ведущий видит их в брифинге задачи.
    const briefing = new AgentService(h).execute({
      operation: 'task_briefing',
      input: { taskId: task.id },
    }) as { items: { kind: string }[] };
    assert.equal(briefing.items.filter((s) => s.kind === 'reproduction').length, 3);
  } finally {
    await scheduler.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Review findings, summary and review.json are masked in every secret form', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-review-redaction-'));
  await setupDemo(root);
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
  const h = new DevContour(store, config);
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

test('Commands that differ only by a secret are not confused when matching observed runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-observed-'));
  await setupDemo(root);
  const config = loadConfig(join(root, 'config.json'));
  process.env.DEVCONTOUR_TEST_SECRET_A = 'secret-alpha-1123';
  process.env.DEVCONTOUR_TEST_SECRET_B = 'secret-bravo-5813';
  config.environment = {
    inherit: ['PATH', 'HOME'],
    values: {},
    secrets: { A: 'DEVCONTOUR_TEST_SECRET_A', B: 'DEVCONTOUR_TEST_SECRET_B' },
  };
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, config);
  const ran = [process.execPath, '-e', 'process.exit(1)', 'secret-alpha-1123'];
  const notRun = [process.execPath, '-e', 'process.exit(1)', 'secret-bravo-5813'];
  const finding = (input: string, command: string[]) => ({
    severity: 'blocking',
    message: 'Fails',
    path: null,
    line: null,
    rule: null,
    consequence: null,
    evidence: null,
    reproduction: {
      property: 'catalog-search',
      input,
      expected: null,
      actual: null,
      command,
      executed: true,
    },
  });
  const runtimes = {
    ...adapters,
    demo: {
      name: 'codex' as const,
      async execute(r: AgentRequest) {
        if (!r.review) return adapters.demo.execute(r);
        const path = r.probe!.args[r.probe!.args.indexOf('--spec') + 1];
        const spec = probeSpec.parse(JSON.parse(await readFile(path, 'utf8')));
        // Запущена только команда с секретом A.
        await new ReviewProbes(spec).run({ argv: ran });
        return {
          data: {
            approved: false,
            summary: 'Two inputs',
            discoveries: [],
            findings: [finding('{"q":"a"}', ran), finding('{"q":"b"}', notRun)],
          },
          log: 'fixture',
          command: [],
        };
      },
    },
  };
  const scheduler = new Scheduler(h, root, runtimes);
  try {
    await scheduler.init();
    for (const t of store.read().tasks) if (t.status !== 'done') h.cancel(t.id);
    const board = h.createBoard('Observed');
    const task = h.addTask(board.id, {
      title: 'Observed',
      description: 'Две команды различаются секретом.',
      role: 'qa',
      acceptance: ['catalog-search'],
    });
    h.approve(board.id);
    h.pause(false);
    await scheduler.drain();
    const registry = (store.read().reproductions ?? []).filter((r) => r.taskId === task.id);
    assert.equal(registry.find((r) => r.input === '{"q":"a"}')?.observed, true, 'запущенная');
    assert.equal(registry.find((r) => r.input === '{"q":"b"}')?.observed, false, 'незапущенная');
  } finally {
    delete process.env.DEVCONTOUR_TEST_SECRET_A;
    delete process.env.DEVCONTOUR_TEST_SECRET_B;
    await scheduler.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
