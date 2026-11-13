import { domain, executionOf } from '../harness/execution.ts';
import { readFileSync, realpathSync } from 'node:fs';
import {
  developmentBinding,
  assertAnyDevelopmentReady,
  assertFeatureOf,
  assertTaskFeature,
  assertTaskPreparation,
} from './preparation.ts';
import {
  outsideRoleScope,
  roleScopeAdvice,
  validateTaskContext,
  validateWorkflow,
} from './workflow.ts';
import type { PreparationRequest } from './preparation-model.ts';
import { entityId } from './ids.ts';
import { createHash } from 'node:crypto';
import { repository, repositories, requiresContract, expandGates } from './repositories.ts';
import { Store } from './store.ts';
import { type FailureKind } from './failure.ts';
import { needsRecheck, taskChecks, taskEvidence, unprovenReason } from './proof.ts';
import { assertTaskProperties, type CheckDeclaration } from './checks.ts';
import {
  draftIssues,
  recoveryActions,
  uncoveredGates as harnessUncoveredGates,
  gatePrerequisites,
  standaloneScope,
  blocksWork,
  requestsOf,
  type CancelActor,
  type ChangedPaths,
  type CodedIssue,
  type ExecutionPolicy,
  type PropertyRecovery,
  type RetryActor,
} from 'devcontour-harness';
import { closeEpisodeIfBasisChanged, episodeBasisOf, storyGuard } from '../harness/host.ts';
import { referenceKey, type StoryBinding } from './intent.ts';
import { approvalPolicyDigest } from '../harness/policy.ts';
import { rebindInputContext } from '../harness/input-host.ts';
import { planIngest } from './plan.ts';
import { boardOwner, completion, receiptHolds, receiptRecordBytes } from './sync-state.ts';
import { carriedTaskIds, pausedByLead } from './work-status.ts';
import { assertDag, descendants, latestTaskId, impactGraph } from './graph.ts';
import {
  DomainError,
  requireValue,
  taskIngest,
  taskInput,
  discoveryInput,
  FINDING_ACCEPTANCE,
  type Contract,
  type ContractArtifact,
  type Task,
  type TaskInput,
  type Board,
  type DevContourState,
  type Config,
  type Evidence,
  type Run,
  type Approval,
  type BaseMove,
  CONTRACT_CONTENT_MAX,
} from './model.ts';
/**
 * Эксплуатационные ключи, которые работающий сервер применяет по запросу
 * `config-apply` без перезапуска: в digest утверждения плана они не входят
 * (`approvalPolicyDigest`), и попытки по ним не устаревают.
 */
export const operationalKeys = [
  'budgets',
  'prices',
  'stallSweep',
  'inputPolicy',
  'gateTimeoutFloorMs',
] as const;
export type OperationalKey = (typeof operationalKeys)[number];
/**
 * Ключи запроса `config-apply`: эксплуатационные и `models` — runtime, модель
 * и уровень рассуждения привязок исполнителей и ревьюеров. `models` не
 * эксплуатационный ключ: привязки входят в digest утверждения плана, поэтому
 * после применения открытые утверждённые задачи требуют повторного
 * утверждения (`approvalStale`), а не перезакрепляются молча. Применяется тем
 * же запросом и тем же drain, что и эксплуатационные ключи.
 */
export const applyKeys = [...operationalKeys, 'models'] as const;
export type ApplyKey = (typeof applyKeys)[number];
type ModelFields = { runtime: string; model?: string; effort?: string };
type BindingHolder = Record<string, unknown> | undefined;
/**
 * Привязки конфигурации по месту объявления: роли и их ревьюеры, ревьюер
 * workspace, роли и ревьюеры компонентов, ревьюеры правил ревью. `visit`
 * получает объект привязки и путь к нему.
 */
function eachBinding(c: Config, visit: (binding: Record<string, unknown>, at: string) => void) {
  const role = (b: BindingHolder, at: string) => {
    if (!b) return;
    visit(b, at);
    if (b.reviewer) visit(b.reviewer as Record<string, unknown>, at + '.reviewer');
  };
  for (const [id, b] of Object.entries(c.roles ?? {})) role(b, `roles.${id}`);
  if (c.reviewer) visit(c.reviewer, 'reviewer');
  for (const r of c.repositories ?? []) {
    for (const [id, b] of Object.entries(r.roles ?? {}))
      role(b, `repositories.${r.id}.roles.${id}`);
    if (r.reviewer) visit(r.reviewer, `repositories.${r.id}.reviewer`);
  }
  for (const kind of ['code', 'plan', 'contract'] as const) {
    const reviewer = c.review?.[kind]?.reviewer;
    if (reviewer) visit(reviewer, `review.${kind}.reviewer`);
  }
}
/** Значение ключа `models`: runtime, модель и effort каждой привязки по её месту. */
export function modelBindings(c: Config): Record<string, ModelFields> {
  const result: Record<string, ModelFields> = {};
  eachBinding(c, (b, at) => {
    result[at] = {
      runtime: b.runtime as string,
      ...(b.model !== undefined ? { model: b.model as string } : {}),
      ...(b.effort !== undefined ? { effort: b.effort as string } : {}),
    };
  });
  return result;
}
/** Конфигурация без полей модели в привязках: что ещё обязано совпасть при применении `models`. */
export function withoutModels(c: Config): Config {
  const copy = JSON.parse(JSON.stringify(c)) as Config;
  eachBinding(copy, (b) => {
    delete b.runtime;
    delete b.model;
    delete b.effort;
  });
  // Свой ревьюер роли или правила ревью, у которого кроме модели ничего нет, —
  // тоже выбор модели: его появление или снятие не меняет прочего.
  const empty = (v: unknown) => !!v && typeof v === 'object' && !Object.keys(v).length;
  const roles = (bindings: Record<string, { reviewer?: unknown }> | undefined) => {
    for (const b of Object.values(bindings ?? {})) if (empty(b.reviewer)) delete b.reviewer;
  };
  roles(copy.roles);
  for (const r of copy.repositories ?? []) roles(r.roles);
  if (copy.review) {
    const review = copy.review as Record<string, { reviewer?: unknown } | undefined>;
    for (const kind of Object.keys(review)) {
      if (empty(review[kind]?.reviewer)) delete review[kind]!.reviewer;
      if (empty(review[kind])) delete review[kind];
    }
    if (empty(copy.review)) delete copy.review;
  }
  return copy;
}
/** Значение ключа запроса применения в конфигурации (журнал `config.applied`). */
export const applyKeyValue = (c: Config, key: ApplyKey): unknown =>
  key === 'models' ? modelBindings(c) : (c[key] ?? null);
export { digest, scopeDigest, specDigest } from './task-digest.ts';
import { digest, scopeDigest, specDigest } from './task-digest.ts';
/**
 * Digest контракта: документ и, если объявлены, нормативные артефакты —
 * путь, назначение и содержимое. Контракт без артефактов сохраняет прежний
 * digest текста, и утверждённые раньше задачи остаются действительными.
 */
export function contractDigest(
  content: string,
  artifacts: ContractArtifact[] | undefined,
  /**
   * Формула закрепления записи — всегда явно. Значение по умолчанию здесь
   * опасно: явно переданный undefined тоже получил бы его, и запись первой
   * формулы проверялась бы по второй.
   */
  pinVersion: 2 | undefined,
  /**
   * Договор проверки входит в digest, если объявлен: изменённое обязательство,
   * покрытие или политика расширения — другой договор. Без него формула
   * прежняя, и утверждённые раньше контракты остаются действительными.
   */
  checks?: CheckDeclaration,
  /**
   * Реализация под тестом входит в digest, только если объявлена: формулы
   * прежних контрактов не меняются.
   */
  underTest?: string[],
) {
  const subject = underTest?.length ? { underTest } : {};
  if (checks)
    return digest({
      content,
      artifacts: (artifacts ?? []).map((a) => ({
        repositoryId: a.repositoryId,
        path: a.path,
        purpose: a.purpose,
        blob: a.blob,
        digest: a.digest,
      })),
      checks,
      ...subject,
    });
  return artifacts?.length
    ? digest({
        content,
        artifacts: artifacts.map((a) => ({
          repositoryId: a.repositoryId,
          path: a.path,
          purpose: a.purpose,
          // Blob — часть закрепления: подменённый blob при прежнем digest
          // содержимого даёт другой digest контракта. Первая формула его не
          // включала; её записи сверяются с Git при импорте.
          ...(pinVersion === 2 ? { blob: a.blob } : {}),
          digest: a.digest,
        })),
        ...subject,
      })
    : digest(content);
}
/**
 * Тот же ли это договор: текст и закреплённые файлы совпадают. Сравнение — по
 * blob, а не по digest: у записей разных формул digest разный при одном и том
 * же содержимом.
 */
export function samePin(
  c: Contract,
  content: string,
  artifacts: ContractArtifact[],
  checks?: CheckDeclaration,
  underTest?: string[],
) {
  return c.content === content && sameObligations(c, artifacts, checks, underTest);
}
/**
 * Те же закреплённые файлы, договор проверки и реализация под тестом —
 * всё, кроме текста документа. Консолидация обязана их сохранить.
 */
export function sameObligations(
  c: Contract,
  artifacts: ContractArtifact[],
  checks?: CheckDeclaration,
  underTest?: string[],
) {
  const pinned = c.artifacts ?? [];
  return (
    JSON.stringify(c.checks ?? null) === JSON.stringify(checks ?? null) &&
    JSON.stringify(c.underTest?.length ? c.underTest : null) ===
      JSON.stringify(underTest?.length ? underTest : null) &&
    pinned.length === artifacts.length &&
    pinned.every((a) =>
      artifacts.some(
        (b) =>
          b.path === a.path &&
          b.blob === a.blob &&
          b.purpose === a.purpose &&
          b.repositoryId === a.repositoryId,
      ),
    )
  );
}
/**
 * Более поздняя утверждённая редакция того же контракта, меняющая его смысл.
 * Каждое утверждение создаёт новый id, и задача, привязанная к прежнему,
 * проходила утверждение и запускалась на старом тексте, хотя в дереве уже
 * лежала новая редакция того же файла. Редакции одного контракта — один
 * источник в одном репозитории.
 *
 * Консолидация (`consolidates`, D-решение «равносильная редакция сохраняет
 * привязки») переписывает текст без изменения смысла: редакция, за которой
 * следуют только консолидации её цепочки, не заменена — привязанные к ней
 * задачи сохраняют digests и утверждение. Любая другая более поздняя
 * редакция заменяет её вместе со всеми её консолидациями; возвращается
 * последняя редакция документа.
 */
export function supersededBy(contracts: readonly Contract[], id: string): Contract | undefined {
  const c = contracts.find((x) => x.id === id);
  if (!c?.source) return undefined;
  const { latest, current } = equivalenceChain(contracts, c);
  return current.id === latest.id ? undefined : latest;
}
/**
 * Есть ли у документа контракта более поздняя редакция любого рода, включая
 * консолидацию. Отличается от `supersededBy`: годится там, где важен
 * действующий текст документа (размер, замыкание артефактов), а не привязка.
 */
export function newerRedaction(contracts: readonly Contract[], id: string): Contract | undefined {
  const c = contracts.find((x) => x.id === id);
  if (!c?.source) return undefined;
  const redactions = contractRedactionsOf(contracts, c.source, c.repositoryId);
  const latest = redactions.at(-1);
  return latest && redactions.indexOf(latest) > redactions.indexOf(c) ? latest : undefined;
}
/**
 * Цепочка равносильных редакций от `c`: каждая следующая редакция документа
 * консолидирует предыдущую звено за звеном. `current` — последнее звено,
 * `latest` — последняя редакция документа (равна `current`, если цепочку не
 * прервала смысловая редакция).
 */
function equivalenceChain(contracts: readonly Contract[], c: Contract) {
  const redactions = c.source ? contractRedactionsOf(contracts, c.source, c.repositoryId) : [c];
  let current = c;
  for (const r of redactions.slice(redactions.indexOf(c) + 1)) {
    if (!consolidatesDirectly(r, current)) break;
    current = r;
  }
  return { current, latest: redactions.at(-1) ?? c };
}
/** `r` консолидирует именно `before` и зарегистрирована сразу после неё. */
const consolidatesDirectly = (r: Contract, before: Contract) =>
  r.consolidates?.from === before.id && r.previous === before.id;
/**
 * Действующий текст договора, к которому привязан `id`: последняя
 * консолидация в его цепочке равносильных редакций или он сам. Исполнитель
 * задачи, привязанной к редакции до консолидации, читает текущий текст того
 * же смысла.
 */
export function currentText(contracts: readonly Contract[], id: string): Contract | undefined {
  const c = contracts.find((x) => x.id === id);
  return c && equivalenceChain(contracts, c).current;
}
/**
 * Действующие тексты контрактов задачи: каждая привязка — через
 * `currentText`. Context pack после консолидации закрепляет её текст, а
 * задача остаётся привязанной к прежней редакции: сверка закрепления с
 * текстом прежней редакции блокировала бы каждый её запуск.
 */
