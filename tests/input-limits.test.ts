// Пределы приёма: новая постановка и файлы агента ограничены до разбора, а уже
// сохранённое состояние сверх предела продолжает читаться.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { AgentService } from '../src/application/agent.ts';
import { DomainError, taskIngest, taskInput, TASK_LIMITS } from '../src/core/model.ts';
import { planIngest, planResult } from '../src/core/plan.ts';
import { recordsFromState } from '../src/core/sync-state.ts';
import { recordSchema } from '../src/core/sync-model.ts';
import { specDigest } from '../src/core/service.ts';
import { cliAdapter, type AgentRequest } from '../src/runner/adapters.ts';
import { agentFileBytes, readAgentFile, readAgentJson } from '../src/runner/json-file.ts';
import { redactor } from '../src/runner/redaction.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { serve } from '../src/server/http.ts';
import { createMcpServer } from '../src/server/mcp.ts';
import { fixture, input } from './helpers.ts';

const ids = (count: number, prefix = 'r') =>
  Array.from({ length: count }, (_, i) => `${prefix}${i}`);
const plan = (task: object) => ({
  title: 'Limits',
  description: 'Plan at the limits',
  tasks: [{ ...input(), key: 'a', contracts: [], dependsOn: [], ...task }],
});
const related = TASK_LIMITS.relatedRepositories;
const strings = (count: number) => ids(count, 'criterion-');

for (const [field, limit, make, message] of [
  ['relatedRepositories', related, ids, /Связанных компонентов не больше 100/],
  ['dependsOn', TASK_LIMITS.dependsOn, ids, /Зависимостей задачи не больше 100/],
  ['acceptance', TASK_LIMITS.acceptance, strings, /Критериев приёмки не больше 30/],
  ['contracts', TASK_LIMITS.contracts, ids, /Контрактов задачи не больше 30/],
] as const)
  test(`plan_import: ${field} принимает ${limit} и отказывает на ${limit + 1}`, () => {
    assert.equal(planIngest.safeParse(plan({ [field]: make(limit) })).success, true);
    const over = plan({ [field]: make(limit + 1) });
    const f = fixture();
    try {
      assert.throws(
        () => f.h.importPlan(over),
        (e: Error) =>
          e instanceof DomainError &&
          e.status === 400 &&
          e.message.startsWith('План не принят') &&
          message.test(e.message),
      );
      assert.throws(
        () => new AgentService(f.h).execute({ operation: 'plan_import', input: { plan: over } }),
        message,
      );
      assert.equal(f.store.read().tasks.length, 0);
    } finally {
      f.cleanup();
    }
  });

test('Схема плана harness не меняется: пределы задачи — только на приёме', () => {
  assert.equal(planResult.safeParse(plan({ acceptance: strings(31) })).success, true);
});

test('План с критериями ровно на пределе импортируется', () => {
  const f = fixture();
  try {
    f.h.importPlan(plan({ acceptance: strings(TASK_LIMITS.acceptance) }));
    assert.equal(f.store.read().tasks[0].acceptance.length, TASK_LIMITS.acceptance);
  } finally {
    f.cleanup();
  }
});

test('task_create и task_edit: связанных компонентов до 100, 101 — отказ', () => {
  const f = fixture();
  try {
    const main = f.h.config.repositories[0] ?? {
      id: 'main',
      path: f.h.config.repository,
      targetBranch: f.h.config.targetBranch,
    };
    f.h.config.repositories = [main, ...ids(related).map((id) => ({ ...main, id }))];
    const service = new AgentService(f.h);
    const boardId = f.h.createBoard('Limits').id;
    const task = (count: number) => ({
      ...input(),
      scope: 'workspace',
      relatedRepositories: ids(count),
    });
    const created = service.execute({
      operation: 'task_create',
      input: { boardId, task: task(related) },
    }) as { taskId: string };
    const stored = f.store.read().tasks.find((t) => t.id === created.taskId)!;
    assert.equal(stored.relatedRepositories?.length, related);
    const message = /Связанных компонентов не больше 100/;
    assert.throws(
      () =>
        service.execute({ operation: 'task_create', input: { boardId, task: task(related + 1) } }),
      message,
    );
    assert.throws(
      () =>
        service.execute({
          operation: 'task_edit',
          input: {
            taskId: stored.id,
            expectedDigest: specDigest(stored),
            task: task(related + 1),
          },
        }),
      message,
    );
    assert.throws(() => f.h.addTask(boardId, task(related + 1)), message);
    assert.equal(f.store.read().tasks.length, 1);
  } finally {
    f.cleanup();
  }
});

test('Сохранённая задача сверх нового предела читается, синхронизируется и считает digest', () => {
  const f = fixture();
  try {
    const board = f.h.createBoard('Legacy');
    const { id } = f.h.addTask(board.id, input());
    f.store.change('legacy', (s) => {
      s.tasks.find((t) => t.id === id)!.relatedRepositories = ids(related + 1);
    });
    const stored = f.store.read().tasks.find((t) => t.id === id)!;
    assert.equal(stored.relatedRepositories?.length, related + 1);
    assert.equal(taskInput.parse(stored).relatedRepositories?.length, related + 1);
    assert.equal(taskIngest.safeParse(stored).success, false);
    assert.match(specDigest(stored), /^[a-f0-9]{64}$/);
    const record = [...recordsFromState(f.h, f.store.read()).values()]
      .flatMap((records) => Object.values(records))
      .find((r) => r.kind === 'task');
    assert.ok(record);
    assert.equal(recordSchema.safeParse(record).success, true);
  } finally {
    f.cleanup();
  }
});

