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
import { AttentionCard, HandoffCommand, type ActOutcome } from './AttentionCard.tsx';
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
const DEFAULT_HANDOFF = 'devcontour handoff --workspace <путь workspace>';
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

export const staleLine = (at?: string) =>
  `Нет связи с сервером: данные на ${at ? new Date(at).toLocaleTimeString('ru-RU') : '—'} могут быть устаревшими. Действия станут доступны после обновления.`;

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
  const [filtered, setFiltered] = useState<AttentionView>();
  useEffect(() => {
    if (!component) {
      setFiltered(undefined);
      return;
    }
    const abort = new AbortController();
    getAttention({ component }, abort.signal)
      .then((r) => {
        if (r.ok && r.body) setFiltered(r.body);
      })
      .catch(() => undefined);
    return () => abort.abort();
  }, [component, attention.view]);

  useEffect(() => {
    if (arrived.seq) setMessage(`Новая карточка: ${arrived.titles.join('; ')}`);
  }, [arrived]);

  const source = useMemo(
    () => (component ? (filtered?.items ?? []) : attention.items),
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
  });
  const operatorHeading = useRef<HTMLHeadingElement>(null);
  const leadHeading = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const prev = before.current;
    const now = {
      operator: groups.operator.map((i) => i.sourceKey),
      lead: groups.lead.map((i) => i.sourceKey),
      titles: new Map(items.map((i) => [i.sourceKey, i.title])),
    };
    before.current = now;
    const key = focused.current;
    if (!key || !prev.titles.has(key)) return;
    if (now.titles.has(key)) {
      // Карточка перешла в другую группу (ответ сохранён — дальше ведущий):
      // элемент перемонтирован, фокус возвращается к нему же.
      const moved = prev.operator.includes(key) !== now.operator.includes(key);
      if (!moved || (document.activeElement && document.activeElement !== document.body)) return;
      if (now.lead.includes(key)) setLeadOpen(true);
      requestAnimationFrame(() => document.getElementById(cardDomId(key))?.focus());
      return;
    }
    // Опрос не уводит фокус: только если он был в исчезнувшей карточке
    // (элемент удалён, фокус на body) или карточку решило своё действие.
    const active = document.activeElement;
    const own = ownAction.current;
    if (!own && active && active !== document.body) return;
    ownAction.current = false;
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
    requestAnimationFrame(() => document.getElementById(cardDomId(key))?.focus());
  }, [attention.view]);

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
  const handoffCommand =
    groups.lead.flatMap((i) => i.actions).find((a): a is Handoff => a.kind === 'handoff')
      ?.command ?? DEFAULT_HANDOFF;
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
                onClick={() => void attention.mark(unreadShown, 'read')}
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
            Сейчас от вас ничего не требуется.
          </h2>
          {groups.lead.length > 0 && who === '' && (
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
          <HandoffCommand command={handoffCommand} />
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
      {attention.stale && (
        <p id={staleId} role="alert" className="text-destructive m-0 text-sm">
          {staleLine(attention.lastOkAt)}
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
          <div
            className="grid min-w-0 gap-6"
            onFocus={(e) => {
              const key = (e.target as HTMLElement)
                .closest('[data-attention-key]')
                ?.getAttribute('data-attention-key');
              if (key) focused.current = key;
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
