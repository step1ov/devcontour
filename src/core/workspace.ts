import { assertTaskPreparation } from './preparation.ts';
import {
  changeSetSpent,
  jointBudgetRefusal,
  jointResetIds,
  settledJointVerifications,
} from './joint-budget.ts';
import { delivered } from './delivery.ts';
import { entityId } from './ids.ts';
import { z } from 'zod';
import { HarnessError } from 'devcontour-harness';
import { DevContour, digest, specDigest } from './service.ts';
import { domain, executionOf } from '../harness/execution.ts';
import { repositories } from './repositories.ts';
import type { DeferredScenario, ProductReleaseProof, UnconfirmedScenario } from './product-map.ts';
import {
  DomainError,
  requireValue,
  type DevContourState,
  type ChangeSet,
  type Verification,
  type WorkspaceEvidence,
  type Approval,
  type Config,
} from './model.ts';

export const changeSetInput = z.object({
  releaseId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,50}$/)
    .optional(),
  title: z.string().trim().min(3).max(180),
  description: z.string().trim().min(10).max(12000),
  boardIds: z.array(z.string()).min(1).max(100),
  supersedes: z.string().optional(),
});
const find = (s: DevContourState, id: string) =>
  requireValue(
    s.changeSets.find((c) => c.id === id),
    'ChangeSet не найден',
  );
export function changeSnapshot(s: DevContourState, c: ChangeSet) {
  const boards = c.boardIds.map((id) =>
    requireValue(
      s.boards.find((b) => b.id === id),
      'Доска не найдена',
    ),
  );
  const ids = new Set(boards.flatMap((b) => b.revisions.at(-1)!.taskIds));
  // Отменённая задача — учтённое решение, а не незавершённая работа: её нет и
  // в снимке приёмки доски. Здесь она требовала done, и ChangeSet доски с
  // отменой нельзя было даже начать проверять.
  const tasks = s.tasks.filter((t) => ids.has(t.id) && t.status !== 'cancelled');
  return {
    boards: boards.map((b) => ({ id: b.id, title: b.title, revision: b.revisions.at(-1)!.number })),
    tasks,
  };
}
export const snapshotDigest = (snapshot: ReturnType<typeof changeSnapshot>) =>
  digest({
    boards: snapshot.boards,
    tasks: snapshot.tasks.map((t) => ({
      id: t.id,
      spec: specDigest(t),
      status: t.status,
      resultSha: t.resultSha,
    })),
  });

export interface ProductReleaseGuard {
  capture(releaseId: string, snapshot: ReturnType<typeof changeSnapshot>): ProductReleaseProof;
  /**
   * Отказывает, если релиз не готов; называет отложенные решением
   * пользователя сценарии и сценарии последней приёмки, изменённые или
   * удалённые без его решения.
   */
  validate(
    proof: ProductReleaseProof,
    snapshot: ReturnType<typeof changeSnapshot>,
    manifest?: Verification['manifest'],
  ): { deferredScenarios: DeferredScenario[]; unconfirmedScenarios?: UnconfirmedScenario[] };
}

/**
 * Digest политики совместной проверки — прежняя формула DevContour: ею
 * подписаны принятые проверки ChangeSet. Движок сравнивает её как формулу хоста.
 */
export function workspacePolicyDigest(config: Config) {
  return digest({
    repositories: repositories(config),
    environment: config.environment,
    workspaceLifecycle: config.workspaceLifecycle,
    gates: config.workspaceGates,
    verificationMode: config.verificationMode,
    resources: config.resources,
    resourceDatabase: config.resourceDatabase,
    // Совместные проверки исполняются в той же песочнице, что и проверки
    // задач: её смена делает прежнюю проверку другой по условиям.
    isolation: config.isolation,
    // Закрепление контекста — часть договора исполнения задач, которые
    // проверка подтверждает: после его смены прежняя проверка не принимает
    // ChangeSet, а её поставка — тем более.
    ...(config.contextPacks.length ? { contextPacks: config.contextPacks } : {}),
  });
}

