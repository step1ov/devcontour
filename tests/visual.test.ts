import { test } from 'node:test';
import assert from 'node:assert/strict';
import { junitSummary } from 'devcontour-harness';
import {
  evaluateBackground,
  evaluateLog,
  evaluateTapHits,
  evaluateVisible,
  evaluateVisual,
  visualFramesSchema,
  visualJunit,
  visualSpecSchema,
  VISUAL_MAX_STATES,
  type VisualAssertion,
  type VisualFrames,
  type VisualFramesInput,
  type VisualImage,
  type VisualTap,
} from '../src/core/visual.ts';

// Вымышленный экран 390×844 pt: кнопка y 563–619, клавиатура y ≥ 583 —
// закрыто 36 из 56 pt. Каждый случай имеет обратный: проверка, которая
// всегда проходит или всегда падает, на одной из пар ошибается.
const window = { x: 0, y: 0, width: 390, height: 844 };
const safeArea = { x: 0, y: 47, width: 390, height: 763 };
const keyboard = { x: 0, y: 583, width: 390, height: 261 };
const frames = (input: Partial<VisualFramesInput> = {}): VisualFrames => {
  const parsed = visualFramesSchema.parse({
    version: 1,
    state: 'UI-form-focused',
    window,
    safeArea,
    keyboard: null,
    elements: {},
    ...input,
  });
  assert.ok('window' in parsed);
  return parsed;
};
const assertion = <K extends VisualAssertion['kind']>(value: unknown) =>
  visualSpecSchema.parse({
    version: 1,
    platform: 'ios-simulator',
    states: [{ id: 'UI-form-focused', assert: [value] }],
  }).states[0].assert[0] as Extract<VisualAssertion, { kind: K }>;

test('visible: кнопка под клавиатурой падает с закрытыми точками, открытая проходит', () => {
  const visible = assertion<'visible'>({ kind: 'visible', element: 'submit' });
  const button = { x: 20, y: 563, width: 350, height: 56 };
  const covered = evaluateVisible(visible, frames({ keyboard, elements: { submit: button } }));
  assert.equal(covered.status, 'failed');
  assert.match(covered.message ?? '', /пересекает клавиатуру y ≥ 583/);
  assert.match(covered.message ?? '', /закрыто 36 из 56 pt/);
  assert.match(covered.message ?? '', /y 583–619/);
  // Обратный случай: та же кнопка над клавиатурой.
  const lifted = { ...button, y: 500 };
  assert.equal(
    evaluateVisible(visible, frames({ keyboard, elements: { submit: lifted } })).status,
    'passed',
  );
  // Без клавиатуры на экране исходная рамка видима.
  assert.equal(evaluateVisible(visible, frames({ elements: { submit: button } })).status, 'passed');
  // notUnder: [] явно отключает проверку клавиатуры.
  const ignore = assertion<'visible'>({ kind: 'visible', element: 'submit', notUnder: [] });
  assert.equal(
    evaluateVisible(ignore, frames({ keyboard, elements: { submit: button } })).status,
    'passed',
  );
});

test('visible: выход за safe area и отсутствие элемента — провал', () => {
  const inset = assertion<'visible'>({ kind: 'visible', element: 'title', inset: 'safe-area' });
  const underNotch = { x: 20, y: 30, width: 200, height: 30 };
  const result = evaluateVisible(inset, frames({ elements: { title: underNotch } }));
  assert.equal(result.status, 'failed');
  assert.match(result.message ?? '', /safe area сверху на 17 pt/);
  assert.equal(
    evaluateVisible(inset, frames({ elements: { title: { ...underNotch, y: 60 } } })).status,
    'passed',
  );
  // Без inset граница — окно, и та же рамка видима.
  const plain = assertion<'visible'>({ kind: 'visible', element: 'title' });
  assert.equal(
    evaluateVisible(plain, frames({ elements: { title: underNotch } })).status,
    'passed',
  );
  assert.match(evaluateVisible(plain, frames()).message ?? '', /не найден/);
});

const tapFrames = (tap: Partial<VisualTap>, extra: Partial<VisualFramesInput> = {}) =>
  frames({
    elements: { submit: { x: 20, y: 563, width: 350, height: 56 } },
    taps: {
      'tap-hits': {
        element: 'submit',
        point: { x: 195, y: 591 },
        hit: 'submit',
        before: { visible: ['submit'], focusedText: '135' },
        after: { visible: ['submit', 'result'], focusedText: '135' },
        ...tap,
      },
    },
    ...extra,
  });

