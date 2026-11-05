import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { junitSummary } from 'devcontour-harness';
import { evaluateReach, visualSpecSchema } from '../src/core/visual.ts';
import { gateList } from '../src/core/model.ts';
import { loadConfig } from '../src/runner/config.ts';
import { policyFromConfig } from '../src/harness/policy.ts';
import {
  BrokerError,
  brokerAddress,
  httpBroker,
  type BrokerFrames,
  type BrokerRect,
  type VisualBroker,
} from '../src/runner/visual-broker.ts';
import { hitAt, visualRun } from '../src/runner/visual-run.ts';
import { config } from './helpers.ts';

// --- PNG без зависимостей: фильтр 0, RGB -------------------------------------
const chunk = (type: string, data: Buffer) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};
function png(width: number, height: number, pixel: (x: number, y: number) => number[]) {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) row.set(pixel(x, y), 1 + x * 3);
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
// Детерминированный шум «фотографии» и плоская заливка с карточкой.
const noise = (x: number, y: number) => {
  const h = Math.imul((x * 73856093) ^ (y * 19349663), 2654435761) >>> 0;
  return [h & 255, (h >>> 8) & 255, (h >>> 16) & 255];
};
const flatWithCard = (x: number, y: number) =>
  x > 40 && x < 360 && y > 200 && y < 400 ? [255, 255, 255] : [242, 242, 242];

// --- Приложение-модель для broker в процессе ---------------------------------
const WINDOW = { x: 0, y: 0, width: 402, height: 874 };
const SAFE = { x: 0, y: 62, width: 402, height: 778 };
const KEYBOARD = { x: 0, y: 583, width: 402, height: 291 };

/**
 * Экран формы: поле суммы, кнопка «рассчитать» и результат. Касание поля
 * поднимает клавиатуру; касание в рамке клавиатуры набирает «2» в поле —
 * так пользователь, целясь в закрытую кнопку, попадает в клавишу.
 */
/** Синхронная форма интерфейса broker для модели приложения. */
type Sync<T> = {
  [K in keyof T]: T[K] extends (...a: infer A) => Promise<infer R> ? (...a: A) => R : never;
};

function fakeApp(options: {
  buttonY: number;
  background: (x: number, y: number) => number[];
  log: string;
  host?: 'dev-client' | 'expo-go';
  device?: Partial<{
    model: string;
    runtime: string;
    appearance: 'light' | 'dark';
    locale: string;
  }>;
  /** Поле принимает не больше стольких символов (маска ввода, maxLength). */
  maxLength?: number;
  /** Поле пароля: broker отдаёт маску и `secure`. */
  secure?: boolean;
  /** Касание поля фокусирует другое поле. */
  focusElsewhere?: boolean;
  /**
   * Часы теста: клавиатура (панель подсказок) перестраивается 300 мс после
   * фокуса и каждого символа, кнопка движется вместе с ней.
   */
  animated?: () => number;
  /** Список: `far-item` ниже видимой части; `scrolls` — прокрутка его показывает. */
  list?: { scrolls: boolean; item: boolean };
  /** Список появляется через `ms` по часам теста. */
  listAfter?: { now: () => number; ms: number };
  /** Курсор встаёт в точку касания поля (иначе — в конец текста). */
  caretAtTap?: boolean;
  /** Курсор ставит только первое касание после фокуса. */
  caretStuck?: boolean;
  /** Начальный текст поля. */
  prefill?: string;
  /** Поле в фокусе без id (broker отдаёт element: null). */
  unnamedFocus?: boolean;
  /** Рамки «дрожат»: кнопка сдвигается на каждом чтении. */
  jitter?: boolean;
  /** Первый символ после фокуса стирает прежний текст (так iOS ведёт себя с паролем). */
  clearsOnRefocus?: boolean;
}) {
  let freshFocus = false;
  let text = options.prefill ?? '';
  let caret = Array.from(text).length;
  let framesReads = 0;
  let focused: string | null = null;
  let result = false;
  let launched = false;
  let log = '';
  let inputAt = 0;
  let scrolled = 0;
  const calls: string[] = [];
  const hellos: unknown[] = [];
  const input = { x: 26, y: 300, width: 350, height: 44 };
  const listFrame = { x: 0, y: 360, width: 402, height: 200 };
  // Анимация: стадия 0, 1, 2 по 150 мс после последнего ввода.
  const stage = () =>
    options.animated ? Math.min(2, Math.floor((options.animated() - inputAt) / 150)) : 2;
  const touched = () => {
    if (options.animated) inputAt = options.animated();
  };
  const button = () => ({
    x: 26,
    y: focused && stage() < 2 ? options.buttonY - 150 : options.buttonY,
    width: 350,
    height: 56,
  });
  const keyboard = (): BrokerRect | null =>
    focused ? (stage() < 2 ? { ...KEYBOARD, y: 800 - stage() * 100 } : KEYBOARD) : null;
  const within = (r: BrokerRect, x: number, y: number) =>
    x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
  // Набор и удаление — в позиции курсора, как в настоящем поле.
  const accept = (ch: string) => {
    const chars = Array.from(text);
    if (ch === '\b') {
      if (caret > 0) {
        chars.splice(caret - 1, 1);
        caret--;
      }
    } else if (options.maxLength === undefined || chars.length < options.maxLength) {
      chars.splice(caret, 0, ch);
      caret++;
    }
    text = chars.join('');
  };
  const sync: Sync<VisualBroker> = {
    hello: (device) => {
      hellos.push(device);
      return {
        protocol: 1 as const,
        platform: 'ios' as const,
        host: options.host ?? 'dev-client',
        device: {
          udid: 'SIM-1',
          model: 'iPhone 16 Pro',
          runtime: 'iOS 18.5',
          appearance: 'light' as const,
          locale: 'ru_RU',
          ...options.device,
        },
      };
    },
    frames: (): BrokerFrames => {
      calls.push('frames');
      framesReads++;
      const listShown =
        options.list && (!options.listAfter || options.listAfter.now() >= options.listAfter.ms);
      const elements: Record<string, BrokerRect> = launched
        ? {
            'form-screen': WINDOW,
            'amount-input': input,
            'other-input': { x: 26, y: 200, width: 350, height: 44 },
            submit: options.jitter ? { ...button(), y: button().y + (framesReads % 7) } : button(),
            ...(result ? { result: { x: 26, y: 120, width: 350, height: 40 } } : {}),
            ...(options.list && listShown
              ? {
                  list: listFrame,
                  ...(options.list.item
                    ? { 'far-item': { x: 20, y: 900 - scrolled * 220, width: 300, height: 40 } }
                    : {}),
                }
              : {}),
          }
        : {};
      return {
        window: WINDOW,
        safeArea: SAFE,
        elements,
        focused: focused
          ? {
              element: options.unnamedFocus ? null : focused,
              text: options.secure ? '•'.repeat(Array.from(text).length) : text,
              ...(options.secure ? { secure: true as const } : {}),
            }
          : null,
      };
    },
    keyboardFrame: () => keyboard(),
    tapPoint: (x, y) => {
      calls.push(`tap ${x},${y}`);
      const kb = keyboard();
      if (kb && within(kb, x, y)) accept('2');
      else if (within(input, x, y)) {
        const first = !focused;
        freshFocus = true;
        focused = options.focusElsewhere ? 'other-input' : 'amount-input';
        if (options.caretAtTap && (first || !options.caretStuck))
          caret = Math.round(((x - input.x) / input.width) * Array.from(text).length);
        else if (!options.caretAtTap) caret = Array.from(text).length;
        touched();
      } else if (within(button(), x, y)) {
        result = true;
        focused = null;
      }
    },
    typeText: (value) => {
      calls.push(`type ${JSON.stringify(value)}`);
      if (options.clearsOnRefocus && freshFocus && value !== '\b' && !value.startsWith('\b')) {
        text = '';
        caret = 0;
      }
      freshFocus = false;
      for (const ch of value) accept(ch);
      touched();
    },
    drag: () => {
      calls.push('drag');
      if (options.list?.scrolls) scrolled++;
    },
    screenshot: () => png(WINDOW.width, WINDOW.height, options.background),
    launch: (args) => {
      calls.push(`launch ${args.join(' ')}`.trim());
      launched = true;
      log += 'bundle ok\n' + options.log;
    },
    openURL: (url) => {
      calls.push(`open ${url}`);
    },
    logSize: () => Buffer.byteLength(log),
    logRead: (from) => ({
      size: Buffer.byteLength(log),
      data: Buffer.from(log).subarray(from),
    }),
  };
  // Тот же объект через Promise: интерфейс broker асинхронный.
  const broker = Object.fromEntries(
    Object.entries(sync).map(([k, f]) => [
      k,
      (...a: unknown[]) => Promise.resolve((f as (...x: unknown[]) => unknown)(...a)),
    ]),
  ) as unknown as VisualBroker;
  return { broker, calls, hellos };
}

