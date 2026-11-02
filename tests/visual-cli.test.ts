import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { junitSummary } from 'devcontour-harness';
import { decodePng } from '../src/runner/png.ts';

// PNG с фильтром строки y % 5: декодер проверяется на всех пяти фильтрах.
function encodePng(
  width: number,
  height: number,
  channels: 3 | 4,
  pixel: (x: number, y: number) => number[],
) {
  const stride = width * channels;
  const rows: Buffer[] = [];
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const line = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) line.set(pixel(x, y).slice(0, channels), x * channels);
    const filter = y % 5;
    const out = Buffer.alloc(stride + 1);
    out[0] = filter;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? line[i - channels] : 0;
      const up = previous[i];
      const corner = i >= channels ? previous[i - channels] : 0;
      const p = left + up - corner;
      const paeth =
        Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - corner)
          ? left
          : Math.abs(p - up) <= Math.abs(p - corner)
            ? up
            : corner;
      const predictor = [0, left, up, (left + up) >> 1, paeth][filter];
      out[i + 1] = (line[i] - predictor) & 0xff;
    }
    rows.push(out);
    previous = line;
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    // CRC декодер не проверяет: снимок пишет локальный драйвер, не сеть.
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, channels === 4 ? 6 : 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const noise = (x: number, y: number) => {
  let h = (x * 374761393 + y * 668265263) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return [h & 255, (h >>> 8) & 255, (h >>> 16) & 255, 255];
};

test('PNG: RGB и RGBA со всеми фильтрами строк декодируются точно', () => {
  for (const channels of [3, 4] as const) {
    const png = decodePng(
      encodePng(17, 11, channels, (x, y) => [x * 13, y * 21, (x * y) & 255, 200]),
    );
    assert.equal(png.width, 17);
    assert.equal(png.height, 11);
    for (const [x, y] of [
      [0, 0],
      [16, 10],
      [5, 3],
      [9, 4],
    ]) {
      const at = (y * 17 + x) * 4;
      assert.deepEqual(
        [...png.data.subarray(at, at + 4)],
        [x * 13, y * 21, (x * y) & 255, channels === 4 ? 200 : 255],
      );
    }
  }
  assert.throws(() => decodePng(Buffer.from('not a png')), /не PNG/);
});

const cli = (...args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'visual', ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  });

const spec = {
  version: 1,
  platform: 'ios-simulator',
  log: { forbid: ['deprecated'] },
  states: [
    {
      id: 'UI-form-focused',
      steps: [{ launch: true }, { tap: 'amount' }, { type: '135' }],
      assert: [
        { kind: 'visible', element: 'submit' },
        { kind: 'background', surfaces: ['card'] },
      ],
    },
  ],
};
const observe = (directory: string, buttonY: number, logText: string) => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'UI-form-focused.frames.json'),
    JSON.stringify({
      version: 1,
      state: 'UI-form-focused',
      window: { x: 0, y: 0, width: 195, height: 422 },
      safeArea: { x: 0, y: 24, width: 195, height: 380 },
      keyboard: { x: 0, y: 290, width: 195, height: 132 },
      elements: {
        submit: { x: 10, y: buttonY, width: 175, height: 28 },
        card: { x: 10, y: 60, width: 175, height: 80 },
      },
    }),
  );
  // Снимок в масштабе 2×: шумный фон и белая карточка.
  writeFileSync(
    join(directory, 'UI-form-focused.png'),
    encodePng(390, 844, 4, (x, y) =>
      x >= 20 && x < 370 && y >= 120 && y < 280 ? [255, 255, 255, 255] : noise(x, y),
    ),
  );
  writeFileSync(join(directory, 'log.txt'), logText);
};

test('visual evaluate: дефектные наблюдения дают провалы в JUnit и код 1, исправленные — 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'dc-visual-'));
  const specPath = join(root, 'spec.json');
  writeFileSync(specPath, JSON.stringify(spec));

  observe(join(root, 'bad'), 281, 'bundle ok\nWARN helper is deprecated\n');
  const report = join(root, 'reports', 'bad.xml');
  const bad = cli(
    'evaluate',
    '--spec',
    specPath,
    '--observations',
    join(root, 'bad'),
    '--report',
    report,
  );
  assert.equal(bad.status, 1, bad.stderr);
  const summary = junitSummary(readFileSync(report, 'utf8'));
  assert.deepEqual(
    summary.cases.map((c) => [c.id, c.status]),
    [
      ['visual.UI-form-focused.visible', 'failed'],
      ['visual.UI-form-focused.background', 'passed'],
      ['visual.log.no-forbidden', 'failed'],
    ],
  );
  assert.match(summary.failedDetails.join('\n'), /закрыто 19 из 28 pt/);
  const output = JSON.parse(bad.stdout) as { passed: boolean; failures: number };
  assert.equal(output.passed, false);
  assert.equal(output.failures, 2);

  observe(join(root, 'good'), 240, 'bundle ok\n');
  const fixed = join(root, 'reports', 'good.xml');
  const good = cli(
    'evaluate',
    '--spec',
    specPath,
    '--observations',
    join(root, 'good'),
    '--report',
    fixed,
  );
  assert.equal(good.status, 0, good.stdout + good.stderr);
  const green = junitSummary(readFileSync(fixed, 'utf8'));
  assert.equal(green.tests, 3);
  assert.equal(green.failures, 0);
});

test('visual evaluate: нет наблюдений — ошибка окружения; неверная спецификация — провал отчёта', () => {
  const root = mkdtempSync(join(tmpdir(), 'dc-visual-'));
  const specPath = join(root, 'spec.json');
  writeFileSync(specPath, JSON.stringify(spec));
  mkdirSync(join(root, 'empty'));
  const report = join(root, 'empty.xml');
  const run = cli(
    'evaluate',
    '--spec',
    specPath,
    '--observations',
    join(root, 'empty'),
    '--report',
    report,
  );
  assert.equal(run.status, 1);
  const xml = readFileSync(report, 'utf8');
  assert.equal((xml.match(/<error type="environment"/g) ?? []).length, 3);
  assert.doesNotMatch(xml, /<skipped/);
  assert.equal(junitSummary(xml).failures, 3);

  writeFileSync(specPath, JSON.stringify({ ...spec, states: [] }));
  const invalid = join(root, 'invalid.xml');
  const rejected = cli(
    'evaluate',
    '--spec',
    specPath,
    '--observations',
    join(root, 'empty'),
    '--report',
    invalid,
  );
  assert.equal(rejected.status, 1);
  const parsed = junitSummary(readFileSync(invalid, 'utf8'));
  assert.deepEqual(
    parsed.cases.map((c) => [c.id, c.status]),
    [['visual.spec.valid', 'failed']],
  );
  assert.match(parsed.failedDetails[0], /спецификация не принята/);

  const usage = cli('run');
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /visual run ещё не реализован/);
});