test('tap-hits: касание центра под клавиатурой падает, даже если драйвер сообщил эффект', () => {
  const tapHits = assertion<'tap-hits'>({
    kind: 'tap-hits',
    element: 'submit',
    expect: { visible: 'result' },
  });
  // Обратный случай: без клавиатуры то же касание с эффектом проходит.
  assert.equal(evaluateTapHits(tapHits, tapFrames({})).status, 'passed');
  const under = evaluateTapHits(tapHits, tapFrames({}, { keyboard }));
  assert.equal(under.status, 'failed');
  assert.match(under.message ?? '', /точка касания \(195, 591\) под клавиатурой/);
  // Касание ушло в клавиатуру: эффекта нет, текст поля вырос.
  const typed = evaluateTapHits(
    tapHits,
    tapFrames(
      {
        hit: null,
        after: { visible: ['submit'], focusedText: '1352' },
      },
      { keyboard },
    ),
  );
  assert.equal(typed.status, 'failed');
  assert.match(typed.message ?? '', /result не появился/);
  assert.match(typed.message ?? '', /"135" → "1352"/);
  assert.match(typed.message ?? '', /пустой участок/);
});

test('tap-hits: эффект должен наступить именно после касания', () => {
  const tapHits = assertion<'tap-hits'>({
    kind: 'tap-hits',
    element: 'submit',
    expect: { visible: 'result' },
  });
  const already = evaluateTapHits(
    tapHits,
    tapFrames({ before: { visible: ['submit', 'result'], focusedText: '135' } }),
  );
  assert.equal(already.status, 'failed');
  assert.match(already.message ?? '', /эффект не доказан/);
  const hide = assertion<'tap-hits'>({
    kind: 'tap-hits',
    element: 'submit',
    expect: { hidden: 'sheet' },
  });
  assert.equal(
    evaluateTapHits(
      hide,
      tapFrames({
        before: { visible: ['submit', 'sheet'] },
        after: { visible: ['submit'] },
      }),
    ).status,
    'passed',
  );
  assert.equal(
    evaluateTapHits(
      hide,
      tapFrames({
        before: { visible: ['submit', 'sheet'] },
        after: { visible: ['submit', 'sheet'] },
      }),
    ).status,
    'failed',
  );
});

test('tap-hits: касание не по центру видимой рамки или без записи — ошибка драйвера', () => {
  const tapHits = assertion<'tap-hits'>({
    kind: 'tap-hits',
    element: 'submit',
    expect: { visible: 'result' },
  });
  // Касание фреймворка в незакрытую полоску кнопки — не координатное касание.
  const strip = evaluateTapHits(tapHits, tapFrames({ point: { x: 195, y: 570 } }));
  assert.equal(strip.status, 'error');
  assert.match(strip.message ?? '', /не в центре видимой рамки/);
  const none = evaluateTapHits(tapHits, frames({ elements: { submit: window } }));
  assert.equal(none.status, 'error');
  // Центр считается по рамке, обрезанной окном: часть кнопки за краем экрана.
  const clipped = tapFrames(
    { point: { x: 195, y: 832 } },
    { elements: { submit: { x: 20, y: 820, width: 350, height: 56 } } },
  );
  assert.equal(evaluateTapHits(tapHits, clipped).status, 'passed');
});

const image = (paint: (x: number, y: number) => [number, number, number]): VisualImage => {
  const width = 390,
    height = 844;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      data.set([...paint(x, y), 255], at);
    }
  return { width, height, data };
};
// Детерминированный шум: «фото» без единого доминирующего цвета.
const noise = (x: number, y: number): [number, number, number] => {
  let h = (x * 374761393 + y * 668265263) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return [h & 255, (h >>> 8) & 255, (h >>> 16) & 255];
};
const card = { x: 20, y: 200, width: 350, height: 300 };
const flatWithCard = (x: number, y: number): [number, number, number] =>
  x >= card.x && x < card.x + card.width && y >= card.y && y < card.y + card.height
    ? [255, 255, 255]
    : [242, 242, 242];

