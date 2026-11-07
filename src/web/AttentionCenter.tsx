import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { Alert, AlertDescription } from '@/ui/alert.tsx';
import { Button } from '@/ui/button.tsx';
import { Label } from '@/ui/label.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs.tsx';
import { humanError } from '@/lib/utils.ts';
import type { AttentionAction, AttentionCategory } from '../core/attention-model.ts';
import { getAttention } from './attention-api.ts';
import {
  cardDomId,
  groupByActor,
  nextFocusKey,
  type AttentionItem,
  type AttentionView,
} from './attention-logic.ts';
import { AttentionCard, HandoffCommand, UnsentText, type ActOutcome } from './AttentionCard.tsx';
import {
  emptyGoneDrafts,
  hasText,
  orphanDrafts,
  removeDraft,
  unsentWhy,
  useDrafts,
} from './attention-drafts.ts';
import { REQUEST_TIMEOUT_MS } from './AttentionProvider.tsx';
import { useAttention } from './AttentionProvider.tsx';
import { AttentionHistory } from './AttentionHistory.tsx';
import { forgetAttentionKey, rememberedAttentionKey } from './navigation.ts';

// Экран центра внимания: одна очередь в двух группах — что ждёт решения
// оператора и что разбирает ведущий агент. Порядок и состав — серверные;
// экран только фильтрует, группирует и держит фокус осмысленным.

type Who = '' | 'operator' | 'lead';
const categories: { value: '' | AttentionCategory; label: string }[] = [
  { value: '', label: 'Все' },
  { value: 'access', label: 'Доступ' },
  { value: 'budget', label: 'Бюджет' },
  { value: 'question', label: 'Вопросы' },
  { value: 'decision', label: 'Решения' },
  { value: 'technical', label: 'Технические' },
];
export const selectClass =
  'border-input bg-card h-(--control-height) rounded-sm border px-2 text-sm max-[760px]:w-full';

type Sub = 'active' | 'history';
const readSub = (): Sub =>
  new URLSearchParams(window.location.search).get('attention') === 'history' ? 'history' : 'active';
const readWho = (): Who => {
  const who = new URLSearchParams(window.location.search).get('who');
  return who === 'operator' || who === 'lead' ? who : '';
};
/** Параметр экрана в адресе — заменой записи: фильтр не плодит «Назад». */
export function writeParam(key: string, value: string) {
  const params = new URLSearchParams(window.location.search);
  if (value) params.set(key, value);
  else params.delete(key);
  const search = params.toString();
  window.history.replaceState(
    window.history.state as unknown,
    '',
    window.location.pathname + (search ? '?' + search : '') + window.location.hash,
  );
}

/** Строка устаревания: нет связи или сервер отказал — сказано по-разному. */
export const staleLine = (at?: string, failure?: { offline: boolean; error: string }) =>
  (failure && !failure.offline
    ? `Сервер не смог обновить список (${failure.error})`
    : 'Нет связи с сервером') +
  `: данные на ${at ? new Date(at).toLocaleTimeString('ru-RU') : '—'} могут быть устаревшими. Действия станут доступны после обновления.`;
export const unsentDomId = (id: string) => 'attention-unsent-' + id;

type Handoff = Extract<AttentionAction, { kind: 'handoff' }>;