export function currentContracts(contracts: readonly Contract[], ids: readonly string[]) {
  const out: Contract[] = [];
  for (const id of ids) {
    const c = currentText(contracts, id);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}
/**
 * Поправки документа: смысловые редакции после последней консолидации, а
 * без неё — после первой регистрации. Каждая добавляет к тексту, и после
 * нескольких подряд документ пора переписать начисто.
 */
export function meaningRedactionsSinceConsolidation(
  contracts: readonly Contract[],
  source: string,
  repositoryId: string | undefined,
) {
  const all = contractRedactionsOf(contracts, source, repositoryId);
  const equivalent = (i: number) => i > 0 && consolidatesDirectly(all[i], all[i - 1]);
  const last = all.findLastIndex((_, i) => equivalent(i));
  // Первая регистрация документа — не поправка.
  const from = Math.max(last + 1, 1);
  return all.slice(from).filter((_, i) => !equivalent(from + i)).length;
}
/** Редакции документа контракта `source` компонента в порядке утверждения (`orderRedactions`). */
export function contractRedactionsOf(
  contracts: readonly Contract[],
  source: string,
  repositoryId: string | undefined,
): Contract[] {
  return orderRedactions(
    contracts.filter(
      (x) => x.source === source && (x.repositoryId ?? 'main') === (repositoryId ?? 'main'),
    ),
  );
}
/**
 * Порядок утверждения редакций одного документа. Позиция в реестре его не
 * доказывает: Git sync собирает записи в порядке ключей, а id — UUID, и
 * «последней» становилась случайная редакция. Порядок задают ссылки
 * `previous` (предыдущая редакция при регистрации) и `consolidates.from`:
 * редакция идёт после той, на которую ссылается. Записи прежних версий без
 * ссылок упорядочиваются временем утверждения, при равенстве — id.
 * Консолидация встаёт сразу за редакцией, которую консолидирует:
 * параллельная ей поправка того же предшественника идёт после и заменяет
 * обе (её текст несёт поправку, а смысл консолидации прежний).
 */
export function orderRedactions(list: readonly Contract[]): Contract[] {
  // Время, затем id: позиция в реестре на разных клонах разная, и при равном
  // времени клоны иначе выбрали бы разные «последние» редакции.
  const fallback = [...list].sort((a, b) =>
    a.approvedAt < b.approvedAt
      ? -1
      : a.approvedAt > b.approvedAt
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
  );
  const ids = new Set(list.map((c) => c.id));
  const parents = (c: Contract) =>
    [c.previous, c.consolidates?.from].filter((p): p is string => !!p && p !== c.id && ids.has(p));
  const out: Contract[] = [];
  const placed = new Set<string>();
  const ready = (c: Contract) => !placed.has(c.id) && parents(c).every((p) => placed.has(p));
  while (out.length < fallback.length) {
    const last = out.at(-1);
    const next =
      fallback.find((c) => ready(c) && !!last && c.consolidates?.from === last.id) ??
      fallback.find(ready);
    // Цикл ссылок (повреждённая запись): остаток — по времени утверждения.
    if (!next) {
      out.push(...fallback.filter((c) => !placed.has(c.id)));
      break;
    }
    out.push(next);
    placed.add(next.id);
  }
  return out;
}
/**
 * Развилки истории документа: две и больше смысловых редакций (не прямые
 * консолидации) с одной и той же действующей предшественницей — её
 * `previous`, приведённой через прямые консолидации к смысловой редакции.
 * Так бывает, когда два клона поправили одну редакцию параллельно: после sync
 * действует последняя по порядку (`winner`), а поправка другой выпадает из
 * текущего договора без сигнала. `branches` — редакции развилки по порядку.
 */
export function contractForks(contracts: readonly Contract[]) {
  const forks: {
    source: string;
    repositoryId?: string;
    base: string;
    branches: string[];
    winner: string;
  }[] = [];
  const documents = new Map<string, Contract>();
  for (const c of contracts)
    if (c.source) documents.set(`${c.repositoryId ?? 'main'}\0${c.source}`, c);
  for (const sample of documents.values()) {
    const all = contractRedactionsOf(contracts, sample.source!, sample.repositoryId);
    const byId = new Map(all.map((c) => [c.id, c]));
    // Смысловая редакция за цепочкой прямых консолидаций.
    const meaning = (id: string) => {
      let c = byId.get(id);
      for (let guard = 0; c && guard < all.length; guard++) {
        const from = c.consolidates && byId.get(c.consolidates.from);
        if (!from || !consolidatesDirectly(c, from)) break;
        c = from;
      }
      return c?.id ?? id;
    };
    const groups = new Map<string, Contract[]>();
    for (const c of all) {
      if (!c.previous) continue;
      const from = c.consolidates && byId.get(c.consolidates.from);
      if (from && consolidatesDirectly(c, from)) continue;
      const base = meaning(c.previous);
      groups.set(base, [...(groups.get(base) ?? []), c]);
    }
    for (const [base, branches] of groups)
      // Развилка открыта, пока действует одна из её ветвей (с точностью до её
      // прямых консолидаций). Смысловая редакция поверх действующей
      // зарегистрирована клоном, видевшим обе ветви, — она и есть сводящая.
      if (branches.length > 1 && branches.some((b) => b.id === meaning(all.at(-1)!.id)))
        forks.push({
          source: sample.source!,
          ...(sample.repositoryId ? { repositoryId: sample.repositoryId } : {}),
          base,
          branches: branches.map((c) => c.id),
          winner: all.at(-1)!.id,
        });
  }
  return forks;
}
/**
 * Последняя редакция документа контракта — единое определение для
 * `supersededBy` и снятия переноса базы по доказательству ревью. Порядок —
 * `orderRedactions`, а не позиция в реестре.
 */
export function latestRedaction(
  contracts: readonly Contract[],
  source: string,
  repositoryId: string | undefined,
): Contract | undefined {
  return contractRedactionsOf(contracts, source, repositoryId).at(-1);
}
const now = () => new Date().toISOString();
const task = (s: DevContourState, id: string) =>
  requireValue(
    s.tasks.find((t) => t.id === id),
    `Задача ${id} не найдена`,
  );
const board = (s: DevContourState, id: string) =>
  requireValue(
    s.boards.find((b) => b.id === id),
    `Доска ${id} не найдена`,
  );
/**
 * Изменение продукта доски: изменение последней по порядку живой задачи
 * доски, привязанной к подготовке (`except` — правленая задача). Следующий
 * этап и задачи, добавленные в ревизию, продолжают изменение доски, а не
 * активное изменение workspace: изменения независимы, и активным может быть
 * другое, проработка которого идёт параллельно.
 */
function boardChanges(s: DevContourState, b: Board | undefined, except?: string) {
  const ids: string[] = [];
  for (const r of [...(b?.revisions ?? [])].reverse())
    for (const id of [...r.taskIds].reverse()) {
      const t = s.tasks.find((t) => t.id === id);
      if (!t || t.id === except || t.status === 'cancelled' || !t.preparation) continue;
      if (!ids.includes(t.preparation.changeId)) ids.push(t.preparation.changeId);
    }
  return ids;
}
const boardChangeId = (s: DevContourState, b: Board | undefined, except?: string) =>
  boardChanges(s, b, except)[0];
const changeKeyOf = (s: DevContourState, id: string) =>
  s.preparation?.changes.find((c) => c.id === id)?.key ?? id;
/**
 * Явно названное изменение задачи или плана. Вне продуктового процесса —
 * отказ, а не молчаливый пропуск. Переданные digests сверяются с действующими
 * утверждёнными: устаревшая привязка отклоняется. Доска ведёт одно изменение:
 * другое изменение на доске с живыми задачами — отказ.
 */
function requestedChange(
  s: DevContourState,
  request: PreparationRequest | undefined,
  b: Board | undefined,
  except?: string,
) {
  if (!request) return undefined;
  if (!s.preparation)
    throw new DomainError(
      'Привязка к изменению продукта есть только в продуктовом процессе; уберите preparation/changeId',
      409,
    );
  const current = developmentBinding(s, request.changeId)!;
  const stale = (Object.keys(request) as (keyof PreparationRequest)[]).some(
    (key) => key !== 'changeId' && request[key] !== undefined && request[key] !== current[key],
  );
  if (stale)
    throw new DomainError(
      `Привязка к изменению ${changeKeyOf(s, request.changeId)} устарела: digests не совпадают с утверждёнными. Перечитайте preparation_status или передайте только changeId`,
      409,
    );
  const others = boardChanges(s, b, except);
  if (b && others.length && !others.includes(request.changeId))
    throw new DomainError(
      `Доска ${b.id} ведёт изменение ${others.map((id) => changeKeyOf(s, id)).join(', ')}; задачи изменения ${changeKeyOf(s, request.changeId)} планируйте на его доске`,
      409,
    );
  return request.changeId;
}
/**
 * Привязка новой или правленой задачи: к названному изменению, иначе к
 * изменению по умолчанию (задачи, доски), иначе к активному. Привязка —
 * всегда действующие утверждённые digests изменения.
 */
function bindingFor(s: DevContourState, ...changeIds: (string | undefined)[]) {
  return developmentBinding(s, changeIds.find(Boolean));
}
/**
 * Следующий этап без changeId продолжает изменение доски. Если активно
 * другое изменение, ведущий мог иметь в виду его: ответ называет оба и путь
 * для активного — новую доску.
 */
function stageWarning(s: DevContourState, bound: string | undefined, named: string | undefined) {
  const active = s.preparation?.activeChangeId;
  if (!bound || named || !active || active === bound) return {};
  return {
    warning: `Этап привязан к изменению доски ${changeKeyOf(s, bound)}, а активно ${changeKeyOf(s, active)}. Работу изменения ${changeKeyOf(s, active)} планируйте на новой доске (plan_import без boardId)`,
  };
}
/**
 * Привязка замены в корректировке — к изменению оригинала. Если его
 * постановку открыли заново и разработка изменения не готова, замена
 * остаётся без привязки (как перенос задачи), и её привязывает правка
 * черновика ведущим: корректировка не отказывает целиком.
 */
function correctionBinding(s: DevContourState, original: Task) {
  try {
    return bindingFor(s, original.preparation?.changeId);
  } catch (error) {
    if (error instanceof DomainError) return undefined;
    throw error;
  }
}
/**
 * Принятая ревизия закрыта для задач, утверждения и приёмки. Отказ называет
 * оба законных пути: следующий этап того же релиза — импорт плана в эту же
 * доску (ревизия N+1), изменение принятого результата — корректировка.
 * Раньше отказ советовал только корректировку, и ведущий, добавлявший работу
 * следующего этапа, шёл не тем путём.
 */
function activeRevision(s: DevContourState, id: string) {
  const b = board(s, id);
  const r = b.revisions.at(-1)!;
  if (r.status !== 'active')
    throw new DomainError(
      `Ревизия ${r.number} доски ${b.id} принята. Новая работа релиза — следующий этап этой доски: plan_import с boardId (CLI: import-plan --board ${b.id}). Изменение принятого результата — корректировка: board_correct (CLI: correct --board ${b.id}).`,
    );
  return r;
}
/**
 * То, что ревьюер видел о зависимости вне предложения: постановка, статус,
 * гейты и принятый SHA. Гейты в specDigest не входят — они часть политики, —
 * но ревьюер их видел, и их смена меняет то, на что опирается план.
 */
export const dependencyDigest = (t: Task) =>
  digest({ spec: specDigest(t), status: t.status, gates: t.gates, resultSha: t.resultSha });
/** Смысловые данные задачи, показанной ревью плана как контекст. */
export const contextDigest = (t: Task) =>
  digest({
    spec: specDigest(t),
    gates: t.gates,
    resultSha: t.resultSha,
    cancelled: t.status === 'cancelled',
  });
/**
 * Задача принятой ревизии неизменяема: следующий этап и корректировка несут
 * её как принятую работу. Вернуть её в работу (reopen, retry) значило бы
 * переписать принятое и заново отменять уже учтённое — повторная отмена
 * такой задачи выглядела бы исторической, и workflow её не замечал. Работа
 * возвращается в этап новой задачей.
 */
function assertNotAccepted(s: DevContourState, t: Task) {
  for (const b of s.boards)
    for (const r of b.revisions)
      if (r.status === 'accepted' && r.taskIds.includes(t.id))
        throw new DomainError(
          `${t.id} входит в принятую ревизию ${r.number} доски «${b.title}»; верните работу в этап новой задачей`,
          409,
        );
}
/**
 * Digest фактически загруженной конфигурации: главный `config.json`,
 * component config каждого компонента и разрешённые пути. Им сверяются
 * перезакрепление, запрос применения и действующая конфигурация процесса —
 * digest одного главного файла не закреплял бы gates компонентов.
 */
export const loadedDigest = (config: Config) => digest(config);
/**
 * Digest каждого ключа верхнего уровня конфигурации. Запись применённой
 * конфигурации хранит только общий digest; по этим digest doctor называет,
 * какими ключами файл отличается от применённой (например, context-lock меняет
 * только `contextPacks`, а не бюджеты).
 */
export const configKeyDigests = (config: Config): Record<string, string> =>
  Object.fromEntries(
    Object.entries(config)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, digest(JSON.stringify(value))]),
  );
/** Локальная запись: digest ключей применённой конфигурации (`applied-config-keys` в `server`). */
export interface AppliedConfigKeys {
  digest: string;
  keys: Record<string, string>;
}
export const APPLIED_KEYS_NAMESPACE = 'server';
export const APPLIED_KEYS_KEY = 'applied-config-keys';
/**
 * Откуда конфигурация загружена: файлы (`config.json` и component config) —
 * путь в том виде, как его задали, разрешённая при загрузке цель и хэш именно
 * тех байтов, которые загрузчик разобрал, — и digest самой конфигурации в
 * момент загрузки. Ставит `loadConfig`; конфигурации, собранные в памяти,
 * источника не имеют.
 */
export type ConfigSourceFile = { path: string; real: string; sha: string; dir?: true };
export const configSources = new WeakMap<Config, { files: ConfigSourceFile[]; digest: string }>();
export const bytesDigest = (text: string) => createHash('sha256').update(text).digest('hex');
/**
 * Файлы, из которых загружена конфигурация, сейчас содержат ровно те байты,
 * что разобрал загрузчик. Сверяется содержимое, а не mtime и размер: их
 * сохраняют копирование и перезапись тем же размером.
 */
/**
 * Происхождение конфигурации процесса: источник, если объект при создании
 * процесса (или при `reconfigure`) совпадал со своим digest на момент
 * загрузки; иначе — причина, почему его нет. Фиксируется один раз: процесс
 * свою конфигурацию в памяти не меняет, а актуальность сверяется по digest,
 * снятому тогда же.
 */
function provenanceOf(config: Config): ConfigSource | string {
  const source = configSources.get(config);
  if (!source) return 'конфигурация собрана в памяти, источника нет';
  if (loadedDigest(config) !== source.digest)
    return 'конфигурация изменена в памяти после загрузки';
  return source;
}
type ConfigSource = { files: ConfigSourceFile[]; digest: string };
function sourceUnchanged(
  provenance: ConfigSource | string,
): { ok: true } | { ok: false; reason: string } {
  if (typeof provenance === 'string') return { ok: false, reason: provenance };
  for (const file of provenance.files) {
    try {
      // Путь разрешается заново: переключённый symlink ведёт к другому файлу.
      if (realpathSync(file.path) !== file.real)
        return { ok: false, reason: `путь ${file.path} теперь ведёт к другому файлу` };
      if (file.dir) continue;
      if (bytesDigest(readFileSync(file.real, 'utf8')) !== file.sha)
        return { ok: false, reason: `файл ${file.path} изменился после загрузки` };
    } catch (error) {
      return { ok: false, reason: `файл ${file.path} не читается: ${String(error)}` };
    }
  }
  return { ok: true };
}

