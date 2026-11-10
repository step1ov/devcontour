import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, RotateCcw } from 'lucide-react';
import type { AuthorOverview } from '../application/overview.ts';
import { Alert, AlertDescription } from '@/ui/alert.tsx';
import { Badge } from '@/ui/badge.tsx';
import { Button } from '@/ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card.tsx';
import { humanError } from '@/lib/utils.ts';
import { headlineOf, type AttentionItem } from './attention-logic.ts';
import { AttentionCard, type ActOutcome } from './AttentionCard.tsx';
import { useAttention } from './AttentionProvider.tsx';
import { staleLine } from './AttentionCenter.tsx';
import { navigate } from './navigation.ts';
import { orphanDrafts, useDrafts } from './attention-drafts.ts';

// Главный экран автора продукта: что можно попробовать, какое решение нужно,
// что изменилось, сколько потрачено и что делает система. Внутренние
// сущности контроллера — только в раскрываемых подробностях. Решения —
// голова очереди центра внимания: тот же ответ, что у значка и экрана.

const changeStatus = {
  accepted: 'Принято',
  verified: 'Проверено, ждёт приёмки',
  'in-progress': 'В работе',
  planned: 'План не утверждён',
} as const;

async function post(path: string, input: unknown = {}) {
  const response = await fetch('/api/' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DevContour-Request': '1' },
    body: JSON.stringify(input),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Ошибка запроса');
  return data;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle id={id}>{title}</CardTitle>
        </CardHeader>
        <CardContent className="grid min-w-0 gap-3 text-sm [overflow-wrap:anywhere]">
          {children}
        </CardContent>
      </Card>
    </section>
  );
}

// Кнопка действия не шире своей колонки: длинная подпись переносится, а не
// растягивает карточку за край экрана.
const action = 'h-auto max-w-full justify-start whitespace-normal text-left';
const when = (at?: string) => (at ? new Date(at).toLocaleString('ru-RU') : 'неизвестно');

/** Сколько карточек оператора показывает обзор; остальные — на экране внимания. */
const HEAD = 5;

/**
 * «Нужно ваше решение»: первые карточки оператора из общего опроса центра.
 * Карточки ведущего агента не выдаются за решения автора — только их число
 * со ссылкой на экран внимания.
 */
