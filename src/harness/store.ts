// Хранилище исполнения harness поверх Store DevContour.
//
// Второй базы исполнения нет: движок читает и пишет тот же документ
// DevContour в той же транзакции SQLite, что и продуктовые записи
// (docs/compatibility.md пакета, «Транзакции адаптера DevContour»).
//
// - Внешняя транзакция — `Store.atomic` с ровно одной `Store.change(kind, …)`;
//   вложенная работает в том же документе и откатывает только свою часть
//   (документ, журнальный буфер, локальные записи — SAVEPOINT).
// - Журнал получает прежнюю форму данных события (её задаёт хост, иначе —
//   ссылки на задачу и попытку транзакции) без токенов владения и ключ
//   `harnessEvents` — нейтральные события транзакции по порядку.
// - Курсор нейтральных событий: `seq = id события журнала × 1024 + индекс`.
import { isDeepStrictEqual } from 'node:util';
import {
  API_VERSION,
  HarnessError,
  STATE_VERSION,
  WORKSPACE_OWNER,
  clipDeep,
  localSchemas,
  readRunEvent,
  runEventSchema,
  type AttemptState,
  type ExecutionStore,
  type ExecutionTransaction,
  type ExecutionView,
  type GraphState,
  type JointVerificationState,
  type RunEvent,
  type RunEventDraft,
  type TransactionKind,
  type WorkState,
} from 'devcontour-harness';
import { Draft, type Store } from '../core/store.ts';
import type { DevContourState } from '../core/model.ts';
import type { UsageRecord } from '../core/usage.ts';
import {
  attemptOf,
  callOf,
  contractDocumentOf,
  controlOf,
  controllerOf,
  graphOf,
  hostNamespace,
  putAttempt,
  putGraph,
  putReproductions,
  putVerification,
  putWork,
  reproductionsOf,
  setControl,
  setController,
  usageOf,
  verificationsOf,
  workOf,
  expiryText,
  type ProjectionOptions,
} from './projection.ts';

/** Не больше событий в одной транзакции: курсор отводит на транзакцию 1024 номера. */
export const MAX_EVENTS_PER_TRANSACTION = 1024;
const SEQ = 1024;

type LocalNamespace = keyof typeof localSchemas;

/** Пространство `local_workflow` для пространства harness; реестр воспроизведений — в документе. */
const hostSpace = (namespace: LocalNamespace) => {
  if (namespace === 'reproductions')
    throw new HarnessError('INVALID_INPUT', 'Реестр воспроизведений хранится в документе');
  return hostNamespace[namespace];
};

/** Транзакция хоста, внутри которой идут транзакции движка (продуктовые поля в той же записи). */
export interface HostTransaction {
  /** Документ транзакции: продуктовые поля хост меняет прямо в нём. */
  readonly state: DevContourState;
  /** Прежняя форма данных события журнала этой транзакции (`{taskId, reset}` у повтора и т. п.). */
  journal(data: Record<string, unknown>): void;
  /** Нейтральный вид той же транзакции. */
  readonly tx: ExecutionTransaction;
}

interface Frame {
  /**
   * Документ транзакции: копия для записи создаётся при первом изменении.
   * Во внешней транзакции он открывается при первом обращении: продление
   * аренды строкой (D53) документ не читает.
   */
  readonly draft: Draft;
  drafts: RunEventDraft[];
  legacy?: Record<string, unknown>;
  works: Set<string>;
  attempts: Set<string>;
  /** Глубина вложенных частей, идущих сейчас: 0 — внешняя транзакция. */
  depth: number;
  /**
   * Транзакция что-то записала: документ, локальную запись, роль или срок
   * аренды. Не откатывается вместе с вложенной частью — `pristine()` после
   * отката её части остаётся `false`.
   */
  wrote: boolean;
  /** Записаны записи модели движка — у транзакции `heartbeat` поднимает ревизию данных. */
  modelWrote: boolean;
  /**
   * Хост менял документ (`HostTransaction.state`): под видом heartbeat это
   * продление сроков, но для шлюза простоя (F79) — не нейтральная запись.
   */
  hostWrote?: boolean;
  /**
   * Транзакция открыта внутри уже идущей транзакции Store (`Store.atomic`
   * вызывающего): та могла записать до неё и откатиться после — видимые
   * данные не обязательно зафиксированы при текущей ревизии.
   */
  enclosed: boolean;
  /**
   * Ревизия данных Store в начале внешней транзакции. Запись данных мимо
   * вида движка (прямо через Store в той же транзакции) поднимает ревизию
   * до фиксации — `pristine()` видит её по расхождению.
   */
  revision?: number;
}

