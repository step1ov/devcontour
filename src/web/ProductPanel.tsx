import { useEffect, useState } from 'react';
import type { FeatureStatus, ProductView } from '../core/product-map.ts';

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
      <div className="product-panel" role="alert">
        {error}
      </div>
    );
  if (!view || (view.available && release && view.releaseId !== release))
    return (
      <div className="product-panel" role="status">
        Читаем карту продукта…
      </div>
    );
  if (!view.available)
    return (
      <div className="product-panel">
        <h2>Карта продукта ещё не подготовлена</h2>
        <p>{view.reason}</p>
        <p>
          Агент описывает приложения, общие фичи и ссылки на истории компонентов. Статусы появятся
          из задач и результатов проверок.
        </p>
      </div>
    );
  return (
    <div className="product-panel">
      <div className="product-heading">
        <div>
          <h2>{view.title}</h2>
          <p>{view.purpose}</p>
        </div>
        <label>
          Релиз
          <select
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
        <p className="muted">
          Проверка: {view.verification.changeSetId} · {view.verification.verificationId}
        </p>
      )}
      <div className="product-switch" aria-label="Представление продукта">
        <button aria-pressed={mode === 'features'} onClick={() => setMode('features')}>
          Возможности для пользователя
        </button>
        <button aria-pressed={mode === 'applications'} onClick={() => setMode('applications')}>
          Приложения и компоненты
        </button>
      </div>
      {view.issues.length > 0 && (
        <details>
          <summary>Что мешает завершению ({view.issues.length})</summary>
          <ul>
            {view.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </details>
      )}
      {mode === 'features' ? (
        <div
          className="product-table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Карта фич по приложениям"
        >
          <table className="product-table">
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
                            <ul>
                              {scope.stories.map((s) => (
                                <li key={s.repositoryId + '/' + s.storyId}>
                                  <button
                                    className="link-button"
                                    onClick={() => onRepository(s.repositoryId)}
                                  >
                                    {s.repositoryId} / {s.storyId}
                                  </button>
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
                        <span className="muted">{check.gate}</span>
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
          <div className="product-applications">
            {view.applications.map((app) => (
              <article key={app.id}>
                <h3>{app.title}</h3>
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
            className="product-table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Размещение технических компонентов"
          >
            <table className="product-table">
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
                      <button className="link-button" onClick={() => onRepository(c.repositoryId)}>
                        {c.repositoryId}
                      </button>{' '}
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
          <p className="muted">
            Несколько компонентов могут жить в одном репозитории. Задачи и интеграция сохраняют
            границы Git.
          </p>
        </>
      )}
    </div>
  );
}
