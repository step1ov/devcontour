import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Alert, AlertDescription } from '@/ui/alert.tsx';
import { Badge } from '@/ui/badge.tsx';
import { Button } from '@/ui/button.tsx';
import { Textarea } from '@/ui/textarea.tsx';
import { cn } from '@/lib/utils.ts';
import type { AttentionAction } from '../core/attention-model.ts';
import { postAct } from './attention-api.ts';
import {
  actorLabel,
  cardDomId,
  categoryLabel,
  impactLine,
  openLabel,
  statusText,
  type AttentionItem,
} from './attention-logic.ts';
import { useAttention } from './AttentionProvider.tsx';
import { navigate } from './navigation.ts';

// Карточка центра внимания: что случилось, что блокирует, кто действует,
// следующий шаг и где доказательства. Действие называет показанную версию;
// конфликт заменяет карточку и не исполняется повторно. «Прочитано» и
// «Увидел» — отдельные тихие отметки, не ответ и не принятие.

type Domain = Extract<AttentionAction, { kind: 'domain' }>;
type Handoff = Extract<AttentionAction, { kind: 'handoff' }>;

/** Кнопка не шире колонки: длинная подпись переносится внутри кнопки. */
export const actionClass = 'h-auto max-w-full justify-start whitespace-normal text-left';
const when = (at: string) => new Date(at).toLocaleString('ru-RU');
const TEXT_LIMIT = 3000;
const evidenceNames: Record<AttentionItem['evidence'][number]['kind'], string> = {
  attempt: 'попытка',
  evidence: 'доказательство',
  review: 'ревью',
  event: 'событие',
  artifact: 'артефакт',
  message: 'сообщение',
};
const shortId = (id: string) => (id.length > 12 ? id.slice(0, 12) + '…' : id);

type Draft = {
  open: string | null;
  text: string;
  option: string | null;
  kind: 'clarification' | 'requirement-change';
  /** Ключ повтора открытой формы: повтор после обрыва — без второго эффекта. */
  key: string;
};
const emptyDraft = (): Draft => ({
  open: null,
  text: '',
  option: null,
  kind: 'clarification',
  key: crypto.randomUUID(),
});
// Черновики форм — по предмету карточки, вне компонента: карточка, перешедшая
// в другую группу, перемонтируется, а набранный текст остаётся.
const drafts = new Map<string, Draft>();
function useDraft(sourceKey: string): [Draft, (patch: Partial<Draft>) => void] {
  const [draft, setState] = useState<Draft>(() => drafts.get(sourceKey) ?? emptyDraft());
  const update = (patch: Partial<Draft>) =>
    setState((d) => {
      const next = { ...d, ...patch };
      if (next.open === null && !next.text) drafts.delete(sourceKey);
      else drafts.set(sourceKey, next);
      return next;
    });
  return [draft, update];
}

/** Итог действия для живой области и для решения списка о фокусе. */
export type ActOutcome = { kind: 'updated'; status: string } | { kind: 'resolved'; status: string };

/** Ссылка «Открыть»: настоящая ссылка; обычный щелчок — переход внутри панели. */
export function OpenLink({
  item,
  onOpen,
  className,
}: {
  item: Pick<AttentionItem, 'source' | 'subject' | 'sourceKey'>;
  onOpen?: () => void;
  className?: string;
}) {
  return (
    <Button asChild variant="outline" size="sm" className={cn(actionClass, className)}>
      <a
        href={item.subject.href}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          onOpen?.();
          navigate(item.subject.href, { attentionKey: item.sourceKey });
        }}
      >
        {openLabel(item)}
      </a>
    </Button>
  );
}

/** Команда для ведущего: копируется, а при отказе буфера показывается для выделения. */
export function HandoffCommand({
  command,
  label = 'Команда для ведущего',
}: {
  command: string;
  label?: string;
}) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <span className="grid min-w-0 gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={actionClass}
        onClick={() => {
          void (async () => {
            try {
              await navigator.clipboard.writeText(command);
              setCopied(true);
            } catch {
              setShown(true);
            }
          })();
        }}
      >
        {copied ? 'Команда скопирована' : label}
      </Button>
      {shown && (
        <code className="bg-raised rounded-sm px-1.5 py-1 font-mono text-xs break-all select-all">
          {command}
        </code>
      )}
    </span>
  );
}

