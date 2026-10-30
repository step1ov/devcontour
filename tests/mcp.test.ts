import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AgentService, capabilities } from '../src/application/agent.ts';
import { serveMcp } from '../src/server/mcp.ts';
import { fixture, input } from './helpers.ts';
const data = (result: { structuredContent?: unknown }) =>
  result.structuredContent as Record<string, unknown>;

test('Read-only agent queries do not rebuild journals; mutations still update projections', () => {
  const f = fixture();
  try {
    f.h.config.workspaceRoot = f.root;
    const service = new AgentService(f.h);
    service.execute({ operation: 'project_context', input: {} });
    service.execute({ operation: 'project_overview', input: {} });
    assert.equal(existsSync(join(f.root, 'docs/journal')), false);
    assert.equal(f.store.events().length, 0);
    service.execute({ operation: 'board_create', input: { title: 'Journal mutation' } });
    assert.equal(existsSync(join(f.root, 'docs/journal')), true);
    assert.equal(f.store.read().boards.length, 1);
  } finally {
    f.cleanup();
  }
});

async function connect(f: ReturnType<typeof fixture>) {
  writeFileSync(join(f.root, 'config.json'), JSON.stringify(f.h.config));
  const client = new Client({ name: 'devcontour-fixture', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', import.meta.resolve('tsx'), resolve('src/cli.ts'), 'mcp', '--data', f.root],
    cwd: f.root,
    stderr: 'pipe',
  });
  await client.connect(transport);
  return client;
}

test('Real MCP clients negotiate tools, keep independent workspaces and enforce draft/stale-edit rules', async () => {
  const left = fixture(),
    right = fixture();
  let a: Client | undefined, b: Client | undefined;
  try {
    a = await connect(left);
    b = await connect(right);
    const tools = await a.listTools();
    assert.deepEqual(
      tools.tools.map((t) => t.name).sort(),
      capabilities()
        .tools.map((t) => t.name)
        .sort(),
    );
    assert.equal(
      tools.tools.find((t) => t.name === 'project_context')?.annotations?.readOnlyHint,
      true,
    );
    const created = await a.callTool({ name: 'board_create', arguments: { title: 'MCP work' } });
    assert.equal(created.isError, undefined);
    const boardId = data(created).boardId;
    const task = await a.callTool({
      name: 'task_create',
      arguments: { boardId, task: input('MCP task') },
    });
    assert.equal(data(task).status, 'draft');
    assert.equal(right.store.read().tasks.length, 0);
    const taskId = data(task).taskId;
    const changed = await a.callTool({
      name: 'task_edit',
      arguments: {
        taskId,
        expectedDigest: data(task).specDigest,
        task: input('Changed task'),
      },
    });
    assert.equal(changed.isError, undefined);
    const stale = await a.callTool({
      name: 'task_edit',
      arguments: {
        taskId,
        expectedDigest: data(task).specDigest,
        task: input('Stale task'),
      },
    });
    assert.equal(stale.isError, true);
    assert.equal(left.store.read().tasks[0].title, 'Changed task');
    const forged = await a.callTool({
      name: 'project_context',
      arguments: { workspace: right.root },
    });
    assert.equal(forged.isError, true);
    const queue = await a.callTool({ name: 'queue_set', arguments: { paused: false } });
    assert.equal(data(queue).serverRequiredForExecution, true);
    await a.close();
    a = undefined;
    assert.equal(
      left.store.read().paused,
      false,
      'MCP disconnect must not stop an independent runner',
    );
    assert.equal(left.store.read().runs.length, 0, 'MCP never claims work itself');
    assert.equal(left.store.read().tasks[0].status, 'draft', 'Queue cannot approve a draft');
  } finally {
    await a?.close();
    await b?.close();
    left.cleanup();
    right.cleanup();
  }
});

test('Agent surface cannot provide evidence/approval; cyclic plans fail atomically and inputs are bounded', () => {
  const f = fixture();
  try {
    const service = new AgentService(f.h);
    for (const operation of ['mark_done', 'evidence', 'approve', 'contract_approve'])
      assert.throws(() => service.execute({ operation, input: { passed: true } }));
    assert.throws(
      () => service.execute({ operation: 'project_context', input: { extra: 'x'.repeat(100001) } }),
      /100000/,
    );
    assert.throws(
      () =>
        service.execute({
          operation: 'plan_import',
          input: {
            plan: {
              title: 'Broken plan',
              description: 'Invalid DAG',
              tasks: [
                { ...input(), key: 'a', contracts: [], dependsOn: ['b'] },
                { ...input(), key: 'b', contracts: [], dependsOn: ['a'] },
              ],
            },
          },
        }),
      /Цикл/,
    );
    assert.equal(f.store.read().tasks.length, 0);
    assert.equal(f.store.read().boards.length, 0);
    assert.equal(f.store.read().runs.length, 0);
  } finally {
    f.cleanup();
  }
});

test('Closing stdin leaves the store open until the calls already started have finished', async () => {
  const stdin = new PassThrough(),
    stdout = new PassThrough();
  const output: string[] = [];
  stdout.on('data', (chunk) => output.push(String(chunk)));
  let released = 0,
    begin = () => {},
    finish = () => {};
  const started = new Promise<void>((done) => (begin = done));
  const result = new Promise<Record<string, unknown>>((done) => (finish = () => done({})));
  const service = {
    run: async () => {
      begin();
      return result;
    },
  };
  const server = await serveMcp(service, () => (released += 1), stdin, stdout);
  const send = (message: Record<string, unknown>) =>
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  send({
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'stdin-end', version: '1.0.0' },
    },
  });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/call', params: { name: 'project_context', arguments: {} } });
  await started;
  stdin.end();
  await new Promise<void>((done) => {
    const previous = server.server.onclose;
    server.server.onclose = () => {
      previous?.();
      done();
    };
  });
  assert.equal(released, 0);
  finish();
  await result;
  await new Promise((done) => setImmediate(done));
  assert.equal(released, 1);
  assert.ok(!output.join('').includes('"id":2'), 'the answer to a closed client is not written');
});
