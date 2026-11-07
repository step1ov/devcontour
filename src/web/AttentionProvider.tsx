import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { Badge } from '@/ui/badge.tsx';
import { getAttention, postMarks } from './attention-api.ts';
import {
  cardDomId,
  freshItems,
  markKey,
  signatureOf,
  toastText,
  unreadCount,
  withOptimistic,
  type AttentionItem,
  type AttentionView,
  type Optimistic,
} from './attention-logic.ts';
import { focusHash, navigate } from './navigation.ts';

// Один опрос центра внимания на обе оболочки: значок, голова очереди в
// обзоре, экран внимания и уведомления читают один ответ, поэтому два
// компонента не расходятся и не поднимают два уведомления об одном.

/** Опрос, пока вкладка видна: проекция тяжелее сводки, поэтому 3 с, а не 2. */
export const POLL_MS = 3000;
/** Запрос, не ответивший за это время, — сбой: данные устарели, очередь не копится. */
export const REQUEST_TIMEOUT_MS = 10_000;
const MARKS_PER_CALL = 100;

export interface AttentionState {
  /** Последний полученный ответ с локальными отметками до подтверждения. */
  view?: AttentionView;
  items: AttentionItem[];
  /** Непрочитанные карточки оператора — значок. */
  unread: number;
  loading: boolean;
  /** Ошибка без данных: показать нечего. */
  error: string;
  /** Данные есть, последнее обновление не удалось: действия заблокированы. */
  stale: boolean;
  /** Причина устаревания: нет связи (или ответа за 10 с) либо отказ сервера. */
  failure?: { offline: boolean; error: string };
  lastOkAt?: string;
  refresh: () => Promise<void>;
  /** `false` — отметка (часть) не сохранена: сервер не ответил или отказал. */
  mark: (items: readonly AttentionItem[], kind: 'read' | 'ack') => Promise<boolean>;
  /** Экран внимания показан: вместо уведомления — объявление на экране. */
  onScreen: (shown: boolean) => void;
  /** Новые карточки, пришедшие при открытом экране (для живой области). */
  arrived: { seq: number; titles: string[] };
  /** Перейти к экрану внимания (и к карточке). */
  openScreen: (focusKey?: string) => void;
  /** Оболочка сообщает адрес своего экрана внимания, пока показана. */
  registerScreen: (href: () => string) => () => void;
}

const Context = createContext<AttentionState | undefined>(undefined);

export function useAttention() {
  const value = useContext(Context);
  if (!value) throw new Error('useAttention вне AttentionProvider');
  return value;
}

const failure = (status: number, error?: string) =>
  status === 0
    ? 'сервер не отвечает или не ответил за 10 с'
    : (error ?? `сервер ответил ${status}`);

