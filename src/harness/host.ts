// Хост DevContour для движка harness: основания, продуктовые условия,
// области бюджетов, согласование контрактов и коннекторы.
//
// Формулы оснований — прежние формулы DevContour (`specDigest`,
// `scopeDigest`, `taskPolicyDigest`): они записаны в принятой истории и
// receipts, и движок их только сравнивает. Продуктовые условия могут лишь
// запретить действие: снять отказ движка или поставить PASS хост не может.
import { readFileSync } from 'node:fs';
import {
  API_VERSION,
  HarnessError,
  contextDigest,
  executionDigest,
  resultProblems,
  sha256,
  closeIfBasisChanged,
  sourceDigest,
  type ContextSnapshot,
  type ContractDocument,
  type ContextSource,
  type ExecutionHost,
  type ExecutionView,
  type HostRefusal,
  type Prerequisite,
  type ReceiverContext,
  type ResultSink,
  type RunResult,
  type WorkSource,
  type WorkState,
} from 'devcontour-harness';
import type { DevContour } from '../core/service.ts';
import { digest, receiptBytes, scopeDigest, specDigest } from '../core/service.ts';
import type { ContextPack, DevContourState, Task } from '../core/model.ts';
import { assertTaskPreparation } from '../core/preparation.ts';
import { validateTaskContext } from '../core/workflow.ts';
import { maxRecordBytes } from '../core/sync-model.ts';
import { completion, validateReceipt } from '../core/sync-state.ts';
import { contents, taskContext } from '../runner/context.ts';
import { effectiveChecks } from '../core/checks.ts';
import { roleBinding } from '../core/repositories.ts';
import type { UsageRecord } from '../core/usage.ts';
import {
  activeRevision,
  contractDocumentOf,
  orderOf,
  type ProjectionOptions,
} from './projection.ts';
import { approvalPolicyDigest, policyFromConfig } from './policy.ts';
import {
  changeSnapshot,
  snapshotDigest,
  workspacePolicyDigest,
  type ProductReleaseGuard,
} from '../core/workspace.ts';
import { acceptedJointBudgetCheckpoints } from '../core/joint-budget.ts';
import { IntentService } from '../runner/intent.ts';
import type { StoryBindingGuard } from '../core/intent.ts';

/** Проверка продуктового релиза (INTENT) — продуктовая служба DevContour. */
const releaseGuard = (h: DevContour): ProductReleaseGuard => new IntentService(h);
/**
 * Проверка привязки задач к историям INTENT при утверждении — та же служба:
 * ядро получает её отсюда и Git само не читает.
 */
export const storyGuard = (h: DevContour): StoryBindingGuard => new IntentService(h);
import type { DevContourExecutionStore } from './store.ts';

const refusal = (code: NonNullable<HostRefusal>['code'], message: string): HostRefusal => ({
  code,
  message,
});
/** Отказ продуктовой проверки как причина хоста, а не исключение движка. */
function guarded(code: NonNullable<HostRefusal>['code'], check: () => void): HostRefusal {
  try {
    check();
    return null;
  } catch (error) {
    return refusal(code, error instanceof Error ? error.message : String(error));
  }
}

/** Пакеты контекста задачи — тот же выбор, что у `taskContext`: названные и пакеты роли. */
export function taskPacks(h: DevContour, task: Task): ContextPack[] {
  return h.config.contextPacks.filter(
    (pack) =>
      task.contextPacks?.includes(pack.id) ||
      (pack.repositoryId === task.repositoryId && pack.roles.includes(task.role)),
  );
}

/**
 * Версия хоста, которую движок записывает в новой попытке и её результате:
 * `<имя>@<версия>` установленного пакета DevContour. Читается из его
 * `package.json` относительно этого модуля (`src/` и собранный `lib/` лежат
 * на одном уровне), а не из каталога запуска. Прежним попыткам её не
 * приписывают: поле записывается только новыми.
 */
export const CONSUMER_VERSION = (() => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    name: string;
    version: string;
  };
  return `${pkg.name}@${pkg.version}`;
})();

