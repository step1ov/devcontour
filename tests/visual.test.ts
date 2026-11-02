import { test } from 'node:test';
import assert from 'node:assert/strict';
import { junitSummary } from 'devcontour-harness';
import {
  evaluateBackground,
  evaluateLog,
  evaluateTapHits,
  evaluateVisible,
  evaluateVisual,
  visualFramesErrorSchema,
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
  const ignore = assertion<'visible'>({
    kind: 'visible',
    element: 'submit',
    notUnder: [],
    reason: 'экран без поля ввода',
  });
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

const field = (text: string) => ({ element: 'amount', text });
const tapFrames = (tap: Partial<VisualTap>, extra: Partial<VisualFramesInput> = {}) =>
  frames({
    elements: { submit: { x: 20, y: 563, width: 350, height: 56 } },
    taps: {
      'tap-hits': {
        element: 'submit',
        point: { x: 195, y: 591 },
        hit: { kind: 'element', element: 'submit' },
        before: { visible: ['submit'], focused: field('135') },
        after: { visible: ['submit', 'result'], focused: field('135') },
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
        hit: { kind: 'keyboard' },
        after: { visible: ['submit'], focused: field('1352') },
      },
      { keyboard },
    ),
  );
  assert.equal(typed.status, 'failed');
  assert.match(typed.message ?? '', /result не появился/);
  assert.match(typed.message ?? '', /"135" → "1352"/);
  assert.match(typed.message ?? '', /касание принял клавиатура/);
});

