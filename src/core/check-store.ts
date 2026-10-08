import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute } from 'node:path';
import { DomainError, type DevContourState, type Task } from './model.ts';
import { digest, type DevContour } from './service.ts';
import { obligationOf } from './checks.ts';
export { effectiveChecks } from './checks.ts';

/**
 * Версионируемый корпус подтверждённых случаев.
 *
 * Воспроизведение из находки ревью — наблюдение: `observed` значит только,
 * что контур видел запуск команды, а не что ожидаемый ответ верен. Реестр
 * воспроизведений ограничен последними записями, а подсказка исполнителю —
 * двадцатью; обязательный набор на них держаться не может. Здесь хранится
 * обязательство: случай подтверждён закреплённым эталоном на дефектном SHA,
 * вошёл в неизменяемую добавочную версию корпуса, и задача приняла эту
 * версию отдельной операцией. Удаление диагностической записи регрессию не
 * удаляет.
 *
 * Корпус — запись владельца компонента (локальная таблица его БД); в общий
 * coordinator тела случаев не попадают. Переносится через Git записью
 * `checks/` (см. sync-model).
 */
export interface CorpusCase {
  id: string;
  property: string;
  /** Канонический JSON входа: ключи объектов отсортированы, порядок массивов сохранён. */
  input: string;
  /** Ожидание — ответ закреплённого эталона, а не слова ревьюера. */
  expected: string;
  source: {
    kind: 'oracle';
    decision: string;
    sha: string;
    runId?: string;
    taskId?: string;
    reproduction?: string;
  };
  addedAt: string;
}
export interface CorpusVersion {
  number: number;
  /** sha256 канонического файла корпуса этой версии. */
  digest: string;
  previous: string | null;
  /** Полный манифест: id всех случаев версии. */
  cases: string[];
  /** Git blob канонического файла в репозитории компонента. */
  blob: string;
  createdAt: string;
  reason: string;
  decisions: string[];
}
export type DecisionOutcome = 'confirmed' | 'refuted' | 'inconclusive' | 'rejected';
/**
 * Решение проверки примера. История только дополняется: новое решение не
 * переписывает прежнее expected.
 */
export interface CaseDecision {
  id: string;
  key?: string;
  property: string;
  input: string;
  inputHash: string;
  outcome: DecisionOutcome;
  reason: string;
  /** Что утверждал источник: ревьюер, ведущий или оператор. */
  claimed?: { expected: string | null; actual: string | null; reproduction?: string };
  source: { sha: string; runId?: string; taskId?: string };
  /** Что контур наблюдал: ответ эталона и реализации на исходном SHA, по каждому повтору. */
  observed?: {
    expected?: string;
    actual?: string;
    equal?: boolean;
    repeats: number;
    durationsMs: number[];
  };
  /** Метод независимой проверки: закреплённый checker, его команда и основание. */
  method?: {
    gate: string;
    command: string[];
    artifacts: { path: string; blob: string }[];
    contract: string;
    basis: string;
  };
  caseId?: string;
  version?: number;
  origin: { kind: 'review' | 'lead' | 'agent' | 'operator'; runtime?: string };
  at: string;
}
export interface Adoption {
  id: string;
  taskId: string;
  from: { number: number; digest: string } | null;
  to: { number: number; digest: string };
  actor: string;
  reason: string;
  operation: string;
  at: string;
}
/** Отложенное принятие: задача занята попыткой, её выдача удерживается. */
export interface PendingAdoption {
  id: string;
  version: number;
  /**
   * Версия адресуется digest: после объединения клонов номера могут
   * совпадать у разных версий. Нет поля — запись прежнего формата.
   */
  digest?: string;
  /** operator mode: принятие ждёт ручного технического подтверждения. */
  awaitingOperator?: boolean;
  tasks: string[];
  status: 'waiting' | 'completed';
  results: Record<string, string>;
  actor: string;
  reason: string;
  requestedAt: string;
  completedAt?: string;
}
/** Операция подтверждения под владением: lease и token, как у других долгих операций. */
export interface CaseOperation {
  key: string;
  status: 'running' | 'completed';
  token?: string;
  leaseUntil?: number;
  decision?: string;
  startedAt: string;
}
export interface CheckSuite {
  id: string;
  repositoryId: string;
  contractId: string;
  contractDigest: string;
  gate: string;
  /**
   * Смысловая версия основания expected: закреплённые checker/oracle/generator,
   * область входов, правила ответа. Случай с другим основанием — другой случай.
   */
  basis: string;
  cases: Record<string, CorpusCase>;
  versions: CorpusVersion[];
  decisions: CaseDecision[];
  adoptions: Adoption[];
  pending: PendingAdoption[];
  operations: Record<string, CaseOperation>;
  /** Счётчик изменений: CAS для конкурентных добавок. */
  revision: number;
}
export const SUITES = 'check-suites';
/** Предел случая: вход и ожидание вместе. */
export const MAX_CASE_BYTES = 64 * 1024;
/** Предел корпуса целиком: запись переносится через Git одним файлом. */
export const MAX_SUITE_BYTES = 1_500_000;

