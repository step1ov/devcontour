import { createHash, randomUUID } from 'node:crypto';
import { DomainError, type DevContourState, type Task } from './model.ts';
import type { Store } from './store.ts';
import {
  preparationInputs,
  preparationDecision,
  preparationState,
  type PreparationBinding,
  type PreparationOperation,
  type ProductChange,
  type ArchitectureBrief,
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
function change(s: DevContourState, id?: string) {
  const c = s.preparation?.changes.find((c) => c.id === (id ?? s.preparation?.activeChangeId));
  if (!c) throw new DomainError('Выберите изменение продукта', 409);
  return c;
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
export function assertTaskPreparation(s: DevContourState, task: Pick<Task, 'preparation'>) {
  if (!s.preparation) return;
  if (
    !task.preparation ||
    hash(task.preparation) !== hash(developmentBinding(s, task.preparation.changeId))
  )
    throw new DomainError(
      'Задача не связана с текущими утверждёнными продуктом и архитектурой',
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
function validateProduct(p: ProductBrief) {
  if (
    p.problem.length < 10 ||
    p.outcome.length < 10 ||
    !p.audience.length ||
    !p.scenarios.length ||
    !p.scope.length ||
    !p.acceptance.length ||
    p.questions.length
  )
    throw new DomainError(
      'Для согласования нужны проблема, пользователи, результат, сценарии, границы и критерии; открытые вопросы нужно решить',
    );
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
  for (const c of p.changes)
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
          if (stage === 'product') validateProduct(r.content as ProductBrief);
          else validateArchitecture(r.content as ArchitectureBrief);
        }
        if (
          'productDigest' in r &&
          !c.product.some((v) => v.digest === r.productDigest && v.status === 'approved')
        )
          throw new DomainError('Архитектура должна ссылаться на утверждённую постановку');
      }
  for (const old of previous?.preparation?.changes ?? []) {
    const next = p.changes.find((c) => c.id === old.id);
    if (!next || next.title !== old.title || next.createdAt !== old.createdAt)
      throw new DomainError('Нельзя удалить историю продуктового изменения');
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
    return {
      enabled: true as const,
      activeChangeId: p.activeChangeId,
      changes: p.changes.map(({ id, title, createdAt }) => ({ id, title, createdAt })),
      current: c
        ? {
            id: c.id,
            title: c.title,
            product,
            architecture,
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
          });
          p.activeChangeId = selected;
        } else {
          const v = preparationInputs[operation].parse(input),
            c = change(s, v.changeId);
          selected = c.id;
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
          } else if (operation === 'preparation_submit') {
            const v = preparationInputs[operation].parse(input),
              r = c[v.stage].at(-1);
            if (!r || r.digest !== v.expectedDigest || r.status !== 'draft')
              throw new DomainError('На согласование можно отправить только текущий черновик', 409);
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
