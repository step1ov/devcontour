import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/ui/badge.tsx';
import { Button } from '@/ui/button.tsx';
import type { taskChecks } from '../application/checks.ts';

type Checks = ReturnType<typeof taskChecks>;
type Page = Checks['cases']['page'];

const actors: Record<string, string> = {
  controller: 'Контур',
  lead: 'Ведущий',
  user: 'Пользователь',
};
const recoveryNames: Record<string, string> = {
  'awaiting-lead': 'ждёт разбора ведущего',
  analyzing: 'разбор ведущего',
  applying: 'подтверждение случаев',
  retry: 'разрешён один повтор',
  retrying: 'идёт разрешённый повтор',
  'awaiting-user': 'нужно решение пользователя',
  stopped: 'автоматических действий нет',
  closed: 'эпизод завершён',
};
const actions: Record<string, string> = {
  'add-cases': 'добавить подтверждённые случаи',
  'new-approach': 'новый подход',
  'strengthen-checker': 'усилить проверку',
  'split-task': 'разделить задачу',
  'clarify-obligation': 'уточнить обязательство',
  environment: 'причина в среде',
};
const outcomes: Record<string, string> = {
  confirmed: 'подтверждён',
  refuted: 'опровергнут',
  inconclusive: 'не определён',
  rejected: 'отклонён',
};
const short = (digest?: string | null) => (digest ? digest.slice(0, 12) : '—');

/**
 * Договор проверки в карточке задачи: какая версия проверок действует, что
 * проверено и сколько, какие случаи стали обязательными и почему, как шли
 * отказы по свойствам, что решил разбор и кто должен действовать сейчас.
 * Подробности читаются по запросу и страницами — большой корпус не тормозит
 * опрашиваемое состояние панели.
 */
