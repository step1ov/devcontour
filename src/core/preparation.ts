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
  type ProductBrief,
  type StoredProductBrief,
  type ProductFeature,
  type ProductRelease,
  type ProductPersona,
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
// Briefs saved before releases, or before features, still have to render and
// stay approvable. Both earlier shapes read as a single implicit release.
const implicitRelease = {
  id: 'release',
  title: 'Единственный релиз',
  goal: 'Постановка сохранена до того, как релизы стали отдельной сущностью.',
};
export function releasesOf(content: StoredProductBrief): ProductRelease[] {
  return 'releases' in content ? content.releases : [implicitRelease];
}
export function personasOf(content: StoredProductBrief): ProductPersona[] {
  if ('personas' in content) return content.personas;
  return content.audience.map((role, index) => ({
    id: 'audience-' + (index + 1),
    name: 'Без имени',
    role,
    goals: ['Цели не описаны: постановка сохранена до появления персон'],
    pains: ['Боли не описаны: постановка сохранена до появления персон'],
  }));
}
export function featuresOf(content: StoredProductBrief): ProductFeature[] {
  if ('personas' in content) return content.features;
  const persona = personasOf(content)[0]?.id ?? 'audience-1';
  const steps = (texts: string[]) => texts.map((text) => ({ personaId: persona, text }));
  const criteria = (texts: string[]) =>
    texts.map((text) => ({ releaseId: implicitRelease.id, text }));
  if ('features' in content)
    return content.features.map((f) => ({
      ...f,
      scenarios: steps(f.scenarios),
      acceptance: criteria(f.acceptance),
    }));
  return [
    {
      id: 'brief',
      title: 'Постановка прежнего формата',
      outcome: content.outcome,
      scenarios: steps(content.scenarios),
      acceptance: criteria(content.acceptance),
    },
  ];
}
function productReady(c: ProductChange) {
  if (c.product.at(-1)?.status !== 'approved')
    throw new DomainError('Сначала пользователь должен утвердить продуктовую постановку', 409);
  return c.product.at(-1)!;
}
export function developmentBinding(
  s: DevContourState,
  id?: string,
): PreparationBinding | undefined {
  if (!s.preparation) return;
  const c = change(s, id),
    product = productReady(c),
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
  return { changeId: c.id, productDigest: product.digest, architectureDigest: architecture.digest };
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
    !featuresOf(productReady(change(s, task.preparation.changeId)).content).some(
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
function validateProduct(p: StoredProductBrief) {
  const features = featuresOf(p),
    personas = personasOf(p);
  if (
    p.problem.length < 10 ||
    p.outcome.length < 10 ||
    !personas.length ||
    personas.some((persona) => !persona.goals.length || !persona.pains.length) ||
    !features.length ||
    features.some((f) => !f.scenarios.length || !f.acceptance.length) ||
    p.questions.length
  )
    throw new DomainError(
      'Для согласования нужны проблема, результат, персоны с целями и болями и хотя бы одна фича со сценариями и критериями; открытые вопросы нужно решить',
    );
  const ids = features.map((f) => f.id);
  if (new Set(ids).size !== ids.length) throw new DomainError('Повтор ID фичи в постановке');
  const releases = releasesOf(p),
    releaseIds = releases.map((r) => r.id);
  if (new Set(releaseIds).size !== releaseIds.length)
    throw new DomainError('Повтор ID релиза в постановке');
  const used = new Set(features.flatMap((f) => f.acceptance.map((a) => a.releaseId)));
  for (const criterion of features.flatMap((f) => f.acceptance))
    if (!releaseIds.includes(criterion.releaseId))
      throw new DomainError('Критерий ссылается на несуществующий релиз: ' + criterion.releaseId);
  const empty = releases.find((r) => !used.has(r.id));
  if (empty) throw new DomainError('У релиза нет ни одного критерия приёмки: ' + empty.id);
  const personaIds = personas.map((persona) => persona.id);
  if (new Set(personaIds).size !== personaIds.length)
    throw new DomainError('Повтор ID персоны в постановке');
  const acting = new Set(features.flatMap((f) => f.scenarios.map((s) => s.personaId)));
  for (const scenario of features.flatMap((f) => f.scenarios))
    if (!personaIds.includes(scenario.personaId))
      throw new DomainError('Сценарий ссылается на несуществующую персону: ' + scenario.personaId);
  const unused = personas.find((persona) => !acting.has(persona.id));
  if (unused) throw new DomainError('У персоны нет ни одного сценария: ' + unused.id);
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
}
export function validatePreparation(s: DevContourState, previous?: DevContourState) {
  if (!s.preparation) {
    if (previous?.preparation)
      throw new DomainError('Нельзя удалить обязательные продуктовые согласования');
    return;
  }
  const p = preparationState.parse(s.preparation);
  if (
    new Set(p.changes.map((c) => c.id)).size !== p.changes.length ||
    (p.activeChangeId && !p.changes.some((c) => c.id === p.activeChangeId))
  )
    throw new DomainError('Некорректный реестр продуктовых изменений');
  for (const c of p.changes) {
    validateJournal(c);
    for (const stage of ['product', 'architecture'] as const)
      for (const [index, r] of c[stage].entries()) {
        const expected = hash({
          changeId: c.id,
          stage,
          number: r.number,
          content: r.content,
          ...('productDigest' in r ? { productDigest: r.productDigest } : {}),
        });
        if (
          r.number !== index + 1 ||
          r.digest !== expected ||
          ['approved', 'changes-requested'].includes(r.status) !== Boolean(r.decision)
        )
          throw new DomainError('Некорректная версия или решение: ' + c.id);
        if (r.status === 'approved' || r.status === 'in-review') {
          if (stage === 'product') validateProduct(r.content as StoredProductBrief);
          else validateArchitecture(r.content as ArchitectureBrief);
        }
        if (
          'productDigest' in r &&
          !c.product.some((v) => v.digest === r.productDigest && v.status === 'approved')
        )
          throw new DomainError('Архитектура должна ссылаться на утверждённую постановку');
      }
  }
  for (const old of previous?.preparation?.changes ?? []) {
    const next = p.changes.find((c) => c.id === old.id);
    if (!next || next.title !== old.title || next.createdAt !== old.createdAt)
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
    for (const stage of ['product', 'architecture'] as const)
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
  status(id?: string) {
    const s = this.store.read(),
      p = s.preparation;
    if (!p) return { enabled: false as const };
    const c = p.changes.find((c) => c.id === (id ?? p.activeChangeId));
    if (id && !c) throw new DomainError('Изменение не найдено', 404);
    const product = c?.product.at(-1),
      architecture = c?.architecture.at(-1);
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
        title: item.title,
        createdAt: item.createdAt,
        open: (item.questions ?? []).filter((q) => q.status === 'open').length,
      })),
      agentActivity: latest,
      current: c
        ? {
            id: c.id,
            title: c.title,
            product,
            architecture,
            activity: [...(c.activity ?? [])].reverse().slice(0, 40),
            questions: c.questions ?? [],
            decisions: [...(c.decisions ?? [])].reverse(),
            // A release aggregates the features that carry at least one of its
            // criteria; a feature spanning two releases counts in both.
            releases: product
              ? releasesOf(product.content).map((r) => {
                  const own = featuresOf(product.content).filter((f) =>
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
              ? featuresOf(product.content).map((f) => {
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
            history: (['product', 'architecture'] as const).flatMap((stage) =>
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
      phase: ready ? 'development' : product?.status === 'approved' ? 'architecture' : 'product',
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
      return this.status(preparationInputs[operation].parse(input).changeId);
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
            title: v.title,
            createdAt: now(),
            product: [],
            architecture: [],
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
            r.status = 'in-review';
          }
        }
        validatePreparation(s, before);
        return { changeId: selected };
      });
      return this.status(selected);
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
