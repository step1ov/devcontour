import { portableTest, unprovenReason } from './proof.ts';
import { validatePreparation } from './preparation.ts';
import { contractDigest, digest, scopeDigest, specDigest, type DevContour } from './service.ts';
import { effectiveChecks, obligationOf } from './checks.ts';
import { CheckCorpus, localRoots, portableSuite, type PortableSuite } from './check-store.ts';
import { dependencyOrder, expandGates, repository, requiresContract } from './repositories.ts';
import { assertDag } from './graph.ts';
import { validateTaskContext } from './workflow.ts';
import {
  taskInput,
  type DevContourState,
  type Task,
  type Approval,
  type Board,
  type Evidence,
  type Contract,
} from './model.ts';
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
    (run.policyDigest === h.policyDigest(t.repositoryId) ||
    run.policyDigest === h.policyDigest(t.repositoryId, true)
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
    ...(t.approvedScope ? { scopeDigest: t.approvedScope } : {}),
    policyDigest: run.policyDigest,
    candidateSha: run.candidateSha,
    resultSha: t.resultSha,
    finishedAt: run.finishedAt,
    runtime: run.runtime,
    reviewer: run.reviewer,
    requiredGates,
    checks: run.evidence.map(
      ({
        kind,
        phase,
        sha,
        gate,
        consumer,
        passed,
        exitCode,
        digest,
        tests,
        testsTruncated,
        checks,
        property,
      }) => ({
        kind,
        phase,
        sha,
        gate,
        ...(consumer ? { consumer } : {}),
        passed,
        exitCode,
        digest,
        // Evidence прежней версии хранило имена без предела длины: одно
        // длинное постороннее имя делало весь receipt непереносимым.
        ...(tests ? { tests: tests.map(portableTest) } : {}),
        ...(testsTruncated ? { testsTruncated } : {}),
        ...(checks ? { checks } : {}),
        ...(property?.level
          ? {
              property: {
                level: property.level,
                seed: property.seed,
                ...(property.manifest ? { manifest: property.manifest } : {}),
              },
            }
          : {}),
      }),
    ),
    ...(run.consumers?.length
      ? {
          consumers: run.consumers.map((c) => {
            if (!c.checked)
              throw new Error(`Проверка потребителя ${c.repositoryId} не записала, что проверено`);
            return { repositoryId: c.repositoryId, gates: c.gates, ...c.checked };
          }),
        }
      : {}),
    ...(run.dependencies
      ? {
          dependencies: run.dependencies.map((d) => {
            const head = run.dependencyFreshness?.find(
              (f) => f.repositoryId === d.repositoryId,
            )?.head;
            return {
              repositoryId: d.repositoryId,
              sha: d.sha,
              tree: d.tree,
              ...(head ? { head } : {}),
              artifacts: d.artifacts,
            };
          }),
        }
      : {}),
    ...(run.checks
      ? {
          checkVersion: {
            effective: run.checks.effective,
            ...(run.checks.corpus ? { corpus: run.checks.corpus } : {}),
          },
        }
      : {}),
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
        ...(t.approvedScope ? { approvedScope: t.approvedScope } : {}),
        approval: approval(t.approval),
        receiptId,
        ...(t.checkVersion ? { checkVersion: t.checkVersion } : {}),
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
                  results: Object.fromEntries(r.snapshot!.tasks.map((t) => [t.id, t.resultSha!])),
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
        // Путь к документу — часть происхождения контракта. Без него клон
        // восстанавливает текст, не зная, какому файлу в дереве он отвечает.
        source: c.source,
        // Закреплённые артефакты — часть договора: без них клон считал бы
        // digest по одному тексту и не узнал бы, какие файлы закреплены.
        ...(c.artifacts ? { artifacts: c.artifacts } : {}),
        ...(c.pinVersion ? { pinVersion: c.pinVersion } : {}),
        ...(c.checks ? { checks: c.checks } : {}),
        approvedAt: c.approvedAt,
      },
    });
  // Корпус проверок — запись владельца компонента: случаи, версии, решения и
  // принятия. Локальные операции и команды checker в Git не уходят.
  const roots = localRoots(h);
  for (const suite of new CheckCorpus(h).all())
    add(suite.repositoryId, { version: 1, kind: 'check', data: portableSuite(suite, roots) });
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
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && new Set(a).size === a.length && b.every((x) => a.includes(x));
export function validateReceipt(
  receipt: CompletionReceipt,
  t: Task,
  demo: boolean,
  /** Корпус по id: версия, на которую ссылается receipt, должна существовать. */
  suites: (id: string) => PortableSuite | undefined = () => undefined,
  /** Контракты состояния: по ним находятся гейты объявленных свойств задачи. */
  contracts: Contract[] = [],
  /**
   * Сверка с конфигурацией этого клона: раскрытие области компонента (gates
   * задачи или потребителя) и состав зависимостей компонента.
   */
  scope: {
    expand?: (repositoryId: string, refs: string[]) => string[];
    dependencyIds?: (repositoryId: string) => string[];
  } = {},
) {
  const expand = scope.expand ?? ((_r: string, refs: string[]) => refs);
  if (
    receipt.taskId !== t.id ||
    receipt.repositoryId !== t.repositoryId ||
    receipt.specDigest !== specDigest(t)
  )
    throw new Error(`Receipt не соответствует постановке ${t.id}`);
  // Receipt нового формата узнаётся по любому из его полей: тогда обязательны
  // все. Иначе удаление одного закрепления выдавало бы новую запись за
  // прежнюю и снимало бы проверку, которую запись по-прежнему несёт.
  const consumersObserved = (receipt.consumers ?? []).map(
    (c) => c.freshness !== undefined || c.observedAt !== undefined,
  );
  if (
    (receipt.scopeDigest !== undefined || consumersObserved.some(Boolean)) &&
    (receipt.scopeDigest === undefined ||
      (receipt.consumers ?? []).some((c) => !c.freshness || !c.observedAt))
  )
    throw new Error(`Receipt ${t.id}: запись нового формата неполна`);
  // Утверждённая область проверок закреплена и в задаче, и в receipt: правка
  // области вместе с receipt не проходит, пока утверждение не обновлено, а
  // закрепление receipt сверяется с постановкой и без закрепления в задаче.
  if (receipt.scopeDigest !== undefined && receipt.scopeDigest !== scopeDigest(t))
    throw new Error(`Receipt ${t.id}: область проверок не соответствует утверждённой`);
  if (
    t.approvedScope &&
    (receipt.scopeDigest !== t.approvedScope || scopeDigest(t) !== t.approvedScope)
  )
    throw new Error(`Receipt ${t.id}: область проверок не соответствует утверждённой`);
  if (
    !demo &&
    (receipt.runtime === 'demo' ||
      receipt.reviewer === 'demo' ||
      receipt.runtime === receipt.reviewer)
  )
    throw new Error(`Нет независимого runtime review: ${t.id}`);
  if (t.requirements?.length && !receipt.requiredGates.includes('requirement-source'))
    throw new Error('Receipt не проверяет требования: ' + t.id);
  // Вид записи и гейт согласованы: ревью — только независимое ревью, тест —
  // только гейт. Иначе одну проверку могли бы закрыть две разные записи.
  if (receipt.checks.some((c) => (c.kind === 'review') !== (c.gate === 'independent-review')))
    throw new Error(`Receipt ${t.id}: вид проверки не соответствует гейту`);
  // Решающая запись проверки — одна и та же для PASS, версии и манифеста.
  // Запись потребителя закрывает только проверку потребителя.
  const decisive = (
    kind: 'test' | 'review',
    phase: 'candidate' | 'integration',
    gate: string,
    consumer?: string,
  ) =>
    receipt.checks.findLast(
      (c) =>
        c.kind === kind &&
        c.phase === phase &&
        c.gate === gate &&
        c.consumer === consumer &&
        c.sha === (phase === 'candidate' ? receipt.candidateSha : receipt.resultSha),
    );
  // Гейты объявленных свойств задачи обязательны независимо от содержимого
  // requiredGates: иначе receipt мог бы исключить проваленный гейт свойства
  // и подставить вместо него другой PASS.
  const byGate = new Map<string, string[]>();
  for (const id of t.properties ?? []) {
    const found = obligationOf(t, contracts, id);
    if (!found) throw new Error(`Receipt ${t.id}: свойство ${id} не объявлено в договорах задачи`);
    byGate.set(found.gate, [...(byGate.get(found.gate) ?? []), id]);
  }
  const required = [
    ...[...new Set([...receipt.requiredGates, ...byGate.keys()])].map(
      (gate) => ['test', gate] as const,
    ),
    ['review', 'independent-review'] as const,
  ];
  for (const phase of ['candidate', 'integration'] as const)
    for (const [kind, gate] of required) {
      const check = decisive(kind, phase, gate);
      if (!check?.passed || check.exitCode !== 0)
        throw new Error(`Нет PASS в receipt ${t.id}: ${phase}/${gate}`);
    }
  // Область задачи раскрывается в этом клоне: receipt не может сократить
  // обязательный набор, убрав gates группы из своих requiredGates. Если
  // группы клонов разошлись, receipt отклоняется — совместимость конфигураций
  // значит, что раскрытие получателя покрыто проверками отправителя.
  const own = expand(t.repositoryId ?? 'main', t.gates ?? []);
  const missingOwn = own.filter((g) => !receipt.requiredGates.includes(g));
  if (missingOwn.length)
    throw new Error(
      `Receipt ${t.id}: область задачи требует ${missingOwn.join(', ')}, а receipt их не проверял`,
    );
  // Снимок собственных зависимостей нового формата полон и согласован.
  const ownIds = scope.dependencyIds?.(t.repositoryId ?? 'main');
  if (receipt.dependencies && ownIds) {
    if (
      !sameSet(
        receipt.dependencies.map((d) => d.repositoryId),
        ownIds,
      )
    )
      throw new Error(
        `Receipt ${t.id}: снимок зависимостей не совпадает с зависимостями компонента`,
      );
    if (receipt.dependencies.some((d) => !d.head))
      throw new Error(
        `Receipt ${t.id}: у снимка зависимостей нет головы ветки на момент завершения`,
      );
  }
  // Объявленные задачей потребители проверены на integration тем же
  // составом, что даёт её постановка; receipt не может их опустить.
  for (const consumer of t.consumers ?? []) {
    const recorded = receipt.consumers?.find((c) => c.repositoryId === consumer.repositoryId);
    if (!recorded)
      throw new Error(`Receipt ${t.id}: нет проверок потребителя ${consumer.repositoryId}`);
    // Что проверено: снимок всех зависимостей потребителя, и компонент задачи
    // в нём — именно принятый результат.
    const ids = scope.dependencyIds?.(consumer.repositoryId);
    if (
      ids &&
      !sameSet(
        recorded.dependencies.map((d) => d.repositoryId),
        ids,
      )
    )
      throw new Error(
        `Receipt ${t.id}: снимок зависимостей потребителя ${consumer.repositoryId} не совпадает с его зависимостями`,
      );
    // Свежесть названа для каждого фактического входа, кроме компонента задачи,
    // и согласована сама с собой: снимок — тот, что проверен, а «свеж» значит,
    // что голова ветки совпала со снимком.
    if (recorded.freshness) {
      if (
        ids &&
        !sameSet(
          recorded.freshness.map((x) => x.repositoryId),
          [...ids.filter((id) => id !== t.repositoryId), consumer.repositoryId],
        )
      )
        throw new Error(
          `Receipt ${t.id}: свежесть входов потребителя ${consumer.repositoryId} названа не для всех`,
        );
      for (const x of recorded.freshness) {
        const checked =
          x.repositoryId === consumer.repositoryId
            ? recorded.sha
            : recorded.dependencies.find((d) => d.repositoryId === x.repositoryId)?.sha;
        if (
          x.repositoryId === t.repositoryId ||
          x.snapshot !== checked ||
          x.fresh !== (x.snapshot === x.head)
        )
          throw new Error(
            `Receipt ${t.id}: свежесть входа ${x.repositoryId} потребителя ${consumer.repositoryId} противоречит проверенному снимку`,
          );
      }
    }
    const provider = recorded.dependencies.find((d) => d.repositoryId === t.repositoryId);
    if (provider?.sha !== receipt.resultSha)
      throw new Error(
        `Receipt ${t.id}: потребитель ${consumer.repositoryId} проверен не на принятом результате`,
      );
    for (const gate of expand(consumer.repositoryId, consumer.gates)) {
      const check = decisive('test', 'integration', gate, consumer.repositoryId);
      if (!check?.passed || check.exitCode !== 0)
        throw new Error(`Нет PASS в receipt ${t.id}: integration/${consumer.repositoryId}:${gate}`);
    }
  }
  // Названный сценарий подтверждается и в чужом receipt по тому же правилу,
  // что при локальном finish: иначе импортированная задача становилась done и
  // открывала зависимые, хотя её manifest прямо не содержит нужного теста.
  // Receipt без manifest у задачи с testId тоже не подтверждает — такой
  // задачи не существовало до появления testId.
  const unproven = unprovenReason(t.requirements, receipt.checks as Evidence[], receipt.resultSha);
  if (unproven) throw new Error(`Receipt ${t.id}: ${unproven}`);
  // Задача с договором проверки принимается только с версией проверок:
  // receipt без неё — неполный новый формат, а не прежний уровень.
  if (t.properties?.length && !receipt.checkVersion)
    throw new Error(`Receipt ${t.id} задачи с договором проверки без версии проверок`);
  const version = receipt.checkVersion;
  // Решающие записи integration одной попытки получены под одной версией
  // проверок, и это видно без агрегатного поля: его удаление не делает
  // PASS потребителя под чужой версией допустимым.
  const integration = [
    ...required.map(([kind, gate]) => decisive(kind, 'integration', gate)!),
    ...(t.consumers ?? []).flatMap((consumer) =>
      expand(consumer.repositoryId, consumer.gates).map(
        (gate) => decisive('test', 'integration', gate, consumer.repositoryId)!,
      ),
    ),
  ];
  if (!version) {
    if (new Set(integration.map((c) => c.checks)).size > 1)
      throw new Error(
        `Receipt ${t.id}: решающие проверки integration получены под разными версиями`,
      );
    return;
  }
  if (
    version.effective !==
    effectiveChecks(
      {
        approvedDigest: receipt.specDigest,
        contractDigests: t.contractDigests,
        checkVersion: version.corpus,
      },
      receipt.policyDigest,
    )
  )
    throw new Error(`Receipt ${t.id}: версия проверок не соответствует постановке и корпусу`);
  for (const phase of ['candidate', 'integration'] as const)
    for (const [kind, gate] of required)
      if (decisive(kind, phase, gate)!.checks !== version.effective)
        throw new Error(`Receipt ${t.id}: ${phase}/${gate} получен под другой версией проверок`);
  // Решающий PASS потребителя — под той же версией проверок, что и попытка.
  for (const consumer of t.consumers ?? [])
    for (const gate of expand(consumer.repositoryId, consumer.gates))
      if (
        decisive('test', 'integration', gate, consumer.repositoryId)!.checks !== version.effective
      )
        throw new Error(
          `Receipt ${t.id}: integration/${consumer.repositoryId}:${gate} получен под другой версией проверок`,
        );
  // Случаи принятой версии корпуса берутся из Git, а не из receipt.
  let corpusCases: { id: string; property: string }[] = [];
  if (version.corpus) {
    const suite = suites(version.corpus.suite);
    const pinned = suite?.versions.find((v) => v.digest === version.corpus!.digest);
    if (!suite || !pinned)
      throw new Error(
        `Receipt ${t.id} ссылается на версию корпуса ${version.corpus.suite}#${version.corpus.number}, которой нет в Git`,
      );
    corpusCases = pinned.cases.map((id) => ({
      id,
      property: suite.cases.find((c) => c.id === id)?.property ?? '',
    }));
  }
  // Манифест свойств обеих фаз переносится вместе с результатом: без него
  // импорт выдал бы сильный уровень за прежний. Обязательный корпус гейта
  // сверяется с версией из Git: убрать его из манифеста или занизить число
  // случаев нельзя; гейт без случаев выбранного корпуса манифеста корпуса не несёт.
  for (const [gate, ids] of byGate) {
    const own = corpusCases.filter((c) => ids.includes(c.property)).length;
    for (const phase of ['candidate', 'integration'] as const) {
      const check = decisive('test', phase, gate);
      const manifest = check?.property?.manifest;
      if (
        check?.property?.level !== 'manifest' ||
        !manifest ||
        ids.some((id) => !manifest.properties.includes(id))
      )
        throw new Error(`Receipt ${t.id}: ${phase}/${gate} без манифеста свойств задачи`);
      if (
        own
          ? manifest.corpus?.digest !== version.corpus!.digest || manifest.corpus.cases !== own
          : manifest.corpus !== undefined
      )
        throw new Error(
          `Receipt ${t.id}: ${phase}/${gate} не исполнял обязательный корпус версии ${version.corpus?.suite ?? ''}`,
        );
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
    if (
      owner !== record.data.repositoryId ||
      contractDigest(
        record.data.content,
        record.data.artifacts,
        record.data.pinVersion,
        record.data.checks,
      ) !== record.data.digest
    )
      throw new Error('Неверный владелец или digest контракта: ' + record.data.id);
    const previous = old.contracts.find((c) => c.id === record.data.id);
    // Неизменяема вся запись, а не только digest: убранная версия
    // закрепления или другой blob при прежнем digest давали историю, которую
    // следующий клон уже не принимал.
    // Сравниваются все переносимые поля: другое название при прежнем digest
    // давало клоны с разными контрактами и разным составом затронутых задач.
    const pinned = (c: {
      title: string;
      content: string;
      source?: string;
      artifacts?: unknown;
      pinVersion?: number;
      checks?: unknown;
      approvedAt: string;
    }) =>
      JSON.stringify({
        title: c.title,
        content: c.content,
        source: c.source ?? null,
        artifacts: c.artifacts ?? null,
        pinVersion: c.pinVersion ?? null,
        checks: c.checks ?? null,
        approvedAt: c.approvedAt,
      });
    if (
      previous &&
      (previous.digest !== record.data.digest ||
        previous.repositoryId !== owner ||
        pinned(previous) !== pinned(record.data))
    )
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
        // Удержание — локальная операция этой установки: импорт его не снимает.
        ...(previous?.hold ? { hold: previous.hold } : {}),
        attempt: previous?.attempt ?? 0,
        contractDigests: progress.approvedDigest ? contractDigests : {},
        approvedDigest: progress.approvedDigest,
        approvedScope: progress.approvedDigest ? progress.approvedScope : undefined,
        ...(progress.checkVersion ? { checkVersion: progress.checkVersion } : {}),
        approval:
          previous?.approvedDigest === progress.approvedDigest &&
          canonical(approval(previous?.approval)) === canonical(progress.approval)
            ? previous?.approval
            : progress.approval,
      };
      if (progress.approvedDigest && progress.approvedDigest !== specDigest(t))
        throw new Error('Постановка изменилась после утверждения: ' + t.id);
      if (progress.approvedScope && progress.approvedScope !== scopeDigest(t))
        throw new Error('Область проверок изменилась после утверждения: ' + t.id);
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
        validateReceipt(
          receipt,
          t,
          h.config.mode === 'demo',
          (id) => {
            const found = all.find((x) => x.record.kind === 'check' && x.record.data.id === id);
            return found?.record.kind === 'check' ? found.record.data : undefined;
          },
          s.contracts,
          {
            expand: (repositoryId, refs) => expandGates(repository(h.config, repositoryId), refs),
            dependencyIds: (repositoryId) =>
              dependencyOrder(h.config, repository(h.config, repositoryId).dependsOn ?? []),
          },
        );
        // Принятая задача закреплена за той версией корпуса, под которой её
        // проверили: другая привязка в записи — подмена.
        if (
          canonical(receipt.checkVersion?.corpus ?? null) !==
          canonical(progress.checkVersion ?? null)
        )
          throw new Error('Привязка корпуса не совпадает с receipt: ' + t.id);
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
              canonical(before.snapshot?.repositories) !== canonical(r.accepted.repositories) ||
              (r.accepted.results !== undefined &&
                canonical(r.accepted.results) !==
                  canonical(
                    Object.fromEntries(
                      (before.snapshot?.tasks ?? []).map((t) => [t.id, t.resultSha]),
                    ),
                  ))
            )
              throw new Error('Принятая ревизия неизменяема: ' + b.id);
            return before;
          }
          if (!r.accepted) return { ...r, status: 'active' as const };
          // Тот же объём, что при приёмке: отменённые задачи в снимок не входят.
          // Манифест отправителя задаёт состав: задачи вне него — отменённые,
          // а свои результаты объединение изменить не вправе.
          const results = r.accepted.results;
          const accepted = results
            ? tasks.filter((t) => t.id in results)
            : tasks.filter((t) => t.status !== 'cancelled');
          if (
            results &&
            (Object.keys(results).some((id) => !r.taskIds.includes(id)) ||
              accepted.some((t) => t.status !== 'done' || t.resultSha !== results[t.id]) ||
              tasks.some((t) => !(t.id in results) && t.status !== 'cancelled'))
          )
            throw new Error(
              `Принятая ревизия ${r.number} доски ${b.id} расходится с манифестом приёмки; верните работу новой задачей`,
            );
          if (!accepted.length || accepted.some((t) => t.status !== 'done'))
            throw new Error('Приёмка требует завершённых задач: ' + b.id);
          const snapshot = {
            tasks: accepted,
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
  // Задачи принятой ревизии неизменяемы (D11) и после слияния истории: clone,
  // ещё не знавший о приёмке, мог законно вернуть отменённую задачу в работу.
  // Локальный запрет такое объединение не видит, а возрождённая задача потом
  // снова отменялась бы «исторически», не останавливая workflow.
  for (const b of s.boards)
    for (const r of b.revisions) {
      if (r.status !== 'accepted') continue;
      for (const id of r.taskIds) {
        const t = s.tasks.find((t) => t.id === id)!;
        const accepted = r.snapshot?.tasks.find((x) => x.id === id);
        if (
          accepted
            ? t.status !== 'done' || t.resultSha !== accepted.resultSha
            : t.status !== 'cancelled'
        )
          throw new Error(
            `Задача ${id} принятой ревизии ${r.number} доски ${b.id} изменилась после приёмки; верните её работу новой задачей`,
          );
      }
    }
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