function CardForm({
  item,
  action,
  disabled,
  describedBy,
  text,
  setText,
  option,
  setOption,
  kind,
  setKind,
  onSubmit,
  onCancel,
}: {
  item: AttentionItem;
  action: Domain;
  disabled: boolean;
  describedBy?: string;
  text: string;
  setText: (text: string) => void;
  option: string | null;
  setOption: (id: string | null) => void;
  kind: 'clarification' | 'requirement-change';
  setKind: (kind: 'clarification' | 'requirement-change') => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const first = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const fieldId = useId();
  useEffect(() => {
    first.current?.focus();
  }, []);
  const choices = action.input === 'text+option' ? (action.choices ?? []) : [];
  // Вопрос подготовки принимает вариант без текста; вопрос исполнителя —
  // только с текстом ответа.
  const textOptional = item.source === 'prep-question' && option !== null;
  const ready = textOptional || !!text.trim();
  const escape = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    onCancel();
  };
  return (
    <form
      ref={form}
      className="grid min-w-0 gap-2"
      onKeyDown={escape}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !disabled) onSubmit();
      }}
    >
      {choices.length > 0 && (
        <fieldset
          className="m-0 grid min-w-0 gap-1 border-0 p-0"
          // Enter в группе вариантов не отправляет форму.
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT')
              e.preventDefault();
          }}
        >
          <legend className="mb-1 text-xs font-medium">Варианты</legend>
          {choices.map((c, i) => (
            <label key={c.id} className="flex min-w-0 items-start gap-2">
              <input
                ref={i === 0 ? (el) => void (first.current = el) : undefined}
                type="radio"
                name={`${fieldId}-option`}
                value={c.id}
                checked={option === c.id}
                onChange={() => setOption(c.id)}
              />
              <span className="min-w-0">
                {c.label}
                {c.recommended && (
                  <Badge variant="outline" className="ml-2">
                    рекомендует исполнитель
                  </Badge>
                )}
                {c.hint && <span className="text-muted-foreground block text-xs">{c.hint}</span>}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <label className="grid min-w-0 gap-1">
        <span className="text-xs">
          {action.id === 'request-changes' ? 'Что доработать' : 'Ваш ответ'}
          {textOptional ? ' (необязательно)' : ''}
        </span>
        <Textarea
          ref={choices.length ? undefined : (el) => void (first.current = el)}
          value={text}
          required={!textOptional}
          maxLength={TEXT_LIMIT}
          aria-describedby={describedBy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              form.current?.requestSubmit();
            }
          }}
        />
      </label>
      {item.source === 'input' && action.id === 'answer' && (
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={kind === 'requirement-change'}
            onChange={(e) => setKind(e.target.checked ? 'requirement-change' : 'clarification')}
          />
          Ответ меняет требования (корректировка доски, а не продолжение)
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" className={actionClass} disabled={disabled || !ready}>
          {action.label}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Отмена
        </Button>
      </div>
    </form>
  );
}

export function AttentionCard({
  item: shownItem,
  compact = false,
  staleId,
  onOutcome,
}: {
  item: AttentionItem;
  /** Обзор: без доказательств и отметок. */
  compact?: boolean;
  /** Id строки «нет связи»: заблокированные действия ссылаются на неё. */
  staleId?: string;
  onOutcome?: (item: AttentionItem, outcome: ActOutcome) => void;
}) {
  const attention = useAttention();
  const { stale, view } = attention;
  // Карточка из ответа действия или конфликта — до следующего опроса.
  const [override, setOverride] = useState<AttentionItem>();
  const item = override ?? shownItem;
  // Новое появление или версия из опроса заменяет карточку из ответа.
  useEffect(() => setOverride(undefined), [shownItem.occurrenceId, shownItem.sourceVersion]);
  const titleId = useId();
  const [draft, setDraft] = useDraft(shownItem.sourceKey);
  const { open, text, option, kind, key } = draft;
  const setOpen = (value: string | null) => setDraft({ open: value });
  const setText = (value: string) => setDraft({ text: value });
  const setOption = (value: string | null) => setDraft({ option: value });
  const setKind = (value: Draft['kind']) => setDraft({ kind: value });
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState<{ tone: 'warning' | 'destructive'; text: string }>();
  const [unsent, setUnsent] = useState('');
  const alertRef = useRef<HTMLDivElement>(null);
  const openers = useRef(new Map<string, HTMLButtonElement | null>());
  const article = useRef<HTMLElement>(null);
  const operator = item.actor === 'operator';
  // Второй рубеж: доменные действия — только у карточек оператора.
  const domain = operator ? item.actions.filter((a): a is Domain => a.kind === 'domain') : [];
  const handoff = item.actions.find((a): a is Handoff => a.kind === 'handoff');
  const blocked = stale || busy;
  const focusAlert = () => requestAnimationFrame(() => alertRef.current?.focus());

  const closeForm = (id: string) => {
    setOpen(null);
    requestAnimationFrame(() => openers.current.get(id)?.focus());
  };

  const act = async (action: Domain) => {
    if (stale) return;
    setBusy(true);
    setAlert(undefined);
    setUnsent('');
    const textual = action.input === 'text' || action.input === 'text+option';
    const input = textual
      ? {
          ...(text.trim() ? { text: text.trim() } : {}),
          ...(option !== null ? { optionId: option } : {}),
          ...(item.source === 'input' && action.id === 'answer' ? { kind } : {}),
        }
      : action.round !== undefined
        ? { confirmRejectedRound: action.round }
        : undefined;
    try {
      const r = await postAct({
        sourceKey: item.sourceKey,
        occurrenceId: item.occurrenceId,
        expectedVersion: item.sourceVersion,
        action: action.id,
        ...(input ? { input } : {}),
        ...(textual ? { idempotencyKey: key } : {}),
      });
      if (r.ok && r.body) {
        const status = r.body.result?.replayed
          ? 'Ответ уже был сохранён.'
          : statusText(item.source, action.id);
        setDraft(emptyDraft());
        if (r.body.item) {
          setOverride(r.body.item);
          onOutcome?.(item, { kind: 'updated', status });
          requestAnimationFrame(() => article.current?.focus());
        } else onOutcome?.(item, { kind: 'resolved', status });
      } else if (r.status === 409 && r.body?.code === 'attention-stale' && r.body.item) {
        const next = r.body.item;
        setOverride(next);
        setAlert({
          tone: 'warning',
          text: 'Карточка изменилась, пока вы её читали: действие не выполнено. Проверьте новое содержание и решите снова.',
        });
        const still =
          next.actor === 'operator' &&
          next.actions.some((a) => a.kind === 'domain' && a.id === action.id);
        if (!still) {
          if (textual && text.trim()) setUnsent(text);
          setDraft({ open: null, text: '' });
        }
        focusAlert();
      } else if (r.status === 409 && r.body?.code === 'attention-resolved')
        onOutcome?.(item, { kind: 'resolved', status: `Уже решено: «${item.title}»` });
      else if (r.status === 0 || r.status >= 500) {
        setAlert({
          tone: 'destructive',
          text: 'Связи нет: неизвестно, выполнено ли действие. Панель проверит это, когда связь вернётся.',
        });
        focusAlert();
      } else {
        setAlert({ tone: 'destructive', text: r.body?.error ?? `Сервер ответил ${r.status}` });
        focusAlert();
      }
    } finally {
      setBusy(false);
      void attention.refresh();
    }
  };

  const impact = impactLine(item.impact);
  const label = categoryLabel(item);
  const leadAbsent = !operator && view?.lead.present === false;
  const formAction = domain.find((a) => a.id === open);
  // Опрос убрал действие открытой формы (ответ дан в другой вкладке):
  // набранный текст не пропадает молча.
  const orphan = open !== null && !formAction && !unsent && text.trim() ? text : '';

  let next: ReactNode;
  if (domain.length)
    next = domain.map((a, i) => {
      if (a.input === 'confirm')
        return (
          <Button
            key={a.id}
            variant={i === 0 ? 'default' : 'outline'}
            size="sm"
            className={actionClass}
            disabled={blocked}
            aria-describedby={stale ? staleId : undefined}
            onClick={() => void act(a)}
          >
            {a.label}
          </Button>
        );
      return (
        <Button
          key={a.id}
          ref={(el) => void openers.current.set(a.id, el)}
          variant={i === 0 ? 'default' : 'outline'}
          size="sm"
          className={actionClass}
          disabled={blocked}
          aria-describedby={stale ? staleId : undefined}
          aria-expanded={open === a.id}
          onClick={() => {
            if (open !== a.id) {
              setOpen(a.id);
              setOption(null);
            } else closeForm(a.id);
          }}
        >
          {a.label}
        </Button>
      );
    });

  return (
    <article
      ref={article}
      id={compact ? undefined : cardDomId(item.sourceKey)}
      aria-labelledby={titleId}
      aria-busy={busy || undefined}
      tabIndex={-1}
      data-attention-key={item.sourceKey}
      data-attention-actor={item.actor}
      className="grid min-w-0 gap-2 rounded-md border p-3 text-sm outline-offset-2 [overflow-wrap:anywhere]"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge variant={label.variant}>{label.text}</Badge>
        <h3 id={titleId} className="m-0 min-w-0 text-sm font-semibold">
          {item.title}
        </h3>
        {item.state.unread ? (
          <Badge variant="ready">новое</Badge>
        ) : item.state.acknowledged ? (
          <Badge variant="secondary">вы видели</Badge>
        ) : null}
      </div>
      <p className="m-0 whitespace-pre-wrap">{item.reason}</p>
      {domain.map(
        (a) =>
          a.prompt && (
            <details key={a.id} className="text-sm">
              <summary className="text-muted-foreground cursor-pointer">
                {a.round !== undefined ? 'Находки ревью полностью' : 'Вопрос полностью'}
              </summary>
              <p className="mt-1 mb-0 whitespace-pre-wrap">{a.prompt}</p>
            </details>
          ),
      )}
      {impact && <p className="text-muted-foreground m-0">{impact}</p>}
      <p className="text-muted-foreground m-0">
        Кто действует: <span className="text-foreground">{actorLabel(item.actor)}</span>
        {leadAbsent ? ' — сейчас не на связи' : ''}
      </p>
      {!operator && (
        <p className="m-0">Ведущий агент разберёт это сам; от вас действие не требуется.</p>
      )}
      {alert && (
        <Alert
          ref={alertRef}
          tabIndex={-1}
          role="alert"
          variant={alert.tone}
          className="outline-offset-2"
        >
          <AlertDescription>{alert.text}</AlertDescription>
        </Alert>
      )}
      {(unsent || orphan) && (
        <div className="grid min-w-0 gap-1">
          {orphan && (
            <p className="text-warning m-0 text-xs">
              Карточка изменилась: это действие больше не предлагается.
            </p>
          )}
          <span className="text-xs font-medium">Ваш неотправленный текст</span>
          <p className="bg-raised m-0 rounded-sm p-2 whitespace-pre-wrap" data-attention-unsent>
            {unsent || orphan}
          </p>
          <div className="flex flex-wrap gap-2">
            <HandoffCommand command={unsent || orphan} label="Скопировать" />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setUnsent('');
                setDraft(emptyDraft());
              }}
            >
              Убрать текст
            </Button>
          </div>
        </div>
      )}
      {formAction && (
        <CardForm
          item={item}
          action={formAction}
          disabled={blocked}
          describedBy={stale ? staleId : undefined}
          text={text}
          setText={setText}
          option={option}
          setOption={setOption}
          kind={kind}
          setKind={setKind}
          onSubmit={() => void act(formAction)}
          onCancel={() => closeForm(formAction.id)}
        />
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {next}
        <OpenLink
          item={item}
          onOpen={() => {
            // Переход по ссылке — чтение карточки: отметка показанной версии.
            if (!compact && item.state.unread && !stale) void attention.mark([item], 'read');
          }}
        />
        {!operator && handoff && <HandoffCommand command={handoff.command} />}
        {!compact && (
          <>
            <span aria-hidden="true" className="bg-border mx-1 h-4 w-px shrink-0" />
            {item.state.unread && (
              <Button
                variant="ghost"
                size="sm"
                disabled={stale}
                aria-label={`Прочитано: ${item.title}`}
                onClick={() => void attention.mark([item], 'read')}
              >
                Прочитано
              </Button>
            )}
            {!item.state.acknowledged && (
              <Button
                variant="ghost"
                size="sm"
                disabled={stale}
                aria-label={`Увидел: ${item.title}`}
                title="Отметить, что вы знаете о карточке. Вопрос останется в списке, пока не решён."
                onClick={() => void attention.mark([item], 'ack')}
              >
                Увидел
              </Button>
            )}
          </>
        )}
      </div>
      {!compact && (
        <details className="text-sm">
          <summary className="text-muted-foreground cursor-pointer">
            Доказательства и подробности
          </summary>
          <dl className="my-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            {item.evidence.map((e) => (
              <div key={e.kind + e.id} className="contents">
                <dt>{evidenceNames[e.kind]}</dt>
                <dd className="m-0 min-w-0">
                  {e.href ? (
                    <a
                      href={e.href}
                      className="font-mono break-all"
                      onClick={(ev) => {
                        if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
                        ev.preventDefault();
                        navigate(e.href!, { attentionKey: item.sourceKey });
                      }}
                    >
                      {shortId(e.id)}
                    </a>
                  ) : (
                    <span className="font-mono break-all">{shortId(e.id)}</span>
                  )}
                </dd>
              </div>
            ))}
            <dt>С</dt>
            <dd className="m-0">{when(item.since)}</dd>
            {item.updatedAt && (
              <>
                <dt>Обновлено</dt>
                <dd className="m-0">{when(item.updatedAt)}</dd>
              </>
            )}
            <dt>Ключ</dt>
            <dd className="m-0 min-w-0">
              <code className="font-mono break-all">{item.sourceKey}</code>
            </dd>
          </dl>
        </details>
      )}
    </article>
  );
}
