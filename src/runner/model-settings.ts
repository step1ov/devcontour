import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DevContour, digest, loadedDigest, modelBindings, withoutModels } from '../core/service.ts';
import { DomainError, type Config, type Task } from '../core/model.ts';
import { declaredRoles, repositories, reviewerBinding, roleBinding } from '../core/repositories.ts';
import { approvalPolicyDigest } from '../harness/policy.ts';
import type { UsageRecord } from '../core/usage.ts';
import { loadConfig } from './config.ts';
import { reviewerRunsChecks, toolProfileFor } from './tools.ts';
import { busyWork, configApplyPrefix, failure, reconfigureSlotBusy } from './reconfigure.ts';

/**
 * Модели ролей из панели: кто пишет и кто проверяет — runtime, модель и
 * уровень рассуждения каждой привязки. Только оператор (маршруты панели):
 * агентской операции нет, выбор моделей и независимость ревью — решение
 * владельца, а не исполнителя.
 *
 * Правка идёт тем же путём, что `devcontour config-apply --keys models`:
 * сервер сверяет digest конфигурации, которую видел оператор, проверяет
 * новую тем же загрузчиком (схема, правило вендора, профили инструментов),
 * записывает файл объявления и запрос применения в одной транзакции, а такт
 * сервера применяет его после завершения работ под прежней конфигурацией.
 * Итог — `config.applied` или `config.apply-refused` в журнале.
 *
 * Привязки входят в утверждение плана (`approvalPolicyDigest`): после
 * применения открытые утверждённые задачи требуют повторного утверждения
 * (review-plan). Панель называет их до записи и требует подтверждения;
 * закрепление утверждений она не трогает.
 */

type Binding = { runtime: string; model?: string; effort?: string };
type Json = Record<string, unknown>;

/** Где объявлена привязка: файл и путь к объекту в нём. */
type Location =
  | { file: 'config'; path: string[] }
  | { file: 'component'; repositoryId: string; real: string; display: string; path: string[] };

export type ModelSlot = {
  /** `writer:<repo>:<role>`, `reviewer:<repo>:<role>`, `reviewer:<repo>`, `reviewer`, `review:<kind>`. */
  id: string;
  kind: 'writer' | 'role-reviewer' | 'repository-reviewer' | 'reviewer' | 'review';
  repositoryId?: string;
  role?: string;
  /** Как роль называется в панели. */
  title?: string;
  /** Действующая привязка; `null` — правило по умолчанию (ревью плана и контракта). */
  binding: Binding | null;
  /** Привязка объявлена здесь, а не унаследована. */
  own: boolean;
  /** Что действует без своей привязки. */
  fallback?: string;
  /** Можно ли снять свою привязку (вернуть наследование или правило по умолчанию). */
  nullable: boolean;
  editable: boolean;
  /** Почему привязку здесь не изменить. */
  reason?: string;
  /** Файл объявления, который изменит правка. */
  file?: string;
  /** Профиль инструментов привязки: он связан с runtime. */
  toolProfile?: string;
};

const efforts = ['low', 'medium', 'high', 'xhigh'] as const;
const runtimesOf = (config: Config) =>
  config.mode === 'demo' ? ['codex', 'claude', 'demo'] : ['codex', 'claude'];

const pick = (b: Partial<Binding> | undefined | null): Binding | null =>
  b?.runtime
    ? {
        runtime: b.runtime,
        ...(b.model !== undefined ? { model: b.model } : {}),
        ...(b.effort !== undefined ? { effort: b.effort } : {}),
      }
    : null;

const get = (doc: Json, path: string[]): unknown =>
  path.reduce<unknown>(
    (at, key) => (at && typeof at === 'object' ? (at as Json)[key] : undefined),
    doc,
  );

function readJson(path: string): Json {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
  } catch {
    return {};
  }
}

