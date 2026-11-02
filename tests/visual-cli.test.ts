import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { junitSummary } from 'devcontour-harness';
import { decodePng } from '../src/runner/png.ts';
import { evaluateVisualRun } from '../src/runner/visual.ts';

const chunk = (type: string, data: Buffer) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

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
      // Касание шага 1 (tap amount) с доказательством.
      stepTaps: [
        {
          step: 1,
          element: 'amount',
          frame: { x: 10, y: 150, width: 175, height: 28 },
          window: { x: 0, y: 0, width: 195, height: 422 },
          keyboard: null,
          point: { x: 97.5, y: 164 },
          hit: { kind: 'element', element: 'amount' },
          before: { visible: ['amount'], focused: null },
          after: { visible: ['amount'], focused: { element: 'amount', text: '' } },
        },
      ],
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
      ['visual.UI-form-focused.reach', 'passed'],
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
  assert.equal(green.tests, 4);
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
  assert.equal((xml.match(/<error type="environment"/g) ?? []).length, 4);
  assert.doesNotMatch(xml, /<skipped/);
  assert.equal(junitSummary(xml).failures, 4);

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

// IHDR валидного PNG заменяется изменённым, с верным CRC: отказ — по смыслу
// заголовка, а не по испорченной контрольной сумме.
const withHeader = (png: Buffer, patch: (header: Buffer) => Buffer) =>
  Buffer.concat([
    png.subarray(0, 8),
    chunk('IHDR', patch(Buffer.from(png.subarray(16, 29)))),
    png.subarray(33),
  ]);

test('PNG: неподдерживаемые и повреждённые файлы отклоняются', () => {
  const valid = encodePng(8, 8, 4, noise);
  assert.equal(decodePng(valid).width, 8);
  const set = (index: number, value: number) => (header: Buffer) => {
    header[index] = value;
    return header;
  };
  const cases: [string, Buffer, RegExp][] = [
    ['палитра', withHeader(valid, set(9, 3)), /RGB\/RGBA/],
    ['16 бит', withHeader(valid, set(8, 16)), /8 бит/],
    ['interlace', withHeader(valid, set(12, 1)), /interlace/],
    ['метод сжатия', withHeader(valid, set(10, 1)), /метод сжатия/],
    ['длина IHDR', withHeader(valid, (h) => Buffer.concat([h, Buffer.alloc(1)])), /длину 13/],
    ['обрезан', valid.subarray(0, valid.length - 20), /обрезан/],
    ['без IEND', valid.subarray(0, valid.length - 12), /нет IEND/],
    [
      'CRC',
      Buffer.concat([valid.subarray(0, 29), Buffer.from([valid[29] ^ 1]), valid.subarray(30)]),
      /CRC/,
    ],
    [
      'размер',
      withHeader(valid, (h) => {
        h.writeUInt32BE(5000, 0);
        h.writeUInt32BE(5000, 4);
        return h;
      }),
      /вне пределов/,
    ],
  ];
  for (const [name, file, error] of cases) assert.throws(() => decodePng(file), error, name);
});

const shot = (paint: (x: number, y: number) => number[]) => {
  const data = Buffer.alloc(390 * 844 * 4);
  for (let y = 0; y < 844; y++)
    for (let x = 0; x < 390; x++) data.set(paint(x, y).slice(0, 4), (y * 390 + x) * 4);
  return data;
};
const flat = () => [242, 242, 242, 255];
const frames = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    state: 'UI-form-focused',
    window: { x: 0, y: 0, width: 195, height: 422 },
    safeArea: { x: 0, y: 24, width: 195, height: 380 },
    keyboard: null,
    elements: { submit: { x: 10, y: 200, width: 175, height: 28 } },
    ...extra,
  });
const backgroundSpec = {
  version: 1,
  platform: 'ios-simulator',
  states: [{ id: 'UI-form-focused', assert: [{ kind: 'background' }] }],
};
const evaluate = async (
  files: Record<string, string | Buffer>,
  value: unknown = backgroundSpec,
) => {
  const root = mkdtempSync(join(tmpdir(), 'dc-visual-'));
  const observations = join(root, 'observations');
  mkdirSync(observations);
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(observations, name), content);
  writeFileSync(join(root, 'spec.json'), JSON.stringify(value));
  const report = join(root, 'visual.xml');
  const result = await evaluateVisualRun({ spec: join(root, 'spec.json'), observations, report });
  return { result, xml: readFileSync(report, 'utf8') };
};
const status = (xml: string) => junitSummary(xml).cases.map((c) => [c.id, c.status]);