test('background: шумное изображение проходит, плоская заливка с карточкой падает', () => {
  const background = assertion<'background'>({ kind: 'background' });
  const photo = evaluateBackground(background, frames(), image(noise));
  assert.equal(photo.status, 'passed');
  assert.ok((photo.flatShare ?? 1) < 0.05);
  const flat = evaluateBackground(background, frames(), image(flatWithCard));
  assert.equal(flat.status, 'failed');
  assert.match(flat.message ?? '', /#F0F0F0/);
  assert.equal(flat.flatShare, 1);
  // Гладкий градиент тоже не плоский.
  const gradient = image((x, y) => [Math.floor((x * 255) / 389), Math.floor((y * 255) / 843), 90]);
  assert.equal(evaluateBackground(background, frames(), gradient).status, 'passed');
});

test('background: порог настраивается, поверхности исключаются из области', () => {
  // Верхние 40% окна — заливка, остальное — шум.
  const half = image((x, y) => (y < 0.4 * 844 ? [242, 242, 242] : noise(x, y)));
  const region = { x: 0, y: 0, width: 1, height: 1 };
  const strict = assertion<'background'>({ kind: 'background', region });
  assert.equal(evaluateBackground(strict, frames(), half).status, 'passed');
  const tight = assertion<'background'>({ kind: 'background', region, maxFlatShare: 0.3 });
  assert.equal(evaluateBackground(tight, frames(), half).status, 'failed');
  // Карточка поверх шума: без исключения она доминирует, с исключением — нет.
  const cardOnPhoto = image((x, y) =>
    x >= 0 && y >= 100 && y < 700 ? [255, 255, 255] : noise(x, y),
  );
  const surface = { x: 0, y: 100, width: 390, height: 600 };
  const withCard = frames({ elements: { card: surface } });
  assert.equal(
    evaluateBackground(assertion({ kind: 'background' }), withCard, cardOnPhoto).status,
    'failed',
  );
  assert.equal(
    evaluateBackground(assertion({ kind: 'background', surfaces: ['card'] }), withCard, cardOnPhoto)
      .status,
    'passed',
  );
  const missing = evaluateBackground(
    assertion({ kind: 'background', surfaces: ['card'] }),
    frames(),
    cardOnPhoto,
  );
  assert.match(missing.message ?? '', /поверхность card не найдена/);
  // Снимок не того размера — ошибка окружения, а не оценка фона.
  const small = { width: 10, height: 10, data: new Uint8Array(400) };
  assert.equal(evaluateBackground(strict, frames(), small).status, 'error');
});

test('log-forbid: запрещённая строка падает, разрешённая явно и чистый журнал проходят', () => {
  const log = visualSpecSchema.parse({
    version: 1,
    platform: 'ios-simulator',
    log: {
      forbid: ['deprecated', '^WARN\\b'],
      allow: [{ pattern: 'Require cycle', reason: 'известный долг' }],
    },
    states: [{ id: 'UI-form-empty', assert: [{ kind: 'visible', element: 'a' }] }],
  }).log!;
  const dirty = evaluateLog(log, ['bundle ok', 'Warning: legacyHelper is Deprecated, use next']);
  assert.equal(dirty.status, 'failed');
  assert.match(dirty.message ?? '', /запрещённых строк журнала: 1/);
  assert.match(dirty.message ?? '', /legacyHelper/);
  assert.equal(evaluateLog(log, ['bundle ok', 'render 12 ms']).status, 'passed');
  assert.equal(evaluateLog(log, ['WARN Require cycle: a -> b -> a']).status, 'passed');
  assert.equal(evaluateLog(log, ['WARN slow frame']).status, 'failed');
});

test('Спецификация строгая: формат id, пределы состояний, бюджет и лишние поля', () => {
  const base = {
    version: 1,
    platform: 'ios-simulator',
    states: [{ id: 'UI-form-empty', assert: [{ kind: 'visible', element: 'a' }] }],
  };
  assert.ok(visualSpecSchema.safeParse(base).success);
  const fails = (value: unknown) => assert.equal(visualSpecSchema.safeParse(value).success, false);
  fails({ ...base, extra: true });
  fails({ ...base, states: [] });
  fails({ ...base, states: [{ id: 'form-empty', assert: [{ kind: 'visible', element: 'a' }] }] });
  fails({ ...base, states: [{ id: 'UI-form', assert: [{ kind: 'visible', element: 'a' }] }] });
  fails({ ...base, states: [{ id: 'UI-form-empty', assert: [] }] });
  fails({
    ...base,
    states: [{ id: 'UI-form-empty', steps: [{ click: 'a' }], assert: base.states[0].assert }],
  });
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `UI-s-${i}`, assert: base.states[0].assert }));
  assert.ok(visualSpecSchema.safeParse({ ...base, states: many(VISUAL_MAX_STATES) }).success);
  fails({ ...base, states: many(VISUAL_MAX_STATES + 1) });
  fails({ ...base, states: [base.states[0], base.states[0]] });
  // Два утверждения одного вида в состоянии различаются только явным name.
  const twice = [
    { kind: 'visible', element: 'a' },
    { kind: 'visible', element: 'b' },
  ];
  fails({ ...base, states: [{ id: 'UI-form-empty', assert: twice }] });
  assert.ok(
    visualSpecSchema.safeParse({
      ...base,
      states: [{ id: 'UI-form-empty', assert: [twice[0], { ...twice[1], name: 'visible-b' }] }],
    }).success,
  );
  // Сумма бюджетов состояний ограничена временем gate.
  fails({
    ...base,
    defaults: { stateTimeoutMs: 60_000 },
    states: many(8),
  });
  fails({ ...base, defaults: { stateTimeoutMs: 120_000 } });
  // Для web клавиатуры нет.
  fails({
    ...base,
    platform: 'web',
    states: [
      { id: 'UI-form-empty', assert: [{ kind: 'visible', element: 'a', notUnder: ['keyboard'] }] },
    ],
  });
  fails({ ...base, log: { forbid: ['('] } });
  const steps = [{ launch: true }, { tap: 'field' }, { type: '135' }, { wait: 'result' }];
  assert.ok(
    visualSpecSchema.safeParse({ ...base, states: [{ ...base.states[0], steps }] }).success,
  );
});