/**
 * Канонический JSON в рамках объявленного формата: ключи объектов
 * сортируются (порядок ключей в JSON не несёт смысла), порядок массивов
 * сохраняется, числа и строки не смешиваются — `1` и `"1"` разные входы.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, (item as Record<string, unknown>)[key]]),
        )
      : item,
  );
}
export function parseCanonical(text: string, what: string) {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new DomainError(`${what}: не JSON`, 400);
  }
  return canonicalJson(value);
}
/** Канонический файл корпуса версии — его байты дают digest и Git blob. */
export function corpusFile(suite: CheckSuite, cases: string[], number: number) {
  return (
    canonicalJson({
      version: 1,
      suite: suite.id,
      number,
      cases: cases.map((id) => {
        const c = suite.cases[id];
        return {
          id: c.id,
          property: c.property,
          input: JSON.parse(c.input) as unknown,
          expected: JSON.parse(c.expected) as unknown,
        };
      }),
    }) + '\n'
  );
}
/**
 * Убрать локальные пути из диагностики: исключение реализации или эталона
 * называет рабочие каталоги, домашний каталог и временные файлы, а запись
 * корпуса уходит в Git. Нормативные поля (вход, ожидание) не трогаются.
 *
 * Основа — точные локальные корни этой машины (workspace, репозитории,
 * каталог данных, временный и домашний каталоги): это подстановка строк, она
 * не задевает маршруты, URL и соседний текст и идемпотентна. Дополнительно —
 * узкая эвристика: токен без пробелов от типичного пользовательского корня и
 * file://. Путь вне известных корней (например, /data/x) по тексту не отличить
 * от маршрута API, поэтому он не очищается: в причины пишут смысл, а не пути.
 */
