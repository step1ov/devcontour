import { assertTaskPreparation } from './preparation.ts';
import { settledJointVerifications } from './joint-budget.ts';
import { delivered } from './delivery.ts';
import { entityId } from './ids.ts';
import { z } from 'zod';
import { DevContour, digest, specDigest } from './service.ts';
import { domain, executionOf } from '../harness/execution.ts';
import { repositories } from './repositories.ts';
import type { ProductReleaseProof } from './product-map.ts';
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
  validate(
    proof: ProductReleaseProof,
    snapshot: ReturnType<typeof changeSnapshot>,
    manifest?: Verification['manifest'],
  ): void;
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
        if (c.verifications.length >= this.h.config.maxAttempts)
          throw new DomainError('Исчерпан лимит попыток ChangeSet');
        const snapshot = changeSnapshot(s, c);
        snapshot.tasks.forEach((t) => assertTaskPreparation(s, t));
        if (!snapshot.tasks.length) throw new DomainError('Сначала завершите все задачи ChangeSet');
        const baseline = this.baseline(s, !!c.releaseId);
        const started = store.withJointTarget(id, () =>
          engine.jointStart({
            workIds: snapshot.tasks.map((t) => t.id),
            ...(baseline ? { baseline } : {}),
          }),
        );
        const productRelease = c.releaseId
          ? this.guard().capture(c.releaseId, snapshot)
          : undefined;
        const v = c.verifications.find((x) => x.id === started.id)!;
        v.boards = snapshot.boards;
        v.tasks = structuredClone(snapshot.tasks);
        if (productRelease) v.productRelease = productRelease;
        ht.journal({ changeSetId: id, verification: v });
        return structuredClone(v);
      }),
    );
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
    return this.h.currentChange('changeset.accepted', (s) => {
      const c = find(s, id);
      if (c.acceptance) return { status: 'already-accepted', changeSetId: id };
      changeSnapshot(s, c).tasks.forEach((t) => assertTaskPreparation(s, t));
      const { verification: v, current } = currentJoint(this.h, c);
      if (!v || !current || c.releaseId !== v.productRelease?.releaseId)
        throw new DomainError('Нет актуальной успешной проверки всего ChangeSet');
      if (c.releaseId) {
        if (v.productRelease?.releaseId !== c.releaseId)
          throw new DomainError('Нет закреплённой проверки продуктового релиза');
        this.guard().validate(v.productRelease, changeSnapshot(s, c), v.manifest);
      }
      const delivery = delivered(this.h, c);
      if (this.h.config.completionMode === 'remote' && !delivery)
        throw new DomainError(
          'ChangeSet проверен локально; сначала подтвердите публикацию, merge и CI через read-only forge adapter',
        );
      if (this.h.config.approvalMode === 'operator' && approval.actor !== 'operator')
        return { status: 'awaiting-operator', changeSetId: id };
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
      return { status: 'accepted', changeSetId: id, ...c.acceptance };
    });
  }
}
