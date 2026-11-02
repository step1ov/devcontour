import { z } from 'zod';

/**
 * Визуальная приёмка: формат спецификации состояний интерфейса и проверки
 * над записанными наблюдениями.
 *
 * Продукт объявляет, какие состояния экрана существуют и что в них должно
 * выполняться; как состояние достигается, измеряется и оценивается, решает
 * DevContour. Поэтому проверки здесь — чистые функции над наблюдениями
 * драйвера (рамки элементов, клавиатура, снимок экрана, журнал), а не код
 * продукта: исполнитель не может ослабить проверку собственной работы.
 *
 * Каждое утверждение даёт ровно один testcase `visual.<stateId>.<name>`.
 * Сбой драйвера или окружения — `<error type="environment">`, никогда не
 * пропуск; пустой прогон — провал.
 */

/** Предел состояний в одной спецификации: время прогона растёт с каждым. */
export const VISUAL_MAX_STATES = 12;
/** Бюджет одного состояния по умолчанию и его верхняя граница. */
export const VISUAL_STATE_TIMEOUT_MS = 15_000;
export const VISUAL_STATE_TIMEOUT_MAX_MS = 60_000;
/** Сумма бюджетов состояний не больше времени gate. */
export const VISUAL_RUN_BUDGET_MS = 420_000;
/** Порог доли «плоских» цветов фона по умолчанию. */
export const VISUAL_MAX_FLAT_SHARE = 0.5;

const finite = z.number().finite();
const size = z.number().finite().nonnegative();
/** testID / accessibility identifier элемента. */
export const visualElementId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, 'id элемента без пробелов, до 128 символов');
/** Стабильный id состояния: `UI-<экран>-<состояние>`. */
export const visualStateId = z
  .string()
  .max(80)
  .regex(/^UI-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/, 'id состояния вида UI-<экран>-<состояние>');
const assertionName = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,47}$/, 'имя утверждения: строчные латинские буквы, цифры и дефис');
/**
 * Шаблоны журнала — регулярные выражения без групп, квантификаторов,
 * обратных ссылок и lookaround; альтернативы `|` — только на верхнем уровне.
 * Каждая альтернатива тогда — последовательность фиксированной длины, и
 * проверка строки линейна по её длине: шаблон спецификации не может сделать
 * gate медленным (`.*x` на строке в 200 000 символов шёл бы минуту), а строки
 * журнала не обрезаются и читаются целиком.
 */
export function logPatternProblem(value: string): string | undefined {
  let inClass = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\') {
      const next = value[i + 1] ?? '';
      if (/[1-9k]/.test(next)) return 'обратные ссылки не поддерживаются';
      if (/[pPu]/.test(next)) return 'escape \\p и \\u не поддерживаются';
      i++;
    } else if (inClass) inClass = c !== ']';
    else if (c === '[') {
      inClass = true;
    } else if (c === '(' || c === ')')
      return 'группы не поддерживаются: альтернативы — через | на верхнем уровне';
    else if ('*+?{'.includes(c)) return 'квантификаторы не поддерживаются';
  }
  try {
    new RegExp(value, 'i');
  } catch {
    return 'некорректное регулярное выражение';
  }
  return undefined;
}
const pattern = z
  .string()
  .min(1)
  .max(200)
  .superRefine((value, context) => {
    const problem = logPatternProblem(value);
    if (problem) context.addIssue({ code: 'custom', message: problem });
  });
/** Строки, которые разрешающий шаблон не должен покрывать: иначе он разрешает всё. */
const NEUTRAL_LINES = ['', ' ', 'a', 'ok', '0'];
/** Текст запрещающего шаблона без якорей и escape — пример строки, которую он ловит. */
const forbiddenSample = (value: string) =>
  value.replace(/\\[bB]|[$^]/g, '').replace(/\\(.)/g, '$1');
const timeout = z.number().int().min(100).max(VISUAL_STATE_TIMEOUT_MAX_MS);