/**
 * Копия без полей `token` на любой глубине: токен владения не попадает в
 * журнал. Общая операция harness без усечения строк.
 */
export const withoutTokens = (value: unknown): unknown => clipDeep(value, Infinity);

const hostOwner = (owner: string) => (owner === WORKSPACE_OWNER ? undefined : owner);

export class DevContourExecutionStore implements ExecutionStore {
  readonly stateVersion = STATE_VERSION;
  private frame?: Frame;
  /** Документ DevContour каждого выданного вида: порты хоста читают продуктовые поля. */
  private readonly states = new WeakMap<ExecutionView, () => DevContourState>();
  /** Кадр транзакции, из которого построен вид (`stateOf` отмечает выданный изменяемый документ). */
  private readonly frames = new WeakMap<ExecutionView, Frame>();
  constructor(
    readonly store: Store,
    readonly options: ProjectionOptions,
  ) {}

  /**
   * Транзакция хоста: продуктовые поля и переходы движка — одна запись.
   * Транзакции движка внутри неё — вложенные. `Store.change` внутри неё
   * отклоняется (`Store.update`): внешняя транзакция записала бы свою копию
   * документа поверх него, а событие журнала о нём осталось бы.
   */
  /** ChangeSet, операция которого сейчас начинает совместную проверку. */
  private jointTarget?: string;
  /**
   * Начать совместную проверку набора ChangeSet `changeSetId`: движок создаёт
   * запись проверки, адаптер помещает её в этот ChangeSet. Вне этого вызова
   * новая проверка не создаётся.
   */
  withJointTarget<T>(changeSetId: string, fn: () => T): T {
    const previous = this.jointTarget;
    this.jointTarget = changeSetId;
    try {
      return fn();
    } finally {
      this.jointTarget = previous;
    }
  }
  /** ChangeSet начинаемой проверки — формула основания хоста читает его до появления id. */
  get startingChangeSet() {
    return this.jointTarget;
  }

  host<T>(kind: string, fn: (h: HostTransaction) => T): T {
    const run = (frame: Frame) =>
      fn({
        // Продуктовые поля хост меняет прямо в документе: копия для записи.
        // Правка хоста — не запись модели движка: продление сроков поставки
        // под видом heartbeat остаётся продлением (ревизия данных прежняя).
        get state() {
          frame.wrote = frame.hostWrote = true;
          return frame.draft.edit();
        },
        journal: (data) => (frame.legacy = data),
        tx: this.view(frame),
      });
    // Внутри уже открытой транзакции (например, повтор, который очередь
    // заданий выполняет в одной транзакции с учётом восстановления) —
    // вложенная часть той же записи.
    const frame = this.frame;
    return frame ? this.nested(frame, () => run(frame)) : this.outer(kind, run);
  }

  transact<T>(kind: TransactionKind, fn: (tx: ExecutionTransaction) => T): T {
    const frame = this.frame;
    if (!frame) return this.outer(kind, (f) => fn(this.view(f)));
    return this.nested(frame, () => fn(this.view(frame)));
  }