const PATH_CHARS = String.raw`[^\s"'\x60<>|,;)\]}]`;
const USER_PATH = new RegExp(
  String.raw`file:\/\/${PATH_CHARS}+` +
    String.raw`|(?<![\w.~:/\\-])(?:\/(?:Users|home)\/|[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/])${PATH_CHARS}*`,
  'gi',
);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function scrubLocalPaths(text: string, roots: string[] = []) {
  let out = text;
  const known = [...new Set(roots.map((r) => r.replace(/[\\/]+$/, '')))]
    .filter((r) => r.length > 1)
    .sort((x, y) => y.length - x.length);
  for (const root of known)
    out = out.replace(
      new RegExp(String.raw`(?<![\w.~/\\-])${escape(root)}(?=$|[\\/\s"'\x60<>|,;:)\]}])`, 'g'),
      '<local-path>',
    );
  return out.replace(USER_PATH, '<local-path>');
}
/** Локальные корни этой установки — и в заданном, и в разрешённом виде. */
export function localRoots(h: DevContour, extra: string[] = []) {
  const given = [
    ...extra,
    h.config.workspaceRoot,
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
  return [...new Set([...given, ...resolved])];
}
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
export const caseId = (property: string, input: string, basis: string) =>
  'K-' + sha256(JSON.stringify([property, input, basis])).slice(0, 32);

/**
 * Версия корпуса по ссылке. Digest однозначен; номер — только если в истории
 * одна версия с ним: после объединения клонов номера могут совпасть.
 */
export function versionOf(suite: CheckSuite, ref: { number?: number; digest?: string }) {
  if (ref.digest) {
    const found = suite.versions.find((v) => v.digest === ref.digest);
    if (!found)
      throw new DomainError(`Версии ${ref.digest.slice(0, 12)} корпуса ${suite.id} нет`, 404);
    if (ref.number !== undefined && found.number !== ref.number)
      throw new DomainError('Номер и digest версии корпуса не совпадают', 409);
    return found;
  }
  const same = suite.versions.filter((v) => v.number === ref.number);
  if (!same.length) throw new DomainError(`Версии ${ref.number} корпуса ${suite.id} нет`, 404);
  if (same.length > 1)
    throw new DomainError(
      `Номер версии ${ref.number} неоднозначен после объединения клонов: укажите digest`,
      409,
    );
  return same[0];
}
export class CheckCorpus {
  constructor(readonly h: DevContour) {}
  all(repositoryId?: string) {
    const owners = repositoryId
      ? [repositoryId]
      : this.h.config.repositories.length
        ? this.h.config.repositories.map((r) => r.id)
        : ['main'];
    return owners.flatMap((owner) =>
      Object.values(this.h.store.localRecords<CheckSuite>(SUITES, owner)),
    );
  }
  get(id: string) {
    const suite = this.all().find((s) => s.id === id);
    if (!suite) throw new DomainError('Корпус проверок не найден: ' + id, 404);
    return suite;
  }
  save(suite: CheckSuite) {
    suite.revision++;
    if (Buffer.byteLength(JSON.stringify(suite)) > MAX_SUITE_BYTES * 2)
      throw new DomainError('Запись корпуса превысила предел хранения', 413);
    this.h.store.saveLocal(SUITES, suite.repositoryId, suite.id, suite);
  }
  /** Корпус договора задачи; создаётся при первом обращении. */
  suiteFor(task: Pick<Task, 'id' | 'contracts' | 'repositoryId'>, property: string) {
    const s = this.h.store.read();
    const found = obligationOf(task, s.contracts, property);
    if (!found) throw new DomainError(`Свойство ${property} не объявлено в договорах задачи`, 400);
    const contract = found.contract;
    const declaration = contract.checks!;
    const id = 'KS-' + contract.id;
    const existing = this.all(task.repositoryId).find((x) => x.id === id);
    if (existing) return { suite: existing, contract, obligation: found.obligation };
    const suite: CheckSuite = {
      id,
      repositoryId: task.repositoryId,
      contractId: contract.id,
      contractDigest: contract.digest,
      gate: declaration.gate,
      basis: digest({
        artifacts: (contract.artifacts ?? []).map((a) => ({ path: a.path, blob: a.blob })),
        gate: declaration.gate,
        obligations: declaration.obligations.map((o) => ({
          property: o.property,
          domain: o.domain,
          answer: o.answer,
          method: o.method,
        })),
      }),
      cases: {},
      versions: [],
      decisions: [],
      adoptions: [],
      pending: [],
      operations: {},
      revision: 0,
    };
    return { suite, contract, obligation: found.obligation };
  }
  /** Последняя версия: наибольший номер, при равных номерах после объединения клонов — поздняя. */
  head(suite: CheckSuite) {
    return [...suite.versions]
      .sort((a, b) => a.number - b.number || a.createdAt.localeCompare(b.createdAt))
      .at(-1);
  }
  /** Случаи закреплённой версии и её канонический файл: их исполняет гейт. */
  snapshot(binding: NonNullable<Task['checkVersion']>) {
    const suite = this.get(binding.suite);
    const version = suite.versions.find((v) => v.digest === binding.digest);
    if (!version)
      throw new DomainError(
        `Версия корпуса ${binding.suite}#${binding.number} не найдена или подменена`,
        409,
      );
    const content = corpusFile(suite, version.cases, version.number);
    if (sha256(content) !== version.digest)
      throw new DomainError(`Корпус ${binding.suite}#${binding.number} не совпадает с digest`, 409);
    return {
      digest: version.digest,
      content,
      cases: version.cases.map((id) => ({ id, property: suite.cases[id].property })),
    };
  }

  /** Начать операцию подтверждения или вернуть её прежний исход по ключу. */
  begin(suiteRef: { suite: CheckSuite }, key: string) {
    return this.h.store.atomic(() => {
      const suite =
        this.all(suiteRef.suite.repositoryId).find((x) => x.id === suiteRef.suite.id) ??
        suiteRef.suite;
      const op = suite.operations[key];
      if (op?.status === 'completed')
        return { done: suite.decisions.find((d) => d.id === op.decision)!, suite };
      if (op?.status === 'running' && op.leaseUntil! > Date.now())
        throw new DomainError('Подтверждение с этим ключом уже выполняется', 409);
      const token = randomUUID();
      suite.operations[key] = {
        key,
        status: 'running',
        token,
        leaseUntil: Date.now() + this.h.config.leaseMs * 4,
        startedAt: new Date().toISOString(),
      };
      this.save(suite);
      return { token, suite };
    });
  }
  heartbeat(suiteId: string, key: string, token: string) {
    this.h.store.atomic(() => {
      const suite = this.get(suiteId);
      const op = suite.operations[key];
      // Истёкший lease не продлевается: владение уже потеряно, и продление
      // вернуло бы право записи тому, кого мог сменить новый владелец.
      if (op?.token !== token || op.status !== 'running' || op.leaseUntil! <= Date.now()) return;
      op.leaseUntil = Date.now() + this.h.config.leaseMs * 4;
      this.save(suite);
    });
  }
  /** Снять владение операцией без решения: она завершилась отказом до проверки. */
  end(suiteId: string, key: string, token: string) {
    this.h.store.atomic(() => {
      const suite = this.all().find((x) => x.id === suiteId);
      const op = suite?.operations[key];
      if (!suite || op?.token !== token || op.status !== 'running') return;
      delete suite.operations[key];
      this.save(suite);
    });
  }
  private guard(suite: CheckSuite, key: string, token: string) {
    const op = suite.operations[key];
    if (op?.status !== 'running' || op.token !== token || op.leaseUntil! <= Date.now())
      throw new DomainError('Владение операцией подтверждения утрачено', 409);
  }

  /**
   * Записать решение и, если случай подтверждён, добавочную версию корпуса
   * и отложенное принятие её задачами. Одна транзакция: решение без версии
   * или версия без решения не возникают. Конкурентная добавка к той же
   * версии не теряется: новая версия строится от текущей головы с
   * повторной проверкой конфликта ожиданий (CAS по номеру головы).
   */
  record(
    suiteRef: CheckSuite,
    key: string,
    token: string,
    decision: Omit<CaseDecision, 'id' | 'at' | 'caseId' | 'version'>,
    blobFor: (content: string) => string,
    adopt: { tasks: string[]; actor: string; manual?: boolean },
  ) {
    return this.h.store.atomic(() => {
      const suite =
        this.all(suiteRef.repositoryId).find((x) => x.id === suiteRef.id) ??
        structuredClone(suiteRef);
      this.guard(suite, key, token);
      const at = new Date().toISOString();
      const made: CaseDecision = { ...decision, id: 'CF-' + randomUUID(), at };
      let pending: PendingAdoption | undefined;
      if (made.outcome === 'confirmed') {
        // Случай сравнивается в каноническом виде, кто бы его ни записал.
        made.input = parseCanonical(made.input, 'вход случая');
        const id = caseId(made.property, made.input, suite.basis);
        const same = Object.values(suite.cases).find(
          (c) => c.property === made.property && c.input === made.input,
        );
        if (same && same.expected !== made.observed!.expected) {
          // Одинаковый вход с другим ожиданием — конфликт, а не выбор одного.
          made.outcome = 'inconclusive';
          made.reason = `конфликт ожиданий: корпус уже содержит ${same.id} с другим ответом`;
        } else {
          const head = this.head(suite);
          const perProperty = Object.values(suite.cases).filter(
            (c) => c.property === made.property,
          ).length;
          const limit = this.declarationOf(suite)?.corpus?.maxCases ?? 500;
          if (!same && perProperty >= limit) {
            made.outcome = 'rejected';
            made.reason = `корпус свойства достиг предела ${limit} случаев: расширьте генератор или эталон обычным изменением договора`;
          } else {
            if (!same)
              suite.cases[id] = {
                id,
                property: made.property,
                input: made.input,
                expected: made.observed!.expected!,
                source: {
                  kind: 'oracle',
                  decision: made.id,
                  sha: made.source.sha,
                  runId: made.source.runId,
                  taskId: made.source.taskId,
                  reproduction: made.claimed?.reproduction,
                },
                addedAt: at,
              };
            made.caseId = same?.id ?? id;
            if (!head?.cases.includes(made.caseId)) {
              // Версия — все подтверждённые случаи корпуса: после объединения
              // клонов новая версия не теряет случаев другой ветки истории.
              const cases = Object.values(suite.cases)
                .sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.id.localeCompare(b.id))
                .map((c) => c.id);
              const number = Math.max(0, ...suite.versions.map((v) => v.number)) + 1;
              const content = corpusFile(suite, cases, number);
              if (Buffer.byteLength(content) > MAX_SUITE_BYTES)
                throw new DomainError('Корпус превысил предел размера', 413);
              suite.versions.push({
                number,
                digest: sha256(content),
                previous: head?.digest ?? null,
                cases,
                blob: blobFor(content),
                createdAt: at,
                reason: `подтверждён случай ${made.caseId} свойства ${made.property}`,
                decisions: [made.id],
              });
            }
            made.version = this.head(suite)!.number;
            if (adopt.tasks.length) {
              pending = {
                id: 'AD-' + randomUUID(),
                version: made.version,
                digest: this.head(suite)!.digest,
                ...(adopt.manual ? { awaitingOperator: true } : {}),
                tasks: adopt.tasks,
                status: 'waiting',
                results: {},
                actor: adopt.actor,
                reason: made.reason,
                requestedAt: at,
              };
              suite.pending.push(pending);
              if (pending.awaitingOperator) this.holdForOperator(pending, suite.id);
            }
          }
        }
      }
      suite.decisions.push(made);
      suite.operations[key] = {
        ...suite.operations[key],
        status: 'completed',
        token: undefined,
        leaseUntil: undefined,
        decision: made.id,
      };
      this.save(suite);
      return { decision: made, suite, pending };
    });
  }
  private declarationOf(suite: CheckSuite) {
    return this.h.store.read().contracts.find((c) => c.id === suite.contractId)?.checks;
  }

  /**
   * Принять версию корпуса явно перечисленными задачами.
   *
   * Посередине активной попытки принятие недопустимо: выдача задачи
   * удерживается, и принятие завершится после окончания попытки. Принятая
   * задача не меняется — для неё нужен маршрут корректировки. Повтор
   * идемпотентен; снимается только собственное удержание операции.
   */
  adopt(suiteId: string, pendingId: string) {
    // Событие журнала несёт только id и итоги: тела случаев корпуса в журнал
    // (и в опрашиваемое состояние, и в coordinator) не попадают.
    this.h.store.change('checks.adopted', (s) => {
      const suite = this.get(suiteId);
      const pending = suite.pending.find((p) => p.id === pendingId);
      if (!pending) throw new DomainError('Принятие версии не найдено', 404);
      if (pending.status === 'completed') return undefined;
      if (pending.awaitingOperator)
        throw new DomainError(
          `Принятие ${pending.id} ждёт ручного технического подтверждения (operator mode): devcontour checks-approve --suite ${suite.id} --pending ${pending.id}`,
          409,
        );
      const version = versionOf(suite, { number: pending.version, digest: pending.digest });
      const operation = 'checks:' + pending.id;
      const waiting: string[] = [];
      for (const id of pending.tasks) {
        if (pending.results[id] && !pending.results[id].startsWith('ждёт')) continue;
        const t = s.tasks.find((x) => x.id === id);
        const verdict = this.adoptable(s, suite, t, version);
        if (verdict === 'busy') {
          if (t!.hold && t!.hold.operation !== operation) {
            pending.results[id] = `ждёт: задачу удерживает ${t!.hold.operation}`;
            waiting.push(id);
            continue;
          }
          t!.hold = {
            operation,
            reason: `Принимается версия корпуса ${suite.id}#${version.number}`,
          };
          pending.results[id] = 'ждёт окончания попытки';
          waiting.push(id);
          continue;
        }
        if (verdict !== 'ok') {
          pending.results[id] = verdict;
          if (t?.hold?.operation === operation) t.hold = undefined;
          continue;
        }
        const from = t!.checkVersion
          ? { number: t!.checkVersion.number, digest: t!.checkVersion.digest }
          : null;
        t!.checkVersion = { suite: suite.id, number: version.number, digest: version.digest };
        if (t!.hold?.operation === operation) t!.hold = undefined;
        suite.adoptions.push({
          id: 'AA-' + randomUUID(),
          taskId: id,
          from,
          to: { number: version.number, digest: version.digest },
          actor: pending.actor,
          reason: scrubLocalPaths(pending.reason, localRoots(this.h)),
          operation: pending.id,
          at: new Date().toISOString(),
        });
        pending.results[id] = 'принята';
      }
      if (!waiting.length) {
        pending.status = 'completed';
        pending.completedAt = new Date().toISOString();
      }
      this.save(suite);
      return {
        suite: suite.id,
        pending: pending.id,
        status: pending.status,
        results: pending.results,
      };
    });
    const suite = this.get(suiteId);
    return { pending: suite.pending.find((p) => p.id === pendingId)!, suite };
  }
  private adoptable(
    s: DevContourState,
    suite: CheckSuite,
    t: Task | undefined,
    version: CorpusVersion,
  ): string {
    if (!t) return 'задача не найдена';
    if (!t.contracts.includes(suite.contractId))
      return 'задача не привязана к договору этого корпуса';
    if (!t.properties?.length)
      return 'механизм договора проверки для задачи не включён: включение проходит ревью плана';
    if (t.status === 'done')
      return 'задача уже принята: её история не меняется, нужна корректировка';
    if (t.status === 'cancelled') return 'задача отменена';
    if (!t.approvedDigest) return 'задача не утверждена';
    for (const b of s.boards)
      for (const r of b.revisions)
        if (r.status === 'accepted' && r.taskIds.includes(t.id))
          return 'задача входит в принятую ревизию';
    if (t.checkVersion && t.checkVersion.suite !== suite.id)
      return `задача закреплена за другим корпусом ${t.checkVersion.suite}`;
    if (t.checkVersion) {
      const current = suite.versions.find((v) => v.digest === t.checkVersion!.digest);
      if (current && version.cases.every((id) => current.cases.includes(id))) return 'принята';
      // Принятие не сужает корпус задачи: версия из другой ветки истории без
      // её случаев понизила бы обязательный набор.
      if (current && !current.cases.every((id) => version.cases.includes(id)))
        return 'версия не содержит всех случаев, уже принятых задачей';
    }
    if (t.activeRunId) return 'busy';
    return 'ok';
  }
  /**
   * Явно принять уже существующую версию корпуса перечисленными задачами —
   * например, соседней задачей того же договора. Новых случаев не создаёт.
   */
  request(
    suiteId: string,
    ref: { number?: number; digest?: string },
    tasks: string[],
    actor: string,
    reason: string,
    /** operator mode: агент только запрашивает, подтверждает человек. */
    manual = false,
  ) {
    const pending = this.h.store.atomic(() => {
      const suite = this.get(suiteId);
      const version = versionOf(suite, ref);
      if (!tasks.length) throw new DomainError('Перечислите задачи, принимающие версию', 400);
      const made: PendingAdoption = {
        id: 'AD-' + randomUUID(),
        version: version.number,
        digest: version.digest,
        tasks,
        status: 'waiting',
        results: {},
        actor,
        reason: scrubLocalPaths(reason, localRoots(this.h)),
        requestedAt: new Date().toISOString(),
        ...(manual ? { awaitingOperator: true } : {}),
      };
      suite.pending.push(made);
      if (manual) this.holdForOperator(made, suite.id);
      this.save(suite);
      return made;
    });
    if (manual) return { pending, suite: this.get(suiteId) };
    return this.adopt(suiteId, pending.id);
  }
  /**
   * В operator mode выдача перечисленных незавершённых задач удерживается до
   * ручного подтверждения: иначе следующая попытка шла бы без нового корпуса.
   */
  private holdForOperator(pending: PendingAdoption, suiteId: string) {
    this.h.store.change('checks.awaiting-operator', (s) => {
      for (const t of s.tasks)
        if (pending.tasks.includes(t.id) && !t.hold && !['done', 'cancelled'].includes(t.status))
          t.hold = {
            operation: 'checks:' + pending.id,
            reason: `Принятие версии корпуса ${suiteId} ждёт подтверждения оператора`,
          };
      return { pending: pending.id };
    });
  }
  /**
   * Ручное техническое подтверждение принятия (operator mode). Вызывается
   * человеком через CLI или панель, а не агентским API.
   */
  approveAdoption(suiteId: string, pendingId: string) {
    this.h.store.atomic(() => {
      const suite = this.get(suiteId);
      const pending = suite.pending.find((p) => p.id === pendingId);
      if (!pending) throw new DomainError('Принятие версии не найдено', 404);
      if (!pending.awaitingOperator) return;
      pending.awaitingOperator = undefined;
      pending.actor += ' + operator';
      this.save(suite);
    });
    return this.adopt(suiteId, pendingId);
  }
  /** Продолжить отложенные принятия: задача освободилась. Ничего не запускает. */
  resume() {
    for (const suite of this.all())
      for (const pending of suite.pending.filter(
        (p) => p.status === 'waiting' && !p.awaitingOperator,
      ))
        try {
          this.adopt(suite.id, pending.id);
        } catch {
          // Принятие повторится на следующем такте; причина остаётся в записи.
        }
  }
  /**
   * Снять удержание операции принятия. Только своё: чужая операция или
   * просроченный владелец чужое удержание не снимают.
   */
  abandon(suiteId: string, pendingId: string, operation: string) {
    return this.h.store.change('checks.adoption-abandoned', (s) => {
      const suite = this.get(suiteId);
      const pending = suite.pending.find((p) => p.id === pendingId);
      if (!pending) throw new DomainError('Принятие версии не найдено', 404);
      if (operation !== 'checks:' + pending.id)
        throw new DomainError('Операция не владеет этим принятием', 409);
      for (const t of s.tasks) if (t.hold?.operation === operation) t.hold = undefined;
      pending.status = 'completed';
      pending.completedAt = new Date().toISOString();
      for (const id of pending.tasks)
        if (pending.results[id]?.startsWith('ждёт')) pending.results[id] = 'отменено';
      this.save(suite);
      return { pending: pending.id };
    });
  }
}