/**
 * Gates профиля компонентов доски, не прошедшие integration ни в одной её
 * задаче. Задача, доказывающая себя всем профилем, покрывает его целиком;
 * пробел возникает, только когда задачи сузили область, — и тогда приёмка
 * доски его называет. Совместная проверка workspace к этому не относится: её
 * `workspaceGates` область задачи не сокращает.
 *
 * Wrapper без правил: правило покрытия — harness. DevContour выбирает только
 * evidence задачи под действующим договором (`taskEvidence`): успешной
 * попытки этого clone или receipt другого (для любой области: задача без
 * явной области выполнялась профилем своего времени, и gate, добавленный или
 * изменённый позже, ею не покрыт).
 */
export function uncoveredGates(
  h: DevContour,
  s: DevContourState,
  tasks: Task[],
  /** Проверка доски на её итоговом SHA (`boardCoverageWorks`): её evidence тоже покрывает. */
  extra: { repositoryId: string; resultSha: string; evidence: readonly Evidence[] }[] = [],
  /**
   * Объединённый diff доски для условных gates (`boardChanges`): от зелёного
   * SHA каждой записи `not-applicable` задач до итогового SHA компонента
   * (`finalShas`). Нет — пропущенный условный gate непокрыт (исполняется на
   * итоговом SHA): без diff его неприменимость к набору не доказана.
   */
  coverage?: BoardChanges,
) {
  const ids = [...new Set(tasks.map((t) => t.repositoryId))];
  // Gates — в форме политики harness: условный gate сверяется по digest
  // своего определения (`gateDigest`), а объект конфигурации DevContour несёт
  // свои умолчания и дал бы другой digest.
  // Политика, которую не выразить для harness, — прежние объекты конфигурации:
  // такая конфигурация не исполняется, но сводки по ней строятся.
  let policy: Map<string, ExecutionPolicy['repositories'][number]>;
  try {
    policy = new Map(executionOf(h).engine.policy.repositories.map((r) => [r.id, r]));
  } catch {
    policy = new Map();
  }
  const gaps = harnessUncoveredGates(
    ids.map((id) => ({
      id,
      gates: policy.get(id)?.gates ?? repository(h.config, id).gates,
      protectedPaths: policy.get(id)?.protectedPaths ?? repository(h.config, id).protectedPaths,
    })),
    tasks.map((t) => ({
      repositoryId: t.repositoryId,
      resultSha: t.resultSha,
      evidence: taskEvidence(s, t, h),
    })),
    coverage?.changes,
    coverage?.finalShas,
  );
  // Проверка доски исполнила gate на итоговом SHA — после всех изменений
  // набора: её PASS покрывает и условный gate, пропущенный задачами. Для
  // обычного gate это то же правило, что прежде (покрывает любая
  // собственная запись test фазы интеграции на итоговом SHA).
  const passed = (repositoryId: string, gate: string) =>
    extra.some(
      (w) =>
        w.repositoryId === repositoryId &&
        w.evidence.some(
          (e) =>
            e.kind === 'test' &&
            e.passed &&
            e.phase === 'integration' &&
            !e.consumer &&
            e.sha === w.resultSha &&
            e.gate === gate,
        ),
    );
  return gaps.flatMap((g) => {
    const gates = g.gates.filter((gate) => !passed(g.repositoryId, gate));
    return gates.length ? [{ repositoryId: g.repositoryId, gates }] : [];
  });
}
/** Объединённый diff доски для условных gates и итоговые SHA его конца. */
export interface BoardChanges {
  changes: Record<string, ChangedPaths>;
  finalShas: Record<string, string>;
}

/**
 * Записи `not-applicable` фазы интеграции на принятом SHA задач доски — те,
 * которые решает `uncoveredGates` harness; от их зелёного SHA строится
 * объединённый diff (`coverageChanges`).
 */
export function boardSkips(h: DevContour, s: DevContourState, tasks: Task[]) {
  return tasks.flatMap((t) =>
    taskEvidence(s, t, h)
      .filter(
        (e) =>
          e.kind === 'not-applicable' &&
          e.phase === 'integration' &&
          !e.consumer &&
          e.sha === t.resultSha,
      )
      .map((e) => ({ repositoryId: t.repositoryId, evidence: e })),
  );
}

/**
 * Прогноз (только предупреждение): gates профиля, которых нет в области ни
 * одной задачи доски, — по постановкам, до исполнения. Решающее правило
 * приёмки — `uncoveredGates` по записанному evidence: прогноз не учитывает,
 * например, смену политики после исполнения. То же правило, что у приёмки: задача без
 * области покрывает весь профиль своего компонента, отменённая не покрывает
 * ничего. Такие gates приёмка доски выполнит один раз на итоговом SHA доски
 * (`acceptBoard`), поэтому пробел — предупреждение, а не отказ.
 */
export function scopeGaps(h: DevContour, tasks: Pick<Task, 'repositoryId' | 'gates' | 'status'>[]) {
  const live = tasks.filter((t) => t.status !== 'cancelled');
  return [...new Set(live.map((t) => t.repositoryId))].flatMap((id) => {
    const repo = repository(h.config, id);
    const scopes = live.filter((t) => t.repositoryId === id).map((t) => expandGates(repo, t.gates));
    const covered = new Set(scopes.flat());
    const gates = repo.gates.map((g) => g.id).filter((g) => !covered.has(g));
    if (!gates.length) return [];
    // Проверка доски исполнит каждый gate с предпосылками, которые выводит
    // из профиля harness (`gatePrerequisites`): `dependsOn` или более ранние
    // check gates. Если задачи опирались на check gates своей области, а
    // gate проверки доски не получит ни одной предпосылки и prepare у
    // компонента нет, — проверка, скорее всего, упадёт на окружении.
    const prerequisites = standaloneScope(repo.gates, gates).filter((g) => !gates.includes(g));
    const checks = new Set(repo.gates.filter((g) => g.kind === 'check').map((g) => g.id));
    const tasksUseSetup = scopes.some((scope) => scope.some((g) => checks.has(g)));
    const withoutSetup =
      tasksUseSetup && !(repo.prepare ?? []).length
        ? gates.filter((g) => !gatePrerequisites(repo.gates, g).length)
        : [];
    return [
      {
        repositoryId: id,
        gates,
        ...(prerequisites.length ? { prerequisites } : {}),
        ...(withoutSetup.length ? { withoutSetup } : {}),
      },
    ];
  });
}
/** Предупреждение о пробеле областей с исправлением, или undefined. */
export function scopeGapWarning(
  gaps: {
    repositoryId: string;
    gates: string[];
    prerequisites?: string[];
    withoutSetup?: string[];
  }[],
) {
  if (!gaps.length) return undefined;
  const setup = gaps.filter((g) => g.withoutSetup?.length);
  return (
    'Области задач доски не включают gates: ' +
    gaps
      .map(
        (g) =>
          `${g.repositoryId}: ${g.gates.join(', ')}` +
          (g.prerequisites?.length ? ` (с предпосылками ${g.prerequisites.join(', ')})` : ''),
      )
      .join('; ') +
    '. Приёмка доски выполнит их один раз на итоговом integration SHA доски и примет её, только если они пройдут. ' +
    'Чтобы их провал находила задача, а не приёмка, включите их в область (gates) задачи, которая меняет проверяемый ими код.' +
    (setup.length
      ? ' Без подготовки окружения: ' +
        setup.map((g) => `${g.repositoryId}: ${g.withoutSetup!.join(', ')}`).join('; ') +
        ' — проверка доски не получит ни одной предпосылки (нет dependsOn, более ранних check gates и prepare), хотя задачи опирались на check gates своей области. Добавьте dependsOn или prepare компонента.'
      : '')
  );
}

/** Проверка доски на её итоговом SHA: gates, не исполненные ни одной задачей. */
export interface BoardCoverage {
  boardId: string;
  revision: number;
  repositoryId: string;
  sha: string;
  /** Договор компонента, под которым шла проверка (`policyDigest`). */
  policyDigest: string;
  /** Ревизия доски, для которой шла проверка (digest, как у приёмки). */
  revisionDigest: string;
  runId: string;
  gates: string[];
  evidence: Evidence[];
  failure?: { gate: string; message: string };
  /** Все непрошедшие gates проверки (`failure` — первый из них). */
  failures?: { gate: string; message: string }[];
  at: string;
}
export const BOARD_COVERAGE = 'board-coverage';
export const boardCoverageKey = (boardId: string, revision: number) => `${boardId}:${revision}`;
/**
 * Evidence проверок доски, которое покрывает её приёмку: запись этой ревизии
 * (тот же digest) на итоговом SHA компонента и под действующим договором
 * компонента. Другой SHA, другой договор или изменённая ревизия — не
 * покрытие.
 */
export function boardCoverageWorks(
  h: DevContour,
  boardId: string,
  revision: { number: number },
  heads: Record<string, string>,
) {
  return Object.entries(heads).flatMap(([repositoryId, sha]) => {
    const record = h.store.localRecord<BoardCoverage>(
      BOARD_COVERAGE,
      repositoryId,
      boardCoverageKey(boardId, revision.number),
    );
    return record &&
      record.sha === sha &&
      record.policyDigest === h.policyDigest(repositoryId) &&
      record.revisionDigest === digest(revision)
      ? [{ repositoryId, resultSha: sha, evidence: record.evidence }]
      : [];
  });
}

/**
 * Размер receipt принятого результата. Попытка, receipt которой не строится
 * (прежняя без восстановимой policy), здесь не отклоняется: это ограничение
 * переноса, а не приёмки.
 */
export function receiptBytes(h: DevContour, s: DevContourState, t: Task) {
  let receipt;
  try {
    receipt = completion(h, s, t);
  } catch {
    return 0;
  }
  return receiptRecordBytes(receipt);
}
/**
 * Ожидание проверки перенесённой базы. Перенос поверх ещё не проверенного
 * сохраняет первую непроверенную базу компонента (`from`): автоматическая
 * проверка сверяет чувствительные пути всего непроверенного диапазона, а не
 * только последнего шага.
 */
/**
 * Непроверенный диапазон текущего ожидания `base-check`: только записанный
 * для этого ожидания (то же время постановки). Нет ожидания или диапазон от
 * другого — `undefined`.
 */
