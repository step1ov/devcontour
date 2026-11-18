// Занятая база под нагрузкой writer: чтения ждут и повторяются, а отказ —
// временный «повторите», без совета остановить работающий serve.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from './helpers.ts';
import { cliCommand } from './cli-command.ts';
import { DevContour } from '../src/core/service.ts';
import { DATABASE_BUSY_ADVICE, Store, busyAsDomain } from '../src/core/store.ts';
import { DomainError } from '../src/core/model.ts';
import { readOnlyRead } from '../src/runner/value-report.ts';
import { command } from '../src/runner/process.ts';

async function dataDir(journalMode?: 'DELETE') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dc-busy-')));
  const data = join(root, 'data');
  await mkdir(data);
  const c = config();
  await writeFile(join(data, 'config.json'), JSON.stringify(c));
  const h = new DevContour(new Store(join(data, 'state.sqlite'), undefined, false, journalMode), c);
  try {
    h.createBoard('Busy board', '', 'main');
  } finally {
    h.store.close();
  }
  return { root, data, c };
}

/**
 * Другой процесс держит блокировку базы `ms` миллисекунд (`EXCLUSIVE` —
 * никаких чтений в режиме DELETE, `IMMEDIATE` — только запись).
 */
async function holdLock(file: string, mode: 'EXCLUSIVE' | 'IMMEDIATE', ms: number) {
  const child = spawn(
    process.execPath,
    [
      '--no-warnings',
      '-e',
      `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN ${mode}');db.exec('UPDATE revision SET n=n WHERE id=1');process.stdout.write('locked\\n');setTimeout(()=>{db.exec('COMMIT');db.close();process.stdout.write('released '+Date.now()+'\\n');},${ms});`,
      file,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let out = '';
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (out.includes('locked\n')) resolve();
    });
    child.once('exit', (code) => reject(new Error('lock holder exited early: ' + code)));
  });
  const released = new Promise<number>((resolve) =>
    child.once('exit', () => resolve(Number(/released (\d+)/.exec(out)?.[1] ?? NaN))),
  );
  return { released };
}

test('чтение только для чтения ждёт writer, держащий базу (DELETE), а не отказывает сразу', async () => {
  const { root, data, c } = await dataDir('DELETE');
  try {
    const lock = await holdLock(join(data, 'state.sqlite'), 'EXCLUSIVE', 700);
    // Прежде таймаут ожидания ставился после первого запроса схемы: открытие
    // падало «database is locked» сразу, пока writer держал базу.
    const boards = readOnlyRead(c, data, (h) => h.store.read().boards.length);
    const doneAt = Date.now();
    assert.equal(boards, 1);
    assert.ok(doneAt >= (await lock.released), 'чтение дождалось writer');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('занятая база: чтение повторяется, затем отказ 503 «повторите», без совета остановить serve', async () => {
  const { root, data, c } = await dataDir();
  try {
    let calls = 0;
    const value = readOnlyRead(c, data, () => {
      if (++calls < 3) throw new Error('database is locked');
      return 'ok';
    });
    assert.equal(value, 'ok');
    assert.equal(calls, 3);
    calls = 0;
    let caught: unknown;
    try {
      readOnlyRead(c, data, () => {
        calls++;
        throw new Error('database is locked');
      });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof DomainError);
    assert.equal(caught.status, 503);
    assert.deepEqual(caught.details, { code: 'DATABASE_BUSY', retryable: true });
    assert.equal(caught.message, DATABASE_BUSY_ADVICE);
    assert.equal(calls, 3);
    assert.match(DATABASE_BUSY_ADVICE, /повторите/);
    assert.doesNotMatch(DATABASE_BUSY_ADVICE, /Остановите/);
    // Другие ошибки чтения не повторяются и не переводятся.
    const other = new Error('boom');
    assert.equal(busyAsDomain(other), other);
    calls = 0;
    assert.throws(
      () =>
        readOnlyRead(c, data, () => {
          calls++;
          throw other;
        }),
      /boom/,
    );
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI agent session_handoff не ждёт блокировку записи работающего writer (WAL)', async () => {
  const { root, data } = await dataDir();
  try {
    const request = join(root, 'request.json');
    await writeFile(request, JSON.stringify({ operation: 'session_handoff', input: {} }));
    const lock = await holdLock(join(data, 'state.sqlite'), 'IMMEDIATE', 8000);
    // Прежде CLI открывал базу writer: начальные строки (`INSERT OR IGNORE`)
    // ждали блокировку записи до конца транзакции writer.
    const result = await command(
      [...cliCommand(), 'agent', '--file', request, '--data', data],
      process.cwd(),
    );
    const doneAt = Date.now();
    assert.equal(result.code, 0, result.stderr);
    assert.ok((JSON.parse(result.stdout) as { pack?: unknown }).pack, 'пакет передачи контекста');
    assert.ok(doneAt < (await lock.released), 'ответ до конца транзакции writer');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