/**
 * Переносимая форма корпуса для Git. Локальные операции (lease, token,
 * отложенные принятия) и исполняемая конфигурация (команда checker) не
 * переносятся: команда остаётся локальной политикой, и ссылка на artifact
 * сама по себе права исполнения не даёт.
 */
export type PortableSuite = Omit<
  CheckSuite,
  'cases' | 'pending' | 'operations' | 'revision' | 'decisions'
> & {
  cases: CorpusCase[];
  decisions: (Omit<CaseDecision, 'method'> & {
    method?: Omit<NonNullable<CaseDecision['method']>, 'command'>;
  })[];
};
export function portableSuite(suite: CheckSuite, roots: string[] = []): PortableSuite {
  return scrubPortable(
    {
      id: suite.id,
      repositoryId: suite.repositoryId,
      contractId: suite.contractId,
      contractDigest: suite.contractDigest,
      gate: suite.gate,
      basis: suite.basis,
      cases: Object.values(suite.cases).sort((a, b) => a.id.localeCompare(b.id)),
      decisions: suite.decisions.map(({ method, ...d }) =>
        method
          ? {
              ...d,
              method: {
                gate: method.gate,
                artifacts: method.artifacts,
                contract: method.contract,
                basis: method.basis,
              },
            }
          : d,
      ),
      versions: suite.versions,
      adoptions: suite.adoptions,
    },
    roots,
  );
}