test('tap-hits: эффект должен наступить именно после касания', () => {
  const tapHits = assertion<'tap-hits'>({
    kind: 'tap-hits',
    element: 'submit',
    expect: { visible: 'result' },
  });
  const already = evaluateTapHits(
    tapHits,
    tapFrames({ before: { visible: ['submit', 'result'], focused: field('135') } }),
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
        before: { visible: ['submit', 'sheet'], focused: null },
        after: { visible: ['submit'], focused: null },
      }),
    ).status,
    'passed',
  );
  assert.equal(
    evaluateTapHits(
      hide,
      tapFrames({
        before: { visible: ['submit', 'sheet'], focused: null },
        after: { visible: ['submit', 'sheet'], focused: null },
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
      ['visual.UI-form-focused.reach', 'passed'],
      ['visual.UI-form-focused.visible', 'failed'],
      ['visual.UI-form-focused.background', 'passed'],
      ['visual.UI-form-result.reach', 'failed'],
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
  assert.match(xml, /tests="6" failures="1" errors="2" skipped="0"/);
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

const specWith = (
  extra: Record<string, unknown>,
  assert: Record<string, unknown>[] = [{ kind: 'visible', element: 'a' }],
) =>
  visualSpecSchema.safeParse({
    version: 1,
    platform: 'ios-simulator',
    states: [{ id: 'UI-form-empty', assert }],
    ...extra,
  }).success;

test('Шаблоны журнала: без групп, квантификаторов и обратных ссылок; проверка линейна', () => {
  for (const bad of ['(a+)+b', '.*deprecated', 'a{2,}', 'x?', '(a)\\1', '(?=x)', '(?:a|b)c'])
    assert.equal(specWith({ log: { forbid: [bad] } }), false, bad);
  for (const good of ['deprecated', '^WARN\\b', 'deprecated|obsolete', '[*+?]', 'a\\.b'])
    assert.equal(specWith({ log: { forbid: [good] } }), true, good);
  const log = visualSpecSchema.parse({
    version: 1,
    platform: 'ios-simulator',
    log: { forbid: ['deprecated', '^WARN\\b', 'warning: [a-z]'] },
    states: [{ id: 'UI-form-empty', assert: [{ kind: 'visible', element: 'a' }] }],
  }).log!;
  const long = 'a'.repeat(2 * 1024 * 1024);
  const started = performance.now();
  assert.equal(evaluateLog(log, [long]).status, 'passed');
  assert.equal(evaluateLog(log, [long + ' deprecated']).status, 'failed');
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1000, `две строки по 2 МБ проверялись ${Math.round(elapsed)} мс`);
});

test('Пустые утверждения отклоняются: порог 1, всеразрешающий allow, notUnder [] без причины', () => {
  const background = (maxFlatShare: number) => [{ kind: 'background', maxFlatShare }];
  assert.equal(specWith({}, background(0.9)), true);
  assert.equal(specWith({}, background(1)), false);
  const allow = (pattern: string, forbid = ['deprecated', '^WARN\\b']) =>
    specWith({ log: { forbid, allow: [{ pattern, reason: 'известный долг' }] } });
  assert.equal(allow('Require cycle'), true);
  assert.equal(allow('WARN Require cycle'), true);
  for (const vacuous of ['.', '^', 'a|', 'deprecated', 'WARN', 'e', '\\d', 'o'])
    assert.equal(allow(vacuous), false, vacuous);
  assert.equal(specWith({}, [{ kind: 'visible', element: 'a', notUnder: [] }]), false);
  assert.equal(
    specWith({}, [{ kind: 'visible', element: 'a', notUnder: [], reason: 'нет поля ввода' }]),
    true,
  );
});

test('tap-hits: hit обязателен; смена фокуса после отправки — не провал', () => {
  const tapHits = assertion<'tap-hits'>({
    kind: 'tap-hits',
    element: 'submit',
    expect: { visible: 'result' },
  });
  const tap = {
    element: 'submit',
    point: { x: 195, y: 591 },
    before: { visible: ['submit'], focused: field('135') },
    after: { visible: ['submit', 'result'], focused: null },
  };
  const parse = (record: Record<string, unknown>) =>
    visualFramesSchema.safeParse({
      version: 1,
      state: 'UI-form-focused',
      window,
      safeArea,
      keyboard: null,
      elements: {},
      taps: { 'tap-hits': record },
    }).success;
  assert.equal(parse(tap), false);
  assert.equal(parse({ ...tap, hit: { kind: 'none' } }), true);
  // Клавиатура называется явно, а не id элемента.
  assert.equal(parse({ ...tap, hit: 'keyboard' }), false);
  const submitHit = { kind: 'element', element: 'submit' } as const;
  // Поле потеряло фокус после отправки: текст не сравнивается.
  assert.equal(evaluateTapHits(tapHits, tapFrames({ ...tap, hit: submitHit })).status, 'passed');
  // Фокус перешёл на другое поле — тоже не изменение текста исходного поля.
  const moved = {
    ...tap,
    hit: submitHit,
    after: { ...tap.after, focused: { element: 'note', text: '' } },
  };
  assert.equal(evaluateTapHits(tapHits, tapFrames(moved)).status, 'passed');
  // То же поле в фокусе с другим текстом — провал.
  const typed = { ...tap, hit: submitHit, after: { ...tap.after, focused: field('1352') } };
  assert.match(evaluateTapHits(tapHits, tapFrames(typed)).message ?? '', /"135" → "1352"/);
});

test('Граница клавиатуры: касание края — под клавиатурой, допуск рамки 0.5 pt', () => {
  const visible = assertion<'visible'>({ kind: 'visible', element: 'submit' });
  const at = (bottom: number) =>
    evaluateVisible(
      visible,
      frames({ keyboard, elements: { submit: { x: 20, y: bottom - 56, width: 350, height: 56 } } }),
    ).status;
  assert.equal(at(583), 'passed');
  assert.equal(at(583.4), 'passed');
  assert.equal(at(583.6), 'failed');
  const tapHits = assertion<'tap-hits'>({
    kind: 'tap-hits',
    element: 'submit',
    expect: { visible: 'result' },
  });
  // Центр кнопки y 555–611 — ровно на верхнем крае клавиатуры.
  const edge = (keyboardY: number) =>
    evaluateTapHits(
      tapHits,
      tapFrames(
        { point: { x: 195, y: 583 } },
        {
          keyboard: { ...keyboard, y: keyboardY },
          elements: { submit: { x: 20, y: 555, width: 350, height: 56 } },
        },
      ),
    );
  assert.match(edge(583).message ?? '', /под клавиатурой/);
  assert.equal(edge(584).status, 'passed');
});

test('background: клавиатура не считается фоном приложения', () => {
  // Шум над клавиатурой, плоская серая клавиатура занимает большую часть safe area.
  const shot = image((x, y) => (y >= 300 ? [210, 213, 219] : noise(x, y)));
  const background = assertion<'background'>({ kind: 'background' });
  const low = { x: 0, y: 300, width: 390, height: 544 };
  assert.equal(evaluateBackground(background, frames({ keyboard: low }), shot).status, 'passed');
  assert.equal(evaluateBackground(background, frames(), shot).status, 'failed');
});

test('log-forbid: пустой журнал — ошибка окружения, а не чистый журнал', () => {
  const log = visualSpecSchema.parse({
    version: 1,
    platform: 'ios-simulator',
    log: { forbid: ['deprecated'] },
    states: [{ id: 'UI-form-empty', assert: [{ kind: 'visible', element: 'a' }] }],
  }).log!;
  assert.equal(evaluateLog(log, []).status, 'error');
  assert.equal(evaluateLog(log, ['', '  ']).status, 'error');
  assert.equal(evaluateLog(log, ['app started']).status, 'passed');
});

test('Разрешения журнала: обходы запрета отклоняются, конкретное разрешение принимается', () => {
  const allow = (forbid: string[], pattern: string) =>
    specWith({ log: { forbid, allow: [{ pattern, reason: 'известный долг' }] } });
  const rejected: [string[], string][] = [
    [['deprecated'], ':'],
    [['deprecated'], 'warn'],
    [['deprecated'], 'is'],
    [['^WARN\\b'], 'WARN '],
    [['deprecat[a-z]'], 'deprecated'],
    [['foo|bar'], '^bar'],
    [['foo|bar'], 'bar'],
    // Альтернатива разрешения проверяется отдельно: конкретная часть не прикрывает общую.
    [['deprecated'], 'Require cycle|:'],
    [['deprecat[a-z]'], 'deprecation:'],
    [['warning: [a-z]'], 'warning: x'],
    // Свой текст есть, но разрешение покрывает любую строку запрета — пример строки ловит.
    [['Warning: helper deprecated soon'], 'helper deprecated'],
    [['Warning: [0-9] deprecated'], 'Warning: \\d deprecated'],
  ];
  for (const [forbid, pattern] of rejected)
    assert.equal(allow(forbid, pattern), false, `${forbid.join(',')} + ${pattern}`);
  const accepted: [string[], string][] = [
    [['deprecated', '^WARN\\b'], 'WARN Require cycle'],
    [['deprecated'], 'Require cycle'],
    [['deprecat[a-z]'], 'legacyHelper is deprecated'],
    [['foo|bar'], 'bar in vendor bundle'],
  ];
  for (const [forbid, pattern] of accepted)
    assert.equal(allow(forbid, pattern), true, `${forbid.join(',')} + ${pattern}`);
});

test('log-forbid: число строк, пропущенных каждым разрешением, попадает в system-out', () => {
  const spec = visualSpecSchema.parse({
    version: 1,
    platform: 'ios-simulator',
    log: {
      forbid: ['deprecated|obsolete', '^WARN\\b'],
      allow: [{ pattern: 'WARN Require cycle', reason: 'известный долг' }],
    },
    states: [{ id: 'UI-form-empty', assert: [{ kind: 'visible', element: 'a' }] }],
  });
  const lines = ['app started', 'WARN Require cycle: a -> b', 'WARN Require cycle: c -> d'];
  const clean = evaluateLog(spec.log!, lines);
  assert.equal(clean.status, 'passed');
  assert.match(clean.output ?? '', /"WARN Require cycle" \(известный долг\): пропущено строк 2/);
  const dirty = evaluateLog(spec.log!, [...lines, 'helper is obsolete']);
  assert.equal(dirty.status, 'failed');
  assert.match(dirty.output ?? '', /пропущено строк 2/);
  const xml = visualJunit(
    evaluateVisual(
      spec,
      { 'UI-form-empty': { frames: frames({ elements: { a: window } }) } },
      lines,
    ),
  );
  assert.match(xml, /<system-out>проверено строк журнала: 3\n.*пропущено строк 2<\/system-out>/);
  assert.equal(junitSummary(xml).failures, 0);
});

// Состояние с вводом и отправкой: шаг 2 касается кнопки отправки.
const reachSpec = visualSpecSchema.parse({
  version: 1,
  platform: 'ios-simulator',
  states: [
    {
      id: 'UI-form-sent',
      steps: [
        { tap: 'amount' },
        { type: '57,5' },
        { tap: 'submit' },
        { tap: { prefix: 'row-', index: 0 } },
        { wait: 'result' },
      ],
      assert: [{ kind: 'visible', element: 'result' }],
    },
  ],
});
const stepTap = (extra: Record<string, unknown> = {}) => ({
  step: 2,
  element: 'submit',
  frame: { x: 20, y: 563, width: 350, height: 56 },
  window,
  keyboard: null,
  point: { x: 195, y: 591 },
  hit: { kind: 'element', element: 'submit' },
  before: { visible: ['submit'], focused: field('57,5') },
  after: { visible: ['submit', 'result'], focused: null },
  ...extra,
});
const unreached = (stepTaps: unknown[]) =>
  evaluateVisual(reachSpec, {
    'UI-form-sent': {
      unreached: visualFramesErrorSchema.parse({
        version: 1,
        state: 'UI-form-sent',
        error: 'step wait result: not shown within 5 s',
        stepTaps,
      }),
    },
  });

test('reach: шаг, заблокированный клавиатурой, — провал продукта с доказательством касания', () => {
  const blocked = unreached([
    stepTap({
      keyboard,
      hit: { kind: 'keyboard' },
      after: { visible: ['submit'], focused: field('57,55') },
    }),
  ]);
  assert.deepEqual(
    blocked.map((c) => [c.name, c.status]),
    [
      ['reach', 'failed'],
      ['visible', 'failed'],
    ],
  );
  const message = blocked[0].message ?? '';
  assert.match(message, /состояние не достигнуто/);
  assert.match(message, /шаг 2 submit: точка касания \(195, 591\) под клавиатурой y ≥ 583/);
  assert.match(message, /касание принял клавиатура/);
  assert.match(message, /"57,5" → "57,55"/);
  assert.match(blocked[1].message ?? '', /см\. visual\.UI-form-sent\.reach/);
  // Обратный случай: касание шага в порядке, драйвер не дождался — окружение.
  const driver = unreached([stepTap()]);
  assert.deepEqual(
    driver.map((c) => [c.name, c.status]),
    [
      ['reach', 'error'],
      ['visible', 'error'],
    ],
  );
  assert.match(driver[0].message ?? '', /драйвер: step wait result/);
});

test('reach: запись касания сверяется со спецификацией и договором координат', () => {
  // Селектор по префиксу: подходит id с префиксом, другой id — ошибка записи.
  const row = stepTap({
    step: 3,
    element: 'row-7f3a',
    hit: { kind: 'element', element: 'row-7f3a' },
    before: { visible: [], focused: null },
    after: { visible: [], focused: null },
  });
  assert.equal(unreached([row])[0].status, 'error');
  assert.match(unreached([row])[0].message ?? '', /^драйвер:/);
  const wrong = unreached([
    { ...row, element: 'col-1', hit: { kind: 'element', element: 'col-1' } },
  ]);
  assert.match(wrong[0].message ?? '', /не соответствует шагу спецификации/);
  assert.match(unreached([stepTap({ step: 1 })])[0].message ?? '', /не соответствует/);
  // Касание фреймворка в незакрытую полоску — нарушение договора драйвером.
  const strip = unreached([stepTap({ keyboard, point: { x: 195, y: 570 } })]);
  assert.equal(strip[0].status, 'error');
  assert.match(strip[0].message ?? '', /не в центре видимой рамки/);
  // Достигнутое состояние с чистыми касаниями шагов — reach проходит,
  // с заблокированным шагом — падает, утверждения оцениваются как обычно.
  const reached = (taps: unknown[]) =>
    evaluateVisual(reachSpec, {
      'UI-form-sent': {
        frames: frames({
          elements: { result: window },
          stepTaps: taps,
        } as Partial<VisualFramesInput>),
      },
    }).map((c) => [c.name, c.status]);
  assert.deepEqual(reached([stepTap()]), [
    ['reach', 'passed'],
    ['visible', 'passed'],
  ]);
  assert.deepEqual(reached([stepTap({ hit: { kind: 'none' } })]), [
    ['reach', 'failed'],
    ['visible', 'passed'],
  ]);
});

test('Шаги: scroll, clear и селектор по префиксу строгие; имя reach занято', () => {
  const steps = (value: unknown[]) =>
    visualSpecSchema.safeParse({
      version: 1,
      platform: 'ios-simulator',
      states: [{ id: 'UI-form-empty', steps: value, assert: [{ kind: 'visible', element: 'a' }] }],
    }).success;
  assert.ok(
    steps([
      { clear: 'amount' },
      { scroll: 'list', to: 'end' },
      { scroll: 'list', to: { prefix: 'row-', index: 3 }, maxSwipes: 5 },
      { tap: { prefix: 'item-add-', index: 0 } },
      { wait: { prefix: 'row-', index: 49 } },
    ]),
  );
  assert.equal(steps([{ scroll: 'list' }]), false);
  assert.equal(steps([{ scroll: 'list', to: 'top of list' }]), false);
  assert.equal(steps([{ scroll: 'list', to: 'end', maxSwipes: 21 }]), false);
  assert.equal(steps([{ tap: { prefix: 'r', index: 0 } }]), false);
  assert.equal(steps([{ tap: { prefix: 'row-', index: 50 } }]), false);
  assert.equal(steps([{ tap: { prefix: 'row-' } }]), false);
  assert.equal(steps([{ tap: { prefix: 'row-', index: 0, extra: 1 } }]), false);
  assert.equal(steps([{ clear: 'amount', type: 'x' }]), false);
  assert.equal(specWith({}, [{ kind: 'visible', element: 'a', name: 'reach' }]), false);
});

test('background: доля и цвета пишутся в system-out и при зелёном результате', () => {
  const spec = visualSpecSchema.parse({
    version: 1,
    platform: 'ios-simulator',
    states: [{ id: 'UI-form-empty', assert: [{ kind: 'background' }] }],
  });
  const run = (paint: (x: number, y: number) => [number, number, number]) =>
    visualJunit(
      evaluateVisual(spec, { 'UI-form-empty': { frames: frames(), screenshot: image(paint) } }),
    );
  const green = run(noise);
  assert.equal(junitSummary(green).failures, 0);
  assert.match(green, /<system-out>flatShare 0\.0\d\d \(порог 0\.5\), точек 9216, цвета: #/);
  assert.match(run(flatWithCard), /<system-out>flatShare 1\.000/);
});

test('log: окна журнала по состояниям называют состояние запрещённой строки', () => {
  const spec = visualSpecSchema.parse({
    version: 1,
    platform: 'ios-simulator',
    log: { forbid: ['deprecated'] },
    states: [
      { id: 'UI-form-empty', assert: [{ kind: 'visible', element: 'a' }] },
      { id: 'UI-form-sent', assert: [{ kind: 'visible', element: 'a' }] },
    ],
  });
  const lines = ['app started', 'helper is deprecated', 'sent', 'late deprecated'];
  const offsets = [0, 12, 33, 38];
  const at = (from: number, to: number) => frames({ elements: { a: window }, log: { from, to } });
  const result = evaluateVisual(
    spec,
    { 'UI-form-empty': { frames: at(0, 12) }, 'UI-form-sent': { frames: at(12, 38) } },
    { lines, offsets },
  );
  const log = result.find((c) => c.classname === 'visual.log');
  assert.equal(log?.status, 'failed');
  assert.match(log?.message ?? '', /\[UI-form-sent\] helper is deprecated/);
  assert.match(log?.message ?? '', /\[вне окон состояний\] late deprecated/);
  // Без окон строки не приписываются состояниям.
  const plain = evaluateVisual(
    spec,
    { 'UI-form-empty': { frames: frames({ elements: { a: window } }) } },
    { lines, offsets },
  ).find((c) => c.classname === 'visual.log');
  assert.doesNotMatch(plain?.message ?? '', /\[UI-/);
  assert.equal(
    visualFramesSchema.safeParse({ ...at(0, 1), log: { from: 5, to: 1 } }).success,
    false,
  );
});