const spec = {
  version: 1,
  platform: 'ios',
  defaults: { settleMs: 0, stateTimeoutMs: 15000 },
  log: { forbid: ['is deprecated'] },
  decorative: ['form-screen'],
  states: [
    {
      id: 'UI-form-focused',
      steps: [{ launch: true }, { tap: 'amount-input' }, { type: '13' }],
      assert: [
        { kind: 'visible', element: 'submit' },
        { kind: 'tap-hits', element: 'submit', expect: { visible: 'result' } },
        { kind: 'background' },
      ],
    },
  ],
};

/** Виртуальные часы: ожидания драйвера не тратят реальное время теста. */
function clock() {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

type Frames = {
  keyboard: unknown;
  taps: Record<
    string,
    { hit: { kind: string; element?: string }; after: { focused: { text: string } } }
  >;
  stepTaps: { hit: { element?: string } }[];
};
const framesOf = (cwd: string) =>
  JSON.parse(
    readFileSync(join(cwd, '.reports', 'visual', 'UI-form-focused.frames.json'), 'utf8'),
  ) as Frames;

function workspace(value: unknown = spec) {
  const cwd = mkdtempSync(join(tmpdir(), 'dc-vrun-'));
  mkdirSync(join(cwd, 'contracts'));
  writeFileSync(join(cwd, 'contracts', 'ui.json'), JSON.stringify(value));
  return cwd;
}
/** Спецификация с одним состоянием из заданных шагов и утверждений. */
const single = (
  steps: unknown[],
  assert: unknown[],
  extra: { state?: Record<string, unknown> } & Record<string, unknown> = {},
) => {
  const { state, ...rest } = extra;
  return {
    version: 1,
    platform: 'ios',
    defaults: { settleMs: 0, stateTimeoutMs: 15000 },
    decorative: ['form-screen'],
    ...rest,
    states: [{ id: 'UI-form-focused', steps, assert, ...state }],
  };
};
const xmlOf = (cwd: string) => readFileSync(join(cwd, '.reports', 'visual.xml'), 'utf8');
/** testcase reach: провал продукта (failure) или ошибка окружения (error). */
const reachOf = (cwd: string) =>
  /name="reach">\s*<(failure|error) type="(assertion|environment)"/.exec(xmlOf(cwd));
const run = (cwd: string, broker: VisualBroker | { error: string }, extra = {}) =>
  visualRun({
    spec: 'contracts/ui.json',
    out: '.reports/visual',
    report: '.reports/visual.xml',
    cwd,
    broker,
    platform: 'darwin',
    ...clock(),
    ...extra,
  });
const cases = (cwd: string) =>
  junitSummary(readFileSync(join(cwd, '.reports', 'visual.xml'), 'utf8')).cases.map((c) => [
    c.id,
    c.status,
  ]);

test('visual run: кнопка под клавиатурой, плоский фон и предупреждение — провалы с числами', async () => {
  const cwd = workspace();
  const { broker, calls } = fakeApp({
    buttonY: 563,
    background: flatWithCard,
    log: ' WARN  ImageBackground is deprecated\n',
  });
  const result = await run(cwd, broker);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(cases(cwd), [
    ['visual.host.accepted', 'passed'],
    ['visual.UI-form-focused.reach', 'passed'],
    ['visual.UI-form-focused.visible', 'failed'],
    ['visual.UI-form-focused.tap-hits', 'failed'],
    ['visual.UI-form-focused.background', 'failed'],
    ['visual.log.no-forbidden', 'failed'],
  ]);
  const xml = readFileSync(join(cwd, '.reports', 'visual.xml'), 'utf8');
  assert.match(xml, /закрыто 36 из 56 pt/);
  assert.match(xml, /ImageBackground is deprecated/);
  // Касание утверждения — по координате центра кнопки (201, 591), которая под клавиатурой.
  assert.ok(calls.includes('tap 201,591'), calls.join('\n'));
  const frames = framesOf(cwd);
  assert.deepEqual(frames.keyboard, KEYBOARD);
  assert.equal(frames.taps['tap-hits'].hit.kind, 'keyboard');
  assert.equal(frames.taps['tap-hits'].after.focused.text, '132');
  assert.ok(existsSync(join(cwd, '.reports', 'visual', 'UI-form-focused.png')));
  assert.ok(existsSync(join(cwd, '.reports', 'visual', 'UI-form-focused.after-tap-hits.png')));
  const evidence = JSON.parse(
    readFileSync(join(cwd, '.reports', 'visual', 'run.json'), 'utf8'),
  ) as { host: string; device: { udid: string } };
  assert.equal(evidence.host, 'dev-client');
  assert.equal(evidence.device.udid, 'SIM-1');
});

test('visual run: кнопка над клавиатурой, фото-фон и чистый журнал — зелёный прогон', async () => {
  const cwd = workspace();
  const { broker } = fakeApp({ buttonY: 500, background: noise, log: '' });
  const result = await run(cwd, broker);
  assert.deepEqual(result.failed, []);
  assert.equal(result.exitCode, 0);
  assert.ok(cases(cwd).every(([, status]) => status === 'passed'));
  assert.equal(cases(cwd).length, 6);
  const frames = framesOf(cwd);
  // Касание шага записано с доказательством: точка, принявший элемент, текст до и после.
  assert.equal(frames.stepTaps.length, 1);
  assert.deepEqual(frames.stepTaps[0].hit.element, 'amount-input');
  assert.equal(frames.taps['tap-hits'].hit.element, 'submit');
  assert.ok(readFileSync(join(cwd, '.reports', 'visual', 'log.txt'), 'utf8').includes('bundle ok'));
});

test('visual run: не macOS, нет broker и broker недоступен — ошибки окружения, код 75', async () => {
  for (const [extra, broker, reason] of [
    [
      { platform: 'linux' },
      fakeApp({ buttonY: 500, background: noise, log: '' }).broker,
      /только на macOS/,
    ],
    [{}, { error: 'нет ресурса visual-broker вида port среди ресурсов gate' }, /visual-broker/],
    [
      {},
      httpBroker({ port: 9, token: 't' }, { timeoutMs: 2000 }),
      /недоступен[\s\S]*visual broker start/,
    ],
  ] as const) {
    const cwd = workspace();
    const result = await run(cwd, broker, extra);
    assert.equal(result.exitCode, 75, JSON.stringify(result));
    assert.equal(result.failures, 0);
    assert.ok(result.errors >= 4);
    const xml = readFileSync(join(cwd, '.reports', 'visual.xml'), 'utf8');
    assert.match(xml, /type="environment"/);
    assert.match(xml, reason);
    assert.doesNotMatch(xml, /<skipped/);
  }
});

test('visual run: Expo Go принимается в gate задачи и отклоняется для релиза', async () => {
  const task = workspace();
  await run(task, fakeApp({ buttonY: 500, background: noise, log: '', host: 'expo-go' }).broker);
  // Спецификация объявляет dev-client по умолчанию: другой хост broker — ошибка окружения.
  // JUnit-сводка harness не различает error и failure; различает тип в XML.
  assert.match(
    readFileSync(join(task, '.reports', 'visual.xml'), 'utf8'),
    /name="accepted">\s*<error type="environment" message="устройство broker не соответствует спецификации: broker запускает приложение в expo-go/,
  );

  const expo = workspace();
  writeFileSync(join(expo, 'contracts', 'ui.json'), JSON.stringify({ ...spec, host: 'expo-go' }));
  const green = await run(
    expo,
    fakeApp({ buttonY: 500, background: noise, log: '', host: 'expo-go' }).broker,
  );
  assert.equal(green.exitCode, 0);
  const release = await run(
    expo,
    fakeApp({ buttonY: 500, background: noise, log: '', host: 'expo-go' }).broker,
    { release: true },
  );
  assert.equal(release.exitCode, 1);
  assert.match(
    readFileSync(join(expo, '.reports', 'visual.xml'), 'utf8'),
    /name="accepted">\s*<failure type="assertion" message="проверка уровня релиза не принимает Expo Go/,
  );
});

test('visual run: каталоги вне рабочего дерева отклоняются, неверная спецификация — провал', async () => {
  const cwd = workspace();
  const { broker } = fakeApp({ buttonY: 500, background: noise, log: '' });
  await assert.rejects(run(cwd, broker, { out: '../elsewhere' }), /внутри рабочего дерева/);
  writeFileSync(
    join(cwd, 'contracts', 'ui.json'),
    JSON.stringify({ ...spec, platform: 'ios-simulator' }),
  );
  const result = await run(cwd, broker);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(cases(cwd), [['visual.spec.valid', 'failed']]);
});

test('Спецификация: ios и web, host по платформе, route требует адреса, notUnder keyboard не для web', () => {
  const base = { version: 1, states: [{ id: 'UI-a-b', assert: [{ kind: 'background' }] }] };
  assert.ok(visualSpecSchema.safeParse({ ...base, platform: 'ios' }).success);
  assert.ok(visualSpecSchema.safeParse({ ...base, platform: 'ios', host: 'expo-go' }).success);
  assert.ok(visualSpecSchema.safeParse({ ...base, platform: 'web' }).success);
  assert.ok(!visualSpecSchema.safeParse({ ...base, platform: 'ios-simulator' }).success);
  assert.ok(!visualSpecSchema.safeParse({ ...base, platform: 'ios', host: 'browser' }).success);
  assert.ok(!visualSpecSchema.safeParse({ ...base, platform: 'web', host: 'dev-client' }).success);
  const routed = {
    version: 1,
    platform: 'ios',
    states: [{ id: 'UI-a-b', route: '/a', assert: [{ kind: 'background' }] }],
  };
  assert.ok(!visualSpecSchema.safeParse(routed).success);
  assert.ok(visualSpecSchema.safeParse({ ...routed, app: { scheme: 'app' } }).success);
  const keyboard = {
    version: 1,
    states: [{ id: 'UI-a-b', assert: [{ kind: 'visible', element: 'x', notUnder: ['keyboard'] }] }],
  };
  assert.ok(visualSpecSchema.safeParse({ ...keyboard, platform: 'ios' }).success);
  assert.ok(!visualSpecSchema.safeParse({ ...keyboard, platform: 'web' }).success);
  assert.ok(!visualSpecSchema.safeParse({ ...base, platform: 'ios', extra: true }).success);
});

test('hit: клавиатура, наименьшая рамка без декоративных, пустой участок', () => {
  const frames: BrokerFrames = {
    window: WINDOW,
    safeArea: SAFE,
    elements: {
      bg: WINDOW,
      card: { x: 0, y: 0, width: 200, height: 200 },
      label: { x: 10, y: 10, width: 50, height: 20 },
    },
    focused: null,
  };
  const deco = new Set(['bg']);
  assert.deepEqual(hitAt({ frames, keyboard: KEYBOARD }, { x: 5, y: 600 }, deco), {
    kind: 'keyboard',
  });
  assert.equal(
    (hitAt({ frames, keyboard: null }, { x: 20, y: 15 }, deco) as { element: string }).element,
    'label',
  );
  assert.equal(
    (hitAt({ frames, keyboard: null }, { x: 150, y: 150 }, deco) as { element: string }).element,
    'card',
  );
  assert.deepEqual(hitAt({ frames, keyboard: null }, { x: 300, y: 300 }, deco), { kind: 'none' });
});

test('Broker по HTTP: токен, закрытый набор, ответ не по договору — сбой окружения', async () => {
  const seen: { method: string; auth?: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { method } = JSON.parse(body) as { method: string };
      seen.push({ method, auth: req.headers.authorization });
      const reply =
        method === 'keyboardFrame'
          ? { result: { keyboard: KEYBOARD } }
          : method === 'frames'
            ? {
                result: {
                  window: WINDOW,
                  safeArea: SAFE,
                  elements: { ok: WINDOW, 'bad id with spaces': WINDOW },
                  focused: null,
                },
              }
            : method === 'screenshot'
              ? { result: { png: 42 } }
              : { error: { message: 'симулятор не загружен' } };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const port = (server.address() as { port: number }).port;
    const broker = httpBroker({ port, token: 'secret' });
    assert.deepEqual(await broker.keyboardFrame(), KEYBOARD);
    assert.deepEqual(Object.keys((await broker.frames()).elements), ['ok']);
    await assert.rejects(
      broker.screenshot(),
      (e) => e instanceof BrokerError && /не по договору/.test(e.message),
    );
    await assert.rejects(broker.launch([]), /симулятор не загружен/);
    assert.ok(seen.every((s) => s.auth === 'Bearer secret'));
  } finally {
    server.close();
  }
});

test('Адрес broker: порт из ресурса, токен из окружения, иначе названная причина', () => {
  const resources = JSON.stringify([
    { id: 'ios-sim', kind: 'device', value: 'iPhone 16 Pro / iOS 18.5' },
    { id: 'visual-broker', kind: 'port', value: '8093' },
  ]);
  assert.deepEqual(
    brokerAddress(
      { DEVCONTOUR_RESOURCES_JSON: resources, DEVCONTOUR_VISUAL_TOKEN: 't' },
      'visual-broker',
    ),
    { port: 8093, token: 't', device: 'iPhone 16 Pro / iOS 18.5' },
  );
  assert.match(
    (brokerAddress({ DEVCONTOUR_RESOURCES_JSON: resources }, 'visual-broker') as { error: string })
      .error,
    /DEVCONTOUR_VISUAL_TOKEN/,
  );
  assert.match((brokerAddress({}, 'visual-broker') as { error: string }).error, /RESOURCES_JSON/);
  assert.match(
    (
      brokerAddress(
        { DEVCONTOUR_RESOURCES_JSON: resources, DEVCONTOUR_VISUAL_TOKEN: 't' },
        'ios-sim',
      ) as {
        error: string;
      }
    ).error,
    /вида port/,
  );
});

test('Конфигурация: gate визуальной приёмки с artifacts проходит схему и доходит до harness', () => {
  const gate = {
    id: 'visual-mobile',
    kind: 'test',
    command: ['devcontour', 'visual', 'run', '--spec', 'contracts/ui-states/mobile.json'],
    resources: ['ios-sim', 'visual-broker'],
    timeoutMs: 420000,
    report: { type: 'junit', path: '.reports/visual.xml' },
    artifacts: ['.reports/visual'],
  };
  assert.deepEqual(gateList.parse([gate])[0].artifacts, ['.reports/visual']);
  for (const bad of [[], ['../outside'], ['/abs/path'], ['a/*.png'], Array(17).fill('x')])
    assert.ok(!gateList.safeParse([{ ...gate, artifacts: bad }]).success, JSON.stringify(bad));

  const root = mkdtempSync(join(tmpdir(), 'dc-vrun-config-'));
  const file = join(root, 'config.json');
  const c = config({ repository: root });
  writeFileSync(
    file,
    JSON.stringify({
      ...c,
      resources: [
        { id: 'ios-sim', kind: 'device', value: 'iPhone 16 Pro / iOS 18.5' },
        { id: 'visual-broker', kind: 'port', value: '8093' },
      ],
      gates: [...c.gates, gate],
      gateGroups: { visual: ['visual-mobile'] },
    }),
  );
  const policy = policyFromConfig(loadConfig(file));
  const gates =
    (policy as unknown as { gates?: { id: string; artifacts?: string[] }[] }).gates ??
    (policy as unknown as { repositories: { gates: { id: string; artifacts?: string[] }[] }[] })
      .repositories[0].gates;
  assert.deepEqual(gates.find((g) => g.id === 'visual-mobile')?.artifacts, ['.reports/visual']);
  assert.equal(gates.find((g) => g.id !== 'visual-mobile')?.artifacts, undefined);
});

test('CLI visual run: без ресурсов gate — JUnit с ошибкой окружения и код 75; broker — честный отказ', () => {
  const cwd = workspace();
  const cli = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        join(import.meta.dirname, '..', 'src', 'cli.ts'),
        'visual',
        ...args,
      ],
      {
        cwd,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, DEVCONTOUR_RESOURCES_JSON: '' },
      },
    );
  const result = cli('run', '--spec', 'contracts/ui.json');
  assert.equal(result.status, 75, result.stderr);
  const xml = readFileSync(join(cwd, '.reports', 'visual.xml'), 'utf8');
  assert.match(
    xml,
    process.platform === 'darwin' ? /DEVCONTOUR_RESOURCES_JSON/ : /только на macOS/,
  );
  assert.ok(existsSync(join(cwd, '.reports', 'visual', 'run.json')));
  const broker = cli('broker', 'start');
  assert.notEqual(broker.status, 0);
  assert.match(broker.stderr, /ещё не реализован/);
});

