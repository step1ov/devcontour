// Характеристика host-каталога агентских операций и пагинации контекста.
// Каталог DevContour остаётся своим (protocolVersion=1, свои имена и лимиты),
// даже если общий builder/схемы придут из harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentService,
  agentInputs,
  agentOperations,
  capabilities,
  readOnly,
} from '../src/application/agent.ts';
import { AgentContext } from '../src/application/context.ts';
import { DomainError } from '../src/core/model.ts';
import { fixture, input } from './helpers.ts';

const operations = [
  'preparation_status',
  'preparation_create',
  'preparation_activate',
  'preparation_product',
  'preparation_architecture',
  'preparation_references',
  'preparation_concept',
  'preparation_design',
  'preparation_submit',
  'preparation_progress',
  'preparation_question',
  'preparation_resolve',
  'intent_render',
  'intent_snapshot',
  'intent_report',
  'product_view',
  'memory_retain',
  'memory_recall',
  'usage_report',
  'decision_report',
  'strategy_replay',
  'signal_ingest',
  'signal_status',
  'workflow_start',
  'workflow_status',
  'workflow_retry',
  'workflow_metrics',
  'requirements_snapshot',
  'requirements_report',
  'requirements_correct',
  'project_context',
  'project_overview',
  'task_briefing',
  'checkpoint_save',
  'checkpoint_changes',
  'plan_import',
  'board_create',
  'task_create',
  'task_edit',
  'task_retry',
  'task_assign',
  'board_correct',
  'changeset_create',
  'queue_set',
  'preview_status',
  'feasibility_spike',
  'feasibility_spikes',
  'checks_view',
  'checks_case_submit',
  'checks_adopt',
  'recovery_decide',
  'contract_change_status',
  'contract_change_revise',
];
const readOnlyOperations = [
  'preparation_status',
  'intent_render',
  'intent_snapshot',
  'intent_report',
  'product_view',
  'memory_recall',
  'usage_report',
  'decision_report',
  'strategy_replay',
  'signal_status',
  'workflow_status',
  'workflow_metrics',
  'requirements_snapshot',
  'requirements_report',
  'project_context',
  'project_overview',
  'task_briefing',
  'checkpoint_changes',
  'preview_status',
  'feasibility_spikes',
  'checks_view',
  'contract_change_status',
];

test('Baseline catalog: host capabilities keep protocolVersion 1, limits, names and readOnly flags', () => {
  const c = capabilities();
  assert.deepEqual(Object.keys(c), [
    'name',
    'version',
    'protocolVersion',
    'maxInputBytes',
    'maxResultBytes',
    'tools',
  ]);
  assert.equal(c.name, 'devcontour');
  assert.equal(c.protocolVersion, 1);
  assert.equal(c.maxInputBytes, 100000);
  assert.equal(c.maxResultBytes, 65536);
  assert.deepEqual([...agentOperations], operations);
  assert.deepEqual(
    c.tools.map((t) => t.name),
    operations,
  );
  assert.deepEqual(
    c.tools.filter((t) => t.readOnly).map((t) => t.name),
    readOnlyOperations,
  );
  for (const tool of c.tools) {
    assert.deepEqual(
      Object.keys(tool),
      ['name', 'description', 'readOnly', 'inputSchema'],
      tool.name,
    );
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 0, tool.name);
    assert.equal(tool.readOnly, readOnly(tool.name));
    assert.equal(typeof tool.inputSchema, 'object');
    assert.ok(tool.name in agentInputs, tool.name);
  }
});

