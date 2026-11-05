import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
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
  type VisualTarget,
} from '../core/visual.ts';
import {
  BrokerError,
  type BrokerFrames,
  type BrokerHello,
  type VisualBroker,
} from './visual-broker.ts';
import { isVisualCase, observedCases, readVisualSpec, writeVisualReport } from './visual.ts';

/**
 * `devcontour visual run`: достигает состояний спецификации через device
 * broker, записывает наблюдения в формате `visual evaluate` (`frames.json`,
 * PNG, `log.txt`) и оценивает их теми же утверждениями.
 *
 * Драйвер не решает, прошла ли проверка: он только касается по координатам и
 * записывает, что видел. Касание, заблокированное клавиатурой или чужим
 * элементом, всё равно выполняется, как его выполнил бы пользователь, — и
 * становится доказательством провала `reach`.
 */

/** Наблюдения, которые пишет прогон: только эти имена очищаются перед новым. */
const OBSERVATION_FILE =
  /^(?:UI-[A-Za-z0-9-]+\.(?:frames\.json|png|after-[A-Za-z0-9_.-]+\.png)|log\.txt|run\.json)$/;
const POLL_MS = 250;

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

/** Состояние не достигнуто: причина пишется в frames.json как ошибка драйвера. */
class Unreached extends Error {}

type Snapshot = {
  frames: BrokerFrames;
  keyboard: Rect | null;
  /** id с ненулевой рамкой, пересекающей окно. */
  visible: string[];
};
type View = { visible: string[]; focused: BrokerFrames['focused'] };

