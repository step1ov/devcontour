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
/** testcase достижения состояния: `visual.<stateId>.reach`. */
export const VISUAL_REACH = 'reach';

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
/** Собственный текст разрешения: не короче этого, и не только текст запрета. */
const ALLOW_MIN_LITERAL = 8;
const ALLOW_MIN_OWN = 4;

/** Альтернативы верхнего уровня шаблона журнала (групп в шаблонах нет). */
export function patternAlternatives(value: string): string[] {
  const out: string[] = [];
  let current = '',
    inClass = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\') {
      current += c + (value[i + 1] ?? '');
      i++;
      continue;
    }
    if (inClass) inClass = c !== ']';
    else if (c === '[') inClass = true;
    else if (c === '|') {
      out.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  out.push(current);
  return out;
}

/** Символ для escape-класса в примере строки; undefined — буквальный символ. */
const ESCAPE_SAMPLES: Record<string, string> = {
  b: ' ',
  B: '',
  d: '0',
  D: 'a',
  w: 'a',
  W: ' ',
  s: ' ',
  S: 'a',
  n: '\n',
  t: '\t',
  r: '\r',
  f: '\f',
  v: '\v',
};
/** Печатные ASCII — кандидаты на член класса `[...]`. */
const PRINTABLE = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));

/**
 * Разбор альтернативы на токены: пример строки, которую она ловит (класс
 * заменён его членом, `\b` — пробелом, якоря опущены), и буквальные отрезки.
 */
function patternTokens(alternative: string) {
  const tokens: { sample: string; literal: boolean }[] = [];
  for (let i = 0; i < alternative.length; i++) {
    const c = alternative[i];
    if (c === '\\') {
      const next = alternative[i + 1] ?? '';
      i++;
      const sample = ESCAPE_SAMPLES[next];
      tokens.push(
        sample === undefined ? { sample: next, literal: true } : { sample, literal: false },
      );
    } else if (c === '[') {
      let end = i + 1;
      while (end < alternative.length && alternative[end] !== ']')
        end += alternative[end] === '\\' ? 2 : 1;
      const member = new RegExp(`^${alternative.slice(i, end + 1)}$`, 'i');
      tokens.push({ sample: PRINTABLE.find((ch) => member.test(ch)) ?? '', literal: false });
      i = end;
    } else if (c === '^' || c === '$') tokens.push({ sample: '', literal: false });
    else if (c === '.') tokens.push({ sample: 'a', literal: false });
    else tokens.push({ sample: c, literal: true });
  }
  return tokens;
}
const patternSample = (alternative: string) =>
  patternTokens(alternative)
    .map((t) => t.sample)
    .join('');
function longestLiteral(alternative: string) {
  let best = '',
    run = '';
  for (const t of patternTokens(alternative)) {
    run = t.literal ? run + t.sample : '';
    if (run.length > best.length) best = run;
  }
  return best;
}

/**
 * Разрешение должно быть уже запрета: каждая его альтернатива не покрывает
 * нейтральную строку и пример запрещённой строки и несёт собственный
 * буквальный текст — не короче 8 символов и не сводящийся к тексту запрета с
 * разделителями. Иначе `:` или `warn` молча разрешили бы настоящие
 * предупреждения.
 */
export function allowPatternProblem(allow: string, forbid: string[]): string | undefined {
  const forbidden = forbid.flatMap(patternAlternatives);
  const samples = forbidden.map(patternSample);
  for (const alternative of patternAlternatives(allow)) {
    const matcher = new RegExp(alternative, 'i');
    const neutral = NEUTRAL_LINES.find((line) => matcher.test(line));
    if (neutral !== undefined)
      return `разрешение ${alternative} покрывает обычную строку ${JSON.stringify(neutral)}`;
    const sample = samples.find((line) => matcher.test(line));
    if (sample !== undefined)
      return `разрешение ${alternative} покрывает запрещённую строку ${JSON.stringify(sample)}`;
    const literal = longestLiteral(alternative);
    if (literal.length < ALLOW_MIN_LITERAL)
      return `разрешение ${alternative}: нужен буквальный текст не короче ${ALLOW_MIN_LITERAL} символов`;
    let own = literal;
    for (const f of forbidden) if (f) own = own.replace(new RegExp(f, 'gi'), '');
    if (own.replace(/[^\p{L}\p{N}]/gu, '').length < ALLOW_MIN_OWN)
      return `разрешение ${alternative} сводится к тексту запрета и разделителям`;
  }
  return undefined;
}
const timeout = z.number().int().min(100).max(VISUAL_STATE_TIMEOUT_MAX_MS);

