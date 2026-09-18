import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsage, measuredExecute } from '../src/runner/usage.ts';
import { priceUsage, usageTotals, type UsageRecord } from '../src/core/usage.ts';
import { workflowMetrics } from '../src/application/metrics.ts';
import { Observability } from '../src/application/observability.ts';
import { fixture, input, complete } from './helpers.ts';
import type { AgentRequest } from '../src/runner/adapters.ts';
import { cliAdapter } from '../src/runner/adapters.ts';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { configSchema, type Task } from '../src/core/model.ts';

test('Documented Codex JSONL telemetry survives unrelated events and exposes incomplete streams', async () => {
  const output = await readFile(new URL('./fixtures/codex-events.jsonl', import.meta.url), 'utf8');
  const usage = parseUsage('codex', output, true);
  assert.equal(usage.inputTokens, 24763);
  assert.equal(usage.cacheReadTokens, 24448);
  assert.equal(usage.outputTokens, 122);
  assert.equal(usage.reportedUsd, null);
  assert.equal(parseUsage('codex', output + '{truncated', true).complete, false);
  assert.equal(parseUsage('codex', output + '{truncated', true).inputTokens, 24763);
});

test('Runtime telemetry normalizes cache tokens; malformed/missing/partial data is never zero', () => {
  const claude = parseUsage(
    'claude',
    JSON.stringify({
      type: 'result',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
      },
      total_cost_usd: 0.12,
    }),
    true,
  );
  assert.equal(claude.inputTokens, 80);
  assert.equal(claude.reportedUsd, 0.12);
  const line = JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 100, cached_input_tokens: 70, output_tokens: 25 },
  });
  const codex = parseUsage('codex', line + '\n' + line, true);
  assert.equal(codex.inputTokens, 200);
  assert.equal(codex.outputTokens, 50);
  assert.equal(codex.cacheReadTokens, 140);
  const price = {
    runtime: 'codex' as const,
    model: 'fixture',
    effectiveAt: '2026-01-01T00:00:00Z',
    input: 10,
    output: 20,
    cacheRead: 1,
    cacheWrite: 5,
  };
  assert.equal(priceUsage(codex, price).costUsd, 0.00174);
  assert.equal(priceUsage(claude, price).costSource, 'provider-reported');
  assert.equal(parseUsage('codex', 'invalid', true).inputTokens, null);
  assert.equal(
    parseUsage('claude', '{"structured_output":{"total_cost_usd":0}}', true).reportedUsd,
    null,
  );
  assert.equal(parseUsage('codex', line, false).complete, false);
  assert.equal(priceUsage({ ...codex, cacheReadTokens: null }, price).costUsd, null);
  assert.equal(
    parseUsage(
      'codex',
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: -1 } }),
      true,
    ).inputTokens,
    null,
  );
});

test('Costs retain failed calls, count retry overhead, preserve unknown totals and page diagnostics', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Usage board', '', 'main');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    f.h.pause(false);
    const first = f.h.claim('usage')!;
    const request = {
      prompt: 'private task text',
      model: 'fixture',
      signal: new AbortController().signal,
    } as AgentRequest;
    const usage = parseUsage(
      'claude',
      JSON.stringify({
        type: 'result',
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.25,
      }),
      true,
    );
    await assert.rejects(
      measuredExecute(
        f.h,
        {
          name: 'claude',
          version: 'fixture',
          execute: async (r) => {
            r.onUsage!(usage);
            throw new Error('provider secret');
          },
        },
        request,
        { repositoryId: 'main', runId: first.id, stage: 'implementation' },
      ),
    );
    f.h.fail(first.id, first.token, 'failed');
    f.h.retry(t.id);
    const second = complete(f.h, t.id);
    await measuredExecute(
      f.h,
      {
        name: 'claude',
        version: 'fixture',
        execute: async (r) => {
          r.onUsage!({ ...usage, reportedUsd: 0.75 });
          return { data: {}, log: 'secret', command: [] };
        },
      },
      request,
      { repositoryId: 'main', runId: second.id, stage: 'implementation' },
    );
    const metrics = workflowMetrics(f.h, 'main');
    assert.equal(metrics.costUsd, 1);
    assert.equal(metrics.usage.costPerAcceptedTaskUsd, 1);
    assert.equal(metrics.counts.failed, 1);
    const records = Object.values(f.store.localRecords<UsageRecord>('usage', 'main'));
    assert.equal(records.find((r) => r.runId === first.id)!.outcome, 'error');
    assert.ok(!JSON.stringify(records).includes('secret'));
    assert.ok(!JSON.stringify(records).includes('private task text'));
    assert.equal(Object.keys(f.store.localRecords('usage')).length, 0);
    const reports = new Observability(f.h),
      page = reports.usage({ repositoryId: 'main', limit: 1 });
    assert.ok(page.nextCursor);
    assert.equal(
      reports.usage({ repositoryId: 'main', cursor: page.nextCursor }).records.length,
      1,
    );
    await measuredExecute(
      f.h,
      { name: 'demo', execute: async () => ({ data: {}, log: '', command: [] }) },
      request,
      { repositoryId: 'main', stage: 'plan-review' },
    );
    assert.throws(
      () => reports.usage({ repositoryId: 'main', cursor: page.nextCursor }),
      /изменился/,
    );
    assert.equal(workflowMetrics(f.h, 'main').costUsd, null);
    assert.equal(workflowMetrics(f.h, 'main').usage.knownCostUsd, 1);
    assert.equal(usageTotals([]).costUsd, null);
  } finally {
    f.cleanup();
  }
});

