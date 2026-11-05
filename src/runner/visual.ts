import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  evaluateVisual,
  visualFramesErrorSchema,
  visualFramesObservedSchema,
  visualJunit,
  visualSpecSchema,
  type VisualCase,
  type VisualImage,
  type VisualLogInput,
  type VisualSpec,
  type VisualStateInput,
} from '../core/visual.ts';
import { decodePng } from './png.ts';

/**
 * `devcontour visual evaluate`: утверждения спецификации над каталогом
 * наблюдений, записанным драйвером, и JUnit для `test` gate.
 *
 * Каталог наблюдений:
 * - `<stateId>.frames.json` — окно, safe area, клавиатура, рамки элементов,
 *   касания утверждений `tap-hits`;
 * - `<stateId>.png` или `<stateId>.rgba` (сырой RGBA, размер — поле
 *   `screenshot` в frames.json) — снимок экрана;
 * - `log.txt` — журнал прогона, если спецификация задаёт `log`.
 */

/** Пределы чтения: наблюдения пишет драйвер, но размер всё равно ограничен. */
const FRAMES_LIMIT = 2 * 1024 * 1024;
const SCREENSHOT_LIMIT = 64 * 1024 * 1024;
/** Журнал читается целиком: больше предела — ошибка, а не проверка начала. */
const LOG_LIMIT = 32 * 1024 * 1024;
const SPEC_LIMIT = 256 * 1024;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function bounded(path: string, limit: number) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${path} — не файл`);
  if (info.size > limit) throw new Error(`${path} больше ${limit} байт`);
  return readFile(path);
}
const missing = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

async function screenshot(
  directory: string,
  id: string,
  size: { width: number; height: number } | undefined,
): Promise<VisualImage | { error: string }> {
  try {
    return decodePng(await bounded(join(directory, `${id}.png`), SCREENSHOT_LIMIT));
  } catch (error) {
    if (!missing(error)) return { error: `снимок ${id}.png не читается: ${message(error)}` };
  }
  try {
    const data = await bounded(join(directory, `${id}.rgba`), SCREENSHOT_LIMIT);
    if (!size) return { error: `для ${id}.rgba нет размера screenshot в ${id}.frames.json` };
    if (data.length !== size.width * size.height * 4)
      return {
        error: `${id}.rgba: ${data.length} байт, ожидалось ${size.width * size.height * 4}`,
      };
    return { ...size, data: new Uint8Array(data.buffer, data.byteOffset, data.length) };
  } catch (error) {
    return missing(error)
      ? { error: `нет снимка экрана ${id}.png или ${id}.rgba` }
      : { error: `снимок ${id}.rgba не читается: ${message(error)}` };
  }
}

async function stateInput(
  directory: string,
  state: VisualSpec['states'][number],
): Promise<VisualStateInput> {
  let raw: unknown;
  try {
    raw = JSON.parse(
      (await bounded(join(directory, `${state.id}.frames.json`), FRAMES_LIMIT)).toString('utf8'),
    );
  } catch (error) {
    return {
      error: missing(error)
        ? `драйвер не записал ${state.id}.frames.json`
        : `${state.id}.frames.json не читается: ${message(error)}`,
    };
  }
  // Вариант выбирается по полю error: ошибка объединения схем не назвала бы,
  // какое поле наблюдений неверно.
  const schema =
    raw && typeof raw === 'object' && 'error' in raw
      ? visualFramesErrorSchema
      : visualFramesObservedSchema;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.map(String).join('.') || '(корень)';
    return { error: `${state.id}.frames.json не по формату: ${path}: ${issue?.message}` };
  }
  const frames = parsed.data;
  if (frames.state !== state.id)
    return { error: `${state.id}.frames.json описывает состояние ${frames.state}` };
  // Недостигнутое состояние несёт касания шагов: заблокированный шаг —
  // провал reach, а не ошибка окружения.
  if ('error' in frames) return { unreached: frames };
  // Снимок декодируется только там, где его читает утверждение.
  if (!state.assert.some((a) => a.kind === 'background')) return { frames };
  return { frames, screenshot: await screenshot(directory, state.id, frames.screenshot) };
}

/**
 * Строки журнала и байтовые смещения их начал: окна `log` в frames.json
 * задаются байтами `log.txt`, а не номерами строк.
 */
/** Управляющие последовательности ANSI (цвет, курсор) — не текст строки. */
const stripAnsi = (line: string) => line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');

async function logLines(directory: string): Promise<VisualLogInput> {
  try {
    const bytes = await bounded(join(directory, 'log.txt'), LOG_LIMIT);
    // NUL в тексте — почти наверняка UTF-16: как UTF-8 он прочитался бы
    // строками с нулями, и запрет не нашёл бы ни одного совпадения.
    if (bytes.includes(0))
      return { error: 'log.txt содержит байты NUL: журнал должен быть в UTF-8, не UTF-16' };
    const lines: string[] = [],
      spans: [number, number][] = [];
    // Строки разделяют \n, \r\n и одиночный \r (прогресс bundler перезаписывает
    // строку через \r); завершающий разделитель не даёт лишней пустой строки.
    let start = 0;
    while (start < bytes.length) {
      let stop = start;
      while (stop < bytes.length && bytes[stop] !== 0x0a && bytes[stop] !== 0x0d) stop++;
      let next = stop;
      if (bytes[next] === 0x0d) next++;
      if (bytes[next] === 0x0a && (next === stop || next === stop + 1)) next++;
      else if (next === stop && stop < bytes.length) next++;
      spans.push([start, Math.min(next, bytes.length)]);
      lines.push(stripAnsi(bytes.toString('utf8', start, stop)));
      start = next;
    }
    return { lines, spans, size: bytes.length };
  } catch (error) {
    return {
      error: missing(error)
        ? 'драйвер не записал журнал прогона log.txt'
        : `log.txt не читается: ${message(error)}`,
    };
  }
}

/** Некорректная спецификация — провал отчёта, а не отсутствие отчёта. */
export const VISUAL_SPEC_CASE = { classname: 'visual.spec', name: 'valid' } as const;

/** Спецификация из файла; неверная — провал `visual.spec.valid` с причиной. */
export async function readVisualSpec(path: string): Promise<VisualSpec | VisualCase> {
  try {
    const text = (await bounded(path, SPEC_LIMIT)).toString('utf8');
    return visualSpecSchema.parse(JSON.parse(text));
  } catch (error) {
    const issues =
      error && typeof error === 'object' && 'issues' in error && Array.isArray(error.issues)
        ? (error.issues as { path: PropertyKey[]; message: string }[])
            .slice(0, 10)
            .map((i) => `${i.path.map(String).join('.') || '(корень)'}: ${i.message}`)
            .join('\n')
        : message(error);
    return { ...VISUAL_SPEC_CASE, status: 'failed', message: `спецификация не принята\n${issues}` };
  }
}
export const isVisualCase = (value: VisualSpec | VisualCase): value is VisualCase =>
  'classname' in value;

/** Утверждения спецификации над каталогом наблюдений. */
export async function observedCases(spec: VisualSpec, observations: string) {
  const states: Record<string, VisualStateInput> = {};
  for (const state of spec.states) states[state.id] = await stateInput(observations, state);
  return evaluateVisual(spec, states, spec.log ? await logLines(observations) : undefined);
}

async function runCases(input: { spec: string; observations: string }): Promise<VisualCase[]> {
  const spec = await readVisualSpec(input.spec);
  return isVisualCase(spec) ? [spec] : observedCases(spec, input.observations);
}

/** JUnit прогона и сводка для stdout; `exitCode` различает провал и сбой окружения. */
export async function writeVisualReport(report: string, cases: VisualCase[]) {
  await mkdir(dirname(report), { recursive: true });
  await writeFile(report, visualJunit(cases));
  const count = (status: VisualCase['status']) => cases.filter((c) => c.status === status).length;
  const failures = count('failed'),
    errors = count('error');
  const passed = cases.length > 0 && count('passed') === cases.length;
  return {
    report,
    tests: cases.length,
    failures,
    errors,
    passed,
    /**
     * 0 — всё прошло; 1 — провал утверждения или пустой прогон; 75
     * (EX_TEMPFAIL) — провалов нет, но есть ошибки окружения.
     */
    exitCode: passed ? 0 : failures || !cases.length ? 1 : VISUAL_ENVIRONMENT_EXIT,
    failed: cases
      .filter((c) => c.status !== 'passed')
      .map((c) => `${c.classname}.${c.name}: ${(c.message ?? '').split('\n')[0]}`),
  };
}
/** Код выхода, когда не прошли только проверки с ошибкой окружения. */
export const VISUAL_ENVIRONMENT_EXIT = 75;

export async function evaluateVisualRun(input: {
  spec: string;
  observations: string;
  report: string;
}) {
  return writeVisualReport(input.report, await runCases(input));
}