function DecisionHead({
  attentionHref,
  onStatus,
}: {
  attentionHref: (who?: 'lead') => string;
  onStatus: (text: string) => void;
}) {
  const attention = useAttention();
  const drafts = useDrafts();
  if (attention.loading)
    return (
      <p className="m-0" role="status" aria-busy="true">
        Загружаем действия…
      </p>
    );
  if (attention.error)
    return (
      <p className="text-destructive m-0" role="alert">
        Не удалось загрузить действия: {humanError(attention.error)}
      </p>
    );
  const operator = attention.items.filter((i) => i.actor === 'operator');
  const lead = attention.items.filter((i) => i.actor === 'lead');
  const all = attention.view?.counts.byActor.operator.active ?? operator.length;
  const link = (who: 'lead' | undefined, text: string) => (
    <a
      className="text-info underline-offset-4 hover:underline"
      href={attentionHref(who)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(attentionHref(who));
      }}
    >
      {text}
    </a>
  );
  const outcome = (_: AttentionItem, o: ActOutcome) => onStatus(o.status);
  // Текст формы, чья карточка исчезла или сменилась, — на экране внимания.
  const unsent = orphanDrafts(drafts, attention.items).length;
  return (
    <>
      {attention.stale && (
        <p className="text-destructive m-0" role="alert">
          {staleLine(attention.lastOkAt, attention.failure)}
        </p>
      )}
      {operator.length ? (
        <ul className="m-0 grid list-none gap-3 p-0" aria-label="Решения для вас">
          {operator.slice(0, HEAD).map((i) => (
            <li key={i.sourceKey} className="min-w-0">
              <AttentionCard item={i} compact onOutcome={outcome} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0">Сейчас от вас ничего не требуется.</p>
      )}
      {unsent > 0 && (
        <p className="text-warning m-0" role="status">
          Есть неотправленный текст ответа: {link(undefined, 'открыть в центре внимания')}.
        </p>
      )}
      <p className="m-0 flex flex-wrap gap-x-4 gap-y-1">
        {link(undefined, `Все действия (${all})`)}
        {lead.length > 0 &&
          link('lead', `Ведущий агент разбирает технических вопросов: ${lead.length}`)}
      </p>
    </>
  );
}

export function AuthorOverviewPanel({
  attentionHref,
}: {
  /** Адрес экрана внимания этой оболочки (с фильтром «кто действует»). */
  attentionHref: (who?: 'lead') => string;
}) {
  const attention = useAttention();
  const [overview, setOverview] = useState<AuthorOverview>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  // После действия карточка решения исчезает; фокус переходит к сообщению
  // об итоге, а не теряется на body.
  const status = useRef<HTMLParagraphElement>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch('/api/overview', { signal });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? 'Не удалось прочитать сводку');
      setOverview(value);
      setError('');
    } catch (e) {
      if (!signal?.aborted) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = setInterval(() => void load(controller.signal), 2000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [load]);
  const act = async (label: string, run: () => Promise<unknown>) => {
    setBusy(true);
    setNotice('');
    try {
      await run();
      setNotice(label);
      await load();
    } catch (e) {
      setNotice('Не выполнено: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
      status.current?.focus();
    }
  };
  if (error && !overview)
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription className="grid gap-2">
          <span>{error}</span>
          <Button variant="outline" className="justify-self-start" onClick={() => void load()}>
            Повторить
          </Button>
        </AlertDescription>
      </Alert>
    );
  if (!overview)
    return (
      <p aria-busy="true" role="status">
        Загрузка сводки…
      </p>
    );
  const o = overview;
  const headline = headlineOf(o, attention.items);
  return (
    <div
      className="grid min-w-0 gap-4 [overflow-wrap:anywhere]"
      aria-label="Обзор для автора продукта"
    >
      <header className="grid gap-1">
        <h2 className="m-0 text-lg font-semibold">{headline}</h2>
        {/* Подпись не повторяет заголовок слово в слово. */}
        {o.activity.doing.replace(/[.!…]+$/, '') !== headline.replace(/[.!…]+$/, '') && (
          <p className="text-muted-foreground m-0 text-sm">{o.activity.doing}</p>
        )}
        {error && (
          <p className="text-destructive m-0 text-sm" role="alert">
            Сводка не обновилась: {error}
          </p>
        )}
        <p ref={status} tabIndex={-1} className="m-0 text-sm" role="status" aria-live="polite">
          {notice}
        </p>
      </header>

      <Section title="Попробовать">
        {o.tryNow ? (
          <>
            <p className="m-0">
              Работает «{o.tryNow.changeSetTitle}».{' '}
              <Badge variant={o.tryNow.scenario === 'confirmed' ? 'success' : 'warning'}>
                {o.tryNow.scenario === 'confirmed'
                  ? 'Сценарий подтверждён'
                  : 'Работает, сценарий не подтверждён'}
              </Badge>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button asChild className={action}>
                <a href={o.tryNow.url} target="_blank" rel="noreferrer">
                  <ArrowUpRight />
                  Открыть версию
                </a>
              </Button>
              {o.preview.canRollback && (
                <Button
                  variant="outline"
                  className={action}
                  disabled={busy}
                  onClick={() =>
                    void act('Возвращена прежняя версия', () => post('preview/rollback'))
                  }
                >
                  <RotateCcw />
                  Вернуть прежнюю версию
                </Button>
              )}
            </div>
            <p className="text-muted-foreground m-0 break-all">{o.tryNow.url}</p>
            <p className="text-muted-foreground m-0">
              Здоровье проверено {when(o.tryNow.checkedAt)}; непрерывно не отслеживается.
            </p>
          </>
        ) : o.preview.deploying ? (
          <p className="m-0">Выкладывается «{o.preview.deploying.changeSetTitle}»…</p>
        ) : !o.preview.configured ? (
          <p className="m-0">
            Preview не настроен: попробовать результат можно будет, когда ведущий агент настроит
            локальный запуск.
          </p>
        ) : (
          <p className="m-0">Пока нечего попробовать: нет выложенной проверенной версии.</p>
        )}
        {o.preview.lost && (
          <p className="text-destructive m-0">
            Версия «{o.preview.lost.changeSetTitle}» не отвечает: {o.preview.lost.reason}
          </p>
        )}
        {o.preview.lastFailure && (
          <p className="text-destructive m-0">
            Последняя выкладка «{o.preview.lastFailure.changeSetTitle}» не удалась
            {o.preview.lastFailure.rolledBack ? ', прежняя версия возвращена' : ''}.
          </p>
        )}
      </Section>

      <Section title="Нужно ваше решение">
        <DecisionHead
          attentionHref={attentionHref}
          onStatus={(text) => {
            setNotice(text);
            status.current?.focus();
          }}
        />
      </Section>

      <Section title="Что изменилось">
        {o.changes.length ? (
          <ul className="m-0 grid gap-2 pl-4">
            {o.changes.map((c, i) => (
              <li key={i}>
                {c.title} — {changeStatus[c.status]}
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0">Изменений пока нет.</p>
        )}
      </Section>

      <Section title="Расходы">
        {/* Суммы — эквивалент по тарифам API: при подписке оператор читал их
            как реальные списания. */}
        <p className="m-0">
          Вызовов моделей за всё время workspace: {o.spend.calls}. Известная стоимость — оценка по
          тарифам API: ${o.spend.knownCostUsd.toFixed(2)} (сообщено CLI $
          {(o.spend.reportedUsd ?? 0).toFixed(2)}, рассчитано по тарифам prices $
          {(o.spend.estimatedUsd ?? 0).toFixed(2)}).
        </p>
        <p className="text-muted-foreground m-0">
          Это не списание: при подписке фактическая оплата другая. Бюджеты в budgets считают ту же
          оценку.
        </p>
        {(o.spend.abandonedCalls ?? 0) > 0 && (
          <p className="text-muted-foreground m-0">
            Прервано падением процесса: {o.spend.abandonedCalls}.
          </p>
        )}
        {/* Пределы и остатки видны и до исчерпания; сначала те, что держат работу. */}
        {o.spend.budgets?.budgets
          .toSorted((a, b) => Number(a.state === 'within') - Number(b.state === 'within'))
          .slice(0, 12)
          .map((b) => (
            <p
              key={`${b.scope.kind}:${b.scope.id ?? ''}`}
              className={b.state === 'within' ? 'm-0' : 'm-0 text-destructive'}
            >
              {(b.reason &&
                b.reason +
                  (b.scope.kind === 'workspace'
                    ? ' (бюджет workspace считает расход за всё время workspace)'
                    : '')) ||
                `Бюджет ${b.scope.kind === 'workspace' ? 'workspace (за всё время workspace)' : b.scope.id}: ` +
                  (b.remainingUsd !== null ? `осталось $${b.remainingUsd.toFixed(2)}` : '') +
                  (b.remainingUsd !== null && b.remainingMs !== null ? ', ' : '') +
                  (b.remainingMs !== null ? `осталось ${Math.round(b.remainingMs / 1000)} с` : '') +
                  (b.remainingUsd === null && b.limit.usd !== undefined
                    ? 'денежный остаток не определён'
                    : '')}
            </p>
          ))}
        {(o.spend.budgets?.budgets.length ?? 0) > 12 && (
          <p className="text-muted-foreground m-0">
            Ещё бюджетов: {o.spend.budgets!.budgets.length - 12} — полный список в метриках.
          </p>
        )}
        {o.spend.unknownCalls > 0 && (
          <p className="text-muted-foreground m-0">
            Для {o.spend.unknownCalls} вызовов стоимость неизвестна: сумма выше — нижняя граница, а
            не итог.
          </p>
        )}
      </Section>

      <details className="text-sm">
        <summary className="cursor-pointer">Подробности работы</summary>
        <p>
          Задач: {o.counts.tasks}, выполнено {o.counts.done}, со сбоем {o.counts.failed}, отменено{' '}
          {o.counts.cancelled}.
        </p>
        {!!o.activity.running.length && (
          <ul className="pl-4">
            {o.activity.running.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}