const green = (extra: Partial<Parameters<typeof fakeApp>[0]> = {}) =>
  fakeApp({ buttonY: 500, background: noise, log: '', ...extra });

test('Устройство: требования спецификации уходят в hello и сверяются; расхождение — красный прогон', async () => {
  const device = {
    model: 'iPhone 16 Pro',
    runtime: 'iOS 18',
    appearance: 'light',
    locale: 'ru-RU',
  };
  const ok = workspace({ ...spec, device });
  const app = green();
  const passed = await run(ok, app.broker);
  assert.equal(passed.exitCode, 0, JSON.stringify(passed.failed));
  assert.deepEqual(app.hellos[0], device);
  for (const [other, word] of [
    [{ runtime: 'iOS 17.5' }, /среда iOS 17\.5/],
    [{ appearance: 'dark' as const }, /оформление dark/],
    [{ locale: 'en_US' }, /локаль en_US/],
    [{ model: 'iPhone SE' }, /модель iPhone SE/],
  ] as const) {
    const cwd = workspace({ ...spec, device });
    const result = await run(cwd, green({ device: other }).broker);
    // Ни одна проверка не зелёная: измерения были бы о другом устройстве.
    assert.equal(result.exitCode, 75);
    assert.ok(
      cases(cwd).every(([, status]) => status !== 'passed'),
      JSON.stringify(cases(cwd)),
    );
    assert.match(xmlOf(cwd), word);
  }
  // iOS 18.5 не допускает iOS 18.50.
  const strict = workspace({ ...spec, device: { runtime: 'iOS 18.5' } });
  assert.equal(
    (await run(strict, green({ device: { runtime: 'iOS 18.50' } }).broker)).exitCode,
    75,
  );
});

