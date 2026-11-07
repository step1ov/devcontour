import { useCallback, useEffect, useId, useState } from 'react';
import { Alert, AlertDescription } from '@/ui/alert.tsx';
import { Badge } from '@/ui/badge.tsx';
import { Button } from '@/ui/button.tsx';
import { humanError } from '@/lib/utils.ts';
import type { AttentionHistoryView } from '../application/attention.ts';
import type { AttentionHistoryItem } from '../core/attention-model.ts';
import { getHistory } from './attention-api.ts';
import { actorLabel, categoryLabel } from './attention-logic.ts';
import { OpenLink } from './AttentionCard.tsx';

// История центра внимания: решённые появления по записанным фактам решения,
// новые первыми. Не опрашивается сама: читается при открытии вкладки и при
// каждой новой ревизии данных общего опроса. Карточки истории не отмечаются.

const markState = (s: AttentionHistoryItem['state']) =>
  s.acknowledged ? 'вы видели' : s.read ? 'вы прочитали' : 'не открывали';

function HistoryRow({ item }: { item: AttentionHistoryItem }) {
  const titleId = useId();
  const label = categoryLabel(item);
  return (
    <article
      aria-labelledby={titleId}
      data-attention-history={item.sourceKey}
      className="grid min-w-0 gap-2 rounded-md border p-3 text-sm [overflow-wrap:anywhere]"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge variant={label.variant}>{label.text}</Badge>
        <h3 id={titleId} className="m-0 min-w-0 text-sm font-semibold">
          {item.title}
        </h3>
      </div>
      <p className="m-0 whitespace-pre-wrap">{item.reason}</p>
      <p className="text-muted-foreground m-0">
        {item.resolvedAt
          ? `Решено ${new Date(item.resolvedAt).toLocaleString('ru-RU')}`
          : 'Время решения не записано'}
        {' · '}
        Кто действовал: {actorLabel(item.actor)}
        {item.actor === 'operator' ? ` · ${markState(item.state)}` : ''}
      </p>
      <div className="flex flex-wrap gap-2">
        <OpenLink item={item} />
      </div>
    </article>
  );
}

export function AttentionHistory({
  revision,
  actor,
  category,
}: {
  /** Ревизия данных общего опроса: новая — перечитать историю. */
  revision?: number;
  actor?: string;
  category?: string;
}) {
  const [view, setView] = useState<AttentionHistoryView>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    getHistory({ actor, category }, abort.signal)
      .then((r) => {
        if (r.ok && r.body) {
          setView(r.body);
          setError('');
        } else
          setError(
            r.status === 0 ? 'сервер не отвечает' : (r.body?.error ?? `сервер ответил ${r.status}`),
          );
      })
      .catch(() => undefined);
    return () => abort.abort();
  }, [revision, actor, category, attempt]);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  if (error && !view)
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription className="grid gap-2">
          <span>Не удалось загрузить историю: {humanError(error)}</span>
          <Button variant="outline" className="justify-self-start" onClick={retry}>
            Повторить
          </Button>
        </AlertDescription>
      </Alert>
    );
  if (!view)
    return (
      <p role="status" aria-busy="true">
        Загружаем историю…
      </p>
    );
  return (
    <div className="grid min-w-0 gap-3">
      {error && (
        <p role="alert" className="text-destructive m-0 text-sm">
          История не обновилась: {humanError(error)}
        </p>
      )}
      {view.items.length ? (
        <ul aria-label="История центра внимания" className="m-0 grid list-none gap-3 p-0">
          {view.items.map((i) => (
            <li key={i.id} className="min-w-0">
              <HistoryRow item={i} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0">Решённых карточек пока нет.</p>
      )}
      <p className="text-muted-foreground m-0 text-xs">
        В истории — то, у чего записан факт решения: ответы, решения по редакциям, принятые
        изменения, завершённые попытки. Паузы, ожидания, бюджеты и preview сюда не попадают.
        {view.truncated ? ' Показаны последние 100.' : ''}
      </p>
    </div>
  );
}