test('Наблюдения: плоский PNG падает, .rgba читается, битый PNG не подменяется .rgba', async () => {
  const flatPng = await evaluate({
    'UI-form-focused.frames.json': frames(),
    'UI-form-focused.png': encodePng(390, 844, 3, flat),
  });
  assert.deepEqual(status(flatPng.xml), [
    ['visual.UI-form-focused.reach', 'passed'],
    ['visual.UI-form-focused.background', 'failed'],
  ]);
  assert.match(flatPng.xml, /type="assertion"/);

  const size = { screenshot: { width: 390, height: 844 } };
  const rgba = await evaluate({
    'UI-form-focused.frames.json': frames(size),
    'UI-form-focused.rgba': shot(noise),
  });
  assert.equal(rgba.result.passed, true, rgba.xml);
  const flatRgba = await evaluate({
    'UI-form-focused.frames.json': frames(size),
    'UI-form-focused.rgba': shot(flat),
  });
  assert.deepEqual(status(flatRgba.xml), [
    ['visual.UI-form-focused.reach', 'passed'],
    ['visual.UI-form-focused.background', 'failed'],
  ]);

  const corrupt = await evaluate({
    'UI-form-focused.frames.json': frames(size),
    'UI-form-focused.png': Buffer.from('not a png'),
    'UI-form-focused.rgba': shot(noise),
  });
  assert.equal(corrupt.result.errors, 1);
  assert.equal(corrupt.result.tests, 2);
  assert.match(
    corrupt.xml,
    /<error type="environment" message="снимок UI-form-focused.png не читается/,
  );
});

test('Наблюдения: чужое состояние, ошибка драйвера и неверное поле — ошибки окружения', async () => {
  const shotFile = { 'UI-form-focused.png': encodePng(390, 844, 3, noise) };
  const other = await evaluate({
    ...shotFile,
    'UI-form-focused.frames.json': frames({ state: 'UI-form-other' }),
  });
  assert.match(
    other.xml,
    /<error type="environment" message="UI-form-focused.frames.json описывает состояние UI-form-other/,
  );
  const driver = await evaluate({
    'UI-form-focused.frames.json': JSON.stringify({
      version: 1,
      state: 'UI-form-focused',
      error: 'simulator did not boot',
    }),
  });
  assert.match(driver.xml, /<error type="environment" message="драйвер: simulator did not boot"/);
  const withoutKeyboard = JSON.parse(frames()) as Record<string, unknown>;
  delete withoutKeyboard.keyboard;
  const field = await evaluate({
    ...shotFile,
    'UI-form-focused.frames.json': JSON.stringify(withoutKeyboard),
  });
  assert.match(field.xml, /не по формату: keyboard:/);
  // Обратный случай: те же файлы с верными наблюдениями проходят.
  const fine = await evaluate({ ...shotFile, 'UI-form-focused.frames.json': frames() });
  assert.equal(fine.result.passed, true, fine.xml);
});

const logSpec = {
  version: 1,
  platform: 'ios-simulator',
  log: { forbid: ['deprecated'] },
  states: [{ id: 'UI-form-focused', assert: [{ kind: 'visible', element: 'submit' }] }],
};

