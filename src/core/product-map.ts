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
  /**
   * Сценарии приёмки релиза. Сценарий подтверждает testcase принятой задачи
   * одной из историй этой фичи, чья связь requirements повторяет текст
   * сценария и называет свой testId; `deferred` — записанная причина, по которой сценарий в этот релиз
   * не входит. Отложить сценарий решает пользователь: ведущий предлагает и
   * спрашивает. Зелёный общий gate сам по себе сценарий не подтверждает.
   * Один gate проверяет несколько сценариев; текст сценария в фиче
   * уникален, потому что доказательство сопоставляется по тексту, а не по
   * gate.
   */
  checks: z.array(z.strictObject({ gate: id, scenario: text, deferred: text.optional() })).max(30),
});
/** Сценарий сравнивается по тексту без различий в пробелах. */
export const scenarioKey = (scenario: string) => scenario.trim().replace(/\s+/g, ' ');
export type ScenarioStatus = 'evidenced' | 'deferred' | 'missing';
export interface ReleaseScenario {
  featureId: string;
  gate: string;
  scenario: string;
  status: ScenarioStatus;
  deferred?: string;
  evidence: { repositoryId: string; taskId: string; testId: string }[];
}
/** Сценарий, отложенный записанным решением пользователя, с причиной. */
export interface DeferredScenario {
  featureId: string;
  gate: string;
  scenario: string;
  reason: string;
}
/**
 * Сценарий релиза так, как его объявляет INTENT: фича, gate, текст и
 * записанная причина отложить. Снимок закрепляется в доказательстве
 * проверки релиза и служит образцом объёма для следующей приёмки.
 */
export interface ReleaseCheck {
  featureId: string;
  gate: string;
  scenario: string;
  deferred?: string;
}
/** Сценарии релиза из карты в порядке фич и проверок. */
export const releaseChecks = (features: FeatureScope[] | undefined): ReleaseCheck[] =>
  (features ?? []).flatMap((f) =>
    f.checks.map((c) => ({
      featureId: f.featureId,
      gate: c.gate,
      scenario: c.scenario,
      ...(c.deferred ? { deferred: c.deferred } : {}),
    })),
  );
/**
 * Сценарий последней приёмки релиза, которого в текущей карте нет:
 * `changed` — у той же фичи появился другой сценарий (переформулировка),
 * `removed` — замены нет. Такое изменение сужает объём релиза так же, как
 * `deferred`, поэтому приёмку подтверждает пользователь.
 */
export interface UnconfirmedScenario {
  featureId: string;
  gate: string;
  /** Текст сценария в принятой карте. */
  scenario: string;
  change: 'changed' | 'removed';
  /** Новые сценарии той же фичи, которых не было в принятой карте. */
  current?: string[];
}
/** Образец объёма: последняя приёмка релиза. */
export interface ScopeReference {
  changeSetId: string;
  verificationId: string;
  acceptedAt: string;
  /** false: карту той приёмки не найти, сверка объёма невозможна. */
  found: boolean;
}
/**
 * Сценарии образца, которых нет в текущей карте. Сравнение — по фиче и
 * тексту без различий в пробелах; смена gate или причины отложить объём
 * не сужает.
 */
export function scopeChanges(reference: ReleaseCheck[], current: ReleaseCheck[]) {
  const key = (c: ReleaseCheck) => JSON.stringify([c.featureId, scenarioKey(c.scenario)]);
  const before = new Set(reference.map(key)),
    now = new Set(current.map(key));
  return reference
    .filter((r) => !now.has(key(r)))
    .map((r): UnconfirmedScenario => {
      const added = current
        .filter((c) => c.featureId === r.featureId && !before.has(key(c)))
        .map((c) => c.scenario);
      return {
        featureId: r.featureId,
        gate: r.gate,
        scenario: r.scenario,
        ...(added.length
          ? { change: 'changed' as const, current: added }
          : { change: 'removed' as const }),
      };
    });
}
/** Ключ сценария фичи в отчётах и на панели: gate и текст сценария. */
export const checkKey = (check: { gate: string; scenario: string }) =>
  JSON.stringify([check.gate, scenarioKey(check.scenario)]);
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
      // Один gate может проверять несколько сценариев фичи, и каждый
      // доказывается отдельно. Доказательство сопоставляется по тексту
      // сценария (gate связи — gate задачи компонента), поэтому один текст на
      // двух gates фичи был бы доказан одним testcase дважды: такой повтор —
      // ошибка карты.
      unique(
        scope.checks.map((c) => scenarioKey(c.scenario)),
        'feature scenario',
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
  /**
   * Сценарии релиза в проверенной карте. Нет у проверок прежних версий:
   * тогда карту находит история Git workspace по `intentDigest`.
   */
  scenarios?: ReleaseCheck[];
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
  checks: (FeatureScope['checks'][number] & {
    passed: boolean;
    status: ScenarioStatus;
    evidence: ReleaseScenario['evidence'];
  })[];
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
      /** Сценарии, отложенные записанным решением; ведущий не откладывает их сам. */
      deferredScenarios: DeferredScenario[];
      /**
       * Сценарии последней приёмки релиза, изменённые или удалённые в
       * текущей карте: сужение объёма, которое подтверждает пользователь.
       */
      unconfirmedScenarios: UnconfirmedScenario[];
      /** Последняя приёмка релиза — образец объёма; нет, если релиз ещё не принимали. */
      scopeReference?: ScopeReference;
      /** Приёмка записана прежним правилом без доказанных сценариев. */
      acceptanceOverridden?: string;
    };