/** Виды ревью, которые объявляет `workspace.json`: их правку заменил бы следующий workspace-init. */
function declaredReviewKinds(config: Config): string[] {
  if (!config.workspaceRoot) return [];
  const file = join(config.workspaceRoot, 'workspace.json');
  if (!existsSync(file)) return [];
  const review = readJson(file).review;
  return review && typeof review === 'object' ? Object.keys(review) : [];
}

/** Файлы объявления: config.json и файлы компонентов — разобранные и исходный текст. */
type Sources = {
  path: string;
  text: string;
  raw: Json;
  components: Map<string, { real: string; display: string; text: string; raw: Json }>;
};

function readSources(config: Config, root: string): Sources {
  const path = join(root, 'config.json');
  const text = readFileSync(path, 'utf8');
  const components = new Map<string, { real: string; display: string; text: string; raw: Json }>();
  for (const repo of config.repositories)
    if (repo.configFile) {
      const real = realpathSync(resolve(repo.path, repo.configFile));
      const content = readFileSync(real, 'utf8');
      components.set(repo.id, {
        real,
        display: `${repo.id}/${repo.configFile}`,
        text: content,
        raw: JSON.parse(content) as Json,
      });
    }
  return { path, text, raw: JSON.parse(text) as Json, components };
}

type Placed = ModelSlot & { location?: Location; seed?: Json };

/**
 * Привязки конфигурации и место, где правка каждой переживёт workspace-init:
 * файл компонента (он сильнее записи реестра), верхний уровень config.json
 * (существующую роль workspace-init не трогает) или ничего — тогда только
 * показ с причиной.
 */
