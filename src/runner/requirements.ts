import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { hostGitArgs } from './process.ts';
import { DevContour, digest } from '../core/service.ts';
import {
  DomainError,
  relativePath,
  type Task,
  type Run,
  type DevContourState,
} from '../core/model.ts';
import { requirementProof, taskChecks, taskEvidence, unprovenReason } from '../core/proof.ts';
import { repository } from '../core/repositories.ts';

const execFileAsync = promisify(execFile);

// A requirement ends at the next level-1/2 heading. Ignore fenced code examples.
export function parseRequirements(markdown: string) {
  if (Buffer.byteLength(markdown) > 1000000) throw new DomainError('ТЗ превышает 1 MB');
  const found: { id: string; text: string; digest: string }[] = [];
  let current: { id: string; lines: string[] } | undefined;
  let fence: string | undefined;
  const finish = () => {
    if (!current) return;
    const text = current.lines.join('\n').trim();
    if (text.length > 12000) throw new DomainError('Разбейте требование: ' + current.id);
    if (found.some((r) => r.id === current!.id)) throw new DomainError('Повтор ID: ' + current.id);
    found.push({ id: current.id, text, digest: digest(text) });
    current = undefined;
  };
  for (const line of markdown.replaceAll('\r\n', '\n').split('\n')) {
    const delimiter = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = undefined;
      current?.lines.push(line);
      continue;
    }
    if (!fence && /^#{1,2}\s/.test(line)) {
      finish();
      const id = line.match(/^## (REQ-[A-Za-z0-9_-]{1,64})(?:\s|:|$)/)?.[1];
      if (id) current = { id, lines: [] };
    }
    current?.lines.push(line);
  }
  finish();
  return found;
}
const gitOptions = (cwd: string) => ({ cwd, encoding: 'utf8' as const, maxBuffer: 1100000 });
function checkSnapshotInput(source: string, ref: string) {
  relativePath.parse(source);
  if (!/^(HEAD|[a-f0-9]{40,64})$/.test(ref)) throw new DomainError('Нужен HEAD или точный SHA');
}
const BLOB = /^100(644|755) blob /;
export type RequirementSnapshot = ReturnType<typeof requirementSnapshot>;
export function requirementSnapshot(cwd: string, source: string, ref = 'HEAD') {
  checkSnapshotInput(source, ref);
  const git = (...args: string[]) =>
    execFileSync('git', hostGitArgs(cwd, args), gitOptions(cwd)).trimEnd();
  const sha = git('rev-parse', '--verify', ref + '^{commit}');
  if (!BLOB.test(git('ls-tree', sha, '--', source)))
    throw new DomainError('ТЗ должно быть обычным Git-файлом: ' + source);
  return { source, sha, requirements: parseRequirements(git('show', `${sha}:${source}`)) };
}
/**
 * То же, что `requirementSnapshot`, без блокировки процесса: Git идёт
 * дочерним процессом асинхронно. Сервер в это время отвечает на другие
 * запросы.
 */
export async function requirementSnapshotAsync(cwd: string, source: string, ref = 'HEAD') {
  checkSnapshotInput(source, ref);
  const git = async (...args: string[]) =>
    (await execFileAsync('git', hostGitArgs(cwd, args), gitOptions(cwd))).stdout.trimEnd();
  const sha = await git('rev-parse', '--verify', ref + '^{commit}');
  if (!BLOB.test(await git('ls-tree', sha, '--', source)))
    throw new DomainError('ТЗ должно быть обычным Git-файлом: ' + source);
  return { source, sha, requirements: parseRequirements(await git('show', `${sha}:${source}`)) };
}
/**
 * Снимки ТЗ по источнику. Отчёт передаёт один кэш на все задачи: прежде
 * каждая задача заново запускала Git и разбирала тот же файл.
 */
export type SnapshotCache = Map<string, RequirementSnapshot>;
export function currentRequirements(
  h: DevContour,
  task: Task,
  cwd = repository(h.config, task.repositoryId).path,
  ref = 'HEAD',
  snapshots: SnapshotCache = new Map(),
) {
  return (task.requirements ?? []).map((link) => {
    if (!snapshots.has(link.source))
      snapshots.set(link.source, requirementSnapshot(cwd, link.source, ref));
    const current = snapshots.get(link.source)!.requirements.find((r) => r.id === link.id);
    return {
      ...link,
      currentDigest: current?.digest ?? null,
      currentText: current?.text ?? null,
      fresh: current?.digest === link.digest,
    };
  });
}
export function assertRequirements(h: DevContour, task: Task, cwd?: string, ref?: string) {
  const stale = currentRequirements(h, task, cwd, ref).filter((r) => !r.fresh);
  if (stale.length)
    throw new DomainError(
      'Требования изменились или удалены: ' + stale.map((r) => r.id).join(', '),
    );
}
/**
 * Критерий, назвавший свой тест, обязан его предъявить на принятом SHA.
 *
 * Проверяется при приёмке, а не при записи evidence: до интеграции доказан
 * кандидат, а принимается результат слияния. Задачи без `testId` проходят на
 * прежнем уровне — история не переписывается.
 */
