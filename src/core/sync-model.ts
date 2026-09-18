import { z } from 'zod';
import { taskInput } from './model.ts';

export const syncId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
const date = z.iso.datetime();
const runtime = z.enum(['codex', 'claude', 'demo']);
export const receiptSchema = z.strictObject({
  id: syncId,
  taskId: syncId,
  repositoryId: syncId,
  specDigest: hash,
  policyDigest: hash,
  candidateSha: sha,
  resultSha: sha,
  finishedAt: date,
  runtime,
  reviewer: runtime,
  requiredGates: z.array(syncId).min(1),
  checks: z
    .array(
      z.strictObject({
        kind: z.enum(['test', 'review']),
        phase: z.enum(['candidate', 'integration']),
        sha,
        gate: syncId,
        passed: z.boolean(),
        exitCode: z.number().int(),
        digest: hash,
      }),
    )
    .min(4),
});
export type CompletionReceipt = z.infer<typeof receiptSchema>;
const task = taskInput
  .extend({ id: syncId, createdAt: date, supersedes: syncId.optional() })
  .strict();
export const sharedApprovalSchema = z.strictObject({
  actor: z.enum(['operator', 'agent']),
  authorRuntime: z.enum(['codex', 'claude']).optional(),
  reviewerRuntime: z.enum(['codex', 'claude']).optional(),
  digest: hash.optional(),
});
const progress = z.strictObject({
  status: z.enum(['draft', 'ready', 'done', 'failed', 'cancelled']),
  receiptId: syncId.optional(),
  approvedDigest: hash.optional(),
  approval: sharedApprovalSchema.optional(),
});
const revision = z.strictObject({
  number: z.number().int().positive(),
  reason: z.string().min(1).max(5000),
  taskIds: z.array(syncId),
  createdAt: date,
  accepted: z
    .strictObject({
      at: date,
      sha,
      repositories: z.record(syncId, sha).optional(),
    })
    .optional(),
});
export const recordSchema = z.discriminatedUnion('kind', [
  z.strictObject({ version: z.literal(1), kind: z.literal('task'), data: task, progress }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal('board'),
    data: z.strictObject({
      id: syncId,
      repositoryId: syncId.optional(),
      scope: z.enum(['component', 'workspace']).optional(),
      title: z.string().min(3).max(180),
      description: z.string().max(12000),
      revisions: z.array(revision).min(1),
    }),
  }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal('contract'),
    data: z.strictObject({
      id: syncId,
      repositoryId: syncId.optional(),
      title: z.string().min(1).max(180),
      content: z.string().min(1).max(60000),
      digest: hash,
      approvedAt: date,
    }),
  }),
  z.strictObject({ version: z.literal(1), kind: z.literal('receipt'), data: receiptSchema }),
  z.strictObject({
    version: z.literal(1),
    kind: z.literal('changeset'),
    data: z.strictObject({
      releaseId: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,50}$/)
        .optional(),
      id: syncId,
      title: z.string().min(3).max(180),
      description: z.string().min(10).max(12000),
      boardIds: z.array(syncId).min(1),
      createdAt: date,
      supersedes: syncId.optional(),
    }),
  }),
]);
export type SyncRecord = z.infer<typeof recordSchema>;
export type Records = Record<string, SyncRecord>;
export const identitySchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  repositoryId: syncId.optional(),
});
export type SyncIdentity = z.infer<typeof identitySchema>;
export const recordKey = (r: SyncRecord) =>
  `${r.kind === 'changeset' ? 'changesets' : r.kind + 's'}/${r.data.id}`;
export function canonical(value: unknown): string {
  return (
    JSON.stringify(
      value,
      (_key, item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map((key) => [key, item[key]]),
            )
          : item,
      2,
    ) + '\n'
  );
}

// Arrays are atomic, except additive membership edits on a board/ChangeSet.
export function mergeValue(base: any, local: any, remote: any, path = ''): any {
  const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
  if (equal(local, remote)) return local;
  if (equal(local, base)) return remote;
  if (equal(remote, base)) return local;
  if (path.endsWith('.taskIds') || path.endsWith('.boardIds')) {
    if (
      [base, local, remote].every(Array.isArray) &&
      base.every((id: string) => local.includes(id) && remote.includes(id))
    )
      return [...new Set([...base, ...local, ...remote])].sort();
  }
  if (
    path.endsWith('.revisions') &&
    [base, local, remote].every(Array.isArray) &&
    base.length === local.length &&
    base.length === remote.length &&
    base.every((r: any, i: number) => r.number === local[i].number && r.number === remote[i].number)
  )
    return base.map((r: any, i: number) => mergeValue(r, local[i], remote[i], `${path}.${i}`));
  if ([base, local, remote].every((v) => v && typeof v === 'object' && !Array.isArray(v))) {
    return Object.fromEntries(
      [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])]
        .sort()
        .map((key) => [key, mergeValue(base[key], local[key], remote[key], `${path}.${key}`)]),
    );
  }
  throw new Error(`Конфликт ${path || 'записи'}`);
}
