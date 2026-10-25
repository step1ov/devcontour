import { memoryDirectory } from '../core/placement.ts';
import { assertTaskPreparation } from '../core/preparation.ts';
import { ProjectMemory } from './memory.ts';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DevContour, digest, specDigest } from '../core/service.ts';
import {
  DomainError,
  requireValue,
  type Board,
  type DevContourState,
  type Task,
} from '../core/model.ts';
import { repositories, repository, roleBinding, reviewerBinding } from '../core/repositories.ts';
import { identitySchema } from '../core/sync-model.ts';
import {
  HarnessError,
  checkJsonBytes,
  pageItems,
  workProgress,
  type ProgressReason,
} from 'devcontour-harness';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const scope = { repositoryId: id.optional() };
const paging = {
  cursor: z.string().max(1000).optional(),
  limit: z.number().int().min(1).max(50).default(20),
};
export const contextInputs = {
  project_context: z.object({}).strict(),
  project_overview: z.object({ ...scope, ...paging }).strict(),
  task_briefing: z.object({ taskId: id, ...paging }).strict(),
  checkpoint_save: z
    .object({
      ...scope,
      expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
      summary: z.string().trim().min(1).max(3000),
      nextStep: z.string().trim().min(1).max(3000),
    })
    .strict(),
  checkpoint_changes: z.object({ ...scope, checkpointId: z.string().uuid(), ...paging }).strict(),
};
export type ContextOperation = keyof typeof contextInputs;
export const contextOperations = Object.keys(contextInputs) as ContextOperation[];

/** Машинные причины ответа (`progress.reasons`) для общих кодов harness. */
const sharedReasons: Record<ProgressReason, string> = {
  'plan-review-required': 'plan_review_required',
  'attempts-exhausted': 'attempts_exhausted',
  'failure-requires-diagnosis': 'failure_requires_diagnosis',
  'dependencies-incomplete': 'dependencies_incomplete',
  'queue-paused': 'queue_paused',
  'workers-busy': 'workers_busy',
};

// Keep runtime ownership tokens, commands, credentials and full component bodies out of summaries.
/**
 * Почему задача не выдаётся. Общие ветви (план, сбой, зависимости, попытки,
 * пауза, занятые исполнители) — проекция harness `workProgress`; хост
 * добавляет продуктовые причины: до общих — согласование продукта и
 * неактивную ревизию, после — чужое назначение и идущую общую операцию
 * workspace. `now` — момент, на который считаются сроки lease; вызывающий
 * передаёт один момент на весь ответ (обязательный параметр: своё чтение часов
 * у каждой задачи давало в одном ответе разные lease-решения).
 */