/**
 * Диагностические поля проходят очистку путей и на экспорте, и на чтении из
 * Git: запись прежней версии могла сохранить их до появления очистки. Очистка
 * идемпотентна, нормативные поля (вход, ожидание, digest) не меняются, поэтому
 * прежняя и очищенная записи одного факта сравниваются как равные.
 */
export function scrubPortable(suite: PortableSuite, roots: string[] = []): PortableSuite {
  const scrub = (text: string) => scrubLocalPaths(text, roots);
  return {
    ...suite,
    decisions: suite.decisions.map((d) => ({
      ...d,
      reason: scrub(d.reason),
      ...(d.observed
        ? {
            observed: {
              ...d.observed,
              ...(d.observed.actual !== undefined ? { actual: scrub(d.observed.actual) } : {}),
            },
          }
        : {}),
      ...(d.claimed
        ? {
            claimed: {
              ...d.claimed,
              actual: d.claimed.actual === null ? null : scrub(d.claimed.actual),
            },
          }
        : {}),
    })),
    versions: suite.versions.map((v) => ({ ...v, reason: scrub(v.reason) })),
    adoptions: suite.adoptions.map((a) => ({ ...a, reason: scrub(a.reason) })),
  };
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
  roots: string[] = [],
): PortableSuite | undefined {
  // Стороны сравниваются в очищенном виде: запись из Git прежней версии с
  // путём в диагностике — тот же факт, а не конфликт истории.
  const sides = [base, local, remote]
    .filter((x): x is PortableSuite => !!x)
    .map((side) => scrubPortable(side, roots));
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
  const union = <T>(pick: (s: PortableSuite) => T[], id: (x: T) => string, what: string) => {
    const out = new Map<string, T>();
    for (const side of sides)
      for (const item of pick(side)) {
        const key = id(item);
        const seen = out.get(key);
        if (seen && canonicalJson(seen) !== canonicalJson(item))
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
    ).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)),
    adoptions: union(
      (s) => s.adoptions,
      (a) => a.id,
      'принятие',
    ).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)),
  };
}

