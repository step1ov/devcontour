import { mkdir, readdir, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  evaluateVisual,
  intersect,
  readingOrder,
  targetLabel,
  visualHost,
  type Rect,
  type VisualCase,
  type VisualHit,
  type VisualSpec,
  type VisualState,
  type VisualStepFailure,
  type VisualTarget,
} from '../core/visual.ts';
import {
  BrokerError,
  type BrokerDeviceRequest,
  type BrokerFrames,
  type BrokerHello,
  type VisualBroker,
} from './visual-broker.ts';
import {
  isVisualCase,
  observedCases,
  readVisualSpec,
  writeFresh,
  writeVisualReport,
} from './visual.ts';

/**
 * `devcontour visual run`: достигает состояний спецификации через device
 * broker, записывает наблюдения в формате `visual evaluate` (`frames.json`,
 * PNG, `log.txt`) и оценивает их теми же утверждениями.
 *
 * Драйвер не решает, прошла ли проверка: он только касается по координатам и
 * записывает, что видел. Касание, заблокированное клавиатурой или чужим
 * элементом, всё равно выполняется, как его выполнил бы пользователь, — и
 * становится доказательством провала `reach`. Экран, не ответивший на шаг
 * (набор, очистка, прокрутка), — тоже провал `reach`; ошибкой окружения
 * остаются только сбои broker, симулятора и связи.
 */

/** Наблюдения, которые пишет прогон: только эти имена очищаются перед новым. */
const OBSERVATION_FILE =
  /^(?:UI-[A-Za-z0-9-]+\.(?:frames\.json|png|after-[A-Za-z0-9_.-]+\.png)|log\.txt|run\.json)$/;
const POLL_MS = 250;
/** Предел кандидатов цели-префикса в записи касания (схема наблюдений). */
const CANDIDATES_LIMIT = 200;