test('CLI telemetry is captured on actual process failure and uses the invoked binary version', async () => {
  const f = fixture();
  try {
    const bin = join(f.root, 'bin');
    await mkdir(bin);
    await writeFile(
      join(bin, 'codex'),
      `#!${process.execPath}
if(process.argv.includes('--version')) { console.log('codex fixture-only'); }
else { console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:50,output_tokens:10}})); process.exitCode=1; }
`,
      { mode: 0o755 },
    );
    const request: AgentRequest = {
      cwd: f.root,
      artifactDir: join(f.root, 'artifacts'),
      prompt: 'Fixture request',
      review: false,
      task: {} as Task,
      model: 'fixture-model',
      signal: new AbortController().signal,
      timeoutMs: 5000,
      execution: {
        env: { PATH: bin + delimiter + (process.env.PATH ?? '') },
        redact: (text) => text,
      },
    };
    await assert.rejects(
      measuredExecute(f.h, cliAdapter('codex'), request, {
        repositoryId: 'main',
        stage: 'implementation',
      }),
      /кодом 1/,
    );
    const record = Object.values(f.store.localRecords<UsageRecord>('usage', 'main'))[0];
    assert.equal(record.runtimeVersion, 'codex fixture-only');
    assert.equal(record.usage.inputTokens, 100);
    assert.equal(record.usage.complete, false);
    assert.equal(record.outcome, 'error');
    assert.equal(usageTotals([record]).costUsd, null);
  } finally {
    f.cleanup();
  }
});

test('Effective tariffs are snapshotted and cannot retroactively change call estimates', async () => {
  const f = fixture();
  try {
    const price = {
      runtime: 'codex' as const,
      model: 'fixture-model',
      effectiveAt: '2026-01-01T00:00:00Z',
      input: 1,
      output: 4,
      cacheRead: 0.1,
      cacheWrite: 1,
    };
    f.h.config.prices.push(price);
    const request = { prompt: 'Fixture', model: 'fixture-model' } as AgentRequest;
    const usage = parseUsage(
      'codex',
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 1000000, cached_input_tokens: 0, output_tokens: 0 },
      }),
      true,
    );
    await measuredExecute(
      f.h,
      {
        name: 'codex',
        version: 'fixture',
        execute: async (r) => {
          price.input = 50;
          r.onUsage!(usage);
          return { data: {}, log: '', command: [] };
        },
      },
      request,
      { repositoryId: 'main', stage: 'implementation' },
    );
    const record = Object.values(f.store.localRecords<UsageRecord>('usage', 'main'))[0];
    assert.equal(record.costUsd, 1);
    assert.equal(record.price!.input, 1);
    assert.equal(record.costSource, 'tariff-estimate');
    assert.throws(
      () =>
        configSchema.parse({
          ...f.h.config,
          prices: [price, { ...price, effectiveAt: '2026-01-01T00:00:00.000Z' }],
        }),
      /Duplicate/,
    );
  } finally {
    f.cleanup();
  }
});
