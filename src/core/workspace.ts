import { delivered } from './delivery.ts';
import { componentImpact } from './workflow.ts';
import { randomUUID } from 'node:crypto';
import { entityId } from './ids.ts';
import { z } from 'zod';
import { Harness, digest, specDigest } from './service.ts';
import { repositories } from './repositories.ts';
import {
  DomainError,
  requireValue,
  type HarnessState,
  type ChangeSet,
  type Verification,
  type WorkspaceEvidence,
  type Approval,
} from './model.ts';

export const changeSetInput = z.object({
  title: z.string().trim().min(3).max(180),
  description: z.string().trim().min(10).max(12000),
  boardIds: z.array(z.string()).min(1).max(100),
  supersedes: z.string().optional(),
});
const find = (s: HarnessState, id: string) =>
  requireValue(
    s.changeSets.find((c) => c.id === id),
    'ChangeSet не найден',
  );
export function changeSnapshot(s: HarnessState, c: ChangeSet) {
  const boards = c.boardIds.map((id) =>
    requireValue(
      s.boards.find((b) => b.id === id),
      'Доска не найдена',
    ),
  );
  const ids = new Set(boards.flatMap((b) => b.revisions.at(-1)!.taskIds));
  const tasks = s.tasks.filter((t) => ids.has(t.id));
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

export class Workspace {
  constructor(readonly h: Harness) {}
  policyDigest() {
    return digest({
      repositories: repositories(this.h.config),
      environment: this.h.config.environment,
      workspaceLifecycle: this.h.config.workspaceLifecycle,
      gates: this.h.config.workspaceGates,
      verificationMode: this.h.config.verificationMode,
      resources: this.h.config.resources,
      resourceDatabase: this.h.config.resourceDatabase,
    });
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
  start(id: string) {
    const gates = this.h.config.workspaceGates;
    if (!gates.some((g) => g.kind === 'test' && g.report))
      throw new DomainError('Настройте обязательные интеграционные workspaceGates с JUnit');
    for (const repo of repositories(this.h.config).filter((r) => r.kind === 'product'))
      if (!gates.some((g) => g.repositoryId === repo.id && g.kind === 'test' && g.report))
        throw new DomainError(`Нужна интеграционная проверка продукта ${repo.id}`);
    return this.h.store.change('workspace.verification.started', (s) => {
      const c = find(s, id);
      if (c.acceptance) throw new DomainError('ChangeSet уже принят; создайте следующий');
      if (
        s.changeSets.some((x) =>
          x.deliveries?.some((d) => d.status === 'active' && d.leaseUntil > Date.now()),
        )
      )
        throw new DomainError('Доставка ещё выполняется');
      if (s.runs.some((r) => r.status === 'active' && r.leaseUntil > Date.now()))
        throw new DomainError('Дождитесь текущих задач перед проверкой workspace');
      for (const other of s.changeSets)
        for (const v of other.verifications) {
          if (v.status !== 'active') continue;
          if (v.leaseUntil > Date.now())
            throw new DomainError('Проверка workspace уже выполняется');
          v.status = 'failed';
          v.error = 'Истёк срок владения проверкой';
          v.finishedAt = new Date().toISOString();
        }
      if (c.verifications.length >= this.h.config.maxAttempts)
        throw new DomainError('Исчерпан лимит попыток ChangeSet');
      const snapshot = changeSnapshot(s, c);
      if (!snapshot.tasks.length || snapshot.tasks.some((t) => t.status !== 'done' || !t.resultSha))
        throw new DomainError('Сначала завершите все задачи ChangeSet');
      const v: Verification = {
        id: randomUUID(),
        token: randomUUID(),
        startedAt: new Date().toISOString(),
        leaseUntil: Date.now() + this.h.config.leaseMs,
        status: 'active',
        policyDigest: this.policyDigest(),
        specDigest: snapshotDigest(snapshot),
        ...snapshot,
        evidence: [],
      };
      c.verifications.push(v);
      return { changeSetId: id, verification: v };
    }).verification;
  }
  private update<T>(id: string, token: string, event: string, action: (v: Verification) => T): T {
    return this.h.store.change(event, (s) => {
      const c = find(s, id),
        v = c.verifications.at(-1);
      if (
        !v ||
        c.acceptance ||
        v.status !== 'active' ||
        v.token !== token ||
        v.leaseUntil <= Date.now()
      )
        throw new DomainError('Устаревшая попытка проверки workspace');
      if (
        v.policyDigest !== this.policyDigest() ||
        v.specDigest !== snapshotDigest(changeSnapshot(s, c))
      )
        throw new DomainError('Состав ChangeSet или политика изменились; нужна новая проверка');
      return action(v);
    });
  }
  heartbeat(id: string, token: string) {
    this.update(id, token, 'heartbeat', (v) => {
      v.leaseUntil = Date.now() + this.h.config.leaseMs;
    });
  }
  manifest(id: string, token: string, manifest: NonNullable<Verification['manifest']>) {
    return this.update(id, token, 'workspace.manifest', (v) => {
      if (v.manifest) throw new DomainError('Manifest уже закреплён');
      const ids = repositories(this.h.config)
        .map((r) => r.id)
        .sort();
      if (
        JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(ids) ||
        Object.values(manifest).some(
          (m) => !/^[a-f0-9]{40,64}$/.test(m.sha) || !/^[a-f0-9]{40,64}$/.test(m.tree),
        )
      )
        throw new DomainError('Manifest должен фиксировать SHA и tree каждого репозитория');
      v.manifest = manifest;
      v.manifestDigest = digest(manifest);
      v.impact = componentImpact(this.h.config, this.h.store.read(), v);
      return { changeSetId: id, verificationId: v.id, manifest, digest: v.manifestDigest };
    });
  }
  evidence(id: string, token: string, evidence: WorkspaceEvidence) {
    return this.update(id, token, 'workspace.evidence', (v) => {
      v.evidence.push(evidence);
      return { changeSetId: id, verificationId: v.id, ...evidence };
    });
  }
  finish(id: string, token: string) {
    return this.update(id, token, 'workspace.verified', (v) => {
      if (!v.manifest || digest(v.manifest) !== v.manifestDigest)
        throw new DomainError('Нет закреплённого manifest');
      for (const gate of this.h.config.workspaceGates.filter(
        (g) => !v.impact || v.impact.gateIds.includes(g.id),
      ))
        if (!v.evidence.findLast((e) => e.gate === gate.id)?.passed)
          throw new DomainError(`Нет PASS: ${gate.id}`);
      v.status = 'passed';
      v.finishedAt = new Date().toISOString();
      return { changeSetId: id, verificationId: v.id, manifest: v.manifest };
    });
  }
  fail(id: string, token: string, error: string) {
    return this.h.store.change('workspace.failed', (s) => {
      const c = find(s, id),
        v = c.verifications.at(-1);
      if (c.acceptance || !v || v.token !== token || v.status !== 'active') return;
      v.status = 'failed';
      v.error = error;
      v.finishedAt = new Date().toISOString();
      return { changeSetId: id, verificationId: v.id, error };
    });
  }
  accept(id: string, approval: Approval = { actor: 'agent' }) {
    return this.h.store.change('changeset.accepted', (s) => {
      const c = find(s, id);
      if (c.acceptance) return { status: 'already-accepted', changeSetId: id };
      const v = c.verifications.at(-1);
      if (
        !v ||
        v.status !== 'passed' ||
        !v.manifest ||
        digest(v.manifest) !== v.manifestDigest ||
        v.policyDigest !== this.policyDigest() ||
        v.specDigest !== snapshotDigest(changeSnapshot(s, c))
      )
        throw new DomainError('Нет актуальной успешной проверки всего ChangeSet');
      for (const gate of this.h.config.workspaceGates.filter(
        (g) => !v.impact || v.impact.gateIds.includes(g.id),
      ))
        if (!v.evidence.findLast((e) => e.gate === gate.id)?.passed)
          throw new DomainError('Отсутствует интеграционное evidence');
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
      };
      return { status: 'accepted', changeSetId: id, ...c.acceptance };
    });
  }
}
