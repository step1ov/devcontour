import { useCallback, useEffect, useRef, useState } from 'react';
import { onDiscussionChanged } from './discussion-events.ts';
import { Alert, AlertDescription } from '@/ui/alert.tsx';
import { Badge } from '@/ui/badge.tsx';
import { Button } from '@/ui/button.tsx';
import { Label } from '@/ui/label.tsx';
import { Textarea } from '@/ui/textarea.tsx';
import { cn } from '@/lib/utils.ts';

// Обсуждение задачи в карточке. История — локальная у владельца задачи:
// заметка ничего не меняет в задаче, обращение уходит ведущему агенту, а
// утверждённая постановка меняется только его новой ревизией. Текст
// сообщений показывается как текст, без разметки.

type Author = 'operator' | 'lead' | 'runtime';
type Kind = 'note' | 'change-request' | 'answer' | 'disposition';
type Outcome = 'accepted' | 'rejected' | 'needs-answer';
export interface DiscussionMessage {
  id: string;
  seq: number;
  taskId: string;
  author: Author;
  kind: Kind;
  text: string;
  createdAt: string;
  replyTo?: string;
  supersedes?: string;
  disposition?: {
    outcome: Outcome;
    refs: { boardId?: string; revision?: number; taskIds?: string[] };
  };
  /** Ответ на вопрос исполнителя: версия ответа или поздний ответ без продолжения. */
  input?:
    | { requestId: string; revision: number; answerDigest: string }
    | { requestId: string; accepted: false; lifecycle: string };
}
interface Page {
  taskId: string;
  version: number;
  messages: DiscussionMessage[];
  nextCursor?: string;
  previousCursor?: string;
  storage: 'local';
}

/** Предел сервера: 16 KiB UTF-8 на сообщение, без обрезания. */
const TEXT_BYTES = 16 * 1024;
/** Сколько последних сообщений видно сразу и сколько добавляет «Показать ранние». */
const SHOWN = 20;
/** Новые сообщения ведущего и исполнителя подтягиваются опросом. */
const POLL_MS = 20_000;
export const CONFLICT_TEXT = 'Обсуждение изменилось — проверьте новые сообщения и отправьте снова';

const authorNames: Record<Author, string> = {
  operator: 'Вы',
  lead: 'Ведущий агент',
  runtime: 'Исполнитель',
};
const kindNames: Record<Exclude<Kind, 'disposition'>, string> = {
  note: 'заметка',
  'change-request': 'обращение к ведущему',
  answer: 'ответ',
};
const outcomeNames: Record<Outcome, string> = {
  accepted: 'принято',
  rejected: 'отклонено',
  'needs-answer': 'нужен ответ',
};
const outcomeTone: Record<Outcome, 'success' | 'destructive' | 'warning'> = {
  accepted: 'success',
  rejected: 'destructive',
  'needs-answer': 'warning',
};

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Код причины отказа сервера (`version-conflict`, `idempotency-conflict`). */
    readonly code?: string,
  ) {
    super(message);
  }
}
async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    '/api/' + path,
    body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-DevContour-Request': '1' },
          body: JSON.stringify(body),
        },
  );
  const data = (await response.json().catch(() => undefined)) as
    (T & { error?: string; code?: string }) | undefined;
  if (!response.ok || data === undefined)
    throw new HttpError(
      data?.error ?? `сервер ответил ${response.status}`,
      response.status,
      data?.code,
    );
  return data;
}