export function AttentionCenter({
  components = [],
}: {
  /** Компоненты (репозитории) — фильтр, когда их больше одного. */
  components?: { id: string; label: string }[];
}) {
  const attention = useAttention();
  const { onScreen, arrived } = attention;
  useEffect(() => {
    onScreen(true);
    return () => onScreen(false);
  }, [onScreen]);
  const baseId = useId();
  const staleId = `${baseId}-stale`;
  const [who, setWho] = useState<Who>(readWho);
  const [sub, setSub] = useState<Sub>(readSub);
  const [category, setCategory] = useState<'' | AttentionCategory>('');
  const [component, setComponent] = useState('');
  const [message, setMessage] = useState('');
  // Решённые своим действием карточки скрываются сразу, до опроса.
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const [leadOpen, setLeadOpen] = useState<boolean | null>(null);
  useEffect(() => {
    const restore = () => {
      setWho(readWho());
      setSub(readSub());
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  const chooseWho = (value: Who) => {
    setWho(value);
    writeParam('who', value);
  };
  const chooseSub = (value: Sub) => {
    setSub(value);
    writeParam('attention', value === 'history' ? 'history' : '');
  };

  // Фильтр компонента решает сервер по репозиторию задачи: свой запрос на
  // каждом обновлении общего ответа; значок — по-прежнему из общего.
  // Ответ относится к своему компоненту: при смене фильтра прежний не
  // показывается; запрос ограничен по времени, отказ назван.
  const [filtered, setFiltered] = useState<{ component: string; view: AttentionView }>();
  const [filterError, setFilterError] = useState('');
  useEffect(() => {
    if (!component) {
      setFiltered(undefined);
      setFilterError('');
      return;
    }
    const abort = new AbortController();
    getAttention(
      { component },
      AbortSignal.any([abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    )
      .then((r) => {
        if (r.ok && r.body) {
          setFiltered({ component, view: r.body });
          setFilterError('');
        } else
          setFilterError(
            r.status === 0
              ? 'сервер не отвечает или не ответил за 10 с'
              : (r.body?.error ?? `сервер ответил ${r.status}`),
          );
      })
      .catch(() => undefined);
    return () => abort.abort();
  }, [component, attention.view]);

  // Новое появление под формой с текстом уже объявлено своим сообщением
  // (ниже): общее «Новая карточка» его не перекрывает, а другие новые
  // карточки того же опроса дописываются к нему. Ключ — id появления:
  // необъявленная запись не скроет следующее появление того же предмета.
  const announced = useRef(new Set<string>());
  useEffect(() => {
    if (!arrived.seq) return;
    const own = arrived.ids.filter((id) => announced.current.has(id));
    announced.current.clear();
    const titles = arrived.titles.filter((_, i) => !own.includes(arrived.ids[i]));
    if (!titles.length) return;
    const text = `Новая карточка: ${titles.join('; ')}`;
    setMessage((m) => (own.length ? `${m} ${text}` : text));
  }, [arrived]);

  const source = useMemo(
    () =>
      component ? (filtered?.component === component ? filtered.view.items : []) : attention.items,
    [component, filtered, attention.items],
  );
  const items = useMemo(
    () => source.filter((i) => !gone.has(i.id) && (!category || i.category === category)),
    [source, gone, category],
  );
  // Скрытое своим действием появление, исчезнувшее и из ответа, больше не
  // держится; новое появление того же предмета видно сразу.
  useEffect(() => {
    if (!gone.size) return;
    const present = new Set(source.map((i) => i.id));
    const keep = [...gone].filter((k) => present.has(k));
    if (keep.length !== gone.size) setGone(new Set(keep));
  }, [source, gone]);
  const groups = useMemo(() => groupByActor(items), [items]);

  // Фокус: какая карточка в фокусе, и порядок групп до изменения.
  const focused = useRef('');
  const ownAction = useRef(false);
  const ownStatus = useRef('');
  const before = useRef({
    operator: [] as string[],
    lead: [] as string[],
    titles: new Map<string, string>(),
    ids: new Map<string, string>(),
  });
  const drafts = useDrafts();
  const draftsNow = useRef(drafts);
  draftsNow.current = drafts;
  // Пустые черновики исчезнувших появлений не копятся. Сверка — с тем
  // списком, что показан (ответ фильтра компонента может опережать общий
  // опрос); пока ответа фильтра нет, сверять не с чем.
  const shownLoaded = !!attention.view && (!component || filtered?.component === component);
  useEffect(() => {
    if (!shownLoaded) return;
    for (const key of emptyGoneDrafts(drafts, source)) removeDraft(key);
  }, [drafts, source, shownLoaded]);
  const list = useRef<HTMLDivElement>(null);
  const operatorHeading = useRef<HTMLHeadingElement>(null);
  const leadHeading = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const prev = before.current;
    const now = {
      operator: groups.operator.map((i) => i.sourceKey),
      lead: groups.lead.map((i) => i.sourceKey),
      titles: new Map(items.map((i) => [i.sourceKey, i.title])),
      ids: new Map(items.map((i) => [i.sourceKey, i.id])),
    };
    before.current = now;
    const key = focused.current;
    if (!key || !prev.titles.has(key)) return;
    // Новое появление того же предмета под формой с текстом: форма прежнего
    // появления исчезла из карточки, текст — в «Неотправленные ответы».
    const wasId = prev.ids.get(key);
    const nowId = now.ids.get(key);
    const active = document.activeElement;
    const lostFocus = !active || active === document.body;
    if (wasId && nowId && wasId !== nowId && hasText(draftsNow.current.get(wasId))) {
      if (!lostFocus && !document.getElementById(cardDomId(key))?.contains(active)) return;
      announced.current.add(nowId);
      setMessage(
        `Появилась новая редакция «${now.titles.get(key)}»: ваш текст к прежней не отправлен и сохранён в «Неотправленные ответы».`,
      );
      requestAnimationFrame(() => document.getElementById(unsentDomId(wasId))?.focus());
      return;
    }
    if (now.titles.has(key)) {
      // Карточка перешла в другую группу (ответ сохранён — дальше ведущий):
      // элемент перемонтирован, фокус возвращается к нему же. Новое
      // появление под пустой формой закрыло её: фокус — на карточку
      // нового появления, а не на body.
      const moved = prev.operator.includes(key) !== now.operator.includes(key);
      const replaced = !!wasId && !!nowId && wasId !== nowId;
      if ((!moved && !replaced) || !lostFocus) return;
      if (now.lead.includes(key)) setLeadOpen(true);
      requestAnimationFrame(() => document.getElementById(cardDomId(key))?.focus());
      return;
    }
    // Опрос не уводит фокус: только если он был в исчезнувшей карточке
    // (элемент удалён, фокус на body) или карточку решило своё действие.
    const own = ownAction.current;
    if (!own && !lostFocus) return;
    ownAction.current = false;
    // Под исчезнувшей карточкой была форма с текстом: фокус — на
    // неотправленном тексте, а не на следующей карточке.
    const goneId = prev.ids.get(key);
    if (goneId && hasText(draftsNow.current.get(goneId))) {
      focused.current = '';
      setMessage(
        own
          ? ownStatus.current
          : `Карточка «${prev.titles.get(key)}» решена или снята без вашего ответа. Ваш текст не отправлен и сохранён в «Неотправленные ответы».`,
      );
      requestAnimationFrame(() => document.getElementById(unsentDomId(goneId))?.focus());
      return;
    }
    const group = prev.operator.includes(key) ? 'operator' : 'lead';
    const target = nextFocusKey(prev[group], now[group], key);
    const nextTitle = target ? now.titles.get(target) : undefined;
    setMessage(
      (own ? ownStatus.current : `Карточка «${prev.titles.get(key)}» решена.`) +
        (nextTitle ? ` Следующая: «${nextTitle}»` : ''),
    );
    focused.current = target ?? '';
    requestAnimationFrame(() => {
      const element = target ? document.getElementById(cardDomId(target)) : null;
      const heading = group === 'lead' ? leadHeading.current : operatorHeading.current;
      (element ?? heading ?? operatorHeading.current)?.focus();
    });
  }, [groups, items]);

  // «Назад» с предмета возвращает фокус на карточку, с которой ушли.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !attention.view) return;
    restored.current = true;
    const key = rememberedAttentionKey();
    if (!key) return;
    // Ключ относится к одному возвращению: запись истории его забывает.
    forgetAttentionKey();
    const active = document.activeElement;
    if (active && active !== document.body) return;
    // Карточка ведущего в свёрнутой группе: сначала раскрыть группу.
    if (attention.items.some((i) => i.sourceKey === key && i.actor === 'lead')) setLeadOpen(true);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => document.getElementById(cardDomId(key))?.focus()),
    );
  }, [attention.view, attention.items]);

  const onOutcome = useCallback((item: AttentionItem, outcome: ActOutcome) => {
    setMessage(outcome.status);
    if (outcome.kind === 'resolved') {
      ownStatus.current = outcome.status;
      focused.current = item.sourceKey;
      ownAction.current = true;
      setGone((g) => new Set(g).add(item.id));
    }
  }, []);

  if (attention.loading)
    return (
      <p role="status" aria-busy="true">
        Загружаем действия…
      </p>
    );
  if (attention.error || !attention.view)
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription className="grid gap-2">
          <span>Не удалось загрузить действия: {humanError(attention.error)}</span>
          <Button
            variant="outline"
            className="justify-self-start"
            onClick={() => void attention.refresh()}
          >
            Повторить
          </Button>
        </AlertDescription>
      </Alert>
    );
  const view = attention.view;
  const leadAbsent = groups.lead.length > 0 && !view.lead.present;
  // Команда — только серверная: своей подстановки у панели нет.
  const handoffCommand = groups.lead
    .flatMap((i) => i.actions)
    .find((a): a is Handoff => a.kind === 'handoff')?.command;
  const filtering = !!category || !!component;
  const pending = !!component && filtered?.component !== component && !filterError;
  // Карточка, скрытая своим действием, уже не держит свой черновик.
  const orphans = orphanDrafts(
    drafts,
    attention.items.filter((i) => !gone.has(i.id)),
  );
  const unreadShown = groups.operator.filter((i) => i.state.unread);
  const card = (i: AttentionItem) => (
    <li key={i.sourceKey} className="min-w-0">
      <AttentionCard item={i} staleId={staleId} onOutcome={onOutcome} />
    </li>
  );
  const headingClass = 'm-0 text-base font-semibold outline-offset-2';
  const operatorGroup = (
    <section aria-labelledby={`${baseId}-operator`} className="grid min-w-0 gap-2">
      {groups.operator.length ? (
        <>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2
              id={`${baseId}-operator`}
              ref={operatorHeading}
              tabIndex={-1}
              className={headingClass}
            >
              Нужно ваше действие ({groups.operator.length})
            </h2>
            {unreadShown.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                disabled={attention.stale}
                className="ml-auto"
                onClick={() => {
                  // Кнопка исчезает вместе с непрочитанными: фокус — на заголовке группы.
                  requestAnimationFrame(() => operatorHeading.current?.focus());
                  void attention.mark(unreadShown, 'read').then((ok) => {
                    if (!ok)
                      setMessage('Отметки не сохранены: сервер не ответил. Повторите позже.');
                  });
                }}
              >
                Отметить всё прочитанным
              </Button>
            )}
          </div>
          <p className="text-muted-foreground m-0 text-xs">
            Прочитано и «увидел» только отмечают карточку: вопрос остаётся, пока его не решат.
          </p>
          <ul className="m-0 grid list-none gap-3 p-0">{groups.operator.map(card)}</ul>
        </>
      ) : (
        <>
          <h2
            id={`${baseId}-operator`}
            ref={operatorHeading}
            tabIndex={-1}
            className={headingClass}
          >
            {pending
              ? 'Загружаем карточки компонента…'
              : filtering
                ? 'Нет карточек по выбранным фильтрам.'
                : 'Сейчас от вас ничего не требуется.'}
          </h2>
          {filtering && !pending && (
            <Button
              variant="outline"
              size="sm"
              className="justify-self-start"
              onClick={() => {
                setCategory('');
                setComponent('');
              }}
            >
              Сбросить фильтры
            </Button>
          )}
          {!filtering && groups.lead.length > 0 && who === '' && (
            <p className="m-0">
              <a
                className="text-info underline-offset-4 hover:underline"
                href="?who=lead"
                onClick={(e) => {
                  e.preventDefault();
                  chooseWho('lead');
                }}
              >
                Ведущий агент разбирает: {groups.lead.length}
              </a>
            </p>
          )}
        </>
      )}
    </section>
  );
  const leadBody = (
    <div className="grid min-w-0 gap-2">
      {leadAbsent && (
        <Alert variant="warning" className="grid gap-2">
          <AlertDescription>
            Нужен ведущий агент: ему есть что разобрать. Запустите сессию ведущего с командой
            передачи.
          </AlertDescription>
          {handoffCommand && <HandoffCommand command={handoffCommand} />}
        </Alert>
      )}
      {groups.lead.length ? (
        <ul className="m-0 grid list-none gap-3 p-0">{groups.lead.map(card)}</ul>
      ) : (
        <p className="m-0">Ведущему агенту сейчас нечего разбирать.</p>
      )}
    </div>
  );
  const leadTitle = `Разбирает ведущий агент (${groups.lead.length})`;
  const leadGroup =
    who === 'lead' ? (
      <section aria-labelledby={`${baseId}-lead`} className="grid min-w-0 gap-2">
        <h2
          id={`${baseId}-lead`}
          ref={leadHeading as RefObject<HTMLHeadingElement>}
          tabIndex={-1}
          className={headingClass}
        >
          {leadTitle}
        </h2>
        {leadBody}
      </section>
    ) : groups.lead.length ? (
      <details
        open={leadOpen ?? (groups.operator.length === 0 || leadAbsent)}
        onToggle={(e) => setLeadOpen(e.currentTarget.open)}
        className="min-w-0"
      >
        <summary ref={leadHeading} className="cursor-pointer">
          <h2 className="m-0 inline text-base font-semibold">{leadTitle}</h2>
        </summary>
        <div className="mt-2">{leadBody}</div>
      </details>
    ) : null;

  return (
    <section
      aria-label="Центр внимания"
      className="grid min-w-0 gap-4 text-sm [overflow-wrap:anywhere]"
    >
      <p role="status" aria-live="polite" className="m-0 text-sm">
        {message}
      </p>
      {filterError && (
        <p role="alert" className="text-destructive m-0 text-sm">
          Не удалось загрузить карточки компонента: {filterError}.
        </p>
      )}
      {attention.stale && (
        <p id={staleId} role="alert" className="text-destructive m-0 text-sm">
          {staleLine(attention.lastOkAt, attention.failure)}
        </p>
      )}
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <div className="grid gap-1 max-[760px]:w-full">
          <Label htmlFor={`${baseId}-who`}>Кто действует</Label>
          <select
            id={`${baseId}-who`}
            className={selectClass}
            value={who}
            onChange={(e) => chooseWho(e.target.value as Who)}
          >
            <option value="">Все</option>
            <option value="operator">Вы</option>
            <option value="lead">Ведущий агент</option>
          </select>
        </div>
        <div className="grid gap-1 max-[760px]:w-full">
          <Label htmlFor={`${baseId}-category`}>Тип</Label>
          <select
            id={`${baseId}-category`}
            className={selectClass}
            value={category}
            onChange={(e) => setCategory(e.target.value as '' | AttentionCategory)}
          >
            {categories.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        {components.length > 1 && (
          <div className="grid gap-1 max-[760px]:w-full">
            <Label htmlFor={`${baseId}-component`}>Компонент</Label>
            <select
              id={`${baseId}-component`}
              className={selectClass}
              value={component}
              onChange={(e) => setComponent(e.target.value)}
            >
              <option value="">Все</option>
              {components.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <Tabs value={sub} onValueChange={(v) => chooseSub(v as Sub)} className="min-w-0">
        <TabsList aria-label="Вид центра внимания" className="max-[760px]:w-full">
          <TabsTrigger value="active" className="max-[760px]:flex-1">
            Нужно действие
          </TabsTrigger>
          <TabsTrigger value="history" className="max-[760px]:flex-1">
            История
          </TabsTrigger>
        </TabsList>
        <TabsContent value="active" className="grid min-w-0 gap-4">
          {orphans.length > 0 && (
            <section aria-label="Неотправленные ответы" className="grid min-w-0 gap-2">
              {orphans.map(([id, d]) => (
                <UnsentText
                  key={id}
                  id={unsentDomId(id)}
                  text={d.text}
                  why={unsentWhy(
                    d,
                    `Карточка «${d.pin?.title ?? 'без названия'}» решена или снята без вашего ответа. Текст не отправлен.`,
                  )}
                  onDrop={() => removeDraft(id)}
                />
              ))}
            </section>
          )}
          <div
            ref={list}
            className="grid min-w-0 gap-6"
            onFocus={(e) => {
              const key = (e.target as HTMLElement)
                .closest('[data-attention-key]')
                ?.getAttribute('data-attention-key');
              if (key) focused.current = key;
            }}
            onBlur={(e) => {
              // Фокус ушёл из списка (щелчок по пустому месту, фильтр): опрос
              // потом не должен переводить его. Удалённый элемент — не уход.
              const left = e.target;
              const to = e.relatedTarget as Node | null;
              if (to && list.current?.contains(to)) return;
              requestAnimationFrame(() => {
                if (left.isConnected && !list.current?.contains(document.activeElement))
                  focused.current = '';
              });
            }}
          >
            {who !== 'lead' && operatorGroup}
            {who !== 'operator' && leadGroup}
          </div>
          {view.truncated && !component && (
            <p className="text-muted-foreground m-0 text-xs">
              Показаны первые {view.items.length} из {view.items.length + view.truncated.count}.
              Остальные появятся по мере решения.
            </p>
          )}
        </TabsContent>
        <TabsContent value="history" className="min-w-0">
          <AttentionHistory
            revision={view.revision}
            actor={who || undefined}
            category={category || undefined}
          />
        </TabsContent>
      </Tabs>
    </section>
  );
}