/**
 * Закрытый словарь шагов. `tap` — всегда касание по координате центра
 * видимой рамки элемента, а не касание элемента средствами фреймворка: точка
 * фреймворка может попасть в незакрытую полоску кнопки, которую пользователь
 * не видит.
 */
const step = z.union([
  z.strictObject({ launch: z.literal(true) }),
  z.strictObject({ tap: visualElementId }),
  z.strictObject({ type: z.string().min(1).max(500) }),
  z.strictObject({ wait: visualElementId, timeoutMs: timeout.optional() }),
]);
export type VisualStep = z.infer<typeof step>;

const normalized = z.number().finite().min(0).max(1);
const region = z.union([
  z.literal('content'),
  z
    .strictObject({ x: normalized, y: normalized, width: normalized, height: normalized })
    .refine((r) => r.x + r.width <= 1 && r.y + r.height <= 1 && r.width > 0 && r.height > 0, {
      message: 'область в долях окна: x + width ≤ 1, y + height ≤ 1, ненулевой размер',
    }),
]);

const assertion = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('visible'),
    name: assertionName.optional(),
    element: visualElementId,
    /** Без поля клавиатура проверяется, если она на экране; `[]` отключает. */
    notUnder: z.array(z.literal('keyboard')).max(1).optional(),
    /** Обязательная причина, если `notUnder: []` отключает проверку клавиатуры. */
    reason: z.string().trim().min(3).max(300).optional(),
    inset: z.literal('safe-area').optional(),
  }),
  z.strictObject({
    kind: z.literal('tap-hits'),
    name: assertionName.optional(),
    element: visualElementId,
    expect: z.union([
      z.strictObject({ visible: visualElementId }),
      z.strictObject({ hidden: visualElementId }),
    ]),
  }),
  z.strictObject({
    kind: z.literal('background'),
    name: assertionName.optional(),
    region: region.default('content'),
    /** Элементы-поверхности (карточки, панели), исключаемые из области. */
    surfaces: z.array(visualElementId).max(32).default([]),
    /** Не выше 0.9: порог 1 пропускал бы любую заливку. */
    maxFlatShare: z.number().finite().gt(0).max(0.9).default(VISUAL_MAX_FLAT_SHARE),
  }),
]);
export type VisualAssertion = z.infer<typeof assertion>;

const state = z.strictObject({
  id: visualStateId,
  route: z
    .string()
    .regex(/^\/[^\s]{0,300}$/)
    .optional(),
  seed: visualElementId.optional(),
  timeoutMs: timeout.optional(),
  steps: z.array(step).max(32).default([]),
  assert: z.array(assertion).min(1, 'состояние без утверждений ничего не проверяет').max(16),
});
export type VisualState = z.infer<typeof state>;

