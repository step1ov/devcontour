import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ReapFailure,
  TaskFailure,
  classifyFailure,
  hostLoad,
  type RuntimeRequest,
} from 'devcontour-harness';
import type { DevContour } from '../src/core/service.ts';
import { fromAgentAdapter } from '../src/harness/adapters.ts';
import { adapters } from '../src/runner/adapters.ts';
import { command, processInventory } from '../src/runner/process.ts';

// Потомков сдерживаемой команды DevContour (вызовы runtime ревью, плана,
// восстановления) не удалось остановить или пересчитать: тот же отказ, что у
// harness, — `ReapFailure` класса environment/process-reap с названной
// командой, PID и выходом, причиной и нагрузкой хоста, а не «-1».

const marked = processInventory.marked;
const tool = processInventory.tool;
const read = hostLoad.read;
const quick = [process.execPath, '-e', ''];

async function withInventory<T>(fake: typeof marked, fn: () => Promise<T>) {
  processInventory.marked = fake;
  hostLoad.read = () => ({ load1: 587, cpus: 8 });
  try {
    return await fn();
  } finally {
    processInventory.marked = marked;
    hostLoad.read = read;
  }
}
const failed = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e,
  );

test('Перечень процессов не получен — ReapFailure environment/process-reap с командой и нагрузкой', async () => {
  const error = await withInventory(
    () => Promise.reject(new Error('ps не ответил за 10 с')),
    () =>
      failed(
        command(quick, process.cwd(), { contain: true, label: 'claude plan', timeoutMs: 30000 }),
      ),
  );
  assert.ok(error instanceof ReapFailure, String(error));
  assert.ok(error instanceof TaskFailure);
  assert.equal(error.kind, 'environment');
  assert.equal(error.diagnosis, 'process-reap');
  assert.equal(error.inventory, 'ps не ответил за 10 с');
  assert.match(
    error.message,
    /^Не удалось завершить процессы команды «claude plan» \(PID \d+, код выхода 0\): перечень процессов не получен \(ps не ответил за 10 с\)\. Ресурсы не освобождены: потомки команды могут ещё работать; нагрузка хоста 587 на 8 ядер$/,
  );
  assert.equal(classifyFailure(error, error.message), 'environment');
});

test('Разовый отказ перечня повторяется — команда завершается штатно', async () => {
  let calls = 0;
  const result = await withInventory(
    (mark) => (calls++ === 0 ? Promise.reject(new Error('ps не ответил за 10 с')) : marked(mark)),
    () => command(quick, process.cwd(), { contain: true, timeoutMs: 30000 }),
  );
  assert.equal(result.code, 0);
  assert.equal(calls, 2, 'перечень запрошен снова после отказа');
});

test('Потомок, переживший остановку, назван PID; без label команда названа по исполняемому файлу', async () => {
  // PID, которого нет: сигнал ему не доходит, а перечень называет его снова.
  const ghost = 0x3ffffff0;
  const error = await withInventory(
    () => Promise.resolve([ghost]),
    () => failed(command(quick, process.cwd(), { contain: true, timeoutMs: 30000 })),
  );
  assert.ok(error instanceof ReapFailure, String(error));
  assert.deepEqual(error.survivors, [ghost]);
  assert.equal(error.kind, 'environment');
  const exe = process.execPath.split('/').at(-1)!;
  assert.match(
    error.message,
    new RegExp(
      `^Не удалось завершить процессы команды «${exe}» .*живы после остановки PID ${ghost}\\.`,
    ),
  );
});

test('Неполученная таблица процессов (ps -axo) или отказ lsof — не «живых нет», а ReapFailure', async () => {
  const failing = (match: (file: string, args: string[]) => boolean, reason: string) =>
    ((file: string, args: string[], timeout: number, partial?: number) =>
      match(file, args)
        ? Promise.resolve({ error: reason })
        : tool(file, args, timeout, partial)) as typeof tool;
  for (const fake of [
    failing((_f, args) => args.includes('pid=,ppid=,lstart='), 'ps не ответил за 10 с'),
    failing((file) => file.endsWith('lsof'), 'lsof не ответил за 15 с'),
  ]) {
    const dir = mkdtempSync(join(tmpdir(), 'dc-reap-dir-'));
    processInventory.tool = fake;
    try {
      const error = await failed(
        command(quick, process.cwd(), { contain: { dirs: [dir] }, timeoutMs: 30000 }),
      );
      assert.ok(error instanceof ReapFailure, String(error));
      assert.match(error.inventory ?? '', /не ответил/);
    } finally {
      processInventory.tool = tool;
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('Вызов runtime через cliAdapter DevContour: неостановленные потомки — environment/process-reap по правилу harness', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dc-reap-cli-')));
  try {
    // Подставной `claude` первым на PATH: отвечает и на --version, и на вызов.
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'claude'), 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
    const request = {
      callId: 'call-1',
      task: 'review-plan',
      cwd: root,
      artifactDir: join(root, 'art'),
      prompt: 'review',
      binding: { runtime: 'claude' },
      timeoutMs: 30000,
      env,
      secrets: [],
    } as unknown as RuntimeRequest;
    const h = { store: { read: () => ({ tasks: [] }) } } as unknown as DevContour;
    const error = await withInventory(
      () => Promise.reject(new Error('ps не ответил за 10 с')),
      () =>
        failed(
          fromAgentAdapter(h, adapters.claude, 'claude').invoke(
            request,
            new AbortController().signal,
          ),
        ),
    );
    assert.ok(error instanceof ReapFailure, String(error));
    assert.match(error.message, /^Не удалось завершить процессы команды «claude review»/);
    assert.equal(classifyFailure(error, error.message), 'environment');
    assert.equal(error.diagnosis, 'process-reap');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