function placeSlots(config: Config, sources: Sources): Placed[] {
  const slots: Placed[] = [];
  const explicit = config.repositories.length > 0;
  const reviewKinds = declaredReviewKinds(config);
  const entryOf = (id: string) =>
    ((sources.raw.repositories as Json[] | undefined) ?? []).find((r) => r.id === id);
  const topRoles = (sources.raw.roles ?? {}) as Json;
  for (const repo of repositories(config)) {
    const component = sources.components.get(repo.id);
    for (const role of declaredRoles(config, repo.id)) {
      const writer = roleBinding(config, role, repo.id);
      if (!writer) continue;
      const fileRole = component ? get(component.raw, ['roles', role]) : undefined;
      const entryRole = explicit ? get(entryOf(repo.id) ?? {}, ['roles', role]) : undefined;
      let location: Location | undefined;
      let seed: Json | undefined;
      let reason: string | undefined;
      if (component && (fileRole || entryRole)) {
        location = {
          file: 'component',
          repositoryId: repo.id,
          real: component.real,
          display: component.display,
          path: ['roles', role],
        };
        // Роль из записи реестра переносится в файл компонента целиком: файл
        // сильнее записи по ключу роли, и прочие поля роли не теряются.
        if (!fileRole) seed = JSON.parse(JSON.stringify(entryRole)) as Json;
      } else if (entryRole)
        reason =
          'Роль объявлена в записи репозитория config.json, которую переписывает workspace-init: измените её в workspace.json и выполните devcontour workspace-init --file <workspace.json>';
      else if (topRoles[role]) location = { file: 'config', path: ['roles', role] };
      else reason = 'Роль не объявлена в файлах конфигурации, которые меняет панель';
      const file =
        location?.file === 'component' ? location.display : location ? 'config.json' : undefined;
      const title = writer.title;
      slots.push({
        id: `writer:${repo.id}:${role}`,
        kind: 'writer',
        repositoryId: repo.id,
        role,
        ...(title ? { title } : {}),
        binding: pick(writer),
        own: true,
        nullable: false,
        editable: !!location,
        ...(reason ? { reason } : {}),
        ...(file ? { file } : {}),
        ...(writer.toolProfile ? { toolProfile: writer.toolProfile } : {}),
        ...(location ? { location } : {}),
        ...(seed ? { seed } : {}),
      });
      const reviewer = reviewerBinding(config, role, repo.id);
      slots.push({
        id: `reviewer:${repo.id}:${role}`,
        kind: 'role-reviewer',
        repositoryId: repo.id,
        role,
        ...(title ? { title } : {}),
        binding: pick(reviewer),
        own: !!writer.reviewer,
        fallback: repo.reviewer ? `ревьюер компонента ${repo.id}` : 'общий ревьюер кода',
        nullable: true,
        editable: !!location,
        ...(reason ? { reason } : {}),
        ...(file ? { file } : {}),
        ...(writer.reviewer?.toolProfile ? { toolProfile: writer.reviewer.toolProfile } : {}),
        ...(location ? { location: { ...location, path: [...location.path, 'reviewer'] } } : {}),
        ...(seed ? { seed } : {}),
      });
    }
    if (explicit && repo.reviewer) {
      const fileReviewer = component ? get(component.raw, ['reviewer']) : undefined;
      slots.push({
        id: `reviewer:${repo.id}`,
        kind: 'repository-reviewer',
        repositoryId: repo.id,
        binding: pick(repo.reviewer),
        own: true,
        nullable: false,
        editable: !!fileReviewer,
        ...(fileReviewer
          ? {
              file: component!.display,
              location: {
                file: 'component' as const,
                repositoryId: repo.id,
                real: component!.real,
                display: component!.display,
                path: ['reviewer'],
              },
            }
          : {
              reason:
                'Ревьюер объявлен в записи репозитория config.json, которую переписывает workspace-init: измените его в файле компонента или в workspace.json',
            }),
        ...(repo.reviewer.toolProfile ? { toolProfile: repo.reviewer.toolProfile } : {}),
      });
    }
  }
  // Общий ревьюер кода — показывается, где он действует: без компонентов
  // или у компонента без своего ревьюера. Иначе верхний уровень — копия.
  if (!explicit || repositories(config).some((r) => !r.reviewer))
    slots.push({
      id: 'reviewer',
      kind: 'reviewer',
      binding: pick(config.reviewer),
      own: true,
      nullable: false,
      editable: true,
      file: 'config.json',
      location: { file: 'config', path: ['reviewer'] },
      ...(config.reviewer.toolProfile ? { toolProfile: config.reviewer.toolProfile } : {}),
    });
  for (const kind of ['code', 'plan', 'contract'] as const) {
    const reviewer = config.review?.[kind]?.reviewer;
    if (kind === 'code' && !reviewer) continue;
    const declared = reviewKinds.includes(kind);
    slots.push({
      id: `review:${kind}`,
      kind: 'review',
      binding: pick(reviewer),
      own: !!reviewer,
      fallback:
        kind === 'code'
          ? 'ревьюеры ролей'
          : 'по умолчанию: живой runtime другого вендора, чем автор',
      nullable: true,
      editable: !declared,
      ...(declared
        ? {
            reason: `review.${kind} объявлен в workspace.json: следующий workspace-init заменил бы правку config.json. Измените его в workspace.json и выполните devcontour workspace-init --file <workspace.json>`,
          }
        : {
            file: 'config.json',
            location: { file: 'config' as const, path: ['review', kind, 'reviewer'] },
          }),
      ...(reviewer?.toolProfile ? { toolProfile: reviewer.toolProfile } : {}),
    });
  }
  return slots;
}

/**
 * Модели, которые workspace знает по runtime: названные привязками
 * конфигурации, тарифами и уже сделанными вызовами. Пустая модель — модель
 * CLI по умолчанию; другой модели панель не предлагает и маршрут не примет.
 */
export function knownModels(h: DevContour): Record<string, string[]> {
  const known: Record<string, Set<string>> = {};
  const add = (runtime: string, model?: string | null) => {
    if (!model) return;
    (known[runtime] ??= new Set()).add(model);
  };
  for (const b of Object.values(modelBindings(h.config))) add(b.runtime, b.model);
  for (const p of h.config.prices) add(p.runtime, p.model);
  for (const { value } of h.store.localEntries<Pick<UsageRecord, 'runtime' | 'model'>>('usage'))
    add(value.runtime, value.model);
  return Object.fromEntries(runtimesOf(h.config).map((r) => [r, [...(known[r] ?? [])].sort()]));
}