test('Набор: экран не принял текст — провал продукта; поле пароля сравнивается по длине', async () => {
  const typing = single(
    [{ launch: true }, { tap: 'amount-input' }, { type: '1350' }],
    [{ kind: 'visible', element: 'submit' }],
  );
  const capped = workspace(typing);
  const red = await run(capped, green({ maxLength: 3 }).broker);
  assert.equal(red.exitCode, 1);
  assert.deepEqual(reachOf(capped)?.slice(1, 3), ['failure', 'assertion']);
  assert.match(xmlOf(capped), /шаг 2 \(type\).*после символа 4/);
  // Обратный случай: то же поле без ограничения.
  const free = workspace(typing);
  assert.equal((await run(free, green().broker)).exitCode, 0);
  // Поле пароля: маска вместо текста, длина растёт — набор принят.
  const secure = workspace(typing);
  assert.equal((await run(secure, green({ secure: true }).broker)).exitCode, 0);
  const secureCapped = workspace(typing);
  assert.equal((await run(secureCapped, green({ secure: true, maxLength: 2 }).broker)).exitCode, 1);
  assert.match(xmlOf(secureCapped), /длина поля amount-input 2, ожидалось 3/);
  assert.doesNotMatch(xmlOf(secureCapped), /1350/);
  // Нет поля в фокусе: набор без касания поля.
  const unfocused = workspace(
    single([{ launch: true }, { type: '1' }], [{ kind: 'visible', element: 'submit' }]),
  );
  assert.equal((await run(unfocused, green().broker)).exitCode, 1);
  assert.match(xmlOf(unfocused), /нет поля в фокусе/);
});

