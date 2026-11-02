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
async function logLines(directory: string): Promise<VisualLogInput> {
  try {
    const bytes = await bounded(join(directory, 'log.txt'), LOG_LIMIT);
    const lines: string[] = [],
      offsets: number[] = [];
    let start = 0;
    while (start <= bytes.length) {
      const end = bytes.indexOf(0x0a, start);
      const stop = end < 0 ? bytes.length : end;
      offsets.push(start);
      lines.push(bytes.toString('utf8', start, stop).replace(/\r$/, ''));
      if (end < 0) break;
      start = end + 1;
    }
    return { lines, offsets };
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

async function runCases(input: { spec: string; observations: string }): Promise<VisualCase[]> {
  let spec: VisualSpec;
  try {
    const text = (await bounded(input.spec, SPEC_LIMIT)).toString('utf8');
    spec = visualSpecSchema.parse(JSON.parse(text));
  } catch (error) {
    const issues =
      error && typeof error === 'object' && 'issues' in error && Array.isArray(error.issues)
        ? (error.issues as { path: PropertyKey[]; message: string }[])
            .slice(0, 10)
            .map((i) => `${i.path.map(String).join('.') || '(корень)'}: ${i.message}`)
            .join('\n')
        : message(error);
    return [
      { ...VISUAL_SPEC_CASE, status: 'failed', message: `спецификация не принята\n${issues}` },
    ];
  }
  const states: Record<string, VisualStateInput> = {};
  for (const state of spec.states) states[state.id] = await stateInput(input.observations, state);
  return evaluateVisual(spec, states, spec.log ? await logLines(input.observations) : undefined);
}

export async function evaluateVisualRun(input: {
  spec: string;
  observations: string;
  report: string;
}) {
  const cases = await runCases(input);
  await mkdir(dirname(input.report), { recursive: true });
  await writeFile(input.report, visualJunit(cases));
  const count = (status: VisualCase['status']) => cases.filter((c) => c.status === status).length;
  return {
    report: input.report,
    tests: cases.length,
    failures: count('failed'),
    errors: count('error'),
    passed: cases.length > 0 && count('passed') === cases.length,
    failed: cases
      .filter((c) => c.status !== 'passed')
      .map((c) => `${c.classname}.${c.name}: ${(c.message ?? '').split('\n')[0]}`),
  };
}
