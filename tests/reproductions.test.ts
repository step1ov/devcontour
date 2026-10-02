import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupDemo } from '../src/demo.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { adapters, cliAdapter, type AgentRequest } from '../src/runner/adapters.ts';
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
        const ran = await new ReviewProbes(spec).run({ argv: command });
        // Та же запись журнала, но команда не запускалась: бюджет исчерпан.
        const late = await new ReviewProbes({ ...spec, deadline: Date.now() }).run({
          argv: exhausted,
        });
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
                run: ran.runId,
              }),
              // Гипотеза: запуска не было, и журнал контура его не видел.
              finding('Unicode query may break', {
                property: 'catalog-search',
                input: '{"q":"é"}',
                expected: null,
                actual: null,
                command: [process.execPath, '-e', '0'],
                executed: true,
                run: null,
              }),
              finding('Large query may time out', {
                property: 'catalog-search',
                input: '{"q":"large"}',
                expected: null,
                actual: null,
                command: exhausted,
                executed: true,
                run: late.runId,
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
  // Сервер проверок получает секреты под их именами в окружении прогона — так
  // их передаёт CLI ревьюера; заглушка запускает его в этом процессе.
  process.env.A = 'secret-alpha-1123';
  process.env.B = 'secret-bravo-5813';
  let recorded: string[] = [];
  const runs = { a: '', literal: '' };
  config.environment = {
    inherit: ['PATH', 'HOME'],
    values: {},
    secrets: { A: 'DEVCONTOUR_TEST_SECRET_A', B: 'DEVCONTOUR_TEST_SECRET_B' },
  };
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, config);
  const ran = [process.execPath, '-e', 'process.exit(1)', 'secret-alpha-1123'];
  const notRun = [process.execPath, '-e', 'process.exit(1)', 'secret-bravo-5813'];
  const literalArgv = [process.execPath, '-e', 'process.exit(1)', '[REDACTED]'];
  const finding = (input: string, command: string[], run: string | null) => ({
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
      run,
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
        // Запущены команда с секретом A и команда с буквальным [REDACTED].
        const a = await new ReviewProbes(spec).run({ argv: ran });
        recorded = a.argv;
        runs.a = a.runId;
        const literal = await new ReviewProbes(spec).run({ argv: literalArgv });
        runs.literal = literal.runId;
        const data = {
          approved: false,
          summary: 'Three inputs',
          discoveries: [],
          findings: [
            finding('{"q":"a"}', ran, a.runId),
            finding('{"q":"b"}', notRun, null),
            // Ревьюер сообщает команду с секретом B, ссылаясь на запуск с
            // буквальным [REDACTED]: реестр записывает то, что запускалось.
            finding('{"q":"c"}', notRun, literal.runId),
          ],
        };
        // Как штатный адаптер: ответ маскируется до разбора.
        return {
          data: JSON.parse(r.execution!.redact(JSON.stringify(data))) as unknown,
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
    const byInput = (input: string) => registry.find((r) => r.input === input)!;
    assert.equal(byInput('{"q":"a"}').observed, true, 'запущенная — несмотря на маску ответа');
    assert.equal(recorded.includes('secret-alpha-1123'), false, 'журнал хранит маску');
    assert.deepEqual(byInput('{"q":"a"}').command, recorded, 'команда — из журнала контура');
    assert.equal(byInput('{"q":"b"}').observed, false, 'без ссылки на запуск — гипотеза');
    // Ссылка на чужой запуск подтверждает только тот запуск: команда в
    // реестре — его, а не сообщённая ревьюером.
    // Замаскированные команды A и C выглядят одинаково; наблюдения различает
    // id запуска — у каждого свой.
    assert.equal(byInput('{"q":"a"}').run, runs.a);
    assert.equal(byInput('{"q":"c"}').run, runs.literal);
    assert.notEqual(runs.a, runs.literal);
    assert.equal(byInput('{"q":"b"}').run, null);
  } finally {
    delete process.env.DEVCONTOUR_TEST_SECRET_A;
    delete process.env.DEVCONTOUR_TEST_SECRET_B;
    delete process.env.A;
    delete process.env.B;
    await scheduler.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Through the real Codex adapter a short secret neither breaks the run id nor leaves a hypothesis command on an observed record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-observed-cli-'));
  await setupDemo(root);
  const config = loadConfig(join(root, 'config.json'));
  // Секрет из одной цифры задевает символы id запуска в ответе, который
  // штатный адаптер маскирует до разбора.
  process.env.DEVCONTOUR_TEST_DIGIT_SECRET = '1';
  config.environment = {
    inherit: ['PATH', 'HOME'],
    values: {},
    secrets: { DIGIT: 'DEVCONTOUR_TEST_DIGIT_SECRET' },
  };
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, config);
  // Фиктивный codex: запускает проверку через сервер проверок по своей
  // MCP-конфигурации и пишет ответ ревьюера, как настоящий CLI.
  const bin = join(root, 'fake-bin');
  await mkdir(bin);
  const fake = join(root, 'fake-codex.mjs');
  await writeFile(
    fake,
    `import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.0.0-fake'); process.exit(0); }
readFileSync(0, 'utf8');
const out = args[args.indexOf('--output-last-message') + 1];
const spec = /"([^"]*probe\\.json)"/.exec(args.find((a) => a.startsWith('mcp_servers=')) ?? '')[1];
const { ReviewProbes, probeSpec } = await import(${JSON.stringify(new URL('../src/runner/review-probe.ts', import.meta.url).href)});
const argv = [process.execPath, '-e', 'process.exit(2)'];
const ran = await new ReviewProbes(probeSpec.parse(JSON.parse(readFileSync(spec, 'utf8')))).run({ argv });
const finding = (command, run) => ({ severity: 'blocking', message: 'Fails', path: null, line: null, rule: null, consequence: null, evidence: null,
  reproduction: { property: 'catalog-search', input: '{"q":"x"}', expected: null, actual: null, command, executed: run !== null, run } });
writeFileSync(out, JSON.stringify({ approved: false, summary: 'Fails', discoveries: [],
  execution: { commands: [], noCommandsReason: 'fixture' },
  findings: [finding([process.execPath, '-e', 'process.exit(73)', 'NEVER_EXECUTED'], null), finding(argv, ran.runId)] }));
`,
  );
  await writeFile(
    join(bin, 'codex'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(import.meta.resolve('tsx'))} ${JSON.stringify(fake)} "$@"\n`,
  );
  await chmod(join(bin, 'codex'), 0o755);
  const codex = cliAdapter('codex');
  const runtimes = {
    ...adapters,
    demo: {
      name: 'codex' as const,
      execute(r: AgentRequest) {
        if (!r.review) return adapters.demo.execute(r);
        return codex.execute({
          ...r,
          execution: {
            ...r.execution!,
            env: { ...r.execution!.env, PATH: `${bin}:${r.execution!.env.PATH}` },
          },
        });
      },
    },
  };
  const scheduler = new Scheduler(h, root, runtimes);
  try {
    await scheduler.init();
    for (const t of store.read().tasks) if (t.status !== 'done') h.cancel(t.id);
    const board = h.createBoard('Observed through CLI');
    const task = h.addTask(board.id, {
      title: 'Observed through CLI',
      description: 'Ответ ревьюера идёт через штатный адаптер.',
      role: 'qa',
      acceptance: ['catalog-search'],
    });
    h.approve(board.id);
    h.pause(false);
    await scheduler.drain();
    const registry = (store.read().reproductions ?? []).filter((r) => r.taskId === task.id);
    assert.equal(registry.length, 1, 'один вход — одна запись');
    const record = registry[0];
    assert.equal(record.observed, true, 'id запуска пережил маску ответа');
    // Команда и id — из журнала контура, а не из гипотезы на тот же вход.
    const dir = store.read().runs.findLast((r) => r.taskId === task.id)!;
    const logged = (
      await readFile(join(root, 'artifacts', dir.id, 'candidate', 'review', 'probes.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { runId: string; argv: string[] });
    assert.equal(record.run, logged[0].runId);
    assert.deepEqual(record.command, logged[0].argv);
    assert.equal(JSON.stringify(record.command).includes('NEVER_EXECUTED'), false);
  } finally {
    delete process.env.DEVCONTOUR_TEST_DIGIT_SECRET;
    await scheduler.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