  /** Вложенная часть: тот же документ; при отказе возвращается её часть документа и журнала. */
  private nested<T>(frame: Frame, run: () => T): T {
    const saved = frame.draft.mark();
    const drafts = frame.drafts.length;
    const legacy = frame.legacy;
    const works = new Set(frame.works);
    const attempts = new Set(frame.attempts);
    // `wrote` откат вложенной части не снимает (pristine остаётся false), а
    // запись модели, откаченная с ней, ревизию heartbeat не поднимает.
    const modelWrote = frame.modelWrote;
    const hostWrote = frame.hostWrote;
    frame.depth++;
    try {
      return this.store.atomic(() => this.settled(run()));
    } catch (error) {
      frame.draft.restore(saved);
      frame.drafts.length = drafts;
      frame.legacy = legacy;
      frame.works = works;
      frame.attempts = attempts;
      frame.modelWrote = modelWrote;
      frame.hostWrote = hostWrote;
      throw error;
    } finally {
      frame.depth--;
    }
  }

  private settled<T>(value: T): T {
    if (value && typeof (value as { then?: unknown }).then === 'function')
      throw new Error('ExecutionStore.transact: внутри транзакции нельзя ждать внешней работы');
    return value;
  }

  private outer<T>(kind: string, run: (frame: Frame) => T): T {
    let out!: T;
    let data: unknown = null;
    let drafts: RunEventDraft[] = [];
    let written: Frame | undefined;
    const enclosed = this.store.inTransaction;
    this.store.atomic(() => {
      const before = this.store.lastEventId();
      const action = (draft: () => Draft) => {
        const frame: Frame = {
          get draft() {
            return draft();
          },
          drafts: [],
          works: new Set(),
          attempts: new Set(),
          depth: 0,
          wrote: false,
          modelWrote: false,
          enclosed,
          revision: enclosed ? undefined : this.store.revision(),
        };
        this.frame = frame;
        written = frame;
        try {
          out = this.settled(run(frame));
        } finally {
          this.frame = undefined;
        }
        if (frame.drafts.length > MAX_EVENTS_PER_TRANSACTION)
          throw new Error('Слишком много событий в одной транзакции');
        drafts = frame.drafts;
        data = this.journalData(frame);
        return data;
      };
      // Транзакция heartbeat без записей модели и правок хоста меняет в
      // документе только сроки (продление совместной проверки): для шлюза
      // простоя выдачи — нейтральная запись своего процесса (F79).
      const renewalOnly = () => !!written && !written.modelWrote && !written.hostWrote;
      this.store.lazyUpdate(kind, action, renewalOnly);
      // Store.change не пишет событие, если документ не изменился: событие
      // транзакции с нейтральными событиями записывается явно, в ней же.
      if (kind !== 'heartbeat' && drafts.length && this.store.lastEventId() === before)
        this.store.appendEvent(
          kind,
          data,
          // Получение и освобождение роли controller — сроки владения, не данные.
          drafts.every((d) => d.type.startsWith('controller.')) ? 'lease' : 'data',
        );
      // Изменение документа под видом `heartbeat` Store считает продлением
      // сроков (счётчик `lease`). Запись модели в такой транзакции, кроме
      // продления срока совместной проверки (`jointHeartbeat`), — изменение
      // данных: `dataVersion` меняется, иначе кэш движка по версии
      // (`pristine`) остался бы прежним при других данных.
      if (kind === 'heartbeat' && written?.modelWrote) this.store.markDataChanged();
    });
    return out;
  }

  /** Данные события журнала: прежняя форма (от хоста или ссылки транзакции) и нейтральные события. */
  private journalData(frame: Frame): Record<string, unknown> | null {
    const legacy =
      frame.legacy ??
      (() => {
        const runId = frame.attempts.size === 1 ? [...frame.attempts][0] : undefined;
        const run = runId ? frame.draft.current.runs.find((r) => r.id === runId) : undefined;
        const taskId = run?.taskId ?? (frame.works.size === 1 ? [...frame.works][0] : undefined);
        return { ...(taskId ? { taskId } : {}), ...(runId ? { runId } : {}) };
      })();
    const data = {
      ...(withoutTokens(legacy) as Record<string, unknown>),
      ...(frame.drafts.length ? { harnessEvents: frame.drafts } : {}),
    };
    return Object.keys(data).length ? data : null;
  }

  /**
   * Вид внешнего чтения: вложенное чтение (status, диагнозы и задания внутри
   * одного `read`, как у пакета передачи) получает тот же снимок и тот же
   * документ, не разбирая его заново. `settled` не даёт чтению уйти в
   * асинхронную работу, поэтому вид снимается в `finally` того же вызова.
   */
  private reading?: ExecutionView;