export const visualSpecSchema = z
  .strictObject({
    version: z.literal(1),
    platform: z.enum(['ios-simulator', 'web']),
    host: z.enum(['dev-client', 'expo-go', 'browser']).optional(),
    device: z
      .strictObject({
        model: z.string().min(1).max(100).optional(),
        runtime: z.string().min(1).max(100).optional(),
        appearance: z.enum(['light', 'dark']).optional(),
        locale: z
          .string()
          .regex(/^[A-Za-z]{2,3}(?:[_-][A-Za-z0-9]{2,8})*$/)
          .optional(),
      })
      .optional(),
    app: z
      .strictObject({
        bundleId: z.string().min(1).max(200).optional(),
        scheme: z.string().min(1).max(100).optional(),
        projectDir: z.string().min(1).max(300).optional(),
        url: z.string().url().max(500).optional(),
      })
      .optional(),
    defaults: z
      .strictObject({
        settleMs: z.number().int().min(0).max(3000).default(400),
        stateTimeoutMs: timeout.default(VISUAL_STATE_TIMEOUT_MS),
      })
      .default({ settleMs: 400, stateTimeoutMs: VISUAL_STATE_TIMEOUT_MS }),
    log: z
      .strictObject({
        forbid: z.array(pattern).min(1).max(32),
        allow: z
          .array(z.strictObject({ pattern, reason: z.string().trim().min(3).max(300) }))
          .max(32)
          .default([]),
      })
      .optional(),
    states: z
      .array(state)
      .min(1, 'спецификация без состояний ничего не проверяет')
      .max(VISUAL_MAX_STATES),
  })
  .superRefine((spec, context) => {
    const seen = new Set<string>();
    let budget = 0;
    spec.states.forEach((s, index) => {
      if (seen.has(s.id))
        context.addIssue({
          code: 'custom',
          path: ['states', index, 'id'],
          message: `Повтор id состояния ${s.id}`,
        });
      seen.add(s.id);
      budget += s.timeoutMs ?? spec.defaults.stateTimeoutMs;
      const names = new Set<string>();
      s.assert.forEach((a, position) => {
        const name = assertionId(a);
        if (names.has(name))
          context.addIssue({
            code: 'custom',
            path: ['states', index, 'assert', position],
            message: `Повтор утверждения ${name} в ${s.id}: задайте разные name`,
          });
        names.add(name);
        if (a.kind === 'visible' && a.notUnder?.length === 0 && !a.reason)
          context.addIssue({
            code: 'custom',
            path: ['states', index, 'assert', position, 'reason'],
            message: 'notUnder: [] отключает проверку клавиатуры: укажите reason',
          });
        if (spec.platform === 'web' && a.kind === 'visible' && a.notUnder?.includes('keyboard'))
          context.addIssue({
            code: 'custom',
            path: ['states', index, 'assert', position, 'notUnder'],
            message: 'Для web экранной клавиатуры нет: notUnder keyboard не применим',
          });
      });
    });
    spec.log?.allow.forEach((a, index) => {
      const allow = new RegExp(a.pattern, 'i');
      const neutral = NEUTRAL_LINES.find((line) => allow.test(line));
      const forbidden = spec.log?.forbid.find((f) => allow.test(forbiddenSample(f)));
      if (neutral !== undefined || forbidden !== undefined)
        context.addIssue({
          code: 'custom',
          path: ['log', 'allow', index, 'pattern'],
          message:
            neutral !== undefined
              ? `разрешающий шаблон покрывает обычную строку ${JSON.stringify(neutral)}`
              : `разрешающий шаблон покрывает сам запрет ${forbidden}`,
        });
    });
    if (budget > VISUAL_RUN_BUDGET_MS)
      context.addIssue({
        code: 'custom',
        path: ['states'],
        message: `Сумма бюджетов состояний ${budget} мс больше ${VISUAL_RUN_BUDGET_MS} мс`,
      });
  });
export type VisualSpec = z.infer<typeof visualSpecSchema>;

/** Имя testcase утверждения: явное `name` или вид проверки. */
export const assertionId = (a: VisualAssertion) => a.name ?? a.kind;

// ---------------------------------------------------------------------------
// Наблюдения драйвера: `<stateId>.frames.json`.

const rect = z.strictObject({ x: finite, y: finite, width: size, height: size });
export type Rect = z.infer<typeof rect>;
const snapshot = z.strictObject({
  /** id элементов, видимых на экране. */
  visible: z.array(visualElementId).max(1000),
  /** Поле в фокусе и его текст; null — фокуса нет. */
  focused: z.strictObject({ element: visualElementId, text: z.string().max(10_000) }).nullable(),
});
const tapRecord = z.strictObject({
  element: visualElementId,
  point: z.strictObject({ x: finite, y: finite }),
  /** Элемент, принявший касание; null — пустой участок. Драйвер обязан записать. */
  hit: visualElementId.nullable(),
  before: snapshot,
  after: snapshot,
});
export type VisualTap = z.infer<typeof tapRecord>;

