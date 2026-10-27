import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINE_LIMIT, parseUsage, usageStream } from '../src/runner/usage.ts';
import { command } from '../src/runner/process.ts';
import { measuredAgentCall as measuredExecute } from '../src/harness/measured.ts';
import { priceUsage, usageTotals, type Usage, type UsageRecord } from '../src/core/usage.ts';
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

test('Provider-reported cost of a long call survives the bounded runtime.log and stdout tail', async () => {
  const f = fixture();
  try {
    const bin = join(f.root, 'bin');
    await mkdir(bin);
    // More stream than the runtime.log cap and the stdout tail; the final result line comes last.
    await writeFile(
      join(bin, 'claude'),
      `#!${process.execPath}
if (process.argv.includes('--version')) console.log('claude fixture-only');
else {
  process.stdin.resume();
  process.stdin.on('end', async () => {
    const write = (event) => new Promise((done) => process.stdout.write(JSON.stringify(event) + '\\n', done));
    await write({ type: 'system', subtype: 'init', model: 'fixture-model' });
    const text = 'x'.repeat(100_000);
    for (let sent = 0; sent < 12_000_000; sent += text.length)
      await write({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    await write({
      type: 'result',
      structured_output: { completed: true, summary: 'done' },
      total_cost_usd: 17.25,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
    });
  });
}
`,
      { mode: 0o755 },
    );
    const artifactDir = join(f.root, 'artifacts');
    await measuredExecute(
      f.h,
      cliAdapter('claude'),
      {
        cwd: f.root,
        artifactDir,
        prompt: 'Fixture request',
        review: false,
        task: {} as Task,
        signal: new AbortController().signal,
        timeoutMs: 60_000,
        execution: {
          env: { PATH: bin + delimiter + (process.env.PATH ?? '') },
          redact: (text) => text,
        },
      },
      { repositoryId: 'main', stage: 'implementation' },
    );
    const record = Object.values(f.store.localRecords<UsageRecord>('usage', 'main'))[0];
    assert.equal(record.usage.reportedUsd, 17.25);
    assert.equal(record.usage.inputTokens, 80);
    assert.equal(record.usage.complete, true);
    assert.equal(record.model, 'fixture-model');
    assert.equal(usageTotals([record]).costUsd, 17.25);
    const diagnostics = JSON.parse(await readFile(join(artifactDir, 'runtime.json'), 'utf8')) as {
      usage: { reportedUsd: number };
    };
    assert.equal(diagnostics.usage.reportedUsd, 17.25);
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
          // Тариф применяется к модели, которую сообщил runtime.
          r.onUsage!(usage, 'fixture', 'fixture-model');
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

test('Streaming telemetry joins split lines, keeps the last result and the first model, and flags malformed or oversized lines', () => {
  const result = (usd: number) =>
    JSON.stringify({
      type: 'result',
      total_cost_usd: usd,
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 4,
      },
    });
  const split = usageStream('claude');
  const text = [
    JSON.stringify({ type: 'system', model: 'first' }),
    result(1),
    JSON.stringify({ type: 'system', model: 'second' }),
    result(2),
  ].join('\n');
  // No trailing newline: the final line is parsed on flush.
  for (let i = 0; i < text.length; i += 7) split.push(text.slice(i, i + 7));
  const u = split.usage(true);
  assert.deepEqual(
    [u.reportedUsd, u.inputTokens, u.complete, split.model()],
    [2, 8, true, 'first'],
  );
  const broken = usageStream('claude');
  broken.push('{"type":"assistant"\n' + result(1) + '\n');
  assert.deepEqual([broken.usage(true).reportedUsd, broken.usage(true).complete], [1, false]);
  const long = usageStream('claude');
  long.push('{"type":"assistant","text":"' + 'x'.repeat(LINE_LIMIT));
  long.push('"}\n' + result(3) + '\n');
  assert.deepEqual([long.usage(true).reportedUsd, long.usage(true).complete], [3, false]);
  assert.ok(LINE_LIMIT <= 8_000_000);
  const turn = JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 5, cached_input_tokens: 1, output_tokens: 2 },
  });
  const codex = usageStream('codex');
  codex.push(turn + '\n' + turn + '\n');
  assert.deepEqual([codex.usage(true).inputTokens, codex.usage(true).outputTokens], [10, 4]);
  assert.equal(usageStream('claude').usage(true).reportedUsd, null);
});

test('Streaming telemetry survives a deeply nested usage without throwing from the output handler', () => {
  const depth = 200_000;
  const deep = '{"a":'.repeat(depth) + '1' + '}'.repeat(depth);
  const claude = usageStream('claude');
  assert.doesNotThrow(() =>
    claude.push('{"type":"result","total_cost_usd":1.5,"usage":' + deep + '}\n'),
  );
  assert.equal(claude.usage(true).reportedUsd, 1.5);
  const codex = usageStream('codex');
  assert.doesNotThrow(() => codex.push('{"type":"turn.completed","usage":' + deep + '}\n'));
});

test('Raw stdout reaches the telemetry hook up to EOF, including the decoder remainder', async () => {
  let raw = '';
  const r = await command(
    [process.execPath, '-e', 'process.stdout.write(Buffer.from([0x61, 0xe2]))'],
    process.cwd(),
    { onRawStdout: (text) => (raw += text) },
  );
  assert.equal(r.code, 0);
  assert.equal(raw, 'a\ufffd');
});

test('An aborted call that still exits 0 keeps its reported cost but counts as incomplete', async () => {
  const f = fixture();
  try {
    const bin = join(f.root, 'bin');
    await mkdir(bin);
    await writeFile(
      join(bin, 'claude'),
      `#!${process.execPath}
if (process.argv.includes('--version')) console.log('claude fixture-only');
else {
  process.stdin.resume();
  process.stdin.on('end', () => {
    process.stdout.write(JSON.stringify({ type: 'system', model: 'm' }) + '\\n');
    setInterval(() => {}, 1000);
  });
  process.on('SIGTERM', () => {
    process.stdout.write(JSON.stringify({ type: 'result', structured_output: { completed: true, summary: 's' }, total_cost_usd: 0.4, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) + '\\n', () => process.exit(0));
  });
}
`,
      { mode: 0o755 },
    );
    const artifactDir = join(f.root, 'artifacts');
    const controller = new AbortController();
    let usage: Usage | undefined;
    const pending = cliAdapter('claude').execute({
      cwd: f.root,
      artifactDir,
      prompt: 'Fixture request',
      review: false,
      task: {} as Task,
      signal: controller.signal,
      timeoutMs: 60_000,
      execution: {
        env: { PATH: bin + delimiter + (process.env.PATH ?? '') },
        redact: (text) => text,
      },
      onUsage: (reported) => (usage = reported),
    });
    for (let i = 0; i < 200; i++) {
      await new Promise((done) => setTimeout(done, 50));
      const log = await readFile(join(artifactDir, 'runtime.log'), 'utf8').catch(() => '');
      if (log.includes('"system"')) break;
    }
    controller.abort();
    await assert.rejects(pending, /прерван/);
    assert.equal(usage?.reportedUsd, 0.4);
    assert.equal(usage?.complete, false);
  } finally {
    f.cleanup();
  }
});