/**
 * `state` — уже прочитанное состояние: приёмка доски проверяет задачи в
 * цикле, и чтение всего хранилища на каждую задачу росло как задачи × история.
 */
export function assertRequirementProof(
  h: DevContour,
  task: Task,
  state: DevContourState = h.store.read(),
) {
  const unproven = unprovenReason(
    task.requirements,
    // Решение о приёмке — по записям под действующим договором (см. `taskEvidence`).
    taskEvidence(state, task, h),
    task.resultSha,
    taskChecks(state, task, h),
  );
  if (unproven) throw new DomainError(unproven);
}
export function recordRequirements(
  h: DevContour,
  run: Run,
  task: Task,
  cwd: string,
  sha: string,
  phase: 'candidate' | 'integration',
) {
  if (!task.requirements?.length) return;
  assertRequirements(h, task);
  assertRequirements(h, task, cwd, sha);
  h.evidence(run.id, run.token, {
    kind: 'test',
    phase,
    sha,
    gate: 'requirement-source',
    passed: true,
    command: ['devcontour', 'requirements-check'],
    exitCode: 0,
    log: '',
    digest: digest(task.requirements),
    summary: 'Pinned requirement sections match source HEAD and tested SHA',
  });
}
/** Задачи отчёта требований компонента: без заменённых задач, в порядке состояния. */
function reportTasks(s: DevContourState, repositoryId: string) {
  const replaced = new Set(s.tasks.map((t) => t.supersedes));
  return s.tasks.filter((t) => t.repositoryId === repositoryId && !replaced.has(t.id));
}
const REPORT_SOURCE = 'committed HEAD; uncommitted specification changes are excluded';

/** Строка задачи отчёта по снимкам ТЗ из кэша. */
function reportRow(h: DevContour, s: DevContourState, t: Task, snapshots: SnapshotCache) {
  const cwd = repository(h.config, t.repositoryId).path;
  // Решающие записи задачи — одни на все её требования.
  const done = t.status === 'done';
  const evidence = done ? taskEvidence(s, t) : [];
  const checks = done ? taskChecks(s, t) : undefined;
  return {
    taskId: t.id,
    contracts: t.contractDigests,
    specDigest: t.approvedDigest,
    resultSha: t.resultSha,
    requirements: currentRequirements(h, t, cwd, 'HEAD', snapshots).map(
      ({ currentText: _text, text: _old, ...r }) => {
        const proof =
          r.fresh && done
            ? requirementProof(r, evidence, t.resultSha, checks)
            : {
                level: 'none' as const,
                reason: r.fresh ? 'Задача ещё не принята' : 'Требование изменилось в источнике',
              };
        return {
          ...r,
          // Прежнее поле сохраняется: оно означало «проверка была
          // зелёной» и продолжает означать ровно это.
          verified: proof.level !== 'none',
          // Уровень называется прямо, чтобы зелёная проверка без
          // связанного теста не читалась как подтверждённый сценарий.
          proof: proof.level,
          proofReason: proof.reason,
        };
      },
    ),
  };
}
export type RequirementReportRow = ReturnType<typeof reportRow>;

export function requirementReport(h: DevContour, repositoryId: string) {
  repository(h.config, repositoryId);
  const s = h.store.read();
  const snapshots: SnapshotCache = new Map();
  return {
    repositoryId,
    source: REPORT_SOURCE,
    tasks: reportTasks(s, repositoryId).map((t) => reportRow(h, s, t, snapshots)),
  };
}

/** Задач отчёта между уступками циклу событий. */
const REPORT_CHUNK = 20;
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Полный отчёт без блокировки процесса: снимки ТЗ читаются асинхронным Git
 * один раз на источник, строки задач считаются порциями с уступкой циклу
 * событий. Так сервер, исполняющий операцию агента, продолжает отвечать на
 * другие запросы.
 */
