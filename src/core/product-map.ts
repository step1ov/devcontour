import { z } from 'zod';
import { DomainError, relativePath } from './model.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,50}$/);
const text = z.string().trim().min(3).max(2000);
const title = z
  .string()
  .trim()
  .min(3)
  .max(180)
  .regex(/^[^\r\n]+$/);
export const storyReference = z.strictObject({
  repositoryId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  storyId: id,
});
const channelScope = z.discriminatedUnion('scope', [
  z.strictObject({
    channelId: id,
    scope: z.literal('included'),
    stories: z.array(storyReference).min(1).max(100),
  }),
  z.strictObject({ channelId: id, scope: z.literal('deferred'), reason: text }),
  z.strictObject({ channelId: id, scope: z.literal('not-applicable'), reason: text }),
]);
export const featureScope = z.strictObject({
  featureId: id,
  channels: z.array(channelScope).min(1).max(30),
  checks: z.array(z.strictObject({ gate: id, scenario: text })).max(30),
});
export const productMap = z.strictObject({
  channels: z
    .array(
      z.strictObject({
        id,
        title,
        purpose: text,
        audience: z.array(text).min(1).max(20),
        componentIds: z.array(id).min(1).max(100),
      }),
    )
    .min(1)
    .max(30),
  components: z
    .array(
      z.strictObject({
        id,
        title,
        kind: z.string().trim().min(2).max(50),
        repositoryId: storyReference.shape.repositoryId,
        path: z.union([z.literal('.'), relativePath]),
        dependsOn: z.array(id).max(100),
      }),
    )
    .min(1)
    .max(100),
  features: z
    .array(z.strictObject({ id, title, outcome: text }))
    .min(1)
    .max(100),
});
export type ProductMap = z.infer<typeof productMap>;
export type FeatureScope = z.infer<typeof featureScope>;
export const storyKey = (ref: z.infer<typeof storyReference>) =>
  JSON.stringify([ref.repositoryId, ref.storyId]);

export function channelRepositories(product: ProductMap, channelId: string) {
  const visited = new Set<string>(),
    repositories = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const component = product.components.find((c) => c.id === id);
    if (!component) throw new DomainError('Неизвестный технический компонент: ' + id);
    repositories.add(component.repositoryId);
    component.dependsOn.forEach(visit);
  };
  product.channels.find((a) => a.id === channelId)?.componentIds.forEach(visit);
  return repositories;
}

export function validateProductMap(
  product: ProductMap | undefined,
  releases: {
    id: string;
    components: { repositoryId: string; releaseId: string }[];
    features?: FeatureScope[];
  }[],
) {
  const unique = (values: string[], label: string) => {
    if (new Set(values).size !== values.length) throw new DomainError('Повтор ' + label);
  };
  if (!product) {
    if (releases.some((r) => r.features !== undefined))
      throw new DomainError('Фичам релиза нужна карта product');
    return;
  }
  unique(
    product.channels.map((a) => a.id),
    'channel ID',
  );
  unique(
    product.components.map((c) => c.id),
    'technical component ID',
  );
  unique(
    product.features.map((f) => f.id),
    'feature ID',
  );
  const active = new Set<string>(),
    visited = new Set<string>();
  const visit = (id: string) => {
    if (active.has(id)) throw new DomainError('Цикл технических компонентов');
    if (visited.has(id)) return;
    const c = product.components.find((c) => c.id === id);
    if (!c) throw new DomainError('Неизвестный технический компонент: ' + id);
    unique(c.dependsOn, 'component dependency');
    active.add(id);
    c.dependsOn.forEach(visit);
    active.delete(id);
    visited.add(id);
  };
  product.components.forEach((c) => visit(c.id));
  for (const app of product.channels) {
    unique(app.componentIds, 'channel component');
    app.componentIds.forEach(visit);
  }
  for (const release of releases) {
    const scopes = release.features;
    if (!scopes || scopes.length !== product.features.length)
      throw new DomainError('Релиз должен явно определить scope каждой фичи');
    unique(
      scopes.map((f) => f.featureId),
      'release feature',
    );
    for (const scope of scopes) {
      if (!product.features.some((f) => f.id === scope.featureId))
        throw new DomainError('Неизвестная фича');
      unique(
        scope.channels.map((a) => a.channelId),
        'feature channel',
      );
      if (scope.channels.length !== product.channels.length)
        throw new DomainError('Фича должна явно определить scope каждого приложения');
      const included = scope.channels.filter((a) => a.scope === 'included');
      if (Boolean(included.length) !== Boolean(scope.checks.length))
        throw new DomainError('Сквозные проверки обязательны только для включённой фичи');
      unique(
        scope.checks.map((c) => c.gate),
        'feature gate',
      );
      for (const app of scope.channels) {
        if (!product.channels.some((a) => a.id === app.channelId))
          throw new DomainError('Неизвестное приложение');
        if (app.scope !== 'included') continue;
        unique(app.stories.map(storyKey), 'feature story');
        const repos = channelRepositories(product, app.channelId);
        for (const ref of app.stories)
          if (
            !repos.has(ref.repositoryId) ||
            !release.components.some((c) => c.repositoryId === ref.repositoryId)
          )
            throw new DomainError('История должна принадлежать компоненту приложения и релизу');
      }
    }
    if (!scopes.some((f) => f.channels.some((a) => a.scope === 'included')))
      throw new DomainError('Продуктовый релиз должен включать хотя бы одну фичу');
  }
}

/** Captured by the runner, never supplied as a user assertion of completion. */
export interface ProductReleaseProof {
  releaseId: string;
  intentDigest: string;
  gateIds: string[];
  acceptedHeads: Record<string, string>;
  sources: { repositoryId: string; files: string[]; digest: string }[];
  stateDigest: string;
}

export type FeatureStatus =
  | 'unplanned'
  | 'in-progress'
  | 'awaiting-verification'
  | 'verified'
  | 'accepted'
  | 'deferred'
  | 'not-applicable';
export interface FeatureProgress {
  id: string;
  title: string;
  outcome: string;
  status: FeatureStatus;
  channels: (FeatureScope['channels'][number] & { covered?: boolean; planned?: boolean })[];
  checks: (FeatureScope['checks'][number] & { passed: boolean })[];
}
export type ProductView =
  | { available: false; reason: string }
  | {
      available: true;
      title: string;
      purpose: string;
      channels: ProductMap['channels'];
      components: ProductMap['components'];
      releases: { id: string; title: string }[];
      releaseId: string;
      intentDigest: string;
      coverageComplete: boolean;
      releaseAccepted: boolean;
      verification?: { changeSetId: string; verificationId: string };
      issues: string[];
      features: FeatureProgress[];
    };