test('JUnit: testcase на каждое утверждение, ошибка окружения — error, пустой прогон — провал', () => {
  const spec = visualSpecSchema.parse({
    version: 1,
    platform: 'ios-simulator',
    log: { forbid: ['deprecated'] },
    states: [
      {
        id: 'UI-form-focused',
        assert: [{ kind: 'visible', element: 'submit' }, { kind: 'background' }],
      },
      { id: 'UI-form-result', assert: [{ kind: 'visible', element: 'result' }] },
    ],
  });
  const cases = evaluateVisual(
    spec,
    {
      'UI-form-focused': {
        frames: frames({
          keyboard,
          elements: { submit: { x: 20, y: 563, width: 350, height: 56 } },
        }),
        screenshot: image(noise),
      },
    },
    ['all <good> & "fine"'],
  );
  const xml = visualJunit(cases);
  const summary = junitSummary(xml);
  assert.deepEqual(
    summary.cases.map((c) => [c.id, c.status]),
    [
      ['visual.UI-form-focused.visible', 'failed'],
      ['visual.UI-form-focused.background', 'passed'],
      ['visual.UI-form-result.visible', 'failed'],
      ['visual.log.no-forbidden', 'passed'],
    ],
  );
  assert.equal(summary.skipped, 0);
  assert.match(xml, /<failure type="assertion"/);
  // Состояние без наблюдений — ошибка окружения, не пропуск и не исчезновение.
  assert.match(
    xml,
    /<error type="environment" message="драйвер не записал наблюдения состояния UI-form-result"/,
  );
  assert.match(xml, /tests="4" failures="1" errors="1" skipped="0"/);
  assert.doesNotMatch(xml, /<skipped/);
  // Пустой прогон — провал.
  const empty = junitSummary(visualJunit([]));
  assert.deepEqual(
    empty.cases.map((c) => [c.id, c.status]),
    [['visual.run.empty', 'failed']],
  );
  // Разметка в сообщениях экранируется.
  const escaped = visualJunit([
    { classname: 'visual.UI-a-b', name: 'visible', status: 'failed', message: 'a <b> & "c"\nd' },
  ]);
  assert.equal(junitSummary(escaped).failedDetails[0], 'visual.UI-a-b.visible: a <b> & "c"');
});
