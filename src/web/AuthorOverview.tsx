import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { ArrowUpRight, RotateCcw } from 'lucide-react';
import type { AuthorOverview, Decision, DecisionKind } from '../application/overview.ts';
import { Alert, AlertDescription } from '@/ui/alert.tsx';
import { Badge } from '@/ui/badge.tsx';
import { Button } from '@/ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card.tsx';

// Главный экран автора продукта: что можно попробовать, какое решение нужно,
// что изменилось, сколько потрачено и что делает система. Внутренние
// сущности контроллера — только в раскрываемых подробностях.

const kinds: Record<DecisionKind, string> = {
  product: 'Продуктовый выбор',
  technical: 'Техническое исправление',
  access: 'Нужен внешний доступ',
};
const kindTone: Record<DecisionKind, 'default' | 'warning' | 'destructive'> = {
  product: 'default',
  technical: 'warning',
  access: 'destructive',
};
const changeStatus = {
  accepted: 'Принято',
  verified: 'Проверено, ждёт приёмки',
  'in-progress': 'В работе',
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
      <Card>
        <CardHeader>
          <CardTitle id={id}>{title}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm break-words">{children}</CardContent>
      </Card>
    </section>
  );
}

export function AuthorOverviewPanel() {
  const [overview, setOverview] = useState<AuthorOverview>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
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
    }
  };
  const decide = (d: Decision) => {
    const a = d.action;
    if (!a) return undefined;
    if (a.type === 'accept-changeset')
      return (
        <Button
          disabled={busy}
          onClick={() =>
            void act('Изменение принято', () => post(`changesets/${a.changeSetId}/accept`))
          }
        >
          Принять изменение
        </Button>
      );
    if (a.type === 'deploy-preview')
      return (
        <Button
          disabled={busy}
          onClick={() =>
            void act('Выкладка preview начата', () => post(`changesets/${a.changeSetId}/preview`))
          }
        >
          Выложить в preview
        </Button>
      );
    return (
      <Button
        disabled={busy}
        onClick={() => void act('Выдача продолжена', () => post('scheduler', { start: true }))}
      >
        Продолжить выдачу
      </Button>
    );
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
  return (
    <div className="grid gap-4" aria-label="Обзор для автора продукта">
      <header className="grid gap-1">
        <h2 className="m-0 text-lg font-semibold">{o.headline}</h2>
        <p className="text-muted-foreground m-0 text-sm">{o.activity.doing}</p>
        {error && (
          <p className="text-destructive m-0 text-sm" role="alert">
            Сводка не обновилась: {error}
          </p>
        )}
        <p className="m-0 text-sm" role="status" aria-live="polite">
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
              <Button asChild>
                <a href={o.tryNow.url} target="_blank" rel="noreferrer">
                  <ArrowUpRight />
                  Открыть версию
                </a>
              </Button>
              {o.preview.canRollback && (
                <Button
                  variant="outline"
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
        {o.preview.lastFailure && (
          <p className="text-destructive m-0">
            Последняя выкладка «{o.preview.lastFailure.changeSetTitle}» не удалась
            {o.preview.lastFailure.rolledBack ? ', прежняя версия возвращена' : ''}.
          </p>
        )}
      </Section>

      <Section title="Нужно ваше решение">
        {o.decisions.length ? (
          <ul className="m-0 grid list-none gap-3 p-0">
            {o.decisions.map((d, i) => (
              <li key={i} className="grid gap-2 rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={kindTone[d.kind]}>{kinds[d.kind]}</Badge>
                  <strong>{d.title}</strong>
                </div>
                <p className="m-0">{d.detail}</p>
                {d.kind !== 'technical' && decide(d)}
                {!!d.refs?.length && (
                  <details>
                    <summary className="text-muted-foreground cursor-pointer">Подробности</summary>
                    <p className="m-0 font-mono text-xs break-all">{d.refs.join(', ')}</p>
                  </details>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0">Сейчас от вас ничего не требуется.</p>
        )}
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
        <p className="m-0">
          Вызовов моделей: {o.spend.calls}. Известная стоимость: ${o.spend.knownCostUsd.toFixed(2)}.
        </p>
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
