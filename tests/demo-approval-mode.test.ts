import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { command } from '../src/runner/process.ts';

// `devcontour demo --approval-mode agent|operator` записывает режим
// согласования в конфигурацию учебного проекта; другое значение — отказ до
// создания проекта. Учебный runtime `demo`: модели не вызываются.

const prefix = 'dc-demo-approval-';
const cli = resolve('src/cli.ts');

function scratch() {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
/** Удаляет только каталог, созданный этим тестом во временной папке. */
function remove(root: string) {
  if (root.startsWith(realpathSync(tmpdir()) + sep) && root.includes(prefix))
    rmSync(root, { recursive: true, force: true });
}

/** Запускает `demo` до строки адреса сервера, затем останавливает его штатно. */
async function demo(root: string, mode: string) {
  const data = join(root, 'data');
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      cli,
      'demo',
      '--data',
      data,
      '--checkout-root',
      join(root, 'checkouts'),
      '--approval-mode',
      mode,
      '--port',
      '0',
    ],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
  // Ждём адрес сервера, выход процесса или предел; таймер и опрос
  // снимаются, чтобы не держать процесс теста.
  let done = false;
  let timer: NodeJS.Timeout | undefined;
  const started = await Promise.race([
    (async () => {
      while (!done && !stdout.includes('DevContour: http'))
        await new Promise((r) => setTimeout(r, 100));
      return stdout.includes('DevContour: http');
    })(),
    exited.then(() => false),
    new Promise<boolean>((r) => (timer = setTimeout(() => r(false), 90_000))),
  ]);
  done = true;
  clearTimeout(timer);
  if (child.exitCode === null) child.kill('SIGTERM');
  await exited;
  child.stdout.destroy();
  child.stderr.destroy();
  assert.ok(started, stderr || stdout);
  return JSON.parse(readFileSync(join(data, 'config.json'), 'utf8')) as { approvalMode?: string };
}

test('demo --approval-mode writes agent or operator into the demo configuration', async () => {
  for (const mode of ['operator', 'agent'] as const) {
    const root = scratch();
    try {
      assert.equal((await demo(root, mode)).approvalMode, mode);
    } finally {
      remove(root);
    }
  }
});

test('demo --approval-mode refuses another value before creating the demo project', async () => {
  const root = scratch();
  try {
    const data = join(root, 'data');
    const result = await command(
      ['node', '--import', 'tsx', cli, 'demo', '--data', data, '--approval-mode', 'host'],
      process.cwd(),
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--approval-mode: agent или operator/);
    assert.equal(existsSync(join(data, 'config.json')), false);
  } finally {
    remove(root);
  }
});
