import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { fencedRefMove } from 'devcontour-harness';
import { executionOf } from '../harness/execution.ts';
import { DomainError, type Contract } from '../core/model.ts';
import { contractDigest, digest, latestRedaction, type DevContour } from '../core/service.ts';
import { consolidationPlan, reviewConsolidation } from './consolidation.ts';
import { repositories, repository } from '../core/repositories.ts';
import {
  contractContent,
  assertDeclaration,
  contractProposal,
  parseProposal,
  defaultOwner,
  reviewContract,
  reviewPlan,
} from './agent-control.ts';
import { adapters, type AgentAdapter } from './adapters.ts';
import { pinArtifacts } from './contract-artifacts.ts';
import { contractImpact } from './contract-impact.ts';
import { STALE_BASE, updateBase } from './base-update.ts';
import { planRepin, stalePins } from './context.ts';
import { applyConfig, busyWork } from './reconfigure.ts';
import { loadConfig } from './config.ts';
import { loadedDigest } from '../core/service.ts';
import { git, isAncestor } from './process.ts';
import { queueStopView } from '../core/work-status.ts';
import {
  siblingContractLifts,
  siblingLiftHolds,
  type SiblingContractLift,
} from './sensitive-paths.ts';

/**
 * Изменение контракта как сохраняемая операция.
 *
 * Раньше это была цепочка ручных команд ведущего: ревью, перепривязка задач,
 * повторное ревью плана, перенос базы. Ошибка в порядке останавливала
 * очередь или запускала задачу на старой редакции, а прерывание оставляло
 * неизвестно какое состояние. Здесь каждый шаг идемпотентен и выполняется
 * только действующим владельцем операции (lease и token); прогресс
 * сохраняется после каждого шага, и после сбоя операция продолжается с того
 * же места, не повторяя необратимого. У Git, SQLite и внешнего ревью нет общей
 * транзакции — согласованность держат ожидаемые digest и SHA, а не атомарность.
 */
/**
 * Порядок шагов. База переносится до ревью планов: рецензент плана видит
 * задачи на той базе, с которой они будут выполняться, — с новой редакцией
 * контракта и её артефактами. При обратном порядке он видел прежнюю базу без
 * них и справедливо отклонял план. Шаг хранится индексом, поэтому операция,
 * начатая при прежнем порядке (без order), продолжает по нему.
 */
/**
 * Третий порядок: после переноса базы операция сама перезакрепляет context
 * packs, закрепляющие источник контракта (`context`), и применяет новую
 * конфигурацию в работающем сервере (`reconfigure`) — с ожидаемым digest,
 * после drain и под своей паузой. Прежде это делал человек командами
 * context-lock и перезапуском сервера, вне владения операции.
 */
const orders = {
  1: ['hold', 'drain', 'review', 'rebind', 'plan', 'base', 'release'],
  2: ['hold', 'drain', 'review', 'rebind', 'base', 'plan', 'release'],
  3: ['hold', 'drain', 'review', 'rebind', 'base', 'context', 'reconfigure', 'plan', 'release'],
} as const;
/**
 * Консолидация (F20): тот же порядок без перепривязки и ревью планов —
 * смысл договора не меняется, задачи сохраняют привязку и утверждение.
 * Удержание и drain остаются: перенос базы и перезакрепление context packs
 * не должны пройти под идущей попыткой.
 */
const consolidateOrder = [
  'hold',
  'drain',
  'review',
  'base',
  'context',
  'reconfigure',
  'release',
] as const satisfies readonly Step[];
type Step = (typeof orders)[3][number];
const stepsOf = (op: { order?: 2 | 3; mode?: 'consolidate' }): readonly Step[] =>
  op.mode === 'consolidate' ? consolidateOrder : orders[op.order ?? 1];

export type ContractChange = {
  id: string;
  /** Контракт, который меняется: компонент и источник. Одна операция на него. */
  key: string;
  owner: string;
  proposal: z.infer<typeof contractProposal>;
  authorRuntime: 'codex' | 'claude';
  expected: { head: string; proposedDigest: string; current: string | null };
  step: number;
  /** Порядок шагов; отсутствует у операций, начатых при первом порядке. */
  order?: 2 | 3;
  /**
   * `consolidate` — консолидация документа без изменения смысла (F20): свой
   * порядок шагов, предпроверки равносильности и ревью `consolidationReview`,
   * регистрация с `consolidates`. Нет поля — изменение контракта.
   */
  mode?: 'consolidate';
  /**
   * Digest `config.json` до и после перезакрепления: на них сверяются запись
   * файла и применение конфигурации; по ним повтор узнаёт сделанное.
   */
  config?: { before: string; after?: string };
  status:
    | 'queued'
    | 'running'
    | 'waiting'
    | 'failed'
    | 'completed'
    | 'stale'
    | 'abandoned'
    | 'superseded';
  /** Версия записи: пересмотр сверяет ожидаемую версию. */
  version?: number;
  /**
   * Прежние редакции этой операции: что ревьюировалось и чем закончилось.
   * Пересмотр не стирает историю, а добавляет к ней.
   */
  revisions?: {
    at: string;
    head: string;
    digest: string;
    /** Digest файла предложения, по которому шла эта редакция. */
    proposal?: string;
    reason: string;
    reviews: { id: string; approved: boolean; summary: string }[];
  }[];
  /**
   * Попытки ревью контракта, проведённые этой операцией (id `contractAttempts`).
   * История ревью связывается с операцией, а не с названием: у другого
   * контракта может быть то же название. У операций прежних версий поля нет.
   */
  reviews?: string[];
  /** Подготовленные новые черновики, явно включённые в ревью плана для утверждения. */
  include?: string[];
  /**
   * Перенос базы соседней операцией, принёсший одобренную редакцию этой как
   * соседнюю: её id и новая вершина базы.
   */
  carriedBy?: { operation: string; base: string };
  /** Связанная редакция: операция, которую эта продолжила после побочных эффектов. */
  previous?: string;
  next?: string;
  waitingFor?: string[];
  token?: string;
  leaseUntil?: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  contractId?: string;
  held: string[];
  rebound: string[];
  boards: string[];
  /** Принятые задачи прежней редакции: их меняет корректировка, а не операция. */
  corrections: string[];
  history: {
    at: string;
    step: Step | 'start';
    event: string;
    detail?: string;
    /**
     * Попытка ревью, на которой закончился шаг: полный текст её итога и
     * находок — `GET /api/contract-attempts/:id/findings` и запись `artifact`.
     */
    review?: { id: string; artifact: string };
  }[];
};

/**
 * Сократить текст до `n` знаков по границе фразы или слова, с «…».
 *
 * История операции хранится в записи и ограничена по размеру, но обрыв
 * посреди слова делал причину отказа нечитаемой. Граница предложения берётся,
 * если она не дальше трети предела от конца, иначе — последний пробел.
 * Полный текст ревью доступен по ссылке `review` записи истории.
 */
export function clipAtBoundary(text: string, n: number) {
  if (text.length <= n) return text;
  // Не разрезать суррогатную пару: половина символа в JSON — мусор.
  let end = n - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  const head = text.slice(0, end);
  const sentence = Math.max(...['. ', '; ', '! ', '? ', '.\n'].map((m) => head.lastIndexOf(m)));
  const space = head.search(/\s\S*$/);
  const cut = sentence >= (n * 2) / 3 ? sentence + 1 : space > n / 3 ? space : head.length;
  return head.slice(0, cut).trimEnd() + '…';
}
/** Предел подробности записи истории и текста ошибки операции. */
const DETAIL = 500;
const ERROR = 1000;