/** Драйвер не смог достичь или измерить состояние. */
export const visualFramesErrorSchema = z.strictObject({
  version: z.literal(1),
  state: visualStateId,
  error: z.string().min(1).max(4000),
});
export const visualFramesObservedSchema = z.strictObject({
  version: z.literal(1),
  state: visualStateId,
  window: rect,
  safeArea: rect,
  /** null — клавиатуры на экране нет; отсутствие поля — драйвер не измерил. */
  keyboard: rect.nullable(),
  elements: z.record(visualElementId, rect),
  /** Касания утверждений `tap-hits` по имени утверждения. */
  taps: z.record(assertionName, tapRecord).default({}),
  /** Размер снимка для сырого `.rgba`; PNG несёт размер сам. */
  screenshot: z
    .strictObject({ width: z.number().int().positive(), height: z.number().int().positive() })
    .optional(),
});
export const visualFramesSchema = z.union([visualFramesErrorSchema, visualFramesObservedSchema]);
export type VisualFramesInput = z.input<typeof visualFramesSchema>;
export type VisualFrames = Extract<z.infer<typeof visualFramesSchema>, { window: Rect }>;

/** Снимок экрана: RGBA по 4 байта на пиксель, построчно. */
export type VisualImage = { width: number; height: number; data: Uint8Array };

// ---------------------------------------------------------------------------
// Утверждения.

export type VisualOutcome = {
  status: 'passed' | 'failed' | 'error';
  message?: string;
};
const passed = (): VisualOutcome => ({ status: 'passed' });
const failed = (message: string): VisualOutcome => ({ status: 'failed', message });
const environment = (message: string): VisualOutcome => ({ status: 'error', message });

/** Допуск сравнения координат в pt: рамки драйвера дробные. */
const EPS = 0.5;
const fmt = (n: number) => String(Math.round(n * 10) / 10);
const span = (from: number, to: number) => `${fmt(from)}–${fmt(to)}`;

export function intersect(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x,
    height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}
const inside = (p: { x: number; y: number }, r: Rect) =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

/**
 * `visible`: рамка элемента целиком в окне (или в safe area) и не пересекает
 * клавиатуру. Отчёт называет закрытые точки: пользователь видит лишь часть
 * кнопки, даже если её «хиттабельная» точка открыта.
 */
export function evaluateVisible(
  a: Extract<VisualAssertion, { kind: 'visible' }>,
  frames: VisualFrames,
): VisualOutcome {
  const frame = frames.elements[a.element];
  if (!frame) return failed(`элемент ${a.element} не найден на экране`);
  if (frame.width <= 0 || frame.height <= 0)
    return failed(`элемент ${a.element} имеет нулевой размер`);
  const problems: string[] = [];
  const bounds = a.inset === 'safe-area' ? frames.safeArea : frames.window;
  const area = a.inset === 'safe-area' ? 'safe area' : 'окна';
  const overflow = {
    сверху: bounds.y - frame.y,
    снизу: frame.y + frame.height - (bounds.y + bounds.height),
    слева: bounds.x - frame.x,
    справа: frame.x + frame.width - (bounds.x + bounds.width),
  };
  for (const [side, value] of Object.entries(overflow))
    if (value > EPS) problems.push(`выходит за границу ${area} ${side} на ${fmt(value)} pt`);
  const keyboard = (a.notUnder ?? ['keyboard']).includes('keyboard') ? frames.keyboard : null;
  const covered = keyboard ? intersect(frame, keyboard) : undefined;
  if (keyboard && covered && covered.width > EPS && covered.height > EPS)
    problems.push(
      `y ${span(frame.y, frame.y + frame.height)} пересекает клавиатуру y ≥ ${fmt(keyboard.y)}: ` +
        `закрыто ${fmt(covered.height)} из ${fmt(frame.height)} pt по высоте ` +
        `(x ${span(covered.x, covered.x + covered.width)}, y ${span(covered.y, covered.y + covered.height)})`,
    );
  return problems.length ? failed(`${a.element}: ${problems.join('; ')}`) : passed();
}

