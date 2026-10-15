import { preparationState } from './preparation-model.ts';
import { z } from 'zod';
import { taskInput, relativePath } from './model.ts';
import { checkDeclaration } from './checks.ts';

export const syncId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
const date = z.iso.datetime();
const runtime = z.enum(['codex', 'claude', 'demo']);
/** Предел файла переносимой записи: его проверяет чтение состояния из Git. */
export const maxRecordBytes = 2 * 1024 * 1024;
/** Предел receipt: запись завершения несёт его с небольшой обвязкой. */
export const maxReceiptBytes = maxRecordBytes - 64 * 1024;
export const receiptSchema = z.strictObject({
  id: syncId,
  taskId: syncId,
  repositoryId: syncId,
  specDigest: hash,
  /** Утверждённая область проверок; нет поля — утверждение прежнего формата. */
  scopeDigest: hash.optional(),
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
        /** Проверка потребителя: компонент, в рабочем дереве которого она выполнена. */
        consumer: syncId.optional(),
        passed: z.boolean(),
        exitCode: z.number().int(),
        digest: hash,
        // Манифест выполненных testcases: без него критерий, назвавший свой
        // тест, в другом клоне подтвердить нечем. Поля необязательны —
        // прежние receipts читаются на прежнем уровне доказательства.
        tests: z
          .array(
            z.strictObject({
              id: z.string().min(1).max(1000),
              status: z.enum(['passed', 'failed', 'skipped']),
              opaque: z.literal(true).optional(),
            }),
          )
          .max(2000)
          .optional(),
        testsTruncated: z.literal(true).optional(),
        /** Версия проверок, под которой получено evidence. */
        checks: hash.optional(),
        /**
         * Манифест генеративной проверки: уровень доказательства, seed и
         * ожидавшиеся свойства и корпус. Переносится то, что исполнялось, —
         * клон не дорисовывает evidence из наличия файла корпуса.
         */
        property: z
          .strictObject({
            level: z.enum(['manifest', 'legacy']),
            seed: z.number().int().min(0),
            manifest: z
              .strictObject({
                digest: hash,
                properties: z.array(z.string().min(1).max(200)).max(30),
                corpus: z.strictObject({ digest: hash, cases: z.number().int().min(0) }).optional(),
              })
              .optional(),
          })
          .optional(),
      }),
    )
    .min(4),
  /** Проверки потребителей попытки: раскрытые списки gates по компонентам. */
  consumers: z
    .array(
      z.strictObject({
        repositoryId: syncId,
        // Без предела сверх профиля: как и собственные requiredGates, область
        // потребителя переносится целиком.
        gates: z.array(syncId).min(1),
        /** Проверенная голова потребителя и снимок всех его зависимостей. */
        sha,
        tree: sha,
        dependencies: z
          .array(
            z.strictObject({
              repositoryId: syncId,
              sha,
              tree: sha,
              // Снимок переносится целиком: конфигурация не ограничивает число
              // артефактов и зависимостей, а обрезка скрыла бы входы проверки.
              artifacts: z.array(
                z.strictObject({ path: z.string().min(1).max(500), digest: hash }),
              ),
            }),
          ),
        /**
         * Свежесть фактических входов и момент наблюдения. Нет полей — receipt
         * прежнего формата: наблюдение тогда не делалось и неизвестно.
         */
        freshness: z
          .array(
            z.strictObject({ repositoryId: syncId, snapshot: sha, head: sha, fresh: z.boolean() }),
          )
          .optional(),
        observedAt: z.iso.datetime().optional(),
      }),
    )
    .max(10)
    .optional(),
  /**
   * Снимок зависимостей, на котором проверен результат: компонент, SHA, tree,
   * голова ветки на момент завершения и digest артефактов. Пустой список —
   * у компонента нет зависимостей. Нет поля — receipt прежнего формата: его
   * снимок неизвестен и проверке не подлежит.
   */
  dependencies: z
    .array(
      z.strictObject({
        repositoryId: syncId,
        sha,
        tree: sha,
        /** Голова целевой ветки зависимости на момент завершения. */
        head: sha.optional(),
        // Целиком, как и снимок потребителя.
        artifacts: z.array(z.strictObject({ path: z.string().min(1).max(500), digest: hash })),
      }),
    )
    .optional(),
  /**
   * Действующая версия проверок попытки и принятый ею корпус. Нет поля —
   * receipt прежнего формата: читается с прежней гарантией.
   */
  checkVersion: z
    .strictObject({
      effective: hash,
      corpus: z
        .strictObject({ suite: syncId, number: z.number().int().min(1), digest: hash })
        .optional(),
    })
    .optional(),
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
  /** Принятая задачей версия корпуса; вне постановки, переносится отдельно. */
  checkVersion: z
    .strictObject({ suite: syncId, number: z.number().int().min(1), digest: hash })
    .optional(),
  approvedDigest: hash.optional(),
  approvedScope: hash.optional(),
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
      /**
       * Манифест приёмки: выполненные задачи снимка и их SHA. Без него
       * clone, впервые получивший приёмку, собирал снимок из уже
       * объединённых задач — и задача, доведённая им до done после чужой
       * приёмки, попадала в принятое. Отсутствует в записях прежних версий.
       */
      results: z.record(syncId, sha).optional(),
    })
    .optional(),
});
const text = (max: number) => z.string().min(1).max(max);
const portableSuiteSchema = z.strictObject({
  id: syncId,
  repositoryId: syncId,
  contractId: syncId,
  contractDigest: hash,
  gate: syncId,
  basis: hash,
  cases: z
    .array(
      z.strictObject({
        id: syncId,
        property: text(200),
        input: text(64 * 1024),
        expected: text(64 * 1024),
        source: z.strictObject({
          kind: z.literal('oracle'),
          decision: syncId,
          sha,
          runId: text(80).optional(),
          taskId: syncId.optional(),
          reproduction: text(80).optional(),
        }),
        addedAt: date,
      }),
    )
    .max(5000),
  versions: z
    .array(
      z.strictObject({
        number: z.number().int().min(1),
        digest: hash,
        previous: hash.nullable(),
        cases: z.array(syncId).max(5000),
        blob: sha,
        createdAt: date,
        reason: text(2000),
        decisions: z.array(syncId).max(5000),
      }),
    )
    .max(5000),
  decisions: z
    .array(
      z.strictObject({
        id: syncId,
        key: text(120).optional(),
        property: text(200),
        input: z.string().max(64 * 1024),
        inputHash: z.string().max(64),
        outcome: z.enum(['confirmed', 'refuted', 'inconclusive', 'rejected']),
        reason: z.string().max(4000),
        claimed: z
          .strictObject({
            expected: z
              .string()
              .max(64 * 1024)
              .nullable(),
            actual: z
              .string()
              .max(64 * 1024)
              .nullable(),
            reproduction: text(80).optional(),
          })
          .optional(),
        source: z.strictObject({ sha, runId: text(80).optional(), taskId: syncId.optional() }),
        observed: z
          .strictObject({
            expected: z
              .string()
              .max(64 * 1024)
              .optional(),
            actual: z
              .string()
              .max(64 * 1024)
              .optional(),
            equal: z.boolean().optional(),
            repeats: z.number().int().min(0),
            durationsMs: z.array(z.number().min(0)).max(10),
          })
          .optional(),
        method: z
          .strictObject({
            gate: syncId,
            artifacts: z.array(z.strictObject({ path: relativePath, blob: sha })).max(50),
            contract: syncId,
            basis: hash,
          })
          .optional(),
        caseId: syncId.optional(),
        version: z.number().int().min(1).optional(),
        origin: z.strictObject({
          kind: z.enum(['review', 'lead', 'agent', 'operator']),
          runtime: text(40).optional(),
        }),
        at: date,
      }),
    )
    .max(10000),
  adoptions: z
    .array(
      z.strictObject({
        id: syncId,
        taskId: syncId,
        from: z.strictObject({ number: z.number().int().min(1), digest: hash }).nullable(),
        to: z.strictObject({ number: z.number().int().min(1), digest: hash }),
        actor: text(80),
        reason: z.string().max(4000),
        operation: syncId,
        at: date,
      }),
    )
    .max(10000),
});
export const recordSchema = z.discriminatedUnion('kind', [
  z.strictObject({ version: z.literal(1), kind: z.literal('preparation'), data: preparationState }),
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
      source: relativePath.optional(),
      artifacts: z
        .array(
          z.strictObject({
            repositoryId: syncId,
            path: relativePath,
            purpose: z.string().min(1).max(200),
            revision: z.string().regex(/^[a-f0-9]{40,64}$/),
            blob: z.string().regex(/^[a-f0-9]{40,64}$/),
            digest: hash,
          }),
        )
        .max(50)
        .optional(),
      pinVersion: z.literal(2).optional(),
      checks: checkDeclaration.optional(),
      approvedAt: date,
    }),
  }),
  z.strictObject({ version: z.literal(1), kind: z.literal('check'), data: portableSuiteSchema }),
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