test('Очистка: в фокусе должна оказаться цель, иначе провал продукта', async () => {
  const onlyClear = workspace(
    single([{ launch: true }, { clear: 'amount-input' }], [{ kind: 'visible', element: 'submit' }]),
  );
  assert.equal((await run(onlyClear, green({ focusElsewhere: true }).broker)).exitCode, 1);
  assert.deepEqual(reachOf(onlyClear)?.slice(1, 3), ['failure', 'assertion']);
  assert.match(
    xmlOf(onlyClear),
    /шаг 1 \(clear\): после касания amount-input в фокусе other-input/,
  );
  // Обратный случай: касание фокусирует саму цель, текст удаляется.
  const fine = workspace(
    single(
      [{ launch: true }, { tap: 'amount-input' }, { type: '13' }, { clear: 'amount-input' }],
      [{ kind: 'visible', element: 'submit' }],
    ),
  );
  assert.equal((await run(fine, green().broker)).exitCode, 0);
});

test('Прокрутка: цель не показана — провал продукта, цели нет — missing с той же целью', async () => {
  const scrolling = single(
    [{ launch: true }, { scroll: 'list', to: 'far-item', maxSwipes: 3 }],
    [{ kind: 'visible', element: 'submit' }],
  );
  const stuck = workspace(scrolling);
  assert.equal(
    (await run(stuck, green({ list: { scrolls: false, item: true } }).broker)).exitCode,
    1,
  );
  assert.match(xmlOf(stuck), /шаг 1 \(scroll\): прокрутка list: far-item не показан/);
  const absent = workspace(scrolling);
  assert.equal(
    (await run(absent, green({ list: { scrolls: false, item: false } }).broker)).exitCode,
    1,
  );
  assert.match(xmlOf(absent), /шаг 1: цель far-item не найдена на экране/);
  const noList = workspace(scrolling);
  assert.equal((await run(noList, green().broker)).exitCode, 1);
  assert.match(xmlOf(noList), /контейнер прокрутки list не появился за время шага/);
  // Обратный случай: прокрутка показывает цель.
  const moves = workspace(scrolling);
  const ok = await run(moves, green({ list: { scrolls: true, item: true } }).broker);
  assert.equal(ok.exitCode, 0, JSON.stringify(ok.failed));
});