/** Слот для панели: без места записи и заготовки роли — их знает только сервер. */
const publicSlot = (placed: Placed): ModelSlot =>
  Object.fromEntries(
    Object.entries(placed).filter(([key]) => key !== 'location' && key !== 'seed'),
  ) as ModelSlot;

/** Модели ролей для панели: привязки, допустимые значения и ведущий агент. */
export function modelSettingsView(h: DevContour, root: string) {
  let slots: ModelSlot[] = [];
  let error: string | undefined;
  try {
    slots = placeSlots(h.config, readSources(h.config, root)).map(publicSlot);
  } catch (e) {
    // Нечитаемый файл компонента: привязки видны по загруженной конфигурации.
    error = failure(e);
  }
  return {
    slots,
    runtimes: runtimesOf(h.config),
    models: knownModels(h),
    efforts: [...efforts],
    /** Effort передаётся только codex (`model_reasoning_effort`). */
    effortRuntimes: ['codex'],
    ...(error ? { error } : {}),
  };
}

const bindingInput = z.strictObject({
  runtime: z.string().min(1).max(40),
  model: z.string().min(1).max(200).nullable().optional(),
  effort: z.enum(efforts).nullable().optional(),
});
export const modelsRequest = z.strictObject({
  changes: z
    .array(z.strictObject({ slot: z.string().min(1).max(300), binding: bindingInput.nullable() }))
    .min(1)
    .max(100),
  /** Digest конфигурации, которую видел оператор: файлы сдвинулись — отказ без записи. */
  expectedConfigDigest: z.string().regex(/^[a-f0-9]{64}$/),
  /** Оператор видел, что утверждённые задачи потребуют повторного утверждения плана. */
  acknowledgeReapproval: z.boolean().optional(),
});

const sameBinding = (a: Binding | null, b: Binding | null) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Записать поля модели в объект привязки, сохранив прочие (профиль инструментов, области записи). */
function assign(target: Json, binding: z.infer<typeof bindingInput>) {
  target.runtime = binding.runtime;
  if (binding.model) target.model = binding.model;
  else delete target.model;
  if (binding.effort) target.effort = binding.effort;
  else delete target.effort;
}

function setAt(doc: Json, path: string[], binding: z.infer<typeof bindingInput> | null) {
  const parents = path.slice(0, -1);
  const key = path.at(-1)!;
  if (binding === null) {
    const parent = get(doc, parents) as Json | undefined;
    if (parent) delete parent[key];
    // Пустое правило ревью без ревьюера — то же, что его отсутствие.
    for (let i = parents.length; i > 0; i--) {
      const owner = get(doc, parents.slice(0, i - 1)) as Json | undefined;
      const value = get(doc, parents.slice(0, i)) as Json | undefined;
      if (owner && value && typeof value === 'object' && !Object.keys(value).length)
        delete owner[parents[i - 1]];
      else break;
    }
    return;
  }
  let at = doc;
  for (const p of parents) {
    if (!at[p] || typeof at[p] !== 'object') at[p] = {};
    at = at[p] as Json;
  }
  if (!at[key] || typeof at[key] !== 'object') at[key] = {};
  assign(at[key] as Json, binding);
}

type Planned = {
  current: Config;
  candidate: Config;
  sources: Sources;
  nextConfig: string;
  nextComponents: Map<string, string>;
  changes: { slot: string; label: string; before: Binding | null; after: Binding | null }[];
};

