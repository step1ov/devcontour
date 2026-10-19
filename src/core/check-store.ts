import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute } from 'node:path';
import {
  CorpusStore,
  HarnessError,
  canonicalJson,
  caseId,
  corpusFile,
  parseCanonical,
  portableSuite,
  scrubLocalPaths,
  scrubPortable,
  sha256,
  versionOf as harnessVersionOf,
  verifySuite,
  type CheckSuite,
  type NotPromise,
  type PortableSuite,
} from 'devcontour-harness';
import { DomainError, type Task } from './model.ts';
import type { DevContour } from './service.ts';
import { executionOf, toDomain } from '../harness/execution.ts';
export { effectiveChecks } from './checks.ts';
export {
  canonicalJson,
  caseId,
  corpusFile,
  parseCanonical,
  portableSuite,
  scrubLocalPaths,
  scrubPortable,
  sha256,
  verifySuite,
  type CheckSuite,
  type PortableSuite,
};

/**
 * Версионируемый корпус подтверждённых случаев — корпус harness над тем же
 * Store.
 *
 * Подтверждение случая закреплённым эталоном, добавочные версии, принятие
 * версии задачами с удержанием выдачи, ожидание оператора и перепривязка по
 * нормативному основанию договора — правила harness (`CorpusStore`). Здесь
 * только продуктовая часть: какие корни установки очищаются из переносимой
 * диагностики, чтение корпусов владельцев компонентов и перенос корпуса через
 * Git (`mergeSuites`, `localSuite`; см. sync-model).
 *
 * Корпус принадлежит нормативному основанию договора, а не ID контракта:
 * первый корпус контракта — `KS-<id>` (так записаны и корпуса прежних версий;
 * основание у них то же), корпус новых правил того же ID — `KS-<id>-<basis>`.
 */
export type CorpusCase = CheckSuite['cases'][string];
export type CorpusVersion = CheckSuite['versions'][number];
export type CaseDecision = CheckSuite['decisions'][number];
export type DecisionOutcome = CaseDecision['outcome'];
export type Adoption = CheckSuite['adoptions'][number];
export type PendingAdoption = CheckSuite['pending'][number];
export type CaseOperation = CheckSuite['operations'][string];

export const SUITES = 'check-suites';
/** Предел одного случая (вход + ожидание) в байтах. */
export const MAX_CASE_BYTES = 64 * 1024;
/** Предел канонического файла версии корпуса в байтах. */
export const MAX_SUITE_BYTES = 1_500_000;

/**
 * Пути из конфигурации в том написании, в каком их задал пользователь: после
 * загрузки конфигурации пути репозиториев и workspace становятся
 * разрешёнными, а диагностика может назвать исходное написание.
 */
export const configuredSpellings = new WeakMap<object, string[]>();
/** Локальные корни этой установки — и в заданном, и в разрешённом виде. */
export function localRoots(h: DevContour, extra: string[] = []) {
  const given = [
    ...extra,
    ...(configuredSpellings.get(h.config) ?? []),
    h.config.workspaceRoot,
    h.config.repository,
    ...h.config.repositories.map((r) => r.path),
    h.store.file === ':memory:' ? undefined : dirname(h.store.file),
    tmpdir(),
    homedir(),
  ].filter((x): x is string => !!x && isAbsolute(x));
  const resolved = given.map((x) => {
    try {
      return realpathSync(x);
    } catch {
      return x;
    }
  });
  // macOS: /tmp, /var, /etc — псевдонимы /private/…; диагностика может
  // назвать любое из двух написаний.
  const aliases = [...given, ...resolved].flatMap((x) =>
    x.startsWith('/private/')
      ? [x.slice('/private'.length)]
      : /^\/(?:tmp|var|etc)(?:\/|$)/.test(x)
        ? ['/private' + x]
        : [],
  );
  return [...new Set([...given, ...resolved, ...aliases])];
}

/** Отказ корпуса harness — ошибка прикладного слоя с тем же текстом. */
function domain<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw error instanceof HarnessError ? toDomain(error) : error;
  }
}

/**
 * Версия корпуса по ссылке. Digest однозначен; номер — только если в истории
 * одна версия с ним: после объединения клонов номера могут совпасть.
 */