test('route открывается после последнего запуска; seed без launch отклоняется', async () => {
  const routed = single(
    [{ launch: true }, { wait: 'submit' }],
    [{ kind: 'visible', element: 'submit' }],
    { app: { scheme: 'app' }, state: { route: '/form/amount', seed: 'preset-a' } },
  );
  const app = green();
  assert.equal((await run(workspace(routed), app.broker)).exitCode, 0);
  const order = app.calls.filter((c) => c.startsWith('launch') || c.startsWith('open'));
  assert.deepEqual(order, ['launch -DevContourSeed preset-a', 'open app://form/amount']);
  // Без запуска в шагах route открывается сразу.
  const noLaunch = single([{ wait: 'submit' }], [{ kind: 'visible', element: 'submit' }], {
    app: { scheme: 'app' },
    state: { route: '/form/amount' },
  });
  const other = green();
  await run(workspace(noLaunch), other.broker);
  assert.equal(
    other.calls.find((c) => c.startsWith('open')),
    'open app://form/amount',
  );
  const seedless = single([{ wait: 'submit' }], [{ kind: 'background' }], {
    state: { seed: 'x' },
  });
  assert.match(JSON.stringify(visualSpecSchema.safeParse(seedless).error?.issues), /добавьте шаг/);
  const seeded = single([{ launch: true }], [{ kind: 'background' }], { state: { seed: 'x' } });
  assert.ok(visualSpecSchema.safeParse(seeded).success);
});

test('Ссылки: каталог наблюдений через symlink наружу отклоняется, подложенный файл не перезаписывается', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'dc-vrun-outside-'));
  const escape = workspace();
  symlinkSync(outside, join(escape, '.reports'));
  await assert.rejects(run(escape, green().broker), /внутри рабочего дерева/);
  assert.equal(existsSync(join(outside, 'visual', 'run.json')), false);
  // Подложенная ссылка с именем наблюдения удаляется, цель ссылки не меняется.
  const planted = workspace();
  mkdirSync(join(planted, '.reports', 'visual'), { recursive: true });
  const victim = join(outside, 'victim.png');
  writeFileSync(victim, 'keep');
  symlinkSync(victim, join(planted, '.reports', 'visual', 'UI-form-focused.png'));
  symlinkSync(victim, join(planted, '.reports', 'visual.xml'));
  assert.equal((await run(planted, green().broker)).exitCode, 0);
  assert.equal(readFileSync(victim, 'utf8'), 'keep');
  assert.ok(
    !lstatSync(join(planted, '.reports', 'visual', 'UI-form-focused.png')).isSymbolicLink(),
  );
  assert.ok(!lstatSync(join(planted, '.reports', 'visual.xml')).isSymbolicLink());
});

test('Анимация клавиатуры: рамки читаются после того, как клавиатура встала', async () => {
  // Без ожидания устойчивого снимка кнопка читалась бы на 150 pt выше, до
  // конца анимации, и visible ложно проходил бы.
  const red = workspace();
  const c = clock();
  const animated = fakeApp({ buttonY: 563, background: noise, log: '', animated: c.now });
  assert.equal((await run(red, animated.broker, c)).exitCode, 1);
  assert.match(xmlOf(red), /закрыто 36 из 56 pt/);
  assert.deepEqual(framesOf(red).keyboard, KEYBOARD);
  // Обратный случай: кнопка после анимации над клавиатурой.
  const fine = workspace();
  const d = clock();
  assert.equal((await run(fine, green({ animated: d.now }).broker, d)).exitCode, 0);
});

test('tap-hits: не больше одного в состоянии', () => {
  const one = single([], [{ kind: 'tap-hits', element: 'a', expect: { visible: 'b' } }]);
  assert.ok(visualSpecSchema.safeParse(one).success);
  const two = single(
    [],
    [
      { kind: 'tap-hits', element: 'a', expect: { visible: 'b' } },
      { kind: 'tap-hits', name: 'second', element: 'c', expect: { visible: 'd' } },
    ],
  );
  assert.match(
    JSON.stringify(visualSpecSchema.safeParse(two).error?.issues),
    /Не больше одного tap-hits/,
  );
});