const KIND = 'contract-change';
const active = (op: ContractChange) =>
  ['queued', 'running', 'waiting', 'failed'].includes(op.status);

/** Представление операции наружу; `continued` — соседи, продолженные вслед за ней. */
export type ContractChangeView = Omit<ContractChange, 'token' | 'leaseUntil'> & {
  next: Step | null;
  continued?: ContractChangeView[];
};

export class ContractChanges {
  /** Предел git update-ref внутри транзакции: зависший Git не держит базу контура. */
  static refMoveTimeoutMs = 15000;
  /** Сколько шаг ждёт подтверждения применения работающим сервером. */
  static reconfigureWaitMs = 30000;
  constructor(
    readonly h: DevContour,
    readonly root: string,
    readonly runtimes: Record<'codex' | 'claude', AgentAdapter> = adapters,
    /** Точка после шага: тест моделирует в ней сбой процесса. */
    readonly afterStep: (step: Step) => void = () => {},
  ) {}
  /** Кого ждала операция до текущего продолжения (по id операции). */
  private readonly waited = new Map<string, string[]>();
  /** Операции всех компонентов; чтение без lease и без записи. */
  list() {
    return repositories(this.h.config).flatMap((r) =>
      Object.values(this.h.store.localRecords<ContractChange>(KIND, r.id)),
    );
  }
  get(id: string) {
    const op = this.list().find((x) => x.id === id);
    if (!op) throw new DomainError('Операция изменения контракта не найдена', 404);
    return op;
  }
  private save(op: ContractChange) {
    op.version = (op.version ?? 0) + 1;
    this.h.store.saveLocal(KIND, op.owner, op.id, op);
  }
  private log(
    op: ContractChange,
    step: ContractChange['history'][number]['step'],
    event: string,
    detail?: string,
    review?: { id: string; artifact: string },
  ) {
    op.history.push({
      at: new Date().toISOString(),
      step,
      event,
      ...(detail ? { detail: clipAtBoundary(detail, DETAIL) } : {}),
      ...(review ? { review } : {}),
    });
    op.history = op.history.slice(-100);
  }
  /** Внешнее представление: без token и lease. */
  view(op: ContractChange): ContractChangeView {
    const { token, leaseUntil, ...rest } = op;
    void token;
    void leaseUntil;
    return { ...rest, next: stepsOf(op)[op.step] ?? null };
  }

  /** Начать операцию или вернуть уже идущую по тому же предложению. */
  async start(
    input: unknown,
    authorRuntime: 'codex' | 'claude',
    include: string[] = [],
    mode?: 'consolidate',
  ) {
    if (this.h.config.approvalMode === 'operator')
      throw new DomainError(
        'В режиме operator изменение контракта проводит оператор: ревью ждёт его подтверждения',
        409,
      );
    if (mode === 'consolidate' && include.length)
      throw new DomainError(
        'Консолидация не меняет задачи и не проводит ревью планов: --include к ней не относится',
        400,
      );
    const proposal = parseProposal(input);
    const impact = await contractImpact(this.h, proposal);
    if (impact.status === 'unchanged') return { status: 'unchanged' as const, impact };
    // Отказ до удержания задач и ревью: новая редакция с незащищённым
    // helper приёмки не была бы одобрена всё равно, а документ сверх предела
    // не был бы зарегистрирован.
    if (impact.size.refusal) throw new DomainError(impact.size.refusal, 400);
    if (impact.closure.refusal) throw new DomainError(impact.closure.refusal, 400);
    // Операция не заводит параллельный контракт для файла, который уже
    // зарегистрирован под другим компонентом: задачи прежнего остались бы
    // привязаны к нему.
    if ('registeredUnder' in impact && impact.registeredUnder?.length)
      throw new DomainError(impact.warning!, 409);
    // Предпроверки равносильности — до удержаний и до вызова модели.
    if (mode === 'consolidate') await consolidationPlan(this.h, proposal, impact.proposed.revision);
    const owner = impact.repositoryId;
    const key = digest({ owner, source: proposal.file ?? `title:${proposal.title}` });
    return this.h.store.atomic(() => {
      const existing = this.list().find((x) => x.key === key && active(x));
      if (existing) {
        if (existing.expected.proposedDigest !== impact.proposed.digest || existing.mode !== mode)
          throw new DomainError(
            `Контракт уже меняет операция ${existing.id} по другой редакции${existing.mode === 'consolidate' ? ' (консолидация)' : ''}; продолжите или отмените её`,
            409,
          );
        return { status: 'existing' as const, operation: existing };
      }
      const op: ContractChange = {
        id: 'CC-' + randomUUID(),
        key,
        owner,
        proposal,
        authorRuntime,
        expected: {
          head: impact.proposed.revision,
          proposedDigest: impact.proposed.digest,
          current: impact.current?.id ?? null,
        },
        step: 0,
        order: 3,
        ...(mode ? { mode } : {}),
        status: 'queued',
        startedAt: new Date().toISOString(),
        held: [],
        rebound: [],
        boards: [],
        corrections: [],
        history: [],
        ...(include.length ? { include } : {}),
      };
      this.log(
        op,
        'start',
        'queued',
        `${impact.tasks.direct.length} прямых, ${impact.tasks.transitive.length} зависимых задач`,
      );
      for (const w of impact.warnings) this.log(op, 'start', 'warning', w.message);
      this.save(op);
      return { status: 'started' as const, operation: op, warnings: impact.warnings };
    });
  }

  private claim(id: string) {
    return this.h.store.atomic(() => {
      const op = this.get(id);
      // Упавшая операция продолжается с того же шага: шаги идемпотентны, и
      // повтор после исправления причины — штатное продолжение.
      if (!['queued', 'running', 'waiting', 'failed'].includes(op.status)) return undefined;
      if (op.status === 'running' && op.leaseUntil! > Date.now()) return undefined;
      op.status = 'running';
      op.token = randomUUID();
      op.leaseUntil = Date.now() + this.h.config.leaseMs;
      op.waitingFor = undefined;
      op.error = undefined;
      this.save(op);
      return op;
    });
  }
  private guard(op: ContractChange) {
    const current = this.get(op.id);
    if (
      current.status !== 'running' ||
      current.token !== op.token ||
      current.leaseUntil! <= Date.now()
    )
      throw new DomainError('Владение операцией изменения контракта утрачено');
    return current;
  }
  private heartbeat(op: ContractChange) {
    this.h.store.atomic(() => {
      const current = this.guard(op);
      current.leaseUntil = Date.now() + this.h.config.leaseMs;
      this.save(current);
    });
  }
  /** Сохранить результат шага под действующим владением и перейти к следующему. */
  private advanceStep(op: ContractChange, effect: (current: ContractChange) => void = () => {}) {
    return this.h.store.atomic(() => {
      const current = this.guard(op);
      effect(current);
      this.log(current, stepsOf(current)[current.step], 'done');
      current.step++;
      if (current.step >= stepsOf(current).length) {
        current.status = 'completed';
        current.finishedAt = new Date().toISOString();
        current.token = undefined;
        current.leaseUntil = undefined;
      }
      this.save(current);
      return current;
    });
  }
  private settle(
    op: ContractChange,
    status: 'waiting' | 'failed' | 'stale',
    message: string,
    waitingFor?: string[],
    /** Попытка ревью, которой закончился шаг (только из ответа этого ревью). */
    review?: { id: string; artifact: string },
  ) {
    this.h.store.atomic(() => {
      const current = this.get(op.id);
      if (current.token !== op.token || current.status !== 'running') return;
      current.status = status;
      current.error = status === 'waiting' ? undefined : clipAtBoundary(message, ERROR);
      current.waitingFor = waitingFor;
      current.token = undefined;
      current.leaseUntil = undefined;
      const step = stepsOf(current)[current.step];
      if (review) current.reviews = [...new Set([...(current.reviews ?? []), review.id])];
      this.log(current, step, status, message, review);
      this.save(current);
    });
  }