/** Сведения хоста для проекции записей: digest политики и выбор области и контекста. */
export function projectionOptions(h: DevContour): ProjectionOptions {
  return {
    policyDigest: () => executionDigest(policyFromConfig(h.config)),
    approvalPolicy: () => approvalPolicyDigest(h.config),
    // Действующая роль задачи: роль компонента заменяет одноимённую роль
    // workspace целиком, как в политике исполнения.
    roleScope: (task) => roleBinding(h.config, task.role, task.repositoryId)?.writePaths,
    contextPacks: (task) => taskPacks(h, task).map((p) => p.id),
    contractDigest: (id) => h.store.read().contracts.find((c) => c.id === id)?.digest,
  };
}

const taskOf = (state: DevContourState, work: WorkState) => {
  const task = state.tasks.find((t) => t.id === work.id);
  if (!task) throw new HarnessError('NOT_FOUND', 'Задача не найдена: ' + work.id);
  return task;
};

/** Доска задачи для учёта: первая, в любой ревизии которой задача есть (прежнее правило). */
const budgetBoard = (state: DevContourState, taskId: string) =>
  state.boards.find((b) => b.revisions.some((r) => r.taskIds.includes(taskId)));
const boardMembers = (state: DevContourState, boardId: string) => [
  ...new Set(state.boards.find((b) => b.id === boardId)?.revisions.flatMap((r) => r.taskIds) ?? []),
];

/**
 * Хост движка над хранилищем `store`. `h` — прикладной слой DevContour:
 * конфигурация и прежние формулы политики задачи.
 */