  read<T>(fn: (view: ExecutionView) => T): T {
    // Чтение внутри транзакции — вид той же транзакции без записи (и без
    // `pristine`: вид чтения его не даёт).
    if (this.frame) return fn(this.view(this.frame, false));
    if (this.reading) return this.settled(fn(this.reading));
    return this.store.snapshot(() => {
      // Чтение без копии: общий замороженный снимок версии данных.
      const state = this.store.view() as DevContourState;
      const frame: Frame = {
        draft: new Draft(
          () => state,
          () => {
            throw new Error('Запись вне транзакции');
          },
          state.leader,
        ),
        drafts: [],
        works: new Set(),
        attempts: new Set(),
        depth: 0,
        wrote: false,
        modelWrote: false,
        enclosed: false,
      };
      const view = this.view(frame, false);
      this.reading = view;
      try {
        return this.settled(fn(view));
      } finally {
        this.reading = undefined;
      }
    });
  }

  events(after = 0, limit = 500): RunEvent[] {
    const max = Math.min(Math.max(limit, 1), 500);
    const out: RunEvent[] = [];
    let cursor = Math.floor(Math.max(after, 0) / SEQ) - 1;
    while (out.length < max) {
      const page = this.store.eventsAfter(Math.max(cursor, 0), 200);
      if (!page.length) break;
      for (const e of page) {
        const harnessEvents = (e.data as { harnessEvents?: RunEventDraft[] } | null)?.harnessEvents;
        (harnessEvents ?? []).forEach((draft, index) => {
          const seq = e.id * SEQ + index;
          if (seq > after && out.length < max)
            // Чтение терпимо к незнакомому типу события (запись новее версии
            // движка): такое событие приходит как `unknown`, а не ломает выдачу.
            out.push(
              readRunEvent({
                apiVersion: API_VERSION,
                seq,
                at: e.at,
                ...draft,
              }),
            );
        });
        cursor = e.id;
      }
    }
    return out;
  }

  close() {
    this.store.close();
  }

  /**
   * Документ DevContour, из которого построен вид `view` (той же транзакции
   * или того же снимка). Порты хоста читают через него продуктовые поля;
   * менять его вне транзакции хоста нельзя.
   */
  stateOf(view: ExecutionView): DevContourState {
    const state = this.states.get(view);
    if (!state) throw new Error('Вид получен не от этого хранилища');
    // Изменяемый документ открытой транзакции вызывающий может и изменить:
    // для шлюза простоя (F79) это правка хоста, как через `h.state`, —
    // продление под видом heartbeat перестаёт быть нейтральным. Неизменённый
    // документ — общий замороженный снимок, его не изменить.
    const frame = this.frames.get(view);
    if (frame && frame === this.frame && frame.draft.edited) frame.hostWrote = true;
    return state();
  }