test('Журнал читается целиком: строка 55 000 не теряется, пустой журнал — ошибка', async () => {
  const lines = Array.from({ length: 60_000 }, (_, i) => `line ${i}`);
  const clean = await evaluate(
    { 'UI-form-focused.frames.json': frames(), 'log.txt': lines.join('\n') },
    logSpec,
  );
  assert.equal(clean.result.passed, true, clean.xml);
  lines[55_000] = 'helper is deprecated';
  const late = await evaluate(
    { 'UI-form-focused.frames.json': frames(), 'log.txt': lines.join('\n') },
    logSpec,
  );
  assert.deepEqual(status(late.xml), [
    ['visual.UI-form-focused.reach', 'passed'],
    ['visual.UI-form-focused.visible', 'passed'],
    ['visual.log.no-forbidden', 'failed'],
  ]);
  const empty = await evaluate(
    { 'UI-form-focused.frames.json': frames(), 'log.txt': '\n  \n' },
    logSpec,
  );
  assert.match(empty.xml, /<error type="environment" message="журнал прогона пуст/);
});

// PNG 2×1 RGB из готовых строк: фильтр и объём данных задаёт тест.
const rawPng = (rows: Buffer, before: Buffer[] = [], ihdrCount = 1) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...before,
    ...Array.from({ length: ihdrCount }, () => chunk('IHDR', header)),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

test('PNG: порядок блоков, фильтр строки и объём данных проверяются', () => {
  const row = Buffer.from([0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...decodePng(rawPng(row)).data], [1, 2, 3, 255, 4, 5, 6, 255]);
  assert.throws(() => decodePng(rawPng(row, [], 2)), /больше одного IHDR/);
  assert.throws(
    () => decodePng(rawPng(row, [chunk('tEXt', Buffer.from('a\0b'))])),
    /начинаться с IHDR/,
  );
  assert.throws(() => decodePng(rawPng(Buffer.from([5, 1, 2, 3, 4, 5, 6]))), /фильтр PNG 5/);
  assert.throws(() => decodePng(rawPng(Buffer.concat([row, Buffer.alloc(7)]))), /размер данных/);
  assert.throws(() => decodePng(rawPng(row.subarray(0, 5))), /размер данных/);
});

test('Наблюдения: окна журнала в байтах, недостигнутое состояние с касанием шага', async () => {
  // Многобайтовые символы и CRLF: окна задаются байтами файла, не символами.
  const head = 'запуск приложения\r\n';
  const log = head + 'helper is deprecated\n';
  const window = { from: Buffer.byteLength(head), to: Buffer.byteLength(log) };
  const spec = {
    version: 1,
    platform: 'ios-simulator',
    log: { forbid: ['deprecated'] },
    states: [
      {
        id: 'UI-form-focused',
        steps: [{ tap: 'submit' }],
        assert: [{ kind: 'visible', element: 'submit' }],
      },
    ],
  };
  const blocked = await evaluate(
    {
      'UI-form-focused.frames.json': JSON.stringify({
        version: 1,
        state: 'UI-form-focused',
        error: 'step wait: not shown',
        log: window,
        stepTaps: [
          {
            step: 0,
            element: 'submit',
            frame: { x: 10, y: 281, width: 175, height: 28 },
            window: { x: 0, y: 0, width: 195, height: 422 },
            keyboard: { x: 0, y: 290, width: 195, height: 132 },
            point: { x: 97.5, y: 295 },
            hit: { kind: 'keyboard' },
            before: { visible: ['submit'], focused: { element: 'amount', text: '60' } },
            after: { visible: ['submit'], focused: { element: 'amount', text: '602' } },
          },
        ],
      }),
      'log.txt': log,
    },
    spec,
  );
  assert.deepEqual(status(blocked.xml), [
    ['visual.UI-form-focused.reach', 'failed'],
    ['visual.UI-form-focused.visible', 'failed'],
    ['visual.log.no-forbidden', 'failed'],
  ]);
  assert.match(
    blocked.xml,
    /type="assertion" message="состояние не достигнуто: шаг 0 submit: точка касания/,
  );
  assert.match(blocked.xml, /\[UI-form-focused\] helper is deprecated/);
  assert.match(blocked.xml, /&quot;60&quot; → &quot;602&quot;/);
  // Окно, не покрывающее строку, не приписывает её состоянию.
  const outside = await evaluate(
    {
      'UI-form-focused.frames.json': frames({ log: { from: 0, to: window.from } }),
      'log.txt': log,
    },
    spec,
  );
  assert.match(outside.xml, /\[вне окон состояний\] helper is deprecated/);
});

test('Журнал: завершающий перевод строки, NUL, окна за пределами файла и по пересечению', async () => {
  const spec = {
    version: 1,
    platform: 'ios-simulator',
    log: { forbid: ['deprecated'] },
    states: [{ id: 'UI-form-focused', assert: [{ kind: 'visible', element: 'submit' }] }],
  };
  const run = (log: string | Buffer, extra: Record<string, unknown> = {}) =>
    evaluate({ 'UI-form-focused.frames.json': frames(extra), 'log.txt': log }, spec);
  const clean = await run('app started\nrender ok\n');
  assert.match(clean.xml, /проверено строк журнала: 2</);
  const utf16 = await run(Buffer.from('helper is deprecated\n', 'utf16le'));
  assert.match(utf16.xml, /<error type="environment" message="log.txt содержит байты NUL/);
  const beyond = await run('app started\n', { log: { from: 0, to: 100 } });
  assert.match(
    beyond.xml,
    /<error type="environment" message="окно журнала состояния UI-form-focused \[0, 100\) за пределами log.txt \(12 байт\)/,
  );
  // Окно начинается внутри строки: строка всё равно принадлежит состоянию.
  const text = 'helper is deprecated\nrender ok\n';
  const overlap = await run(text, { log: { from: 5, to: Buffer.byteLength(text) } });
  assert.match(overlap.xml, /\[UI-form-focused\] helper is deprecated/);
});