test('Релиз и Expo Go: спецификация отклоняется до broker, Expo Go от broker — провал', async () => {
  const declared = workspace({ ...spec, host: 'expo-go' });
  const untouched = green({ host: 'expo-go' });
  const result = await run(declared, untouched.broker, { release: true });
  assert.equal(result.exitCode, 1);
  assert.equal(untouched.hellos.length, 0);
  assert.match(xmlOf(declared), /name="accepted">\s*<failure type="assertion"/);
  // Спецификация dev-client, broker сообщил Expo Go: провал, а не окружение.
  const reported = workspace();
  const expo = await run(reported, green({ host: 'expo-go' }).broker, { release: true });
  assert.equal(expo.exitCode, 1);
  assert.match(xmlOf(reported), /name="accepted">\s*<failure type="assertion"/);
  // Без --release та же пара — расхождение хоста, ошибка окружения.
  assert.equal((await run(workspace(), green({ host: 'expo-go' }).broker)).exitCode, 75);
  // Обратный случай: dev-client в релизе проходит.
  assert.equal((await run(workspace(), green().broker, { release: true })).exitCode, 0);
});

test('Неверная спецификация удаляет прежние наблюдения', async () => {
  const cwd = workspace();
  assert.equal((await run(cwd, green().broker)).exitCode, 0);
  assert.ok(existsSync(join(cwd, '.reports', 'visual', 'UI-form-focused.png')));
  writeFileSync(join(cwd, 'contracts', 'ui.json'), '{"version": 2}');
  assert.equal((await run(cwd, green().broker)).exitCode, 1);
  assert.ok(!existsSync(join(cwd, '.reports', 'visual', 'UI-form-focused.png')));
});

test('reach: запись failure — провал продукта, только если совпадает с видом шага', () => {
  const parsed = visualSpecSchema.parse(
    single([{ launch: true }, { type: '12' }], [{ kind: 'background' }]),
  );
  const state = parsed.states[0];
  const unreached = (failure: { step: number; kind: 'type' | 'clear' | 'scroll' }) => ({
    unreached: {
      version: 1 as const,
      state: state.id,
      error: 'x',
      stepTaps: [],
      failure: { ...failure, message: 'текст не принят' },
    },
  });
  const product = evaluateReach(state, unreached({ step: 1, kind: 'type' }));
  assert.equal(product.status, 'failed');
  assert.match(product.message ?? '', /шаг 1 \(type\): текст не принят/);
  // Обратный случай: запись не того вида или шага — нарушение договора, окружение.
  assert.equal(evaluateReach(state, unreached({ step: 1, kind: 'scroll' })).status, 'error');
  assert.equal(evaluateReach(state, unreached({ step: 0, kind: 'type' })).status, 'error');
});

test('Broker по HTTP: перенаправление, слишком большой ответ и не-PNG снимок — сбой окружения', async () => {
  const image = png(4, 4, noise);
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { method } = JSON.parse(body) as { method: string };
      if (method === 'launch') {
        res.writeHead(302, { location: 'http://example.invalid/rpc' });
        res.end();
        return;
      }
      if (method === 'frames') {
        res.setHeader('content-length', String(60 * 1024 * 1024));
        res.end();
        return;
      }
      const png64 = (method === 'screenshot' ? image : Buffer.from('GIF89a')).toString('base64');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ result: { png: png64 } }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const port = (server.address() as { port: number }).port;
    const broker = httpBroker({ port, token: 't' });
    assert.deepEqual(await broker.screenshot(), image);
    await assert.rejects(broker.launch([]), (e) => e instanceof BrokerError);
    await assert.rejects(broker.frames(), /больше/);
    const gif = httpBroker(
      { port, token: 't' },
      {
        fetch: (url, init) =>
          fetch(url, { ...init, body: JSON.stringify({ method: 'gif', params: {} }) }),
      },
    );
    await assert.rejects(gif.screenshot(), /не PNG/);
  } finally {
    server.close();
  }
});