const slotLabel = (s: ModelSlot) =>
  s.kind === 'writer'
    ? `${s.title ?? s.role} (${s.repositoryId}): исполнитель`
    : s.kind === 'role-reviewer'
      ? `${s.title ?? s.role} (${s.repositoryId}): ревьюер кода`
      : s.kind === 'repository-reviewer'
        ? `Ревьюер компонента ${s.repositoryId}`
        : s.kind === 'reviewer'
          ? 'Общий ревьюер кода'
          : s.id === 'review:plan'
            ? 'Ревью плана'
            : s.id === 'review:contract'
              ? 'Ревью контракта'
              : 'Ревью кода (правило)';

/** Собрать новые тексты файлов и проверить их тем же загрузчиком, без записи. */
function plan(h: DevContour, root: string, input: z.infer<typeof modelsRequest>): Planned {
  const sources = readSources(h.config, root);
  const current = loadConfig(sources.path, sources.text);
  if (loadedDigest(current) !== input.expectedConfigDigest)
    throw new DomainError(
      'Конфигурация отличается от той, которую видела панель: в файлах неприменённые правки (примените их devcontour config-apply или верните файлы) либо их изменили после чтения — обновите страницу и повторите',
      409,
    );
  const slots = placeSlots(current, sources);
  const known = knownModels(h);
  const runtimes = runtimesOf(current);
  const configDoc = JSON.parse(sources.text) as Json;
  const componentDocs = new Map<string, Json>();
  const doc = (location: Location) => {
    if (location.file === 'config') return configDoc;
    let found = componentDocs.get(location.repositoryId);
    if (!found) {
      found = JSON.parse(sources.components.get(location.repositoryId)!.text) as Json;
      componentDocs.set(location.repositoryId, found);
    }
    return found;
  };
  const seen = new Set<string>();
  const changes: Planned['changes'] = [];
  for (const change of input.changes) {
    if (seen.has(change.slot)) throw new DomainError(`Привязка ${change.slot} названа дважды`, 400);
    seen.add(change.slot);
    const slot = slots.find((s) => s.id === change.slot);
    if (!slot) throw new DomainError(`Неизвестная привязка: ${change.slot}`, 400);
    if (!slot.editable || !slot.location)
      throw new DomainError(`${slotLabel(slot)}: ${slot.reason ?? 'не изменяется из панели'}`, 409);
    const binding = change.binding;
    if (binding === null && !slot.nullable)
      throw new DomainError(`${slotLabel(slot)}: привязку нельзя снять, выберите runtime`, 400);
    if (binding) {
      if (!runtimes.includes(binding.runtime))
        throw new DomainError(
          `${slotLabel(slot)}: runtime ${binding.runtime} не поддерживается; доступны ${runtimes.join(', ')}`,
          400,
        );
      if (
        binding.model &&
        !known[binding.runtime]?.includes(binding.model) &&
        !(slot.binding?.runtime === binding.runtime && slot.binding.model === binding.model)
      )
        throw new DomainError(
          `${slotLabel(slot)}: модель ${binding.model} для ${binding.runtime} workspace не знает. Доступны: ${known[binding.runtime]?.join(', ') || 'только модель CLI по умолчанию'}. Новую модель объявите тарифом (prices) в config.json`,
          400,
        );
      if (binding.effort && binding.runtime !== 'codex')
        throw new DomainError(
          `${slotLabel(slot)}: уровень рассуждения поддерживается только для codex`,
          400,
        );
    }
    const before = slot.own ? slot.binding : null;
    const after = binding ? pick(binding as Binding) : null;
    if (sameBinding(before, after)) continue;
    const target = doc(slot.location);
    // Роль, которой в файле компонента ещё нет, переносится из записи реестра целиком.
    if (slot.seed && !get(target, ['roles', slot.role!])) {
      target.roles = { ...(target.roles ?? {}) };
      (target.roles as Json)[slot.role!] = JSON.parse(JSON.stringify(slot.seed)) as Json;
    }
    setAt(target, slot.location.path, after as z.infer<typeof bindingInput> | null);
    changes.push({ slot: slot.id, label: slotLabel(slot), before: slot.binding, after });
  }
  if (!changes.length) throw new DomainError('Изменений нет: привязки уже такие', 400);
  // Единственный компонент: верхний уровень config.json — копия его ролей и
  // ревьюера (так их пишет workspace-init). Копия получает те же поля модели,
  // иначе config.json показывал бы модели, которых контур уже не вызывает.
  if (current.repositories.length === 1) {
    const repo = current.repositories[0];
    const file = componentDocs.get(repo.id);
    if (file) {
      const topRoles = (configDoc.roles ?? {}) as Json;
      const fileRoles = (file.roles ?? {}) as Json;
      const fileReviewer = file.reviewer as Json | undefined;
      const copy = (to: Json | undefined, from: Json | undefined) => {
        if (!to || !from?.runtime) return;
        assign(to, from as z.infer<typeof bindingInput>);
      };
      for (const [id, b] of Object.entries(fileRoles)) {
        const top = topRoles[id] as Json | undefined;
        if (!top) continue;
        copy(top, b as Json);
        copy(top.reviewer as Json | undefined, ((b as Json).reviewer as Json) ?? fileReviewer);
      }
      copy(configDoc.reviewer as Json | undefined, fileReviewer);
    }
  }
  const nextConfig = JSON.stringify(configDoc, null, 2) + '\n';
  const nextComponents = new Map<string, string>();
  for (const [id, value] of componentDocs)
    nextComponents.set(id, JSON.stringify(value, null, 2) + '\n');
  let candidate: Config;
  try {
    candidate = loadConfig(
      sources.path,
      nextConfig,
      new Map(
        [...nextComponents].map(([id, text]) => [sources.components.get(id)!.real, text] as const),
      ),
    );
  } catch (error) {
    throw new DomainError(`Конфигурация с этими моделями не принята: ${failure(error)}`, 400);
  }
  // Применение `models` допускает отличие только полей модели: то же правило
  // проверит сервер при применении.
  if (digest(withoutModels(candidate)) !== digest(withoutModels(current)))
    throw new DomainError(
      'Правка изменила бы не только модели привязок; измените конфигурацию вручную и перезапустите serve',
      400,
    );
  return { current, candidate, sources, nextConfig, nextComponents, changes };
}