export interface VisualRunInput {
  /** Путь спецификации. */
  spec: string;
  /** Каталог наблюдений внутри рабочего дерева, например `.reports/visual`. */
  out: string;
  /** JUnit gate, например `.reports/visual.xml`. */
  report: string;
  /** Рабочее дерево gate: `out` и `report` должны лежать внутри. */
  cwd: string;
  /** Проверка уровня релиза: Expo Go не принимается. */
  release?: boolean;
  /** Broker или причина, по которой его нет (ошибка окружения). */
  broker: VisualBroker | { error: string };
  platform?: NodeJS.Platform;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Состояние не достигнуто. Без `failure` и записи `missing` — сбой драйвера
 * (ошибка окружения); с `failure` — экран не ответил на шаг, провал `reach`.
 */
class Unreached extends Error {
  constructor(
    message: string,
    readonly failure?: VisualStepFailure,
  ) {
    super(message);
  }
}
const productFailure = (step: number, kind: VisualStepFailure['kind'], message: string) =>
  new Unreached(message, { step, kind, message });

type Snapshot = {
  frames: BrokerFrames;
  keyboard: Rect | null;
  /** id с ненулевой рамкой, пересекающей окно. */
  visible: string[];
};
type View = { visible: string[]; focused: { element: string; text: string } | null };

function inside(path: string, cwd: string) {
  const rel = relative(cwd, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Каталог внутри рабочего дерева и после разрешения ссылок: символическая
 * ссылка в пути увела бы запись наблюдений за пределы worktree.
 */
async function insideReal(path: string, cwd: string, name: string) {
  await mkdir(path, { recursive: true });
  const [real, root] = await Promise.all([realpath(path), realpath(cwd)]);
  if (real !== root && !inside(real, root))
    throw new Error(`${name} должен быть внутри рабочего дерева gate: ${path} ведёт в ${real}`);
}

/**
 * Очистка прежних наблюдений: только записи с именами наблюдений, без
 * рекурсии. Ссылка удаляется сама, без перехода по ней.
 */
async function freshDirectory(out: string) {
  for (const entry of await readdir(out, { withFileTypes: true }))
    if ((entry.isFile() || entry.isSymbolicLink()) && OBSERVATION_FILE.test(entry.name))
      await unlink(join(out, entry.name));
}

const view = (s: Snapshot): View => ({
  visible: s.visible,
  focused: s.frames.focused && { element: s.frames.focused.element, text: s.frames.focused.text },
});

/**
 * Кто примет касание, по договору драйвера без hit-test: точка в рамке
 * клавиатуры — клавиатура; иначе наименьшая рамка с id, содержащая точку,
 * кроме декоративных; иначе пустой участок.
 */
export function hitAt(
  snapshot: { frames: BrokerFrames; keyboard: Rect | null },
  point: { x: number; y: number },
  decorative: ReadonlySet<string>,
): VisualHit {
  const within = (r: Rect) =>
    point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height;
  if (snapshot.keyboard && within(snapshot.keyboard)) return { kind: 'keyboard' };
  let best: { id: string; frame: Rect } | undefined;
  for (const [id, frame] of Object.entries(snapshot.frames.elements)) {
    if (decorative.has(id) || frame.width <= 0 || frame.height <= 0 || !within(frame)) continue;
    if (!best || frame.width * frame.height < best.frame.width * best.frame.height)
      best = { id, frame };
  }
  return best ? { kind: 'element', element: best.id, frame: best.frame } : { kind: 'none' };
}

const centre = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const length = (text: string) => Array.from(text).length;

class StateDriver {
  readonly stepTaps: Record<string, unknown>[] = [];
  missing: { step: number; target: string; visible: string[] } | undefined;

  constructor(
    private readonly broker: VisualBroker,
    private readonly spec: VisualSpec,
    private readonly deadline: number,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly now: () => number,
  ) {}

  get settle() {
    return this.spec.defaults.settleMs;
  }

  /**
   * Бюджет состояния проверяется после обращений к broker: прогон должен
   * закончиться отчётом раньше, чем gate снимут по timeout.
   */
  checkBudget(what: string) {
    if (this.now() > this.deadline) throw new Unreached(`бюджет состояния исчерпан: ${what}`);
  }

  /**
   * Снимок экрана. `stable` — для измерения и касания: клавиатура не
   * меняется два чтения подряд, затем рамки элементов читаются, пока два
   * снимка подряд не совпадут (не больше трёх чтений). Опрос при ожидании
   * цели обходится без этого.
   */
  async snapshot(stable = false): Promise<Snapshot> {
    let keyboard = stable ? await this.stableKeyboard() : await this.broker.keyboardFrame();
    let frames = await this.broker.frames();
    if (stable) {
      for (let i = 0; i < 2; i++) {
        await this.sleep(200);
        const next = await this.broker.frames();
        const same = JSON.stringify(next) === JSON.stringify(frames);
        frames = next;
        if (same) break;
      }
      keyboard = await this.broker.keyboardFrame();
    }
    const visible = Object.entries(frames.elements)
      .filter(([, f]) => f.width > 0 && f.height > 0 && intersect(f, frames.window))
      .map(([id]) => id);
    return { frames, keyboard, visible };
  }

  /** Анимация клавиатуры: две одинаковые рамки подряд через 200 мс, не больше пяти чтений. */
  private async stableKeyboard() {
    let last = await this.broker.keyboardFrame();
    for (let i = 0; i < 4; i++) {
      await this.sleep(200);
      const next = await this.broker.keyboardFrame();
      if (JSON.stringify(next) === JSON.stringify(last)) return next;
      last = next;
    }
    return last;
  }

  /** Цель на экране: id или `index`-й по порядку чтения элемент с префиксом. */
  private resolve(s: Snapshot, target: VisualTarget) {
    if (typeof target === 'string') {
      const frame = s.frames.elements[target];
      return frame ? { id: target, frame } : undefined;
    }
    const candidates = s.visible
      .filter((id) => id.startsWith(target.prefix))
      .map((id) => ({ id, frame: s.frames.elements[id] }))
      .slice(0, CANDIDATES_LIMIT);
    const chosen = readingOrder(candidates)[target.index];
    return chosen ? { ...chosen, candidates } : undefined;
  }

  private missingAt(step: number, label: string, s: Snapshot) {
    this.missing = { step, target: label, visible: s.visible.slice(0, 200) };
    return new Unreached(`цель шага ${step} ${label} не появилась на экране`);
  }

  /** Ждать цель до `timeoutMs` или конца бюджета состояния; не появилась — `missing`. */
  private async await(step: number, target: VisualTarget, timeoutMs?: number) {
    const until = Math.min(
      this.deadline,
      timeoutMs === undefined ? Infinity : this.now() + timeoutMs,
    );
    for (;;) {
      const s = await this.snapshot();
      if (this.resolve(s, target)) {
        // Найдена: измерение и касание — по устойчивому снимку.
        const settled = await this.snapshot(true);
        const found = this.resolve(settled, target);
        if (found) return { s: settled, found };
      }
      if (this.now() >= until) throw this.missingAt(step, targetLabel(target), s);
      await this.sleep(POLL_MS);
    }
  }

  /** Касание шага по центру видимой рамки цели; запись — доказательство для `reach`. */
  async stepTap(step: number, target: VisualTarget) {
    const { s, found } = await this.await(step, target);
    const visibleFrame = intersect(found.frame, s.frames.window);
    const base = {
      step,
      element: found.id,
      frame: found.frame,
      window: s.frames.window,
      keyboard: s.keyboard,
      ...('candidates' in found ? { candidates: found.candidates } : {}),
    };
    if (!visibleFrame) {
      this.stepTaps.push({ ...base, point: null });
      throw new Unreached(`цель шага ${step} ${found.id} вне окна`);
    }
    const point = centre(visibleFrame);
    const hit = hitAt(s, point, new Set(this.spec.decorative));
    await this.broker.tapPoint(point.x, point.y);
    await this.sleep(this.settle);
    const after = await this.snapshot(true);
    this.stepTaps.push({ ...base, point, hit, before: view(s), after: view(after) });
    return { id: found.id, after };
  }

  private async focused() {
    return (await this.broker.frames()).focused;
  }

  /**
   * Набор по одному символу с проверкой поля после каждого: симулятор
   * теряет нажатия под нагрузкой, поэтому одна повторная проверка через
   * 500 мс. Поле не в фокусе, фокус ушёл или текст не тот — экран не принял
   * набор: провал шага. У поля пароля (`secure`) платформа отдаёт маску,
   * поэтому сравнивается длина.
   */
  async type(step: number, text: string) {
    const start = await this.focused();
    if (!start)
      throw productFailure(step, 'type', `набор ${JSON.stringify(text)}: нет поля в фокусе`);
    const chars = Array.from(text);
    const initial = length(start.text);
    for (let k = 0; k < chars.length; k++) {
      await this.broker.typeText(chars[k]);
      const want = chars.slice(0, k + 1).join('');
      const ok = (f: BrokerFrames['focused']) =>
        !!f &&
        f.element === start.element &&
        (f.secure ? length(f.text) === initial + k + 1 : f.text.endsWith(want));
      let got = await this.focused();
      if (!ok(got)) {
        await this.sleep(500);
        got = await this.focused();
      }
      if (!ok(got)) {
        const field = !got
          ? `поле ${start.element} потеряло фокус`
          : got.element !== start.element
            ? `фокус ушёл с ${start.element} на ${got.element}`
            : got.secure
              ? `длина поля ${start.element} ${length(got.text)}, ожидалось ${initial + k + 1}`
              : `текст поля ${start.element} ${JSON.stringify(got.text)} не оканчивается на ${JSON.stringify(want)}`;
        throw productFailure(
          step,
          'type',
          `набор ${JSON.stringify(start.secure ? '•'.repeat(chars.length) : text)}: после символа ${k + 1} ${field}`,
        );
      }
      this.checkBudget(`набор в ${start.element}`);
    }
  }

  /** Очистка: касание цели, в фокусе должна оказаться она; после удаления поле пусто. */
  async clear(step: number, target: VisualTarget) {
    const { id, after } = await this.stepTap(step, target);
    const field = after.frames.focused;
    if (!field || field.element !== id)
      throw productFailure(
        step,
        'clear',
        `после касания ${id} в фокусе ${field ? field.element : 'нет поля'}, а не ${id}`,
      );
    if (field.text) await this.broker.typeText('\b'.repeat(length(field.text) + 2));
    await this.sleep(this.settle);
    const left = await this.focused();
    if (!left || left.element !== id)
      throw productFailure(step, 'clear', `после удаления текста ${id} потерял фокус`);
    if (left.text)
      throw productFailure(
        step,
        'clear',
        `очистка ${id}: осталось ${left.secure ? `${length(left.text)} символов` : JSON.stringify(left.text)}`,
      );
  }

  async wait(step: number, target: VisualTarget, timeoutMs?: number) {
    await this.await(step, target, timeoutMs);
  }

  /**
   * Прокрутка контейнера жестами до цели в его видимой части или до конца.
   * `to` — цель или зарезервированный id `end`. Экран, на котором прокрутка
   * не дошла, — провал шага; цели нет в дереве вовсе — запись `missing` с
   * той же целью, что называет шаг.
   */
  async scroll(step: number, container: string, to: VisualTarget, maxSwipes: number) {
    for (let n = 0; ; n++) {
      const s = await this.snapshot(true);
      const frame = s.frames.elements[container];
      if (!frame) {
        if (to === 'end') throw this.missingAt(step, container, s);
        throw productFailure(step, 'scroll', `контейнер прокрутки ${container} не на экране`);
      }
      const area = intersect(frame, s.frames.window);
      if (!area) throw productFailure(step, 'scroll', `контейнер прокрутки ${container} вне окна`);
      const bottom = Math.min(area.y + area.height, s.keyboard?.y ?? Infinity);
      const goal = to === 'end' ? undefined : this.resolve(s, to);
      if (
        goal &&
        goal.frame.y >= area.y &&
        goal.frame.y + goal.frame.height <= bottom &&
        goal.frame.x >= area.x &&
        goal.frame.x + goal.frame.width <= area.x + area.width
      )
        return;
      if (n >= maxSwipes) {
        if (to === 'end')
          throw productFailure(
            step,
            'scroll',
            `прокрутка ${container}: конец не достигнут за ${maxSwipes} жестов`,
          );
        if (!goal) throw this.missingAt(step, targetLabel(to), s);
        throw productFailure(
          step,
          'scroll',
          `прокрутка ${container}: ${targetLabel(to)} не показан в видимой части за ${maxSwipes} жестов`,
        );
      }
      this.checkBudget(`прокрутка ${container}`);
      const x = area.x + area.width / 2;
      const height = bottom - area.y;
      await this.broker.drag({ x, y: bottom - 0.2 * height }, { x, y: area.y + 0.2 * height });
      await this.sleep(Math.max(this.settle, 300));
      if (to === 'end') {
        const next = await this.snapshot(true);
        if (JSON.stringify(next.frames.elements) === JSON.stringify(s.frames.elements)) return;
      }
    }
  }

  /**
   * Касание утверждения `tap-hits` (одно на состояние): центр видимой рамки
   * по тому же снимку, по которому записаны рамки состояния, затем ожидание
   * объявленного эффекта не дольше 2 с. Оценщик сам решает, наступил ли
   * эффект и не изменился ли текст поля.
   */
  async tapHits(a: Extract<VisualState['assert'][number], { kind: 'tap-hits' }>, s: Snapshot) {
    const frame = s.frames.elements[a.element];
    const visibleFrame = frame && intersect(frame, s.frames.window);
    if (!visibleFrame) return undefined;
    const point = centre(visibleFrame);
    const hit = hitAt(s, point, new Set(this.spec.decorative));
    await this.broker.tapPoint(point.x, point.y);
    const until = this.now() + Math.max(this.settle, 2000);
    let after: Snapshot;
    for (;;) {
      await this.sleep(Math.min(this.settle || POLL_MS, POLL_MS));
      after = await this.snapshot();
      const done =
        'visible' in a.expect
          ? after.visible.includes(a.expect.visible)
          : !after.visible.includes(a.expect.hidden);
      if (done || this.now() >= until) break;
    }
    return { element: a.element, point, hit, before: view(s), after: view(after) };
  }
}

/** Ошибка окружения на все объявленные проверки: каждая называет причину. */
function environmentCases(spec: VisualSpec, reason: string): VisualCase[] {
  const states = Object.fromEntries(spec.states.map((s) => [s.id, { error: reason }]));
  return evaluateVisual(spec, states, spec.log ? { error: reason } : undefined);
}

const HOST_CASE = { classname: 'visual.host', name: 'accepted' } as const;
const RELEASE_EXPO =
  'проверка уровня релиза не принимает Expo Go: нужна сборка dev-client (host: "dev-client")';

/** Требования спецификации к устройству для `hello`: broker настраивает устройство по ним. */
function deviceRequest(spec: VisualSpec): BrokerDeviceRequest {
  const d = spec.device ?? {};
  return Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined));
}
const sameLocale = (a: string, b: string) =>
  a.replace(/-/g, '_').toLowerCase() === b.replace(/-/g, '_').toLowerCase();
/** `iOS 18` допускает `iOS 18.5`; `iOS 18.5` — только её и `iOS 18.5.x`. */
const sameRuntime = (declared: string, actual: string) => {
  const a = declared.trim().toLowerCase(),
    b = actual.trim().toLowerCase();
  return b === a || b.startsWith(a + '.');
};

/** Расхождения устройства broker со спецификацией. */
export function deviceProblems(spec: VisualSpec, hello: BrokerHello): string[] {
  const d = spec.device;
  if (!d) return [];
  const problems: string[] = [];
  if (d.model && d.model !== hello.device.model)
    problems.push(`модель ${hello.device.model}, а спецификация требует ${d.model}`);
  if (d.runtime && !sameRuntime(d.runtime, hello.device.runtime))
    problems.push(`среда ${hello.device.runtime}, а спецификация требует ${d.runtime}`);
  if (d.appearance && d.appearance !== hello.device.appearance)
    problems.push(`оформление ${hello.device.appearance}, а спецификация требует ${d.appearance}`);
  if (d.locale && !sameLocale(d.locale, hello.device.locale))
    problems.push(`локаль ${hello.device.locale}, а спецификация требует ${d.locale}`);
  return problems;
}

export async function visualRun(input: VisualRunInput) {
  const sleep = input.sleep ?? realSleep;
  const now = input.now ?? Date.now;
  const out = resolve(input.cwd, input.out);
  const report = resolve(input.cwd, input.report);
  for (const [name, path] of [
    ['--out', out],
    ['--report', report],
  ] as const)
    if (!inside(path, input.cwd))
      throw new Error(`${name} должен быть внутри рабочего дерева gate: ${path}`);
  await insideReal(out, input.cwd, '--out');
  await insideReal(dirname(report), input.cwd, '--report');
  // Прежние наблюдения удаляются до разбора спецификации: отчёт о неверной
  // спецификации не должен соседствовать со снимками прошлого прогона.
  await freshDirectory(out);
  const started = now();
  const evidence: Record<string, unknown> = {
    version: 1,
    release: input.release === true,
    startedAt: new Date(started).toISOString(),
  };
  const finish = async (cases: VisualCase[]) => {
    evidence.durationMs = now() - started;
    await writeFresh(join(out, 'run.json'), JSON.stringify(evidence, null, 2) + '\n');
    return writeVisualReport(report, cases);
  };
  const parsed = await readVisualSpec(resolve(input.cwd, input.spec));
  if (isVisualCase(parsed)) return finish([parsed]);
  const spec = parsed;
  evidence.platform = spec.platform;
  const environment = (reason: string, head: VisualCase[] = []) => {
    evidence.environment = reason;
    return finish([...head, ...environmentCases(spec, reason)]);
  };
  // Expo Go в проверке релиза отклоняется до обращения к broker: это
  // решение по спецификации, а не наблюдение.
  if (input.release && visualHost(spec) === 'expo-go')
    return environment('проверка не выполнялась: спецификация объявляет Expo Go для релиза', [
      { ...HOST_CASE, status: 'failed', message: RELEASE_EXPO },
    ]);
  if (spec.platform === 'web')
    return environment(
      'драйвер web для visual run ещё не реализован: доступна только платформа ios',
    );
  const platform = input.platform ?? process.platform;
  if (platform !== 'darwin')
    return environment(
      `iOS-симулятор доступен только на macOS, а gate выполняется на ${platform}: проверка не пропускается и не считается пройденной`,
    );
  if ('error' in input.broker) return environment(input.broker.error);
  const broker = input.broker;
  let hello: BrokerHello;
  let logStart: number;
  try {
    hello = await broker.hello(deviceRequest(spec));
    logStart = spec.log ? await broker.logSize() : 0;
  } catch (error) {
    return environment(error instanceof Error ? error.message : String(error));
  }
  evidence.host = hello.host;
  evidence.device = hello.device;
  const d = hello.device;
  const output = `host ${hello.host}, ${d.model}, ${d.runtime}, ${d.appearance}, ${d.locale}, udid ${d.udid}`;
  // Expo Go, о котором сообщил broker, в проверке релиза — провал: такой
  // прогон не доказывает работу сборки, которую получит пользователь.
  if (input.release && hello.host === 'expo-go')
    return environment('проверка не выполнялась: broker запускает приложение в Expo Go', [
      { ...HOST_CASE, status: 'failed', message: RELEASE_EXPO, output },
    ]);
  // Не тот хост или не то устройство — измерения были бы о другом экране:
  // ни одна проверка не выполняется и не может стать зелёной.
  const declared = visualHost(spec);
  const mismatch = [
    ...(hello.host !== declared
      ? [`broker запускает приложение в ${hello.host}, а спецификация объявляет ${declared}`]
      : []),
    ...deviceProblems(spec, hello),
  ];
  if (mismatch.length) {
    const reason = `устройство broker не соответствует спецификации: ${mismatch.join('; ')}`;
    return environment(reason, [{ ...HOST_CASE, status: 'error', message: reason, output }]);
  }
  const host: VisualCase = { ...HOST_CASE, status: 'passed', output };
  const timing: Record<string, number> = {};
  evidence.timingMs = timing;
  let dead: string | undefined;
  for (const state of spec.states) {
    const t0 = now();
    const budget = state.timeoutMs ?? spec.defaults.stateTimeoutMs;
    const driver = new StateDriver(broker, spec, t0 + budget, sleep, now);
    const file = join(out, `${state.id}.frames.json`);
    let from = 0;
    const window = async () => {
      if (!spec.log) return {};
      const to = (await broker.logSize()) - logStart;
      return { log: { from, to: Math.max(from, to) } };
    };
    const unreached = async (error: string, failure?: VisualStepFailure) => {
      let log = {};
      try {
        log = await window();
      } catch {
        // broker уже недоступен: окно журнала не известно.
      }
      await writeFresh(
        file,
        JSON.stringify(
          {
            version: 1,
            state: state.id,
            error,
            stepTaps: driver.stepTaps,
            ...(driver.missing ? { missing: driver.missing } : {}),
            ...(failure ? { failure } : {}),
            ...log,
          },
          null,
          1,
        ),
      );
    };
    if (dead) {
      await unreached(dead);
      continue;
    }
    try {
      if (spec.log) from = (await broker.logSize()) - logStart;
      // route открывается после последнего запуска: запуск начинает
      // приложение с первого экрана, и открытый до него deep link потерялся бы.
      const lastLaunch = state.steps.findLastIndex((step) => 'launch' in step);
      const openRoute = async () => {
        if (state.route)
          await broker.openURL(`${spec.app?.scheme}://${state.route.replace(/^\//, '')}`);
      };
      if (lastLaunch < 0) await openRoute();
      for (const [index, step] of state.steps.entries()) {
        if ('launch' in step) {
          await broker.launch(state.seed ? ['-DevContourSeed', state.seed] : []);
          if (index === lastLaunch) await openRoute();
        } else if ('tap' in step) await driver.stepTap(index, step.tap);
        else if ('clear' in step) await driver.clear(index, step.clear);
        else if ('type' in step) await driver.type(index, step.type);
        else if ('wait' in step) await driver.wait(index, step.wait, step.timeoutMs);
        else await driver.scroll(index, step.scroll, step.to, step.maxSwipes);
        // Касание уже выждало settle; остальные шаги — здесь.
        if (!('tap' in step) && !('clear' in step)) await sleep(driver.settle);
        driver.checkBudget(`шаг ${index}`);
      }
      const s = await driver.snapshot(true);
      await writeFresh(join(out, `${state.id}.png`), await broker.screenshot());
      const taps: Record<string, unknown> = {};
      for (const a of state.assert) {
        if (a.kind !== 'tap-hits') continue;
        const name = a.name ?? a.kind;
        const tap = await driver.tapHits(a, s);
        if (!tap) continue;
        taps[name] = tap;
        await writeFresh(join(out, `${state.id}.after-${name}.png`), await broker.screenshot());
      }
      await writeFresh(
        file,
        JSON.stringify(
          {
            version: 1,
            state: state.id,
            window: s.frames.window,
            safeArea: s.frames.safeArea,
            keyboard: s.keyboard,
            elements: s.frames.elements,
            taps,
            stepTaps: driver.stepTaps,
            ...(await window()),
          },
          null,
          1,
        ),
      );
    } catch (error) {
      if (error instanceof Unreached) await unreached(error.message, error.failure);
      else if (error instanceof BrokerError) {
        dead = `broker перестал отвечать: ${error.message}`;
        await unreached(error.message);
      } else throw error;
    }
    timing[state.id] = now() - t0;
  }
  if (spec.log && !dead) {
    try {
      const { data } = await broker.logRead(logStart);
      await writeFresh(join(out, 'log.txt'), data);
    } catch (error) {
      dead = error instanceof Error ? error.message : String(error);
    }
  }
  if (dead) evidence.environment = dead;
  return finish([host, ...(await observedCases(spec, out))]);
}