export function versionOf(suite: CheckSuite, ref: { number?: number; digest?: string }) {
  return domain(() => harnessVersionOf(suite, ref));
}

/**
 * Корпус установки: операции корпуса harness над движком DevContour. Методы
 * сохраняют прежние имена прикладного слоя; отказ harness — `DomainError`.
 */
export class CheckCorpus {
  constructor(readonly h: DevContour) {}
  private get store() {
    return new CorpusStore(executionOf(this.h).engine, localRoots(this.h));
  }
  private read<T>(
    fn: (store: CorpusStore, view: Parameters<CorpusStore['all']>[0]) => NotPromise<T>,
  ): T {
    const store = this.store;
    return domain(() => store.engine.read((v) => fn(store, v)));
  }
  /** Корпуса владельца (компонента) или всех владельцев установки. */
  all(repositoryId?: string): CheckSuite[] {
    return this.read((store, v) => store.all(v, repositoryId));
  }
  get(id: string): CheckSuite {
    return this.read((store, v) => structuredClone(store.get(v, id)));
  }
  /**
   * Запись корпуса, импортированного из Git (продуктовая синхронизация):
   * прежний размер и ревизия, без правил подтверждения — их запись уже прошла
   * у клона-источника и сверена `verifySuite`.
   */
  save(suite: CheckSuite) {
    suite.revision++;
    if (Buffer.byteLength(JSON.stringify(suite)) > MAX_SUITE_BYTES * 2)
      throw new DomainError('Запись корпуса превысила предел хранения', 413);
    this.h.store.saveLocal(SUITES, suite.repositoryId, suite.id, suite);
  }
  head(suite: CheckSuite) {
    return this.store.head(suite);
  }
  /** Корпус договора задачи по свойству (в памяти, если его ещё нет). */
  suiteFor(task: Pick<Task, 'id'>, property: string) {
    return this.read((store, v) => {
      const work = v.work(task.id);
      if (!work) throw new DomainError('Задача не найдена', 404);
      return store.suiteFor(v, work, property);
    });
  }
  /** Начать операцию подтверждения или вернуть её прежний исход по ключу. */
  begin(ref: { suite: CheckSuite }, key: string) {
    return domain(() => this.store.begin(ref.suite, key));
  }
  heartbeat(suiteId: string, key: string, token: string) {
    return domain(() => this.store.heartbeat(suiteId, key, token));
  }
  end(suiteId: string, key: string, token: string) {
    return domain(() => this.store.end(suiteId, key, token));
  }
  /** Запись решения и версии под владением операции; принятие — задачами `tasks`. */
  record(
    suite: CheckSuite,
    key: string,
    token: string,
    decision: Parameters<CorpusStore['record']>[3],
    blobFor: (content: string) => string,
    adopt: { tasks: string[]; actor: string; manual?: boolean },
  ) {
    const { tasks, ...rest } = adopt;
    return domain(() =>
      this.store.record(suite, key, token, decision, blobFor, { ...rest, works: tasks }),
    );
  }
  /** Случаи закреплённой версии и её канонический файл: их исполняет gate. */
  snapshot(binding: NonNullable<Task['checkVersion']>) {
    return this.read((store, v) => store.snapshot(v, binding));
  }
  /** Принятие версии задачами — одна транзакция с удержанием выдачи. */
  adopt(suiteId: string, pendingId: string) {
    return domain(() => this.store.adopt(suiteId, pendingId));
  }
  /** Запрос принятия версии; в operator mode его подтверждает человек. */
  request(
    suiteId: string,
    ref: { number?: number; digest?: string },
    tasks: string[],
    actor: string,
    reason: string,
    manual = false,
  ) {
    return domain(() => this.store.request(suiteId, ref, tasks, actor, reason, manual));
  }
  /** Подтверждение человеком принятия, ждущего оператора. */
  approveAdoption(suiteId: string, pendingId: string) {
    return domain(() => this.store.approveAdoption(suiteId, pendingId));
  }
  /** Продолжить отложенные принятия: задача освободилась. Ничего не запускает. */
  resume() {
    domain(() => this.store.resume());
  }
  /** Снять удержание своей операции принятия. */
  abandon(suiteId: string, pendingId: string, operation: string) {
    return domain(() => this.store.abandon(suiteId, pendingId, operation));
  }
}

