import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { Preparation } from '../core/preparation.ts';
import type { ProductBrief, ArchitectureBrief } from '../core/preparation-model.ts';
const Development = lazy(() => import('./App.tsx').then((m) => ({ default: m.App })));
const C4 = lazy(() => import('./C4Panel.tsx'));
type View = ReturnType<Preparation['status']> & {
  engineConnected?: boolean;
  startupError?: string;
};
const names = {
  draft: 'Агент прорабатывает',
  'in-review': 'Ожидает вашего решения',
  approved: 'Утверждено',
  'changes-requested': 'Нужна доработка',
};
async function request<T>(path: string, value?: unknown): Promise<T> {
  const response = await fetch(
    '/api/' + path,
    value === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-DevContour-Request': '1' },
          body: JSON.stringify(value),
        },
  );
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? 'Не удалось получить состояние');
  return data;
}
function TextList({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="preparation-section">
      <h3>{title}</h3>
      {items.length ? (
        <ul>
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">Не указано</p>
      )}
    </section>
  );
}
function Product({ content: p }: { content: ProductBrief }) {
  return (
    <>
      <section className="preparation-section">
        <h3>Проблема и ожидаемый результат</h3>
        <p>{p.problem || 'Агент ещё уточняет проблему'}</p>
        <p>{p.outcome}</p>
      </section>
      <TextList title="Для кого" items={p.audience} />
      <TextList title="Пользовательские сценарии" items={p.scenarios} />
      <TextList title="Входит в изменение" items={p.scope} />
      <TextList title="За пределами изменения" items={p.exclusions} />
      <TextList title="Как примем результат" items={p.acceptance} />
      <TextList title="Материалы и референсы" items={p.references} />
      {p.questions.length > 0 && <TextList title="Открытые вопросы" items={p.questions} />}
    </>
  );
}
function Architecture({ content: a }: { content: ArchitectureBrief }) {
  const systemName = a.c1?.nodes.find((n) => n.id === a.c1?.systemId)?.name ?? 'Система';
  return (
    <>
      <section className="preparation-section">
        <h3>Архитектурное решение</h3>
        <p>{a.summary}</p>
      </section>
      <section className="preparation-section">
        <h3>Стек и обоснование</h3>
        <div className="preparation-table">
          <table>
            <thead>
              <tr>
                <th>Область</th>
                <th>Выбор</th>
                <th>Почему</th>
                <th>Альтернативы</th>
              </tr>
            </thead>
            <tbody>
              {a.stack.map((s, i) => (
                <tr key={i}>
                  <td>{s.area}</td>
                  <td>{s.choice}</td>
                  <td>{s.rationale}</td>
                  <td>{s.alternatives}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <Suspense fallback={<p role="status">Загрузка диаграмм…</p>}>
        {a.c1 && <C4 diagram={a.c1} level={1} systemName={systemName} />}
        {a.c2 && <C4 diagram={a.c2} level={2} systemName={systemName} />}
      </Suspense>
      <TextList title="Решения и границы ответственности" items={a.decisions} />
      <TextList title="Риски и компромиссы" items={a.risks} />
      <section className="preparation-section">
        <h3>Стратегия тестирования</h3>
        <p>{a.testStrategy}</p>
      </section>
      {a.questions.length > 0 && <TextList title="Открытые вопросы" items={a.questions} />}
    </>
  );
}
export function PreparationPanel() {
  const [view, setView] = useState<View>();
  const [selected, setSelected] = useState('');
  const [tab, setTab] = useState<'product' | 'architecture' | 'development'>('product');
  const [error, setError] = useState('');
  const [comment, setComment] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [tasks, showTasks] = useState(false);
  const reload = useCallback(async () => {
    const next = await request<View>(
      'preparation' + (selected ? '?change=' + encodeURIComponent(selected) : ''),
    );
    setView(next);
  }, [selected]);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const next = await request<View>(
          'preparation' + (selected ? '?change=' + encodeURIComponent(selected) : ''),
        );
        if (!disposed) setView(next);
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 1500);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [selected]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await reload();
      setComment('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (view && !view.enabled)
    return (
      <Suspense fallback={<p role="status">Загрузка панели…</p>}>
        <Development />
      </Suspense>
    );
  if (!view?.enabled)
    return (
      <main className="preparation">
        <h1>DevContour</h1>
        {error ? <p role="alert">{error}</p> : <p role="status">Подключение к workspace…</p>}
      </main>
    );
  const c = view.current,
    p = c?.product,
    a = c?.architecture;
  const current = tab === 'product' ? p : a;
  const architectureCurrent = p?.status === 'approved' && a?.productDigest === p.digest;
  const decide = (decision: 'approve' | 'request-changes') =>
    run(async () => {
      if (!c || !current || tab === 'development') return;
      await request('preparation/decision', {
        changeId: c.id,
        stage: tab,
        expectedDigest: current.digest,
        decision,
        comment,
      });
    });
  if (tasks && view.engineConnected)
    return (
      <>
        <div className="preparation-return">
          <button onClick={() => showTasks(false)}>← Продукт и архитектура</button>
          <span>{c?.title}</span>
        </div>
        <Suspense fallback={<p role="status">Загрузка разработки…</p>}>
          <Development />
        </Suspense>
      </>
    );
  return (
    <main className="preparation">
      <header className="preparation-header">
        <div>
          <span className="preparation-brand">DevContour</span>
          <h1>От запроса к разработке</h1>
          <p>
            Сначала определяем продукт, затем согласуем устройство системы и запускаем исполнение.
          </p>
        </div>
        <span className="preparation-live">Панель подключена</span>
      </header>
      <div className="preparation-layout">
        <aside className="preparation-sidebar">
          <h2>Изменения продукта</h2>
          <nav aria-label="Изменения продукта">
            {view.changes.map((change) => (
              <button
                key={change.id}
                aria-current={change.id === c?.id ? 'page' : undefined}
                onClick={() => {
                  setSelected(change.id);
                  setTab('product');
                  setComment('');
                }}
              >
                {change.title}
              </button>
            ))}
          </nav>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const next = await request<View>('agent', {
                  operation: 'preparation_create',
                  input: { title },
                });
                if (next.enabled) {
                  setSelected(next.activeChangeId ?? '');
                  setTab('product');
                }
                setTitle('');
              });
            }}
          >
            <label htmlFor="change-title">Новое изменение</label>
            <input
              id="change-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              minLength={3}
              maxLength={180}
              placeholder="Например, модерация чата"
              required
            />
            <button disabled={busy} type="submit">
              Создать изменение
            </button>
          </form>
        </aside>
        <article className="preparation-content">
          {error && (
            <p role="alert" className="preparation-error">
              {error}
            </p>
          )}
          {view.startupError && (
            <p role="alert" className="preparation-error">
              Не удалось подключить разработку: {view.startupError}
            </p>
          )}
          <ol className="preparation-steps" aria-label="Этапы изменения">
            {(['product', 'architecture', 'development'] as const).map((step, i) => (
              <li key={step}>
                <button
                  aria-current={tab === step ? 'step' : undefined}
                  onClick={() => {
                    setTab(step);
                    setComment('');
                  }}
                >
                  <span>{i + 1}</span>
                  <strong>{['Продукт', 'Архитектура и стек', 'Разработка'][i]}</strong>
                  <small>
                    {step === 'product'
                      ? p
                        ? names[p.status]
                        : 'Нужна постановка'
                      : step === 'architecture'
                        ? p?.status !== 'approved'
                          ? 'После согласования продукта'
                          : architectureCurrent && a
                            ? names[a.status]
                            : 'Нужна актуальная архитектура'
                        : view.developmentReady
                          ? 'Разрешена'
                          : 'Ожидает согласований'}
                  </small>
                </button>
              </li>
            ))}
          </ol>
          {c ? (
            <>
              <div className="preparation-title">
                <h2>{c.title}</h2>
                {view.activeChangeId !== c.id && (
                  <button
                    disabled={busy}
                    onClick={() => {
                      void run(() =>
                        request('agent', {
                          operation: 'preparation_activate',
                          input: { changeId: c.id },
                        }),
                      );
                    }}
                  >
                    Выбрать для новых задач
                  </button>
                )}
              </div>
              {tab === 'development' ? (
                <section className="preparation-section">
                  <h3>
                    {view.developmentReady
                      ? 'Постановка и архитектура утверждены'
                      : 'Разработка ещё не разрешена'}
                  </h3>
                  <p>
                    {view.developmentReady
                      ? view.engineConnected
                        ? 'Агент может декомпозировать работу и запустить технический workflow. Тесты, независимое ревью и приёмка остаются обязательными.'
                        : 'Агент готовит репозитории, профили и настоящие проверки. Панель подключит технический workflow автоматически.'
                      : view.blocker}
                  </p>
                  <p>
                    Принято задач: {view.delivery.done} из {view.delivery.total}. Сбоев:{' '}
                    {view.delivery.failed}.
                  </p>
                  {view.delivery.boards.length > 0 && (
                    <ul>
                      {view.delivery.boards.map((b) => (
                        <li key={b.id}>{b.title}</li>
                      ))}
                    </ul>
                  )}
                  {view.engineConnected && (
                    <button className="primary" onClick={() => showTasks(true)}>
                      Открыть доски разработки
                    </button>
                  )}
                  <p className="muted">
                    Готовность задач не означает публикацию или продуктовую приёмку релиза.
                  </p>
                </section>
              ) : (
                <>
                  {current && (
                    <div className="preparation-version">
                      <strong>Версия {current.number}</strong>
                      <span>{names[current.status]}</span>
                      <span>{current.reason}</span>
                    </div>
                  )}
                  {tab === 'architecture' && !architectureCurrent && a && (
                    <p className="preparation-warning">
                      Эта архитектура относится к прежней постановке. Агент должен подготовить новую
                      версию.
                    </p>
                  )}
                  {tab === 'product' ? (
                    p ? (
                      <Product content={p.content} />
                    ) : (
                      <p className="preparation-empty">
                        Поручите ведущему агенту изучить ТЗ и заполнить постановку. Здесь появятся
                        сценарии, границы и критерии приёмки. Проект и стек пока не нужны.
                      </p>
                    )
                  ) : a ? (
                    <Architecture content={a.content} />
                  ) : (
                    <p className="preparation-empty">
                      {p?.status === 'approved'
                        ? 'Агент готовит архитектуру, сравнение стеков и диаграммы C1/C2.'
                        : 'Архитектура будет прорабатываться после вашего утверждения продуктовой части.'}
                    </p>
                  )}
                  {current?.decision && (
                    <div className="preparation-decision">
                      <strong>
                        Решение пользователя ·{' '}
                        {new Date(current.decision.at).toLocaleString('ru-RU')}
                      </strong>
                      <p>{current.decision.comment || 'Версия утверждена без замечаний.'}</p>
                    </div>
                  )}
                  {current?.status === 'in-review' &&
                    (tab === 'product' || architectureCurrent) && (
                      <form
                        className="preparation-approval"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void decide('approve');
                        }}
                      >
                        <h3>
                          {tab === 'product'
                            ? 'Утвердить продуктовую постановку'
                            : 'Утвердить архитектуру и стек'}
                        </h3>
                        <p>
                          {tab === 'product'
                            ? 'После утверждения агент сможет приступить к архитектуре. Разработка останется заблокированной.'
                            : 'После утверждения агент сможет настроить проект и начать разработку по этой версии.'}
                        </p>
                        <label htmlFor="decision-comment">Комментарий к решению</label>
                        <textarea
                          id="decision-comment"
                          value={comment}
                          onChange={(e) => setComment(e.target.value)}
                          maxLength={3000}
                          rows={3}
                        />
                        <div>
                          <button className="primary" type="submit" disabled={busy}>
                            Утвердить версию {current.number}
                          </button>
                          <button
                            type="button"
                            disabled={busy || comment.trim().length < 3}
                            onClick={() => {
                              void decide('request-changes');
                            }}
                          >
                            Вернуть на доработку
                          </button>
                        </div>
                      </form>
                    )}
                </>
              )}
              <details className="preparation-history">
                <summary>История версий и решений ({c.history.length})</summary>
                <ol>
                  {c.history.map((r) => (
                    <li key={r.stage + r.number}>
                      <strong>
                        {r.stage === 'product' ? 'Продукт' : 'Архитектура'} · v{r.number} ·{' '}
                        {names[r.status]}
                      </strong>
                      <p>{r.reason}</p>
                      {r.decision && (
                        <p>Пользователь: {r.decision.comment || 'Утверждено без замечаний'}</p>
                      )}
                    </li>
                  ))}
                </ol>
              </details>
            </>
          ) : (
            <p className="preparation-empty">
              Workspace открыт. Создайте первое изменение или поручите это агенту. Проработка
              продукта уже будет видна на этой странице.
            </p>
          )}
        </article>
      </div>
    </main>
  );
}