export function CheckPanel({ taskId, revision }: { taskId: string; revision: string }) {
  const [data, setData] = useState<Checks>();
  const [cases, setCases] = useState<Page['items']>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(
    async (cursor = 0, signal?: AbortSignal) => {
      setLoading(true);
      try {
        const response = await fetch(`/api/tasks/${taskId}/checks?limit=10&cursor=${cursor}`, {
          signal,
        });
        const body = (await response.json()) as Checks & { error?: string };
        if (!response.ok) throw new Error(body.error ?? 'Ошибка запроса');
        setData(body);
        setCases((prev) => (cursor ? [...prev, ...body.cases.page.items] : body.cases.page.items));
        setNext(body.cases.page.nextCursor);
        setError('');
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError((e as Error).message);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [taskId],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(0, controller.signal);
    return () => controller.abort();
  }, [load, revision]);

  if (!data && loading)
    return (
      <section aria-label="Договор проверки" className="my-4" aria-busy="true">
        <h3>Договор проверки</h3>
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Загрузка…
        </p>
      </section>
    );
  if (!data)
    return (
      <section aria-label="Договор проверки" className="my-4">
        <h3>Договор проверки</h3>
        <p role="alert" className="text-destructive text-sm break-words">
          Не удалось загрузить: {error}
        </p>
        <Button size="sm" variant="outline" onClick={() => void load()}>
          Повторить
        </Button>
      </section>
    );
  const latest =
    data.coverage.filter((c) => c.phase === 'candidate').at(-1) ?? data.coverage.at(-1);
  return (
    <section aria-label="Договор проверки" className="my-4 grid gap-3 text-sm break-words">
      <h3 className="m-0">Договор проверки</h3>
      {error && (
        <p role="alert" className="text-destructive m-0">
          Обновление не удалось: {error}
        </p>
      )}
      <div className="bg-secondary grid gap-1 rounded-md p-3" data-testid="check-next">
        <p className="m-0">
          <strong>Сейчас действует:</strong> {data.next.actor ? actors[data.next.actor] : '—'}
        </p>
        <p className="m-0">{data.next.step}</p>
      </div>
      <dl className="m-0 grid gap-1">
        <div>
          <dt>Уровень доказательства</dt>
          <dd>
            <Badge variant={data.level === 'manifest' ? 'success' : 'secondary'}>
              {data.level === 'manifest' ? 'манифест свойств' : 'прежний (без манифеста)'}
            </Badge>
          </dd>
        </div>
        <div>
          <dt>Версия проверок</dt>
          <dd>
            <code>{short(data.versions.effective)}</code>
            {data.versions.corpus && (
              <>
                {' '}
                · корпус {data.versions.suite} v{data.versions.corpus.number} (
                <code>{short(data.versions.corpus.digest)}</code>)
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Бюджет</dt>
          <dd>
            попытки {data.budget.attemptsUsed} из {data.budget.attemptsMax}; восстановления доски{' '}
            {data.budget.repairsUsed} из {data.budget.repairBudget}
          </dd>
        </div>
      </dl>
      {!!data.properties.length && (
        <div
          className="overflow-x-auto"
          tabIndex={0}
          role="group"
          aria-label="Свойства и фактическое покрытие"
        >
          <table className="w-full text-left text-xs [&_td]:px-1 [&_td]:py-0.5 [&_td]:align-top [&_th]:px-1">
            <caption className="text-muted-foreground text-left">
              Свойства и фактическое покрытие
              {latest ? ` (${latest.phase}, seed ${latest.seed})` : ''}
            </caption>
            <thead>
              <tr>
                <th scope="col">Свойство</th>
                <th scope="col">Обещание</th>
                <th scope="col">Проверено</th>
                <th scope="col">Итог</th>
              </tr>
            </thead>
            <tbody>
              {data.properties.map((p) => {
                const seen = latest?.properties.find((x) => x.id === p.id);
                return (
                  <tr key={p.id}>
                    <td>
                      <code>{p.id}</code>
                    </td>
                    <td>{p.promise ?? '—'}</td>
                    <td>
                      {seen ? `${seen.cases} из ${p.minCases ?? '?'}` : '—'}
                      {seen?.families &&
                        ' · ' +
                          Object.entries(seen.families)
                            .map(([f, n]) => `${f}: ${n}`)
                            .join(', ')}
                    </td>
                    <td>
                      {seen ? (
                        <Badge variant={seen.status === 'passed' ? 'success' : 'destructive'}>
                          {seen.status === 'passed'
                            ? 'выполнено'
                            : seen.status === 'running'
                              ? 'оборвалось'
                              : 'нарушено'}
                        </Badge>
                      ) : (
                        'не проверялось'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!!latest?.problems.length && (
            <ul className="text-destructive m-0 mt-1 pl-4">
              {latest.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {latest?.corpus && (
            <p className="text-muted-foreground m-0 mt-1">
              Корпус на гейте: выполнено {latest.corpus.executed}, пройдено {latest.corpus.passed}
            </p>
          )}
        </div>
      )}
      <div>
        <p className="m-0">
          Случаи: подтверждено <strong>{data.cases.confirmed}</strong>, предложено ревью{' '}
          <strong>{data.cases.proposed}</strong>, спорных <strong>{data.cases.disputed}</strong>
        </p>
        {!!cases.length && (
          <ol className="m-0 mt-1 grid gap-1 pl-4" aria-label="Обязательные случаи корпуса">
            {cases.map((c) => (
              <li key={c.id}>
                <code>{c.property}</code>: <code className="break-all">{c.input}</code> → ожидается{' '}
                <code className="break-all">{c.expected}</code>{' '}
                <span className="text-muted-foreground">(эталон на {short(c.sha)})</span>
              </li>
            ))}
          </ol>
        )}
        {next !== null && (
          <Button
            size="sm"
            variant="outline"
            className="mt-1"
            disabled={loading}
            onClick={() => void load(next)}
          >
            Показать ещё
          </Button>
        )}
        {!!data.cases.decisions.length && (
          <details className="mt-1">
            <summary className="cursor-pointer">
              Решения проверки примеров ({data.cases.decisions.length})
            </summary>
            <ul className="m-0 mt-1 grid gap-1 pl-4">
              {data.cases.decisions.map((d) => (
                <li key={d.id}>
                  <Badge
                    variant={
                      d.outcome === 'confirmed'
                        ? 'success'
                        : d.outcome === 'refuted'
                          ? 'destructive'
                          : 'secondary'
                    }
                  >
                    {outcomes[d.outcome]}
                  </Badge>{' '}
                  <code>{d.property}</code> — {d.reason}{' '}
                  <span className="text-muted-foreground">
                    (источник: {d.origin.kind}
                    {d.origin.runtime ? `, ${d.origin.runtime}` : ''})
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      {!!Object.keys(data.history.byProperty).length && (
        <div>
          <p className="m-0">История отказов по свойствам</p>
          <ul className="m-0 grid gap-1 pl-4">
            {Object.entries(data.history.byProperty).map(([property, runs]) => (
              <li key={property}>
                <code>{property}</code>: {runs.length} отказ(а) —{' '}
                {runs.map((r) => `попытка ${r.attempt} (${r.kind ?? '?'})`).join(', ')}
              </li>
            ))}
          </ul>
          {!!data.history.unbound.length && (
            <p className="text-muted-foreground m-0">
              Названы ревьюером, но не объявлены: {data.history.unbound.join(', ')} — только для
              разбора.
            </p>
          )}
        </div>
      )}
      {data.recovery && (
        <div className="bg-secondary rounded-md p-3" data-testid="check-recovery">
          <p className="m-0">
            <strong>Разбор по свойству {data.recovery.property}:</strong>{' '}
            {recoveryNames[data.recovery.status] ?? data.recovery.status}
          </p>
          {data.recovery.decision && (
            <p className="m-0">
              Решение: {actions[data.recovery.decision.action]} — {data.recovery.decision.reason}{' '}
              (источник: {data.recovery.decision.source.kind === 'lead' ? 'ведущий' : 'вручную'}
              {data.recovery.decision.source.runtime
                ? `, ${data.recovery.decision.source.runtime}`
                : ''}
              )
            </p>
          )}
          {data.recovery.decision?.hypothesis && (
            <p className="m-0">Гипотеза: {data.recovery.decision.hypothesis}</p>
          )}
          {data.recovery.reason && <p className="m-0">{data.recovery.reason}</p>}
        </div>
      )}
      {!data.recovery && !!data.recoveries.length && (
        <p className="text-muted-foreground m-0">
          Прежние разборы:{' '}
          {data.recoveries
            .map(
              (r) =>
                `${r.property} — ${r.action ? actions[r.action] : '—'} (${recoveryNames[r.status] ?? r.status})`,
            )
            .join('; ')}
        </p>
      )}
    </section>
  );
}
