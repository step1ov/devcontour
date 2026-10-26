import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { fencedRefMove } from 'devcontour-harness';
import { executionOf } from '../harness/execution.ts';
import { DomainError, type Contract } from '../core/model.ts';
import { contractDigest, digest, type DevContour } from '../core/service.ts';
import { repositories, repository } from '../core/repositories.ts';
import {
  contractContent,
  assertDeclaration,
  contractProposal,
  defaultOwner,
  reviewContract,
  reviewPlan,
} from './agent-control.ts';
import { adapters, type AgentAdapter } from './adapters.ts';
import { pinArtifacts } from './contract-artifacts.ts';
import { contractImpact } from './contract-impact.ts';
import { updateBase } from './base-update.ts';
import { planRepin, stalePins } from './context.ts';
import { applyConfig, busyWork } from './reconfigure.ts';
import { loadConfig } from './config.ts';
import { loadedDigest } from '../core/service.ts';
import { git } from './process.ts';

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
type Step = (typeof orders)[3][number];
const stepsOf = (op: { order?: 2 | 3 }): readonly Step[] => orders[op.order ?? 1];

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
  private all() {
    return repositories(this.h.config).flatMap((r) =>
      Object.values(this.h.store.localRecords<ContractChange>(KIND, r.id)),
    );
  }
  get(id: string) {
    const op = this.all().find((x) => x.id === id);
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
  view(op: ContractChange) {
    const { token, leaseUntil, ...rest } = op;
    void token;
    void leaseUntil;
    return { ...rest, next: stepsOf(op)[op.step] ?? null };
  }

  /** Начать операцию или вернуть уже идущую по тому же предложению. */
  async start(input: unknown, authorRuntime: 'codex' | 'claude', include: string[] = []) {
    if (this.h.config.approvalMode === 'operator')
      throw new DomainError(
        'В режиме operator изменение контракта проводит оператор: ревью ждёт его подтверждения',
        409,
      );
    const proposal = contractProposal.parse(input);
    const impact = await contractImpact(this.h, proposal);
    if (impact.status === 'unchanged') return { status: 'unchanged' as const, impact };
    // Отказ до удержания задач и ревью: новая редакция с незащищённым
    // helper приёмки не была бы одобрена всё равно.
    if (impact.closure.refusal) throw new DomainError(impact.closure.refusal, 400);
    // Операция не заводит параллельный контракт для файла, который уже
    // зарегистрирован под другим компонентом: задачи прежнего остались бы
    // привязаны к нему.
    if ('registeredUnder' in impact && impact.registeredUnder?.length)
      throw new DomainError(impact.warning!, 409);
    const owner = impact.repositoryId;
    const key = digest({ owner, source: proposal.file ?? `title:${proposal.title}` });
    return this.h.store.atomic(() => {
      const existing = this.all().find((x) => x.key === key && active(x));
      if (existing) {
        if (existing.expected.proposedDigest !== impact.proposed.digest)
          throw new DomainError(
            `Контракт уже меняет операция ${existing.id} по другой редакции; продолжите или отмените её`,
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
  async advance(id: string) {
    const claimed = this.claim(id);
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
    }
    return this.view(this.get(id));
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
    const proposal = input === undefined ? op.proposal : contractProposal.parse(input);
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
        (impact.current?.id ?? null) === op.expected.current;
      if (!same)
        throw new DomainError(
          'Пересмотр меняет тот же контракт: файл, название, repositoryId и компонент должны совпадать с операцией',
          400,
        );
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
          current.corrections = impact.tasks.direct
            .filter((t) => t.status === 'done')
            .map((t) => t.id);
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
        const result = await reviewContract(
          this.h,
          this.root,
          op.proposal,
          op.authorRuntime,
          this.runtimes,
          () => this.guard(op),
          op.expected.head,
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
        const allowed = new Set([
          ...(op.proposal.file ? [op.proposal.file] : []),
          ...(op.proposal.artifacts ?? []).map((a) => a.path),
        ]);
        // Переносится ровно проверенный commit и только в компоненте
        // контракта: подготовка других компонентов остаётся за ведущим.
        const reviewed = op.expected.head;
        // Итоговое изменение от общей базы, а не каждый промежуточный commit:
        // правка, отменённая позже в той же ветке, в базу не попадает. Без
        // переименований: перенос постороннего файла на путь артефакта
        // виден удалением прежнего пути.
        const paths = (
          await git(repo.path, 'diff', '--name-only', '--no-renames', `${target}...${reviewed}`)
        )
          .split('\n')
          .filter(Boolean);
        const extra = [...new Set(paths.filter((p) => !allowed.has(p)))];
        if (extra.length)
          throw new DomainError(
            `Рабочая ветка несёт изменения вне контракта: ${extra.slice(0, 20).join(', ')}. Перенесите базу явно (base-update) и продолжите операцию`,
          );
        // Перенос базы — внешний эффект: сдвиг ref выполняется синхронно в той
        // же транзакции, что проверка владения. Отмена или перехват операции
        // либо видны проверке, либо происходят уже после сдвига — окна между
        // ними нет. Слияние до этого шага ничего не публикует.
        const updated = await updateBase(
          this.h.config,
          this.root,
          { [repo.id]: reviewed },
          // Сдвиг ref внутри транзакции проверки владения операцией, без hooks
          // и с пределом времени Git (`fencedRefMove` пакета harness).
          fencedRefMove(
            executionOf(this.h).store,
            () => this.guard(op),
            ContractChanges.refMoveTimeoutMs,
          ),
        );
        this.advanceStep(op, (current) => {
          if (updated.updated.length)
            this.log(
              current,
              'base',
              'moved',
              updated.updated.map((u) => `${u.repositoryId}:${u.to}`).join(', '),
            );
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
    if (head !== op.expected.head)
      throw new StaleChange(
        `Рабочая ветка сдвинулась (${op.expected.head.slice(0, 12)} → ${head.slice(0, 12)}): начните операцию заново по текущей редакции`,
      );
    const content = await contractContent(this.h, op.proposal, op.expected.head);
    const pinned = await pinArtifacts(
      repo,
      op.proposal.artifacts ?? [],
      op.expected.head,
      this.h.config.contractArtifacts,
    );
    if (
      contractDigest(content, pinned.artifacts, 2, op.proposal.checks, op.proposal.underTest) !==
      op.expected.proposedDigest
    )
      throw new StaleChange('Предложение изменилось после начала операции');
  }
}

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