/**
 * `tap-hits`: касание по координате центра видимой (обрезанной окном) рамки
 * элемента. Проходит, только если объявленный эффект наступил и текст поля в
 * фокусе не изменился. Точка под клавиатурой — провал, даже если драйвер
 * сообщил об эффекте: пользователь в эту точку кнопку не видит.
 */
export function evaluateTapHits(
  a: Extract<VisualAssertion, { kind: 'tap-hits' }>,
  frames: VisualFrames,
): VisualOutcome {
  const name = assertionId(a);
  const frame = frames.elements[a.element];
  if (!frame) return failed(`элемент ${a.element} не найден на экране`);
  const shown = intersect(frame, frames.window);
  if (!shown) return failed(`элемент ${a.element} вне окна`);
  const centre = { x: shown.x + shown.width / 2, y: shown.y + shown.height / 2 };
  const tap = frames.taps[name];
  if (!tap) return environment(`драйвер не записал касание утверждения ${name}`);
  if (tap.element !== a.element)
    return environment(`драйвер записал касание ${tap.element} вместо ${a.element}`);
  if (Math.abs(tap.point.x - centre.x) > EPS * 2 || Math.abs(tap.point.y - centre.y) > EPS * 2)
    return environment(
      `касание (${fmt(tap.point.x)}, ${fmt(tap.point.y)}) не в центре видимой рамки ` +
        `(${fmt(centre.x)}, ${fmt(centre.y)}): драйвер нарушил договор координатного касания`,
    );
  const problems: string[] = [];
  if (frames.keyboard && inside(tap.point, frames.keyboard))
    problems.push(
      `точка касания (${fmt(tap.point.x)}, ${fmt(tap.point.y)}) под клавиатурой y ≥ ${fmt(frames.keyboard.y)}`,
    );
  if (tap.hit !== a.element)
    problems.push(`касание принял ${tap.hit ?? 'пустой участок экрана'}, а не ${a.element}`);
  if ('visible' in a.expect) {
    const target = a.expect.visible;
    if (!tap.after.visible.includes(target)) problems.push(`после касания ${target} не появился`);
    else if (tap.before.visible.includes(target))
      problems.push(`${target} был виден до касания: эффект не доказан`);
  } else {
    const target = a.expect.hidden;
    if (!tap.before.visible.includes(target))
      problems.push(`${target} не был виден до касания: эффект не доказан`);
    else if (tap.after.visible.includes(target))
      problems.push(`после касания ${target} не скрылся`);
  }
  // Текст сравнивается, только пока фокус на том же поле: отправка формы
  // законно снимает фокус, а набор в чужую клавиатуру его сохраняет.
  const field = tap.before.focused;
  if (
    field &&
    tap.after.focused?.element === field.element &&
    tap.after.focused.text !== field.text
  )
    problems.push(
      `касание изменило текст поля ${field.element} в фокусе: ${JSON.stringify(field.text)} → ` +
        JSON.stringify(tap.after.focused.text),
    );
  return problems.length ? failed(`${a.element}: ${problems.join('; ')}`) : passed();
}

/** Сетка выборки фона: до GRID × GRID точек. */
const GRID = 96;
const MIN_SAMPLES = 64;
const TOP_COLORS = 3;

/**
 * `background`: область не залита плоским цветом. Пиксели сетки квантуются до
 * 5 бит на канал; `flatShare` — доля трёх самых частых цветов. Фото или
 * текстура дают низкую долю, сплошная заливка с карточкой — высокую.
 */
