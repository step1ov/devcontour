import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { command } from '../src/runner/process.ts';
import { redactor, outputRedactor, composeRedactors } from '../src/runner/redaction.ts';
import { cliAdapter, type AgentRequest } from '../src/runner/adapters.ts';
import { measuredExecute } from '../src/runner/usage.ts';
import { fixture, input } from './helpers.ts';
import type { UsageRecord } from '../src/core/usage.ts';

test('Streaming redaction protects every chunk split, including overlapping and encoded secrets', () => {
  const secret = 'private/token',
    text = 'prefix private/token private%2Ftoken suffix';
  for (let at = 0; at <= text.length; at++) {
    const mask = outputRedactor(composeRedactors(redactor([secret]), redactor(['suffix'])));
    const a = mask(text.slice(0, at));
    const b = mask(text.slice(at));
    const result = a + b + mask('', true);
    assert.equal(result, 'prefix [REDACTED] [REDACTED] [REDACTED]');
  }
  const custom = outputRedactor((s) => s.replaceAll('secret', '[REDACTED]'));
  assert.equal(custom('sec'), '');
  assert.equal(custom('ret'), '');
  assert.equal(custom('', true), '[REDACTED]');
  const overlap = outputRedactor(redactor(['abcd', 'cdef']));
  assert.equal(overlap('abcdefgh') + overlap('', true), '[REDACTED]efgh');
});

test('A hanging subprocess emits output before timeout and retains activity, tails and termination', async () => {
  let live = '',
    finished = false;
  const result = await command(
    [
      process.execPath,
      '-e',
      `
    process.stderr.write('stage: loading\\n');
    process.stdout.write('тест: started\\n');
    setInterval(()=>{},1000);
  `,
    ],
    process.cwd(),
    {
      timeoutMs: 5000,
      onOutput: (_stream, text) => {
        assert.equal(finished, false);
        live += text;
      },
    },
  );
  finished = true;
  assert.match(live, /stage: loading/);
  assert.match(result.diagnostics.stderrTail, /stage: loading/);
  assert.match(result.diagnostics.stdoutTail, /тест: started/);
  assert.ok(result.diagnostics.lastOutputAt);
  assert.equal(result.diagnostics.timedOut, true);
  assert.notEqual(result.code, 0);
  assert.ok(result.diagnostics.signal);
  assert.ok(result.diagnostics.processTree);
});

test('A timed out CLI retains streamed logs and diagnostics in owner-local attempt telemetry', async () => {
  const f = fixture();
  try {
    const bin = join(f.root, 'bin');
    await mkdir(bin);
    await writeFile(
      join(bin, 'codex'),
      `#!${process.execPath}
if(process.argv.includes('--version')) console.log('codex fixture-stream');
else { process.stderr.write('loading private-token and waiting for provider\\n'); setInterval(()=>{},1000); }
`,
      { mode: 0o755 },
    );
    const artifactDir = join(f.root, 'artifacts');
    const request = {
      cwd: f.root,
      artifactDir,
      prompt: 'Fixture',
      review: false,
      task: f.h.addTask(f.h.createBoard('Diagnostic fixture').id, input()),
      signal: new AbortController().signal,
      timeoutMs: 5000,
      execution: {
        env: { PATH: bin + delimiter + process.env.PATH },
        redact: redactor(['private-token']),
      },
    } satisfies AgentRequest;
    await assert.rejects(
      measuredExecute(f.h, cliAdapter('codex'), request, {
        repositoryId: 'main',
        runId: 'fixture-run',
        stage: 'implementation',
      }),
      // Отказ называет сам лимит: «код -1» не давал отличить исчерпанное время
      // от остановки сервера, и оператор шёл смотреть логи, чтобы это понять.
      /исчерпан лимит времени прогона: 5 с/,
    );
    const log = await readFile(join(artifactDir, 'runtime.log'), 'utf8');
    assert.match(log, /loading \[REDACTED\]/);
    assert.ok(!log.includes('private-token'));
    const record = Object.values(f.store.localRecords<UsageRecord>('usage', 'main'))[0];
    assert.equal(record.outcome, 'error');
    assert.equal(record.runId, 'fixture-run');
    assert.equal(record.diagnostics?.timedOut, true);
    assert.match(record.diagnostics.stderrTail, /waiting for provider/);
    assert.ok(record.diagnostics?.lastOutputAt);
    assert.ok(!JSON.stringify(record).includes('private-token'));
    assert.ok(await readFile(join(artifactDir, 'runtime.json'), 'utf8'));
  } finally {
    f.cleanup();
  }
});

test('Claude streaming envelope validates the final result and captures usage independently', async () => {
  const f = fixture();
  const root = f.root;
  try {
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(
      join(bin, 'claude'),
      `#!${process.execPath}
if(process.argv.includes('--version')) console.log('claude fixture-stream');
else {
 console.log(JSON.stringify({type:'system',subtype:'init'}));
 console.log(JSON.stringify({type:'result',is_error:false,usage:{input_tokens:12,cache_read_input_tokens:3,cache_creation_input_tokens:0,output_tokens:4},total_cost_usd:0.01,structured_output:{completed:true,summary:'fixture',discoveries:[]}}));
}
`,
      { mode: 0o755 },
    );
    let tokens: number | null = null;
    const result = await cliAdapter('claude').execute({
      cwd: root,
      artifactDir: join(root, 'artifacts'),
      prompt: 'Fixture',
      review: false,
      task: f.h.addTask(f.h.createBoard('Diagnostic fixture').id, input()),
      timeoutMs: 5000,
      signal: new AbortController().signal,
      execution: { env: { PATH: bin + delimiter + process.env.PATH }, redact: redactor([]) },
      onUsage: (usage) => {
        tokens = usage.inputTokens;
      },
    } satisfies AgentRequest);
    assert.equal(tokens, 15);
    assert.ok(result.command.includes('stream-json'));
    assert.ok(result.command.includes('--verbose'));
  } finally {
    f.cleanup();
  }
});