// Черновик живёт в sessionStorage вкладки. Ключ запроса создаётся при первой
// отправке и привязан к тексту, виду, исправляемому сообщению и запросу
// ведущего, на который это ответ: повтор после
// сбоя и двойной щелчок отправляют тот же ключ, и сервер вернёт ту же запись.
// Любая правка — другое сообщение и другой ключ.
interface Draft {
  text: string;
  key: string;
  kind?: 'note' | 'change-request';
  supersedes?: string;
  /** Ответ на запрос ведущего «нужен ответ»: обращение вернётся ему. */
  replyTo?: string;
}
const draftKey = (taskId: string) => 'devcontour.discussion-draft.' + taskId;
function loadDraft(taskId: string): Draft {
  try {
    const raw = window.sessionStorage.getItem(draftKey(taskId));
    if (raw) return { text: '', key: '', ...(JSON.parse(raw) as Partial<Draft>) };
  } catch {
    // Хранилище недоступно: форма работает и без черновика.
  }
  return { text: '', key: '' };
}
function saveDraft(taskId: string, draft: Draft) {
  try {
    if (draft.text || draft.supersedes || draft.replyTo)
      window.sessionStorage.setItem(draftKey(taskId), JSON.stringify(draft));
    else window.sessionStorage.removeItem(draftKey(taskId));
  } catch {
    // Приватное окно: черновик не сохраняется.
  }
}
const newKey = () =>
  'd' +
  (typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replaceAll('-', '')
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join(''));

const timeFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
const anchor = (id: string) => 'dm-' + id;

