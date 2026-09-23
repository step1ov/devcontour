import { validatePreparation } from './preparation.ts';
import { digest, specDigest, type DevContour } from './service.ts';
import { repository, requiresContract } from './repositories.ts';
import { assertDag } from './graph.ts';
import { validateTaskContext } from './workflow.ts';
import { taskInput, type DevContourState, type Task, type Approval, type Board } from './model.ts';
import {
  canonical,
  recordKey,
  recordSchema,
  receiptSchema,
  type Records,
  type SyncRecord,
  type CompletionReceipt,
} from './sync-model.ts';

export function taskOwner(t: Pick<Task, 'scope' | 'repositoryId'>) {
  return t.scope === 'workspace' ? undefined : t.repositoryId;
}
export function boardOwner(
  b: Pick<Board, 'repositoryId' | 'revisions' | 'scope'>,
  state: DevContourState,
) {
  if (b.scope === 'workspace') return;
  if (b.repositoryId) return b.repositoryId;
  const tasks = b.revisions
    .flatMap((r) => r.taskIds)
    .map((id) => state.tasks.find((t) => t.id === id));
  if (tasks.length && tasks.every((t) => t && taskOwner(t) === taskOwner(tasks[0]!)))
    return taskOwner(tasks[0]!);
}
function approval(a?: Approval) {
  return a
    ? {
        actor: a.actor,
        authorRuntime: a.authorRuntime,
        reviewerRuntime: a.reviewerRuntime,
        digest: a.digest,
      }
    : undefined;
}
export function completion(h: DevContour, s: DevContourState, t: Task): CompletionReceipt {
  if (t.sharedCompletion) return t.sharedCompletion.receipt;
  const run = s.runs.findLast(
    (r) => r.taskId === t.id && r.status === 'succeeded' && r.integrationSha === t.resultSha,
  );
  if (!run) throw new Error(`Нет завершённой попытки для ${t.id}`);
  const requiredGates =
    run.requiredGates ??
    (run.policyDigest === h.policyDigest(t.repositoryId)
      ? repository(h.config, t.repositoryId).gates.map((g) => g.id)
      : undefined);
  if (!requiredGates)
    throw new Error(
      `Для старой попытки ${t.id} нельзя восстановить policy: нужна исходная конфигурация`,
    );
  return receiptSchema.parse({
    id: run.id,
    taskId: t.id,
    repositoryId: t.repositoryId,
    specDigest: t.approvedDigest,
    policyDigest: run.policyDigest,
    candidateSha: run.candidateSha,
    resultSha: t.resultSha,
    finishedAt: run.finishedAt,
    runtime: run.runtime,
    reviewer: run.reviewer,
    requiredGates,
    checks: run.evidence.map(({ kind, phase, sha, gate, passed, exitCode, digest }) => ({
      kind,
      phase,
      sha,
      gate,
      passed,
      exitCode,
      digest,
    })),
  });
}
export function recordsFromState(h: DevContour, s: DevContourState) {
  const records = new Map<string | undefined, Records>();
  const add = (owner: string | undefined, record: SyncRecord) => {
    if (!records.has(owner)) records.set(owner, {});
    const parsed = recordSchema.parse(record);
    records.get(owner)![recordKey(parsed)] = parsed;
  };
  for (const t of s.tasks) {
    const owner = taskOwner(t);
    let receiptId: string | undefined;
    if (t.status === 'done') {
      const receipt = completion(h, s, t);
      add(owner, { version: 1, kind: 'receipt', data: receipt });
      receiptId = receipt.id;
    }
    add(owner, {
      version: 1,
      kind: 'task',
      data: {
        ...taskInput.parse(t),
        id: t.id,
        createdAt: t.createdAt,
        supersedes: t.supersedes,
      },
      progress: {
        status: ['draft', 'ready', 'done', 'failed', 'cancelled'].includes(t.status)
          ? (t.status as 'draft' | 'ready' | 'done' | 'failed' | 'cancelled')
          : 'ready',
        approvedDigest: t.approvedDigest,
        approval: approval(t.approval),
        receiptId,
      },
    });
  }
  for (const b of s.boards)
    add(boardOwner(b, s), {
      version: 1,
      kind: 'board',
      data: {
        id: b.id,
        title: b.title,
        description: b.description,
        repositoryId: boardOwner(b, s),
        scope: boardOwner(b, s) ? 'component' : 'workspace',
        revisions: b.revisions.map((r) => ({
          number: r.number,
          reason: r.reason,
          taskIds: r.taskIds,
          createdAt: r.createdAt,
          accepted:
            r.status === 'accepted'
              ? {
                  at: r.acceptedAt!,
                  sha: r.snapshot!.sha,
                  repositories: r.snapshot!.repositories,
                }
              : undefined,
        })),
      },
    });
  for (const c of s.contracts)
    add(c.repositoryId, {
      version: 1,
      kind: 'contract',
      data: {
        id: c.id,
        repositoryId: c.repositoryId,
        title: c.title,
        content: c.content,
        digest: c.digest,
        approvedAt: c.approvedAt,
      },
    });
  for (const c of s.changeSets)
    add(undefined, {
      version: 1,
      kind: 'changeset',
      data: {
        id: c.id,
        title: c.title,
        description: c.description,
        boardIds: c.boardIds,
        releaseId: c.releaseId,
        createdAt: c.createdAt,
        supersedes: c.supersedes,
      },
    });
  if (s.preparation) add(undefined, { version: 1, kind: 'preparation', data: s.preparation });
  return records;
}
export function validateReceipt(receipt: CompletionReceipt, t: Task, demo: boolean) {
  if (
    receipt.taskId !== t.id ||
    receipt.repositoryId !== t.repositoryId ||
    receipt.specDigest !== specDigest(t)
  )
    throw new Error(`Receipt не соответствует постановке ${t.id}`);
  if (
    !demo &&
    (receipt.runtime === 'demo' ||
      receipt.reviewer === 'demo' ||
      receipt.runtime === receipt.reviewer)
  )
    throw new Error(`Нет независимого runtime review: ${t.id}`);
  if (t.requirements?.length && !receipt.requiredGates.includes('requirement-source'))
    throw new Error('Receipt не проверяет требования: ' + t.id);
  for (const phase of ['candidate', 'integration'] as const) {
    const sha = phase === 'candidate' ? receipt.candidateSha : receipt.resultSha;
    for (const [kind, gates] of [
      ['test', receipt.requiredGates],
      ['review', ['independent-review']],
    ] as const)
      for (const gate of gates) {
        const check = receipt.checks.findLast(
          (c) => c.kind === kind && c.phase === phase && c.gate === gate && c.sha === sha,
        );
        if (!check?.passed || check.exitCode !== 0)
          throw new Error(`Нет PASS в receipt ${t.id}: ${phase}/${gate}`);
      }
  }
}

