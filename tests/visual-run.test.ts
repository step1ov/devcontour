import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { junitSummary } from 'devcontour-harness';
import { visualSpecSchema } from '../src/core/visual.ts';
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
}) {
  let text = '';
  let focused = false;
  let result = false;
  let launched = false;
  let log = '';
  const calls: string[] = [];
  const button = { x: 26, y: options.buttonY, width: 350, height: 56 };
  const input = { x: 26, y: 300, width: 350, height: 44 };
  const keyboard = (): BrokerRect | null => (focused ? KEYBOARD : null);
  const within = (r: BrokerRect, x: number, y: number) =>
    x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
  const sync: Sync<VisualBroker> = {
    hello: () => ({
      protocol: 1 as const,
      platform: 'ios' as const,
      host: options.host ?? 'dev-client',
      device: { udid: 'SIM-1', model: 'iPhone 16 Pro', runtime: 'iOS 18.5' },
    }),
    frames: (): BrokerFrames => {
      calls.push('frames');
      const elements: Record<string, BrokerRect> = launched
        ? {
            'form-screen': WINDOW,
            'amount-input': input,
            submit: button,
            ...(result ? { result: { x: 26, y: 120, width: 350, height: 40 } } : {}),
          }
        : {};
      return {
        window: WINDOW,
        safeArea: SAFE,
        elements,
        focused: focused ? { element: 'amount-input', text } : null,
      };
    },
    keyboardFrame: () => keyboard(),
    tapPoint: (x, y) => {
      calls.push(`tap ${x},${y}`);
      const kb = keyboard();
      if (kb && within(kb, x, y)) text += '2';
      else if (within(input, x, y)) focused = true;
      else if (within(button, x, y)) {
        result = true;
        focused = false;
      }
    },
    typeText: (value) => {
      calls.push(`type ${JSON.stringify(value)}`);
      for (const ch of value) text = ch === '\b' ? text.slice(0, -1) : text + ch;
    },
    drag: () => undefined,
    screenshot: () => png(WINDOW.width, WINDOW.height, options.background),
    launch: () => {
      calls.push('launch');
      launched = true;
      log += 'bundle ok\n' + options.log;
    },
    openURL: () => undefined,
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
  return { broker, calls };
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

function workspace() {
  const cwd = mkdtempSync(join(tmpdir(), 'dc-vrun-'));
  mkdirSync(join(cwd, 'contracts'));
  writeFileSync(join(cwd, 'contracts', 'ui.json'), JSON.stringify(spec));
  return cwd;
}
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
    /name="accepted">\s*<error type="environment" message="broker запускает приложение в expo-go/,
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