export function TaskDiscussion({
  taskId,
  closed = false,
  onOpenTask,
}: {
  taskId: string;
  /** Принятая или отменённая задача: заметка остаётся историей, изменение — новой работой. */
  closed?: boolean;
  onOpenTask?: (id: string) => void;
}) {
  const [messages, setMessages] = useState<DiscussionMessage[]>([]);
  const [version, setVersion] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [shown, setShown] = useState(SHOWN);
  // Cursor страницы перед самой ранней загруженной записью; нет — загружено всё.
  const [older, setOlder] = useState<string | undefined>(undefined);
  const [draft, setDraftState] = useState<Draft>(() => loadDraft(taskId));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState('');
  const inFlight = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const lastSeq = useRef(0);
  const focusTarget = useRef('');

  const setDraft = (next: Draft) => {
    setDraftState(next);
    saveDraft(taskId, next);
  };

  // Первое чтение — последняя страница треда (ранние — по «Показать ранние»),
  // дальше — только записи после последней известной. Записи сливаются по id.
  const refresh = useCallback(
    async (after = lastSeq.current) => {
      let cursor = after ? String(after) : undefined;
      const fresh: DiscussionMessage[] = [];
      let latest = 0;
      if (!after) {
        const page = await call<Page>(
          `tasks/${encodeURIComponent(taskId)}/discussion?latest=1&limit=${SHOWN}`,
        );
        fresh.push(...page.messages);
        latest = page.version;
        setOlder(page.previousCursor);
        cursor = undefined;
      }
      for (; after;) {
        const page = await call<Page>(
          `tasks/${encodeURIComponent(taskId)}/discussion?limit=50` +
            (cursor ? `&cursor=${cursor}` : ''),
        );
        fresh.push(...page.messages);
        latest = page.version;
        if (!page.nextCursor || page.nextCursor === cursor) break;
        cursor = page.nextCursor;
      }
      setMessages((current) => {
        const all = new Map(current.map((m) => [m.id, m]));
        for (const m of fresh) all.set(m.id, m);
        const merged = [...all.values()].sort((a, b) => a.seq - b.seq);
        lastSeq.current = merged.at(-1)?.seq ?? 0;
        return merged;
      });
      setVersion((v) => Math.max(v, latest));
      setLoaded(true);
      setLoadError('');
    },
    [taskId],
  );

  useEffect(() => {
    let alive = true;
    const tick = () => void refresh().catch((e: Error) => alive && setLoadError(e.message));
    tick();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') tick();
    }, POLL_MS);
    // Действие этой вкладки, записавшее сообщение (ответ на вопрос
    // исполнителя), — сразу, без ожидания опроса.
    const unsubscribe = onDiscussionChanged(taskId, tick);
    return () => {
      alive = false;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [refresh, taskId]);

  // Переход по ссылке на сообщение: раскрыть ранние, если цель среди них, и
  // перевести фокус на него после отрисовки.
  useEffect(() => {
    if (!focusTarget.current) return;
    const el = document.getElementById(anchor(focusTarget.current));
    if (!el) return;
    focusTarget.current = '';
    el.scrollIntoView({ block: 'nearest' });
    el.focus();
  });
  const jump = (id: string) => {
    const el = document.getElementById(anchor(id));
    if (el) {
      el.scrollIntoView({ block: 'nearest' });
      el.focus();
      return;
    }
    const index = messages.findIndex((m) => m.id === id);
    if (index < 0) return;
    focusTarget.current = id;
    setShown((s) => Math.max(s, messages.length - index));
  };

  const byId = new Map(messages.map((m) => [m.id, m]));
  const correctedBy = new Map<string, DiscussionMessage>();
  const dispositions = new Map<string, DiscussionMessage>();
  // Ответы оператора на запросы ведущего «нужен ответ», по id обработки.
  const answers = new Map<string, DiscussionMessage>();
  for (const m of messages) {
    if (m.supersedes) correctedBy.set(m.supersedes, m);
    if (m.kind === 'disposition' && m.replyTo) dispositions.set(m.replyTo, m);
    if (m.author === 'operator' && m.replyTo) answers.set(m.replyTo, m);
  }
  /** Обработка — последняя «нужен ответ» по последней версии обращения. */
  const asksAnswer = (m: DiscussionMessage) =>
    m.kind === 'disposition' &&
    m.disposition?.outcome === 'needs-answer' &&
    !!m.replyTo &&
    dispositions.get(m.replyTo)?.id === m.id &&
    !correctedBy.has(m.replyTo);
  const start = Math.max(0, messages.length - shown);
  const visible = messages.slice(start);

  const text = draft.text;
  // Сервер хранит текст как есть: предел — по всему тексту.
  const bytes = new TextEncoder().encode(text).length;
  const tooLong = bytes > TEXT_BYTES;
  const empty = !text.trim();
  const correcting = draft.supersedes ? byId.get(draft.supersedes) : undefined;
  const answering = draft.replyTo ? byId.get(draft.replyTo) : undefined;

  const send = async (kind: 'note' | 'change-request') => {
    if (inFlight.current || empty || tooLong) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    setSent('');
    const key = draft.key && draft.kind === kind ? draft.key : newKey();
    const pending = { ...draft, key, kind };
    setDraft(pending);
    const before = lastSeq.current;
    try {
      const result = await call<{ message: DiscussionMessage; version: number }>(
        `tasks/${encodeURIComponent(taskId)}/discussion`,
        {
          kind,
          text: pending.text,
          idempotencyKey: key,
          expectedVersion: version,
          ...(pending.supersedes ? { supersedes: pending.supersedes } : {}),
          ...(pending.replyTo ? { replyTo: pending.replyTo } : {}),
        },
      );
      setMessages((current) =>
        current.some((m) => m.id === result.message.id)
          ? current
          : [...current, result.message].sort((a, b) => a.seq - b.seq),
      );
      setVersion((v) => Math.max(v, result.version));
      setDraft({ text: '', key: '' });
      setSent(
        pending.replyTo
          ? 'Ответ передан ведущему агенту'
          : kind === 'note'
            ? 'Заметка сохранена'
            : 'Обращение передано ведущему агенту',
      );
      // Записи между прежней версией и отправленной (повтор с тем же ключом
      // возвращает прежнюю запись) — дочитываем с прежнего места.
      await refresh(before).catch(() => undefined);
    } catch (e) {
      const failure = e as Error;
      if (failure instanceof HttpError && failure.status === 409) {
        // Ключ занят другим текстом — это уже другое сообщение: новый ключ.
        if (failure.code === 'idempotency-conflict') setDraft({ ...pending, key: '' });
        await refresh(before).catch(() => undefined);
        setNotice(CONFLICT_TEXT);
      } else setError(failure.message);
    } finally {
      inFlight.current = false;
      setBusy(false);
      textarea.current?.focus();
    }
  };

  const headingId = `discussion-${taskId}`;
  const noteHint = `discussion-note-hint-${taskId}`;
  const changeHint = `discussion-change-hint-${taskId}`;
  const counterId = `discussion-size-${taskId}`;

  return (
    // Запасная цель ссылки на сообщение, которого нет на загруженной странице.
    <section
      id="discussion"
      tabIndex={-1}
      aria-labelledby={headingId}
      className="mt-5 min-w-0 outline-offset-2"
    >
      <h3 id={headingId} className="text-muted-foreground mt-0 mb-1 text-xs font-medium">
        Обсуждение
      </h3>
      <p className="text-muted-foreground mt-0 mb-2 text-xs">
        История хранится локально у владельца задачи и не переносится синхронизацией Git
      </p>
      {loadError && (
        <p role="alert" className="text-destructive m-0 mb-2 text-sm [overflow-wrap:anywhere]">
          Обсуждение не загрузилось: {loadError}{' '}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh().catch((e: Error) => setLoadError(e.message))}
          >
            Повторить
          </Button>
        </p>
      )}
      {loaded && !messages.length && (
        <p className="text-muted-foreground m-0 mb-2 text-sm">Сообщений пока нет.</p>
      )}
      {(start > 0 || older) && (
        <Button
          variant="outline"
          size="sm"
          className="mb-2"
          onClick={() => {
            if (start > 0 || !older) {
              setShown((s) => s + SHOWN);
              return;
            }
            void call<Page>(
              `tasks/${encodeURIComponent(taskId)}/discussion?before=${older}&limit=${SHOWN}`,
            ).then(
              (page) => {
                setMessages((current) => {
                  const all = new Map(current.map((m) => [m.id, m]));
                  for (const m of page.messages) all.set(m.id, m);
                  return [...all.values()].sort((a, b) => a.seq - b.seq);
                });
                setOlder(page.previousCursor);
                setShown((s) => s + SHOWN);
              },
              (e: Error) => setLoadError(e.message),
            );
          }}
        >
          Показать ранние{start > 0 ? ` (${start})` : ''}
        </Button>
      )}
      {visible.length > 0 && (
        <ol className="m-0 grid list-none gap-2 p-0" aria-label="Сообщения обсуждения">
          {visible.map((m) => {
            const correction = correctedBy.get(m.id);
            const handled = dispositions.get(m.id);
            const request = m.replyTo ? byId.get(m.replyTo) : undefined;
            const own =
              m.author === 'operator' && (m.kind === 'note' || m.kind === 'change-request');
            // Исход accepted/rejected окончателен: изменение — новое обращение.
            const final =
              m.kind === 'change-request' &&
              !!handled?.disposition &&
              handled.disposition.outcome !== 'needs-answer';
            return (
              <li
                key={m.id}
                id={anchor(m.id)}
                tabIndex={-1}
                data-message-kind={m.kind}
                className="bg-raised min-w-0 rounded-sm px-2.5 py-2 outline-offset-2"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <strong className="font-medium">{authorNames[m.author]}</strong>
                  {m.kind === 'disposition' && m.disposition ? (
                    <Badge variant={outcomeTone[m.disposition.outcome]}>
                      обработка: {outcomeNames[m.disposition.outcome]}
                    </Badge>
                  ) : (
                    <Badge variant={m.kind === 'change-request' ? 'ready' : 'secondary'}>
                      {kindNames[m.kind as Exclude<Kind, 'disposition'>] ?? m.kind}
                      {m.input && 'revision' in m.input ? ` на вопрос, r${m.input.revision}` : ''}
                    </Badge>
                  )}
                  {m.input && 'accepted' in m.input && (
                    <Badge variant="outline" data-late-answer>
                      не принят: вопрос уже {m.input.lifecycle === 'cancelled' ? 'снят' : 'заменён'}
                    </Badge>
                  )}
                  <time
                    dateTime={m.createdAt}
                    className="text-muted-foreground tabular"
                    title={m.createdAt}
                  >
                    {timeFormat.format(new Date(m.createdAt))}
                  </time>
                </div>
                <p
                  className={cn(
                    'm-0 mt-1 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]',
                    correction && 'text-muted-foreground line-through',
                  )}
                >
                  {correction && <span className="sr-only">Исправлено: </span>}
                  {m.text}
                </p>
                <div className="text-muted-foreground flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs empty:hidden">
                  {correction && (
                    <a
                      href={'#' + anchor(correction.id)}
                      className="text-info underline-offset-2 hover:underline"
                      onClick={(e) => {
                        e.preventDefault();
                        jump(correction.id);
                      }}
                    >
                      Исправлено — к новой версии
                    </a>
                  )}
                  {m.supersedes && (
                    <a
                      href={'#' + anchor(m.supersedes)}
                      className="text-info underline-offset-2 hover:underline"
                      onClick={(e) => {
                        e.preventDefault();
                        jump(m.supersedes!);
                      }}
                    >
                      Исправление прежнего сообщения
                    </a>
                  )}
                  {m.kind === 'disposition' && m.replyTo && (
                    <a
                      href={'#' + anchor(m.replyTo)}
                      className="text-info underline-offset-2 hover:underline"
                      onClick={(e) => {
                        e.preventDefault();
                        jump(m.replyTo!);
                      }}
                    >
                      {request ? 'К обращению' : 'Обращение'}
                    </a>
                  )}
                  {m.disposition && (
                    <DispositionRefs refs={m.disposition.refs} onOpenTask={onOpenTask} />
                  )}
                  {m.kind === 'change-request' &&
                    !correction &&
                    (handled?.disposition?.outcome === 'needs-answer' ? (
                      answers.has(handled.id) ? (
                        <span>Ответ передан — ждёт обработки ведущим агентом</span>
                      ) : (
                        <a
                          href={'#' + anchor(handled.id)}
                          className="text-info underline-offset-2 hover:underline"
                          onClick={(e) => {
                            e.preventDefault();
                            jump(handled.id);
                          }}
                        >
                          Ведущий агент ждёт ответа
                        </a>
                      )
                    ) : handled?.disposition ? (
                      <a
                        href={'#' + anchor(handled.id)}
                        className="text-info underline-offset-2 hover:underline"
                        onClick={(e) => {
                          e.preventDefault();
                          jump(handled.id);
                        }}
                      >
                        Обработано: {outcomeNames[handled.disposition.outcome]}
                      </a>
                    ) : (
                      <span>Ждёт обработки ведущим агентом</span>
                    ))}
                  {m.author === 'operator' &&
                    m.replyTo &&
                    byId.get(m.replyTo)?.kind === 'disposition' && (
                      <a
                        href={'#' + anchor(m.replyTo)}
                        className="text-info underline-offset-2 hover:underline"
                        onClick={(e) => {
                          e.preventDefault();
                          jump(m.replyTo!);
                        }}
                      >
                        Ответ на запрос ведущего
                      </a>
                    )}
                  {asksAnswer(m) && (
                    <button
                      type="button"
                      className="text-info cursor-pointer underline-offset-2 hover:underline"
                      onClick={() => {
                        setDraft({
                          text: draft.supersedes ? '' : draft.text,
                          key: '',
                          replyTo: m.id,
                        });
                        setNotice('');
                        textarea.current?.focus();
                      }}
                    >
                      Ответить
                    </button>
                  )}
                  {own && !correction && !final && (
                    <button
                      type="button"
                      className="text-info cursor-pointer underline-offset-2 hover:underline"
                      onClick={() => {
                        setDraft({ text: m.text, key: '', supersedes: m.id });
                        setNotice('');
                        textarea.current?.focus();
                      }}
                    >
                      Исправить
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <form
        aria-label="Новое сообщение в обсуждении"
        className="mt-3 grid min-w-0 gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send('note');
        }}
      >
        <Label htmlFor={`discussion-text-${taskId}`}>Сообщение</Label>
        {answering && (
          <p className="text-muted-foreground m-0 text-xs">
            Ответ на запрос ведущего агента: обращение вернётся ему на обработку.{' '}
            <button
              type="button"
              className="text-info cursor-pointer underline-offset-2 hover:underline"
              onClick={() => {
                setDraft({ text: draft.text, key: '' });
                textarea.current?.focus();
              }}
            >
              Отменить ответ
            </button>
          </p>
        )}
        {correcting && (
          <p className="text-muted-foreground m-0 text-xs">
            Исправление создаст новую запись; прежняя останется в истории зачёркнутой.{' '}
            <button
              type="button"
              className="text-info cursor-pointer underline-offset-2 hover:underline"
              onClick={() => {
                setDraft({ text: '', key: '' });
                textarea.current?.focus();
              }}
            >
              Отменить исправление
            </button>
          </p>
        )}
        <Textarea
          id={`discussion-text-${taskId}`}
          ref={textarea}
          value={text}
          rows={3}
          aria-invalid={tooLong || undefined}
          aria-describedby={tooLong ? counterId : undefined}
          onChange={(e) => setDraft({ ...draft, text: e.target.value, key: '' })}
          onKeyDown={(e) => {
            // Ctrl/Cmd+Enter — заметка, как основное безопасное действие.
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void send('note');
            }
          }}
        />
        {tooLong && (
          <p id={counterId} className="text-destructive m-0 text-xs">
            Сообщение длиннее {TEXT_BYTES / 1024} KiB ({bytes} байт UTF-8). Сократите текст:
            сохраняемый текст не обрезается.
          </p>
        )}
        {notice && (
          <Alert variant="warning" role="alert">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription className="[overflow-wrap:anywhere]">
              Не отправлено: {error}. Текст сохранён — повтор отправит то же сообщение.
            </AlertDescription>
          </Alert>
        )}
        {answering ? (
          <Button
            type="button"
            variant="outline"
            className="justify-self-start"
            disabled={empty || tooLong}
            aria-busy={busy || undefined}
            onClick={() => void send('note')}
          >
            Ответить ведущему
          </Button>
        ) : (
          <div className="grid gap-2 min-[420px]:grid-cols-2">
            <div className="grid content-start gap-1">
              <Button
                type="button"
                variant="outline"
                disabled={empty || tooLong}
                aria-busy={busy || undefined}
                aria-describedby={noteHint}
                onClick={() => void send('note')}
              >
                Заметка
              </Button>
              <p id={noteHint} className="text-muted-foreground m-0 text-xs">
                Сохраняется в истории: не меняет задачу и не запускает работу.
              </p>
            </div>
            <div className="grid content-start gap-1">
              <Button
                type="button"
                variant="outline"
                disabled={empty || tooLong}
                aria-busy={busy || undefined}
                aria-describedby={changeHint}
                onClick={() => void send('change-request')}
              >
                Предложить изменение
              </Button>
              <p id={changeHint} className="text-muted-foreground m-0 text-xs">
                Обращение к ведущему агенту. Утверждённая задача меняется только новой ревизией,
                которую оформит ведущий
                {closed ? '; для закрытой задачи это будет новая работа' : ''}.
              </p>
            </div>
          </div>
        )}
        <p role="status" className="text-muted-foreground m-0 min-h-4 text-xs">
          {busy ? 'Отправка…' : sent}
        </p>
      </form>
    </section>
  );
}

function DispositionRefs({
  refs,
  onOpenTask,
}: {
  refs: NonNullable<DiscussionMessage['disposition']>['refs'];
  onOpenTask?: (id: string) => void;
}) {
  if (!refs.boardId && !refs.taskIds?.length) return null;
  return (
    <span className="min-w-0 [overflow-wrap:anywhere]">
      {refs.boardId && (
        <>
          доска <code>{refs.boardId}</code>
          {refs.revision ? `, ревизия ${refs.revision}` : ''}
        </>
      )}
      {refs.boardId && refs.taskIds?.length ? '; ' : ''}
      {refs.taskIds?.length ? 'задачи: ' : ''}
      {refs.taskIds?.map((id, i) => (
        <span key={id}>
          {i > 0 && ', '}
          {onOpenTask ? (
            <button
              type="button"
              className="text-info cursor-pointer font-mono underline-offset-2 hover:underline"
              onClick={() => onOpenTask(id)}
            >
              {id}
            </button>
          ) : (
            <code>{id}</code>
          )}
        </span>
      ))}
    </span>
  );
}