/**
 * Проверка переносимого корпуса: каждая версия собирается из своих случаев в
 * канонический файл, и его digest совпадает с записанным. Запись, где версия
 * ссылается на отсутствующий случай или подменён digest, не принимается.
 */
export function verifySuite(suite: PortableSuite) {
  const local: CheckSuite = {
    ...suite,
    cases: Object.fromEntries(suite.cases.map((c) => [c.id, c])),
    decisions: suite.decisions as CaseDecision[],
    pending: [],
    operations: {},
    revision: 0,
  };
  const contents = new Map<string, string>();
  for (const v of suite.versions) {
    const missing = v.cases.filter((id) => !local.cases[id]);
    if (missing.length)
      throw new Error(`Версия ${v.number} корпуса ${suite.id} ссылается на отсутствующие случаи`);
    const content = corpusFile(local, v.cases, v.number);
    if (sha256(content) !== v.digest)
      throw new Error(`Digest версии ${v.number} корпуса ${suite.id} не совпадает с её случаями`);
    contents.set(v.digest, content);
  }
  for (const c of suite.cases)
    if (c.id !== caseId(c.property, c.input, suite.basis))
      throw new Error(
        `Id случая ${c.id} корпуса ${suite.id} не соответствует его входу и основанию`,
      );
  return contents;
}
/** Локальная запись из переносимой; локальные операции клона сохраняются. */
export function localSuite(portable: PortableSuite, previous?: CheckSuite): CheckSuite {
  const decisions = portable.decisions.map((d) => {
    const own = previous?.decisions.find((x) => x.id === d.id);
    return (own ?? d) as CaseDecision;
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