  private view(frame: Frame, writable = true): ExecutionTransaction {
    const { options, store } = this;
    // Чтение — состояние транзакции (до первого изменения — общий снимок);
    // запись — копия документа для записи.
    const state = () => frame.draft.current as DevContourState;
    const inTx = () => {
      if (!writable || this.frame !== frame) throw new Error('Запись вне транзакции');
    };
    const edit = () => {
      inTx();
      frame.wrote = frame.modelWrote = true;
      return frame.draft.edit();
    };
    // Вложенная часть получает свой вид на том же кадре: `pristine` — только
    // у вида внешней транзакции и только пока вложенная часть не идёт.
    const depth = frame.depth;
    const tasksOf = () => state().tasks;
    const local = <N extends LocalNamespace>(namespace: N, owner: string, key: string) => {
      if (namespace === 'reproductions')
        return owner === WORKSPACE_OWNER ? reproductionsOf(state(), key) : undefined;
      if (namespace === 'contract-documents') {
        const contract = state().contracts.find((c) => c.digest === key);
        if (contract && owner === WORKSPACE_OWNER) return contractDocumentOf(contract);
      }
      // Одна запись — одним запросом: обход пространства (`locals`) иначе
      // разбирал бы все его записи на каждый ключ.
      const raw = store.localRecord<unknown>(hostSpace(namespace), hostOwner(owner), key);
      if (raw === undefined) return undefined;
      return localSchemas[namespace].parse(
        namespace === 'usage' ? callOf(raw as UsageRecord) : raw,
      ) as never;
    };
    const view: ExecutionTransaction = {
      control: () => controlOf(state()),
      controller: () => controllerOf(state()),
      graph: (id) => {
        const board = state().boards.find((b) => b.id === id);
        return board ? graphOf(state(), board, options) : undefined;
      },
      graphs: () =>
        state()
          .boards.map((b) => graphOf(state(), b, options))
          .filter((g): g is GraphState => !!g),
      work: (id) => {
        const task = tasksOf().find((t) => t.id === id);
        return task ? workOf(state(), task, options) : undefined;
      },
      works: (graphId) =>
        tasksOf()
          .map((t) => workOf(state(), t, options))
          .filter((w) => !graphId || w.graphId === graphId),
      attempt: (id) => {
        const run = state().runs.find((r) => r.id === id);
        return run ? attemptOf(state(), run) : undefined;
      },
      attempts: (workId) =>
        state()
          .runs.filter((r) => !workId || r.taskId === workId)
          .map((r) => attemptOf(state(), r)),
      // Аренда попытки — строка (D53): без строки — срок документа попытки
      // прежней версии (без метки) или 0 у попытки с меткой.
      attemptLease: (id) => {
        const row = store.attemptLeaseRow(id);
        if (row)
          return {
            id,
            token: row.token,
            owner: row.owner,
            engineVersion: row.engine || undefined,
            leaseUntil: row.until,
          };
        const run = state().runs.find((r) => r.id === id);
        return run?.status === 'active'
          ? {
              id,
              token: run.token,
              owner: run.owner,
              engineVersion: run.engineVersion,
              leaseUntil: run.leaseUntil,
            }
          : undefined;
      },
      activeLeases: (at) =>
        state()
          .runs.filter((r) => r.status === 'active' && r.leaseUntil > at)
          .map((r) => ({
            id: r.id,
            token: r.token,
            owner: r.owner,
            engineVersion: r.engineVersion,
            leaseUntil: r.leaseUntil,
          })),
      dataVersion: () => store.revision(),
      pristine: () =>
        writable &&
        this.frame === frame &&
        depth === 0 &&
        frame.depth === 0 &&
        !frame.enclosed &&
        !frame.wrote &&
        frame.revision === store.revision() &&
        frame.drafts.length === 0 &&
        // Попытка со сроком в документе (её ведёт версия до D53, или её
        // ещё не перенесла первая запись этой версии): прежняя версия
        // продлевает срок в документе под видом heartbeat, не меняя ревизию
        // данных. Пока такая попытка активна, кэш по версии не берётся.
        state().runs.every((r) => r.status !== 'active' || !!store.attemptLeaseRow(r.id)),
      renewLease: (kind, id, token, owner, engineVersion, until, now) => {
        inTx();
        frame.wrote = true;
        if (kind !== 'attempt') throw new Error('Неизвестный вид аренды: ' + String(kind));
        return store.renewAttemptLease(id, token, owner, engineVersion ?? '', until, now);
      },
      verification: (id) => verificationsOf(state()).find((v) => v.id === id),
      verifications: () => verificationsOf(state()),
      local: local as ExecutionView['local'],
      locals: ((namespace: LocalNamespace, owner?: string) => {
        if (namespace === 'reproductions')
          return owner && owner !== WORKSPACE_OWNER
            ? []
            : [...new Set((state().reproductions ?? []).map((r) => r.taskId))].map((key) => ({
                owner: WORKSPACE_OWNER,
                key,
                value: reproductionsOf(state(), key)!,
              }));
        const stored = store
          .localEntries<unknown>(hostSpace(namespace))
          .map((e) => ({ owner: e.owner ?? WORKSPACE_OWNER, key: e.key }))
          .filter((e) => owner === undefined || e.owner === owner);
        const contracts =
          namespace === 'contract-documents' && (owner === undefined || owner === WORKSPACE_OWNER)
            ? state().contracts.map((c) => ({ owner: WORKSPACE_OWNER, key: c.digest }))
            : [];
        const seen = new Set<string>();
        return [...contracts, ...stored]
          .filter((e) => {
            const id = e.owner + '\0' + e.key;
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
          })
          .map((e) => ({ ...e, value: local(namespace, e.owner, e.key)! }));
      }) as ExecutionView['locals'],
      putGraph: (graph: GraphState) => putGraph(edit(), graph, options),
      putWork: (work: WorkState) => {
        // Отказ истечения (F74): что будет дальше — по режиму согласования.
        if (work.status === 'failed' && work.failure)
          work = { ...work, failure: expiryText(work.failure, work.id, options) };
        putWork(edit(), work, options);
        frame.works.add(work.id);
      },
      putAttempt: (attempt: AttemptState) => {
        if (attempt.status === 'expired' && attempt.error)
          attempt = { ...attempt, error: expiryText(attempt.error, attempt.workId, options) };
        putAttempt(edit(), attempt);
        frame.attempts.add(attempt.id);
      },
      putVerification: (verification: JointVerificationState) => {
        // Продление срока совместной проверки (jointHeartbeat) — срок
        // владения, как строка аренды попытки: под видом heartbeat ревизию
        // данных не поднимает. Любое другое изменение — запись модели.
        const current = verificationsOf(state()).find((v) => v.id === verification.id);
        const renewal =
          !!current &&
          isDeepStrictEqual({ ...current, leaseUntil: 0 }, { ...verification, leaseUntil: 0 });
        inTx();
        frame.wrote = true;
        if (!renewal) frame.modelWrote = true;
        putVerification(frame.draft.edit(), verification, this.jointTarget);
      },
      setControl: (control) => setControl(edit(), control),
      // Роль controller — своя строка хранилища: её продление документ не копирует.
      setController: (lease) => {
        inTx();
        frame.wrote = true;
        const holder: { leader?: DevContourState['leader'] } = {};
        setController(holder as DevContourState, lease);
        frame.draft.leader = holder.leader;
      },
      putLocal: (namespace: LocalNamespace, owner: string, key: string, value: unknown) => {
        inTx();
        frame.wrote = true;
        const parsed = localSchemas[namespace].parse(value);
        if (namespace === 'reproductions') {
          if (owner !== WORKSPACE_OWNER || key !== (parsed as { workId: string }).workId)
            throw new HarnessError(
              'INVALID_INPUT',
              'Реестр воспроизведений — по поручению у workspace',
            );
          putReproductions(edit(), parsed as Parameters<typeof putReproductions>[1]);
          return;
        }
        store.saveLocal(
          hostSpace(namespace),
          hostOwner(owner || WORKSPACE_OWNER),
          key,
          namespace === 'usage' ? usageOf(parsed as never) : parsed,
          'data',
          // Задание ведущего выдача очереди не читает: его захват, продление
          // и возврат ожидающей стадии шлюз простоя не открывают (F79).
          // Что стадия меняет в задачах и досках — обычная запись данных.
          namespace === 'workflow-jobs',
        );
      },
      emit: (event: RunEventDraft) => {
        inTx();
        frame.wrote = true;
        // Нагрузка закрыта схемой: событие вне договора не записывается.
        runEventSchema.parse({
          apiVersion: API_VERSION,
          seq: 1,
          at: new Date().toISOString(),
          ...event,
        });
        frame.drafts.push(structuredClone(event));
      },
    };
    // Быстрый путь движка (необязательный метод представления): такт очереди
    // ищет истёкшие среди активных попыток и не строит всю историю попыток.
    Object.assign(view, {
      activeAttempts: () =>
        state()
          .runs.filter((r) => r.status === 'active')
          .map((r) => attemptOf(state(), r)),
    });
    this.states.set(view, state);
    this.frames.set(view, frame);
    return view;
  }
}
