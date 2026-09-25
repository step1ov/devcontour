import { execFileSync } from 'node:child_process';
import { DevContour, digest } from '../core/service.ts';
import { DomainError, relativePath, type Task, type Run, type Evidence } from '../core/model.ts';
import { requirementProof, taskEvidence, unprovenReason } from '../core/proof.ts';
import { repository } from '../core/repositories.ts';

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
export function requirementSnapshot(cwd: string, source: string, ref = 'HEAD') {
  relativePath.parse(source);
  if (!/^(HEAD|[a-f0-9]{40,64})$/.test(ref)) throw new DomainError('Нужен HEAD или точный SHA');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1100000 }).trimEnd();
  const sha = git('rev-parse', '--verify', ref + '^{commit}');
  if (!/^100(644|755) blob /.test(git('ls-tree', sha, '--', source)))
    throw new DomainError('ТЗ должно быть обычным Git-файлом: ' + source);
  return { source, sha, requirements: parseRequirements(git('show', `${sha}:${source}`)) };
}
export function currentRequirements(
  h: DevContour,
  task: Task,
  cwd = repository(h.config, task.repositoryId).path,
  ref = 'HEAD',
) {
  const snapshots = new Map<string, ReturnType<typeof requirementSnapshot>>();
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
export function assertRequirementProof(h: DevContour, task: Task) {
  const unproven = unprovenReason(
    task.requirements,
    taskEvidence(h.store.read(), task),
    task.resultSha,
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
export function requirementReport(h: DevContour, repositoryId: string) {
  repository(h.config, repositoryId);
  const s = h.store.read();
  const replaced = new Set(s.tasks.map((t) => t.supersedes));
  return {
    repositoryId,
    source: 'committed HEAD; uncommitted specification changes are excluded',
    tasks: s.tasks
      .filter((t) => t.repositoryId === repositoryId && !replaced.has(t.id))
      .map((t) => {
        const run = s.runs.findLast((r) => r.taskId === t.id && r.status === 'succeeded');
        return {
          taskId: t.id,
          contracts: t.contractDigests,
          specDigest: t.approvedDigest,
          resultSha: t.resultSha,
          requirements: currentRequirements(h, t).map(
            ({ currentText: _text, text: _old, ...r }) => {
              const evidence = (run?.evidence ??
                t.sharedCompletion?.receipt.checks ??
                []) as Evidence[];
              const proof =
                r.fresh && t.status === 'done'
                  ? requirementProof(r, evidence, t.resultSha)
                  : {
                      level: 'none' as const,
                      reason: r.fresh
                        ? 'Задача ещё не принята'
                        : 'Требование изменилось в источнике',
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
      }),
  };
}
export function correctRequirements(h: DevContour, boardId: string, reason: string) {
  const s = h.store.read(),
    board = s.boards.find((b) => b.id === boardId);
  if (!board) throw new DomainError('Доска не найдена');
  const tasks = s.tasks.filter((t) => board.revisions.at(-1)!.taskIds.includes(t.id));
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