export function baseMovesOf(s: Readonly<DevContourState>) {
  const wait = s.waits?.find((w) => w.kind === 'base-check');
  return wait && s.baseMoves?.at === wait.at ? s.baseMoves.bases : undefined;
}
export function waitBaseCheck(s: DevContourState, updated: BaseMove[], detail: string) {
  // Диапазон копится только поверх ещё стоящего ожидания: снятое ожидание
  // (проверка прошла, queue --start) оставляет прежний диапазон в прошлом.
  const at = now();
  const previous = baseMovesOf(s) ?? [];
  const bases = [
    ...previous.filter((p) => !updated.some((u) => u.repositoryId === p.repositoryId)),
    ...updated.map((u) => ({
      repositoryId: u.repositoryId,
      from: previous.find((p) => p.repositoryId === u.repositoryId)?.from ?? u.from,
      to: u.to,
    })),
  ];
  s.baseMoves = { at, bases };
  s.waits = [
    ...(s.waits ?? []).filter((w) => w.kind !== 'base-check'),
    { kind: 'base-check', detail, at },
  ];
}
/** Путь поля плана для отказа: `tasks[2].gates`. */
function planPath(path: PropertyKey[]) {
  return (
    path.map((p, i) => (typeof p === 'number' ? `[${p}]` : (i ? '.' : '') + String(p))).join('') ||
    'план'
  );
}
export class DevContour {
  constructor(
    readonly store: Store,
    /** Меняется только `reconfigure` — шагом операции, после drain. */
    public config: Config,
  ) {
    validateWorkflow(config);
    this.knownConfig = loadedDigest(config);
    this.provenance = provenanceOf(config);
  }
  /**
   * Применённая конфигурация в базе — единственный источник правды; у
   * процесса нет своего «поколения», которое мог бы рассинхронизировать
   * откат транзакции. Процесс текущий, только если его конфигурация совпадает
   * с применённой. Записать свою вместо применённой (перезапуск, CLI после
   * правки файла, когда сервера нет) он может, только если нет живого чужого
   * лидера и его файлы не менялись с загрузки — возврат файла к прежнему
   * содержимому тоже меняет mtime. Конфигурация без источника этого права не
   * имеет. Ошибка чтения файла не запоминается: следующая проверка повторит её.
   */
  private knownConfig: string;
  private provenance: ConfigSource | string;
  /** Digest конфигурации этого процесса. */
  get configDigest() {
    return this.knownConfig;
  }
  /** Источник конфигурации не менялся с загрузки: `undefined` — да, иначе причина. */
  configProvenance(): string | undefined {
    const unchanged = sourceUnchanged(this.provenance);
    return unchanged.ok ? undefined : unchanged.reason;
  }
  /**
   * Процесс работает не с применённой конфигурацией и сменить её не вправе.
   * Правило — движка harness (`policyState().stale`): живой чужой controller,
   * изменённый источник или применённое после запуска поколение.
   */
  configStale() {
    const { engine } = executionOf(this);
    return !!engine.policyState().stale;
  }
  /**
   * Транзакция прикладного слоя под барьером применённой конфигурации: процесс
   * сверяет свою конфигурацию с применённой в той же записи (правило движка);
   * первый законный после правки файла процесс делает свою применённой — откат
   * отменит и это. Продуктовые поля меняются в документе транзакции.
   */
  /**
   * Барьер применённой конфигурации отдельной записью: отставший процесс
   * получает отказ; законный после правки файла — делает свою применённой.
   */
  assertCurrentConfig() {
    this.currentChange('config.checked', () => undefined);
  }
  currentChange<T>(kind: string, action: (state: DevContourState) => T): T {
    const { store, engine } = executionOf(this);
    return domain(() =>
      store.host(kind, (ht) => {
        engine.assertCurrentPolicy(ht.tx);
        const result = action(ht.state);
        if (result !== undefined)
          ht.journal(
            result && typeof result === 'object' && !Array.isArray(result)
              ? (result as Record<string, unknown>)
              : { result },
          );
        return result;
      }),
    );
  }
  /**
   * Применить новую конфигурацию в этом процессе. Только шаг операции
   * изменения контракта: она сверила digest, дождалась окончания работ и
   * держит паузу. Отличаться может только закрепление context packs — всё
   * остальное требует перезапуска процесса.
   *
   * `keys` — запрос `config-apply` эксплуатационных пределов: тогда
   * отличаться могут только названные ключи (`operationalKeys`), а
   * закрепление пакетов — нет.
   */
  reconfigure(next: Config, keys?: readonly ApplyKey[]) {
    // Без перезапуска меняется только закрепление пакетов — их revision и
    // digest. Состав пакетов, их роли, файлы и версии — другая конфигурация.
    // `models` — только runtime, модель и effort привязок: прочие поля ролей
    // (области записи, профили инструментов, правила вендора) — нет.
    const rest = (c: Config) =>
      keys
        ? digest({
            ...(keys.includes('models') ? withoutModels(c) : c),
            ...Object.fromEntries(keys.filter((k) => k !== 'models').map((k) => [k, undefined])),
          })
        : digest({
            ...c,
            contextPacks: c.contextPacks.map((pack) => ({
              ...pack,
              revision: undefined,
              digest: undefined,
            })),
          });
    if (rest(next) !== rest(this.config))
      throw new DomainError(
        keys
          ? `config.json отличается от действующей конфигурации не только ${keys.join(', ')}: примените правку перезапуском сервера или верните прочие ключи`
          : 'Новая конфигурация отличается не только закреплением context packs (revision и digest): примените её перезапуском сервера',
        409,
      );
    validateWorkflow(next);
    this.config = next;
    this.knownConfig = loadedDigest(next);
    this.provenance = provenanceOf(next);
  }
  /** Пауза операции (правило движка): только если очередь не остановлена; пауза человека не перезаписывается. */
  operationPause(operation: string) {
    const { engine } = executionOf(this);
    return domain(() => engine.operationPause(operation))
      ? { paused: true, reason: 'reconfigure', operation }
      : undefined;
  }
  /** Снять паузу операции — только свою; паузу человека она не трогает. */
  operationResume(operation: string) {
    const { engine } = executionOf(this);
    return domain(() => engine.operationResume(operation))
      ? { paused: false, operation }
      : undefined;
  }
  /**
   * Запросить применение конфигурации с ожидаемым digest (идемпотентно).
   * Повтор той же операцией сбрасывает прежний отказ: файл могли исправить.
   */
  requestReconfigure(operation: string, configDigest: string) {
    const { engine } = executionOf(this);
    const r = domain(() => engine.requestReconfigure(operation, configDigest));
    if (!r.changed) return undefined;
    return { operation, digest: configDigest, ...(r.retried ? { retried: true } : {}) };
  }
  /**
   * Подтвердить применение (процесс уже работает с ожидаемой конфигурацией)
   * или записать отказ с причиной. Применение — правило движка: только при
   * совпадающем digest и без работ под прежней конфигурацией.
   */
  settleReconfigure(operation: string, configDigest: string, by: string, error?: string) {
    const { engine } = executionOf(this);
    if (error) {
      const rejected = domain(() => engine.rejectReconfigure(operation, configDigest, error));
      return rejected ? { operation, digest: configDigest, error } : undefined;
    }
    const request = engine.policyState().reconfigure;
    if (!request || request.operation !== operation || request.digest !== configDigest)
      return undefined;
    const applied = domain(() => engine.applyReconfigure(by));
    return applied.status === 'applied' ? { operation, digest: configDigest, by } : undefined;
  }
  /**
   * Запуск процесса применяет его конфигурацию: перезапуск — штатный способ
   * сменить любые поля. Только действующий controller; неприменённый запрос
   * операции остаётся (правило движка).
   */
  recordConfig(by: string) {
    const { engine } = executionOf(this);
    domain(() => engine.recordPolicy(by));
  }
  /**
   * Запомнить digest ключей конфигурации процесса, когда она стала
   * применённой: без этой записи doctor знает только общий digest и не
   * отличает правку бюджетов от перезакрепления контекста.
   */
  noteAppliedKeys() {
    const applied = this.store.view().appliedConfig;
    if (applied?.digest !== this.configDigest) return;
    const recorded = this.store.localRecord<AppliedConfigKeys>(
      APPLIED_KEYS_NAMESPACE,
      undefined,
      APPLIED_KEYS_KEY,
    );
    if (recorded?.digest === applied.digest) return;
    this.store.atomic(() =>
      this.store.saveLocal(APPLIED_KEYS_NAMESPACE, undefined, APPLIED_KEYS_KEY, {
        digest: applied.digest,
        keys: configKeyDigests(this.config),
      } satisfies AppliedConfigKeys),
    );
  }
  /** Digest политики исполнения этой конфигурации — то, с чем сверяется утверждение плана. */
  planPolicyDigest() {
    return approvalPolicyDigest(this.config);
  }
  /**
   * Утверждение плана задачи дано при другой политике исполнения. Такую
   * задачу движок не выдаёт (граф проецируется с закреплённым digest), пока
   * план не утверждён заново (review-plan). Утверждение прежней версии без
   * закрепления считается данным при текущей политике.
   */
  approvalStale(t: Task, policy = this.planPolicyDigest()) {
    return (
      !['draft', 'done', 'cancelled'].includes(t.status) &&
      !!t.approvedDigest &&
      !!t.approvedPolicy &&
      t.approvedPolicy !== policy
    );
  }
  /**
   * Утверждения прежних версий (без `approvedPolicy`) закрепляются за текущей
   * политикой: первый такт controller после обновления, а не повторное
   * утверждение всех планов. Пишет, только если такие задачи есть.
   */
  pinLegacyApprovals() {
    const open = (t: Task) =>
      !!t.approvedDigest && !t.approvedPolicy && !['draft', 'done', 'cancelled'].includes(t.status);
    if (!this.store.view().tasks.some(open)) return [];
    const policy = this.planPolicyDigest();
    return this.currentChange('approval.policy-pinned', (s) => {
      const pinned = s.tasks.filter(open);
      for (const t of pinned) t.approvedPolicy = policy;
      return pinned.length ? { tasks: pinned.map((t) => t.id) } : undefined;
    });
  }
  /** Снять завершённый запрос операции. */
  clearReconfigure(operation: string) {
    const { engine } = executionOf(this);
    return domain(() => engine.clearReconfigure(operation)) ? { operation } : undefined;
  }
  /**
   * Договор исполнения задачи. Изоляция входит в него: смена режима или
   * доменов посреди прогона — другие условия, и прежнее evidence не должно
   * выглядеть полученным в новых. `legacy` — тот же договор без изоляции,
   * как его считала прежняя версия; он нужен только чтобы восстановить
   * receipt уже завершённой задачи, не выдавая её за исполненную в песочнице.
   */
  /**
   * Договор исполнения попытки задачи: политика её компонента и, если задача
   * называет потребителей, политика каждого из них с раскрытым составом его
   * проверок. Смена команды или группы потребителя делает прежнюю попытку
   * устаревшей так же, как смена собственной.
   */
  taskPolicyDigest(t: Pick<Task, 'repositoryId' | 'consumers'>): string {
    // Без потребителей договор задачи — сама политика компонента.
    const input = this.taskPolicyInput(t, digest);
    return t.consumers?.length ? digest(input) : (input as string);
  }
  /**
   * Содержимое договора задачи, из которого считается taskPolicyDigest.
   * `policy` задаёт, чем представлена политика компонента: digest (формула
   * договора) или сама запись (тождество проверок receipt — тот же договор
   * без потери полей).
   */
  taskPolicyInput(
    t: Pick<Task, 'repositoryId' | 'consumers'>,
    policy: (input: Record<string, unknown>) => unknown = (x) => x,
  ): unknown {
    const own = policy(this.policyInput(t.repositoryId));
    if (!t.consumers?.length) return own;
    return {
      own,
      consumers: t.consumers.map((c) => ({
        repositoryId: c.repositoryId,
        policy: policy(this.policyInput(c.repositoryId)),
        gates: expandGates(repository(this.config, c.repositoryId), c.gates),
      })),
    };
  }
  /** Receipt задачи из другого clone подтверждает её при текущей конфигурации. */
  receiptHolds(s: DevContourState, t: Task) {
    return receiptHolds(this, s, t);
  }
  policyDigest(repositoryId = 'main', legacy = false) {
    return digest(this.policyInput(repositoryId, legacy));
  }
  /** Запись политики компонента, digest которой — policyDigest. */
  policyInput(repositoryId = 'main', legacy = false): Record<string, unknown> {
    const repo = repository(this.config, repositoryId);
    return {
      ...(legacy ? {} : { isolation: this.config.isolation }),
      ...(this.config.repositories.length
        ? { repositoryId, path: repo.path, targetBranch: repo.targetBranch }
        : {}),
      gates: repo.gates,
      // Определение групп входит в договор: изменённая группа — другой набор
      // проверок задачи, даже если её область не менялась.
      ...(repo.gateGroups ? { gateGroups: repo.gateGroups } : {}),
      execution: {
        environment: this.config.environment,
        toolProfiles: this.config.toolProfiles,
        lifecycle: repo.lifecycle,
        prepare: repo.prepare,
        repositoryEnvironment: repo.environment,
      },
      dependencies: repositories(this.config).map(
        ({
          id,
          path,
          targetBranch,
          dependsOn,
          dependencyBuild,
          dependencyArtifacts,
          environment,
        }) => ({
          id,
          path,
          targetBranch,
          dependsOn,
          dependencyBuild,
          dependencyArtifacts,
          environment,
        }),
      ),
      memoryPolicy: this.config.memoryPolicy,
      protectedPaths: repo.protectedPaths,
      roles: { ...this.config.roles, ...repo.roles },
      repositoryReviewer: repo.reviewer,
      reviewer: this.config.reviewer,
      mode: this.config.mode,
      ...(this.config.contextPacks.length ? { contextPacks: this.config.contextPacks } : {}),
      ...(this.config.resources.length
        ? { resources: this.config.resources, resourceDatabase: this.config.resourceDatabase }
        : {}),
      ...(repo.generatedPaths?.length ? { generatedPaths: repo.generatedPaths } : {}),
    };
  }
  /**
   * План без доски открывает новую доску. План с доской — следующий этап её
   * работы: ревизия N+1 принятой доски. Раньше каждая порция работы одного
   * релиза заводила свою доску, и наблюдатель видел россыпь «частей 1»,
   * похожих на параллельные потоки. Этап несёт прежние задачи, как и
   * корректировка: последняя ревизия — весь состав доски, её приёмка
   * проверяет и прежние результаты. Цель этапа хранится в причине ревизии.
   */
  importPlan(
    input: unknown,
    boardId?: string,
    changeId?: string,
  ): {
    boardId: string;
    revision?: number;
    tasks: number;
    changeId?: string;
    warning?: string;
  } {
    // Отказ схемы плана — по путям и сообщениям, а не сырым массивом zod:
    // ведущий исправляет план по названному полю.
    const parsedPlan = planIngest.safeParse(input);
    if (!parsedPlan.success)
      throw new DomainError(
        'План не принят: ' +
          parsedPlan.error.issues
            .slice(0, 10)
            .map((i) => `${planPath(i.path)}: ${i.message}`)
            .join('; '),
        400,
      );
    const plan = parsedPlan.data;
    const stage = boardId ? `Следующий этап: ${plan.title}\n\n${plan.description}`.trim() : '';
    if (stage.length > 5000)
      throw new DomainError('Цель этапа: название и описание вместе до 5000 символов', 400);
    return this.store.change('plan.imported', (s) => {
      const target = boardId ? board(s, boardId) : undefined;
      const previous = target?.revisions.at(-1);
      if (previous && previous.status !== 'accepted')
        throw new DomainError(
          'Следующий этап открывается после приёмки текущей ревизии; до неё добавляйте задачи в неё',
          409,
        );
      // Структура плана — общая проверка harness (`draftIssues`): повтор ключа,
      // неизвестная зависимость, цикл внутри плана. Хост сохраняет прежний
      // порядок и статусы отказов: повтор ключа — раньше всего (400),
      // неизвестная зависимость — у своей задачи до её проверок (404), цикл —
      // после проверок всех задач, тем же отказом, что у графа состояния.
      const issues = draftIssues(plan, { known: s.tasks.map((t) => t.id) });
      const at = (code: CodedIssue['code'], task?: number) =>
        issues.find((i) => i.code === code && (task === undefined || i.path[1] === task));
      if (at('GRAPH_DUPLICATE_ID')) throw new DomainError('Ключи задач должны быть уникальны', 400);
      const ids = new Map<string, string>();
      for (const t of plan.tasks) ids.set(t.key, entityId(s, 'T'));
      const named = requestedChange(s, changeId ? { changeId } : undefined, target);
      const preparation = s.preparation
        ? bindingFor(s, named, boardChangeId(s, target))
        : undefined;
      const tasks = plan.tasks.map((item, i) => {
        const unknown = at('GRAPH_UNKNOWN_DEPENDENCY', i);
        if (unknown) throw new DomainError(unknown.message, 404);
        const parsed = taskInput.parse({
          ...item,
          dependsOn: item.dependsOn.map((key) => ids.get(key) ?? key),
        });
        repository(this.config, parsed.repositoryId);
        validateTaskContext(this.config, parsed);
        // Путь вне области роли — как у task_create (F15): план — главный
        // путь создания задач ведущим.
        this.assertWithinRole(parsed, [], `Задача плана ${item.key}`);
        const owner = target && boardOwner(target, s);
        if (owner && (parsed.repositoryId !== owner || parsed.scope === 'workspace'))
          throw new DomainError('Локальная доска принимает только задачи своего компонента');
        return {
          ...parsed,
          preparation,
          assignee: parsed.assignee ?? s.team?.member,
          id: ids.get(item.key)!,
          status: 'draft' as const,
          attempt: 0,
          createdAt: now(),
          contractDigests: {},
        };
      });
      s.tasks.push(...tasks);
      // Цикл плана называется задачами состояния, как у любого цикла графа.
      const cycle = at('GRAPH_CYCLE');
      if (cycle) {
        assertDag(s.tasks);
        throw new DomainError(cycle.message);
      }
      assertDag(s.tasks);
      if (target && previous) {
        const revision = {
          number: previous.number + 1,
          status: 'active' as const,
          reason: stage,
          taskIds: [...previous.taskIds, ...tasks.map((t) => t.id)],
          createdAt: now(),
        };
        target.revisions.push(revision);
        return {
          boardId: target.id,
          revision: revision.number,
          tasks: tasks.length,
          ...(preparation ? { changeId: preparation.changeId } : {}),
          ...stageWarning(s, preparation?.changeId, named),
        };
      }
      const b = {
        id: entityId(s, 'B'),
        title: plan.title,
        description: plan.description,
        revisions: [
          {
            number: 1,
            status: 'active' as const,
            reason: 'Утверждение предложенного плана',
            taskIds: tasks.map((t) => t.id),
            createdAt: now(),
          },
        ],
      };
      s.boards.push(b);
      return {
        boardId: b.id,
        tasks: tasks.length,
        ...(preparation ? { changeId: preparation.changeId } : {}),
      };
    });
  }
  /**
   * Название и цель доски правятся, пока её план не утверждён. Цель входит в
   * предложение, которое читает ревью плана: сузив план, ведущий обязан
   * сузить и обещание доски, а до этой правки её приходилось пересоздавать.
   * После утверждения цель — часть согласованного, и меняет её корректировка.
   * Между этапами, когда текущая ревизия принята, доска снова свободна: она
   * ведёт релиз, а цель следующего этапа ревью прочтёт уже в новой редакции.
   * Принятые снимки названия не хранят и от правки не меняются.
   */
  editBoard(id: string, input: { title?: string; description?: string }) {
    return this.store.change('board.edited', (s) => {
      const b = requireValue(
        s.boards.find((x) => x.id === id),
        'Доска не найдена',
      );
      const r = b.revisions.at(-1)!;
      const approved = s.tasks.filter(
        (t) => r.taskIds.includes(t.id) && t.status !== 'draft' && t.status !== 'cancelled',
      );
      if (r.status === 'active' && approved.length)
        throw new DomainError(
          'Цель доски меняется до утверждения плана или после приёмки ревизии',
          409,
        );
      const title = input.title?.trim() ?? b.title;
      if (title.length < 3 || title.length > 180)
        throw new DomainError('Название: от 3 до 180 символов', 400);
      b.title = title;
      if (input.description !== undefined) b.description = input.description;
      return { boardId: id, title: b.title, description: b.description };
    });
  }
  createBoard(title: string, description = '', repositoryId?: string) {
    if (repositoryId) repository(this.config, repositoryId);
    if (title.trim().length < 3 || title.length > 180)
      throw new DomainError('Название: от 3 до 180 символов', 400);
    return this.store.change('board.created', (s) => {
      const b = {
        id: entityId(s, 'B'),
        repositoryId,
        title: title.trim(),
        description,
        revisions: [
          {
            number: 1,
            status: 'active' as const,
            reason: 'Первый цикл',
            taskIds: [],
            createdAt: now(),
          },
        ],
      };
      s.boards.push(b);
      return b;
    });
  }
  addTask(boardId: string, input: unknown) {
    const parsed = taskIngest.parse(input);
    repository(this.config, parsed.repositoryId);
    validateTaskContext(this.config, { ...parsed, preparation: undefined });
    this.assertWithinRole(parsed);
    return this.store.change('task.created', (s) => {
      const r = activeRevision(s, boardId);
      const owner = board(s, boardId).repositoryId;
      if (owner && (parsed.repositoryId !== owner || parsed.scope === 'workspace'))
        throw new DomainError('Локальная доска принимает только задачи своего компонента');
      const t: Task = {
        ...parsed,
        preparation: bindingFor(
          s,
          requestedChange(s, parsed.preparation, board(s, boardId)),
          boardChangeId(s, board(s, boardId)),
        ),
        assignee: parsed.assignee ?? s.team?.member,
        id: entityId(s, 'T'),
        status: 'draft',
        attempt: 0,
        createdAt: now(),
        contractDigests: {},
      };
      s.tasks.push(t);
      assertDag(s.tasks);
      r.taskIds.push(t.id);
      return t;
    });
  }
  /**
   * Добавленные пути области записи задачи должны лежать в области её роли
   * (F15): путь вне неё исполнитель не вправе изменить, и задача тратила бы
   * попытки на отказ по области. Отказ называет роль, которой путь
   * принадлежит, — нужна отдельная задача этой роли. `kept` — пути прежней
   * постановки той же роли, которые правка не трогает.
   */
  private assertWithinRole(
    task: Pick<TaskInput, 'role' | 'repositoryId' | 'writePaths'>,
    kept: string[] = [],
    label = 'Область записи задачи',
  ) {
    const added = outsideRoleScope(this.config, task).filter((p) => !kept.includes(p));
    if (added.length)
      throw new DomainError(label + ': ' + roleScopeAdvice(this.config, task, added), 400);
  }
  editTask(id: string, input: unknown, expectedDigest: string) {
    const parsed = taskIngest.parse(input);
    repository(this.config, parsed.repositoryId);
    validateTaskContext(this.config, { ...parsed, preparation: undefined });
    return this.store.change('task.edited', (s) => {
      const t = task(s, id);
      if (t.status !== 'draft')
        throw new DomainError(
          'Изменять можно только черновик. Для принятой задачи создайте корректировку.',
        );
      if (specDigest(t) !== expectedDigest)
        throw new DomainError('Задача изменилась. Обновите страницу.');
      // Новые пути — только в области роли; прежние (записанные до этого
      // правила или до сужения роли) правка не отвергает.
      this.assertWithinRole(parsed, t.role === parsed.role ? t.writePaths : undefined);
      const ownerBoard = s.boards.find((b) => b.revisions.some((r) => r.taskIds.includes(t.id)));
      if (
        ownerBoard?.repositoryId &&
        (parsed.repositoryId !== ownerBoard.repositoryId || parsed.scope === 'workspace')
      )
        throw new DomainError('Локальная доска принимает только задачи своего компонента');
      // Отметка правки — только при изменённой постановке: правка без
      // изменений не вносит изменения и не принимает обращение к черновику
      // (`discussion_resolve`). Перепривязка к подготовке правкой не считается.
      const unbound = (x: Task) => specDigest({ ...x, preparation: undefined });
      const before = unbound(t);
      // Правка с preparation перепривязывает к названному изменению; без неё
      // задача остаётся в своём изменении (его действующие digests).
      Object.assign(t, parsed, {
        preparation: bindingFor(
          s,
          requestedChange(s, parsed.preparation, ownerBoard, t.id),
          t.preparation?.changeId,
          boardChangeId(s, ownerBoard, t.id),
        ),
      });
      if (unbound(t) !== before) t.specEditedAt = now();
      // Правка черновика находки — разбор ведущим: подсказка передачи
      // контекста больше не держит её как непроверенную.
      if (t.finding) t.triagedAt ??= now();
      // Корпус договора, которого задача больше не касается, не переносится.
      if (t.checkVersion && !t.contracts.includes(t.checkVersion.suite.replace(/^KS-/, '')))
        t.checkVersion = undefined;
      assertDag(s.tasks);
      return t;
    });
  }
  contract(
    title: string,
    content: string,
    approval: Approval = { actor: 'operator' },
    repositoryId?: string,
    source?: string,
    artifacts?: ContractArtifact[],
    checks?: CheckDeclaration,
    underTest?: string[],
    /** Консолидация последней редакции того же документа (`Contract.consolidates`). */
    consolidates?: { from: string; review: string },
  ) {
    if (repositoryId) repository(this.config, repositoryId);
    if (underTest?.length && !artifacts?.length)
      throw new DomainError(
        'underTest без artifacts: реализацию под тестом объявляют для закреплённой приёмки',
        400,
      );
    if (!title.trim() || !content.trim() || content.length > CONTRACT_CONTENT_MAX)
      throw new DomainError('Укажите название и содержимое контракта (до 60 000 символов)', 400);
    return this.store.change('contract.approved', (s) => {
      // Консолидация относится к действующей редакции документа и меняет
      // только текст: иначе задачи прежней редакции сохранили бы привязку к
      // другому договору.
      const previous = source ? latestRedaction(s.contracts, source, repositoryId)?.id : undefined;
      if (consolidates) {
        const from = source ? latestRedaction(s.contracts, source, repositoryId) : undefined;
        if (!from || from.id !== consolidates.from)
          throw new DomainError(
            `Консолидация относится к действующей редакции ${source ?? title}: ${from?.id ?? 'её нет'}, а не ${consolidates.from}`,
            409,
          );
        if (!sameObligations(from, artifacts ?? [], checks, underTest))
          throw new DomainError(
            'Консолидация меняет только текст: artifacts, checks и underTest должны совпадать с действующей редакцией',
            400,
          );
      }
      const c = {
        id: entityId(s, 'C'),
        repositoryId,
        title,
        content,
        source,
        ...(artifacts?.length ? { artifacts, pinVersion: 2 as const } : {}),
        ...(checks ? { checks } : {}),
        ...(underTest?.length ? { underTest } : {}),
        digest: contractDigest(
          content,
          artifacts,
          artifacts?.length ? 2 : undefined,
          checks,
          underTest,
        ),
        ...(consolidates ? { consolidates } : {}),
        ...(previous ? { previous } : {}),
        approvedAt: now(),
        approval,
      };
      s.contracts.push(c);
      return c;
    });
  }
  /**
   * Предусловия утверждения черновика; возвращает закреплённые digests его
   * контрактов. Ревью плана вызывает их до модели: иначе ревью тратилось и
   * одобряло план, который утверждение затем отвергало — например, из-за
   * контракта, заменённого новой редакцией того же файла.
   */
  approvable(s: DevContourState, t: Task): Record<string, string> {
    assertTaskPreparation(s, t);
    assertTaskFeature(s, t);
    validateTaskContext(this.config, t);
    if (requiresContract(this.config, t.role, t.repositoryId) && !t.contracts.length)
      throw new DomainError(`${t.id}: для ${t.role} сначала привяжите утверждённый контракт`);
    // Область задачи — раскрытый список: свойство может проверяться gate из группы.
    const repo = repository(this.config, t.repositoryId);
    assertTaskProperties(
      { ...t, gates: t.gates && expandGates(repo, t.gates) },
      s.contracts,
      repo.gates,
    );
    return Object.fromEntries(
      t.contracts.map((id) => {
        const c = requireValue(
          s.contracts.find((c) => c.id === id),
          `Контракт ${id} не утверждён`,
        );
        if (c.repositoryId && c.repositoryId !== t.repositoryId)
          throw new DomainError('Для межпроектного интерфейса нужен общий контракт');
        const newer = supersededBy(s.contracts, id);
        if (newer)
          throw new DomainError(
            `${t.id}: контракт ${id} заменён редакцией ${newer.id} того же файла ${newer.source}; привяжите её`,
          );
        return [id, c.digest];
      }),
    );
  }
  /**
   * Задача, ссылающаяся на подробный REQ из критериев истории, обязана нести
   * и связь с самой историей (`REQ-intent-<story>`) текущего digest. Карту
   * читает внедрённая проверка runner; без карты компонента — ничего, а
   * карта, которую не прочитать, — отказ.
   */
  assertStoryBindings(tasks: Task[]) {
    if (tasks.length) storyGuard(this).assertStoryBindings(tasks);
  }
  approve(
    boardId: string,
    taskIds?: string[],
    approval: Approval = { actor: 'operator' },
    expected?: {
      revision: number;
      taskIds: string[];
      tasks: Record<string, string>;
      reason?: string;
      /** Зависимости, показанные ревьюеру вне предложения: digest постановки и статус. */
      dependencies?: Record<string, string>;
      /** Задачи ревизии, показанные ревьюеру как контекст и не утверждаемые им. */
      context?: Record<string, string>;
      /** Политика исполнения по компонентам на момент ревью. */
      policies?: Record<string, string>;
      /** Область проверок утверждаемых задач (gates, потребители) на момент ревью. */
      scopes?: Record<string, string>;
      /** Digest политики исполнения, при которой ревьюер читал план. */
      execution?: string;
    },
  ) {
    const policy = this.planPolicyDigest();
    // Карты INTENT читаются до транзакции записи: Git не держит её открытой.
    // Внутри — только сравнение черновиков с прочитанными картами.
    const before = this.store.read();
    const revision = before.boards.find((b) => b.id === boardId)?.revisions.at(-1);
    const storyCheck = storyGuard(this).prepareStoryBindings(
      before.tasks.filter((t) => revision?.taskIds.includes(t.id) && t.status === 'draft'),
    );
    return this.currentChange('board.approved', (s) => {
      // Привязку каждой задачи к её изменению проверяет approvable.
      assertAnyDevelopmentReady(s);
      const r = activeRevision(s, boardId);
      if (!r.taskIds.length) throw new DomainError('Добавьте задачи перед утверждением');
      const selected = taskIds ?? r.taskIds;
      if (!selected.length || selected.some((id) => !r.taskIds.includes(id)))
        throw new DomainError('Выберите задачи этой ревизии', 400);
      if (
        expected &&
        (expected.revision !== r.number ||
          (expected.reason !== undefined && expected.reason !== r.reason) ||
          Object.entries(expected.dependencies ?? {}).some(
            ([id, pinned]) => dependencyDigest(task(s, id)) !== pinned,
          ) ||
          Object.entries(expected.context ?? {}).some(
            ([id, pinned]) => contextDigest(task(s, id)) !== pinned,
          ) ||
          Object.entries(expected.policies ?? {}).some(
            ([id, pinned]) => this.policyDigest(id) !== pinned,
          ) ||
          Object.entries(expected.scopes ?? {}).some(
            ([id, pinned]) => scopeDigest(task(s, id)) !== pinned,
          ) ||
          digest(expected.taskIds) !== digest(r.taskIds) ||
          (expected.execution !== undefined && expected.execution !== policy) ||
          selected.some((id) => {
            const current = task(s, id);
            return (
              (current.status !== 'draft' && !this.approvalStale(current, policy)) ||
              expected.tasks[id] !== specDigest(current)
            );
          }))
      )
        throw new DomainError('План изменился во время ревью; требуется повторная проверка');
      // Связь с историей INTENT — предусловие выпуска, как связь с фичей:
      // без неё принятая работа держала бы историю непроверенной навсегда.
      storyCheck(selected.map((id) => task(s, id)).filter((t) => t.status === 'draft'));
      const repinned: string[] = [];
      const restarted: { taskId: string; spent: number }[] = [];
      const kept: { taskId: string; spent: number; reason: string }[] = [];
      for (const id of selected) {
        const t = task(s, id);
        if (t.status === 'draft') {
          // Постановка черновика до закрепления контрактов: с ней сверяется
          // снимок с ответом, перенесённым в этот черновик (F14). ID
          // контрактов входят в постановку, новая редакция — новый ID.
          const draftSpec = specDigest(t);
          t.contractDigests = this.approvable(s, t);
          t.approvedAt = now();
          t.approvedDigest = specDigest(t);
          t.approvedScope = scopeDigest(t);
          t.approvedPolicy = policy;
          t.approval = approval;
          t.status = 'ready';
          closeEpisodeIfBasisChanged(t, now());
          rebindInputContext(t, draftSpec);
          const outcome = this.restartAttempts(s, t);
          if (outcome && 'restarted' in outcome) restarted.push(outcome.restarted);
          if (outcome && 'kept' in outcome) kept.push(outcome.kept);
        } else if (this.approvalStale(t, policy)) {
          // Повторное утверждение после смены политики: постановка и
          // закреплённые контракты прежние, утверждается план при новой
          // политике исполнения.
          t.approvedPolicy = policy;
          t.approval = approval;
          repinned.push(t.id);
        }
      }
      return {
        boardId,
        revision: r.number,
        approval,
        ...(repinned.length ? { repinned } : {}),
        ...(restarted.length ? { attemptsRestarted: restarted } : {}),
        ...(kept.length ? { attemptsKept: kept } : {}),
      };
    });
  }
  /**
   * Счётчик попыток после нового утверждения изменённой постановки (D47).
   * Попытки, потраченные на прежнее основание (постановка и закреплённые
   * контракты, как у эпизода разбора), к новой постановке не относятся: она
   * прошла независимое ревью плана заново, как корректировка, которая тоже
   * начинает с нуля. Поэтому счётчик начинается заново — автоматически не
   * больше одного раза за жизнь задачи: иначе ведущий покупал бы попытки
   * косметическими правками. Прежние попытки остаются в истории, перезапуск —
   * в журнале (`attemptsRestarted`), а отказ в нём — `attemptsKept` с причиной.
   *
   * Не перезапускается: исчерпанный счётчик (остановка для человека,
   * `retry --reset` с причиной), возврат из отмены человеком (D46), второй
   * перезапуск. То же утверждение той же постановки счётчик не трогает.
   * Бюджеты и предел остановок вопросом считаются по истории.
   */
  private restartAttempts(
    s: DevContourState,
    t: Task,
  ):
    | { restarted: { taskId: string; spent: number } }
    | { kept: { taskId: string; spent: number; reason: string } }
    | undefined {
    if (t.attempt <= 0) return undefined;
    const last = s.runs.findLast((r) => r.taskId === t.id && r.episodeBasis);
    if (!last || last.episodeBasis === episodeBasisOf(t)) return undefined;
    const spent = t.attempt;
    const reason =
      t.attempt >= this.config.maxAttempts
        ? 'exhausted'
        : t.restartBlocked
          ? t.restartBlocked
          : (t.attemptRestarts ?? 0) >= 1
            ? 'restart-limit'
            : undefined;
    if (reason) return { kept: { taskId: t.id, spent, reason } };
    t.attempt = 0;
    t.attemptRestarts = (t.attemptRestarts ?? 0) + 1;
    return { restarted: { taskId: t.id, spent } };
  }
  impact(boardId: string, roots: string[]) {
    const s = this.store.read();
    const b = board(s, boardId);
    const r = b.revisions.at(-1)!;
    if (r.status !== 'accepted')
      throw new DomainError('Корректировка создаётся после приёмки текущей ревизии');
    if (!roots.length || roots.some((id) => !r.taskIds.includes(id)))
      throw new DomainError('Выберите принятые задачи этой доски', 400);
    // Отменённый потребитель — не результат: корректировать его нечего, а
    // требование done делало корректировку предшественника невозможной.
    // Обход через него к живым потребителям сохраняется.
    const ids = descendants(impactGraph(s.tasks), [
      ...new Set(roots.map((id) => latestTaskId(s.tasks, id))),
    ]).filter((id) => task(s, id).status !== 'cancelled');
    return {
      taskIds: ids,
      boards: s.boards
        .filter((b) => b.revisions.at(-1)!.taskIds.some((id) => ids.includes(id)))
        .map((b) => ({ id: b.id, title: b.title })),
    };
  }
  correct(
    boardId: string,
    roots: string[],
    reason: string,
    refresh?: { expected: string; requirements: Record<string, Task['requirements']> },
  ) {
    if (reason.trim().length < 10 || reason.length > 5000)
      throw new DomainError('Опишите корректировку: от 10 до 5000 символов', 400);
    // Recompute the entire impact inside the write transaction; preview is never authoritative.
    return this.store.change('board.corrected', (s) => {
      const b = board(s, boardId);
      if (refresh && digest(b) !== refresh.expected)
        throw new DomainError('Доска изменилась во время чтения требований');
      const previous = b.revisions.at(-1)!;
      if (previous.status !== 'accepted') throw new DomainError('Сначала примите текущую ревизию');
      if (!roots.length || roots.some((id) => !previous.taskIds.includes(id)))
        throw new DomainError('Выберите задачи текущей принятой ревизии', 400);
      const impacted = descendants(impactGraph(s.tasks), [
        ...new Set(roots.map((id) => latestTaskId(s.tasks, id))),
      ]).filter((id) => task(s, id).status !== 'cancelled');
      if (impacted.some((id) => task(s, id).status !== 'done'))
        throw new DomainError(
          'В затронутой цепочке есть незавершённые задачи. Сначала завершите их.',
        );
      const currentIds = new Map(s.tasks.map((t) => [t.id, latestTaskId(s.tasks, t.id)]));
      const currentRoots = roots.map((id) => currentIds.get(id)!);
      const map = new Map(impacted.map((id) => [id, entityId(s, 'T')]));
      for (const id of impacted) {
        const original = task(s, id);
        const requirements = refresh?.requirements[id] ?? original.requirements;
        validateTaskContext(this.config, { ...original, requirements });
        s.tasks.push({
          ...original,
          preparation: correctionBinding(s, original),
          requirements,
          sharedCompletion: undefined,
          id: map.get(id)!,
          description:
            original.description +
            `\n\nКорректировка: ${reason}\n${currentRoots.includes(id) ? 'Измените результат согласно корректировке.' : 'Повторно проверьте и при необходимости адаптируйте результат к новым зависимостям.'}`,
          dependsOn: original.dependsOn.map(
            (d) => map.get(currentIds.get(d)!) ?? currentIds.get(d)!,
          ),
          supersedes: id,
          status: 'draft',
          createdAt: now(),
          attempt: 0,
          approvedAt: undefined,
          approvedDigest: undefined,
          approvedScope: undefined,
          approvedPolicy: undefined,
          approval: undefined,
          // Привязка к истории подтверждала принятый результат оригинала;
          // замена связывается с историей своей постановкой.
          storyBindings: undefined,
          activeRunId: undefined,
          resultSha: undefined,
          failure: undefined,
          contractDigests: {},
        });
      }
      const revision = {
        number: previous.number + 1,
        status: 'active' as const,
        reason,
        taskIds: [
          ...new Set([
            ...previous.taskIds.map((id) => map.get(currentIds.get(id)!) ?? id),
            ...map.values(),
          ]),
        ],
        createdAt: now(),
      };
      b.revisions.push(revision);
      assertDag(s.tasks);
      return { boardId, revision: revision.number, replacements: Object.fromEntries(map) };
    });
  }
  accept(
    boardId: string,
    headSha: string,
    approval: Approval = { actor: 'operator' },
    expectedDigest?: string,
    repositories?: Record<string, string>,
    /** Объединённый diff для условных gates, пропущенных задачами (`boardChanges`). */
    changes?: Record<string, ChangedPaths>,
  ) {
    return this.currentChange('board.accepted', (s) => {
      const r = activeRevision(s, boardId);
      if (expectedDigest && digest(r) !== expectedDigest)
        throw new DomainError('Ревизия изменилась во время приёмки');
      // Отменённая задача — явное решение с причиной в журнале, а не
      // незавершённая работа. Раньше она делала ревизию непринимаемой навсегда:
      // убрать её из ревизии было нечем. Объём приёмки — выполненные задачи;
      // хотя бы одна обязательна.
      const tasks = r.taskIds
        .map((id) => task(s, id))
        .filter((t) => t.status !== 'cancelled')
        .map((t) => structuredClone(t));
      if (!tasks.length || tasks.some((t) => t.status !== 'done'))
        throw new DomainError('Приёмка доступна, когда все задачи прошли интеграцию и проверки');
      // Перенесённые из принятой ревизии задачи уже проверены её приёмкой.
      const carried = carriedTaskIds(board(s, boardId), s.tasks);
      const work = tasks.filter((t) => !carried.has(t.id));
      work.forEach((t) => assertTaskPreparation(s, t));
      for (const t of work) {
        const unproven = unprovenReason(
          t.requirements,
          taskEvidence(s, t, this),
          t.resultSha,
          taskChecks(s, t, this),
        );
        if (unproven)
          throw new DomainError(
            needsRecheck(s, t, this)
              ? `${unproven}. Receipt задачи ${t.id} подтверждает другие проверки или не называет их (прежний формат) — нужна перепроверка задачи под текущей конфигурацией`
              : unproven,
          );
      }
      const uncovered = uncoveredGates(
        this,
        s,
        tasks,
        repositories ? boardCoverageWorks(this, boardId, r, repositories) : [],
        repositories && changes ? { changes, finalShas: repositories } : undefined,
      );
      if (uncovered.length) {
        // Receipt другого clone с другими проверками или без их тождества
        // покрытия не даёт — причина названа: задачу нужно перепроверить.
        const recheck = tasks.filter((t) => needsRecheck(s, t, this)).map((t) => t.id);
        throw new DomainError(
          'Полный набор проверок не пройден: ' +
            uncovered.map((u) => `${u.repositoryId}: ${u.gates.join(', ')}`).join('; ') +
            ' — ни одна задача доски и ни одна проверка доски на её итоговом SHA не прошли их на integration. ' +
            (recheck.length
              ? `Receipt задач ${recheck.join(', ')} подтверждает другие проверки или не называет их (прежний формат) — нужна перепроверка задач под текущей конфигурацией`
              : 'Примите доску командой `devcontour accept --board ' +
                boardId +
                '` или стадией 2 workflow (`workflow_start`): они выполнят эти gates на итоговом SHA доски'),
        );
      }
      r.status = 'accepted';
      r.acceptedAt = now();
      r.acceptance = approval;
      r.snapshot = {
        tasks,
        sha: headSha,
        ...(repositories ? { repositories } : {}),
        digest: digest({ tasks, sha: headSha, ...(repositories ? { repositories } : {}) }),
      };
      return { boardId, revision: r.number, snapshot: r.snapshot.digest, approval };
    });
  }
  /**
   * Пауза и продолжение очереди — wrapper без правил над паузой harness
   * (`pause`/`resume`): штатная остановка не подменяет паузу человека, решение
   * человека снимает паузу вместе с классами отказов и ожиданием проверки
   * базы. Паузу операции применения политики человек сначала забирает себе
   * (`pause('operator')` harness) — операция её уже не снимет, — затем снимает.
   * DevContour добавляет продуктовое условие продолжения: привязку разработки.
   */
  pause(
    value: boolean,
    reason: 'operator' | 'shutdown' = 'operator',
    by: 'operator' | 'lead' = 'operator',
  ) {
    const { store, engine } = executionOf(this);
    return domain(() =>
      store.host(value ? 'scheduler.paused' : 'scheduler.started', (ht) => {
        // Запуск очереди из любого процесса (CLI, отдельный MCP, панель) не
        // снимает паузу, пока сервер, ведущий очередь, останавливается: снятая
        // пауза остановки осталась бы в базе, и очередь пошла бы при
        // следующем запуске без решения человека.
        if (!value && serverStopping(this.store, ht.state.leader))
          throw new DomainError(SERVER_STOPPING, 409);
        // Очередь выдаёт работу утверждённых изменений; изменение в
        // проработке (даже активное) её запуск не держит.
        if (!value) assertAnyDevelopmentReady(ht.state);
        // Решение человека заменяет паузу операции применения политики (как
        // и прежде): пауза переходит к человеку и снимается им. Выдачу до
        // применения конфигурации по-прежнему держит запрос операции.
        if (!value && engine.read((v) => v.control().pauseReason) === 'reconfigure')
          engine.pause('operator');
        // Пауза ведущего поверх паузы человека ничего не меняет: решение
        // человека остаётся его решением (и снимается только по нему), а не
        // переписывается в паузу, которую ведущий вправе снять сам.
        const before = engine.read((v) => v.control());
        if (
          value &&
          reason === 'operator' &&
          by === 'lead' &&
          before.paused &&
          before.pauseReason === 'operator' &&
          !pausedByLead({ ...ht.state, ...before })
        ) {
          // Без записи и без события журнала: паузы ведущего не было.
          return { paused: true, reason: before.pauseReason, kept: 'operator' as const };
        }
        const { control } = value ? engine.pause(reason) : engine.resume();
        // Кто поставил паузу `operator`: ведущий агент — отметкой со временем
        // паузы; решение человека и снятие паузы отметку убирают.
        const lead = value && reason === 'operator' && by === 'lead' && control.pausedAt;
        if (lead) ht.state.pauseActor = { by: 'lead', at: control.pausedAt! };
        else if (!value || reason === 'operator') delete ht.state.pauseActor;
        const result = {
          paused: control.paused,
          reason: control.pauseReason,
          ...(lead ? { by: 'lead' as const } : {}),
        };
        ht.journal(result);
        return result;
      }),
    );
  }
  // Карта продукта считает готовность по связи задачи с фичей. Задачи,
  // выпущенные без неё, исправляются здесь — в том числе принятые: связь не
  // входит в постановку, и приёмку она не затрагивает.
  bindFeature(id: string, featureId: string) {
    return this.store.change('task.feature', (s) => {
      const t = task(s, id);
      if (t.status === 'cancelled') throw new DomainError('Отменённая задача не относится к фиче');
      if (!t.preparation)
        throw new DomainError('Задача не связана с изменением продукта; фичу ей назначить нельзя');
      assertFeatureOf(s, t.preparation.changeId, featureId);
      const previous = t.featureId;
      t.featureId = featureId;
      return { taskId: t.id, featureId, previous };
    });
  }
  /**
   * Привязка выполненной задачи к истории INTENT без изменения постановки —
   * восстановление для работы, принятой без связи с историей. Связь в
   * `requirements` изменила бы `specDigest` и потребовала бы повторного
   * прогона; привязка хранится отдельно, как `featureId`. Историю и её digest
   * на текущей карте проверяет runner (`IntentService.bindStory`); здесь —
   * сами задачи: выполнена, не заменена, не связана с историей в постановке,
   * и каждый её подробный REQ входит в критерии этой истории.
   */
  bindStory(input: {
    repositoryId: string;
    storyId: string;
    binding: Omit<StoryBinding, 'boundAt'>;
    criteria: string[];
    taskIds: string[];
    reason: string;
    actor: Approval['actor'];
  }) {
    const reason = input.reason.trim();
    if (reason.length < 10 || reason.length > 5000)
      throw new DomainError('Укажите причину привязки: от 10 до 5000 символов', 400);
    const criteria = new Set(input.criteria);
    return this.store.change('task.story', (s) => {
      const at = now();
      for (const id of new Set(input.taskIds)) {
        const t = task(s, id);
        if ((t.scope === 'workspace' ? undefined : t.repositoryId) !== input.repositoryId)
          throw new DomainError(`${t.id}: задача вне компонента ${input.repositoryId}`, 409);
        if (t.status !== 'done')
          throw new DomainError(
            `${t.id}: привязать к истории можно только выполненную задачу; черновику добавьте связь ${input.binding.id} в requirements`,
            409,
          );
        if (s.tasks.some((x) => x.supersedes === t.id))
          throw new DomainError(`${t.id}: задача заменена корректировкой`, 409);
        const links = t.requirements ?? [];
        if (links.some((r) => r.source === input.binding.source))
          throw new DomainError(`${t.id}: задача уже связана с историей в постановке`, 409);
        if (!links.length)
          throw new DomainError(`${t.id}: у задачи нет подробных REQ этой истории`, 409);
        const outside = links.filter((r) => !criteria.has(referenceKey(r)));
        if (outside.length)
          throw new DomainError(
            `${t.id}: ${outside.map((r) => r.source + '#' + r.id).join(', ')} не входит в критерии истории ${input.storyId}`,
            409,
          );
        // Повторная привязка переподтвердила бы изменённую историю без
        // прогона: автор новой редакции не видел. Устаревшая привязка
        // восстанавливается как задача со связью — корректировкой доски.
        if (t.storyBindings?.some((b) => b.id === input.binding.id))
          throw new DomainError(
            `${t.id}: задача уже привязана к истории ${input.storyId}; привязка к изменённой истории не обновляется — нужна корректировка доски (board_correct) с повторным прогоном`,
            409,
          );
        t.storyBindings = [...(t.storyBindings ?? []), { ...input.binding, boundAt: at }];
      }
      return {
        repositoryId: input.repositoryId,
        storyId: input.storyId,
        binding: input.binding,
        taskIds: [...new Set(input.taskIds)],
        reason,
        actor: input.actor,
      };
    });
  }
  // Перенос базы устраняет причину, по которой диспетчер встал, но очередь не
  // запускает: сначала базу проверяют гейтами. Прежний сбой перестаёт
  // называться причиной — иначе экран продолжал советовать уже выполненный
  // base-update. Событие оставляет перенос в журнале.
  baseUpdated(updated: BaseMove[]) {
    return this.store.change('base.updated', (s) => {
      if (!s.paused) throw new DomainError('Перенос базы выполняется на остановленной очереди');
      // Пауза человека остаётся его паузой, а остановка из-за отказа
      // провайдера — своей причиной со сбоями: перенос базы провайдер не
      // чинит. Иначе очередь ждёт проверки базы — это техническое ожидание,
      // а не решение человека.
      if (s.pauseReason !== 'operator' && s.pauseReason !== 'runtime') {
        s.pauseReason = 'base-check';
        s.pauseFailures = undefined;
      }
      s.pausedAt = now();
      waitBaseCheck(
        s,
        updated,
        `База прогонов перенесена (${updated.map((u) => u.repositoryId).join(', ')}): проверьте её гейтами и продолжите очередь`,
      );
      return { updated };
    });
  }
  /**
   * Остановка выдачи под перенос базы в режиме агента. В режиме оператора
   * перенос требует паузы человека, и она остаётся его паузой. В режиме
   * агента согласования ведёт контур: ручная пауза перед переносом
   * превращалась в паузу человека, и очередь потом ждала ручного
   * `queue --start`. Здесь очередь сразу встаёт на техническое ожидание
   * `base-check`, которое цикл ведущего снимает после прохождения gates базы.
   */
  holdForBaseUpdate() {
    return this.store.change('base.update.hold', (s) => {
      if (this.config.approvalMode !== 'agent')
        throw new DomainError('Сначала приостановите очередь: queue --pause', 409);
      if (s.paused) return { held: false };
      if (s.runs.some((r) => r.status === 'active'))
        throw new DomainError('Дождитесь завершения попыток перед переносом базы', 409);
      s.paused = true;
      s.pauseReason = 'base-check';
      s.pausedAt = now();
      return { held: true };
    });
  }
  /**
   * Ожидание `base-check`, поставленное `holdForBaseUpdate` (перенос базы в
   * режиме агента на идущей очереди), снять не удалось: сервер
   * останавливается. Без диапазона переноса это ожидание никто не снимет —
   * проверять нечего. До ожидания очередь шла, поэтому оно становится паузой
   * штатной остановки: её снимает тот же запуск, что и остановку сервера.
   * Ожидание с диапазоном переноса (проверку базы) не трогается.
   */
  yieldBaseHold() {
    return this.store.change('base.update.hold.yielded', (s) => {
      if (!s.paused || s.pauseReason !== 'base-check' || s.baseMoves) return { yielded: false };
      if (s.waits?.some((w) => w.kind === 'base-check')) return { yielded: false };
      s.pauseReason = 'shutdown';
      return { yielded: true };
    });
  }
  /** Техническое ожидание операции: видно отдельно от паузы и её не трогает. */
  waitFor(kind: 'context-lock', operation: string, detail: string) {
    return this.store.change('wait.started', (s) => {
      s.waits = [
        ...(s.waits ?? []).filter((w) => !(w.kind === kind && w.operation === operation)),
        { kind, detail, operation, at: now() },
      ];
      return { kind, operation };
    });
  }
  clearWait(kind: 'context-lock', operation: string) {
    return this.store.change('wait.cleared', (s) => {
      const left = (s.waits ?? []).filter((w) => !(w.kind === kind && w.operation === operation));
      if (left.length === (s.waits ?? []).length) return;
      s.waits = left.length ? left : undefined;
      return { kind, operation };
    });
  }
  /** Передать удержание задач от одной операции другой без окна выдачи (правило движка). */
  transferHold(from: string, to: string, reason: string) {
    const { engine } = executionOf(this);
    return domain(() => engine.transferHold(from, to, reason));
  }
  /** Снять удержание операции с перечисленных задач; чужие не трогаются. */
  releaseTasks(operation: string, ids: string[]) {
    const { engine } = executionOf(this);
    return domain(() => engine.releaseHold(operation, ids));
  }
  assign(id: string, member: string) {
    const assignee = taskInput.shape.assignee.unwrap().parse(member);
    return this.store.change('task.assigned', (s) => {
      const t = task(s, id);
      if (t.activeRunId) throw new DomainError('Дождитесь завершения активной попытки');
      t.assignee = assignee;
      return { taskId: id, assignee };
    });
  }
  private awaitsOperator(t: Task) {
    // Корпус хранится у компонента-владельца договора, не обязательно у
    // компонента задачи: смотрим всех владельцев, как CheckCorpus.all().
    const owners = this.config.repositories.length
      ? this.config.repositories.map((r) => r.id)
      : ['main'];
    return owners
      .flatMap((owner) =>
        Object.values(
          this.store.localRecords<{
            pending: { tasks: string[]; status: string; awaitingOperator?: boolean }[];
          }>('check-suites', owner),
        ),
      )
      .some((suite) =>
        suite.pending.some(
          (p) => p.status === 'waiting' && p.awaitingOperator && p.tasks.includes(t.id),
        ),
      );
  }
  /**
   * Выдача попытки — решение движка harness (пауза, барьеры, бюджеты,
   * предел попыток, продуктовые условия хоста); ожидание задачи до выдачи
   * движок пишет по сведениям хоста в той же транзакции, как и при выдаче
   * очередью.
   */
  claim(owner: string): Run | undefined {
    const { store, engine } = executionOf(this);
    return domain(() =>
      store.host('run.claimed', (ht) => {
        const before = ht.state.leader;
        const leading = before?.owner === owner && before.leaseUntil > Date.now();
        if (!engine.lead(owner)) return undefined;
        const attempt = engine.claim(owner);
        // Выдаёт только controller; прямая выдача (не из очереди) роль за
        // вызвавшим не оставляет — как и прежде, она не запуск очереди.
        if (!leading) engine.release(owner);
        if (!attempt) return undefined;
        // Ожидание задачи (`wait`) записал движок в той же транзакции: время
        // готовности — от хоста (`devcontourHost.readyAt`).
        const s = ht.state;
        const run = s.runs.find((r) => r.id === attempt.id)!;
        run.callsRecorded = true;
        ht.journal({ taskId: run.taskId, runId: run.id });
        return structuredClone(run);
      }),
    );
  }
  /**
   * Продуктовая запись в попытку под её владением: владение и актуальность
   * проверяет движок в той же транзакции. Правил исполнения здесь нет.
   */
  withRun<T>(
    id: string,
    token: string,
    type: string,
    fn: (run: Run, t: Task, s: DevContourState) => T,
  ): T {
    const { store, engine } = executionOf(this);
    return domain(() =>
      store.host(
        type,
        (ht) =>
          engine.withAttempt(id, token, 'run.context', () => {
            const s = ht.state;
            const r = requireValue(
              s.runs.find((r) => r.id === id),
              'Попытка не найдена',
            );
            const out = fn(r, task(s, r.taskId), s);
            // Возвращённое продуктовой записью — данные её события журнала, как прежде.
            if (out && typeof out === 'object' && !Array.isArray(out))
              ht.journal(out as Record<string, unknown>);
            return out as never;
          }) as T,
      ),
    );
  }
  heartbeat(id: string, token: string) {
    const { engine } = executionOf(this);
    domain(() => engine.heartbeat(id, token));
  }
  /**
   * Продление владения не удалось.  /**
   * Продление владения не удалось. Планировщик прерывал попытку молча, и
   * снаружи оставалось только «истёк срок владения» — причину (сменившаяся
   * политика, привязка к подготовке, сбой хранилища) узнать было неоткуда.
   * Причина записывается в попытку; истечение её не затирает.
   */
  heartbeatFailed(id: string, token: string, reason: string) {
    const { engine } = executionOf(this);
    return domain(() => engine.heartbeatFailed(id, token, reason));
  }
  phase(
    id: string,
    token: string,
    phase: 'running' | 'verifying' | 'reviewing' | 'integrating',
    data: Partial<Pick<Run, 'baseSha' | 'candidateSha' | 'integrationSha' | 'worktree'>> = {},
  ) {
    const { engine } = executionOf(this);
    domain(() => engine.phase(id, token, phase, data));
  }
  evidence(id: string, token: string, evidence: Omit<Evidence, 'id' | 'runId' | 'createdAt'>) {
    const { engine } = executionOf(this);
    return domain(() =>
      engine.evidence(id, token, evidence as Parameters<typeof engine.evidence>[2]),
    );
  }
  /** Приёмка — решение движка: gates, ревью, потребители, требования, CAS в `publish`. */
  finish(id: string, token: string, sha: string, publish?: () => void) {
    const { engine } = executionOf(this);
    return domain(() => {
      const accepted = engine.finish(id, token, sha, publish);
      return { taskId: accepted.workId, runId: id, sha };
    });
  }
  fail(
    id: string,
    token: string,
    error: string,
    blocked = false,
    kind: FailureKind = 'unknown',
    /** Первая причина неудавшегося продления, известная планировщику. */
    heartbeatCause?: string,
    /** Свойства, с которыми связан отказ: объявленные и только названные. */
    properties?: { bound: string[]; unbound: string[] },
  ) {
    const { engine } = executionOf(this);
    return domain(() =>
      engine.fail(id, token, error, {
        blocked,
        kind,
        ...(heartbeatCause ? { heartbeatCause } : {}),
        ...(properties ? { properties } : {}),
      }),
    );
  }
  discoveries(id: string, token: string, sha: string, input: unknown) {
    const findings = discoveryInput.array().max(20).parse(input);
    if (!findings.length) return [];
    return this.withRun(id, token, 'findings.recorded', (run, source, s) => {
      const created: string[] = [];
      for (const finding of findings) {
        const fingerprint = digest({
          repositoryId: source.repositoryId,
          path: finding.path,
          observation: finding.observation,
        });
        // Открытая или отменённая находка с тем же отпечатком — та же находка:
        // отмена — решение разбора ведущего, повтор его не отменяет. После
        // принятого исправления повторное появление — новый дефект.
        if (s.tasks.some((t) => t.finding?.fingerprint === fingerprint && t.status !== 'done'))
          continue;
        let inbox = s.boards.find(
          (b) => b.title === 'Находки агентов' && b.revisions.at(-1)?.status === 'active',
        );
        if (!inbox) {
          inbox = {
            id: entityId(s, 'B'),
            title: 'Находки агентов',
            description:
              'Непроверенные дефекты и техдолг. Ведущий агент проверяет воспроизведение и приоритет до утверждения.',
            revisions: [
              {
                number: 1,
                status: 'active',
                reason: 'Сбор находок',
                taskIds: [],
                createdAt: now(),
              },
            ],
          };
          s.boards.push(inbox);
        }
        const t: Task = {
          ...taskInput.parse({
            repositoryId: source.repositoryId,
            role: source.role,
            title: finding.title,
            description: `${finding.observation}\nПоследствие: ${finding.consequence}\nВоспроизведение: ${finding.reproduction}\nИсточник: ${finding.path}:${finding.line} @ ${sha}. Находка не подтверждена.`,
            acceptance: [...FINDING_ACCEPTANCE],
            finding: {
              ...finding,
              fingerprint,
              sourceTaskId: source.id,
              sourceRunId: run.id,
              sourceSha: sha,
              verification: 'proposed',
            },
          }),
          id: entityId(s, 'T'),
          assignee: s.team?.member,
          status: 'draft',
          attempt: 0,
          createdAt: now(),
          contractDigests: {},
        };
        // Находка относится к той же постановке, фиче и контрактам, что и задача,
        // в которой её нашли. Без привязки черновик блокировал утверждение всей
        // доски находок: постановка — сообщением, которое не называло задачу,
        // контракт — для роли, которой он обязателен. Контракт берётся текущей
        // редакцией того же файла; исчезнувший из реестра — отбрасывается.
        // Digests закрепляет утверждение, черновик их не несёт.
        t.contracts = [
          ...new Set(
            source.contracts.flatMap((id) => {
              // Действующая редакция того же смысла — последняя консолидация.
              const c = supersededBy(s.contracts, id) ?? currentText(s.contracts, id);
              return c ? [c.id] : [];
            }),
          ),
        ];
        if (source.preparation) {
          try {
            t.preparation = developmentBinding(s, source.preparation.changeId);
          } catch {
            /* Постановка сменилась: привязку даст правка черновика ведущим. */
          }
          if (source.featureId) t.featureId = source.featureId;
        }
        s.tasks.push(t);
        inbox.revisions.at(-1)!.taskIds.push(t.id);
        created.push(t.id);
      }
      return created;
    });
  }
  /**
   * Учесть разбор ведущего до вызова модели. Один автоматический разбор на
   * эпизод: повторная регистрация, рестарт или дубликат события бесплатного
   * вызова не получают. Исчерпанные попытки задачи — решение пользователя.
   */
  recoveryReserve(taskId: string, recoveryId: string) {
    const { engine } = executionOf(this);
    return domain(() => {
      const r = engine.recoveryReserve(taskId, recoveryId);
      return { taskId, recovery: r.id, status: r.status, reason: r.reason };
    });
  }
  /**
   * Записать решение разбора — ведущего (автоматического) или ручное через
   * API. Правила эпизода — движка harness.
   */
  recoveryDecide(
    taskId: string,
    recoveryId: string,
    decision: NonNullable<PropertyRecovery['decision']>,
    expectedVersion?: number,
  ): PropertyRecovery {
    if (!recoveryActions.includes(decision.action))
      throw new DomainError('Неизвестное действие восстановления', 400);
    const { engine } = executionOf(this);
    domain(() => engine.recoveryDecide(taskId, recoveryId, decision, expectedVersion));
    return structuredClone(task(this.store.read(), taskId).recovery!);
  }
  /** Итог добавления случаев: подтверждённый случай разрешает один повтор. */
  recoveryApplied(
    taskId: string,
    recoveryId: string,
    outcomes: { outcome: string; reason: string }[],
  ) {
    const { engine } = executionOf(this);
    domain(() =>
      engine.recoveryApplied(
        taskId,
        recoveryId,
        outcomes as Parameters<typeof engine.recoveryApplied>[2],
      ),
    );
    return structuredClone(task(this.store.read(), taskId).recovery!);
  }
  /** Разбор прервался без решения: вызов учтён, повтор не бесплатен. */
  recoveryInterrupted(taskId: string, recoveryId: string, reason: string) {
    const { engine } = executionOf(this);
    return domain(() => engine.recoveryInterrupted(taskId, recoveryId, reason));
  }
  // Причина отмены остаётся в журнале: отменённая находка без неё неотличима
  // от забытой. Панель отменяет без причины, ведущий агент — с ней.
  // `by` — актёр события `work.cancelled`: `operator` — человек (CLI, панель),
  // `host` — ведущий агент (`cancel --by host`; отчёт harness считает такую
  // задачу неизвестной). Без актёра — человек: отмена ведущим меняет объём
  // работы задания доски (`leadScope`), и молча её не назначить.
  cancel(id: string, reason?: string, by: CancelActor = 'operator') {
    const { store, engine } = executionOf(this);
    return domain(() =>
      store.host('task.cancelled', (ht) => {
        const t = task(ht.state, id);
        if (t.status === 'done')
          throw new DomainError('Принятый результат нельзя отменить; создайте корректировку');
        // Отмена задачи закрывает её открытые вопросы исполнителя. Вопрос,
        // который ведущий не вправе решить сам (критический или режим
        // оператора), снимает только оператор — и задачей тоже: иначе отмена
        // и повтор обошли бы правило ответа.
        if (by !== 'operator') {
          const work = ht.tx.work(id);
          const held = work
            ? requestsOf(ht.tx, work).find(
                (r) =>
                  blocksWork(r) && (r.floors.length > 0 || this.config.approvalMode === 'operator'),
              )
            : undefined;
          if (held) {
            const error = new DomainError(
              `Задачу ${id} держит вопрос исполнителя ${held.id}, который решает оператор: вопрос или задачу отменяет оператор`,
              403,
            );
            (error as DomainError & { code?: string }).code = 'OPERATOR_ANSWERS';
            throw error;
          }
        }
        // Актёр первой отмены: повторная отмена задачу не меняет и актёра
        // не переписывает (цикл ведущего различает их, `leadScope`).
        if (t.status !== 'cancelled') t.cancelledBy = by;
        engine.cancel(id, reason, by);
        const data = reason ? { taskId: id, reason } : { taskId: id };
        ht.journal(data);
        return data;
      }),
    );
  }
  /**
   * Повтор после сбоя. Бюджет попыток защищает от задачи, которая крутится
   * вхолостую, но у оператора, устранившего причину, не было никакого способа
   * вернуть задачу в работу: лимит упирался в тупик, и единственным выходом
   * оставалась правка базы руками. Сброс возможен, он явный и с причиной —
   * она попадает в журнал рядом с попытками, которые сбрасываются.
   */
  /**
   * Вернуть в черновик задачу, которая ничего не произвела.
   *
   * Утверждённая постановка неизменна — и правильно: под неё уже велась работа.
   * Но пока задача не дала принятого результата, менять её бывает необходимо:
   * контракт исправлен до того, как доска принята, и переписывать под старый
   * контракт нечего. Штатного пути не было: `correct` требует принятой ревизии
   * и завершённых задач, `edit-task` — черновика. Оставался тупик, из которого
   * выходили правкой базы руками.
   *
   * Возврат разрешён только задаче без принятого результата. Прогоны остаются
   * в истории; утверждение снимается, и доску нужно провести через ревью плана
   * заново — иначе это был бы обход независимого согласования.
   */
  reopen(id: string, reason: string) {
    if (reason.trim().length < 10 || reason.length > 5000)
      throw new DomainError('Опишите причину возврата: от 10 до 5000 символов', 400);
    return this.store.change('task.reopened', (s) => {
      const t = task(s, id);
      if (t.resultSha)
        throw new DomainError('Задача дала принятый результат; нужна корректировка доски');
      if (t.activeRunId) throw new DomainError('Дождитесь завершения текущей попытки');
      assertNotAccepted(s, t);
      // Открытый вопрос исполнителя не снимается: черновик не выдаётся, а
      // после нового утверждения той же постановки ответ применяется обычным
      // applyInput (исходная остановка держится). Изменённая постановка —
      // выход supersede (преемник — та же задача) и перенос ответа.
      // Черновик тоже возвращается: снятое утверждение могло оставить за собой
      // digest контрактов, и задача продолжала бы закреплять одну редакцию,
      // ссылаясь на другую. Операция идемпотентна.
      const approved = t.approvedDigest;
      // Отмена человеком (или без записанного актёра — D46) — его решение:
      // возврат её не отменяет счёт попыток, новая постановка не перезапустит
      // его автоматически (D47).
      const humanCancel =
        t.status === 'cancelled' && t.cancelledBy !== 'host' && t.cancelledBy !== 'graph';
      if (humanCancel) t.restartBlocked = 'human-cancel';
      t.status = 'draft';
      t.cancelledBy = undefined;
      t.approvedDigest = undefined;
      t.approvedScope = undefined;
      t.approval = undefined;
      // Digest контрактов принадлежит снятому утверждению. Оставить его значит
      // сказать, что задача закрепляет одну редакцию контракта, а ссылается на
      // другую: исполнитель получил бы противоречащие обязательства.
      t.contractDigests = {};
      t.failure = undefined;
      return {
        taskId: id,
        reason: reason.trim(),
        wasApproved: Boolean(approved),
        ...(humanCancel ? { humanCancel: true } : {}),
      };
    });
  }
  /**
   * Удержать задачи от выдачи на время изменения их контракта. Задача,
   * удерживаемая другой операцией, — конфликт (правило движка).
   */
  hold(ids: string[], operation: string, reason: string) {
    const { engine } = executionOf(this);
    return domain(() => engine.hold(ids, operation, reason));
  }
  /** Снять удержание операции. Чужие удержания не трогаются. */
  release(operation: string) {
    const { engine } = executionOf(this);
    return domain(() => engine.releaseHold(operation));
  }
  /**
   * Перепривязать задачи с прежних редакций контракта на новую. Задача
   * возвращается в черновик: её утверждение относилось к прежнему договору и
   * требует нового ревью плана. Выданные прогону и принятые задачи не
   * трогаются — первые дожидаются, вторые меняются корректировкой.
   */
  rebind(ids: string[], from: string[], to: string) {
    return this.store.change('task.rebound', (s) => {
      requireValue(
        s.contracts.find((c) => c.id === to),
        'Новая редакция контракта не найдена',
      );
      const rebound: string[] = [];
      for (const id of ids) {
        const t = task(s, id);
        if (t.activeRunId || t.resultSha || !['draft', 'ready', 'failed'].includes(t.status))
          continue;
        if (!t.contracts.some((c) => from.includes(c))) continue;
        t.contracts = [...new Set(t.contracts.map((c) => (from.includes(c) ? to : c)))];
        // Корпус принадлежит прежнему договору и его основанию эталона: новая
        // редакция начинает со своего корпуса. История принятий остаётся в
        // корпусе прежнего договора. Корпус другого, не заменённого договора
        // задачи остаётся обязательным.
        if (t.checkVersion && !t.contracts.includes(t.checkVersion.suite.replace(/^KS-/, '')))
          t.checkVersion = undefined;
        t.status = 'draft';
        t.approvedDigest = undefined;
        t.approvedScope = undefined;
        t.approval = undefined;
        t.contractDigests = {};
        t.failure = undefined;
        rebound.push(t.id);
      }
      return rebound;
    });
  }
  /**
   * `by` — актёр события `work.retried`: `operator` — человек (CLI, панель),
   * `recovery` — восстановление цикла ведущего по правилу, `host` — актёр не
   * назван (по умолчанию; отчёт считает такую задачу неизвестной).
   */
  retry(
    id: string,
    reset?: { reason: string },
    by: RetryActor = 'host',
    /**
     * Повтор просит ведущий агент (MCP `task_retry`, CLI `retry --by host`):
     * задачу, которую отменил человек или отмена без записанного актёра
     * (D46: считается отменой человеком), он не повторяет — продолжение
     * такой отмены — решение человека.
     */
    options: { lead?: boolean } = {},
  ) {
    const { store, engine } = executionOf(this);
    return domain(() =>
      store.host('task.retry', (ht) => {
        const t = task(ht.state, id);
        // Продуктовое условие: принятую ревизией задачу повтор не трогает.
        assertNotAccepted(ht.state, t);
        if (
          options.lead &&
          t.status === 'cancelled' &&
          t.cancelledBy !== 'host' &&
          t.cancelledBy !== 'graph'
        )
          throw new DomainError(
            `${t.id}: задачу отменил человек${t.cancelledBy ? '' : ' (актёр отмены не записан — считается отменой человеком)'}; повтор такой отмены — решение пользователя: оператор повторяет её в панели или командой devcontour retry --task ${t.id}`,
            409,
          );
        const exhaustedReady = t.attempt >= this.config.maxAttempts && !t.activeRunId;
        if (!['failed', 'cancelled'].includes(t.status) && !exhaustedReady)
          throw new DomainError('Повтор доступен после сбоя или отмены');
        const spent = t.attempt;
        const exhausted = t.attempt >= this.config.maxAttempts;
        // Повтор отменённой задачи снимает актёра прежней отмены: следующая
        // отмена (в том числе пришедшая через sync) не унаследует его.
        t.cancelledBy = undefined;
        engine.retry(id, reset, by);
        const data =
          exhausted && reset
            ? { taskId: id, reset: { spent, reason: reset.reason.trim() } }
            : { taskId: id };
        ht.journal(data);
        return data;
      }),
    );
  }
  /** Истечение владения к моменту `at` — решение движка. */
  expire(at?: number) {
    const { engine } = executionOf(this);
    return domain(() => engine.expire(at));
  }
  adopt(id: string, owner: string): Run {
    const { engine } = executionOf(this);
    domain(() => engine.adopt(id, owner));
    return structuredClone(this.store.read().runs.find((r) => r.id === id)!);
  }
  leader(owner: string) {
    const { engine } = executionOf(this);
    return domain(() => engine.lead(owner));
  }
  /**
   * Отметка штатной остановки сервера-владельца `owner` (его планировщика):
   * `true` — с начала остановки, `false` — после неё и при запуске; `false` в
   * ответе — действующая отметка другого сервера осталась. Отметка —
   * локальная запись базы (в sync не входит) и действует, только пока её
   * владелец держит живую роль controller (`serverStopping`): после
   * освобождения роли или падения процесса (срок роли истёк) она ничего не
   * блокирует.
   */
  markStopping(owner: string, stopping: boolean): boolean {
    return this.store.atomic(() => {
      const current = this.store.localRecord<StoppingMarker | null>(
        STOPPING_NAMESPACE,
        undefined,
        STOPPING_KEY,
      );
      // Действующую отметку другого сервера (он ведёт очередь и
      // останавливается) не заменяет ни отметка, ни снятие: заменяется и
      // снимается только своя или недействующая.
      const foreign =
        !!current &&
        current.owner !== owner &&
        serverStopping(this.store, this.store.read().leader);
      if (foreign) return false;
      if (stopping)
        this.store.saveLocal(STOPPING_NAMESPACE, undefined, STOPPING_KEY, {
          owner,
          at: new Date().toISOString(),
        } satisfies StoppingMarker);
      else if (current) this.store.saveLocal(STOPPING_NAMESPACE, undefined, STOPPING_KEY, null);
      return true;
    });
  }
}

/** Отказ запуска очереди, пока процесс сервера останавливается. */
export const SERVER_STOPPING = 'Сервер останавливается: очередь не запускается';
const STOPPING_NAMESPACE = 'server';
const STOPPING_KEY = 'stopping';
interface StoppingMarker {
  owner: string;
  at: string;
}
/**
 * Сервер останавливается: есть отметка остановки, и её владелец всё ещё
 * держит живую роль controller. Роль снимает исполнитель в конце остановки;
 * у упавшего процесса истекает её срок — отметка тогда не действует.
 */
export function serverStopping(
  store: Store,
  leader: { owner: string; leaseUntil: number } | undefined,
  at = Date.now(),
) {
  const marker = store.localRecord<StoppingMarker | null>(
    STOPPING_NAMESPACE,
    undefined,
    STOPPING_KEY,
  );
  return !!marker && leader?.owner === marker.owner && leader.leaseUntil > at;
}
