import { timed } from './timing.ts';
import { runEnvironment, assertDependencies } from './dependencies.ts';
import { readFile, writeFile, mkdir, rm, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { command, git } from './process.ts';
import { digest, DevContour } from '../core/service.ts';
import type { Run, Gate, Evidence } from '../core/model.ts';
import { TaskFailure } from '../core/failure.ts';
/** Предел манифеста: полный список тестов крупного проекта в состояние не кладётся. */
const MANIFEST_LIMIT = 2000;
/** Текст провала testcase: атрибут message или содержимое элемента. */
function failureText(value: unknown): string {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === 'string') return first.trim().split('\n')[0];
  if (first && typeof first === 'object') {
    const node = first as Record<string, unknown>;
    const text = node['@_message'] ?? node['#text'];
    if (typeof text === 'string') return text.trim().split('\n')[0];
  }
  return '';
}
export function junitSummary(xml: string): {
  tests: number;
  failures: number;
  skipped: number;
  /** Имена провалившихся testcases: по ним различаются разные провалы. */
  failed: string[];
  /** Те же testcases с первыми словами сообщения о провале. */
  failedDetails: string[];
  /** Что именно выполнилось и с каким исходом. */
  cases: { id: string; status: 'passed' | 'failed' | 'skipped' }[];
  /** Список обрезан: отсутствие теста по нему доказать нельзя. */
  truncated: boolean;
} {
  if (xml.includes('<!DOCTYPE') || XMLValidator.validate(xml) !== true)
    throw new Error('Некорректный JUnit XML');
  const document = new XMLParser({ ignoreAttributes: false, processEntities: false }).parse(xml);
  const summary = {
    tests: 0,
    failures: 0,
    skipped: 0,
    failed: [] as string[],
    failedDetails: [] as string[],
    cases: [] as { id: string; status: 'passed' | 'failed' | 'skipped' }[],
    truncated: false,
  };
  function visit(value: unknown, key = '') {
    if (Array.isArray(value)) {
      value.forEach((v) => visit(v, key));
      return;
    }
    if (key === 'testcase') {
      summary.tests++;
      if (value && typeof value === 'object') {
        const named = value as Record<string, unknown>;
        const name = [named['@_classname'], named['@_name']].filter(Boolean).join('.');
        const broken = 'failure' in value || 'error' in value;
        if (broken) {
          summary.failures++;
          if (name && summary.failed.length < 10) {
            summary.failed.push(String(name));
            summary.failedDetails.push(
              [String(name), failureText(named['failure'] ?? named['error'])]
                .filter(Boolean)
                .join(': ')
                .slice(0, 200),
            );
          }
        }
        if ('skipped' in value) summary.skipped++;
        if (name) {
          if (summary.cases.length < MANIFEST_LIMIT)
            summary.cases.push({
              id: String(name),
              status: broken ? 'failed' : 'skipped' in value ? 'skipped' : 'passed',
            });
          else summary.truncated = true;
        }
      }
      return;
    }
    if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, k);
  }
  visit(document);
  if (!summary.tests) throw new Error('JUnit не содержит выполненных testcases');
  return summary;
}
/**
 * Короткая выжимка вывода провалившейся проверки.
 *
 * Полный лог лежит в артефакте, но исполнителю следующей попытки он не
 * доступен, а в отказ попадал только «Код выхода 1». Два разных провала одной
 * проверки выглядели одной причиной — предел одинаковых повторов исчерпывался
 * на несвязанных ошибках, и подсказка повтора не содержала ничего, кроме кода
 * возврата. Берутся последние содержательные строки обоих потоков: ошибку
 * одни инструменты пишут в stdout, другие в stderr, и одинаковое
 * предупреждение в одном потоке не должно закрывать ошибку в другом. Секреты
 * снимаются тем же redact, что и в логе; объём ограничен.
 */