const openStatuses = (t: Task) => !['draft', 'done', 'cancelled'].includes(t.status);

/** Что изменит применение: утверждения, идущие работы, ослабление ревью, файлы. */
function consequences(h: DevContour, planned: Planned) {
  const { current, candidate } = planned;
  const before = approvalPolicyDigest(current);
  const after = approvalPolicyDigest(candidate);
  const state = h.store.read();
  // Утверждение прежней версии без закрепления считается данным при текущей
  // политике: его тоже затронет смена.
  const affected =
    before === after
      ? []
      : state.tasks.filter(
          (t) =>
            openStatuses(t) &&
            !!t.approvedDigest &&
            (!t.approvedPolicy || t.approvedPolicy === before),
        );
  const warnings: string[] = [];
  for (const repo of repositories(candidate))
    for (const role of declaredRoles(candidate, repo.id)) {
      const writer = roleBinding(candidate, role, repo.id);
      const reviewer = reviewerBinding(candidate, role, repo.id);
      const wasWriter = roleBinding(current, role, repo.id);
      const wasReviewer = reviewerBinding(current, role, repo.id);
      const name = `${writer?.title ?? role} (${repo.id})`;
      if (
        writer &&
        writer.runtime === reviewer.runtime &&
        candidate.mode !== 'demo' &&
        !(wasWriter && wasWriter.runtime === wasReviewer.runtime)
      )
        warnings.push(
          `${name}: ревьюер того же вендора, что исполнитель (${writer.runtime}) — так разрешает явное правило same-vendor-allowed; независимость ревью держится только на отдельной сессии`,
        );
      const runs = (config: Config, runtime: string) => {
        try {
          return reviewerRunsChecks(
            runtime as 'codex' | 'claude',
            toolProfileFor(config, runtime as 'codex' | 'claude', role, true, repo.id),
          );
        } catch {
          return false;
        }
      };
      if (runs(current, wasReviewer.runtime) && !runs(candidate, reviewer.runtime))
        warnings.push(
          `${name}: ревьюер ${reviewer.runtime} не сможет запускать проверки (нет shell в профиле инструментов ${reviewer.toolProfile ?? `${reviewer.runtime}-review`}) — ревью станет только чтением diff`,
        );
    }
  return {
    changes: planned.changes,
    approvals: {
      /** Утверждения плана, закреплённые при прежних моделях: задачи не выдаются до повторного утверждения. */
      stale: affected.length,
      tasks: affected.slice(0, 20).map((t) => ({ id: t.id, title: t.title })),
    },
    /** Работы под прежней конфигурацией: сервер применит правку после их завершения. */
    waitingFor: busyWork(h),
    warnings,
    files: [
      'config.json',
      ...[...planned.nextComponents.keys()].map(
        (id) => planned.sources.components.get(id)!.display,
      ),
    ],
    /** Файлы компонентов лежат в репозитории продукта: их правку стоит закоммитить. */
    commit: [...planned.nextComponents.keys()].map(
      (id) => planned.sources.components.get(id)!.display,
    ),
  };
}

