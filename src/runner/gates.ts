import { timed } from './timing.ts';
import { runEnvironment, assertDependencies } from './dependencies.ts';
import { readFile, writeFile, mkdir, mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { isolation, isolatedCommand, isolationSupport } from './isolation.ts';
import { join, resolve, sep, delimiter } from 'node:path';
import { accessSync, constants } from 'node:fs';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { command, git } from './process.ts';
import { digest, DevContour } from '../core/service.ts';
import type { Run, Gate, Evidence } from '../core/model.ts';
import { TaskFailure } from '../core/failure.ts';
/** Предел манифеста: полный список тестов крупного проекта в состояние не кладётся. */
const MANIFEST_LIMIT = 2000;
/** Предел имени testcase: столько же переносит receipt между клонами. */
const ID_LIMIT = 1000;
/**
 * Полный текст провала testcase: атрибут message или содержимое элемента.
 * Первая строка выделяется после redaction: многострочный секрет, обрезанный
 * до первой строки раньше, redactor уже не узнал бы.
 */
function failureText(value: unknown): string {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object') {
    const node = first as Record<string, unknown>;
    const text = node['@_message'] ?? node['#text'];
    if (typeof text === 'string') return text;
  }
  return '';
}
/**
 * Сводка JUnit-отчёта.
 *
 * `redact` применяется к именам и сообщениям до любой обрезки: обрезанный
 * секрет redactor уже не узнаёт, и в сводке оставался бы его префикс. Имя
 * testcase тоже проходит redact — оно попадает в состояние, журнал и API.
 * Изменённое так имя не совпадёт с названным критерием, и подтверждения
 * не будет: для секрета в имени теста это правильный исход.
 */