// Shared records are peer attestations from a reviewed Git repository. They never
// recreate worker credentials, leases, processes, local reports or workspace acceptance.
export function stateFromRecords(
  h: DevContour,
  old: DevContourState,
  groups: Map<string | undefined, Records>,
  commits: Map<string | undefined, string>,
) {
  const s = structuredClone(old);
  const all = [...groups].flatMap(([owner, records]) =>
    Object.values(records).map((record) => ({ owner, record: recordSchema.parse(record) })),
  );
  const ids = new Set<string>();
  for (const { record } of all) {
    if (ids.has(record.data.id)) throw new Error('Повтор ID: ' + record.data.id);
    ids.add(record.data.id);
  }
  const preparations = all.filter((x) => x.record.kind === 'preparation');
  if (preparations.length > 1 || preparations.some((x) => x.owner))
    throw new Error('Продуктовый процесс хранится только в workspace');
  const preparation = preparations[0]?.record;
  s.preparation = preparation?.kind === 'preparation' ? preparation.data : undefined;
  validatePreparation(s, old);
  const contracts = all.filter((x) => x.record.kind === 'contract');
  s.contracts = contracts.map(({ owner, record }) => {
    if (record.kind !== 'contract') throw new Error('Contract expected');
    if (owner !== record.data.repositoryId || digest(record.data.content) !== record.data.digest)
      throw new Error('Неверный владелец или digest контракта: ' + record.data.id);
    const previous = old.contracts.find((c) => c.id === record.data.id);
    if (previous && (previous.digest !== record.data.digest || previous.repositoryId !== owner))
      throw new Error('Утверждённый контракт неизменяем: ' + record.data.id);
    return previous ?? record.data;
  });
  s.tasks = all
    .filter((x) => x.record.kind === 'task')
    .map(({ owner, record }) => {
      if (record.kind !== 'task') throw new Error('Task expected');
      const data = record.data,
        progress = record.progress;
      if (owner !== taskOwner(data)) throw new Error('Задача вне своего репозитория: ' + data.id);
      repository(h.config, data.repositoryId);
      validateTaskContext(h.config, data);
      const contractDigests = Object.fromEntries(
        data.contracts.map((id) => {
          const c = s.contracts.find((c) => c.id === id);
          if (!c || (c.repositoryId && c.repositoryId !== data.repositoryId))
            throw new Error('Недоступный контракт: ' + id);
          return [id, c.digest];
        }),
      );
      const previous = old.tasks.find((t) => t.id === data.id);
      const t: Task = {
        ...data,
        status: progress.status,
        attempt: previous?.attempt ?? 0,
        contractDigests: progress.approvedDigest ? contractDigests : {},
        approvedDigest: progress.approvedDigest,
        approval:
          previous?.approvedDigest === progress.approvedDigest &&
          canonical(approval(previous?.approval)) === canonical(progress.approval)
            ? previous?.approval
            : progress.approval,
      };
      if (progress.approvedDigest && progress.approvedDigest !== specDigest(t))
        throw new Error('Постановка изменилась после утверждения: ' + t.id);
      if (
        (t.status === 'ready' || t.status === 'done') &&
        (!t.approvedDigest ||
          !t.approval ||
          (requiresContract(h.config, t.role, t.repositoryId) && !t.contracts.length))
      )
        throw new Error('Нет утверждённой постановки: ' + t.id);
      if (
        t.approval?.actor === 'agent' &&
        (!t.approval.authorRuntime ||
          !t.approval.reviewerRuntime ||
          t.approval.authorRuntime === t.approval.reviewerRuntime)
      )
        throw new Error('Нет независимого согласования: ' + t.id);
      if (previous && previous.status !== 'draft' && specDigest(previous) !== specDigest(t))
        throw new Error('Нужна корректировка утверждённой задачи: ' + t.id);
      if (previous?.status === 'done' && t.status !== 'done')
        throw new Error('Нельзя отменить принятый результат: ' + t.id);
      if (t.status === 'done') {
        const entry = all.find(
          (x) =>
            x.owner === owner &&
            x.record.kind === 'receipt' &&
            x.record.data.id === progress.receiptId,
        );
        if (entry?.record.kind !== 'receipt')
          throw new Error('Нет receipt завершённой задачи: ' + t.id);
        const receipt = entry.record.data;
        validateReceipt(receipt, t, h.config.mode === 'demo');
        if (previous?.resultSha && previous.resultSha !== receipt.resultSha)
          throw new Error('Нельзя заменить принятый SHA: ' + t.id);
        t.resultSha = receipt.resultSha;
        if (previous?.status !== 'done' || previous.sharedCompletion)
          t.sharedCompletion = previous?.sharedCompletion ?? {
            receipt,
            sourceCommit: commits.get(owner)!,
          };
      }
      // Keep local diagnostics and original evidence when the task did not change.
      return {
        ...previous,
        ...t,
        activeRunId: undefined,
        failure:
          t.status === 'failed'
            ? (previous?.failure ??
              'Неуспешная попытка участника команды; подробности в его локальных артефактах.')
            : undefined,
      };
    });
  assertDag(s.tasks);
  const replacements = new Set<string>();
  for (const t of s.tasks) {
    if (t.supersedes) {
      const parent = s.tasks.find((p) => p.id === t.supersedes);
      if (
        !parent ||
        parent.status !== 'done' ||
        replacements.has(parent.id) ||
        parent.repositoryId !== t.repositoryId
      )
        throw new Error('Некорректная цепочка корректировок: ' + t.id);
      replacements.add(parent.id);
    }
    if (
      t.status === 'done' &&
      t.dependsOn.some((id) => s.tasks.find((d) => d.id === id)?.status !== 'done')
    )
      throw new Error('Завершённая задача зависит от незавершённой: ' + t.id);
  }
  assertDag(s.tasks.map((t) => ({ id: t.id, dependsOn: t.supersedes ? [t.supersedes] : [] })));
  s.boards = all
    .filter((x) => x.record.kind === 'board')
    .map(({ owner, record }) => {
      if (record.kind !== 'board') throw new Error('Board expected');
      const b = record.data,
        previous = old.boards.find((p) => p.id === b.id);
      if (b.repositoryId && b.repositoryId !== owner)
        throw new Error('Доска вне своего компонента');
      const board: Board = {
        ...b,
        revisions: b.revisions.map((r, index) => {
          if (r.number !== index + 1 || (index < b.revisions.length - 1 && !r.accepted))
            throw new Error('Неверная история ревизий: ' + b.id);
          const tasks = r.taskIds.map((id) => {
            const t = s.tasks.find((t) => t.id === id);
            if (!t) throw new Error('Доска ссылается на неизвестную задачу: ' + id);
            if (owner && taskOwner(t) !== owner)
              throw new Error('Локальная доска с чужими задачами');
            return t;
          });
          if (new Set(r.taskIds).size !== r.taskIds.length)
            throw new Error('Повтор задачи в ревизии');
          const before = previous?.revisions.find((p) => p.number === r.number);
          if (before?.status === 'accepted') {
            if (
              !r.accepted ||
              canonical(before.taskIds) !== canonical(r.taskIds) ||
              before.snapshot?.sha !== r.accepted.sha ||
              before.reason !== r.reason ||
              before.acceptedAt !== r.accepted.at ||
              canonical(before.snapshot?.repositories) !== canonical(r.accepted.repositories)
            )
              throw new Error('Принятая ревизия неизменяема: ' + b.id);
            return before;
          }
          if (!r.accepted) return { ...r, status: 'active' as const };
          if (!tasks.length || tasks.some((t) => t.status !== 'done'))
            throw new Error('Приёмка требует завершённых задач: ' + b.id);
          const snapshot = {
            tasks,
            sha: r.accepted.sha,
            ...(r.accepted.repositories ? { repositories: r.accepted.repositories } : {}),
          };
          return {
            number: r.number,
            reason: r.reason,
            taskIds: r.taskIds,
            createdAt: r.createdAt,
            status: 'accepted' as const,
            acceptedAt: r.accepted.at,
            snapshot: { ...snapshot, digest: digest(snapshot) },
          };
        }),
      };
      if (boardOwner(board, s) !== owner) throw new Error('Неверное расположение доски: ' + b.id);
      if (previous && previous.revisions.length > board.revisions.length)
        throw new Error('Нельзя удалить историю ревизий');
      return board;
    });
  const visible = new Set(s.boards.flatMap((b) => b.revisions.flatMap((r) => r.taskIds)));
  if (s.tasks.some((t) => !visible.has(t.id))) throw new Error('Задача без доски');
  s.changeSets = all
    .filter((x) => x.record.kind === 'changeset')
    .map(({ owner, record }) => {
      if (record.kind !== 'changeset' || owner)
        throw new Error('ChangeSet должен находиться в workspace');
      const c = record.data,
        previous = old.changeSets.find((p) => p.id === c.id);
      if (c.boardIds.some((id) => !s.boards.some((b) => b.id === id)))
        throw new Error('ChangeSet с неизвестной доской');
      if (
        previous?.acceptance &&
        (canonical(c.boardIds) !== canonical(previous.boardIds) ||
          c.releaseId !== previous.releaseId)
      )
        throw new Error('Нельзя менять принятый ChangeSet');
      return {
        ...previous,
        ...c,
        releaseId: c.releaseId,
        verifications: previous?.verifications ?? [],
      };
    });
  assertDag(s.changeSets.map((c) => ({ id: c.id, dependsOn: c.supersedes ? [c.supersedes] : [] })));
  return s;
}