/**
 * Закрытый словарь шагов. `tap` — всегда касание по координате центра
 * видимой рамки элемента, а не касание элемента средствами фреймворка: точка
 * фреймворка может попасть в незакрытую полоску кнопки, которую пользователь
 * не видит.
 */
/**
 * Цель шага: id элемента или селектор по префиксу для id, создаваемых во
 * время работы (`item-add-<uuid>`): `index`-й элемент с этим префиксом в
 * порядке чтения — сверху вниз, затем слева направо по рамкам на экране.
 */
export const visualTargetSchema = z.union([
  visualElementId,
  z.strictObject({
    prefix: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{1,63}$/, 'префикс id: 2–64 символа без пробелов'),
    index: z.number().int().min(0).max(49),
  }),
]);
export type VisualTarget = z.infer<typeof visualTargetSchema>;
/** Подходит ли id элемента под цель шага. */
export const targetMatches = (target: VisualTarget, id: string) =>
  typeof target === 'string' ? id === target : id.startsWith(target.prefix);
export const targetLabel = (target: VisualTarget) =>
  typeof target === 'string' ? target : `${target.prefix}*[${target.index}]`;

const step = z.union([
  z.strictObject({ launch: z.literal(true) }),
  z.strictObject({ tap: visualTargetSchema }),
  z.strictObject({ type: z.string().min(1).max(500) }),
  /** Очистить поле: фокус и удаление всего текста. */
  z.strictObject({ clear: visualTargetSchema }),
  z.strictObject({ wait: visualTargetSchema, timeoutMs: timeout.optional() }),
  /** Прокрутка контейнера до элемента или до конца; не больше `maxSwipes` жестов. */
  z.strictObject({
    scroll: visualElementId,
    to: z.union([visualTargetSchema, z.literal('end')]),
    maxSwipes: z.number().int().min(1).max(20).default(10),
  }),
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
    /** `ios` — iOS-симулятор через broker на macOS; `web` — браузер. */
    platform: z.enum(['ios', 'web']),
    /**
     * Где исполняется приложение. Для `ios` — `dev-client` (по умолчанию) или
     * `expo-go`; Expo Go принимается в gate задачи, но не в проверке уровня
     * релиза (`visual run --release`). Для `web` — только `browser`.
     */
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
    /**
     * id элементов, которые не принимают касаний (фоновое изображение,
     * декоративная подложка): драйвер не называет их `hit`, а оценщик не
     * считает такой `hit` попаданием мимо цели.
     */
    decorative: z.array(visualElementId).max(64).default([]),
    states: z
      .array(state)
      .min(1, 'спецификация без состояний ничего не проверяет')
      .max(VISUAL_MAX_STATES),
  })
  .superRefine((spec, context) => {
    const host = visualHost(spec);
    if ((spec.platform === 'web') !== (host === 'browser'))
      context.addIssue({
        code: 'custom',
        path: ['host'],
        message:
          spec.platform === 'web'
            ? 'Для web host — только browser'
            : 'Для ios host — dev-client или expo-go',
      });
    const decorative = new Set(spec.decorative);
    if (decorative.size !== spec.decorative.length)
      context.addIssue({
        code: 'custom',
        path: ['decorative'],
        message: 'Повтор id в decorative',
      });
    const touched = (id: string, path: (string | number)[]) => {
      if (decorative.has(id))
        context.addIssue({
          code: 'custom',
          path,
          message: `${id} объявлен декоративным: касаться его нельзя`,
        });
    };
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
      if (s.route && !(spec.platform === 'web' ? spec.app?.url : spec.app?.scheme))
        context.addIssue({
          code: 'custom',
          path: ['states', index, 'route'],
          message:
            spec.platform === 'web'
              ? 'route открывается от app.url: укажите app.url'
              : 'route открывается deep link: укажите app.scheme',
        });
      budget += s.timeoutMs ?? spec.defaults.stateTimeoutMs;
      s.steps.forEach((step, position) => {
        const target = 'tap' in step ? step.tap : 'clear' in step ? step.clear : undefined;
        if (typeof target === 'string') touched(target, ['states', index, 'steps', position]);
        else if (target)
          for (const id of decorative)
            if (id.startsWith(target.prefix))
              context.addIssue({
                code: 'custom',
                path: ['states', index, 'steps', position],
                message: `префикс ${target.prefix} покрывает декоративный ${id}`,
              });
      });
      const names = new Set<string>();
      s.assert.forEach((a, position) => {
        const name = assertionId(a);
        if (name === VISUAL_REACH)
          context.addIssue({
            code: 'custom',
            path: ['states', index, 'assert', position, 'name'],
            message: `Имя ${VISUAL_REACH} занято проверкой достижения состояния`,
          });
        if (names.has(name))
          context.addIssue({
            code: 'custom',
            path: ['states', index, 'assert', position],
            message: `Повтор утверждения ${name} в ${s.id}: задайте разные name`,
          });
        names.add(name);
        if (a.kind === 'tap-hits')
          touched(a.element, ['states', index, 'assert', position, 'element']);
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
      const problem = allowPatternProblem(a.pattern, spec.log?.forbid ?? []);
      if (problem)
        context.addIssue({
          code: 'custom',
          path: ['log', 'allow', index, 'pattern'],
          message: problem,
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
/** Хост приложения: явный или по умолчанию для платформы. */
export function visualHost(spec: { platform: 'ios' | 'web'; host?: VisualSpec['host'] }) {
  return spec.host ?? (spec.platform === 'web' ? 'browser' : 'dev-client');
}

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
/**
 * Кто принял касание — лучшее доказательство драйвера. Клавиатура названа
 * явно, а не id элемента: testID `keyboard` у продукта возможен. Драйвер
 * без hit-test и без надёжного порядка отрисовки (XCUITest) вычисляет так:
 * точка в рамке клавиатуры — `keyboard`; иначе наименьшая по площади рамка,
 * содержащая точку, среди элементов с id, кроме `decorative` и заведомо не
 * принимающих касаний, — `element`; иначе `none`. Это приближение: перекрытия
 * без id и скрытые от доступности слои драйвер не видит.
 */
export const visualHitSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('element'),
    element: visualElementId,
    /** Рамка принявшего элемента: вложенный в цель элемент со своим id — не промах. */
    frame: rect.optional(),
    /** Драйвер с настоящей иерархией (web) подтверждает, что элемент — потомок цели. */
    descendant: z.literal(true).optional(),
  }),
  z.strictObject({ kind: z.literal('keyboard') }),
  z.strictObject({ kind: z.literal('none') }),
]);
export type VisualHit = z.infer<typeof visualHitSchema>;
const hitLabel = (hit: VisualHit) =>
  hit.kind === 'element'
    ? hit.element
    : hit.kind === 'keyboard'
      ? 'клавиатура'
      : 'пустой участок экрана';
const tapRecord = z.strictObject({
  element: visualElementId,
  point: z.strictObject({ x: finite, y: finite }),
  hit: visualHitSchema,
  before: snapshot,
  after: snapshot,
});
export type VisualTap = z.infer<typeof tapRecord>;

/**
 * Касание шага (`tap`, `clear`): записывается и для недостигнутого
 * состояния — заблокированный шаг становится провалом `reach` с этим
 * доказательством, а не ошибкой окружения.
 */
const stepIndex = z.number().int().min(0).max(31);
/**
 * Для цели-префикса — все элементы на экране с этим префиксом и их рамки:
 * оценщик сам упорядочивает их и проверяет, что выбран `index`-й.
 */
const candidates = z
  .array(z.strictObject({ id: visualElementId, frame: rect }))
  .min(1)
  .max(200);
const stepTapRecord = z.union([
  z.strictObject({
    /** Номер шага в `steps` состояния, с нуля. */
    step: stepIndex,
    element: visualElementId,
    /** Рамка элемента в момент касания. */
    frame: rect,
    window: rect,
    keyboard: rect.nullable(),
    point: z.strictObject({ x: finite, y: finite }),
    hit: visualHitSchema,
    before: snapshot,
    after: snapshot,
    candidates: candidates.optional(),
  }),
  /**
   * Цель найдена, но её рамка вне окна: видимого центра нет, касания не было.
   * Шаг `scroll` такой записи не даёт — прокрутка для этого и нужна.
   */
  z.strictObject({
    step: stepIndex,
    element: visualElementId,
    frame: rect,
    window: rect,
    keyboard: rect.nullable(),
    point: z.null(),
    candidates: candidates.optional(),
  }),
]);
export type VisualStepTap = z.infer<typeof stepTapRecord>;
/**
 * Цель шага не появилась на экране за всё время шага: id нет в дереве
 * доступности (например, его нет в коде этого SHA). Провал `reach` с
 * названным id, а не тайм-аут драйвера.
 */
const missingRecord = z.strictObject({
  step: stepIndex,
  /** Цель шага, как её называет спецификация: id или `префикс*[index]`. */
  target: z.string().min(1).max(100),
  /** id, которые были на экране в конце ожидания, для диагностики. */
  visible: z.array(visualElementId).max(200),
});
/** Байтовое окно `log.txt`, записанное за время состояния: [from, to). */
const logWindow = z
  .strictObject({ from: z.number().int().min(0), to: z.number().int().min(0) })
  .refine((w) => w.from <= w.to, 'окно журнала: from ≤ to');

/** Драйвер не смог достичь или измерить состояние. */
export const visualFramesErrorSchema = z.strictObject({
  version: z.literal(1),
  state: visualStateId,
  error: z.string().min(1).max(4000),
  stepTaps: z.array(stepTapRecord).max(32).default([]),
  missing: missingRecord.optional(),
  log: logWindow.optional(),
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
  stepTaps: z.array(stepTapRecord).max(32).default([]),
  missing: missingRecord.optional(),
  log: logWindow.optional(),
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
  /** Сведения для evidence (`<system-out>`), при любом статусе. */
  output?: string;
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
/** Рамка `inner` целиком внутри `outer` с допуском EPS. */
const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x - EPS &&
  inner.y >= outer.y - EPS &&
  inner.x + inner.width <= outer.x + outer.width + EPS &&
  inner.y + inner.height <= outer.y + outer.height + EPS;
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
  decorative: ReadonlySet<string> = new Set(),
): VisualOutcome {
  const name = assertionId(a);
  const frame = frames.elements[a.element];
  if (!frame) return failed(`элемент ${a.element} не найден на экране`);
  const shown = intersect(frame, frames.window);
  if (!shown) return failed(`элемент ${a.element} вне окна`);
  const tap = frames.taps[name];
  if (!tap) return environment(`драйвер не записал касание утверждения ${name}`);
  if (tap.element !== a.element)
    return environment(`драйвер записал касание ${tap.element} вместо ${a.element}`);
  const offCentre = centreProblem(shown, tap.point);
  if (offCentre) return environment(offCentre);
  const problems = tapProblems(tap, frame, frames.keyboard, decorative);
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
  return problems.length ? failed(`${a.element}: ${problems.join('; ')}`) : passed();
}

/** Цель шага, если у него она есть. */
function stepTarget(step: VisualStep): VisualTarget | undefined {
  if ('tap' in step) return step.tap;
  if ('clear' in step) return step.clear;
  if ('wait' in step) return step.wait;
  if ('scroll' in step) return step.to === 'end' ? step.scroll : step.to;
  return undefined;
}

/** Касание не в центре видимой рамки — нарушение договора драйвером. */
function centreProblem(shown: Rect, point: { x: number; y: number }) {
  const centre = { x: shown.x + shown.width / 2, y: shown.y + shown.height / 2 };
  if (Math.abs(point.x - centre.x) <= EPS * 2 && Math.abs(point.y - centre.y) <= EPS * 2)
    return undefined;
  return (
    `касание (${fmt(point.x)}, ${fmt(point.y)}) не в центре видимой рамки ` +
    `(${fmt(centre.x)}, ${fmt(centre.y)}): драйвер нарушил договор координатного касания`
  );
}

/**
 * Признаки касания мимо цели: точка под клавиатурой, касание принял не
 * элемент, текст поля в фокусе изменился. Текст сравнивается, только пока
 * фокус на том же поле: отправка формы законно снимает фокус, а набор в
 * чужую клавиатуру его сохраняет.
 */
function hitProblems(
  tap: Pick<VisualTap, 'element' | 'point' | 'hit'>,
  target: Rect,
  keyboard: Rect | null,
  decorative: ReadonlySet<string>,
) {
  const problems: string[] = [];
  if (keyboard && inside(tap.point, keyboard))
    problems.push(
      `точка касания (${fmt(tap.point.x)}, ${fmt(tap.point.y)}) под клавиатурой y ≥ ${fmt(keyboard.y)}`,
    );
  const hit = tap.hit;
  if (hit.kind === 'element' && decorative.has(hit.element))
    // Декоративный id драйвер исключает из расчёта hit; если он всё же назван,
    // касание приняло то, что не должно принимать касаний, — промах.
    problems.push(`касание принял декоративный ${hit.element}, а не ${tap.element}`);
  else if (hit.kind !== 'element')
    problems.push(`касание принял ${hitLabel(hit)}, а не ${tap.element}`);
  else if (hit.element !== tap.element && !nested(hit, target))
    problems.push(`касание принял ${hit.element}, а не ${tap.element}`);
  return problems;
}

/**
 * Вложенный в цель элемент (подпись в кнопке) — то же касание: если драйвер
 * с иерархией подтвердил потомка, или если рамка строго меньше цели и лежит
 * в ней. Перекрытие той же рамки соседним слоем этим не оправдывается.
 */
function nested(hit: Extract<VisualHit, { kind: 'element' }>, target: Rect) {
  if (hit.descendant) return true;
  const frame = hit.frame;
  if (!frame || !contains(target, frame)) return false;
  const inner =
    frame.x - target.x > EPS ||
    frame.y - target.y > EPS ||
    target.x + target.width - (frame.x + frame.width) > EPS ||
    target.y + target.height - (frame.y + frame.height) > EPS;
  return inner && frame.width * frame.height < target.width * target.height;
}

/**
 * Касание изменило текст поля в фокусе. Сравнивается, только пока фокус на
 * том же поле: отправка формы законно снимает фокус, а набор в чужую
 * клавиатуру его сохраняет. Для `clear` `after` снимается сразу после
 * фокусирующего касания, до удаления текста.
 */
function textProblems(tap: Pick<VisualTap, 'before' | 'after'>) {
  const field = tap.before.focused;
  if (
    field &&
    tap.after.focused?.element === field.element &&
    tap.after.focused.text !== field.text
  )
    return [
      `касание изменило текст поля ${field.element} в фокусе: ${JSON.stringify(field.text)} → ` +
        JSON.stringify(tap.after.focused.text),
    ];
  return [];
}

function tapProblems(
  tap: Pick<VisualTap, 'element' | 'point' | 'hit' | 'before' | 'after'>,
  target: Rect,
  keyboard: Rect | null,
  decorative: ReadonlySet<string>,
) {
  return [...hitProblems(tap, target, keyboard, decorative), ...textProblems(tap)];
}

/**
 * `reach`: состояние достигнуто, и ни одно касание шага не ушло мимо цели.
 * Заблокированный шаг (точка под клавиатурой, касание принял другой
 * элемент, набор в поле) — провал продукта с доказательством касания, даже
 * если драйвер дальше не смог достичь состояния. Сбой драйвера без такого
 * шага — ошибка окружения.
 */
export function evaluateReach(
  state: VisualState,
  input: VisualStateInput,
  decorative: ReadonlySet<string> = new Set(),
): VisualOutcome {
  if ('error' in input) return environment(input.error);
  const reached = !('unreached' in input);
  const observed = 'unreached' in input ? input.unreached : input.frames;
  const blocked: string[] = [];
  // Нарушения договора драйвером копятся отдельно: они не отменяют уже
  // найденный дефект продукта, но без него делают результат ошибкой окружения.
  const driver: string[] = [];
  const tapSteps = state.steps.flatMap((step, index) =>
    'tap' in step || 'clear' in step ? [index] : [],
  );
  const recorded = new Set<number>();
  for (const tap of observed.stepTaps) {
    // Точка под клавиатурой и чужой hit не зависят от исправности остальной
    // записи: нарушение договора не должно скрывать заблокированное касание.
    const geometry =
      tap.point === null
        ? []
        : hitProblems({ ...tap, point: tap.point }, tap.frame, tap.keyboard, decorative);
    const contract = (problem: string) => {
      driver.push(problem);
      if (geometry.length) blocked.push(`шаг ${tap.step} ${tap.element}: ${geometry.join('; ')}`);
    };
    if (recorded.has(tap.step)) {
      driver.push(`повтор записи касания шага ${tap.step}`);
      continue;
    }
    recorded.add(tap.step);
    const declared = state.steps[tap.step];
    const target =
      declared && 'tap' in declared
        ? declared.tap
        : declared && 'clear' in declared
          ? declared.clear
          : undefined;
    if (!target || !targetMatches(target, tap.element)) {
      contract(
        `запись касания шага ${tap.step} (${tap.element}) не соответствует шагу спецификации`,
      );
      continue;
    }
    const order = candidateProblem(target, tap);
    if (order) {
      contract(`шаг ${tap.step}: ${order}`);
      continue;
    }
    const label = `шаг ${tap.step} ${targetLabel(target)}`;
    if (decorative.has(tap.element)) {
      blocked.push(`${label}: цель ${tap.element} объявлена декоративной`);
      continue;
    }
    const shown = intersect(tap.frame, tap.window);
    if (tap.point === null) {
      if (shown)
        driver.push(`шаг ${tap.step}: драйвер не коснулся ${tap.element}, хотя его рамка в окне`);
      else
        blocked.push(
          `${label}: цель шага вне окна ` +
            `(${tap.element} y ${span(tap.frame.y, tap.frame.y + tap.frame.height)}, ` +
            `окно y ${span(tap.window.y, tap.window.y + tap.window.height)})`,
        );
      continue;
    }
    if (!shown) {
      contract(`шаг ${tap.step}: касание ${tap.element}, чья рамка вне окна`);
      continue;
    }
    const offCentre = centreProblem(shown, tap.point);
    if (offCentre) {
      contract(`шаг ${tap.step}: ${offCentre}`);
      continue;
    }
    // Для `clear` `after` — снимок сразу после фокусирующего касания. Пустое
    // поле вместо прежнего текста значит, что драйвер снял его после удаления:
    // это не дефект продукта, а нарушение формата записи.
    const before = tap.before.focused,
      after = tap.after.focused;
    if (
      'clear' in declared &&
      before &&
      after?.element === before.element &&
      before.text !== '' &&
      after.text === ''
    ) {
      contract(`шаг ${tap.step}: after для clear снят после удаления текста`);
      continue;
    }
    const problems = [...geometry, ...textProblems(tap)];
    if (problems.length) blocked.push(`${label}: ${problems.join('; ')}`);
  }
  const missing = observed.missing;
  if (missing) {
    const declared = state.steps[missing.step];
    const expected = declared ? stepTarget(declared) : undefined;
    if (reached)
      driver.push(`достигнутое состояние с записью отсутствия цели шага ${missing.step}`);
    else if (!expected || targetLabel(expected) !== missing.target)
      driver.push(
        `запись отсутствия цели шага ${missing.step} (${missing.target}) не соответствует спецификации`,
      );
    else
      blocked.push(
        `шаг ${missing.step}: цель ${missing.target} не найдена на экране за время шага` +
          (missing.visible.length ? `; на экране: ${missing.visible.slice(0, 20).join(', ')}` : ''),
      );
  }
  // Каждое касание шага должно иметь запись: без неё заблокированный шаг
  // был бы неотличим от чистого. Для недостигнутого состояния — все шаги до
  // последнего записанного.
  const last = Math.max(-1, ...recorded, missing && !reached ? missing.step - 1 : -1);
  const required = reached ? tapSteps : tapSteps.filter((index) => index <= last);
  const absent = required.filter((index) => !recorded.has(index));
  if (absent.length) driver.push(`нет записи касания шагов ${absent.join(', ')}`);
  const contract = driver.length ? `нарушения договора драйвером: ${driver.join('; ')}` : '';
  if (blocked.length)
    return failed(
      (reached ? '' : 'состояние не достигнуто: ') +
        blocked.join('\n') +
        (contract ? `\n${contract}` : ''),
    );
  if (contract) return environment(contract);
  return 'unreached' in input ? environment(`драйвер: ${input.unreached.error}`) : passed();
}

/**
 * Цель-префикс: записанные кандидаты упорядочиваются сверху вниз, затем слева
 * направо, и `index`-й должен быть выбранным элементом.
 */
function candidateProblem(target: VisualTarget, tap: VisualStepTap): string | undefined {
  if (typeof target === 'string') return undefined;
  const label = targetLabel(target);
  const list = tap.candidates;
  if (!list) return `для цели ${label} драйвер не записал кандидатов`;
  if (list.some((c) => !c.id.startsWith(target.prefix)))
    return `кандидаты цели ${label} не все с префиксом ${target.prefix}`;
  const ids = new Set(list.map((c) => c.id));
  if (ids.size !== list.length) return `кандидаты цели ${label} повторяются`;
  // Каждый видимый до касания элемент с префиксом обязан быть кандидатом:
  // иначе пропуск настоящего первого сдвинул бы индекс.
  if (tap.point !== null) {
    const omitted = tap.before.visible.filter((id) => id.startsWith(target.prefix) && !ids.has(id));
    if (omitted.length) return `кандидаты цели ${label} не включают видимые ${omitted.join(', ')}`;
  }
  const chosen = readingOrder(list)[target.index];
  if (chosen?.id !== tap.element)
    return `${label} в порядке чтения — ${chosen?.id ?? 'нет такого кандидата'}, а драйвер выбрал ${tap.element}`;
  const same =
    Math.abs(chosen.frame.x - tap.frame.x) <= EPS &&
    Math.abs(chosen.frame.y - tap.frame.y) <= EPS &&
    Math.abs(chosen.frame.width - tap.frame.width) <= EPS &&
    Math.abs(chosen.frame.height - tap.frame.height) <= EPS;
  return same ? undefined : `рамка кандидата ${chosen.id} не совпадает с рамкой записи касания`;
}

/**
 * Порядок чтения: строки по y (новая строка, если y дальше EPS от первого
 * элемента строки), внутри строки — по x. Группировка по строкам делает
 * порядок транзитивным и независимым от порядка записи.
 */
export function readingOrder<T extends { frame: Rect }>(list: readonly T[]): T[] {
  const rows: T[][] = [];
  for (const item of [...list].sort((a, b) => a.frame.y - b.frame.y)) {
    const row = rows.at(-1);
    if (row && item.frame.y - row[0].frame.y <= EPS) row.push(item);
    else rows.push([item]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.frame.x - b.frame.x));
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
  const hex = (key: number) =>
    '#' +
    [(key >> 10) & 31, (key >> 5) & 31, key & 31]
      .map((c) => (c << 3).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  const colors = top.map(([key, n]) => `${hex(key)} ${Math.round((n / total) * 100)}%`).join(', ');
  // Доля и цвета остаются в evidence и при зелёном результате: видно, насколько
  // фон близок к порогу.
  const output = `flatShare ${flatShare.toFixed(3)} (порог ${a.maxFlatShare}), точек ${total}, цвета: ${colors}`;
  if (flatShare <= a.maxFlatShare) return { ...passed(), flatShare, output };
  return {
    ...failed(
      `доля трёх самых частых цветов ${flatShare.toFixed(2)} > ${a.maxFlatShare} ` +
        `(${colors}): фон области — плоская заливка`,
    ),
    flatShare,
    output,
  };
}

/** Строки журнала, показываемые в отчёте о провале. */
const LOG_EXAMPLES = 5;

/** `log-forbid`: строки журнала, совпавшие с запретом и не разрешённые явно. */
export function evaluateLog(
  log: NonNullable<VisualSpec['log']>,
  lines: string[],
  /** Состояние, в окне журнала которого записана строка, если драйвер записал окна. */
  origin?: (index: number) => string | undefined,
): VisualOutcome {
  // Пустой журнал не доказывает отсутствие предупреждений: захват не подтверждён.
  if (!lines.some((line) => line.trim()))
    return environment('журнал прогона пуст: захват журнала не подтверждён');
  const forbid = log.forbid.map((p) => new RegExp(p, 'i'));
  const allow = log.allow.map((a) => new RegExp(a.pattern, 'i'));
  const allowed = log.allow.map(() => 0);
  const found: string[] = [];
  lines.forEach((line, index) => {
    if (!forbid.some((r) => r.test(line))) return;
    const by = allow.findIndex((r) => r.test(line));
    if (by >= 0) {
      allowed[by]++;
      return;
    }
    const text = line.slice(0, 300);
    found.push(origin ? `[${origin(index) ?? 'вне окон состояний'}] ${text}` : text);
  });
  // Число пропущенных каждым разрешением строк остаётся в evidence: слишком
  // широкое разрешение видно, даже когда testcase зелёный.
  const output = [
    `проверено строк журнала: ${lines.length}`,
    ...log.allow.map(
      (a, i) =>
        `разрешение ${JSON.stringify(a.pattern)} (${a.reason}): пропущено строк ${allowed[i]}`,
    ),
  ].join('\n');
  if (!found.length) return { ...passed(), output };
  return {
    ...failed(
      `запрещённых строк журнала: ${found.length}\n` + found.slice(0, LOG_EXAMPLES).join('\n'),
    ),
    output,
  };
}

// ---------------------------------------------------------------------------
// Прогон спецификации и JUnit.

export type VisualCase = VisualOutcome & { classname: string; name: string };

/** Наблюдения одного состояния; отсутствующий файл — `{ error }` от читателя. */
export type VisualStateInput =
  | { error: string }
  | { unreached: z.infer<typeof visualFramesErrorSchema> }
  | { frames: VisualFrames; screenshot?: VisualImage | { error: string } };

/** Журнал прогона: строки и, если известны, байтовые смещения их начал. */
export type VisualLogInput =
  | string[]
  | {
      lines: string[];
      /** Байтовый полуинтервал каждой строки в log.txt, включая перевод строки. */
      spans?: [number, number][];
      /** Размер log.txt в байтах: окна состояний не выходят за него. */
      size?: number;
    }
  | { error: string };

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
  log?: VisualLogInput,
): VisualCase[] {
  const cases: VisualCase[] = [];
  const decorative = new Set(spec.decorative);
  const windows: { state: string; from: number; to: number }[] = [];
  for (const s of spec.states) {
    const input = states[s.id] ?? { error: `драйвер не записал наблюдения состояния ${s.id}` };
    const observed =
      'frames' in input ? input.frames : 'unreached' in input ? input.unreached : undefined;
    if (observed?.log) windows.push({ state: s.id, ...observed.log });
    const reach = evaluateReach(s, input, decorative);
    cases.push({ classname: `visual.${s.id}`, name: VISUAL_REACH, ...reach });
    for (const a of s.assert) {
      const head = { classname: `visual.${s.id}`, name: assertionId(a) };
      const outcome = (): VisualOutcome => {
        if ('error' in input) return environment(input.error);
        if ('unreached' in input)
          return reach.status === 'failed'
            ? failed(`состояние не достигнуто: см. visual.${s.id}.${VISUAL_REACH}`)
            : environment(`драйвер: ${input.unreached.error}`);
        if (a.kind === 'visible') return evaluateVisible(a, input.frames);
        if (a.kind === 'tap-hits') return evaluateTapHits(a, input.frames, decorative);
        const shot = input.screenshot;
        if (!shot) return environment(`нет снимка экрана состояния ${s.id}`);
        if ('error' in shot) return environment(shot.error);
        const { status, message, output } = evaluateBackground(a, input.frames, shot);
        return { status, message, output };
      };
      cases.push({ ...head, ...outcome() });
    }
  }
  const rules = spec.log;
  if (rules) {
    const outcome = (): VisualOutcome => {
      if (!log) return environment('драйвер не записал журнал прогона');
      if ('error' in log) return environment(log.error);
      if (Array.isArray(log)) return evaluateLog(rules, log);
      const { spans, size } = log;
      const outside = size === undefined ? undefined : windows.find((w) => w.to > size);
      if (outside && size !== undefined)
        return environment(
          `окно журнала состояния ${outside.state} [${outside.from}, ${outside.to}) за пределами log.txt (${size} байт)`,
        );
      // Строка принадлежит окну, с которым пересекается её байтовый отрезок.
      const origin =
        spans && windows.length
          ? (index: number) =>
              windows.find((w) => spans[index][0] < w.to && spans[index][1] > w.from)?.state
          : undefined;
      return evaluateLog(rules, log.lines, origin);
    };
    cases.push({ ...VISUAL_LOG_CASE, ...outcome() });
  }
  return cases;
}

/** Символы, недопустимые в XML 1.0, удаляются; разметка экранируется. */
const xml = (value: string) =>
  value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
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
    const out = c.output ? `\n      <system-out>${xml(c.output)}</system-out>` : '';
    if (c.status === 'passed') return out ? `${open}>${out}\n    </testcase>` : `${open}/>`;
    const tag = c.status === 'failed' ? 'failure' : 'error';
    const type = c.status === 'failed' ? 'assertion' : 'environment';
    const message = c.message ?? '';
    return (
      `${open}>\n      <${tag} type="${type}" message="${attribute(message.split('\n')[0])}">` +
      `${xml(message)}</${tag}>${out}\n    </testcase>`
    );
  });
  const counts = `tests="${cases.length}" failures="${failures}" errors="${errors}" skipped="0"`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites ${counts}>\n` +
    `  <testsuite name="visual" ${counts}>\n${body.join('\n')}\n  </testsuite>\n</testsuites>\n`
  );
}