test('Срок прогона: состояния, исчерпавшие бюджеты, всё равно дают JUnit до срока', async () => {
  const waiting = {
    version: 1,
    platform: 'ios',
    defaults: { settleMs: 0, stateTimeoutMs: 60000 },
    log: { forbid: ['is deprecated'] },
    states: ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => ({
      id: `UI-wait-${n}`,
      steps: [{ launch: true }, { wait: 'never-shown' }],
      assert: [{ kind: 'visible', element: 'submit' }],
    })),
  };
  const cwd = workspace(waiting);
  const c = clock();
  const start = c.now();
  const result = await run(cwd, green().broker, { ...c, budgetMs: 100_000 });
  assert.ok(c.now() - start <= 100_000, `прогон занял ${c.now() - start} мс`);
  assert.ok(existsSync(join(cwd, '.reports', 'visual.xml')));
  const xml = xmlOf(cwd);
  // Первое состояние исчерпало свой бюджет: missing, провал продукта.
  assert.match(xml, /UI-wait-a" name="reach">\s*<failure type="assertion"/);
  // Второе урезано сроком прогона: не дефект экрана, а окружение.
  assert.match(
    xml,
    /UI-wait-b" name="reach">\s*<error type="environment" message="[^"]*срок прогона/,
  );
  assert.match(xml, /UI-wait-f" name="reach">\s*<error type="environment"/);
  assert.equal(result.exitCode, 1);
  // Обратный случай: тот же прогон с достаточным сроком — каждое состояние проваливается само.
  const roomy = workspace(waiting);
  await run(roomy, green().broker, { budgetMs: 390_000 });
  assert.equal((xmlOf(roomy).match(/name="reach">\s*<failure type="assertion"/g) ?? []).length, 6);
});

test('Прокрутка: контейнер, появившийся позже, ожидается; missing — только после бюджета', async () => {
  const scrolling = single(
    [{ launch: true }, { scroll: 'list', to: 'far-item', maxSwipes: 3 }],
    [{ kind: 'visible', element: 'submit' }],
  );
  const late = workspace(scrolling);
  const c = clock();
  const app = green({
    list: { scrolls: true, item: true },
    listAfter: { now: c.now, ms: c.now() + 3000 },
  });
  const ok = await run(late, app.broker, c);
  assert.equal(ok.exitCode, 0, JSON.stringify(ok.failed));
  // Обратный случай: контейнер появляется позже бюджета состояния (15 с).
  const tooLate = workspace(scrolling);
  const d = clock();
  const slow = green({
    list: { scrolls: true, item: true },
    listAfter: { now: d.now, ms: d.now() + 20_000 },
  });
  const started = d.now();
  assert.equal((await run(tooLate, slow.broker, d)).exitCode, 1);
  assert.ok(d.now() - started >= 15_000);
  assert.match(xmlOf(tooLate), /контейнер прокрутки list не появился за время шага/);
});

test('Очистка: курсор ставится в конец поля; остаток-суффикс — сбой драйвера', async () => {
  const clearing = single(
    [{ launch: true }, { tap: 'amount-input' }, { type: '13' }, { clear: 'amount-input' }],
    [{ kind: 'visible', element: 'submit' }],
  );
  // Касание центра ставит курсор посередине: без касания у края осталось бы «3».
  const caret = workspace(clearing);
  const result = await run(caret, green({ caretAtTap: true }).broker);
  assert.equal(result.exitCode, 0, JSON.stringify(result.failed));
  // Обратный случай: курсор не двигается после первого касания — остаётся конец текста.
  const stuck = workspace(
    single([{ launch: true }, { clear: 'amount-input' }], [{ kind: 'visible', element: 'submit' }]),
  );
  const env = await run(stuck, green({ caretAtTap: true, caretStuck: true, prefill: '50' }).broker);
  assert.equal(env.exitCode, 75);
  assert.match(xmlOf(stuck), /курсор не встал в конец поля, осталось &quot;0&quot;/);
});

test('Набор: поле без id в фокусе — не «нет фокуса»; текст сверяется с начальным', async () => {
  const typing = single(
    [{ launch: true }, { tap: 'amount-input' }, { type: '13' }],
    [{ kind: 'visible', element: 'submit' }],
  );
  const unnamed = workspace(typing);
  const ok = await run(unnamed, green({ unnamedFocus: true }).broker);
  assert.equal(ok.exitCode, 0, JSON.stringify(ok.failed));
  assert.doesNotMatch(xmlOf(unnamed), /нет поля в фокусе/);
  // Поле с начальным текстом: ожидается «50» + «13».
  const prefilled = workspace(typing);
  assert.equal((await run(prefilled, green({ prefill: '50' }).broker)).exitCode, 0);
  // Обратный случай: курсор в середине — «5130» оканчивается не на набранное начало.
  const middle = workspace(typing);
  assert.equal((await run(middle, green({ prefill: '50', caretAtTap: true }).broker)).exitCode, 1);
  assert.match(xmlOf(middle), /ожидалось &quot;501&quot;/);
});

test('Поле пароля, очищенное при повторном фокусе, принимается и отмечается', async () => {
  const typing = single(
    [{ launch: true }, { tap: 'amount-input' }, { type: 'ab' }],
    [{ kind: 'visible', element: 'submit' }],
  );
  const cwd = workspace(typing);
  const app = green({ secure: true, prefill: 'xyz', clearsOnRefocus: true });
  assert.equal((await run(cwd, app.broker)).exitCode, 0);
  assert.match(
    readFileSync(join(cwd, '.reports', 'visual', 'run.json'), 'utf8'),
    /очищено при наборе/,
  );
  // Обратный случай: обычное поле, стёршее текст, — провал набора.
  const plain = workspace(typing);
  const wiped = green({ prefill: 'xyz', clearsOnRefocus: true });
  assert.equal((await run(plain, wiped.broker)).exitCode, 1);
  assert.match(xmlOf(plain), /ожидалось &quot;xyza&quot;/);
});

test('Каталоги: --out не корень worktree; каталоги вне worktree не создаются', async () => {
  const cwd = workspace();
  await assert.rejects(run(cwd, green().broker, { out: '.' }), /внутри рабочего дерева/);
  // Отчёт в корне worktree допустим.
  assert.equal((await run(cwd, green().broker, { report: 'visual.xml' })).exitCode, 0);
  const outside = mkdtempSync(join(tmpdir(), 'dc-vrun-outside-'));
  const escape = workspace();
  symlinkSync(outside, join(escape, 'link'));
  await assert.rejects(run(escape, green().broker, { out: 'link/a/b' }), /внутри рабочего дерева/);
  assert.equal(existsSync(join(outside, 'a')), false);
});

test('Неустойчивые рамки записываются в run.json', async () => {
  const shaky = workspace();
  await run(shaky, green({ jitter: true }).broker);
  const notes = (
    JSON.parse(readFileSync(join(shaky, '.reports', 'visual', 'run.json'), 'utf8')) as {
      notes: Record<string, string[]>;
    }
  ).notes;
  assert.match(JSON.stringify(notes), /рамки не установились/);
  const calm = workspace();
  await run(calm, green().broker);
  const quiet = (
    JSON.parse(readFileSync(join(calm, '.reports', 'visual', 'run.json'), 'utf8')) as {
      notes: Record<string, string[]>;
    }
  ).notes;
  assert.deepEqual(quiet, {});
});

test('Broker по HTTP: тело chunked без Content-Length ограничено по ходу чтения', async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.write('{"result": {"keyboard": null}, "pad": "');
      let sent = 0;
      const more = () => {
        if (sent >= 20) return res.end('"}');
        sent++;
        res.write('x'.repeat(500));
        setImmediate(more);
      };
      more();
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const port = (server.address() as { port: number }).port;
    await assert.rejects(
      httpBroker({ port, token: 't' }, { responseLimit: 4000 }).keyboardFrame(),
      /больше 4000 байт/,
    );
    // Обратный случай: под пределом ответ читается (и отклоняется только схемой из-за pad).
    await assert.rejects(
      httpBroker({ port, token: 't' }, { responseLimit: 100_000 }).keyboardFrame(),
      /не по договору/,
    );
    // Исчерпанный срок: вызов не начинается.
    await assert.rejects(
      httpBroker({ port, token: 't' }, { remaining: () => 0 }).keyboardFrame(),
      /срок прогона исчерпан/,
    );
  } finally {
    server.close();
  }
});