export function evaluateBackground(
  a: Extract<VisualAssertion, { kind: 'background' }>,
  frames: VisualFrames,
  image: VisualImage,
): VisualOutcome & { flatShare?: number } {
  const window = frames.window;
  if (window.width <= 0 || window.height <= 0) return environment('окно нулевого размера');
  if (image.data.length !== image.width * image.height * 4)
    return environment('размер данных снимка не совпадает с его шириной и высотой');
  const scale = image.width / window.width;
  if (Math.abs(image.height - window.height * scale) > Math.max(2, scale))
    return environment(
      `снимок ${image.width}×${image.height} не соответствует окну ${fmt(window.width)}×${fmt(window.height)} pt`,
    );
  let area: Rect | undefined;
  if (a.region === 'content') area = intersect(frames.safeArea, window);
  else
    area = {
      x: window.x + a.region.x * window.width,
      y: window.y + a.region.y * window.height,
      width: a.region.width * window.width,
      height: a.region.height * window.height,
    };
  if (!area) return failed('область оценки фона пуста');
  const surfaces: Rect[] = [];
  for (const id of a.surfaces) {
    const frame = frames.elements[id];
    if (!frame) return failed(`поверхность ${id} не найдена на экране`);
    surfaces.push(frame);
  }
  // Клавиатура — не фон приложения.
  if (frames.keyboard) surfaces.push(frames.keyboard);
  const nx = Math.max(1, Math.min(GRID, Math.floor(area.width * scale)));
  const ny = Math.max(1, Math.min(GRID, Math.floor(area.height * scale)));
  const counts = new Map<number, number>();
  let total = 0;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const point = {
        x: area.x + ((i + 0.5) * area.width) / nx,
        y: area.y + ((j + 0.5) * area.height) / ny,
      };
      if (surfaces.some((s) => inside(point, s))) continue;
      const px = Math.min(image.width - 1, Math.max(0, Math.floor((point.x - window.x) * scale)));
      const py = Math.min(image.height - 1, Math.max(0, Math.floor((point.y - window.y) * scale)));
      const at = (py * image.width + px) * 4;
      const key =
        ((image.data[at] >> 3) << 10) |
        ((image.data[at + 1] >> 3) << 5) |
        (image.data[at + 2] >> 3);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total++;
    }
  if (total < MIN_SAMPLES)
    return failed(`в области оценки фона ${total} точек выборки, нужно не меньше ${MIN_SAMPLES}`);
  const top = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, TOP_COLORS);
  const flatShare = top.reduce((sum, [, n]) => sum + n, 0) / total;
  if (flatShare <= a.maxFlatShare) return { ...passed(), flatShare };
  const hex = (key: number) =>
    '#' +
    [(key >> 10) & 31, (key >> 5) & 31, key & 31]
      .map((c) => (c << 3).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  return {
    ...failed(
      `доля трёх самых частых цветов ${flatShare.toFixed(2)} > ${a.maxFlatShare} ` +
        `(${top.map(([key, n]) => `${hex(key)} ${Math.round((n / total) * 100)}%`).join(', ')}): ` +
        'фон области — плоская заливка',
    ),
    flatShare,
  };
}

/** Строки журнала, показываемые в отчёте о провале. */
const LOG_EXAMPLES = 5;