test('MCP: сверх предела — ошибка инструмента с понятным текстом, сервер продолжает работу', async () => {
  const f = fixture();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(new AgentService(f.h));
  const client = new Client({ name: 'limits', version: '1.0.0' });
  try {
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const boardId = f.h.createBoard('Limits').id;
    const refused = await client.callTool({
      name: 'task_create',
      arguments: {
        boardId,
        task: { ...input(), relatedRepositories: ids(related + 1) },
      },
    });
    assert.equal(refused.isError, true);
    assert.match(JSON.stringify(refused.content), /Связанных компонентов не больше 100/);
    const plain = await client.callTool({
      name: 'plan_import',
      arguments: { plan: plan({ acceptance: strings(TASK_LIMITS.acceptance + 1) }) },
    });
    assert.equal(plain.isError, true);
    assert.match(JSON.stringify(plain.content), /Критериев приёмки не больше 30/);
    const accepted = await client.callTool({
      name: 'task_create',
      arguments: { boardId, task: input() },
    });
    assert.equal(accepted.isError, undefined);
  } finally {
    await client.close();
    f.cleanup();
  }
});

test('HTTP: taskIds до 1000, roots до 100; сверх предела — 400 с названным полем', async () => {
  const f = fixture();
  const app = await serve(f.h, new Scheduler(f.h, f.root), { port: 0 });
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${app.url}/api/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DevContour-Request': '1' },
      body: JSON.stringify(body),
    });
    return { status: r.status, error: ((await r.json()) as { error?: string }).error };
  };
  try {
    const board = f.h.createBoard('Limits');
    const { id } = f.h.addTask(board.id, input());
    const approve = (taskIds: string[]) => post(`boards/${board.id}/approve`, { taskIds });
    const correct = (roots: string[]) =>
      post(`boards/${board.id}/correct`, { roots, reason: 'A reason long enough.' });

    const refused = await approve(ids(1001));
    assert.equal(refused.status, 400);
    assert.equal(refused.error, 'taskIds: Задач в одном утверждении не больше 1000');
    const atLimit = await approve([...ids(999), id]);
    assert.doesNotMatch(atLimit.error ?? '', /не больше/);

    const tooMany = await correct(ids(101));
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.error, 'roots: Корней корректировки не больше 100');
    // Предел пройден: отказывает уже домен, ревизия ещё не принята.
    assert.equal((await correct(ids(100))).error, 'Сначала примите текущую ревизию');
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('Файл агента: ровно предел читается, байт сверх него — отказ до чтения', async () => {
  const f = fixture();
  try {
    const path = join(f.root, 'agent.json');
    writeFileSync(path, '');
    truncateSync(path, agentFileBytes);
    assert.equal((await readAgentFile(path)).length, agentFileBytes);
    truncateSync(path, agentFileBytes + 1);
    await assert.rejects(readAgentFile(path), (e: Error) => {
      assert.ok(e instanceof DomainError);
      assert.equal(e.status, 413);
      assert.match(e.message, /4194305 байт при пределе 4194304/);
      return true;
    });
    writeFileSync(path, '{"ok":true}');
    assert.deepEqual(await readAgentJson(path), { ok: true });
  } finally {
    f.cleanup();
  }
});

test('Результат codex сверх предела отклоняется, ровно предел принимается', async () => {
  const f = fixture();
  try {
    const bin = join(f.root, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'codex'),
      `#!${process.execPath}
const fs = require('fs');
if (process.argv.includes('--version')) { console.log('codex fixture'); process.exit(0); }
const empty = JSON.stringify({ completed: true, summary: '' });
const summary = 'x'.repeat(Number(process.env.RESULT_BYTES) - empty.length);
const out = process.argv[process.argv.indexOf('--output-last-message') + 1];
fs.writeFileSync(out, JSON.stringify({ completed: true, summary }));
`,
      { mode: 0o755 },
    );
    const task = f.h.addTask(f.h.createBoard('Result').id, input());
    const request = (name: string, bytes: number) =>
      ({
        cwd: f.root,
        artifactDir: join(f.root, name),
        prompt: 'Fixture',
        review: false,
        task,
        signal: new AbortController().signal,
        timeoutMs: 20000,
        execution: {
          env: { PATH: bin + delimiter + process.env.PATH, RESULT_BYTES: String(bytes) },
          redact: redactor([]),
        },
      }) satisfies AgentRequest;
    const accepted = await cliAdapter('codex').execute(request('fits', agentFileBytes));
    assert.equal((accepted.data as { completed: boolean }).completed, true);
    assert.equal(statSync(join(f.root, 'fits/result.json')).size, agentFileBytes);
    await assert.rejects(
      cliAdapter('codex').execute(request('over', agentFileBytes + 1)),
      /при пределе 4194304/,
    );
  } finally {
    f.cleanup();
  }
});

test('CLI: --file сверх предела — понятный отказ без падения и без записи', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'config.json'), JSON.stringify(f.h.config));
    const file = join(f.root, 'plan.json');
    writeFileSync(file, '');
    truncateSync(file, agentFileBytes + 1);
    const run = spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        resolve('src/cli.ts'),
        'import-plan',
        '--data',
        f.root,
        '--file',
        file,
      ],
      { cwd: f.root, encoding: 'utf8' },
    );
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /при пределе 4194304/);
    assert.doesNotMatch(run.stderr, /Unexpected|SyntaxError/);
    assert.equal(f.store.read().tasks.length, 0);
  } finally {
    f.cleanup();
  }
});
