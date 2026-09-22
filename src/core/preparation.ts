import { createHash, randomUUID } from 'node:crypto';
import { DomainError, type DevContourState, type Task } from './model.ts';
import type { Store } from './store.ts';
import {
  preparationInputs,
  preparationDecision,
  preparationAnswer,
  preparationState,
  type PreparationBinding,
  type PreparationOperation,
  type ProductChange,
  type ArchitectureBrief,
  type DesignBrief,
  type ProductBrief,
  type C4Diagram,
} from './preparation-model.ts';
const hash = (value: unknown) =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item: unknown) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item,
      ),
    )
    .digest('hex');
const now = () => new Date().toISOString();
// Titles are usually Russian; a readable key needs transliteration rather than
// dropping every non-latin character.
const latin: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};
export function slugify(title: string, fallback = 'change') {
  const text = [...title.toLowerCase()]
    .map((c) => latin[c] ?? c)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 49)
    .replace(/-+$/g, '');
  return /^[a-z0-9]/.test(text) ? text : fallback;
}
const changeKeyOf = (number: number, slug: string) =>
  'r-' + String(number).padStart(3, '0') + '.' + slug;
// States saved before the journal existed carry no arrays; normalise on access so
// every caller can append without re-checking.
function journal(c: ProductChange) {
  c.activity ??= [];
  c.questions ??= [];
  c.decisions ??= [];
  return c;
}
function change(s: DevContourState, id?: string) {
  const c = s.preparation?.changes.find((c) => c.id === (id ?? s.preparation?.activeChangeId));
  if (!c) throw new DomainError('Выберите изменение продукта', 409);
  return journal(c);
}
function productReady(c: ProductChange) {
  if (c.product.at(-1)?.status !== 'approved')
    throw new DomainError('Сначала пользователь должен утвердить продуктовую постановку', 409);
  return c.product.at(-1)!;
}
function architectureReady(c: ProductChange) {
  const product = productReady(c),
    architecture = c.architecture.at(-1);
  if (
    !architecture ||
    architecture.status !== 'approved' ||
    architecture.productDigest !== product.digest
  )
    throw new DomainError(
      'Сначала пользователь должен утвердить актуальные архитектуру и стек',
      409,
    );
  return architecture;
}
export function developmentBinding(
  s: DevContourState,
  id?: string,
): PreparationBinding | undefined {
  if (!s.preparation) return;
  const c = change(s, id),
    product = productReady(c),
    architecture = architectureReady(c),
    design = c.design.at(-1);
  if (!design || design.status !== 'approved' || design.architectureDigest !== architecture.digest)
    throw new DomainError(
      'Сначала пользователь должен утвердить актуальное направление дизайна',
      409,
    );
  return {
    changeId: c.id,
    productDigest: product.digest,
    architectureDigest: architecture.digest,
    designDigest: design.digest,
  };
}
export function assertTaskPreparation(
  s: DevContourState,
  task: Pick<Task, 'preparation' | 'featureId'>,
) {
  if (!s.preparation) return;
  if (
    !task.preparation ||
    hash(task.preparation) !== hash(developmentBinding(s, task.preparation.changeId))
  )
    throw new DomainError(
      'Задача не связана с текущими утверждёнными продуктом и архитектурой',
      409,
    );
  if (
    task.featureId &&
    !productReady(change(s, task.preparation.changeId)).content.features.some(
      (f) => f.id === task.featureId,
    )
  )
    throw new DomainError(
      'Задача ссылается на фичу вне утверждённой постановки: ' + task.featureId,
      409,
    );
}
function editable(s: DevContourState, id?: string) {
  if (
    s.runs.some(
      (r) =>
        r.status === 'active' &&
        (!id || s.tasks.find((t) => t.id === r.taskId)?.preparation?.changeId === id),
    ) ||
    s.changeSets.some(
      (c) =>
        c.verifications.some((v) => v.status === 'active') ||
        c.deliveries?.some((d) => d.status === 'active'),
    )
  )
    throw new DomainError('Сначала остановите выдачу задач и дождитесь активных проверок', 409);
}
function validateDiagram(d: C4Diagram, level: 1 | 2) {
  const ids = d.nodes.map((n) => n.id);
  if (new Set(ids).size !== ids.length) throw new DomainError('Повтор ID на C' + level);
  if (d.relationships.some((r) => !ids.includes(r.from) || !ids.includes(r.to) || r.from === r.to))
    throw new DomainError('Некорректная связь на C' + level);
  if (d.nodes.some((n) => !d.relationships.some((r) => r.from === n.id || r.to === n.id)))
    throw new DomainError('У каждого элемента C' + level + ' должна быть связь');
  if (
    level === 1 &&
    (d.nodes.filter((n) => n.kind === 'system' && n.id === d.systemId).length !== 1 ||
      d.nodes.some((n) => n.kind === 'container' || (n.kind === 'system' && n.id !== d.systemId)))
  )
    throw new DomainError('C1: одна целевая система, пользователи и внешние системы');
  if (
    level === 2 &&
    (!d.nodes.some((n) => n.kind === 'container') ||
      d.nodes.some(
        (n) =>
          n.kind === 'system' || n.id === d.systemId || (n.kind === 'container' && !n.technology),
      ))
  )
    throw new DomainError('C2: приложения и хранилища внутри системы, с указанными технологиями');
}
function validateJournal(c: ProductChange) {
  const questions = c.questions ?? [],
    decisions = c.decisions ?? [],
    ids = questions.map((q) => q.id);
  if (new Set(ids).size !== ids.length) throw new DomainError('Повтор ID вопроса: ' + c.id);
  if (questions.some((q) => Boolean(q.answer) !== (q.status === 'answered')))
    throw new DomainError('Ответ должен соответствовать статусу вопроса');
  const recorded = decisions.map((d) => d.id);
  if (new Set(recorded).size !== recorded.length)
    throw new DomainError('Повтор ID решения: ' + c.id);
  if (decisions.some((d) => d.questionId && !ids.includes(d.questionId)))
    throw new DomainError('Решение ссылается на несуществующий вопрос');
}
// SemVer ordering: releases are delivered in the order they are listed, so a
// later entry must carry a higher version. A prerelease sorts below its release.
function rank(version: string) {
  const [core, pre] = version.split('-');
  const [major, minor, patch] = core.split('.').map(Number);
  return { major, minor, patch, pre: pre ?? '' };
}
function ordered(previous: string, next: string) {
  const a = rank(previous),
    b = rank(next);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (b[key] > a[key]) return true;
    if (b[key] < a[key]) return false;
  }
  return Boolean(a.pre) && !b.pre;
}
function validateProduct(p: ProductBrief) {
  if (
    p.problem.length < 10 ||
    p.outcome.length < 10 ||
    !p.features.length ||
    p.features.some((f) => !f.scenarios.length || !f.acceptance.length) ||
    p.questions.length
  )
    throw new DomainError(
      'Для согласования нужны проблема, результат и хотя бы одна фича со сценариями и критериями; открытые вопросы нужно решить',
    );
  const ids = p.features.map((f) => f.id);
  if (new Set(ids).size !== ids.length) throw new DomainError('Повтор ID фичи в постановке');
  const releaseIds = p.releases.map((r) => r.id);
  if (new Set(releaseIds).size !== releaseIds.length)
    throw new DomainError('Повтор ID релиза в постановке');
  const versions = p.releases.map((r) => r.version);
  if (new Set(versions).size !== versions.length)
    throw new DomainError('Повтор версии релиза в постановке');
  for (const [index, release] of p.releases.entries())
    if (index && !ordered(p.releases[index - 1].version, release.version))
      throw new DomainError(
        'Версии релизов должны возрастать по SemVer: ' +
          p.releases[index - 1].version +
          ' затем ' +
          release.version,
      );
  for (const criterion of p.features.flatMap((f) => f.acceptance))
    if (!releaseIds.includes(criterion.releaseId))
      throw new DomainError('Критерий ссылается на несуществующий релиз: ' + criterion.releaseId);
  const used = new Set(p.features.flatMap((f) => f.acceptance.map((a) => a.releaseId)));
  const empty = p.releases.find((r) => !used.has(r.id));
  if (empty) throw new DomainError('У релиза нет ни одного критерия приёмки: ' + empty.id);
  const personaIds = p.personas.map((x) => x.id);
  if (new Set(personaIds).size !== personaIds.length)
    throw new DomainError('Повтор ID персоны в постановке');
  if (p.personas.some((x) => !x.goals.length || !x.pains.length))
    throw new DomainError('У описанной персоны должны быть цели и боли');
  for (const scenario of p.features.flatMap((f) => f.scenarios))
    if (scenario.personaId && !personaIds.includes(scenario.personaId))
      throw new DomainError('Сценарий ссылается на несуществующую персону: ' + scenario.personaId);
  const channelIds = p.channels.map((c) => c.id);
  if (new Set(channelIds).size !== channelIds.length)
    throw new DomainError('Повтор ID канала в постановке');
  for (const feature of p.features)
    for (const channel of feature.channels)
      if (!channelIds.includes(channel))
        throw new DomainError('Фича ссылается на несуществующий канал: ' + channel);
  const reached = new Set(p.features.flatMap((f) => f.channels));
  const idle = p.channels.find((c) => !reached.has(c.id));
  if (idle) throw new DomainError('Канал не реализует ни одной фичи: ' + idle.id);
}
function validateArchitecture(a: ArchitectureBrief) {
  if (
    a.summary.length < 10 ||
    !a.stack.length ||
    !a.decisions.length ||
    a.testStrategy.length < 10 ||
    a.questions.length ||
    !a.c1 ||
    !a.c2
  )
    throw new DomainError(
      'Для согласования нужны архитектура, обоснованный стек, решения, стратегия тестов, C1 и C2; открытые вопросы нужно решить',
    );
  validateDiagram(a.c1, 1);
  validateDiagram(a.c2, 2);
  if (a.c1.systemId !== a.c2.systemId)
    throw new DomainError('C1 и C2 должны описывать одну систему');
  for (const n of a.c2.nodes.filter((n) => n.kind !== 'container')) {
    const other = a.c1.nodes.find((other) => other.id === n.id);
    if (!other || other.kind !== n.kind || other.name !== n.name)
      throw new DomainError('Пользователи и внешние системы C2 должны соответствовать C1');
  }
  const containers = new Set(a.c2.nodes.filter((n) => n.kind === 'container').map((n) => n.id));
  const drawn = new Set<string>();
  for (const c3 of a.c3) {
    if (!containers.has(c3.containerId))
      throw new DomainError('C3 описывает контейнер вне C2: ' + c3.containerId);
    if (drawn.has(c3.containerId))
      throw new DomainError('Для контейнера уже есть C3: ' + c3.containerId);
    drawn.add(c3.containerId);
    const ids = c3.nodes.map((n) => n.id);
    if (new Set(ids).size !== ids.length) throw new DomainError('Повтор ID на C3');
    if (
      c3.relationships.some((r) => !ids.includes(r.from) || !ids.includes(r.to) || r.from === r.to)
    )
      throw new DomainError('Некорректная связь на C3');
    if (c3.nodes.some((n) => !c3.relationships.some((r) => r.from === n.id || r.to === n.id)))
      throw new DomainError('У каждого элемента C3 должна быть связь');
    if (!c3.nodes.some((n) => n.kind === 'component'))
      throw new DomainError('C3 должен содержать компоненты контейнера: ' + c3.containerId);
    if (c3.nodes.some((n) => n.kind === 'component' && !n.technology))
      throw new DomainError('У компонента C3 должна быть указана технология');
    // Everything that is not a component of this container must already exist
    // on C2, so the levels cannot drift apart.
    for (const n of c3.nodes.filter((n) => n.kind !== 'component')) {
      const other = a.c2.nodes.find((other) => other.id === n.id);
      if (!other || other.kind !== n.kind || other.name !== n.name)
        throw new DomainError('Соседи на C3 должны совпадать с C2: ' + n.id);
    }
  }
}
// Direction is what blocks development, so it is validated like the other two
// stages. A change that touches no interface may declare itself inapplicable —
// with a reason the operator approves, not a silent skip.
function validateDesign(d: DesignBrief, channels: string[]) {
  if (!d.applicable) {
    if (d.reason.length < 10)
      throw new DomainError('Объясните, почему изменению не нужно направление дизайна');
    return;
  }
  if (d.concept.length < 10 || !d.guidelines.length || !d.tokens.length || !d.channels.length)
    throw new DomainError(
      'Для согласования нужны концепция, семантические токены, guidelines и разбор по каналам; либо отметьте, что дизайн не требуется',
    );
  if (d.questions.length) throw new DomainError('Открытые вопросы дизайна нужно решить');
  for (const item of d.channels)
    if (!channels.includes(item.channelId))
      throw new DomainError('Дизайн ссылается на несуществующий канал: ' + item.channelId);
  const covered = d.channels.map((item) => item.channelId);
  if (new Set(covered).size !== covered.length)
    throw new DomainError('Повтор канала в разборе дизайна');
  const names = d.tokens.map((token) => token.group + '/' + token.name);
  if (new Set(names).size !== names.length) throw new DomainError('Повтор имени токена');
  if (d.references.some((r) => !/^https?:\/\//.test(r.url)))
    throw new DomainError('Референс должен быть ссылкой http(s)');
}
export function validatePreparation(s: DevContourState, previous?: DevContourState) {
  if (!s.preparation) {
    if (previous?.preparation)
      throw new DomainError('Нельзя удалить обязательные продуктовые согласования');
    return;
  }
  const p = preparationState.parse(s.preparation);
  const keys = p.changes.map((c) => c.key);
  if (
    new Set(p.changes.map((c) => c.id)).size !== p.changes.length ||
    new Set(keys).size !== keys.length ||
    (p.activeChangeId && !p.changes.some((c) => c.id === p.activeChangeId))
  )
    throw new DomainError('Некорректный реестр продуктовых изменений');
  for (const c of p.changes) {
    validateJournal(c);
    for (const stage of ['product', 'architecture', 'design'] as const)
      for (const [index, r] of c[stage].entries()) {
        const expected = hash({
          changeId: c.id,
          stage,
          number: r.number,
          content: r.content,
          ...('productDigest' in r ? { productDigest: r.productDigest } : {}),
          ...('architectureDigest' in r ? { architectureDigest: r.architectureDigest } : {}),
        });
        if (
          r.number !== index + 1 ||
          r.digest !== expected ||
          ['approved', 'changes-requested'].includes(r.status) !== Boolean(r.decision)
        )
          throw new DomainError('Некорректная версия или решение: ' + c.id);
        if (r.status === 'approved' || r.status === 'in-review') {
          if (stage === 'product') validateProduct(r.content as ProductBrief);
          else if (stage === 'architecture') validateArchitecture(r.content as ArchitectureBrief);
          else {
            const source = c.product.find((v) => v.status === 'approved');
            validateDesign(
              r.content as DesignBrief,
              source ? (source.content as ProductBrief).channels.map((x) => x.id) : [],
            );
          }
        }
        if (
          'productDigest' in r &&
          !c.product.some((v) => v.digest === r.productDigest && v.status === 'approved')
        )
          throw new DomainError('Архитектура должна ссылаться на утверждённую постановку');
        if (
          'architectureDigest' in r &&
          !c.architecture.some((v) => v.digest === r.architectureDigest && v.status === 'approved')
        )
          throw new DomainError('Дизайн должен ссылаться на утверждённую архитектуру');
      }
  }
  for (const old of previous?.preparation?.changes ?? []) {
    const next = p.changes.find((c) => c.id === old.id);
    if (
      !next ||
      next.title !== old.title ||
      next.createdAt !== old.createdAt ||
      next.key !== old.key
    )
      throw new DomainError('Нельзя удалить историю продуктового изменения');
    for (const before of old.decisions ?? []) {
      const after = (next.decisions ?? []).find((d) => d.id === before.id);
      if (!after || hash(after) !== hash(before))
        throw new DomainError('Журнал принятых решений неизменяем');
    }
    for (const before of old.questions ?? []) {
      const after = (next.questions ?? []).find((q) => q.id === before.id);
      if (
        !after ||
        after.text !== before.text ||
        after.createdAt !== before.createdAt ||
        (before.answer && hash(before.answer) !== hash(after.answer))
      )
        throw new DomainError('История вопросов и ответов неизменяема');
    }
    for (const stage of ['product', 'architecture', 'design'] as const)
      for (const before of old[stage]) {
        const after = next[stage].find((r) => r.number === before.number);
        if (
          !after ||
          before.digest !== after.digest ||
          before.createdAt !== after.createdAt ||
          before.reason !== after.reason ||
          (before.decision && hash(before) !== hash(after))
        )
          throw new DomainError('История согласований неизменяема');
      }
  }
}
export class Preparation {
  constructor(readonly store: Store) {}
  enable() {
    this.store.change('preparation.enabled', (s) => {
      if (s.preparation) return;
      editable(s);
      s.paused = true;
      s.preparation = { id: 'workspace-preparation', changes: [] };
    });
  }
  // The agent writes the content and can re-read it from docs/changes; sending
  // it back on every call pushed realistic briefs past the response budget.
  status(id?: string, options: { content?: boolean } = {}) {
    const withContent = options.content ?? true;
    const s = this.store.read(),
      p = s.preparation;
    if (!p) return { enabled: false as const };
    const c = p.changes.find((c) => c.id === (id ?? p.activeChangeId));
    if (id && !c) throw new DomainError('Изменение не найдено', 404);
    const strip = <T extends { content: unknown }>(r: T | undefined) =>
      r && (withContent ? r : { ...r, content: undefined });
    const product = c?.product.at(-1),
      architecture = c?.architecture.at(-1),
      design = c?.design.at(-1);
    let ready = false,
      blocker = 'Создайте изменение и поручите агенту проработать продуктовую часть';
    if (c)
      try {
        developmentBinding(s, c.id);
        ready = true;
        blocker = '';
      } catch (error) {
        blocker = (error as Error).message;
      }
    const tasks = s.tasks.filter((t) => Boolean(c) && t.preparation?.changeId === c?.id);
    // The newest note of any change tells the operator the session is alive even
    // before the first revision exists.
    const latest = p.changes
      .flatMap((item) => (item.activity ?? []).map((a) => ({ ...a, changeId: item.id })))
      .sort((a, b) => a.at.localeCompare(b.at))
      .at(-1);
    return {
      enabled: true as const,
      activeChangeId: p.activeChangeId,
      changes: p.changes.map((item) => ({
        id: item.id,
        key: item.key,
        title: item.title,
        createdAt: item.createdAt,
        open: (item.questions ?? []).filter((q) => q.status === 'open').length,
      })),
      agentActivity: latest,
      current: c
        ? {
            id: c.id,
            key: c.key,
            title: c.title,
            product: strip(product),
            architecture: strip(architecture),
            design: strip(design),
            source: 'docs/changes/' + c.key,
            activity: [...(c.activity ?? [])].reverse().slice(0, 40),
            questions: c.questions ?? [],
            decisions: [...(c.decisions ?? [])].reverse(),
            // A release aggregates the features that carry at least one of its
            // criteria; a feature spanning two releases counts in both.
            releases: product
              ? product.content.releases.map((r) => {
                  const own = product.content.features.filter((f) =>
                    f.acceptance.some((a) => a.releaseId === r.id),
                  );
                  const ids = own.map((f) => f.id);
                  const bound = tasks.filter((t) => t.featureId && ids.includes(t.featureId));
                  const done = bound.filter((t) => t.status === 'done').length;
                  return {
                    id: r.id,
                    features: own.length,
                    criteria: own.reduce(
                      (sum, f) => sum + f.acceptance.filter((a) => a.releaseId === r.id).length,
                      0,
                    ),
                    tasks: bound.length,
                    done,
                    failed: bound.filter((t) => t.status === 'failed').length,
                    readiness: !bound.length
                      ? ('unplanned' as const)
                      : done === bound.length
                        ? ('done' as const)
                        : bound.some((t) => t.status === 'failed')
                          ? ('failed' as const)
                          : ('in-progress' as const),
                  };
                })
              : [],
            // Readiness only: the feature text already travels in product.content,
            // and duplicating it pushed the agent response past its size budget.
            features: product
              ? product.content.features.map((f) => {
                  const own = tasks.filter((t) => t.featureId === f.id);
                  const done = own.filter((t) => t.status === 'done').length;
                  return {
                    id: f.id,
                    tasks: own.length,
                    done,
                    failed: own.filter((t) => t.status === 'failed').length,
                    readiness: !own.length
                      ? ('unplanned' as const)
                      : done === own.length
                        ? ('done' as const)
                        : own.some((t) => t.status === 'failed')
                          ? ('failed' as const)
                          : ('in-progress' as const),
                  };
                })
              : [],
            history: (['product', 'architecture', 'design'] as const).flatMap((stage) =>
              c[stage].map(({ number, status, createdAt, reason, decision, digest }) => ({
                stage,
                number,
                status,
                createdAt,
                reason,
                decision,
                digest,
              })),
            ),
          }
        : undefined,
      phase: ready
        ? 'development'
        : product?.status !== 'approved'
          ? 'product'
          : architecture?.status !== 'approved' || architecture.productDigest !== product.digest
            ? 'architecture'
            : 'design',
      developmentReady: ready,
      blocker,
      delivery: {
        total: tasks.length,
        done: tasks.filter((t) => t.status === 'done').length,
        failed: tasks.filter((t) => t.status === 'failed').length,
        boards: s.boards
          .filter((b) =>
            b.revisions.some((r) => r.taskIds.some((id) => tasks.some((t) => t.id === id))),
          )
          .map(({ id, title }) => ({ id, title })),
      },
    };
  }
  execute(operation: PreparationOperation, input: unknown) {
    if (operation === 'preparation_status')
      return this.status(preparationInputs[operation].parse(input).changeId, { content: false });
    preparationInputs[operation].parse(input);
    return this.store.atomic(() => {
      this.enable();
      let selected: string | undefined;
      this.store.change(operation, (s) => {
        const before = structuredClone(s),
          p = s.preparation!;
        if (operation === 'preparation_create') {
          const v = preparationInputs[operation].parse(input);
          selected = 'PC-' + randomUUID();
          p.changes.push({
            id: selected,
            key: changeKeyOf(p.changes.length + 1, v.slug ?? slugify(v.title)),
            title: v.title,
            createdAt: now(),
            product: [],
            architecture: [],
            design: [],
            activity: [],
            questions: [],
            decisions: [],
          });
          p.activeChangeId = selected;
        } else {
          const v = preparationInputs[operation].parse(input),
            c = change(s, v.changeId);
          selected = c.id;
          // The journal only appends context; it never rewrites an approved revision,
          // so it stays available while the queue is running.
          if (
            !(
              ['preparation_progress', 'preparation_question', 'preparation_resolve'] as string[]
            ).includes(operation)
          )
            editable(s, c.id);
          if (operation === 'preparation_activate') p.activeChangeId = c.id;
          else if (operation === 'preparation_product') {
            const v = preparationInputs[operation].parse(input);
            if ((c.product.at(-1)?.digest ?? null) !== v.expectedDigest)
              throw new DomainError('Продуктовая постановка изменилась; перечитайте её', 409);
            const number = c.product.length + 1;
            c.product.push({
              number,
              status: 'draft',
              createdAt: now(),
              reason: v.reason,
              content: v.content,
              digest: hash({ changeId: c.id, stage: 'product', number, content: v.content }),
            });
          } else if (operation === 'preparation_architecture') {
            const v = preparationInputs[operation].parse(input),
              product = productReady(c);
            if ((c.architecture.at(-1)?.digest ?? null) !== v.expectedDigest)
              throw new DomainError('Архитектура изменилась; перечитайте её', 409);
            const number = c.architecture.length + 1;
            c.architecture.push({
              number,
              status: 'draft',
              createdAt: now(),
              reason: v.reason,
              productDigest: product.digest,
              content: v.content,
              digest: hash({
                changeId: c.id,
                stage: 'architecture',
                number,
                content: v.content,
                productDigest: product.digest,
              }),
            });
          } else if (operation === 'preparation_design') {
            const v = preparationInputs[operation].parse(input),
              architecture = architectureReady(c);
            if ((c.design.at(-1)?.digest ?? null) !== v.expectedDigest)
              throw new DomainError('Направление дизайна изменилось; перечитайте его', 409);
            const number = c.design.length + 1;
            c.design.push({
              number,
              status: 'draft',
              createdAt: now(),
              reason: v.reason,
              architectureDigest: architecture.digest,
              content: v.content,
              digest: hash({
                changeId: c.id,
                stage: 'design',
                number,
                content: v.content,
                architectureDigest: architecture.digest,
              }),
            });
          } else if (operation === 'preparation_progress') {
            const v = preparationInputs[operation].parse(input);
            c.activity.push({ at: now(), stage: v.stage, note: v.note });
            if (c.activity.length > 200) c.activity.splice(0, c.activity.length - 200);
          } else if (operation === 'preparation_question') {
            const v = preparationInputs[operation].parse(input);
            if (!v.add.length && !v.withdraw.length)
              throw new DomainError('Укажите вопросы для добавления или снятия');
            for (const q of v.withdraw) {
              const existing = c.questions.find((item) => item.id === q);
              if (!existing) throw new DomainError('Вопрос не найден: ' + q, 404);
              if (existing.status === 'answered')
                throw new DomainError('Отвеченный вопрос нельзя снять: ' + q, 409);
              existing.status = 'withdrawn';
            }
            for (const q of v.add)
              c.questions.push({
                id: 'Q-' + randomUUID(),
                stage: v.stage,
                createdAt: now(),
                status: 'open',
                text: q.text,
                why: q.why,
                options: q.options,
              });
          } else if (operation === 'preparation_resolve') {
            const v = preparationInputs[operation].parse(input);
            if (v.questionId) {
              const q = c.questions.find((item) => item.id === v.questionId);
              if (!q) throw new DomainError('Вопрос не найден: ' + v.questionId, 404);
              if (q.status === 'open')
                throw new DomainError('Сначала дождитесь ответа пользователя на вопрос', 409);
            }
            c.decisions.push({
              id: 'D-' + randomUUID(),
              stage: v.stage,
              createdAt: now(),
              statement: v.statement,
              rationale: v.rationale,
              ...(v.questionId ? { questionId: v.questionId } : {}),
            });
          } else if (operation === 'preparation_submit') {
            const v = preparationInputs[operation].parse(input),
              r = c[v.stage].at(-1);
            if (!r || r.digest !== v.expectedDigest || r.status !== 'draft')
              throw new DomainError('На согласование можно отправить только текущий черновик', 409);
            const open = c.questions.filter((q) => q.status === 'open' && q.stage === v.stage);
            if (open.length)
              throw new DomainError(
                'Сначала получите ответы на открытые вопросы этапа: ' + open.length,
                409,
              );
            if (
              v.stage === 'architecture' &&
              c.architecture.at(-1)!.productDigest !== productReady(c).digest
            )
              throw new DomainError('Архитектура относится к прежней постановке');
            if (
              v.stage === 'design' &&
              c.design.at(-1)!.architectureDigest !== architectureReady(c).digest
            )
              throw new DomainError('Дизайн относится к прежней архитектуре');
            r.status = 'in-review';
          }
        }
        validatePreparation(s, before);
        return { changeId: selected };
      });
      return this.status(selected, { content: false });
    });
  }
  // The answer comes from the panel form, like a stage decision: the agent asks,
  // the operator replies, and the agent turns the reply into a recorded decision.
  answer(raw: unknown) {
    const v = preparationAnswer.parse(raw);
    this.store.change('preparation.operator-answer', (s) => {
      const before = structuredClone(s),
        c = change(s, v.changeId),
        q = c.questions.find((item) => item.id === v.questionId);
      if (!q) throw new DomainError('Вопрос не найден', 404);
      if (q.status !== 'open') throw new DomainError('Вопрос уже закрыт', 409);
      q.status = 'answered';
      q.answer = { at: now(), text: v.text };
      validatePreparation(s, before);
      return { changeId: c.id, questionId: q.id };
    });
    return this.status(v.changeId);
  }
  decide(raw: unknown) {
    const v = preparationDecision.parse(raw);
    this.store.change('preparation.operator-decision', (s) => {
      const before = structuredClone(s),
        c = change(s, v.changeId),
        r = c[v.stage].at(-1);
      editable(s, c.id);
      if (!r || r.digest !== v.expectedDigest || r.status !== 'in-review')
        throw new DomainError('Версия изменилась или не ожидает согласования', 409);
      if (
        v.stage === 'architecture' &&
        c.architecture.at(-1)!.productDigest !== productReady(c).digest
      )
        throw new DomainError('Архитектура относится к прежней постановке');
      if (
        v.stage === 'design' &&
        c.design.at(-1)!.architectureDigest !== architectureReady(c).digest
      )
        throw new DomainError('Дизайн относится к прежней архитектуре');
      if (v.decision === 'request-changes' && v.comment.length < 3)
        throw new DomainError('Опишите необходимые изменения');
      r.status = v.decision === 'approve' ? 'approved' : 'changes-requested';
      r.decision = { actor: 'operator', at: now(), comment: v.comment };
      validatePreparation(s, before);
      return { changeId: c.id, stage: v.stage, digest: r.digest, decision: v.decision };
    });
    return this.status(v.changeId);
  }
}