test('Baseline catalog: input over 100000 bytes is 413 on both entries; async operation via execute is 409', async () => {
  const f = fixture();
  try {
    const api = new AgentService(f.h);
    const big = { operation: 'board_create', input: { title: 'x'.repeat(100001) } };
    assert.throws(
      () => api.execute(big),
      (e: unknown) =>
        e instanceof DomainError &&
        e.status === 413 &&
        e.message === 'Запрос превышает 100000 байт',
    );
    await assert.rejects(
      api.run(big),
      (e: unknown) =>
        e instanceof DomainError &&
        e.status === 413 &&
        e.message === 'Запрос превышает 100000 байт',
    );
    assert.throws(
      () => api.execute({ operation: 'feasibility_spike', input: {} }),
      (e: unknown) =>
        e instanceof DomainError &&
        e.status === 409 &&
        e.message === 'Операция запускает процессы: вызовите её через run',
    );
    await assert.rejects(
      api.run({ operation: 'feasibility_spike', input: {} }),
      (e: unknown) =>
        e instanceof DomainError &&
        e.status === 409 &&
        e.message === 'Операция запускает процессы и требует каталога данных контура',
    );
    const context = api.execute({ operation: 'project_context' }) as {
      protocolVersion: number;
      operations: string[];
    };
    assert.equal(context.protocolVersion, 1);
    assert.deepEqual(context.operations, operations);
  } finally {
    f.cleanup();
  }
});

type Page = {
  items: unknown[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
};
type Cursor = { revision: string; binding: string; offset: number };

test('Baseline context paging: cursor errors keep their status; pages report total and hasMore', () => {
  const f = fixture();
  try {
    const api = new AgentContext(f.h);
    const board = f.h.createBoard('Paging board');
    for (let i = 0; i < 3; i++) f.h.addTask(board.id, input('Task ' + i));
    const first = api.execute('project_overview', { repositoryId: 'main', limit: 1 }) as Page;
    assert.equal(first.items.length, 1);
    assert.equal(first.hasMore, true);
    assert.equal(typeof first.nextCursor, 'string');
    assert.equal(typeof first.total, 'number');
    const cursor = JSON.parse(
      Buffer.from(first.nextCursor ?? '', 'base64url').toString('utf8'),
    ) as Cursor;
    assert.deepEqual(Object.keys(cursor).sort(), ['binding', 'offset', 'revision']);
    assert.equal(cursor.binding, 'overview/main');
    assert.equal(cursor.offset, 1);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const expectError = (c: string, status: number, message: string) =>
      assert.throws(
        () => api.execute('project_overview', { repositoryId: 'main', cursor: c }),
        (e: unknown) => e instanceof DomainError && e.status === status && e.message === message,
      );
    expectError(encode(null), 400, 'Некорректный cursor');
    expectError(encode({ ...cursor, offset: 10_000 }), 400, 'Некорректный cursor offset');
    expectError(
      encode({ ...cursor, binding: 'overview/other' }),
      409,
      'Контекст изменился или cursor принадлежит другому запросу. Начните с первой страницы.',
    );
    expectError(
      encode({ ...cursor, revision: 'stale' }),
      409,
      'Контекст изменился или cursor принадлежит другому запросу. Начните с первой страницы.',
    );
    // Полный проход собирает все элементы без потерь и повторов.
    const seen: unknown[] = [...first.items];
    let next = first.nextCursor;
    while (next) {
      const page = api.execute('project_overview', {
        repositoryId: 'main',
        limit: 1,
        cursor: next,
      }) as Page;
      seen.push(...page.items);
      next = page.nextCursor;
    }
    assert.equal(seen.length, first.total);
    const all = api.execute('project_overview', { repositoryId: 'main', limit: 50 }) as Page;
    assert.deepEqual(seen, all.items);
    assert.equal(all.hasMore, false);
    assert.equal(all.nextCursor, null);
  } finally {
    f.cleanup();
  }
});

test('Baseline read-only diagnostics: capabilities and context reads change no state or events', () => {
  const f = fixture();
  try {
    const board = f.h.createBoard('Read-only board');
    const a = f.h.addTask(board.id, input('Root task'));
    f.h.addTask(board.id, input('Dependent task', [a.id]));
    f.h.approve(board.id);
    const api = new AgentService(f.h);
    const state = JSON.stringify(f.store.read());
    const events = f.store.events().length;
    for (let i = 0; i < 3; i++) {
      capabilities();
      for (const operation of ['project_context', 'project_overview', 'task_briefing'] as const)
        api.execute({
          operation,
          input:
            operation === 'task_briefing'
              ? { taskId: a.id }
              : operation === 'project_overview'
                ? { repositoryId: 'main' }
                : {},
        });
    }
    assert.equal(JSON.stringify(f.store.read()), state);
    assert.equal(f.store.events().length, events);
  } finally {
    f.cleanup();
  }
});