/**
 * Объединение корпусов двух клонов. Корпус — только дополняемые факты:
 * случаи, решения, версии и принятия объединяются по id (версии — по digest).
 * Один и тот же факт с разным содержимым и одинаковый вход с разным
 * ожиданием — конфликт: молча выбрать одно значит переписать принятое.
 * Номер версии — порядковый номер в истории клона; идентичность — digest.
 */
export function mergeSuites(
  base: PortableSuite | undefined,
  local: PortableSuite | undefined,
  remote: PortableSuite | undefined,
): PortableSuite | undefined {
  // Порядок предпочтения при совпадении фактов: Git (remote), затем базовая
  // точка прошлого sync, затем локальная проекция.
  const sides = [local, base, remote].filter((x): x is PortableSuite => !!x);
  if (!sides.length) return undefined;
  const [first] = sides;
  for (const side of sides)
    for (const key of [
      'id',
      'repositoryId',
      'contractId',
      'contractDigest',
      'gate',
      'basis',
    ] as const)
      if (side[key] !== first[key]) throw new Error(`Конфликт корпуса ${first.id}: поле ${key}`);
  // Идентичность факта — нормативные поля. Диагностический текст (причины,
  // вывод реализации) в неё не входит: разные установки очищают его по своим
  // локальным корням, а прежние версии могли сохранить его неочищенным. При
  // расхождении только в диагностике остаётся значение из Git — все клоны
  // сходятся к нему, уже опубликованная история не переписывается.
  const union = <T>(
    pick: (s: PortableSuite) => T[],
    id: (x: T) => string,
    what: string,
    normative: (x: T) => unknown = (x) => x,
  ) => {
    const out = new Map<string, T>();
    for (const side of sides)
      for (const item of pick(side)) {
        const key = id(item);
        const seen = out.get(key);
        if (seen && canonicalJson(normative(seen)) !== canonicalJson(normative(item)))
          throw new Error(`Конфликт корпуса ${first.id}: ${what} ${key} различается`);
        out.set(key, item);
      }
    return [...out.values()];
  };
  const cases = union(
    (s) => s.cases,
    (c) => c.id,
    'случай',
  ).sort((a, b) => a.id.localeCompare(b.id));
  for (const c of cases) {
    const other = cases.find((x) => x !== c && x.property === c.property && x.input === c.input);
    if (other && other.expected !== c.expected)
      throw new Error(
        `Конфликт корпуса ${first.id}: вход ${c.input.slice(0, 120)} свойства ${c.property} имеет разные ожидания`,
      );
  }
  return {
    ...first,
    cases,
    versions: union(
      (s) => s.versions,
      (v) => v.digest,
      'версия',
      (v) => ({ ...v, reason: undefined }),
    ).sort(
      (a, b) =>
        a.number - b.number ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.digest.localeCompare(b.digest),
    ),
    decisions: union(
      (s) => s.decisions,
      (d) => d.id,
      'решение',
      (d) => ({
        ...d,
        reason: undefined,
        observed: d.observed && { ...d.observed, actual: undefined },
        claimed: d.claimed && { ...d.claimed, actual: undefined },
      }),
    ).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)),
    adoptions: union(
      (s) => s.adoptions,
      (a) => a.id,
      'принятие',
      (a) => ({ ...a, reason: undefined }),
    ).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)),
  };
}

/** Локальная запись из переносимой; локальные операции клона сохраняются. */
export function localSuite(portable: PortableSuite, previous?: CheckSuite): CheckSuite {
  const decisions = portable.decisions.map((d) => {
    // Значение из Git, включая диагностику; локально остаётся только команда
    // checker, которая в Git не уходит.
    const own = previous?.decisions.find((x) => x.id === d.id);
    return own?.method ? { ...d, method: { ...own.method, ...d.method } } : d;
  });
  return {
    ...portable,
    cases: Object.fromEntries(portable.cases.map((c) => [c.id, c])),
    decisions,
    pending: previous?.pending ?? [],
    operations: previous?.operations ?? {},
    revision: (previous?.revision ?? 0) + 1,
  };
}