  /**
   * Попытка ревью по каталогу её решения. Ссылка строится только по каталогу,
   * который назвал сам ответ ревью: отказ без нового ревью (сбой модели или
   * транспорта) ссылки не получает, и чужая попытка с тем же названием не
   * подставляется.
   */
  private attemptOf(artifact: string | undefined) {
    if (!artifact) return undefined;
    const attempt = (this.h.store.read().contractAttempts ?? []).find(
      (a) => a.artifact === artifact,
    );
    return attempt ? { id: attempt.id, artifact: attempt.artifact } : undefined;
  }
  /** Ревью этой операции; прежние операции без `reviews` — по названию и началу. */
  private reviewsOf(op: ContractChange) {
    const attempts = this.h.store.read().contractAttempts ?? [];
    return op.reviews
      ? attempts.filter((a) => op.reviews!.includes(a.id))
      : attempts.filter(
          (a) =>
            a.subject.startsWith('contract') &&
            a.title === op.proposal.title &&
            a.at >= op.startedAt,
        );
  }

  /** Продолжить операцию с сохранённого шага, пока она не ждёт, не упала или не завершилась. */
  async advance(id: string): Promise<ContractChangeView> {
    // Кого операция ждала до этого продолжения: claim стирает waitingFor.
    const waited = this.list().find((x) => x.id === id)?.waitingFor;
    const claimed = this.claim(id);
    if (claimed && waited?.length) this.waited.set(id, waited);
    if (!claimed) return this.view(this.get(id));
    let op = claimed;
    const heartbeat = setInterval(
      () => {
        try {
          this.heartbeat(op);
        } catch {
          /* Утраченное владение обнаружит следующий guard. */
        }
      },
      Math.max(1000, this.h.config.leaseMs / 3),
    );
    heartbeat.unref();
    try {
      while (op.status === 'running' && op.step < stepsOf(op).length) {
        const step = stepsOf(op)[op.step];
        // Вход сверяется перед каждым шагом, а не только до ревью: редакция,
        // появившаяся после ревью, иначе ушла бы в базу под чужим одобрением.
        await this.assertInputs(op);
        const outcome = await this.run(step, op);
        if (outcome.wait) {
          this.settle(op, 'waiting', outcome.wait, outcome.waitingFor);
          break;
        }
        op = { ...this.get(op.id), token: op.token };
        this.afterStep(step);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.settle(
        op,
        error instanceof StaleChange ? 'stale' : 'failed',
        message,
        undefined,
        error instanceof ReviewRejected ? this.attemptOf(error.artifact) : undefined,
      );
    } finally {
      clearInterval(heartbeat);
      this.waited.delete(id);
    }
    const result = this.view(this.get(id));
    // Соседи, ждавшие эту операцию на шаге базы, продолжаются сразу: иначе
    // их удержания стояли бы, пока ведущий не вспомнит о каждой.
    const continued: ContractChangeView[] = [];
    for (const waiter of this.list().filter(
      (o) => o.waitingFor?.includes(id) && this.stalledWait(o),
    ))
      continued.push(await this.advance(waiter.id));
    return continued.length ? { ...result, continued } : result;
  }

  /**
   * Пересмотреть предложение по той же операции после отказа ревью.
   *
   * Раньше отклонённый контракт после правки документа требовал отменить
   * операцию и начать новую. Пересмотр берёт текущий закоммиченный HEAD явно
   * — обычное продолжение по прежнему входу его не подхватывает — и сверяет
   * ожидаемую версию записи.
   *
   * До регистрации новой редакции побочных эффектов, кроме удержаний, нет:
   * операция получает новую редакцию входа, прежняя редакция и её ревью
   * остаются в истории, влияние и удержания пересчитываются в одной
   * транзакции без окна выдачи, ревью повторяется. Поздний ответ прежнего
   * ревьюера не утверждает новую редакцию: владение сброшено.
   *
   * После регистрации, перепривязки или переноса базы эти эффекты не
   * отменяются: создаётся связанная следующая операция, которой удержания
   * передаются атомарно, а прежняя помечается заменённой.
   *
   * `input` — исправленный файл предложения (текст или файл, artifacts,
   * checks, underTest) того же контракта. Без него пересмотр берёт прежнее
   * предложение, и исправить, например, отсутствующий договор проверки было
   * нельзя: оставалось отменить операцию и снять удержания. Новое предложение
   * проходит те же предпроверки, что и старт, — закрепление артефактов,
   * замыкание их зависимостей и структуру договора проверки — до записи и до
   * вызова модели.
   */
  async revise(id: string, expectedVersion: number, include?: string[], input?: unknown) {
    const op = this.get(id);
    if ((op.version ?? 0) !== expectedVersion)
      throw new DomainError('Операция изменилась; прочитайте её заново и повторите', 409);
    if (op.status === 'running' && op.leaseUntil! > Date.now())
      throw new DomainError('Операция выполняется; дождитесь окончания шага', 409);
    // Выполняющаяся операция с истёкшим lease — владелец её потерял: пересмотр
    // допустим, его поздний ответ отсечёт проверка владения.
    if (!['failed', 'stale', 'waiting', 'queued', 'running'].includes(op.status))
      throw new DomainError(`Пересмотр недоступен операции в состоянии ${op.status}`, 409);
    const proposal = input === undefined ? op.proposal : parseProposal(input);
    if (op.mode === 'consolidate' && (op.contractId || op.step > stepsOf(op).indexOf('review')))
      throw new DomainError(
        'Консолидация уже зарегистрирована: её не пересматривают. Продолжите её (contract-change --id) или проведите новую консолидацию',
        409,
      );
    if (op.mode === 'consolidate' && include?.length)
      throw new DomainError(
        'Консолидация не меняет задачи и не проводит ревью планов: --include к ней не относится',
        400,
      );
    const impact = await contractImpact(this.h, proposal);
    // Тот же отказ, что у старта: файл, зарегистрированный под другим
    // компонентом, — параллельный контракт, а не новая редакция.
    if ('registeredUnder' in impact && impact.registeredUnder?.length)
      throw new DomainError(impact.warning!, 409);
    if (input !== undefined) {
      // Пересмотр меняет тот же контракт: та же нормализованная идентичность
      // (компонент, источник, repositoryId в том виде, как он записан, и
      // название). Иначе редакция регистрировалась бы рядом с прежней, а
      // задачи оставались бы привязаны к старой.
      const same =
        digest({
          owner: impact.repositoryId,
          source: proposal.file ?? `title:${proposal.title}`,
        }) === op.key &&
        (proposal.repositoryId ?? null) === (op.proposal.repositoryId ?? null) &&
        (proposal.file ?? null) === (op.proposal.file ?? null) &&
        proposal.title === op.proposal.title &&
        // После регистрации действующая редакция — та, что зарегистрировала
        // сама операция: пересмотр продолжается связанной следующей операцией.
        (impact.current?.id ?? null) === (op.contractId ?? op.expected.current);
      if (!same)
        throw new DomainError(
          'Пересмотр меняет тот же контракт: файл, название, repositoryId и компонент должны совпадать с операцией',
          400,
        );
      if (impact.size.refusal) throw new DomainError(impact.size.refusal, 400);
      if (impact.closure.refusal) throw new DomainError(impact.closure.refusal, 400);
      if (proposal.checks) {
        const pinned = await pinArtifacts(
          repository(this.h.config, impact.repositoryId),
          proposal.artifacts ?? [],
          impact.proposed.revision,
          this.h.config.contractArtifacts,
        );
        assertDeclaration(this.h, impact.repositoryId, proposal.checks, pinned.artifacts);
      }
    }
    if (
      impact.proposed.revision === op.expected.head &&
      impact.proposed.digest === op.expected.proposedDigest
    )
      throw new DomainError('Редакция не изменилась: закоммитьте исправленный документ', 400);
    if (impact.status === 'unchanged')
      throw new DomainError('Новая редакция совпадает с утверждённой: менять нечего', 400);
    if (op.mode === 'consolidate')
      await consolidationPlan(this.h, proposal, impact.proposed.revision);
    const effects =
      !!op.contractId || op.rebound.length > 0 || op.step > stepsOf(op).indexOf('review');
    const at = new Date().toISOString();
    const reviews = this.reviewsOf(op).map((a) => ({
      id: a.id,
      approved: a.approved,
      summary: a.summary.slice(0, 500),
    }));
    const held = [...impact.tasks.direct, ...impact.tasks.transitive]
      .filter((t) => !['done', 'cancelled'].includes(t.status))
      .map((t) => t.id);
    return this.h.store.atomic(() => {
      const current = this.get(id);
      if ((current.version ?? 0) !== expectedVersion)
        throw new DomainError('Операция изменилась; прочитайте её заново и повторите', 409);
      const reason = 'Меняется контракт ' + (op.proposal.file ?? op.proposal.title);
      if (!effects) {
        current.revisions = [
          ...(current.revisions ?? []),
          {
            at,
            head: current.expected.head,
            digest: current.expected.proposedDigest,
            proposal: digest(current.proposal),
            reason: current.error ?? current.status,
            reviews,
          },
        ];
        // Ревью прежней редакции сохранены в revisions; новая начинает свой список.
        current.reviews = [];
        current.expected = {
          head: impact.proposed.revision,
          proposedDigest: impact.proposed.digest,
          current: impact.current?.id ?? null,
        };
        // Удержания пересчитываются в той же транзакции: новые задачи
        // удерживаются до снятия старых, окна выдачи по неподтверждённому
        // договору нет.
        this.h.hold(held, current.id, reason);
        this.h.releaseTasks(
          current.id,
          current.held.filter((t) => !held.includes(t)),
        );
        current.held = held;
        current.step = stepsOf(current).indexOf('drain');
        current.status = 'queued';
        current.error = undefined;
        current.waitingFor = undefined;
        current.token = undefined;
        current.leaseUntil = undefined;
        if (include) current.include = include;
        current.proposal = proposal;
        this.log(
          current,
          'start',
          'revised',
          `${impact.proposed.revision.slice(0, 12)}; предложение ${digest(proposal).slice(0, 12)}${input === undefined ? '' : ' (новый файл)'}`,
        );
        for (const w of impact.warnings) this.log(current, 'start', 'warning', w.message);
        this.save(current);
        return { status: 'revised' as const, operation: this.view(current) };
      }
      const next: ContractChange = {
        id: 'CC-' + randomUUID(),
        key: current.key,
        owner: current.owner,
        proposal,
        authorRuntime: current.authorRuntime,
        expected: {
          head: impact.proposed.revision,
          proposedDigest: impact.proposed.digest,
          current: impact.current?.id ?? null,
        },
        step: 0,
        order: 3,
        status: 'queued',
        startedAt: at,
        held: [],
        rebound: [],
        boards: [],
        corrections: [],
        history: [],
        previous: current.id,
        ...((include ?? current.include)?.length ? { include: include ?? current.include } : {}),
      };
      this.h.transferHold(current.id, next.id, reason);
      next.held = this.h.store
        .read()
        .tasks.filter((t) => t.hold?.operation === next.id)
        .map((t) => t.id);
      current.status = 'superseded';
      current.next = next.id;
      current.token = undefined;
      current.leaseUntil = undefined;
      current.finishedAt = at;
      this.log(
        current,
        stepsOf(current)[current.step] ?? 'release',
        'superseded',
        `следующая редакция ${next.id}; эффекты этой операции остаются в истории`,
      );
      this.log(
        next,
        'start',
        'queued',
        `продолжает ${current.id}; предложение ${digest(proposal).slice(0, 12)}`,
      );
      this.h.clearWait('context-lock', current.id);
      // Пауза и запрос применения принадлежали заменённой операции: следующая
      // проведёт перезакрепление и применение сама.
      this.h.operationResume(current.id);
      this.h.clearReconfigure(current.id);
      this.save(current);
      this.save(next);
      return {
        status: 'superseded' as const,
        operation: this.view(next),
        previous: this.view(current),
      };
    });
  }

  /** Отменить операцию: снять удержание. Перепривязанные задачи остаются черновиками. */
  abandon(id: string) {
    return this.h.store.atomic(() => {
      const op = this.get(id);
      if (op.status === 'running' && op.leaseUntil! > Date.now())
        throw new DomainError('Операция выполняется; дождитесь окончания шага', 409);
      if (!active(op) && op.status !== 'stale') return this.view(op);
      this.h.release(op.id);
      this.h.clearWait('context-lock', op.id);
      // Неприменённый запрос и пауза операции снимаются: выдача не должна
      // ждать отменённую операцию. Уже записанный config.json остаётся и
      // будет прочитан при следующем запуске сервера.
      this.h.operationResume(op.id);
      this.h.clearReconfigure(op.id);
      op.status = 'abandoned';
      op.token = undefined;
      op.leaseUntil = undefined;
      op.finishedAt = new Date().toISOString();
      this.log(op, stepsOf(op)[op.step] ?? 'release', 'abandoned');
      this.save(op);
      return this.view(op);
    });
  }

  /**
   * Горячей перезагрузки конфигурации нет: пакет контекста с прежней
   * редакцией контракта заблокировал бы задачи на первом запуске и истратил бы
   * попытку, а рецензент плана видел бы два разных текста. Удержание
   * остаётся до перезакрепления.
   */
  private async contextWait(op: ContractChange) {
    const contract = this.h.store.read().contracts.find((c) => c.id === op.contractId);
    const stale = contract ? await stalePins(this.h.config, contract) : [];
    if (!stale.length) {
      this.h.clearWait('context-lock', op.id);
      return undefined;
    }
    // Не отказ, а возобновляемое ожидание с точным следующим шагом: уже
    // действительное ревью не повторяется, удержания остаются.
    const detail = `Context pack ${stale.join(', ')} закрепляет прежнюю редакцию ${contract!.source}: задачи заблокировались бы на первом запуске. Выполните context-lock, перезапустите сервер и продолжите: contract-change --id ${op.id}`;
    this.h.waitFor('context-lock', op.id, detail);
    return { wait: detail, waitingFor: ['context-lock'] };
  }

  /**
   * Снять паузу сбоя такта «база прогонов отстала от рабочей ветки» (F40),
   * если ни одна база больше не отстаёт. Только паузу этой причины: без
   * назначенной причины (`runtime`) и с последней ошибкой такта о базе;
   * паузы оператора, ведущего, штатной остановки, проверки базы и
   * применения конфигурации не трогает. Проверка и снятие — одной записью.
   */
  private async liftStaleBasePause(op: Pick<ContractChange, 'id'>) {
    for (const r of repositories(this.h.config)) {
      const behind = Number(
        await git(r.path, 'rev-list', '--count', `refs/heads/${r.targetBranch}..HEAD`),
      );
      if (behind) return false;
    }
    try {
      return this.h.store.atomic(() => {
        const state = this.h.store.read();
        if (!state.paused || state.pauseReason) return false;
        const stop = queueStopView(state, this.h.store.latestEvents(['scheduler.error'], 50));
        if (stop.reason !== 'runtime' || !stop.stopReason?.startsWith(STALE_BASE)) return false;
        this.h.pause(false);
        // Запуск записан как снятие паузы операцией, а не решение человека:
        // событие называет операцию и причину снятой паузы.
        this.h.store.appendEvent('contract-change.queue-resumed', {
          operation: op.id,
          reason: 'stale-base',
        });
        return true;
      });
    } catch {
      // Очередь сейчас не запустить (сервер останавливается, нет готовой
      // разработки): пауза остаётся, перенос базы от этого не зависит.
      return false;
    }
  }

  /**
   * Ревью равносильности и регистрация консолидации. Консолидируется та
   * редакция, с которой операцию начали: новая редакция документа после
   * старта — устаревшая операция, а не консолидация другого текста.
   */
  private async consolidate(op: ContractChange) {
    const current = () =>
      latestRedaction(this.h.store.read().contracts, op.proposal.file!, op.proposal.repositoryId)
        ?.id ?? null;
    if (current() !== op.expected.current)
      throw new StaleChange(
        `Действующая редакция ${op.proposal.file} сменилась после начала консолидации: начните её заново по текущей редакции`,
      );
    const contract = await reviewConsolidation(
      this.h,
      this.root,
      op.proposal,
      op.authorRuntime,
      this.runtimes,
      () => {
        this.guard(op);
        if (current() !== op.expected.current)
          throw new StaleChange(
            `Действующая редакция ${op.proposal.file} сменилась во время ревью консолидации`,
          );
      },
      op.expected.head,
    );
    return { status: 'approved' as const, contract };
  }

  private revisions(op: ContractChange) {
    const p = op.proposal;
    return this.h.store
      .read()
      .contracts.filter(
        (c: Contract) =>
          (c.repositoryId ?? undefined) === (p.repositoryId ?? undefined) &&
          (p.file ? c.source === p.file : !c.source && c.title === p.title),
      );
  }

  private async run(
    step: Step,
    op: ContractChange,
  ): Promise<{ wait?: string; waitingFor?: string[] }> {
    const repo = repository(this.h.config, op.owner);
    switch (step) {
      case 'hold': {
        const impact = await contractImpact(this.h, op.proposal);
        const held = [...impact.tasks.direct, ...impact.tasks.transitive]
          .filter((t) => !['done', 'cancelled'].includes(t.status))
          .map((t) => t.id);
        this.advanceStep(op, (current) => {
          this.h.hold(held, op.id, 'Меняется контракт ' + (op.proposal.file ?? op.proposal.title));
          current.held = held;
          // Консолидация не меняет смысла: принятые задачи остаются принятыми
          // без корректировки.
          current.corrections =
            op.mode === 'consolidate'
              ? []
              : impact.tasks.direct.filter((t) => t.status === 'done').map((t) => t.id);
        });
        return {};
      }
      case 'drain': {
        // Идущие попытки дожидаются: операция не отменяет работу, которую
        // запустил кто-то другой.
        const s = this.h.store.read();
        const busy = s.tasks
          .filter((t) => op.held.includes(t.id) && t.activeRunId)
          .map((t) => t.id);
        if (busy.length) return { wait: 'Ждёт окончания идущих попыток', waitingFor: busy };
        this.advanceStep(op);
        return {};
      }
      case 'review': {
        // Регистрация редакции — под проверкой владения в той же транзакции:
        // ответ ревью, пришедший после перехвата операции, ничего не создаёт.
        const result = await (
          op.mode === 'consolidate'
            ? this.consolidate(op)
            : reviewContract(
                this.h,
                this.root,
                op.proposal,
                op.authorRuntime,
                this.runtimes,
                () => this.guard(op),
                op.expected.head,
              )
        ).catch((error: unknown) => {
          // Отказ ревью называет каталог своего решения: по нему операция
          // связывает запись истории с попыткой. Сбой без ревью его не несёт.
          const message = error instanceof Error ? error.message : String(error);
          const artifact = /Артефакты: (.+)$/.exec(message)?.[1];
          throw artifact && this.attemptOf(artifact)
            ? new ReviewRejected(message, artifact)
            : error;
        });
        if (!('contract' in result) || !result.contract)
          throw new DomainError('Ревью контракта не зарегистрировало редакцию: ' + result.status);
        const contractId = result.contract.id;
        const approved = this.attemptOf(result.contract.approval?.artifact);
        this.advanceStep(op, (current) => {
          current.contractId = contractId;
          if (approved) current.reviews = [...new Set([...(current.reviews ?? []), approved.id])];
        });
        return {};
      }
      case 'rebind': {
        const s = this.h.store.read();
        const from = this.revisions(op)
          .map((c) => c.id)
          .filter((id) => id !== op.contractId);
        const direct = s.tasks.filter(
          (t) => op.held.includes(t.id) && t.contracts.some((c) => from.includes(c)),
        );
        this.advanceStep(op, (current) => {
          const rebound = this.h.rebind(
            direct.map((t) => t.id),
            from,
            op.contractId!,
          );
          const state = this.h.store.read();
          current.rebound = [...new Set([...current.rebound, ...rebound])];
          current.boards = [
            ...new Set(
              current.rebound
                .map((id) => state.boards.find((b) => b.revisions.at(-1)!.taskIds.includes(id))?.id)
                .filter((id): id is string => Boolean(id)),
            ),
          ];
        });
        return {};
      }
      case 'plan': {
        // Рецензент плана читает закреплённый контекст: с прежней редакцией
        // контракта в нём он справедливо отклонил бы план. При прежнем порядке
        // шагов база ещё не перенесена, и проверка остаётся за release.
        if (stepsOf(op).indexOf('base') < stepsOf(op).indexOf('plan')) {
          const wait = await this.contextWait(op);
          if (wait) return wait;
        }
        const state = this.h.store.read();
        const includeBoards = (op.include ?? [])
          .map((id) => state.boards.find((b) => b.revisions.at(-1)!.taskIds.includes(id))?.id)
          .filter((id): id is string => Boolean(id));
        for (const boardId of [...new Set([...op.boards, ...includeBoards])]) {
          const s = this.h.store.read();
          const drafts = op.rebound.filter(
            (id) => s.tasks.find((t) => t.id === id)?.status === 'draft',
          );
          const revision = s.boards.find((b) => b.id === boardId)?.revisions.at(-1);
          // Утверждаются перепривязанные и явно включённые подготовленные
          // черновики; остальные задачи ревизии ревьюер видит как контекст.
          const included = (op.include ?? []).filter(
            (id) => s.tasks.find((t) => t.id === id)?.status === 'draft',
          );
          const onBoard = [...new Set([...drafts, ...included])].filter((id) =>
            revision?.taskIds.includes(id),
          );
          if (!onBoard.length) continue;
          const result = await reviewPlan(
            this.h,
            this.root,
            boardId,
            op.authorRuntime,
            this.runtimes,
            () => this.guard(op),
            onBoard,
            true,
          );
          if (result.status === 'awaiting-operator')
            throw new DomainError('Ревью плана ждёт оператора: ' + boardId);
          this.heartbeat(op);
        }
        this.advanceStep(op);
        return {};
      }
      case 'base': {
        // Перенос ограничен изменением контракта: рабочая ветка, несущая и
        // другую работу, переносится явно, а не заодно.
        const target = `refs/heads/${repo.targetBranch}`;
        const allowed = pathsOf(op);
        // Переносится ровно проверенный commit и только в компоненте
        // контракта: подготовка других компонентов остаётся за ведущим.
        const reviewed = op.expected.head;
        // Итоговое изменение от общей базы, а не каждый промежуточный commit:
        // правка, отменённая позже в той же ветке, в базу не попадает. Без
        // переименований: перенос постороннего файла на путь артефакта
        // виден удалением прежнего пути.
        // `-z`: пути как есть; без него не-ASCII путь приходит экранированным
        // (core.quotePath) и не совпадал с путём документа или артефакта.
        // Подмодули не скрываются настройкой репозитория (`diff.ignoreSubmodules`):
        // смена gitlink — тоже изменение вне контракта.
        const paths = await changedPaths(repo.path, `${target}...${reviewed}`);
        const extra = [...new Set(paths.filter((p) => !allowed.has(p)))];
        // Этап, меняющий несколько контрактов, коммитит их документы вместе:
        // ревьюер каждого видит соседей, на которые тот ссылается. Соседний
        // путь переносится, только если это одобренная редакция соседнего
        // контракта живой операции (точный blob и режим, `siblingContractLifts`).
        // Путь соседа, ещё не прошедшего ревью, — ожидание этой операции, а
        // не отказ: перенос сделает та, что дойдёт до базы последней.
        const siblings = this.siblingsOf(op);
        const lifted = await siblingContractLifts(
          this.h,
          this.root,
          this.h.store.read(),
          repo.id,
          extra,
          reviewed,
          siblings.flatMap((o) =>
            o.contractId ? [{ contractId: o.contractId, head: o.expected.head }] : [],
          ),
        );
        const rest = extra.filter((p) => !lifted.has(p));
        if (rest.length) return this.refuseOrWait(op, repo.id, reviewed, paths, rest, siblings);
        // Перенос базы — внешний эффект: сдвиг ref выполняется синхронно в той
        // же транзакции, что проверка владения. Отмена или перехват операции
        // либо видны проверке, либо происходят уже после сдвига — окна между
        // ними нет. Слияние до этого шага ничего не публикует. Снятия соседних
        // путей сверяются там же по состоянию: соседа могли отменить или
        // зарегистрировать новую редакцию его документа, пока шёл перенос.
        let updated: Awaited<ReturnType<typeof updateBase>>['updated'] = [];
        let lost = false;
        try {
          updated = (
            await updateBase(
              this.h.config,
              this.root,
              { [repo.id]: reviewed },
              // Сдвиг ref внутри транзакции проверки владения операцией, без hooks
              // и с пределом времени Git (`fencedRefMove` пакета harness).
              // Актёр сдвига — `host`: операцию ведёт ведущий агент (в режиме
              // operator она недоступна), а не человек и не перемотка очереди.
              fencedRefMove(
                executionOf(this.h).store,
                () => {
                  this.guard(op);
                  this.assertLifts(op, repo.id, lifted);
                },
                ContractChanges.refMoveTimeoutMs,
                'host',
              ),
            )
          ).updated;
        } catch (error) {
          // Соседняя операция сдвинула ту же базу раньше (CAS проиграл): если
          // база уже содержит проверенный commit, переносить нечего.
          if (!(await isAncestor(repo.path, reviewed, target))) throw error;
          lost = true;
        }
        const tip = await git(repo.path, 'rev-parse', target);
        // База догнала рабочую ветку: пауза сбоя такта «база отстала»
        // (коммит контракта на рабочую ветку до переноса) больше не нужна (F40).
        await this.liftStaleBasePause(op);
        this.advanceStep(op, (current) => {
          if (lifted.size)
            this.log(
              current,
              'base',
              'siblings',
              [...lifted.values()].map((l) => `${l.path} (${l.contractId})`).join(', '),
            );
          if (updated.length)
            this.log(
              current,
              'base',
              'moved',
              updated.map((u) => `${u.repositoryId}:${u.to}`).join(', '),
            );
          else if (current.carriedBy || lost)
            this.log(
              current,
              'base',
              'carried',
              `база ${repo.id}:${tip} уже содержит ${reviewed.slice(0, 12)}` +
                (current.carriedBy
                  ? `: перенесла операция ${current.carriedBy.operation} (${current.carriedBy.base})`
                  : ': ref сдвинут другим переносом'),
            );
          // Операции, чьи редакции этот перенос принёс как соседние, узнают
          // о нём из своей записи, а не из истории этой (она ограничена).
          if (updated.length)
            for (const id of new Set([...lifted.values()].map((l) => l.contractId))) {
              const carried = this.list().find(
                (o) => o.id !== op.id && o.contractId === id && active(o),
              );
              if (!carried) continue;
              carried.carriedBy = {
                operation: op.id,
                base: updated.map((u) => `${u.repositoryId}:${u.to}`).join(', '),
              };
              this.save(carried);
            }
        });
        return {};
      }
      case 'context': {
        const path = join(this.root, 'config.json');
        const contract = this.h.store.read().contracts.find((c) => c.id === op.contractId);
        const stale = contract ? await stalePins(this.h.config, contract) : [];
        if (!stale.length && !op.config) {
          // Перезакреплять нечего: конфигурация не меняется.
          this.advanceStep(op);
          return {};
        }
        const text = await readFile(path, 'utf8');
        const current = loadedDigest(loadConfig(path, text));
        // Ожидаемые digest до и после вычисляются и сохраняются до записи:
        // повтор принимает за сделанное только этот результат, а не любую
        // правку файла, оказавшуюся на диске.
        let planned = op.config;
        if (!planned?.after) {
          // Исходное состояние — действующая конфигурация процесса, а не то,
          // что лежит в файле: чужая правка (роли пакета, другие поля) не
          // становится частью операции и не применяется без перезапуска.
          if (current !== loadedDigest(this.h.config))
            throw new DomainError(
              'config.json отличается от действующей конфигурации процесса: примените правку перезапуском сервера и продолжите операцию',
            );
          const nextText = await planRepin(this.h.config, text, stale, op.expected.head);
          planned = { before: current, after: loadedDigest(loadConfig(path, nextText)) };
          const fixed = planned;
          this.h.store.atomic(() => {
            const c = this.guard(op);
            c.config = fixed;
            this.save(c);
          });
        }
        const { before, after } = planned as { before: string; after: string };
        if (current === after) {
          this.advanceStep(op, (c) => this.log(c, 'context', 'already-repinned'));
          return {};
        }
        if (current !== before)
          throw new DomainError(
            `config.json изменён вне операции: ожидался digest ${before.slice(0, 16)}, загружен ${current.slice(0, 16)}`,
          );
        const nextText = await planRepin(this.h.config, text, stale, op.expected.head);
        if (loadedDigest(loadConfig(path, nextText)) !== after)
          throw new DomainError('Перезакрепление дало не ту конфигурацию, что была рассчитана');
        const temp = `${path}.${op.id}.${process.pid}`;
        await writeFile(temp, nextText, { flag: 'w' });
        // Запись — внешний эффект: rename выполняется синхронно внутри
        // транзакции записи SQLite вместе с проверкой владения, чужого запроса
        // и неизменности файла. Транзакция записи одна на базу, поэтому записи
        // config.json из DevContour (эта и context-lock) сериализуются ею;
        // потерявший владение процесс файл не пишет.
        try {
          this.h.store.atomic(() => {
            const c = this.guard(op);
            const pending = this.h.store.read().reconfigure;
            if (pending && !pending.appliedAt && pending.operation !== op.id)
              throw new DomainError(`Конфигурацию применяет операция ${pending.operation}`, 409);
            if (readFileSync(path, 'utf8') !== text)
              throw new DomainError('config.json изменился во время перезакрепления');
            renameSync(temp, path);
            this.log(
              c,
              'context',
              'repinned',
              `${stale.join(', ')} @ ${op.expected.head.slice(0, 12)}; config ${before.slice(0, 12)} → ${after.slice(0, 12)}`,
            );
            this.save(c);
          });
        } finally {
          rmSync(temp, { force: true });
        }
        this.advanceStep(op);
        return {};
      }
      case 'reconfigure': {
        const after = op.config?.after;
        // Шаг context ничего не перезакреплял: применять нечего.
        if (!after) {
          this.advanceStep(op);
          return {};
        }
        const path = join(this.root, 'config.json');
        // Своя пауза — только если очередь не остановлена; пауза человека
        // остаётся его. Запрос применения останавливает выдачу и без паузы.
        // Повтор запроса той же операцией сбрасывает прежний отказ.
        this.h.store.atomic(() => {
          this.guard(op);
          this.h.operationPause(op.id);
          this.h.requestReconfigure(op.id, after);
        });
        const busy = busyWork(this.h);
        if (busy.length)
          return {
            wait: 'Ждёт окончания работ перед применением конфигурации',
            waitingFor: busy,
          };
        // Свой процесс — сразу: следующие шаги (ревью планов) читают контекст.
        applyConfig(this.h, path, after);
        // Работающий сервер применяет сам и подтверждает; без живого сервера
        // следующий запуск прочитает уже новый файл.
        const s = this.h.store.read();
        const leader = s.leader && s.leader.leaseUntil > Date.now();
        if (leader) {
          const deadline = Date.now() + ContractChanges.reconfigureWaitMs;
          for (;;) {
            const request = this.h.store.read().reconfigure;
            if (request?.error)
              throw new DomainError('Сервер не применил конфигурацию: ' + request.error);
            if (request?.appliedAt && request.digest === after) break;
            if (Date.now() > deadline)
              return {
                wait: 'Ждёт применения конфигурации работающим сервером',
                waitingFor: ['reconfigure'],
              };
            await new Promise((r) => setTimeout(r, 200));
          }
        } else
          this.h.store.atomic(() => {
            this.guard(op);
            this.h.settleReconfigure(op.id, after, 'operation:' + op.id);
          });
        this.advanceStep(op, (c) => {
          this.h.operationResume(op.id);
          this.h.clearReconfigure(op.id);
          this.log(c, 'reconfigure', 'applied', `config ${after.slice(0, 12)}`);
        });
        return {};
      }
      case 'release': {
        const wait = await this.contextWait(op);
        if (wait) return wait;
        this.advanceStep(op, () => {
          this.h.release(op.id);
        });
        return {};
      }
    }
  }

  /**
   * Вход операции не изменился: ревью и перепривязка относятся к той
   * редакции, с которой операцию начали. Сдвинутая рабочая ветка или другой
   * документ — устаревшая операция, а не повод продолжать по новому тексту.
   */
  private async assertInputs(op: ContractChange) {
    const repo = repository(this.h.config, op.proposal.repositoryId ?? defaultOwner(this.h));
    const head = await git(repo.path, 'rev-parse', 'HEAD');
    let moved: string[] | undefined;
    if (head !== op.expected.head) {
      moved = await this.siblingMove(op, repo.path, head);
      if (!moved)
        throw new StaleChange(
          `Рабочая ветка сдвинулась (${op.expected.head.slice(0, 12)} → ${head.slice(0, 12)}): начните операцию заново по текущей редакции`,
        );
    }
    const at = moved ? head : op.expected.head;
    const content = await contractContent(this.h, op.proposal, at);
    const pinned = await pinArtifacts(
      repo,
      op.proposal.artifacts ?? [],
      at,
      this.h.config.contractArtifacts,
    );
    if (
      contractDigest(content, pinned.artifacts, 2, op.proposal.checks, op.proposal.underTest) !==
      op.expected.proposedDigest
    )
      throw new StaleChange('Предложение изменилось после начала операции');
    if (moved) {
      const from = op.expected.head;
      this.h.store.atomic(() => {
        const current = this.guard(op);
        current.expected = { ...current.expected, head };
        this.log(
          current,
          stepsOf(current)[current.step],
          'rebased',
          `${from.slice(0, 12)} → ${head.slice(0, 12)}: изменены только соседние контракты (${moved.slice(0, 20).join(', ')})`,
        );
        this.save(current);
      });
      op.expected = { ...op.expected, head };
    }
  }

  /**
   * Пути вне контракта, которые не сняты как одобренные редакции соседей.
   * Ожидание — только если все они принадлежат соседним операциям, ещё не
   * дошедшим до базы (сосед на шаге базы сам ждал бы эту операцию), и если
   * эти соседи смогут перенести и пути этой операции: иначе ожидание не
   * кончилось бы ничем, и отказ — сразу. Остальное — отказ с выходом.
   */
  private async refuseOrWait(
    op: ContractChange,
    repositoryId: string,
    reviewed: string,
    paths: string[],
    rest: string[],
    siblings: ContractChange[],
  ): Promise<{ wait: string; waitingFor: string[] }> {
    const base = (o: ContractChange) => stepsOf(o).indexOf('base');
    const ahead = siblings.filter((o) => o.step < base(o));
    const holders = ahead.filter((o) => rest.some((p) => pathsOf(o).has(p)));
    const held = rest.filter((p) => holders.some((o) => pathsOf(o).has(p)));
    const unheld = rest.filter((p) => !held.includes(p));
    const way =
      `Перенесите базу явно (base-update --by host на остановленной очереди) и продолжите: contract-change --id ${op.id}. ` +
      'Перенос, задевающий документы или артефакты контрактов без доказательства ревью, затем ждёт подтверждения оператора (base-check).';
    if (!unheld.length) {
      const own = paths.filter((p) => pathsOf(op).has(p));
      const carried = await siblingContractLifts(
        this.h,
        this.root,
        this.h.store.read(),
        repositoryId,
        own,
        reviewed,
        op.contractId ? [{ contractId: op.contractId, head: reviewed }] : [],
      );
      const blocked = own.filter((p) => !carried.has(p));
      if (blocked.length)
        throw new DomainError(
          `Рабочая ветка несёт неодобренные пока редакции соседних контрактов (${held.slice(0, 20).join(', ')}), но соседние операции не смогут перенести пути этой (${blocked.slice(0, 20).join(', ')}): их редакция не годится для снятия по одобрению. ${way}`,
        );
      const ids = holders.map((o) => o.id);
      return {
        wait: `Рабочая ветка несёт неодобренные пока редакции соседних контрактов (${held.slice(0, 20).join(', ')}): их проводят операции ${ids.join(', ')}. Базу перенесёт та, что дойдёт до неё последней; эта продолжится сама, когда они пройдут перенос, или командой contract-change --id ${op.id}`,
        waitingFor: ids,
      };
    }
    const all = this.list();
    const sibling = unheld.filter((p) => siblings.some((o) => pathsOf(o).has(p)));
    const foreign = unheld.filter((p) => !sibling.includes(p));
    const gone = (this.waited.get(op.id) ?? [])
      .map((id) => all.find((o) => o.id === id))
      .filter((o): o is ContractChange => Boolean(o) && !(active(o!) && o!.step < base(o!)));
    throw new DomainError(
      [
        foreign.length
          ? `Рабочая ветка несёт изменения вне контракта: ${foreign.slice(0, 20).join(', ')}.`
          : '',
        sibling.length
          ? `Пути соседних контрактов не в одобренной редакции (blob или режим отличаются от одобренных, редакция не последняя или не годится для снятия): ${sibling.slice(0, 20).join(', ')}.`
          : '',
        held.length
          ? `Ждут ревью соседних операций: ${held.slice(0, 20).join(', ')} (${holders.map((o) => o.id).join(', ')}).`
          : '',
        gone.length
          ? `Операции, которых ждала эта, больше не ведут свои контракты к базе: ${gone.map((o) => `${o.id} (${o.status})`).join(', ')}.`
          : '',
        way,
      ]
        .filter(Boolean)
        .join(' '),
    );
  }

  /** Снятия соседних путей действительны по состоянию; вызывается в транзакции сдвига ref. */
  private assertLifts(
    op: ContractChange,
    repositoryId: string,
    lifted: Map<string, SiblingContractLift>,
  ) {
    if (!lifted.size) return;
    const s = this.h.store.read();
    const siblings = this.siblingsOf(op);
    const changed = [...lifted.values()].filter(
      (l) =>
        !siblings.some((o) => o.contractId === l.contractId) ||
        !siblingLiftHolds(this.h.config, s, repositoryId, l),
    );
    if (changed.length)
      throw new DomainError(
        `Соседний контракт изменился во время переноса базы (${changed.map((l) => l.path).join(', ')}): операция отменена, заменена или зарегистрирована новая редакция. База не сдвинута; продолжите операцию, снятия будут пересчитаны: contract-change --id ${op.id}`,
      );
  }

  /**
   * Операция числится выполняющейся, но её lease истёк: процесс, который её
   * вёл, оборвался посреди шага. Продолжение — `contract-change --id`.
   */
  interrupted(op: ContractChange, now = Date.now()) {
    return op.status === 'running' && op.leaseUntil !== undefined && op.leaseUntil <= now;
  }

  /**
   * Операция ждёт на шаге базы соседей, ни один из которых больше не идёт к
   * базе: они перенесли её, завершились, отменены, заменены или устарели.
   * Продолжение пересчитает снятия — перенос, новое ожидание или отказ.
   */
  stalledWait(op: ContractChange) {
    if (op.status !== 'waiting' || stepsOf(op)[op.step] !== 'base' || !op.waitingFor?.length)
      return false;
    const all = this.list();
    return op.waitingFor.every((id) => {
      const o = all.find((x) => x.id === id);
      return !o || !active(o) || o.step >= stepsOf(o).indexOf('base');
    });
  }

  /** Живые операции других контрактов того же компонента. */
  private siblingsOf(op: ContractChange) {
    return this.list().filter((o) => o.id !== op.id && o.owner === op.owner && active(o));
  }

  /**
   * Рабочая ветка сдвинулась только в файлах соседних контрактов этапа:
   * исправленный после отказа документ соседа не делает устаревшей операцию,
   * чей документ и артефакты не изменились (это сверяет digest по новому
   * HEAD). Условия: операция ещё не переносила базу (context packs после
   * переноса закреплены на прежнем HEAD), новый HEAD — потомок проверенного,
   * а изменённые пути — только свои и пути документов и артефактов других
   * живых операций того же компонента. Возвращает изменённые пути соседей или
   * `undefined` — тогда операция устарела, как прежде.
   */
  private async siblingMove(op: ContractChange, repoPath: string, head: string) {
    // Не после переноса базы и не после ревью плана (у операций первого
    // порядка оно идёт до базы): рецензент плана видел прежний HEAD.
    const steps = stepsOf(op);
    // У консолидации ревью планов нет: ограничивает только перенос базы.
    const plan = steps.includes('plan') ? steps.indexOf('plan') : Infinity;
    if (op.step > steps.indexOf('base') || op.step >= plan) return undefined;
    if (!(await isAncestor(repoPath, op.expected.head, head))) return undefined;
    const changed = await changedPaths(repoPath, op.expected.head, head);
    // Свой путь в итоговом изменении — другой blob или режим: ревью его не
    // видело, даже если digest (по blob) прежний.
    const own = pathsOf(op);
    const sibling = new Set(this.siblingsOf(op).flatMap((o) => [...pathsOf(o)]));
    if (!changed.length || changed.some((p) => own.has(p) || !sibling.has(p))) return undefined;
    return changed;
  }
}

/**
 * Пути итогового изменения диапазона: `-z` — пути как есть, без
 * переименований, подмодули видны независимо от настройки репозитория.
 */
async function changedPaths(repoPath: string, ...range: string[]) {
  return (
    await git(
      repoPath,
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      '--ignore-submodules=none',
      ...range,
    )
  )
    .split('\0')
    .filter(Boolean);
}

/** Документ и артефакты предложения операции — пути, которые она переносит. */
const pathsOf = (op: ContractChange) =>
  new Set([
    ...(op.proposal.file ? [op.proposal.file] : []),
    ...(op.proposal.artifacts ?? []).map((a) => a.path),
  ]);

class StaleChange extends DomainError {}
/** Ревью отклонило редакцию; `artifact` — каталог решения этой попытки. */
class ReviewRejected extends DomainError {
  constructor(
    message: string,
    readonly artifact: string,
  ) {
    super(message, 400);
  }
}
