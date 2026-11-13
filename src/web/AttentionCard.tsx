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
import { CONTRACT_ANSWER_NOTE } from './input-labels.ts';
import {
  draftKey,
  emptyDraft,
  openPin,
  answerEdit,
  pinOf,
  pinStale,
  unsentWhy,
  useDraft,
  type Draft,
} from './attention-drafts.ts';

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

/** Итог действия для живой области и для решения списка о фокусе. */
export type ActOutcome = { kind: 'updated'; status: string } | { kind: 'resolved'; status: string };

/**
 * Неотправленный текст формы, только для чтения: объяснение, копирование и
 * «Убрать». Цель фокуса, когда карточка под формой изменилась или исчезла.
 */
export function UnsentText({
  text,
  why,
  onDrop,
  ref,
  id,
}: {
  text: string;
  why: string;
  onDrop: () => void;
  ref?: React.Ref<HTMLDivElement>;
  id?: string;
}) {
  return (
    <div
      ref={ref}
      id={id}
      tabIndex={-1}
      role="group"
      aria-label="Ваш неотправленный текст"
      className="border-warning/30 bg-warning-foreground grid min-w-0 gap-1 rounded-md border p-2 outline-offset-2"
    >
      <p className="text-warning m-0 text-xs">{why}</p>
      <span className="text-xs font-medium">Ваш неотправленный текст</span>
      <p className="bg-card m-0 rounded-sm p-2 whitespace-pre-wrap" data-attention-unsent>
        {text}
      </p>
      <div className="flex flex-wrap gap-2">
        <HandoffCommand command={text} label="Скопировать" />
        <Button type="button" variant="ghost" size="sm" onClick={onDrop}>
          Убрать текст
        </Button>
      </div>
    </div>
  );
}

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
    <span className="grid min-w-0 justify-items-start gap-1">
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
  // Выбранный вариант без текста — ответ этим вариантом (вопрос подготовки и
  // вопрос исполнителя, как на сервере).
  const textOptional = option !== null;
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
      <label className="mt-0 grid min-w-0 gap-1">
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
        <label className="mt-0 flex min-w-0 flex-row items-start gap-2 text-xs font-normal">
          <input
            type="checkbox"
            className="mt-0.5 shrink-0"
            checked={kind === 'requirement-change'}
            onChange={(e) => setKind(e.target.checked ? 'requirement-change' : 'clarification')}
          />
          <span className="min-w-0">
            Ответ меняет требования (корректировка доски, а не продолжение)
          </span>
        </label>
      )}
      {item.source === 'input' && action.contract && (
        <p className="text-warning m-0 text-xs" data-contract-answer-note>
          {CONTRACT_ANSWER_NOTE}
        </p>
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
  /** Обзор: без доказательств и отметок, заголовок на уровень ниже раздела. */
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
  const Title = compact ? 'h4' : 'h3';
  // Черновик — этого появления; версия, которую он называет, закреплена
  // при открытии формы.
  const [draft, setDraft] = useDraft(draftKey(shownItem));
  const { open, text, option, kind, key } = draft;
  const setText = (value: string) => setDraft(answerEdit(draft, { text: value }));
  const setOption = (value: string | null) => setDraft(answerEdit(draft, { option: value }));
  const setKind = (value: Draft['kind']) => setDraft(answerEdit(draft, { kind: value }));
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState<{ tone: 'warning' | 'destructive'; text: string }>();
  const [markNote, setMarkNote] = useState('');
  const alertRef = useRef<HTMLDivElement>(null);
  const changedRef = useRef<HTMLDivElement>(null);
  const unsentRef = useRef<HTMLDivElement>(null);
  const ackRef = useRef<HTMLButtonElement>(null);
  const openers = useRef(new Map<string, HTMLButtonElement | null>());
  const article = useRef<HTMLElement>(null);
  const operator = item.actor === 'operator';
  // Второй рубеж: доменные действия — только у карточек оператора.
  const domain = operator ? item.actions.filter((a): a is Domain => a.kind === 'domain') : [];
  const handoff = item.actions.find((a): a is Handoff => a.kind === 'handoff');
  const blocked = stale || busy;
  const focusAlert = () => requestAnimationFrame(() => alertRef.current?.focus());

  const closeForm = (id: string) => {
    setDraft({ open: null });
    requestAnimationFrame(() => openers.current.get(id)?.focus());
  };
  // Отметки убирают свои кнопки: фокус — на следующей отметке или на карточке,
  // а не на body.
  const markCard = async (kind: 'read' | 'ack') => {
    setMarkNote('');
    requestAnimationFrame(() =>
      (kind === 'read' && ackRef.current ? ackRef.current : article.current)?.focus(),
    );
    const ok = await attention.mark([item], kind);
    if (!ok) setMarkNote('Отметка не сохранена: сервер не ответил. Повторите позже.');
  };

  const act = async (action: Domain) => {
    if (stale) return;
    setBusy(true);
    setAlert(undefined);
    const textual = action.input === 'text' || action.input === 'text+option';
    // Текстовое действие называет версию, закреплённую при открытии формы.
    const shown = textual && draft.pin ? draft.pin : item;
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
        occurrenceId: shown.occurrenceId,
        expectedVersion: shown.sourceVersion,
        action: action.id,
        ...(input ? { input } : {}),
        ...(textual ? { idempotencyKey: key } : {}),
      });
      if (r.ok && r.body) {
        const status = r.body.result?.replayed
          ? 'Ответ уже был сохранён.'
          : statusText(item.source, action.id);
        setDraft({ ...emptyDraft(), open: null, text: '' });
        if (r.body.item) {
          setOverride(r.body.item);
          onOutcome?.(item, { kind: 'updated', status });
          requestAnimationFrame(() => article.current?.focus());
        } else onOutcome?.(item, { kind: 'resolved', status });
      } else if (r.status === 409 && r.body?.code === 'attention-stale' && r.body.item) {
        // Форма остаётся с текстом; предупреждение об изменении карточки
        // и выбор новой версии — ниже (черновик закреплён за прежней).
        const next = r.body.item;
        setOverride(next);
        const still =
          next.actor === 'operator' &&
          next.occurrenceId === shown.occurrenceId &&
          next.actions.some((a) => a.kind === 'domain' && a.id === action.id);
        if (textual && still)
          // Форма остаётся: предупреждение с выбором новой версии — её alert.
          requestAnimationFrame(() => changedRef.current?.focus());
        else {
          // Действие больше не предлагается: объявление и фокус — на
          // предупреждении, неотправленный текст — под ним.
          setAlert({
            tone: 'warning',
            text: 'Карточка изменилась, пока вы её читали: действие не выполнено. Проверьте новое содержание и решите снова.',
          });
          focusAlert();
        }
      } else if (r.status === 409 && r.body?.code === 'attention-resolved')
        onOutcome?.(item, {
          kind: 'resolved',
          status:
            `Уже решено: «${item.title}».` +
            (textual && text.trim()
              ? // На обзоре раздела «Неотправленные ответы» нет: текст — в центре внимания.
                compact
                ? ' Ваш текст не отправлен и сохранён в центре внимания.'
                : ' Ваш текст не отправлен и сохранён в «Неотправленные ответы».'
              : ''),
        });
      else if (r.status === 0 || r.status >= 500) {
        // Исход неизвестен: если карточка потом исчезнет, текст назовётся
        // «возможно, отправлен».
        if (textual) setDraft({ attempted: true });
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
  const offered = domain.find((a) => a.id === open);
  // Карточка изменилась после открытия формы (новая версия того же
  // появления): форма не отправляется молча под новой версией.
  const changed =
    !!offered && pinStale(draft, item) && draft.pin?.occurrenceId === item.occurrenceId;
  // Действие больше не предлагается или появление сменилось: текст — только
  // для чтения, с копированием.
  const orphan =
    open !== null &&
    text.trim() &&
    (!offered || (!!draft.pin && draft.pin.occurrenceId !== item.occurrenceId))
      ? text
      : '';
  const formAction = orphan ? undefined : offered;
  // Действие исчезло из-под открытой формы — фокус на неотправленном тексте,
  // если он был в этой карточке (опрос не уводит фокус из другого места).
  // Изменение версии объявляет role=alert, не уводя фокус из поля ввода.
  const wasOrphan = useRef(false);
  useEffect(() => {
    if (orphan && !wasOrphan.current && !alert) {
      const active = document.activeElement;
      if (!active || active === document.body || article.current?.contains(active))
        requestAnimationFrame(() => unsentRef.current?.focus());
    }
    wasOrphan.current = !!orphan;
  }, [orphan, alert]);

  let next: ReactNode;
  if (domain.length)
    // Кнопка открытой формы скрыта: отправка — в самой форме, под тем же
    // названием; Esc и «Отмена» возвращают фокус на эту кнопку.
    next = domain.map((a, i) => {
      if (a.id === open && formAction) return null;
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
            // Черновик с текстом сохраняет прежнюю версию: если карточка
            // изменилась, повторное открытие покажет «Карточка изменилась»,
            // и ответить на новую версию можно только явным выбором.
            if (open !== a.id)
              setDraft({
                open: a.id,
                option: draft.text.trim() ? option : null,
                pin: openPin(draft, item),
              });
            else closeForm(a.id);
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
        <Title id={titleId} className="m-0 min-w-0 text-sm font-semibold">
          {item.title}
        </Title>
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
            // Решение за владельца подтверждают, прочитав его целиком: текст открыт.
            <details key={a.id} className="text-sm" open={item.source === 'stand-in'}>
              <summary className="text-muted-foreground cursor-pointer">
                {a.round !== undefined
                  ? 'Находки ревью полностью'
                  : a.id === 'confirm-proposal'
                    ? 'Ответ ведущего и обоснование'
                    : item.source === 'stand-in'
                      ? 'Решение полностью'
                      : 'Вопрос полностью'}
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
      {changed && (
        <Alert
          ref={changedRef}
          tabIndex={-1}
          role="alert"
          variant="warning"
          className="grid gap-2 outline-offset-2"
          data-attention-changed
        >
          <AlertDescription>
            Карточка изменилась, пока вы писали: выше — новое содержание. Ваш текст сохранён и не
            отправлен. Отправьте его, только если он подходит к новой версии.
          </AlertDescription>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(actionClass, 'justify-self-start')}
            disabled={blocked}
            onClick={() => {
              // Кнопка исчезает вместе с предупреждением: фокус — в поле ответа.
              setDraft({ pin: pinOf(item) });
              requestAnimationFrame(() =>
                article.current?.querySelector<HTMLTextAreaElement>('form textarea')?.focus(),
              );
            }}
          >
            Ответить на новую версию
          </Button>
        </Alert>
      )}
      {orphan && (
        <UnsentText
          ref={unsentRef}
          text={orphan}
          why={unsentWhy(
            draft,
            'Карточка изменилась: это действие больше не предлагается. Ваш текст не отправлен.',
          )}
          onDrop={() => setDraft({ open: null, text: '' })}
        />
      )}
      {formAction && (
        <CardForm
          item={item}
          action={formAction}
          disabled={blocked || changed}
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
            if (item.state.unread && !stale) void attention.mark([item], 'read');
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
                onClick={() => void markCard('read')}
              >
                Прочитано
              </Button>
            )}
            {!item.state.acknowledged && (
              <Button
                ref={ackRef}
                variant="ghost"
                size="sm"
                disabled={stale}
                aria-label={`Увидел: ${item.title}`}
                title="Отметить, что вы знаете о карточке. Вопрос останется в списке, пока не решён."
                onClick={() => void markCard('ack')}
              >
                Увидел
              </Button>
            )}
          </>
        )}
      </div>
      {markNote && (
        <p role="status" className="text-destructive m-0 text-xs">
          {markNote}
        </p>
      )}
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