export async function requirementReportAsync(h: DevContour, repositoryId: string) {
  const cwd = repository(h.config, repositoryId).path;
  const s = h.store.read();
  const tasks = reportTasks(s, repositoryId);
  const snapshots: SnapshotCache = new Map();
  for (const source of new Set(tasks.flatMap((t) => (t.requirements ?? []).map((r) => r.source))))
    snapshots.set(source, await requirementSnapshotAsync(cwd, source));
  const rows: RequirementReportRow[] = [];
  for (let i = 0; i < tasks.length; i++) {
    if (i && i % REPORT_CHUNK === 0) await yieldToLoop();
    rows.push(reportRow(h, s, tasks[i], snapshots));
  }
  return { repositoryId, source: REPORT_SOURCE, tasks: rows };
}

/** Строк задач на странице операции агента по умолчанию и предел. */
export const REQUIREMENT_PAGE_DEFAULT = 50;
export const REQUIREMENT_PAGE_MAX = 200;
/** Бюджет строк задач страницы: остаток предела ответа — сводке и полям страницы. */
const REQUIREMENT_PAGE_BYTES = 48_000;
const jsonBytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

/**
 * Отчёт требований для операции агента: сводка по всем задачам и страница
 * строк задач в пределе ответа. `cursor` — id последней задачи прошлой
 * страницы; `nextCursor` — продолжение. Требования задачи, не вместившиеся в
 * страницу одни, сокращаются (`omittedRequirements`); полный отчёт — CLI
 * `requirements-report` (`full`).
 */
export function requirementReportPage(
  report: { repositoryId: string; source: string; tasks: RequirementReportRow[] },
  input: { cursor?: string; limit?: number },
) {
  const all = report.tasks;
  const proof: Record<string, number> = {};
  let requirements = 0;
  let stale = 0;
  for (const row of all)
    for (const r of row.requirements) {
      requirements++;
      if (!r.fresh) stale++;
      proof[r.proof] = (proof[r.proof] ?? 0) + 1;
    }
  let start = 0;
  if (input.cursor !== undefined) {
    const at = all.findIndex((t) => t.taskId === input.cursor);
    if (at < 0)
      throw new DomainError(
        `Курсор отчёта требований не найден: задачи ${input.cursor} в отчёте нет. Начните с первой страницы (без cursor).`,
        400,
      );
    start = at + 1;
  }
  const limit = input.limit ?? REQUIREMENT_PAGE_DEFAULT;
  const page: (RequirementReportRow & { omittedRequirements?: number })[] = [];
  let used = 0;
  for (const row of all.slice(start, start + limit)) {
    const bytes = jsonBytes(row);
    if (used + bytes <= REQUIREMENT_PAGE_BYTES) {
      page.push(row);
      used += bytes;
      continue;
    }
    if (page.length) break;
    // Одна задача больше страницы: её требования сокращаются до предела.
    const kept: RequirementReportRow['requirements'] = [];
    let size = jsonBytes({ ...row, requirements: [], omittedRequirements: 0 });
    for (const r of row.requirements) {
      const b = jsonBytes(r) + 1;
      if (size + b > REQUIREMENT_PAGE_BYTES) break;
      kept.push(r);
      size += b;
    }
    page.push({
      ...row,
      requirements: kept,
      omittedRequirements: row.requirements.length - kept.length,
    });
    break;
  }
  const end = start + page.length;
  return {
    repositoryId: report.repositoryId,
    source: report.source,
    summary: { tasks: all.length, requirements, stale, proof },
    tasks: page,
    ...(end < all.length ? { nextCursor: page.at(-1)!.taskId } : {}),
    full: `devcontour requirements-report --repository-id ${report.repositoryId} --workspace …`,
  };
}
export function correctRequirements(h: DevContour, boardId: string, reason: string) {
  const s = h.store.read(),
    board = s.boards.find((b) => b.id === boardId);
  if (!board) throw new DomainError('Доска не найдена');
  // Отменённая задача — не результат, который можно скорректировать: корнем
  // она делала корректировку невозможной («незавершённая цепочка»).
  const tasks = s.tasks.filter(
    (t) => board.revisions.at(-1)!.taskIds.includes(t.id) && t.status !== 'cancelled',
  );
  const updates: Record<string, Task['requirements']> = {};
  for (const task of tasks) {
    const links = currentRequirements(h, task);
    if (!links.some((r) => !r.fresh)) continue;
    if (links.some((r) => !r.currentText))
      throw new DomainError('Удалённое требование требует явного перепланирования');
    updates[task.id] = links.map(({ currentText, currentDigest, fresh: _fresh, ...r }) => ({
      ...r,
      text: currentText!,
      digest: currentDigest!,
    }));
  }
  if (!Object.keys(updates).length) return { status: 'unchanged' };
  return h.correct(boardId, Object.keys(updates), reason, {
    expected: digest(board),
    requirements: updates,
  });
}