function inside(path: string, cwd: string) {
  const rel = relative(cwd, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Очистка прежних наблюдений: только файлы с именами наблюдений, без рекурсии. */
async function freshDirectory(out: string) {
  await mkdir(out, { recursive: true });
  for (const entry of await readdir(out, { withFileTypes: true }))
    if (entry.isFile() && OBSERVATION_FILE.test(entry.name)) await rm(join(out, entry.name));
}

const view = (s: Snapshot): View => ({ visible: s.visible, focused: s.frames.focused });

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

  async snapshot(): Promise<Snapshot> {
    const frames = await this.broker.frames();
    const keyboard = await this.stableKeyboard();
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
      .map((id) => ({ id, frame: s.frames.elements[id] }));
    const chosen = readingOrder(candidates)[target.index];
    return chosen ? { ...chosen, candidates } : undefined;
  }

  /** Ждать цель до `timeoutMs` или конца бюджета состояния; не появилась — `missing`. */
  private async await(step: number, target: VisualTarget, timeoutMs?: number) {
    const until = Math.min(
      this.deadline,
      timeoutMs === undefined ? Infinity : this.now() + timeoutMs,
    );
    for (;;) {
      const s = await this.snapshot();
      const found = this.resolve(s, target);
      if (found) return { s, found };
      if (this.now() >= until) {
        this.missing = { step, target: targetLabel(target), visible: s.visible.slice(0, 200) };
        throw new Unreached(`цель шага ${step} ${targetLabel(target)} не появилась на экране`);
      }
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
    const after = await this.snapshot();
    this.stepTaps.push({ ...base, point, hit, before: view(s), after: view(after) });
    return after;
  }

  private async focusedText() {
    return (await this.broker.frames()).focused?.text ?? null;
  }

  /** Набор по одному символу с проверкой текста поля: симулятор теряет нажатия под нагрузкой. */
  async type(text: string) {
    const start = (await this.focusedText()) ?? '';
    for (let k = 0; k < text.length; k++) {
      await this.broker.typeText(text[k]);
      const want = text.slice(0, k + 1);
      let got = await this.focusedText();
      if (got === null || !got.endsWith(want)) {
        await this.sleep(500);
        got = await this.focusedText();
      }
      if (got === null || !got.endsWith(want))
        throw new Unreached(
          `набор ${JSON.stringify(text)}: после символа ${k + 1} текст поля ${JSON.stringify(got)} ` +
            `не оканчивается на ${JSON.stringify(want)} (было ${JSON.stringify(start)})`,
        );
    }
  }

  async clear(step: number, target: VisualTarget) {
    const after = await this.stepTap(step, target);
    const text = after.frames.focused?.text ?? '';
    if (text) await this.broker.typeText('\b'.repeat(text.length + 2));
    await this.sleep(this.settle);
    const left = await this.focusedText();
    if (left)
      throw new Unreached(`очистка поля ${targetLabel(target)}: осталось ${JSON.stringify(left)}`);
  }

  async wait(step: number, target: VisualTarget, timeoutMs?: number) {
    await this.await(step, target, timeoutMs);
  }

  /**
   * Прокрутка контейнера жестами до цели в его видимой части или до конца.
   * `to` — цель или зарезервированный id `end` (конец прокрутки).
   */
  async scroll(step: number, container: string, to: VisualTarget, maxSwipes: number) {
    for (let n = 0; ; n++) {
      const s = await this.snapshot();
      const frame = s.frames.elements[container];
      if (!frame) {
        this.missing = { step, target: container, visible: s.visible.slice(0, 200) };
        throw new Unreached(`контейнер прокрутки ${container} не на экране`);
      }
      const area = intersect(frame, s.frames.window);
      if (!area) throw new Unreached(`контейнер прокрутки ${container} вне окна`);
      const bottom = Math.min(area.y + area.height, s.keyboard?.y ?? Infinity);
      if (to !== 'end') {
        const goal = this.resolve(s, to);
        if (
          goal &&
          goal.frame.y >= area.y &&
          goal.frame.y + goal.frame.height <= bottom &&
          goal.frame.x >= area.x &&
          goal.frame.x + goal.frame.width <= area.x + area.width
        )
          return;
      }
      if (n >= maxSwipes)
        throw new Unreached(
          to === 'end'
            ? `прокрутка ${container}: конец не достигнут за ${maxSwipes} жестов`
            : `прокрутка ${container}: ${targetLabel(to)} не показан за ${maxSwipes} жестов`,
        );
      if (this.now() >= this.deadline)
        throw new Unreached(`прокрутка ${container}: бюджет состояния исчерпан`);
      const x = area.x + area.width / 2;
      const height = bottom - area.y;
      await this.broker.drag({ x, y: bottom - 0.2 * height }, { x, y: area.y + 0.2 * height });
      await this.sleep(Math.max(this.settle, 300));
      if (to === 'end') {
        const next = await this.snapshot();
        if (JSON.stringify(next.frames.elements) === JSON.stringify(s.frames.elements)) return;
      }
    }
  }

  /**
   * Касание утверждения `tap-hits`: центр видимой рамки, затем ожидание
   * объявленного эффекта не дольше 2 с. Оценщик сам решает, наступил ли
   * эффект и не изменился ли текст поля.
   */
  async tapHits(a: Extract<VisualState['assert'][number], { kind: 'tap-hits' }>) {
    const s = await this.snapshot();
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

/** Хост приложения в evidence; Expo Go не принимается для релиза. */
function hostCase(spec: VisualSpec, hello: BrokerHello, release: boolean): VisualCase {
  const head = { classname: 'visual.host', name: 'accepted' };
  const output = `host ${hello.host}, ${hello.device.model}, ${hello.device.runtime}, udid ${hello.device.udid}`;
  const declared = visualHost(spec);
  if (hello.host !== declared)
    return {
      ...head,
      status: 'error',
      message: `broker запускает приложение в ${hello.host}, а спецификация объявляет ${declared}`,
      output,
    };
  if (release && hello.host === 'expo-go')
    return {
      ...head,
      status: 'failed',
      message:
        'проверка уровня релиза не принимает Expo Go: нужна сборка dev-client (host: "dev-client")',
      output,
    };
  return { ...head, status: 'passed', output };
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
  const parsed = await readVisualSpec(resolve(input.cwd, input.spec));
  if (isVisualCase(parsed)) return writeVisualReport(report, [parsed]);
  const spec = parsed;
  await freshDirectory(out);
  const started = now();
  const evidence: Record<string, unknown> = {
    version: 1,
    platform: spec.platform,
    release: input.release === true,
    startedAt: new Date(started).toISOString(),
  };
  const finish = async (cases: VisualCase[]) => {
    evidence.durationMs = now() - started;
    await writeFile(join(out, 'run.json'), JSON.stringify(evidence, null, 2) + '\n');
    return writeVisualReport(report, cases);
  };
  const environment = (reason: string) => {
    evidence.environment = reason;
    return finish(environmentCases(spec, reason));
  };
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
    hello = await broker.hello();
    logStart = spec.log ? await broker.logSize() : 0;
  } catch (error) {
    return environment(error instanceof Error ? error.message : String(error));
  }
  evidence.host = hello.host;
  evidence.device = hello.device;
  const host = hostCase(spec, hello, input.release === true);
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
    const failure = async (error: string) => {
      let log = {};
      try {
        log = await window();
      } catch {
        // broker уже недоступен: окно журнала не известно.
      }
      await writeFile(
        file,
        JSON.stringify(
          {
            version: 1,
            state: state.id,
            error,
            stepTaps: driver.stepTaps,
            ...(driver.missing ? { missing: driver.missing } : {}),
            ...log,
          },
          null,
          1,
        ),
      );
    };
    if (dead) {
      await failure(dead);
      continue;
    }
    try {
      if (spec.log) from = (await broker.logSize()) - logStart;
      if (state.route)
        await broker.openURL(`${spec.app?.scheme}://${state.route.replace(/^\//, '')}`);
      for (const [index, step] of state.steps.entries()) {
        if ('launch' in step)
          await broker.launch(state.seed ? ['-DevContourSeed', state.seed] : []);
        else if ('tap' in step) await driver.stepTap(index, step.tap);
        else if ('clear' in step) await driver.clear(index, step.clear);
        else if ('type' in step) await driver.type(step.type);
        else if ('wait' in step) await driver.wait(index, step.wait, step.timeoutMs);
        else await driver.scroll(index, step.scroll, step.to, step.maxSwipes);
        await sleep(driver.settle);
      }
      const s = await driver.snapshot();
      await writeFile(join(out, `${state.id}.png`), await broker.screenshot());
      const taps: Record<string, unknown> = {};
      for (const a of state.assert) {
        if (a.kind !== 'tap-hits') continue;
        const name = a.name ?? a.kind;
        const tap = await driver.tapHits(a);
        if (!tap) continue;
        taps[name] = tap;
        await writeFile(join(out, `${state.id}.after-${name}.png`), await broker.screenshot());
      }
      await writeFile(
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
      if (error instanceof Unreached) await failure(error.message);
      else if (error instanceof BrokerError) {
        dead = `broker перестал отвечать: ${error.message}`;
        await failure(error.message);
      } else throw error;
    }
    timing[state.id] = now() - t0;
  }
  if (spec.log && !dead) {
    try {
      const { data } = await broker.logRead(logStart);
      await writeFile(join(out, 'log.txt'), data);
    } catch (error) {
      dead = error instanceof Error ? error.message : String(error);
    }
  }
  if (dead) evidence.environment = dead;
  return finish([host, ...(await observedCases(spec, out))]);
}
