import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FINDING_ID_PATTERN, REVIEW_ITEMS_LIMIT } from 'devcontour-harness';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import { reviewPlan } from '../src/runner/agent-control.ts';
import { reviewSchema, type AgentAdapter } from '../src/runner/adapters.ts';
import { fixture, input } from './helpers.ts';

/**
 * Ревью плана доски из задания ведущего — с настоящими адаптерами контура.
 * Вместо CLI модели — исполняемый файл-фикстура `claude`/`codex` первым в
 * PATH: он читает схему ответа из аргументов и, как CLI со structured output,
 * отвечает только полями, которые схема разрешает. Модель не вызывается.
 */
const cli = `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const { basename, dirname, join } = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log(basename(process.argv[1]) + ' fixture-only');
  process.exit(0);
}
const bin = dirname(process.argv[1]);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (prompt += chunk));
process.stdin.on('end', () => {
  const codex = basename(process.argv[1]) === 'codex';
  const after = (flag) => args[args.indexOf(flag) + 1];
  const schema = codex
    ? JSON.parse(readFileSync(after('--output-schema'), 'utf8'))
    : JSON.parse(after('--json-schema'));
  appendFileSync(join(bin, 'calls.jsonl'), JSON.stringify({ runtime: basename(process.argv[1]), schema, prompt }) + '\\n');
  if (existsSync(join(bin, 'hang'))) {
    writeFileSync(join(bin, 'started'), String(process.pid));
    setInterval(() => {}, 1000);
    return;
  }
  const line = prompt.split('\\n\\n').find((p) => p.startsWith('Previous open findings.')) ?? '';
  const ids = [...line.matchAll(/"id":"([a-f0-9]{64})"/g)].map((m) => m[1]);
  const output = {
    execution: { commands: [], noCommandsReason: 'Plan review reads the proposal only' },
    approved: true,
    summary: 'Fixture review; no provider called',
    discoveries: [],
    findings: [],
    ...(schema.properties && schema.properties.previous
      ? { previous: ids.map((id) => ({ id, status: 'closed', basis: 'исправлено в этой редакции' })) }
      : {}),
  };
  if (codex) writeFileSync(after('--output-last-message'), JSON.stringify(output));
  else
    console.log(JSON.stringify({ type: 'result', is_error: false, structured_output: output }));
});
`;

/** Отклоняющий ревьюер первого раунда: открывает находку для следующего. */
const rejecting = (): Record<'codex' | 'claude', AgentAdapter> => {
  const make = (name: 'codex' | 'claude'): AgentAdapter => ({
    name,
    execute: () =>
      Promise.resolve({
        data: {
          approved: false,
          summary: 'Fixture rejection',
          discoveries: [],
          findings: [{ severity: 'blocking', message: 'В плане нет критерия приёмки ошибки' }],
          previous: [],
        },
        log: 'Fixture only; no provider called',
        command: ['fixture'],
      }),
  });
  return { codex: make('codex'), claude: make('claude') };
};