export function AttentionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{
    view?: AttentionView;
    error: string;
    stale: boolean;
    failure?: { offline: boolean; error: string };
    lastOkAt?: string;
  }>({ error: '', stale: false });
  const [optimistic, setOptimistic] = useState<Optimistic>(() => new Map());
  const [arrived, setArrived] = useState({ seq: 0, titles: [] as string[] });
  const signature = useRef('');
  // Время последнего успешного ответа: «данные на …» в строке устаревания.
  const lastOk = useRef<string | undefined>(undefined);
  const seen = useRef<Set<string> | undefined>(undefined);
  const shown = useRef(0);
  const screens = useRef<(() => string)[]>([]);
  const disposed = useRef(false);
  const controller = useRef<AbortController | undefined>(undefined);
  // Один запрос за раз: обещания ждут запроса, начатого после их вызова.
  const inflight = useRef(false);
  const queued = useRef<(() => void)[]>([]);

  const openScreen = useCallback((focusKey?: string) => {
    const href = screens.current.at(-1)?.() ?? '/?tab=attention';
    navigate(href);
    if (focusKey) focusHash(cardDomId(focusKey));
  }, []);

  const notify = useCallback(
    (fresh: AttentionItem[]) => {
      if (!fresh.length) return;
      if (shown.current > 0) {
        setArrived((a) => ({ seq: a.seq + 1, titles: fresh.map((i) => i.title) }));
        return;
      }
      toast(toastText(fresh), {
        // Несколько новых карточек — их названия, а не только число.
        ...(fresh.length > 1 ? { description: fresh.map((i) => i.title).join('; ') } : {}),
        action: { label: 'Открыть', onClick: () => openScreen(fresh[0].sourceKey) },
      });
    },
    [openScreen],
  );

  const kick = useCallback(() => {
    if (inflight.current || disposed.current || !queued.current.length) return;
    inflight.current = true;
    const waiting = queued.current.splice(0);
    const abort = new AbortController();
    controller.current = abort;
    void (async () => {
      try {
        const response = await getAttention(
          {},
          AbortSignal.any([abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        );
        if (disposed.current) return;
        if (!response.ok || !response.body) {
          const error = failure(response.status, response.body?.error);
          setState((s) => ({
            ...s,
            error,
            stale: !!s.view,
            failure: { offline: response.status === 0, error },
            lastOkAt: lastOk.current ?? s.lastOkAt,
          }));
          return;
        }
        const view = response.body;
        const next = signatureOf(view);
        const at = new Date().toISOString();
        lastOk.current = at;
        const step = freshItems(seen.current, view.items);
        seen.current = step.seen;
        if (next === signature.current)
          // Тот же ответ (heartbeat): без перерисовки, только снять устаревание.
          setState((s) =>
            s.stale || s.error
              ? { ...s, error: '', stale: false, failure: undefined, lastOkAt: at }
              : s,
          );
        else {
          signature.current = next;
          setState({ view, error: '', stale: false, failure: undefined, lastOkAt: at });
        }
        notify(step.fresh);
      } catch {
        /* Отмена при размонтировании. */
      } finally {
        // Отменённый при размонтировании запрос не освобождает чужой.
        if (controller.current === abort) inflight.current = false;
        for (const resolve of waiting) resolve();
        kick();
      }
    })();
  }, [notify]);

  const refresh = useCallback(
    () =>
      new Promise<void>((resolve) => {
        queued.current.push(resolve);
        kick();
      }),
    [kick],
  );

  useEffect(() => {
    disposed.current = false;
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    const visible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('focus', visible);
    return () => {
      disposed.current = true;
      clearInterval(timer);
      controller.current?.abort();
      inflight.current = false;
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('focus', visible);
    };
  }, [refresh]);

  const mark = useCallback(
    async (items: readonly AttentionItem[], kind: 'read' | 'ack') => {
      if (!items.length) return true;
      // Отметка — показанной версии: обновление, пришедшее после показа,
      // остаётся непрочитанным.
      const keys = items.map(markKey);
      setOptimistic((o) => {
        const next = new Map(o);
        for (const i of items) {
          const before = next.get(markKey(i));
          next.set(markKey(i), {
            version: i.sourceVersion,
            read: true,
            ack: kind === 'ack' || (before?.version === i.sourceVersion && before.ack),
          });
        }
        return next;
      });
      let ok = true;
      for (let at = 0; at < items.length; at += MARKS_PER_CALL) {
        const r = await postMarks(
          items.slice(at, at + MARKS_PER_CALL).map((i) => ({
            sourceKey: i.sourceKey,
            occurrenceId: i.occurrenceId,
            version: i.sourceVersion,
            kind,
          })),
        );
        ok &&= r.ok;
      }
      await refresh();
      setOptimistic((o) => {
        const next = new Map(o);
        for (const key of keys) next.delete(key);
        return next;
      });
      return ok;
    },
    [refresh],
  );

  const onScreen = useCallback((visible: boolean) => {
    shown.current = Math.max(0, shown.current + (visible ? 1 : -1));
  }, []);

  const registerScreen = useCallback((href: () => string) => {
    screens.current.push(href);
    return () => {
      screens.current = screens.current.filter((h) => h !== href);
    };
  }, []);

  const value = useMemo<AttentionState>(() => {
    const items = state.view ? withOptimistic(state.view.items, optimistic) : [];
    return {
      view: state.view,
      items,
      unread: state.view ? unreadCount(state.view, items) : 0,
      loading: !state.view && !state.error,
      error: state.view ? '' : state.error,
      stale: state.stale,
      failure: state.failure,
      lastOkAt: state.lastOkAt,
      refresh,
      mark,
      onScreen,
      arrived,
      openScreen,
      registerScreen,
    };
  }, [state, optimistic, refresh, mark, onScreen, arrived, openScreen, registerScreen]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Адрес экрана внимания этой оболочки — для уведомления «Открыть». */
export function useAttentionScreen(href: () => string) {
  const { registerScreen } = useAttention();
  const latest = useRef(href);
  latest.current = href;
  useEffect(() => registerScreen(() => latest.current()), [registerScreen]);
}

/**
 * Значок непрочитанных карточек оператора. Цифры скрыты от чтения экрана:
 * вместо них — фраза «новых для вас: N».
 */
export function AttentionCount() {
  const { unread, view } = useAttention();
  if (!view || unread <= 0) return null;
  return (
    <Badge variant="ready" data-attention-count={unread}>
      <span aria-hidden="true">{unread}</span>
      <span className="sr-only">, новых для вас: {unread}</span>
    </Badge>
  );
}