/**
 * Актуальность последней проверки ChangeSet — правило движка (`jointResult`):
 * успешная, целый manifest, текущая политика, неизменное основание, PASS
 * каждого gate своей области. Продуктовые условия (релиз) проверяет вызывающий.
 */
export function currentJoint(h: DevContour, c: ChangeSet) {
  const v = c.verifications.at(-1);
  if (!v) return { verification: undefined, current: false, reason: 'Проверки ChangeSet нет' };
  const { engine } = executionOf(h);
  const { current, reason } = engine.jointResult(
    v.tasks.map((t) => t.id),
    v.id,
  );
  return { verification: v, current, ...(reason ? { reason } : {}) };
}

export class Workspace {
  constructor(
    readonly h: DevContour,
    readonly productGuard?: ProductReleaseGuard,
  ) {}
  private guard() {
    return requireValue(
      this.productGuard,
      'Продуктовый релиз требует проверки INTENT через runner',
    );
  }
  policyDigest() {
    return workspacePolicyDigest(this.h.config);
  }
  create(input: unknown) {
    const parsed = changeSetInput.parse(input);
    return this.h.store.change('changeset.created', (s) => {
      if (new Set(parsed.boardIds).size !== parsed.boardIds.length)
        throw new DomainError('Доски не должны повторяться');
      for (const id of parsed.boardIds)
        requireValue(
          s.boards.find((b) => b.id === id),
          'Доска не найдена',
        );
      if (parsed.supersedes && !find(s, parsed.supersedes).acceptance)
        throw new DomainError('supersedes должен ссылаться на принятый ChangeSet');
      const c: ChangeSet = {
        ...parsed,
        id: entityId(s, 'CHG'),
        createdAt: new Date().toISOString(),
        verifications: [],
      };
      s.changeSets.push(c);
      return c;
    });
  }
  /**
   * База для области `affected` — последняя принятая проверка ChangeSet под
   * текущей политикой (продуктовый выбор). Продуктовый релиз и неполный граф
   * компонентов проверяются целиком: база не передаётся.
   */
  private baseline(s: DevContourState, release: boolean) {
    if (release || this.h.config.verificationMode !== 'affected') return undefined;
    if (repositories(this.h.config).some((r) => r.dependsOn === undefined)) return undefined;
    const policy = this.policyDigest();
    return s.changeSets
      .filter((c) => c.acceptance)
      .sort((a, b) => b.acceptance!.at.localeCompare(a.acceptance!.at))
      .map((c) => c.verifications.find((v) => v.id === c.acceptance!.verificationId))
      .find((v) => v?.manifest && v.policyDigest === policy)?.id;
  }
  /**
   * Начать проверку ChangeSet: продуктовые условия (ChangeSet не принят, нет
   * идущей поставки, предел попыток ChangeSet, подготовка задач, снимок
   * продуктового релиза) и правила движка (`jointStart`: gates с JUnit,
   * применённая политика, нет попыток и другой живой проверки, поручения
   * приняты) — одна запись.
   */
  start(id: string) {
    const { store, engine } = executionOf(this.h);
    return domain(() =>
      store.host('workspace.verification.started', (ht) => {
        const s = ht.state;
        const c = find(s, id);
        if (c.acceptance) throw new DomainError('ChangeSet уже принят; создайте следующий');
        if (
          s.changeSets.some((x) =>
            x.deliveries?.some((d) => d.status === 'active' && d.leaseUntil > Date.now()),
          )
        )
          throw new DomainError('Доставка ещё выполняется');
        const snapshot = changeSnapshot(s, c);
        const workIds = snapshot.tasks.map((t) => t.id);
        // Предел самого ChangeSet — те же правила, что у движка: прерванные
        // до результата gates и снятые сбросом оператора проверки не тратят.
        const resetIds = jointResetIds(ht.tx);
        const refusal = { changeSetId: id, resetIds };
        if (changeSetSpent(c, resetIds) >= this.h.config.maxAttempts)
          throw new DomainError(
            jointBudgetRefusal(s, workIds, this.h.config.maxAttempts, 'changeset', refusal),
          );
        snapshot.tasks.forEach((t) => assertTaskPreparation(s, t));
        if (!snapshot.tasks.length) throw new DomainError('Сначала завершите все задачи ChangeSet');
        // То же условие движок проверит в `jointStart`; здесь — до снимка
        // релиза, чтобы незавершённая работа называлась прежде покрытия.
        const open = snapshot.tasks.filter((t) => t.status !== 'done' || !t.resultSha);
        if (open.length)
          throw new DomainError(
            'Сначала завершите все задачи ChangeSet: ' +
              open
                .slice(0, 10)
                .map((t) => t.id)
                .join(', ') +
              (open.length > 10 ? ` и ещё ${open.length - 10}` : ''),
          );
        const baseline = this.baseline(s, !!c.releaseId);
        // Снимок релиза — до начала проверки движком: покрытие продукта
        // читает Git синхронно, а срок владения проверкой идёт с `jointStart`.
        // Снятый после него, снимок съедал срок до первого продления, и
        // проверка начиналась с истёкшим сроком.
        const productRelease = c.releaseId
          ? this.guard().capture(c.releaseId, snapshot)
          : undefined;
        let started;
        try {
          started = store.withJointTarget(id, () =>
            engine.jointStart({ workIds, ...(baseline ? { baseline } : {}) }),
          );
        } catch (error) {
          // Предел движка — по набору задач: отказ называет и прерванные
          // проверки, и путь, которого у прежнего текста не было.
          if (error instanceof HarnessError && error.code === 'ATTEMPTS_EXHAUSTED')
            throw new DomainError(
              jointBudgetRefusal(s, workIds, this.h.config.maxAttempts, 'set', refusal),
            );
          throw error;
        }
        const v = c.verifications.find((x) => x.id === started.id)!;
        v.boards = snapshot.boards;
        v.tasks = structuredClone(snapshot.tasks);
        if (productRelease) v.productRelease = productRelease;
        ht.journal({ changeSetId: id, verification: v });
        return structuredClone(v);
      }),
    );
  }
  /**
   * Сброс бюджета совместных проверок набора задач ChangeSet — решение
   * оператора с причиной (`jointBudgetReset` движка): снимает только
   * завершённые проверки набора без результата gates. Никогда не вызывается
   * автоматически и не доступен ведущему агенту.
   */
  budgetReset(id: string, reason: string) {
    if (!reason.trim()) throw new DomainError('Укажите причину сброса: --reason …');
    const { engine } = executionOf(this.h);
    const s = this.h.store.read();
    const c = find(s, id);
    if (c.acceptance) throw new DomainError('ChangeSet уже принят: его набору сброс не нужен');
    const workIds = changeSnapshot(s, c).tasks.map((t) => t.id);
    if (!workIds.length) throw new DomainError('В ChangeSet нет задач');
    const record = domain(() => engine.jointBudgetReset(workIds, { reason, actor: 'operator' }));
    return { changeSetId: id, ...record };
  }
  /** Текущая проверка ChangeSet: записи — только её владельцем (fencing движка). */
  private latest(id: string) {
    const v = this.h.store
      .read()
      .changeSets.find((c) => c.id === id)
      ?.verifications.at(-1);
    if (!v) throw new DomainError('Устаревшая попытка проверки workspace');
    return v;
  }
  heartbeat(id: string, token: string) {
    const { engine } = executionOf(this.h);
    const v = this.latest(id);
    domain(() => engine.jointHeartbeat(v.id, token));
  }
  manifest(id: string, token: string, manifest: NonNullable<Verification['manifest']>) {
    const { engine } = executionOf(this.h);
    const v = this.latest(id);
    const pinned = domain(() => engine.jointManifest(v.id, token, manifest));
    return {
      changeSetId: id,
      verificationId: v.id,
      manifest,
      digest: pinned.manifestDigest,
    };
  }
  evidence(id: string, token: string, evidence: WorkspaceEvidence) {
    const { engine } = executionOf(this.h);
    const v = this.latest(id);
    domain(() => engine.jointEvidence(v.id, token, evidence));
    return { changeSetId: id, verificationId: v.id, ...evidence };
  }
  finish(id: string, token: string) {
    const { engine } = executionOf(this.h);
    const v = this.latest(id);
    const done = domain(() => engine.jointFinish(v.id, token));
    return { changeSetId: id, verificationId: v.id, manifest: done.manifest! };
  }
  fail(id: string, token: string, error: string) {
    const { engine } = executionOf(this.h);
    const v = this.h.store
      .read()
      .changeSets.find((c) => c.id === id)
      ?.verifications.at(-1);
    if (!v) return undefined;
    return domain(() => engine.jointFail(v.id, token, error))
      ? { changeSetId: id, verificationId: v.id, error }
      : undefined;
  }
  accept(id: string, approval: Approval = { actor: 'agent' }) {
    // Повтор приёмки называет отложенные сценарии так же, как первая:
    // принятый релиз с непроверенными сценариями не выглядит полным.
    const acceptedNotes = (c: ChangeSet) => {
      const v = c.verifications.find((x) => x.id === c.acceptance?.verificationId);
      if (!c.releaseId || !v?.productRelease) return {};
      try {
        const { deferredScenarios } = this.guard().validate(
          v.productRelease,
          changeSnapshot(this.h.store.read(), c),
          v.manifest,
        );
        return deferredScenarios.length ? { deferredScenarios } : {};
      } catch {
        // Карта или покрытие изменились после приёмки: актуальный список
        // показывает product-view, а не повтор приёмки.
        return {};
      }
    };
    return this.h.currentChange('changeset.accepted', (s) => {
      const c = find(s, id);
      if (c.acceptance) return { status: 'already-accepted', changeSetId: id, ...acceptedNotes(c) };
      changeSnapshot(s, c).tasks.forEach((t) => assertTaskPreparation(s, t));
      let deferred: DeferredScenario[] = [];
      let unconfirmed: UnconfirmedScenario[] = [];
      const { verification: v, current } = currentJoint(this.h, c);
      if (!v || !current || c.releaseId !== v.productRelease?.releaseId)
        throw new DomainError('Нет актуальной успешной проверки всего ChangeSet');
      if (c.releaseId) {
        if (v.productRelease?.releaseId !== c.releaseId)
          throw new DomainError('Нет закреплённой проверки продуктового релиза');
        const checked = this.guard().validate(v.productRelease, changeSnapshot(s, c), v.manifest);
        deferred = checked.deferredScenarios;
        unconfirmed = checked.unconfirmedScenarios ?? [];
      }
      // Отложенные сценарии не проверены: приёмка называет их, а не молчит.
      const notes = deferred.length ? { deferredScenarios: deferred } : {};
      const delivery = delivered(this.h, c);
      if (this.h.config.completionMode === 'remote' && !delivery)
        throw new DomainError(
          'ChangeSet проверен локально; сначала подтвердите публикацию, merge и CI через read-only forge adapter',
        );
      // Сценарии последней приёмки, изменённые или удалённые в карте, сужают
      // релиз без решения пользователя: такую приёмку подтверждает оператор и
      // в режиме agent. Его приёмка и есть решение — она становится образцом
      // объёма следующей сверки.
      if (unconfirmed.length && approval.actor !== 'operator')
        return {
          status: 'awaiting-operator',
          changeSetId: id,
          unconfirmedScenarios: unconfirmed,
          reason:
            'Сценарии релиза изменены или удалены после прошлой приёмки: объём релиза подтверждает пользователь приёмкой ChangeSet («Принять» во «Внимании»)',
          ...notes,
        };
      if (this.h.config.approvalMode === 'operator' && approval.actor !== 'operator')
        return { status: 'awaiting-operator', changeSetId: id, ...notes };
      c.acceptance = {
        at: new Date().toISOString(),
        verificationId: v.id,
        deliveryId: delivery?.id,
        digest: digest(v),
        approval,
        jointBudgetCheckpoint: {
          verificationId: v.id,
          settledVerificationIds: settledJointVerifications(
            s,
            v.tasks.map((t) => t.id),
          ),
        },
      };
      return {
        status: 'accepted',
        changeSetId: id,
        ...c.acceptance,
        ...notes,
        ...(unconfirmed.length ? { confirmedScenarioChanges: unconfirmed } : {}),
      };
    });
  }
}
