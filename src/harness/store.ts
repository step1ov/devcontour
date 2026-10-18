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
import {
  API_VERSION,
  HarnessError,
  STATE_VERSION,
  WORKSPACE_OWNER,
  localSchemas,
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
import type { Store } from '../core/store.ts';
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
  type ProjectionOptions,
} from './projection.ts';

/** Не больше событий в одной транзакции: курсор отводит на транзакцию 1024 номера. */
export const MAX_EVENTS_PER_TRANSACTION = 1024;
const SEQ = 1024;

type LocalNamespace = keyof typeof localSchemas;

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
  state: DevContourState;
  drafts: RunEventDraft[];
  legacy?: Record<string, unknown>;
  works: Set<string>;
  attempts: Set<string>;
}

/** Копия без полей `token` на любой глубине: токен владения не попадает в журнал. */
export function withoutTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTokens);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => k !== 'token')
        .map(([k, v]) => [k, withoutTokens(v)]),
    );
  return value;
}

const hostOwner = (owner: string) => (owner === WORKSPACE_OWNER ? undefined : owner);

export class DevContourExecutionStore implements ExecutionStore {
  readonly stateVersion = STATE_VERSION;
  private frame?: Frame;
  /** Документ DevContour каждого выданного вида: порты хоста читают продуктовые поля. */
  private readonly states = new WeakMap<ExecutionView, DevContourState>();
  constructor(
    readonly store: Store,
    readonly options: ProjectionOptions,
  ) {}

  /**
   * Транзакция хоста: продуктовые поля и переходы движка — одна запись.
   * Транзакции движка внутри неё — вложенные. Хост не вызывает внутри
   * `Store.change`: тот перечитал бы документ поверх изменений транзакции.
   */
  host<T>(kind: string, fn: (h: HostTransaction) => T): T {
    if (this.frame) throw new Error('Транзакция хоста открывается только снаружи');
    return this.outer(kind, (frame) =>
      fn({
        state: frame.state,
        journal: (data) => (frame.legacy = data),
        tx: this.view(frame),
      }),
    );
  }

  transact<T>(kind: TransactionKind, fn: (tx: ExecutionTransaction) => T): T {
    const frame = this.frame;
    if (!frame) return this.outer(kind, (f) => fn(this.view(f)));
    // Вложенная: тот же документ; при отказе возвращается её часть документа и журнала.
    const saved = structuredClone(frame.state);
    const drafts = frame.drafts.length;
    const legacy = frame.legacy;
    const works = new Set(frame.works);
    const attempts = new Set(frame.attempts);
    try {
      return this.store.atomic(() => this.settled(fn(this.view(frame))));
    } catch (error) {
      const state = frame.state as unknown as Record<string, unknown>;
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, saved);
      frame.drafts.length = drafts;
      frame.legacy = legacy;
      frame.works = works;
      frame.attempts = attempts;
      throw error;
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
    this.store.atomic(() => {
      const before = this.store.lastEventId();
      this.store.change(kind, (state) => {
        const frame: Frame = { state, drafts: [], works: new Set(), attempts: new Set() };
        this.frame = frame;
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
      });
      // Store.change не пишет событие, если документ не изменился: событие
      // транзакции с нейтральными событиями записывается явно, в ней же.
      if (kind !== 'heartbeat' && drafts.length && this.store.lastEventId() === before)
        this.store.appendEvent(
          kind,
          data,
          // Получение и освобождение роли controller — сроки владения, не данные.
          drafts.every((d) => d.type.startsWith('controller.')) ? 'lease' : 'data',
        );
    });
    return out;
  }

  /** Данные события журнала: прежняя форма (от хоста или ссылки транзакции) и нейтральные события. */
  private journalData(frame: Frame): Record<string, unknown> | null {
    const legacy =
      frame.legacy ??
      (() => {
        const runId = frame.attempts.size === 1 ? [...frame.attempts][0] : undefined;
        const run = runId ? frame.state.runs.find((r) => r.id === runId) : undefined;
        const taskId = run?.taskId ?? (frame.works.size === 1 ? [...frame.works][0] : undefined);
        return { ...(taskId ? { taskId } : {}), ...(runId ? { runId } : {}) };
      })();
    const data = {
      ...(withoutTokens(legacy) as Record<string, unknown>),
      ...(frame.drafts.length ? { harnessEvents: frame.drafts } : {}),
    };
    return Object.keys(data).length ? data : null;
  }

  read<T>(fn: (view: ExecutionView) => T): T {
    if (this.frame) return fn(this.view(this.frame));
    return this.store.snapshot(() => {
      const frame: Frame = {
        state: this.store.read(),
        drafts: [],
        works: new Set(),
        attempts: new Set(),
      };
      return this.settled(fn(this.view(frame, false)));
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
            out.push(
              runEventSchema.parse({
                apiVersion: API_VERSION,
                seq,
                at: e.at,
                ...draft,
              }) as RunEvent,
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
    return state;
  }

  private view(frame: Frame, writable = true): ExecutionTransaction {
    const { options, store } = this;
    const state = () => frame.state;
    const inTx = () => {
      if (!writable || this.frame !== frame) throw new Error('Запись вне транзакции');
    };
    const tasksOf = () => state().tasks;
    const local = <N extends LocalNamespace>(namespace: N, owner: string, key: string) => {
      if (namespace === 'reproductions')
        return owner === WORKSPACE_OWNER ? reproductionsOf(state(), key) : undefined;
      if (namespace === 'contract-documents') {
        const contract = state().contracts.find((c) => c.digest === key);
        if (contract && owner === WORKSPACE_OWNER) return contractDocumentOf(contract);
      }
      const raw = store.localRecords<unknown>(hostNamespace[namespace], hostOwner(owner))[key];
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
          .localEntries<unknown>(hostNamespace[namespace])
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
      putGraph: (graph: GraphState) => {
        inTx();
        putGraph(state(), graph, options);
      },
      putWork: (work: WorkState) => {
        inTx();
        putWork(state(), work, options);
        frame.works.add(work.id);
      },
      putAttempt: (attempt: AttemptState) => {
        inTx();
        putAttempt(state(), attempt);
        frame.attempts.add(attempt.id);
      },
      putVerification: (verification: JointVerificationState) => {
        inTx();
        putVerification(state(), verification);
      },
      setControl: (control) => {
        inTx();
        setControl(state(), control);
      },
      setController: (lease) => {
        inTx();
        setController(state(), lease);
      },
      putLocal: (namespace: LocalNamespace, owner: string, key: string, value: unknown) => {
        inTx();
        const parsed = localSchemas[namespace].parse(value);
        if (namespace === 'reproductions') {
          if (owner !== WORKSPACE_OWNER || key !== (parsed as { workId: string }).workId)
            throw new HarnessError(
              'INVALID_INPUT',
              'Реестр воспроизведений — по поручению у workspace',
            );
          putReproductions(state(), parsed as Parameters<typeof putReproductions>[1]);
          return;
        }
        store.saveLocal(
          hostNamespace[namespace],
          hostOwner(owner || WORKSPACE_OWNER),
          key,
          namespace === 'usage' ? usageOf(parsed as never) : parsed,
        );
      },
      emit: (event: RunEventDraft) => {
        inTx();
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
    this.states.set(view, frame.state);
    return view;
  }
}