export function taskProgress(h: DevContour, s: DevContourState, t: Task, now: number) {
  const before: string[] = [];
  const after: string[] = [];
  if (s.preparation && t.status !== 'done') {
    try {
      assertTaskPreparation(s, t);
    } catch {
      before.push('product_approval_required');
    }
  }
  if (t.status === 'ready') {
    const active = s.boards.some(
      (b) => b.revisions.at(-1)?.status === 'active' && b.revisions.at(-1)!.taskIds.includes(t.id),
    );
    if (!active) before.push('inactive_revision');
    if (s.team && t.assignee !== s.team.member) after.push('assigned_to_another_member');
    if (
      s.changeSets.some(
        (c) =>
          c.verifications.some((v) => v.status === 'active' && v.leaseUntil > now) ||
          c.deliveries?.some((d) => d.status === 'active' && d.leaseUntil > now),
      )
    )
      after.push('workspace_operation_active');
  }
  const shared = workProgress({
    work: t,
    statusOf: (id) => s.tasks.find((x) => x.id === id)?.status,
    maxAttempts: h.config.maxAttempts,
    paused: s.paused,
    activeRuns: s.runs.filter((r) => r.status === 'active').length,
    concurrency: h.config.concurrency,
    hostReasons: [...before, ...after],
  });
  return {
    taskId: t.id,
    repositoryId: t.repositoryId,
    status: t.status,
    attempt: t.attempt,
    dependencies: shared.dependencies,
    reasons: [...before, ...shared.reasons.map((r) => sharedReasons[r]), ...after],
    eligible: shared.eligible,
  };
}
function boardOwner(b: Board, s: DevContourState) {
  if (b.scope === 'workspace') return undefined;
  if (b.repositoryId) return b.repositoryId;
  const tasks = s.tasks.filter((t) => b.revisions.some((r) => r.taskIds.includes(t.id)));
  const owners = new Set(tasks.map((t) => (t.scope === 'workspace' ? undefined : t.repositoryId)));
  return owners.size === 1 ? [...owners][0] : undefined;
}
type RecordSummary = {
  key: string;
  digest: string;
  id: string;
  kind: string;
  title?: string;
  status?: string;
  repositoryId?: string;
};
/** `now` — тот же момент, что у причин задач этого ответа. */
function snapshot(h: DevContour, s: DevContourState, now: number, repositoryId?: string) {
  if (repositoryId) repository(h.config, repositoryId);
  const records: RecordSummary[] = [];
  const add = (
    kind: string,
    value: { id: string; title?: string; status?: string; repositoryId?: string },
    content: unknown,
  ) =>
    records.push({
      key: kind + '/' + value.id,
      id: value.id,
      kind,
      title: value.title?.slice(0, 180),
      status: value.status,
      repositoryId: value.repositoryId,
      digest: digest(content),
    });
  for (const t of s.tasks.filter(
    (t) => (t.scope === 'workspace' ? undefined : t.repositoryId) === repositoryId,
  )) {
    const run = s.runs.find((r) => r.id === t.activeRunId);
    add('task', t, {
      spec: specDigest(t),
      status: t.status,
      assignee: t.assignee,
      attempt: t.attempt,
      result: t.resultSha,
      failure: t.failure,
      run: run && {
        id: run.id,
        phase: run.phase,
        status: run.status,
        evidence: run.evidence.map((e) => ({
          id: e.id,
          digest: e.digest,
          passed: e.passed,
          sha: e.sha,
        })),
      },
    });
  }
  for (const b of s.boards.filter((b) => boardOwner(b, s) === repositoryId))
    add('board', { ...b, status: b.revisions.at(-1)?.status }, b);
  for (const c of s.contracts.filter((c) => c.repositoryId === repositoryId)) add('contract', c, c);
  if (!repositoryId)
    for (const c of s.changeSets)
      add('changeset', c, {
        ...c,
        verifications: c.verifications.map(({ token: _token, leaseUntil: _lease, ...v }) => v),
        deliveries: c.deliveries?.map(({ token: _token, leaseUntil: _lease, ...d }) => d),
      });
  if (repositoryId || h.config.workspaceRoot) {
    const memory = new ProjectMemory(h).recall({ repositoryId, maxBytes: 0 });
    if (memory.recordCount)
      add(
        'knowledge',
        { id: repositoryId ?? 'workspace', repositoryId },
        { revision: memory.revision },
      );
  }
  records.sort((a, b) => a.key.localeCompare(b.key));
  const control = {
    paused: s.paused,
    member: s.team?.member,
    policy: digest(h.config),
    scheduling: digest({
      tasks: s.tasks.map((t) => [t.id, t.status, t.assignee]),
      activeRuns: s.runs.filter((r) => r.status === 'active').map((r) => [r.id, r.phase]),
      workspaceBusy: s.changeSets.some(
        (c) =>
          c.verifications.some((v) => v.status === 'active' && v.leaseUntil > now) ||
          c.deliveries?.some((d) => d.status === 'active' && d.leaseUntil > now),
      ),
    }),
  };
  return { revision: digest({ repositoryId, records, control }), records, control };
}
const MAX_RESPONSE = 64 * 1024;
/**
 * Страница контекста — общая операция harness (`pageItems`): cursor
 * base64url `{revision, binding, offset}`, бюджет страницы 64 KiB с запасом
 * 2048 байт под конверт. Хост задаёт revision и binding запроса и называет
 * отказы прежними словами и статусами.
 */
function page<T>(
  items: T[],
  header: Record<string, unknown>,
  revision: string,
  binding: string,
  input: { cursor?: string; limit: number },
) {
  try {
    return pageItems(items, header, {
      revision,
      binding,
      cursor: input.cursor,
      limit: input.limit,
    });
  } catch (error) {
    if (!(error instanceof HarnessError)) throw error;
    const at = JSON.stringify(error.issues[0]?.path ?? []);
    if (error.code === 'INVALID_INPUT' && at === '["cursor"]')
      throw new DomainError('Некорректный cursor', 400);
    if (error.code === 'INVALID_INPUT' && at === '["cursor","offset"]')
      throw new DomainError('Некорректный cursor offset', 400);
    if (error.code === 'REVISION_CONFLICT')
      throw new DomainError(
        'Контекст изменился или cursor принадлежит другому запросу. Начните с первой страницы.',
      );
    if (error.code === 'RESPONSE_TOO_LARGE')
      throw new DomainError('Элемент контекста превышает лимит ответа', 413);
    throw error;
  }
}
const checkpointSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  identity: z.string().uuid(),
  repositoryId: id.optional(),
  createdAt: z.string(),
  revision: z.string(),
  summary: z.string().max(3000),
  nextStep: z.string().max(3000),
  control: z.object({
    paused: z.boolean(),
    member: z.string().optional(),
    policy: z.string(),
    scheduling: z.string(),
  }),
  records: z
    .array(z.object({ key: z.string().max(160), digest: z.string().regex(/^[a-f0-9]{64}$/) }))
    .max(20000),
});
function safePath(root: string, relative: string) {
  let path = realpathSync(root);
  for (const segment of relative.split('/')) {
    path = join(path, segment);
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw new DomainError('Checkpoint не использует symlink', 400);
  }
  return path;
}