function diagnostic(stderr: string, stdout: string, redact?: (value: string) => string) {
  const tail = (text: string) =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-4)
      // Каждая строка короткая: одна длинная строка одного потока иначе
      // съедает весь лимит и прячет ошибку другого.
      .map((line) => (line.length > 140 ? line.slice(0, 140) + '…' : line));
  const lines = [...tail(stdout), ...tail(stderr)];
  if (!lines.length) return '';
  const text = lines.join(' | ');
  return (redact ? redact(text) : text).slice(0, 600);
}
/** Упавшие testcases с их сообщениями — то, чем провалы отличаются друг от друга. */
function failedCases(counts: ReturnType<typeof junitSummary>, redact?: (value: string) => string) {
  const text = counts.failedDetails.join('; ');
  return (redact ? redact(text) : text).slice(0, 600);
}
/** Отчёт внутри worktree, прочитанный без выхода за его границы. */
async function readReport(reportPath: string, cwd: string) {
  const real = await realpath(reportPath);
  if (!real.startsWith((await realpath(cwd)) + sep))
    throw new Error('Report symlink выходит из worktree');
  const xml = await readFile(real, 'utf8');
  return { ...junitSummary(xml), xml };
}
export async function runGate(...args: Parameters<typeof executeGate>) {
  return timed(args[0], args[1], `${args[4]}-test:${args[5].id}`, () => executeGate(...args));
}
async function executeGate(
  h: DevContour,
  run: Run,
  cwd: string,
  sha: string,
  phase: Evidence['phase'],
  gate: Gate,
  artifactDir: string,
  signal: AbortSignal,
) {
  const gateCwd = gate.cwd ? await realpath(resolve(cwd, gate.cwd)) : await realpath(cwd);
  if (gateCwd !== (await realpath(cwd)) && !gateCwd.startsWith((await realpath(cwd)) + sep))
    throw new Error('Gate cwd выходит из worktree');
  const reportPath = gate.report ? resolve(cwd, gate.report.path) : undefined;
  if (reportPath) {
    await mkdir(join(reportPath, '..'), { recursive: true });
    const parent = await realpath(join(reportPath, '..'));
    if (!parent.startsWith((await realpath(cwd)) + sep))
      throw new Error('Report выходит из worktree');
    await rm(reportPath, { force: true });
  }
  let passed = false,
    summary = '',
    log = '',
    exitCode = -1,
    redact: ((value: string) => string) | undefined,
    manifest: ReturnType<typeof junitSummary> | undefined;
  try {
    const environment = runEnvironment(h.config, run, phase, cwd);
    redact = environment.redact;
    const result = await command(gate.command, gateCwd, {
      signal,
      timeoutMs: gate.timeoutMs,
      env: { ...environment.env, DEVCONTOUR_REPORT_PATH: reportPath },
      redact,
    });
    exitCode = result.code;
    log = result.stdout + '\n' + result.stderr;
    if (result.timedOut || signal.aborted)
      throw new Error('Проверка прервана или превысила timeout');
    if (result.code !== 0) {
      // Отчёт читается и при ненулевом коде: упавшие testcases — главная
      // причина провала, а многие раннеры пишут их только в отчёт. Код выхода
      // по-прежнему означает провал; повреждённый или отсутствующий отчёт
      // не заменяет исходную ошибку команды, а только не добавляет к ней.
      const counts = reportPath
        ? await readReport(reportPath, cwd).catch(() => undefined)
        : undefined;
      if (counts) manifest = counts;
      const parts = [
        `Код выхода ${result.code}`,
        counts?.failures ? `упали ${failedCases(counts, redact)}` : '',
        diagnostic(result.stderr, result.stdout, redact),
      ].filter(Boolean);
      throw new Error(parts.join(': '));
    }
    if (reportPath) {
      const counts = (manifest = await readReport(reportPath, cwd));
      summary = `${counts.tests} tests, ${counts.failures} failures, ${counts.skipped} skipped`;
      if (counts.failures || counts.skipped)
        throw new Error(summary + (counts.failures ? `: ${failedCases(counts, redact)}` : ''));
      await mkdir(artifactDir, { recursive: true });
      await writeFile(join(artifactDir, `${gate.id}.xml`), counts.xml);
    } else summary = 'Команда завершилась успешно';
    await assertDependencies(run.dependencies ?? []);
    if ((await git(cwd, 'rev-parse', 'HEAD')) !== sha) throw new Error('Gate изменил HEAD');
    if (await git(cwd, 'status', '--porcelain', '--untracked-files=no'))
      throw new Error('Gate изменил отслеживаемые файлы');
    passed = true;
  } catch (error) {
    summary = error instanceof Error ? error.message : String(error);
    log += '\n' + summary;
  }
  await mkdir(artifactDir, { recursive: true });
  const logPath = join(artifactDir, `${gate.id}.log`);
  await writeFile(logPath, log);
  h.evidence(run.id, run.token, {
    kind: 'test',
    phase,
    sha,
    gate: gate.id,
    passed,
    command: gate.command,
    exitCode,
    log: logPath,
    digest: digest(log),
    summary,
    // Манифест упавшей проверки тоже записывается: он показывает, какие
    // testcases упали. Подтвердить критерий он не может — evidence не passed.
    tests: manifest?.cases,
    testsTruncated: manifest?.truncated || undefined,
  });
  if (!passed) throw new TaskFailure('gate', `${phase}/${gate.id}: ${summary}`);
}