export function devcontourHost(h: DevContour, store: DevContourExecutionStore): ExecutionHost {
  const state = (view: ExecutionView) => store.stateOf(view);
  return {
    store,
    consumerVersion: CONSUMER_VERSION,
    // Готовность задачи: согласована и дождалась зависимостей — успешной
    // попытки этого clone или receipt другого (прежнее правило выдачи).
    readyAt: (work, view) => {
      const s = state(view);
      const t = taskOf(s, work);
      const dependencyDates = t.dependsOn.map((id) => {
        const dependency = s.tasks.find((x) => x.id === id);
        return (
          s.runs.findLast((r) => r.taskId === id && r.status === 'succeeded')?.finishedAt ??
          dependency?.sharedCompletion?.receipt.finishedAt
        );
      });
      return t.approvedAt && dependencyDates.every(Boolean)
        ? [t.approvedAt, ...(dependencyDates as string[])].sort().at(-1)
        : undefined;
    },
    basis: {
      orderDigest: (work, view) => specDigest(taskOf(state(view), work)),
      scopeDigest: (work, view) => scopeDigest(taskOf(state(view), work)),
      policyDigest: (work, view) => h.taskPolicyDigest(taskOf(state(view), work)),
      // Версия проверок — прежняя формула DevContour: ею подписаны записи и receipts.
      checksDigest: (work, policyDigest, view) =>
        effectiveChecks(taskOf(state(view), work), policyDigest),
      // Основание эпизода разбора — прежняя формула DevContour: ею подписаны
      // эпизоды и попытки прежних версий. Постановка — согласованная редакция
      // поручения той же транзакции, контракты — закреплённые задачей.
      // Основание корпуса — прежняя формула DevContour: им записаны корпуса
      // прежних версий и ID их случаев.
      suiteBasis: (contract) => suiteBasisOf(contract),
      episodeBasis: (work, view) =>
        episodeBasisOf({
          approvedDigest: work.approvedDigest,
          contractDigests: taskOf(state(view), work).contractDigests,
        }),
      // Совместная проверка — прежние формулы DevContour: ими подписаны принятые ChangeSet.
      jointPolicyDigest: () => workspacePolicyDigest(h.config),
      jointBudgetCheckpoints: (workIds, view) =>
        acceptedJointBudgetCheckpoints(state(view), workIds),
      jointSpecDigest: (workIds, view, verificationId) => {
        const s = state(view);
        const changeSet = verificationId
          ? s.changeSets.find((c) => c.verifications.some((v) => v.id === verificationId))
          : s.changeSets.find((c) => c.id === store.startingChangeSet);
        // Проверка вне ChangeSet не принадлежит ни одному набору: основание не совпадёт.
        return changeSet
          ? snapshotDigest(changeSnapshot(s, changeSet))
          : sha256('no-changeset:' + JSON.stringify(workIds));
      },
    },
    guards: {
      // Поставка и preview идут под действующей конфигурацией: её применение их дожидается.
      busy: (view) => {
        const s = state(view);
        const now = Date.now();
        return [
          ...s.changeSets.flatMap((c) =>
            (c.deliveries ?? [])
              .filter((d) => d.status === 'active' && d.leaseUntil > now)
              .map((d) => d.id),
          ),
          ...(s.previewLock && s.previewLock.leaseUntil > now ? ['preview'] : []),
        ];
      },
      // Продуктовые условия записи совместной проверки: ChangeSet не принят,
      // релиз тот же, закреплённая проверка продуктового релиза актуальна.
      joint: (verification, view, kind) => {
        const s = state(view);
        const changeSet = s.changeSets.find((c) =>
          c.verifications.some((v) => v.id === verification.id),
        );
        const v = changeSet?.verifications.find((x) => x.id === verification.id);
        if (!changeSet || !v || changeSet.acceptance)
          return refusal('APPROVAL_STALE', 'Устаревшая попытка проверки workspace');
        if (changeSet.releaseId !== v.productRelease?.releaseId)
          return refusal(
            'APPROVAL_STALE',
            'Состав ChangeSet или политика изменились; нужна новая проверка',
          );
        if (changeSet.releaseId && v.productRelease) {
          const release = v.productRelease;
          if (kind === 'workspace.manifest' && v.manifest)
            return guarded('APPROVAL_STALE', () =>
              releaseGuard(h).validate(release, v, v.manifest),
            );
          if (kind === 'workspace.verified')
            return guarded('APPROVAL_STALE', () =>
              releaseGuard(h).validate(release, changeSnapshot(s, changeSet), v.manifest),
            );
        }
        return null;
      },
      // Активная поставка ChangeSet закрепила комбинацию: новые попытки сдвинули бы её.
      claimBarrier: (view) => {
        const delivery = state(view)
          .changeSets.flatMap((c) => (c.deliveries ?? []).map((d) => ({ c, d })))
          .find(({ d }) => d.status === 'active' && d.leaseUntil > Date.now());
        return delivery
          ? refusal('PAUSED', `Идёт поставка ${delivery.d.id} набора ${delivery.c.id}`)
          : null;
      },
      claimable: (work, view) => {
        const s = state(view);
        const task = taskOf(s, work);
        const visible = s.boards.some((b) =>
          b.revisions.some((r) => r.status === 'active' && r.taskIds.includes(task.id)),
        );
        if (!visible)
          return refusal('NOT_READY', `${task.id}: задачи нет в активной ревизии доски`);
        if (s.team && task.assignee !== s.team.member)
          return refusal('NOT_READY', `${task.id}: задача назначена другому участнику`);
        return (
          guarded('NOT_READY', () => assertTaskPreparation(s, task)) ??
          guarded('NOT_READY', () => validateTaskContext(h.config, task))
        );
      },
      current: (work, _attempt, view) =>
        guarded('APPROVAL_STALE', () =>
          assertTaskPreparation(state(view), taskOf(state(view), work)),
        ),
      // Принятый результат переносим: receipt, который чтение состояния из Git
      // отвергло бы по размеру, отклоняется до публикации.
      beforeAccept: (work, attempt, view) => {
        const s = structuredClone(state(view));
        const task = taskOf(s, work);
        const run = s.runs.find((r) => r.id === attempt.id);
        if (run) run.status = 'succeeded';
        task.status = 'done';
        task.resultSha = attempt.integrationSha;
        const bytes = receiptBytes(h, s, task);
        return bytes > maxRecordBytes
          ? refusal(
              'NOT_READY',
              `Запись receipt задачи ${task.id} занимает ${bytes} байт при пределе ${maxRecordBytes}: ` +
                'сократите dependencyArtifacts или область проверок',
            )
          : null;
      },
    },
    budgets: {
      groupOf: (workId, view) => budgetBoard(state(view), workId)?.id,
      members: (groupId, view) => boardMembers(state(view), groupId),
      // Прежнее правило атрибуции: задача — по попытке или предмету вызова;
      // доска — по текущему графу; вызов о доске — все задачи всех её ревизий.
      legacy: (record, view) => {
        const s = state(view);
        const r = record as unknown as UsageRecord & { subjectKind?: string };
        const taskId =
          (r.runId ? s.runs.find((x) => x.id === r.runId)?.taskId : undefined) ??
          (r.subjectId &&
          (!r.subjectKind || r.subjectKind === 'work') &&
          s.tasks.some((t) => t.id === r.subjectId)
            ? r.subjectId
            : undefined);
        if (taskId) {
          const board = budgetBoard(s, taskId);
          return { workId: taskId, ...(board ? { groupId: board.id } : {}) };
        }
        const boardId =
          record.groupId ?? (r.subjectKind === 'other' ? undefined : (r.subjectId ?? undefined));
        if (!boardId || !s.boards.some((b) => b.id === boardId)) return {};
        return { groupId: boardId, workIds: boardMembers(s, boardId) };
      },
    },
    // Согласование контракта DevContour — утверждённая редакция контракта:
    // запись `contracts[]` с её digest. Задача закрепляет digest при
    // утверждении; раунды ревью в форме harness из неё не выдумываются.
    contracts: {
      approved: (ref, view) => {
        const contract = state(view).contracts.find((c) => c.id === ref.id);
        if (!contract || !contract.approvedAt)
          return refusal('NOT_READY', `Контракт ${ref.id} не утверждён`);
        if (contract.digest !== ref.digest)
          return refusal(
            'APPROVAL_STALE',
            `Контракт ${ref.id}: задача закрепила другую редакцию (digest не совпадает)`,
          );
        return null;
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Коннекторы                                                          */
/* ------------------------------------------------------------------ */

/**
 * Источник поручений. В DevContour поручения не загружаются: граф строится
 * из состояния доски. Доверие к внешней предпосылке — receipt задачи
 * другого клона, импортированный Git-синхронизацией и прошедший её проверку.
 */
export function devcontourWorkSource(h: DevContour, store: DevContourExecutionStore): WorkSource {
  return {
    id: 'devcontour',
    fetch: (ref) =>
      Promise.resolve(
        store.read((v) => {
          const graph = v.graph(ref);
          if (!graph) throw new HarnessError('NOT_FOUND', 'Доска не найдена: ' + ref);
          return { graph: graph.graph, source: graph.graph.source };
        }),
      ),
    revision: (ref) =>
      Promise.resolve(
        store.read((v) => {
          const task = store.stateOf(v).tasks.find((t) => t.id === ref);
          return task ? specDigest(task) : undefined;
        }),
      ),
    trusts: (prerequisite: Prerequisite) =>
      Promise.resolve(
        store.read((v) => {
          const s = store.stateOf(v);
          const task = s.tasks.find((t) => t.id === prerequisite.id);
          const shared = task?.sharedCompletion;
          if (!task || !shared || shared.receipt.resultSha !== prerequisite.resultSha) return false;
          try {
            validateReceipt(h, shared.receipt, task, s.contracts);
            return true;
          } catch {
            return false;
          }
        }),
      ),
  };
}

/** Источник снимка из закреплённого пакета: документы на его ревизии, прежний digest пакета. */
async function packEntry(h: DevContour, pack: ContextPack) {
  if (!pack.revision || !pack.digest)
    throw new HarnessError(
      'NOT_READY',
      `Context pack ${pack.id} не закреплён; выполните context-lock после bootstrap-коммита`,
    );
  const documents = await contents(h.config, pack, pack.revision);
  if (digest({ id: pack.id, version: pack.version, documents }) !== pack.digest)
    throw new HarnessError('NOT_READY', 'Context digest не совпадает: ' + pack.id);
  const pin = (file: string) => {
    const content = documents.find((d) => d.file === file)!.content;
    return {
      path: file,
      digest: sha256(content),
      bytes: Buffer.byteLength(content),
      content: { encoding: 'utf8' as const, data: content },
    };
  };
  const entry = {
    id: pack.id,
    kind: 'context-pack',
    version: pack.version,
    repositoryId: pack.repositoryId,
    ...(/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(pack.revision) ? { revision: pack.revision } : {}),
    required: true,
    files: pack.files.map(pin),
    references: pack.references.filter((f) => documents.some((d) => d.file === f)).map(pin),
    hostDigest: pack.digest,
  };
  return { ...entry, digest: sourceDigest(entry) };
}

/**
 * Источник контекста: закреплённые context packs задачи (`ids` — поручения,
 * чей контекст закрепляется). Снимок — те же байты, что видит исполнитель
 * DevContour, с прежним digest пакета (`hostDigest`).
 */
export function devcontourContextSource(
  h: DevContour,
  store: DevContourExecutionStore,
): ContextSource & { forTask(taskId: string): Promise<ContextSnapshot> } {
  const forTask = async (taskId: string): Promise<ContextSnapshot> => {
    const s = store.read((v) => structuredClone(store.stateOf(v)));
    const task = s.tasks.find((t) => t.id === taskId);
    if (!task) throw new HarnessError('NOT_FOUND', 'Задача не найдена: ' + taskId);
    // Прежние условия контекста задачи: пакеты закреплены, digest совпадает,
    // закреплённая редакция файла контракта — утверждённая, предел объёма.
    try {
      await taskContext(
        h.config,
        task,
        s.contracts.filter((c) => task.contracts.includes(c.id)),
      );
    } catch (error) {
      throw new HarnessError('NOT_READY', error instanceof Error ? error.message : String(error));
    }
    const sources = [];
    for (const pack of taskPacks(h, task)) sources.push(await packEntry(h, pack));
    return { apiVersion: API_VERSION, sources, missing: [] };
  };
  return {
    id: 'devcontour-packs',
    forTask,
    snapshot: async (ids) => {
      const packs = h.config.contextPacks.filter((p) => ids.includes(p.id));
      const missing = ids.filter((id) => !packs.some((p) => p.id === id));
      if (missing.length)
        throw new HarnessError('NOT_READY', 'Неизвестный context pack: ' + missing.join(', '));
      const sources = [];
      for (const pack of packs) sources.push(await packEntry(h, pack));
      return { apiVersion: API_VERSION, sources, missing: [] };
    },
  };
}

/**
 * Что получатель знает сам о задаче: её постановка, доска, контракты,
 * политика этого клона и ожидаемый снимок контекста по его закреплённым
 * пакетам. Им проверяется переносимый результат (Git-синхронизация, доставка).
 */
export async function receiverContext(
  h: DevContour,
  store: DevContourExecutionStore,
  taskId: string,
): Promise<ReceiverContext> {
  const s = store.read((v) => structuredClone(store.stateOf(v)));
  const task = s.tasks.find((t) => t.id === taskId);
  if (!task) throw new HarnessError('NOT_FOUND', 'Задача не найдена: ' + taskId);
  const options = projectionOptions(h);
  const board = s.boards.find((b) => activeRevision(b)?.taskIds.includes(task.id));
  const packs = taskPacks(h, task);
  const snapshot = packs.length
    ? await devcontourContextSource(h, store).forTask(task.id)
    : undefined;
  return {
    order: orderOf(task, options),
    graphId: board?.id ?? 'devcontour-unassigned',
    contracts: task.contracts
      .map((id) => s.contracts.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => !!c)
      .map(contractDocumentOf),
    policy: policyFromConfig(h.config),
    contextDigest: snapshot ? contextDigest(snapshot) : null,
    specDigest: specDigest(task),
    checkVersion: task.checkVersion ?? null,
    // Корпус получателя — копия этой установки (общий Store).
    suite: (id) =>
      store.read((v) =>
        structuredClone(
          v
            .locals('check-suites')
            .map((x) => x.value)
            .find((x) => x.id === id),
        ),
      ),
    suiteBasis: (contract) => suiteBasisOf(contract),
    checksDigest: ({ specDigest: spec, policyDigest, corpus }) =>
      effectiveChecks(
        {
          approvedDigest: spec,
          contractDigests: task.contractDigests,
          ...(corpus ? { checkVersion: { ...task.checkVersion!, ...corpus } } : {}),
        },
        policyDigest,
      ),
  };
}

/**
 * Получатель результата. Принятый результат DevContour уже записан в
 * задачу; доставка подтверждает его переносимость проверкой получателя и
 * отвечает receipt задачи. Изменённая постановка — конфликт с её текущей
 * редакцией. Повтор с тем же ключом даёт тот же ответ и ничего не пишет.
 */
export function devcontourResultSink(h: DevContour, store: DevContourExecutionStore): ResultSink {
  return {
    id: 'devcontour-delivery',
    deliver: async ({ result }: { key: string; result: RunResult }) => {
      const s = store.read((v) => structuredClone(store.stateOf(v)));
      const task = s.tasks.find((t) => t.id === result.workOrderId);
      if (!task) throw new HarnessError('NOT_FOUND', 'Задача не найдена: ' + result.workOrderId);
      const current = specDigest(task);
      if (result.source.revision !== current)
        return { status: 'conflict', currentRevision: current };
      if (result.outcome !== 'accepted' || task.status !== 'done')
        throw new HarnessError(
          'NOT_READY',
          `Результат ${result.runId} не принят задачей ${task.id}`,
        );
      const problems = resultProblems(result, await receiverContext(h, store, task.id));
      if (problems.length)
        throw new HarnessError(
          'INVALID_INPUT',
          `Результат ${result.runId}: ${problems.join('; ')}`,
        );
      return { status: 'delivered', receipt: sha256(JSON.stringify(completion(h, s, task))) };
    },
  };
}

/**
 * Основание эпизода разбора по свойству — прежняя формула DevContour: ею
 * подписаны эпизоды и попытки прежних версий.
 */
export function episodeBasisOf(t: Pick<Task, 'approvedDigest' | 'contractDigests'>) {
  return sha256(JSON.stringify({ spec: t.approvedDigest ?? null, contracts: t.contractDigests }));
}

/**
 * Продуктовое согласование задачи (утверждение ревизии доски) меняет её
 * основание: эпизод прежнего основания закрывается правилом harness с
 * формулой основания DevContour, в той же записи.
 */
export function closeEpisodeIfBasisChanged(t: Task, at: string) {
  const work = {
    approvedDigest: t.approvedDigest,
    recovery: t.recovery,
    recoveryHistory: t.recoveryHistory,
  };
  if (closeIfBasisChanged(work as unknown as WorkState, at, episodeBasisOf(t))) {
    t.recovery = work.recovery;
    t.recoveryHistory = work.recoveryHistory;
  }
}

/**
 * Нормативное основание корпуса договора проверки — прежняя формула DevContour
 * (`digest` по тексту JSON): закреплённые файлы, gate и обязательства.
 */
export function suiteBasisOf(contract: Pick<ContractDocument, 'artifacts' | 'checks'>) {
  const declaration = contract.checks!;
  return digest({
    artifacts: (contract.artifacts ?? []).map((a) => ({ path: a.path, blob: a.blob })),
    gate: declaration.gate,
    // Gates обязательства и эталонная проверка входят, только когда
    // объявлены: основание прежних корпусов не меняется (как suiteBasis harness).
    obligations: declaration.obligations.map((o) => ({
      property: o.property,
      domain: o.domain,
      answer: o.answer,
      method: o.method,
      ...(o.gates ? { gates: o.gates } : {}),
      ...(o.verification ? { verification: o.verification } : {}),
      ...(o.reference ? { reference: o.reference } : {}),
    })),
  });
}