export class AgentContext {
  constructor(readonly h: DevContour) {}
  execute(operation: ContextOperation, raw: unknown): unknown {
    const result = this.evaluate(operation, raw);
    if (!checkJsonBytes(result, MAX_RESPONSE).within)
      throw new DomainError('Ответ превышает 64 KiB; сузьте контекст', 413);
    return result;
  }
  private evaluate(operation: ContextOperation, raw: unknown): unknown {
    const h = this.h,
      s = h.store.read();
    // Один момент на весь ответ: revision, scheduling и причины каждой задачи
    // считают lease по нему и не расходятся на границе срока.
    const now = Date.now();
    if (operation === 'project_context') {
      contextInputs.project_context.parse(raw);
      return {
        protocolVersion: 1,
        name: h.config.name,
        workspace: h.config.workspaceRoot ?? null,
        workspaceMode: h.config.workspaceMode ?? (h.config.workspaceRoot ? 'separate' : null),
        approvalMode: h.config.approvalMode,
        completionMode: h.config.completionMode,
        storage: h.config.storage,
        paused: s.paused,
        member: s.team?.member,
        repositories: repositories(h.config).map((r) => ({
          id: r.id,
          name: r.name,
          kind: r.kind,
          path: r.path,
          dependsOn: r.dependsOn ?? [],
          targetBranch: r.targetBranch,
          taskCount: s.tasks.filter((t) => t.repositoryId === r.id && t.scope !== 'workspace')
            .length,
        })),
        operations: contextOperations,
        nextStep: 'project_overview для общего контура; repositoryId для локального компонента',
        invariants: [
          'done требует evidence на candidate и integration SHA',
          'checkpoint — контекст, не разрешение и не evidence',
          'публикация выполняется человеком',
        ],
      };
    }
    if (operation === 'project_overview') {
      const input = contextInputs.project_overview.parse(raw),
        snap = snapshot(h, s, now, input.repositoryId);
      const items = snap.records.map((record) => {
        const task = record.kind === 'task' ? s.tasks.find((t) => t.id === record.id) : undefined;
        return { ...record, ...(task ? { progress: taskProgress(h, s, task, now) } : {}) };
      });
      return page(
        items,
        { scope: input.repositoryId ?? '@workspace', paused: s.paused },
        snap.revision,
        'overview/' + (input.repositoryId ?? ''),
        input,
      );
    }
    if (operation === 'task_briefing') {
      const input = contextInputs.task_briefing.parse(raw),
        t = requireValue(
          s.tasks.find((t) => t.id === input.taskId),
          'Задача не найдена',
        );
      const sections: { kind: string; id: string; part: number; text: string }[] = [];
      const section = (kind: string, id: string, text: string) => {
        const chars = Array.from(text);
        for (let i = 0; i < chars.length; i += 1800)
          sections.push({ kind, id, part: i / 1800, text: chars.slice(i, i + 1800).join('') });
      };
      section('description', t.id, t.description);
      for (const r of t.requirements ?? []) section('requirement', r.id, JSON.stringify(r));
      t.acceptance.forEach((text, i) => section('acceptance', String(i + 1), text));
      for (const id of t.contracts) {
        const c = requireValue(
          s.contracts.find((c) => c.id === id),
          'Контракт не найден',
        );
        if (c.repositoryId && c.repositoryId !== t.repositoryId)
          throw new DomainError('Локальный контракт принадлежит другому компоненту');
        section('contract', c.id, c.content);
      }
      if (t.failure) section('failure', t.id, t.failure);
      for (const r of (s.reproductions ?? []).filter((r) => r.taskId === t.id).slice(-20))
        section('reproduction', r.id, JSON.stringify(r));
      const repo = repository(h.config, t.repositoryId);
      const header = {
        task: {
          id: t.id,
          title: t.title,
          repositoryId: t.repositoryId,
          role: t.role,
          status: t.status,
          specDigest: specDigest(t),
          resultSha: t.resultSha,
          assignee: t.assignee,
          supersedes: t.supersedes,
        },
        progress: taskProgress(h, s, t, now),
        execution: {
          runtime: roleBinding(h.config, t.role, t.repositoryId).runtime,
          reviewer: reviewerBinding(h.config, t.role, t.repositoryId).runtime,
          writePaths:
            t.writePaths ?? roleBinding(h.config, t.role, t.repositoryId).writePaths ?? [],
          protectedPaths: repo.protectedPaths,
          gates: repo.gates.map((g) => ({ id: g.id, kind: g.kind })),
          contextPacks: h.config.contextPacks
            .filter(
              (p) =>
                p.repositoryId === t.repositoryId &&
                (t.contextPacks ? t.contextPacks.includes(p.id) : p.roles.includes(t.role)),
            )
            .map(({ id, revision, digest }) => ({ id, revision, digest })),
        },
      };
      return page(sections, header, digest({ header, sections }), 'briefing/' + t.id, input);
    }
    if (operation !== 'checkpoint_save' && operation !== 'checkpoint_changes')
      throw new DomainError('Неизвестная операция контекста', 400);
    const input =
      operation === 'checkpoint_save'
        ? contextInputs.checkpoint_save.parse(raw)
        : contextInputs.checkpoint_changes.parse(raw);
    const root = input.repositoryId
      ? repository(h.config, input.repositoryId).path
      : requireValue(h.config.workspaceRoot, 'Для общего checkpoint требуется workspaceRoot');
    const snap = snapshot(h, s, now, input.repositoryId);
    const prefix = memoryDirectory(h.config, input.repositoryId);
    const identityPath = safePath(root, prefix + '/context-identity.json');
    const directory = safePath(root, prefix + '/checkpoints');
    if (operation === 'checkpoint_save' && 'expectedRevision' in input) {
      if (input.expectedRevision !== snap.revision)
        throw new DomainError('Контекст изменился; обновите обзор перед checkpoint');
      mkdirSync(directory, { recursive: true });
      if (!existsSync(identityPath)) {
        const gitIdentityPath = safePath(root, prefix + '/identity.json');
        let identity: string = randomUUID();
        if (existsSync(gitIdentityPath)) {
          if (lstatSync(gitIdentityPath).size > 1000)
            throw new DomainError('Некорректная Git identity', 400);
          const shared = identitySchema.parse(JSON.parse(readFileSync(gitIdentityPath, 'utf8')));
          if (shared.repositoryId !== input.repositoryId)
            throw new DomainError('Git identity принадлежит другому компоненту');
          identity = shared.id;
        }
        writeFileSync(identityPath, JSON.stringify({ version: 1, id: identity }) + '\n', {
          flag: 'wx',
        });
      }
      const identity = this.identity(identityPath);
      const checkpoint = checkpointSchema.parse({
        version: 1,
        id: randomUUID(),
        identity,
        repositoryId: input.repositoryId,
        createdAt: new Date().toISOString(),
        revision: snap.revision,
        summary: input.summary,
        nextStep: input.nextStep,
        control: snap.control,
        records: snap.records.map(({ key, digest }) => ({ key, digest })),
      });
      const path = join(directory, checkpoint.id + '.json');
      writeFileSync(path, JSON.stringify(checkpoint, null, 2) + '\n', { flag: 'wx' });
      return {
        checkpointId: checkpoint.id,
        path,
        revision: snap.revision,
        createdAt: checkpoint.createdAt,
      };
    }
    if (!('checkpointId' in input)) throw new DomainError('Укажите checkpointId', 400);
    const file = safePath(root, prefix + '/checkpoints/' + input.checkpointId + '.json');
    if (lstatSync(file).size > 4 * 1024 * 1024)
      throw new DomainError('Checkpoint слишком большой', 413);
    const saved = checkpointSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    if (
      saved.id !== input.checkpointId ||
      saved.identity !== this.identity(identityPath) ||
      saved.repositoryId !== input.repositoryId
    )
      throw new DomainError('Checkpoint принадлежит другому контуру');
    const before = new Map(saved.records.map((r) => [r.key, r.digest]));
    const current = new Map(snap.records.map((r) => [r.key, r]));
    const changes = [...new Set([...before.keys(), ...current.keys()])].sort().flatMap((key) =>
      before.get(key) === current.get(key)?.digest
        ? []
        : [
            {
              key,
              change: !before.has(key) ? 'added' : !current.has(key) ? 'removed' : 'modified',
              current: current.get(key),
            },
          ],
    );
    return page(
      changes,
      {
        checkpointId: saved.id,
        summary: saved.summary,
        nextStep: saved.nextStep,
        createdAt: saved.createdAt,
        contextOnly: true,
        controlChanged: digest(saved.control) !== digest(snap.control),
      },
      snap.revision,
      'changes/' + saved.identity + '/' + saved.id,
      input,
    );
  }
  private identity(path: string) {
    if (lstatSync(path).size > 1000) throw new DomainError('Некорректная context identity', 400);
    return z
      .object({ version: z.literal(1), id: z.string().uuid() })
      .strict()
      .parse(JSON.parse(readFileSync(path, 'utf8'))).id;
  }
}