/** Показать, что изменит правка, без записи. */
export function previewModels(h: DevContour, root: string, raw: unknown) {
  const input = modelsRequest.parse(raw);
  const planned = plan(h, root, input);
  return { status: 'preview' as const, ...consequences(h, planned) };
}

/**
 * Записать модели и запрос применения `config-apply:models`. Файлы и запрос —
 * вместе: если запрос не записался, все файлы возвращаются к прежнему тексту.
 */
export function requestModels(h: DevContour, root: string, raw: unknown) {
  const input = modelsRequest.parse(raw);
  const planned = plan(h, root, input);
  const effects = consequences(h, planned);
  if (effects.approvals.stale && !input.acknowledgeReapproval)
    throw new DomainError(
      `Утверждение плана ${effects.approvals.stale} задач закреплено при прежних моделях: после применения они не выдаются, пока план не утверждён заново (review-plan). Подтвердите это и повторите`,
      409,
    );
  // Утверждения прежней версии без закрепления закрепляются за текущей
  // политикой до смены: иначе первый такт после применения закрепил бы их за
  // новой молча.
  if (effects.approvals.stale) h.pinLegacyApprovals();
  const digestNext = loadedDigest(planned.candidate);
  const operation = `${configApplyPrefix}models:${randomUUID().slice(0, 8)}`;
  const files = [
    { path: planned.sources.path, before: planned.sources.text, after: planned.nextConfig },
    ...[...planned.nextComponents].map(([id, after]) => {
      const source = planned.sources.components.get(id)!;
      return { path: source.real, before: source.text, after };
    }),
  ];
  const replace = (path: string, content: string) => {
    const mode = statSync(path).mode & 0o777;
    const temp = join(resolve(path, '..'), `.${basename(path)}.${randomUUID().slice(0, 8)}.tmp`);
    writeFileSync(temp, content, { mode, flag: 'wx' });
    renameSync(temp, path);
  };
  const written: typeof files = [];
  try {
    h.store.atomic(() => {
      const busy = h.store.read().reconfigure;
      if (reconfigureSlotBusy(busy))
        throw new DomainError(
          `Конфигурацию сейчас применяет операция ${busy!.operation}: дождитесь её и повторите`,
          409,
        );
      if (busy) h.clearReconfigure(busy.operation);
      for (const file of files) {
        replace(file.path, file.after);
        written.push(file);
      }
      h.requestReconfigure(operation, digestNext);
    });
  } catch (error) {
    for (const file of written.reverse()) replace(file.path, file.before);
    throw error;
  }
  return { status: 'requested' as const, operation, digest: digestNext, ...effects };
}