/** `log-forbid`: строки журнала, совпавшие с запретом и не разрешённые явно. */
export function evaluateLog(log: NonNullable<VisualSpec['log']>, lines: string[]): VisualOutcome {
  // Пустой журнал не доказывает отсутствие предупреждений: захват не подтверждён.
  if (!lines.some((line) => line.trim()))
    return environment('журнал прогона пуст: захват журнала не подтверждён');
  const forbid = log.forbid.map((p) => new RegExp(p, 'i'));
  const allow = log.allow.map((a) => new RegExp(a.pattern, 'i'));
  const found = lines.filter(
    (line) => forbid.some((r) => r.test(line)) && !allow.some((r) => r.test(line)),
  );
  if (!found.length) return passed();
  return failed(
    `запрещённых строк журнала: ${found.length}\n` +
      found
        .slice(0, LOG_EXAMPLES)
        .map((line) => line.slice(0, 300))
        .join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Прогон спецификации и JUnit.

export type VisualCase = VisualOutcome & { classname: string; name: string };

/** Наблюдения одного состояния; отсутствующий файл — `{ error }` от читателя. */
export type VisualStateInput =
  { error: string } | { frames: VisualFrames; screenshot?: VisualImage | { error: string } };

/** testcase журнала: одна проверка на прогон, вне состояний. */
export const VISUAL_LOG_CASE = { classname: 'visual.log', name: 'no-forbidden' } as const;

/**
 * Все утверждения спецификации над наблюдениями. Каждое объявленное
 * утверждение даёт testcase: состояние без наблюдений не исчезает из отчёта,
 * а становится ошибкой окружения.
 */
export function evaluateVisual(
  spec: VisualSpec,
  states: Readonly<Record<string, VisualStateInput | undefined>>,
  log?: string[] | { error: string },
): VisualCase[] {
  const cases: VisualCase[] = [];
  for (const s of spec.states) {
    const input = states[s.id] ?? { error: `драйвер не записал наблюдения состояния ${s.id}` };
    for (const a of s.assert) {
      const head = { classname: `visual.${s.id}`, name: assertionId(a) };
      const outcome = (): VisualOutcome => {
        if ('error' in input) return environment(input.error);
        if (a.kind === 'visible') return evaluateVisible(a, input.frames);
        if (a.kind === 'tap-hits') return evaluateTapHits(a, input.frames);
        const shot = input.screenshot;
        if (!shot) return environment(`нет снимка экрана состояния ${s.id}`);
        if ('error' in shot) return environment(shot.error);
        const { status, message } = evaluateBackground(a, input.frames, shot);
        return { status, message };
      };
      cases.push({ ...head, ...outcome() });
    }
  }
  if (spec.log)
    cases.push({
      ...VISUAL_LOG_CASE,
      ...(!log
        ? environment('драйвер не записал журнал прогона')
        : 'error' in log
          ? environment(log.error)
          : evaluateLog(spec.log, log)),
    });
  return cases;
}

/** Символы, недопустимые в XML 1.0, удаляются; разметка экранируется. */
const xml = (value: string) =>
  value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
const attribute = (value: string) => xml(value).replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');

/** Пустой прогон — провал, а не зелёный отчёт без проверок. */
export const VISUAL_EMPTY_CASE = { classname: 'visual.run', name: 'empty' } as const;

/**
 * JUnit визуального прогона. Провал утверждения — `<failure type="assertion">`,
 * сбой драйвера или окружения — `<error type="environment">`; `<skipped>` не
 * пишется никогда.
 */
export function visualJunit(input: readonly VisualCase[]): string {
  const cases: VisualCase[] = input.length
    ? [...input]
    : [
        {
          ...VISUAL_EMPTY_CASE,
          status: 'failed',
          message: 'визуальный прогон не выполнил ни одной проверки',
        },
      ];
  const failures = cases.filter((c) => c.status === 'failed').length;
  const errors = cases.filter((c) => c.status === 'error').length;
  const body = cases.map((c) => {
    const open = `    <testcase classname="${attribute(c.classname)}" name="${attribute(c.name)}"`;
    if (c.status === 'passed') return `${open}/>`;
    const tag = c.status === 'failed' ? 'failure' : 'error';
    const type = c.status === 'failed' ? 'assertion' : 'environment';
    const message = c.message ?? '';
    return (
      `${open}>\n      <${tag} type="${type}" message="${attribute(message.split('\n')[0])}">` +
      `${xml(message)}</${tag}>\n    </testcase>`
    );
  });
  const counts = `tests="${cases.length}" failures="${failures}" errors="${errors}" skipped="0"`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites ${counts}>\n` +
    `  <testsuite name="visual" ${counts}>\n${body.join('\n')}\n  </testsuite>\n</testsuites>\n`
  );
}
