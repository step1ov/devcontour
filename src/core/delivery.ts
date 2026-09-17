import { randomUUID } from 'node:crypto';
import { Harness, digest } from './service.ts';
import { Workspace, changeSnapshot, snapshotDigest } from './workspace.ts';
import { DomainError, type ChangeSet, type HarnessState } from './model.ts';
import type { Delivery, DeliveryComponent } from './integrations.ts';
import { repositories } from './repositories.ts';

export const deliveryPolicy = (h: Harness) =>
  digest({
    mode: h.config.completionMode,
    connections: h.config.forgeConnections,
    repositories: repositories(h.config),
    environment: h.config.environment,
  });
export function currentVerification(h: Harness, s: HarnessState, c: ChangeSet) {
  const v = c.verifications.at(-1);
  if (
    !v ||
    v.status !== 'passed' ||
    !v.manifest ||
    digest(v.manifest) !== v.manifestDigest ||
    v.policyDigest !== new Workspace(h).policyDigest() ||
    v.specDigest !== snapshotDigest(changeSnapshot(s, c))
  )
    throw new DomainError('Доставка требует актуальной успешной проверки ChangeSet');
  return v;
}
export function delivered(h: Harness, c: ChangeSet) {
  const v = c.verifications.at(-1);
  return c.deliveries?.findLast(
    (d) =>
      d.status === 'delivered' &&
      d.verificationId === v?.id &&
      d.manifestDigest === v?.manifestDigest &&
      d.policyDigest === deliveryPolicy(h),
  );
}
export class Deliveries {
  constructor(readonly h: Harness) {}
  start(id: string, namespace: string) {
    if (this.h.config.completionMode !== 'remote')
      throw new DomainError('Включите completionMode: remote');
    return this.h.store.change('delivery.started', (s) => {
      const c = s.changeSets.find((c) => c.id === id);
      if (!c) throw new DomainError('ChangeSet не найден');
      if (c.acceptance) throw new DomainError('ChangeSet уже принят');
      const v = currentVerification(this.h, s, c);
      if (
        s.runs.some((r) => r.status === 'active') ||
        s.changeSets.some((x) => x.verifications.some((r) => r.status === 'active'))
      )
        throw new DomainError('Дождитесь задач и проверок перед доставкой');
      if (
        s.changeSets.some((x) =>
          x.deliveries?.some((d) => d.status === 'active' && d.leaseUntil > Date.now()),
        )
      )
        throw new DomainError('Доставка уже выполняется');
      const complete = delivered(this.h, c);
      if (complete) return complete;
      c.deliveries ??= [];
      let d = c.deliveries.find(
        (d) => d.verificationId === v.id && d.policyDigest === deliveryPolicy(this.h),
      );
      if (!d) {
        d = {
          id: randomUUID(),
          verificationId: v.id,
          manifestDigest: v.manifestDigest!,
          policyDigest: deliveryPolicy(this.h),
          token: randomUUID(),
          leaseUntil: 0,
          status: 'active',
          startedAt: new Date().toISOString(),
          components: {},
        };
        for (const repo of repositories(this.h.config))
          d.components[repo.id] = {
            sha: v.manifest![repo.id].sha,
            tree: v.manifest![repo.id].tree,
            sourceBranch: `harness/delivery/${namespace}-${c.id}-${repo.id}-${v.manifest![repo.id].sha.slice(0, 12)}`,
            state: 'pending',
          };
        c.deliveries.push(d);
      }
      d.token = randomUUID();
      d.status = 'active';
      d.error = undefined;
      d.finishedAt = undefined;
      d.leaseUntil = Date.now() + this.h.config.leaseMs;
      return d;
    });
  }
  update<T>(id: string, token: string, event: string, action: (d: Delivery) => T): T {
    return this.h.store.change(event, (s) => {
      const c = s.changeSets.find((c) => c.id === id);
      const d = c?.deliveries?.find((d) => d.token === token);
      if (!c || !d || c.acceptance || d.status !== 'active' || d.leaseUntil <= Date.now())
        throw new DomainError('Устаревшая попытка доставки');
      const v = currentVerification(this.h, s, c);
      if (d.verificationId !== v.id || d.policyDigest !== deliveryPolicy(this.h))
        throw new DomainError('Политика доставки изменилась');
      return action(d);
    });
  }
  heartbeat(id: string, token: string) {
    this.update(id, token, 'heartbeat', (d) => {
      d.leaseUntil = Date.now() + this.h.config.leaseMs;
    });
  }
  component(id: string, token: string, repositoryId: string, component: DeliveryComponent) {
    this.update(id, token, 'delivery.component', (d) => {
      if (d.components[repositoryId]?.sha !== component.sha)
        throw new DomainError('SHA доставки изменился');
      d.components[repositoryId] = component;
      return { changeSetId: id, repositoryId, ...component };
    });
  }
  finish(id: string, token: string) {
    return this.update(id, token, 'delivery.completed', (d) => {
      for (const repo of repositories(this.h.config)) {
        const c = d.components[repo.id];
        if (
          repo.forge?.requiredChecks.some(
            (name) =>
              !c?.checks?.some(
                (check) =>
                  check.name === name && check.sha === c.mergedSha && check.status === 'success',
              ),
          )
        )
          throw new DomainError('Отсутствует обязательная удалённая проверка: ' + repo.id);
        if (
          !c ||
          c.state !== 'merged' ||
          !c.mergedSha ||
          c.remoteTree !== c.tree ||
          !c.checks?.length ||
          c.checks.some((check) => check.sha !== c.mergedSha || check.status !== 'success')
        )
          throw new DomainError('Нет доказательств удалённой приёмки: ' + repo.id);
      }
      d.status = 'delivered';
      d.finishedAt = new Date().toISOString();
      return d;
    });
  }
  wait(id: string, token: string, prepared = false) {
    return this.update(id, token, 'delivery.waiting', (d) => {
      d.status = prepared ? 'prepared' : 'waiting';
      return d;
    });
  }
  fail(id: string, token: string, error: string) {
    this.h.store.change('delivery.failed', (s) => {
      const d = s.changeSets.find((c) => c.id === id)?.deliveries?.find((d) => d.token === token);
      if (d?.status === 'active') {
        d.status = 'failed';
        d.error = error;
        d.finishedAt = new Date().toISOString();
      }
      return { changeSetId: id, error };
    });
  }
}
