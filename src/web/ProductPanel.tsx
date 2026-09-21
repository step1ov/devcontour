import { useEffect, useState } from 'react';
import type { FeatureStatus, ProductView } from '../core/product-map.ts';
import { Button } from '@/ui/button.tsx';
import { cn } from '@/lib/utils.ts';

const panel = 'p-6 break-words';
const scroll = 'my-4 overflow-x-auto';
const table =
  'w-full min-w-(--product-table-width) border-collapse text-sm [&_caption]:py-3 [&_caption]:text-left [&_caption]:font-semibold [&_thead]:bg-secondary [&_td]:min-w-(--product-column-width) [&_th]:min-w-(--product-column-width) [&_td]:border-b [&_th]:border-b [&_td]:p-3 [&_th]:p-3 [&_td]:text-left [&_th]:text-left [&_td]:align-top [&_th]:align-top [&_p]:font-normal';
const link =
  'h-auto whitespace-normal p-1 text-left text-primary underline-offset-4 hover:underline';

const labels: Record<FeatureStatus, string> = {
  unplanned: 'Нужны задачи',
  'in-progress': 'В работе / нужна перепроверка',
  'awaiting-verification': 'Ждёт сквозной проверки',
  verified: 'Сценарии проверены',
  accepted: 'Принята в релизе',
  deferred: 'Отложено',
  'not-applicable': 'Не применяется',
};
export function ProductPanel({ onRepository }: { onRepository: (id: string) => void }) {
  const [view, setView] = useState<ProductView>();
  const [release, setRelease] = useState('');
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'features' | 'applications'>('features');
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch(
          '/api/product' + (release ? '?release=' + encodeURIComponent(release) : ''),
          { signal: controller.signal },
        );
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? 'Не удалось прочитать карту продукта');
        if (!controller.signal.aborted) {
          setView(value);
          setError('');
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setError(String(error));
          setView(undefined);
        }
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = setInterval(() => {
      void load();
    }, 10000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [release]);
  if (error)
    return (
      <div className={panel} role="alert">
        {error}
      </div>
    );
  if (!view || (view.available && release && view.releaseId !== release))
    return (
      <div className={panel} role="status">
        Читаем карту продукта…
      </div>
    );
  if (!view.available)
    return (
      <div className={panel}>
        <h2 className="text-lg font-semibold">Карта продукта ещё не подготовлена</h2>
        <p>{view.reason}</p>
        <p>
          Агент описывает приложения, общие фичи и ссылки на истории компонентов. Статусы появятся
          из задач и результатов проверок.
        </p>
      </div>
    );
  return (
    <div className={panel}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{view.title}</h2>
          <p className="text-muted-foreground">{view.purpose}</p>
        </div>
        <label className="grid gap-1 text-sm font-medium">
          Релиз
          <select
            className="border-input bg-card h-10 rounded-md border px-3 text-sm"
            aria-label="Продуктовый релиз"
            value={release || view.releaseId}
            onChange={(event) => setRelease(event.target.value)}
          >
            {view.releases.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p role="status">
        {view.releaseAccepted
          ? 'Релиз принят на проверенной совместной версии.'
          : view.verification
            ? 'Совместные проверки пройдены. Релиз ожидает приёмки.'
            : view.coverageComplete
              ? 'Требования покрыты. Нужна совместная проверка продуктового релиза.'
              : 'Продуктовый релиз ещё не готов: проверьте покрытие требований.'}
      </p>
      {view.verification && (
        <p className="text-muted-foreground">
          Проверка: {view.verification.changeSetId} · {view.verification.verificationId}
        </p>
      )}
      <div className="my-5 flex flex-wrap gap-4" aria-label="Представление продукта">
        {(['features', 'applications'] as const).map((value) => (
          <Button
            key={value}
            variant="outline"
            aria-pressed={mode === value}
            className={cn(mode === value && 'border-primary bg-accent text-accent-foreground')}
            onClick={() => setMode(value)}
          >
            {value === 'features' ? 'Возможности для пользователя' : 'Приложения и компоненты'}
          </Button>
        ))}
      </div>
      {view.issues.length > 0 && (
        <details>
          <summary className="cursor-pointer font-medium">
            Что мешает завершению ({view.issues.length})
          </summary>
          <ul className="mt-2 grid gap-1">
            {view.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </details>
      )}
      {mode === 'features' ? (
        <div className={scroll} tabIndex={0} role="region" aria-label="Карта фич по приложениям">
          <table className={table}>
            <caption>Фичи и их участие в выбранном релизе</caption>
            <thead>
              <tr>
                <th scope="col">Возможность</th>
                {view.applications.map((a) => (
                  <th scope="col" key={a.id}>
                    {a.title}
                  </th>
                ))}
                <th scope="col">Готовность и проверки</th>
              </tr>
            </thead>
            <tbody>
              {view.features.map((feature) => (
                <tr key={feature.id}>
                  <th scope="row">
                    {feature.title}
                    <p>{feature.outcome}</p>
                  </th>
                  {view.applications.map((app) => {
                    const scope = feature.applications.find((a) => a.applicationId === app.id)!;
                    return (
                      <td key={app.id}>
                        {scope.scope === 'included' ? (
                          <>
                            <strong>
                              {scope.covered
                                ? 'Требования покрыты'
                                : scope.planned
                                  ? 'Есть задачи'
                                  : 'Нужны задачи'}
                            </strong>
                            <ul className="mt-1 grid gap-1">
                              {scope.stories.map((s) => (
                                <li key={s.repositoryId + '/' + s.storyId}>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className={link}
                                    onClick={() => onRepository(s.repositoryId)}
                                  >
                                    {s.repositoryId} / {s.storyId}
                                  </Button>
                                </li>
                              ))}
                            </ul>
                          </>
                        ) : (
                          <>
                            <strong>
                              {scope.scope === 'deferred' ? 'Отложено' : 'Не применяется'}
                            </strong>
                            <p>{scope.reason}</p>
                          </>
                        )}
                      </td>
                    );
                  })}
                  <td>
                    <strong>{labels[feature.status]}</strong>
                    {feature.checks.map((check) => (
                      <p key={check.gate}>
                        {check.passed ? '✓' : '○'} {check.scenario}
                        <br />
                        <span className="text-muted-foreground">{check.gate}</span>
                      </p>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="grid gap-4">
            {view.applications.map((app) => (
              <article key={app.id} className="rounded-md border p-4">
                <h3 className="text-md font-semibold">{app.title}</h3>
                <p>{app.purpose}</p>
                <p>Пользователи: {app.audience.join(', ')}</p>
                <p>
                  Компоненты:{' '}
                  {app.componentIds
                    .map((id) => view.components.find((c) => c.id === id)!.title)
                    .join(', ')}
                </p>
              </article>
            ))}
          </div>
          <div
            className={scroll}
            tabIndex={0}
            role="region"
            aria-label="Размещение технических компонентов"
          >
            <table className={table}>
              <caption>Технические компоненты и размещение кода</caption>
              <thead>
                <tr>
                  <th scope="col">Компонент</th>
                  <th scope="col">Назначение</th>
                  <th scope="col">Репозиторий / каталог</th>
                  <th scope="col">Зависит от</th>
                </tr>
              </thead>
              <tbody>
                {view.components.map((c) => (
                  <tr key={c.id}>
                    <th scope="row">{c.title}</th>
                    <td>{c.kind}</td>
                    <td>
                      <Button
                        variant="ghost"
                        size="sm"
                        className={link}
                        onClick={() => onRepository(c.repositoryId)}
                      >
                        {c.repositoryId}
                      </Button>{' '}
                      / {c.path}
                    </td>
                    <td>
                      {c.dependsOn
                        .map((id) => view.components.find((c) => c.id === id)!.title)
                        .join(', ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-muted-foreground">
            Несколько компонентов могут жить в одном репозитории. Задачи и интеграция сохраняют
            границы Git.
          </p>
        </>
      )}
    </div>
  );
}