async function setup() {
  const f = fixture();
  const bin = join(f.root, 'bin');
  await mkdir(bin);
  for (const name of ['claude', 'codex']) await writeFile(join(bin, name), cli, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = bin + delimiter + (path ?? '');
  // Каталог состояния задания — в репозитории владельца: не общий /tmp.
  f.h.config.repository = f.root;
  f.h.config.mode = 'local';
  f.h.config.approvalMode = 'agent';
  const board = f.h.createBoard('Workflow plan', '', 'main');
  f.h.addTask(board.id, input());
  // Первый раунд отклонён с находкой: следующий обязан назвать её состояние.
  await assert.rejects(
    reviewPlan(f.h, f.root, board.id, 'codex', rejecting()),
    /Независимое ревью отклонено/,
  );
  // Ревью плана из задания ведущего — с настоящими адаптерами по умолчанию.
  const runner = new LeadRunner(f.h, f.root);
  const job = runner.workflow.start({ kind: 'board', id: board.id, authorRuntime: 'codex' });
  const claimed = runner.workflow.claim(job.key, 'main')!;
  const calls = async () =>
    (await readFile(join(bin, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(
        (l) =>
          JSON.parse(l) as {
            runtime: string;
            schema: {
              required: string[];
              properties: {
                findings: { maxItems?: number };
                previous: { items: { properties: { id: { pattern: string } } } };
              };
            };
            prompt: string;
          },
      );
  return {
    ...f,
    bin,
    board,
    runner,
    claimed,
    calls,
    cleanup: () => {
      process.env.PATH = path;
      f.cleanup();
    },
  };
}

const approvals = (f: Awaited<ReturnType<typeof setup>>) =>
  f.store
    .allEvents()
    .filter(
      (e) => e.type === 'board.approved' && (e.data as { boardId?: string }).boardId === f.board.id,
    ).length;

test('Ревью плана из задания ведущего с прежней открытой находкой: ревьюер называет её состояние, и одобрение утверждает доску', async () => {
  const f = await setup();
  try {
    await f.runner.execute(f.claimed, new AbortController().signal);
    const [call] = await f.calls();
    assert.match(call.prompt, /Previous open findings\./, 'прежняя находка передана ревьюеру');
    assert.equal(approvals(f), 1, 'одобренный раунд утвердил доску');
    assert.ok(f.store.read().tasks.every((t) => t.status !== 'draft'));
  } finally {
    f.cleanup();
  }
});

test('Ревью плана из задания ведущего идёт живым адаптером harness: схема ответа — схема harness с обязательным previous', async () => {
  const f = await setup();
  try {
    await f.runner.execute(f.claimed, new AbortController().signal);
    const [call] = await f.calls();
    assert.ok(call.schema.required.includes('previous'));
    assert.equal(call.schema.properties.previous.items.properties.id.pattern, FINDING_ID_PATTERN);
    // Запасной путь контура пишет свою схему (`reviewSchema`); у harness
    // список находок ограничен пределом раунда.
    assert.notDeepEqual(call.schema, reviewSchema, 'не запасной путь контура');
    assert.equal(call.schema.properties.findings.maxItems, REVIEW_ITEMS_LIMIT);
  } finally {
    f.cleanup();
  }
});

test('Отмена задания ведущего прерывает идущее ревью плана', async () => {
  const f = await setup();
  let running: Promise<boolean> | undefined;
  try {
    await writeFile(join(f.bin, 'hang'), '');
    const controller = new AbortController();
    running = f.runner.execute(f.claimed, controller.signal);
    for (let i = 0; i < 600 && !existsSync(join(f.bin, 'started')); i++) await delay(50);
    assert.ok(existsSync(join(f.bin, 'started')), 'ревьюер запущен');
    controller.abort();
    // Срок вызова — минуты (runTimeoutMs): исход раньше — только отмена.
    assert.ok(f.h.config.runTimeoutMs >= 60_000);
    const outcome = await Promise.race([
      running.then(
        () => 'finished',
        () => 'rejected',
      ),
      delay(30_000, undefined, { ref: false }).then(() => 'still running'),
    ]);
    assert.equal(outcome, 'rejected', 'отмена остановила вызов ревьюера');
    assert.equal(approvals(f), 0);
  } finally {
    // Без отмены ревьюер-фикстура ждал бы срока вызова: остановить его.
    const pid = existsSync(join(f.bin, 'started'))
      ? Number(await readFile(join(f.bin, 'started'), 'utf8'))
      : 0;
    if (pid > 0)
      try {
        process.kill(pid);
      } catch {
        /* Уже остановлен отменой. */
      }
    await running?.catch(() => undefined);
    f.cleanup();
  }
});

test('F54: отказ ревью плана с длинной сводкой сохраняет в ошибке задания ссылку на полные находки', async () => {
  const f = fixture();
  try {
    f.h.config.repository = f.root;
    f.h.config.mode = 'local';
    f.h.config.approvalMode = 'agent';
    const board = f.h.createBoard('Long rejection', '', 'main');
    f.h.addTask(board.id, input());
    const summary = Array.from({ length: 300 }, (_, i) => `Причина ${i} описана подробно.`).join(
      ' ',
    );
    const findings = Array.from({ length: 5 }, (_, i) => ({
      severity: 'blocking',
      message: `Находка ${i}: ` + 'подробность '.repeat(60),
    }));
    const verbose = (name: 'codex' | 'claude'): AgentAdapter => ({
      name,
      execute: () =>
        Promise.resolve({
          data: { approved: false, summary, discoveries: [], findings, previous: [] },
          log: 'Fixture only; no provider called',
          command: ['fixture'],
        }),
    });
    const error = await reviewPlan(f.h, f.root, board.id, 'codex', {
      codex: verbose('codex'),
      claude: verbose('claude'),
    }).then(
      () => assert.fail('ревью должно отклонить'),
      (e: unknown) => e as Error,
    );
    const attempt = f.store.read().contractAttempts!.at(-1)!;
    assert.ok(summary.length > 1000);
    assert.ok(error.message.length <= 1000, String(error.message.length));
    assert.ok(error.message.startsWith('Независимое ревью отклонено: Причина 0'));
    assert.ok(
      error.message.endsWith(
        `Находок: 5; полный текст ревью — review.json в каталоге решения. Артефакты: ${attempt.artifact}`,
      ),
      error.message.slice(-300),
    );
    // Полный текст — по ссылке: сводка и все находки целиком.
    assert.equal(attempt.summary, summary);
    const saved = JSON.parse(await readFile(join(attempt.artifact, 'review.json'), 'utf8')) as {
      response: { summary: string; findings: unknown[] };
    };
    assert.equal(saved.response.summary, summary);
    assert.equal(saved.response.findings.length, 5);
    assert.equal(attempt.findings.length, 5);
    // Через очередь заданий ссылка доходит до ведущего без обрезки.
    const runner = new LeadRunner(f.h, f.root);
    const job = runner.workflow.start({ kind: 'board', id: board.id, authorRuntime: 'codex' });
    runner.workflow.fail(runner.workflow.claim(job.key, 'main')!, error.message);
    const failed = runner.workflow.list('main').find((j) => j.key === job.key)!;
    assert.equal(failed.status, 'failed');
    assert.ok(failed.error!.endsWith(`Артефакты: ${attempt.artifact}`));
  } finally {
    f.cleanup();
  }
});