export function junitSummary(
  xml: string,
  redact: (value: string) => string = (value) => value,
): {
  tests: number;
  failures: number;
  skipped: number;
  /** Имена провалившихся testcases: по ним различаются разные провалы. */
  failed: string[];
  /** Те же testcases с первыми словами сообщения о провале. */
  failedDetails: string[];
  /** Что именно выполнилось и с каким исходом. */
  cases: NonNullable<Evidence['tests']>;
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
    cases: [] as NonNullable<Evidence['tests']>,
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
        const raw = [named['@_classname'], named['@_name']].filter(Boolean).join('.');
        const redacted = redact(raw);
        // Длинное имя заменяется хешем: обрезка дала бы коллизии и ложные
        // совпадения, а без замены receipt не перенёс бы манифест.
        const name =
          redacted.length > ID_LIMIT
            ? 'sha256:' + createHash('sha256').update(redacted).digest('hex')
            : redacted;
        const opaque = name !== raw;
        const broken = 'failure' in value || 'error' in value;
        if (broken) {
          summary.failures++;
          if (name && summary.failed.length < 10) {
            summary.failed.push(String(name));
            summary.failedDetails.push(
              [
                String(name),
                redact(failureText(named['failure'] ?? named['error']))
                  .trim()
                  .split('\n')[0],
              ]
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
              ...(opaque ? { opaque: true as const } : {}),
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
  // У каждого потока свой бюджет: общий лимит, заполняемый по очереди,
  // позволял нескольким длинным строкам одного потока вытеснить ошибку
  // другого. Redact — до обрезки, иначе префикс секрета остаётся.
  const tail = (text: string) => {
    const joined = text
      .split('\n')
      .map((line) => (redact ? redact(line) : line).trim())
      .filter(Boolean)
      .slice(-4)
      .map((line) => (line.length > 140 ? line.slice(0, 140) + '…' : line))
      .join(' | ');
    return joined.length > 290 ? '…' + joined.slice(-290) : joined;
  };
  return [tail(stdout), tail(stderr)].filter(Boolean).join(' | ');
}
/** Упавшие testcases с их сообщениями — то, чем провалы отличаются друг от друга. */
function failedCases(counts: ReturnType<typeof junitSummary>) {
  return counts.failedDetails.join('; ').slice(0, 600);
}
/** Песочница отказала до запуска команды: вывода команды нет, причина — поиск shell. */
export function sandboxNotStarted(
  argv: string[],
  result: { code: number; stdout: string; stderr: string },
) {
  return (
    argv[1]?.includes('sandbox-runtime') === true &&
    result.code !== 0 &&
    !result.stdout.trim() &&
    /^Error: Shell '[^']+' not found in PATH\s*$/.test(result.stderr.trim())
  );
}
/** Команда проверки находится — иначе ENOENT, как при обычном запуске. */
function assertExecutable(name: string, path: string | undefined, cwd: string) {
  const candidates = name.includes('/')
    ? [resolve(cwd, name)]
    : (path ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => join(dir, name));
  if (
    !candidates.some((file) => {
      try {
        accessSync(file, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    })
  )
    throw new Error(`spawn ${name} ENOENT`);
}
/** Отчёт внутри worktree, прочитанный без выхода за его границы. */
async function readReport(reportPath: string, cwd: string, redact?: (value: string) => string) {
  const real = await realpath(reportPath);
  if (!real.startsWith((await realpath(cwd)) + sep))
    throw new Error('Report symlink выходит из worktree');
  const xml = await readFile(real, 'utf8');
  return { ...junitSummary(xml, redact), xml };
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
  /** Каталоги контура — база, worktrees, артефакты: проверке они закрыты. */
  controller: string[] = [],
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
  // Временный каталог проверки: единственное место записи вне worktree.
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'dc-gate-')));
  try {
    const environment = runEnvironment(h.config, run, phase, cwd);
    redact = environment.redact;
    let argv = gate.command,
      env: NodeJS.ProcessEnv = { ...environment.env, DEVCONTOUR_REPORT_PATH: reportPath };
    // Проверка исполняется в песочнице ОС. Прежде она шла обычным процессом
    // хоста и могла читать базу контура и соседние файлы, писать вне
    // worktree и ходить в сеть: сверка HEAD и отслеживаемых файлов после неё
    // этого не видит. Без механизма песочницы проверка не запускается —
    // снять изоляцию можно только явным isolation.mode: none.
    if (h.config.isolation.mode === 'os') {
      const support = isolationSupport();
      if (!support.ok)
        throw new Error(
          `Изоляция проверок недоступна: ${support.detail}. Установите зависимости или явно задайте isolation.mode: none`,
        );
      // Отсутствующая команда внутри песочницы выглядела бы как «код 127»
      // от обёртки. Причина та же, что и без неё, — называем её так же.
      assertExecutable(gate.command[0], env.PATH, gateCwd);
      const policy = isolation({
        write: [cwd, scratch],
        controller,
        readable: (run.dependencies ?? []).map((d) => d.path),
        domains: h.config.isolation.domains,
      });
      const wrapped = await isolatedCommand(
        policy,
        gate.command,
        join(artifactDir, gate.id),
        scratch,
      );
      argv = wrapped.argv;
      env = { ...env, ...wrapped.env };
    }
    const execute = () =>
      command(argv, gateCwd, { signal, timeoutMs: gate.timeoutMs, env, redact });
    let result = await execute();
    // sandbox-runtime ищет shell через `which` с таймаутом в секунду и под
    // нагрузкой отказывает до запуска команды. Команда проверки при этом не
    // исполнялась, поэтому повтор безопасен; любой другой отказ — итог.
    for (let attempt = 1; attempt < 3 && sandboxNotStarted(argv, result); attempt++) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
      result = await execute();
    }
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
        ? await readReport(reportPath, cwd, redact).catch(() => undefined)
        : undefined;
      if (counts) manifest = counts;
      const parts = [
        `Код выхода ${result.code}`,
        counts?.failures ? `упали ${failedCases(counts)}` : '',
        diagnostic(result.stderr, result.stdout, redact),
      ].filter(Boolean);
      throw new Error(parts.join(': '));
    }
    if (reportPath) {
      const counts = (manifest = await readReport(reportPath, cwd, redact));
      summary = `${counts.tests} tests, ${counts.failures} failures, ${counts.skipped} skipped`;
      if (counts.failures || counts.skipped)
        throw new Error(summary + (counts.failures ? `: ${failedCases(counts)}` : ''));
      await mkdir(artifactDir, { recursive: true });
      await writeFile(
        join(artifactDir, `${gate.id}.xml`),
        redact ? redact(counts.xml) : counts.xml,
      );
    } else summary = 'Команда завершилась успешно';
    await assertDependencies(run.dependencies ?? []);
    if ((await git(cwd, 'rev-parse', 'HEAD')) !== sha) throw new Error('Gate изменил HEAD');
    if (await git(cwd, 'status', '--porcelain', '--untracked-files=no'))
      throw new Error('Gate изменил отслеживаемые файлы');
    passed = true;
  } catch (error) {
    summary = error instanceof Error ? error.message : String(error);
    log += '\n' + summary;
  } finally {
    await rm(scratch, { recursive: true, force: true });
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
