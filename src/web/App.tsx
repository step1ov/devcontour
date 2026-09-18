import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from 'react';
import { ReactFlow, Background, Controls, Handle, Position, type NodeProps } from '@xyflow/react';
import {
  GitBranch,
  Plus,
  Play,
  Pause,
  Check,
  CircleCheck,
  Clock,
  AlertCircle,
  ArrowUpRight,
  LayoutGrid,
  List,
  History,
  X,
  FileCheck,
  RotateCcw,
  Workflow,
  ChevronRight,
} from 'lucide-react';
import type { DevContourState, Task, Config, AuditEvent, Board, Role } from '../core/model.ts';
import { levels } from '../core/graph.ts';
import type { taskProgress } from '../application/context.ts';
import { ProductPanel } from './ProductPanel.tsx';
type UITask = Task & {
  specDigest: string;
  blockers: string[];
  progress?: ReturnType<typeof taskProgress>;
};
type Snapshot = Omit<DevContourState, 'tasks'> & {
  tasks: UITask[];
  events: AuditEvent[];
  ready: string[];
  journalError?: string;
  config: Pick<
    Config,
    | 'name'
    | 'mode'
    | 'approvalMode'
    | 'completionMode'
    | 'storage'
    | 'concurrency'
    | 'roles'
    | 'reviewer'
    | 'gates'
    | 'targetBranch'
    | 'packs'
    | 'repositories'
    | 'workspaceGates'
  >;
};
const roleNames: Record<Role, string> = {
  architect: 'Архитектор',
  backend: 'Backend',
  frontend: 'Frontend',
  qa: 'Тестирование',
};
const waitingReasons: Record<string, string> = {
  plan_review_required: 'План ещё не утверждён. Требуется ревью.',
  dependencies_incomplete: 'Сначала должны завершиться связанные задачи.',
  queue_paused: 'Очередь на паузе. Выдача задач возобновится после запуска.',
  assigned_to_another_member: 'Задача назначена другому участнику команды.',
  workers_busy: 'Все исполнители заняты. Задача ждёт свободного места.',
  workspace_operation_active: 'Идёт общая проверка или проверка публикации.',
  inactive_revision: 'Задача относится к неактивной ревизии.',
  failure_requires_diagnosis: 'Разберите причину сбоя перед повторной попыткой.',
  attempts_exhausted: 'Лимит попыток исчерпан. Нужна диагностика и пересмотр решения.',
};
const statusNames: Record<string, string> = {
  draft: 'Черновик',
  ready: 'Готова к запуску',
  running: 'Разработка',
  verifying: 'Проверки',
  reviewing: 'Ревью',
  integrating: 'Интеграция',
  done: 'Проверена локально',
  failed: 'Сбой',
  cancelled: 'Отменена',
  blocked: 'Ждёт зависимостей',
};
const stamp = (value?: string) =>
  value
    ? new Date(value).toLocaleString('ru-RU', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
function status(t: UITask) {
  return t.status === 'ready' && t.blockers.length ? 'blocked' : t.status;
}
const taskStatusName = (t: UITask) =>
  t.status === 'done' && t.sharedCompletion ? 'Принята из Git' : statusNames[status(t)];
const shortId = (id: string) =>
  /^[A-Z]+-[a-f0-9-]{36}$/.test(id) ? id.slice(0, id.indexOf('-') + 9) : id;
function Badge({ value, children }: { value: string; children?: ReactNode }) {
  return <span className={`badge badge-${value}`}>{children ?? statusNames[value] ?? value}</span>;
}
function TaskNode({ data }: NodeProps) {
  const t = data.task as UITask;
  return (
    <div className={`task-node node-${status(t)}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-meta">
        <span title={t.id}>{shortId(t.id)}</span>
        <span>
          {t.repositoryId} · {roleNames[t.role]}
        </span>
      </div>
      <strong>{t.title}</strong>
      <Badge value={status(t)}>{taskStatusName(t)}</Badge>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { task: TaskNode };
async function api(path: string, input?: unknown, method = 'POST') {
  const response = await fetch(
    '/api/' + path,
    input === undefined
      ? undefined
      : {
          method,
          headers: { 'Content-Type': 'application/json', 'X-DevContour-Request': '1' },
          body: JSON.stringify(input),
        },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Ошибка запроса');
  return data;
}
function Modal({
  title,
  children,
  onClose,
  error,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  error?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      prior?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-labelledby="modal-title"
    >
      <div className="modal-head">
        <h2 id="modal-title">{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="Закрыть диалог">
          <X />
        </button>
      </div>
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      {children}
    </dialog>
  );
}
export function App() {
  const flowRef =
    useRef<(options: { padding: number; minZoom: number; maxZoom: number }) => Promise<boolean>>(
      null,
    );
  const canvasRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<Snapshot>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [boardId, setBoardId] = useState('');
  const [revisionNumber, setRevisionNumber] = useState<number | null>(null);
  const [selected, setSelected] = useState('');
  const [tab, setTab] = useState('graph');
  const [query, setQuery] = useState('');
  const [repositoryFilter, setRepositoryFilter] = useState('');
  const [modal, setModal] = useState<
    'board' | 'task' | 'edit' | 'correct' | 'contract' | 'changeset' | null
  >(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [impact, setImpact] = useState<{
    taskIds: string[];
    boards: { id: string; title: string }[];
  }>();
  const [log, setLog] = useState<{ title: string; content: string }>();
  const refresh = useCallback(async () => {
    const state = (await api('state')) as Snapshot;
    setData(state);
    return state;
  }, []);
  useEffect(() => {
    let alive = true;
    const load = () =>
      refresh().catch((e) => {
        if (alive) setError(String(e.message));
      });
    void load();
    const id = setInterval(() => {
      void load();
    }, 1800);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [refresh]);
  useEffect(() => {
    if (!data) return;
    if (!boardId)
      setBoardId(
        data.boards.find((b) => b.revisions.at(-1)?.status === 'active')?.id ??
          data.boards[0]?.id ??
          '',
      );
  }, [data, boardId]);
  const board = data?.boards.find((b) => b.id === boardId);
  const revision =
    board?.revisions.find((r) => r.number === revisionNumber) ?? board?.revisions.at(-1);
  const current = revision?.number === board?.revisions.at(-1)?.number;
  const editable =
    revision?.status === 'active' && current && tab !== 'workspace' && tab !== 'product';
  const tasks = useMemo(
    () => data?.tasks.filter((t) => revision?.taskIds.includes(t.id)) ?? [],
    [data, revision],
  );
  const graphTasks = useMemo(
    () =>
      tab === 'workspace'
        ? (data?.tasks.filter((t) =>
            data.boards.some((b) => b.revisions.at(-1)?.taskIds.includes(t.id)),
          ) ?? [])
        : tasks,
    [tab, data, tasks],
  );
  const filtered = graphTasks.filter(
    (t) =>
      (!repositoryFilter || t.repositoryId === repositoryFilter) &&
      `${t.title} ${t.id} ${t.repositoryId} ${roleNames[t.role]}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const task = graphTasks.find((t) => t.id === selected);
  useEffect(() => {
    if (graphTasks.length && !graphTasks.some((t) => t.id === selected))
      setSelected(graphTasks[0].id);
  }, [graphTasks, selected]);
  useEffect(() => {
    let valid = true;
    if (modal !== 'correct' || !roots.length) {
      setImpact(undefined);
      return;
    }
    api(`boards/${boardId}/impact?roots=${roots.join(',')}`)
      .then((v) => {
        if (valid) setImpact(v);
      })
      .catch((e) => {
        if (valid) setError(e.message);
      });
    return () => {
      valid = false;
    };
  }, [modal, boardId, roots]);
  const hasData = !!data;
  useEffect(() => {
    if (!canvasRef.current) return;
    const observer = new ResizeObserver(() => {
      void flowRef.current?.({ padding: 0.12, minZoom: 0.65, maxZoom: 1 });
    });
    observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, [tab, boardId, hasData]);
  async function act(fn: () => Promise<unknown>, message: string, close = true) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
      setNotice(message);
      if (close) setModal(null);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  function switchBoard(id: string) {
    setBoardId(id);
    setRevisionNumber(null);
    setSelected('');
    setQuery('');
  }
  const graph = useMemo(() => {
    const columns = new Map<number, number>();
    const lv = levels(filtered);
    const styles = getComputedStyle(document.documentElement);
    const token = (key: string) => parseFloat(styles.getPropertyValue(key));
    const dx = token('--node-width') + token('--node-gap-x'),
      dy = token('--node-height') + token('--node-gap-y');
    return {
      nodes: filtered.map((t) => {
        const level = lv.get(t.id)!;
        const row = columns.get(level) ?? 0;
        columns.set(level, row + 1);
        return {
          id: t.id,
          type: 'task',
          position: { x: level * dx, y: row * dy },
          data: { task: t },
          selected: t.id === selected,
          ariaLabel: `${t.id}: ${t.title}, ${taskStatusName(t)}`,
        };
      }),
      edges: filtered.flatMap((t) =>
        t.dependsOn
          .filter((d) => filtered.some((t) => t.id === d))
          .map((d) => ({
            id: `${d}-${t.id}`,
            source: d,
            target: t.id,
            type: 'smoothstep',
            className: status(t) === 'done' ? 'edge-done' : '',
          })),
      ),
    };
  }, [filtered, selected]);
  if (!data)
    return (
      <main className="loading">
        <Workflow />
        <h1>DevContour</h1>
        <p role="status">{error || 'Загружаем рабочий граф…'}</p>
        {error && <button onClick={() => location.reload()}>Повторить</button>}
      </main>
    );
  const done = tasks.filter((t) => t.status === 'done').length;
  const blocked = tasks.filter((t) => status(t) === 'blocked').length;
  const ready = tasks.filter((t) => data.ready.includes(t.id)).length;
  const latestRun = task ? data.runs.filter((r) => r.taskId === task.id).at(-1) : undefined;
  const taskRepository = data.config.repositories.find((r) => r.id === task?.repositoryId);
  const taskBinding = task
    ? (taskRepository?.roles?.[task.role] ?? data.config.roles[task.role])
    : undefined;
  const plannedReviewer = taskBinding?.reviewer ?? taskRepository?.reviewer ?? data.config.reviewer;
  const displayedRun = task && !['draft', 'ready'].includes(task.status) ? latestRun : undefined;
  const displayedWriter = displayedRun ?? taskBinding;
  const displayedReviewer = displayedRun
    ? { runtime: displayedRun.reviewer, model: displayedRun.reviewerModel }
    : plannedReviewer;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="DevContour, главная">
          <span className="brand-icon">
            <Workflow />
          </span>
          DevContour<span className="version">mvp</span>
        </a>
        <div className="project-name">
          <span className="project-avatar">D</span>
          <div>
            <strong>{data.config.name}</strong>
            <small>Локальное рабочее пространство</small>
          </div>
        </div>
        <div className="sidebar-heading">
          <span>Доски проекта</span>
          <button
            className="icon-button"
            aria-label="Создать доску"
            onClick={() => setModal('board')}
          >
            <Plus />
          </button>
        </div>
        <nav aria-label="Доски">
          {[...data.boards]
            .sort(
              (a, b) =>
                Number(b.revisions.at(-1)!.status === 'active') -
                Number(a.revisions.at(-1)!.status === 'active'),
            )
            .map((b) => (
              <button
                key={b.id}
                className={`board-nav ${b.id === boardId ? 'is-active' : ''}`}
                onClick={() => switchBoard(b.id)}
                aria-current={b.id === boardId ? 'page' : undefined}
              >
                <LayoutGrid />
                <span>
                  {b.title}
                  <small>
                    {b.revisions.at(-1)!.status === 'accepted' ? 'Принята' : 'В работе'} · ревизия{' '}
                    {b.revisions.at(-1)!.number}
                  </small>
                </span>
                {b.revisions.at(-1)!.status === 'accepted' && <Check className="nav-check" />}
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="runner-status">
            <span className={data.paused ? 'dot' : 'dot active'} />
            <strong>{data.paused ? 'Очередь на паузе' : 'Оркестратор работает'}</strong>
          </div>
          <p>
            {data.runs.filter((r) => r.status === 'active').length} из {data.config.concurrency}{' '}
            исполнителей занято
          </p>
          <p>
            Интеграция в <code>{data.config.targetBranch}</code>
          </p>
          <p>Репозитории: {data.config.repositories.map((r) => r.id).join(', ')}</p>
          <p>Согласования: {data.config.approvalMode === 'operator' ? 'оператор' : 'агент'}</p>
        </div>
      </aside>
      <main className="workspace">
        <div className="topbar">
          <span>
            Проект <ChevronRight />{' '}
            {tab === 'product' ? 'Продукт' : (board?.title ?? 'Новая доска')}
          </span>
          <span className="mode-label">
            {data.config.mode === 'demo'
              ? 'Учебный режим · без вызовов моделей'
              : 'Локальный runtime'}
          </span>
        </div>
        <div className="page-content">
          <header className="page-header">
            <div>
              <div className="title-row">
                <h1>{tab === 'product' ? 'Продукт' : (board?.title ?? 'Создайте первую доску')}</h1>
                {revision && tab !== 'product' && (
                  <span className="revision-label">r{revision.number}</span>
                )}
              </div>
              <p>
                {tab === 'product'
                  ? 'Пользовательские возможности, приложения и проверенный результат.'
                  : (board?.description ?? 'Опишите цель, добавьте задачи и их зависимости.')}
              </p>
            </div>
            <div className="header-actions">
              {tab !== 'product' && board && current && revision?.status === 'accepted' && (
                <button
                  className="primary"
                  onClick={() => {
                    setRoots([]);
                    setModal('correct');
                  }}
                >
                  <RotateCcw />
                  Создать корректировку
                </button>
              )}
              {editable && (
                <>
                  <button onClick={() => setModal('task')}>
                    <Plus />
                    Задача
                  </button>
                  {tasks.some((t) => t.status === 'draft') && (
                    <button
                      onClick={() =>
                        void act(() => api(`boards/${boardId}/approve`, {}), 'Задачи утверждены')
                      }
                      disabled={busy}
                    >
                      Утвердить план
                    </button>
                  )}
                  {tasks.length > 0 && done === tasks.length && (
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () => api(`boards/${boardId}/accept`, {}),
                          'Ревизия принята. Снимок сохранён.',
                        )
                      }
                    >
                      <CircleCheck />
                      {data.config.completionMode === 'remote'
                        ? 'Принять доску локально'
                        : 'Принять доску'}
                    </button>
                  )}
                </>
              )}
            </div>
          </header>
          {error && !modal && !log && (
            <div className="alert error" role="alert">
              <AlertCircle />
              <span>{error}</span>
              <button
                className="icon-button"
                onClick={() => setError('')}
                aria-label="Скрыть ошибку"
              >
                <X />
              </button>
            </div>
          )}
          {data.journalError && (
            <p className="alert error" role="alert">
              Дневник: {data.journalError}
            </p>
          )}
          {notice && (
            <div className="notice" role="status">
              <Check />
              {notice}
              <button
                className="icon-button"
                onClick={() => setNotice('')}
                aria-label="Скрыть уведомление"
              >
                <X />
              </button>
            </div>
          )}
          {tab !== 'product' && revision?.status === 'accepted' && (
            <div className="accepted-banner">
              <CircleCheck />
              <div>
                <strong>
                  Ревизия {revision.number} принята {stamp(revision.acceptedAt)}
                </strong>
                <span>Снимок сохранён. Изменения начнут новый цикл и сохранят эту историю.</span>
              </div>
              <code>{revision.snapshot?.sha.slice(0, 8)}</code>
            </div>
          )}
          {tab !== 'product' && (
            <section className="summary-bar" aria-label="Прогресс доски">
              <div>
                <CircleCheck />
                <strong>
                  {done}
                  <span> / {tasks.length}</span>
                </strong>
                <span>результатов принято</span>
              </div>
              <div>
                <Play />
                <strong>{ready}</strong>
                <span>готово к запуску</span>
              </div>
              <div>
                <Clock />
                <strong>{blocked}</strong>
                <span>ждут зависимостей</span>
              </div>
              <div className="queue-control">
                <button
                  className={data.paused ? 'primary' : ''}
                  disabled={busy || (data.paused && !data.ready.length)}
                  onClick={() =>
                    void act(
                      () => api('scheduler', { start: data.paused }),
                      data.paused
                        ? 'Очередь всех досок запущена'
                        : 'Новые задачи приостановлены; текущие продолжаются',
                      false,
                    )
                  }
                >
                  {data.paused ? <Play /> : <Pause />}
                  {data.paused ? 'Запустить очередь' : 'Пауза очереди'}
                </button>
              </div>
            </section>
          )}
          <div className="workspace-toolbar">
            <div className="tabs" role="tablist" aria-label="Представление доски">
              {[
                { key: 'product', label: 'Продукт', icon: <LayoutGrid /> },
                { key: 'graph', label: 'Граф', icon: <GitBranch /> },
                { key: 'workspace', label: 'Общий граф', icon: <Workflow /> },
                { key: 'changesets', label: 'Изменения', icon: <FileCheck /> },
                { key: 'list', label: 'Список', icon: <List /> },
                { key: 'history', label: 'Ревизии', icon: <History /> },
                { key: 'contracts', label: 'Контракты', icon: <FileCheck /> },
              ].map((t) => (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={tab === t.key}
                  onClick={() => setTab(t.key)}
                >
                  {t.icon}
                  {t.label}
                </button>
              ))}
            </div>
            {tab !== 'product' && (
              <>
                <label className="repository-filter">
                  <span className="sr-only">Репозиторий</span>
                  <select
                    aria-label="Репозиторий"
                    value={repositoryFilter}
                    onChange={(e) => setRepositoryFilter(e.target.value)}
                  >
                    <option value="">Все репозитории</option>
                    {data.config.repositories.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="search">
                  <span className="sr-only">Поиск задач</span>
                  <input
                    placeholder="Найти задачу…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
              </>
            )}
          </div>
          <div
            className={`work-area ${tab === 'changesets' || tab === 'product' ? 'changeset-area' : ''}`}
          >
            <section className="board-surface" aria-label="Рабочая область">
              {tab === 'product' && (
                <ProductPanel
                  onRepository={(id) => {
                    setRepositoryFilter(id);
                    setTab('workspace');
                  }}
                />
              )}
              {(tab === 'graph' || tab === 'workspace') &&
                (filtered.length ? (
                  <>
                    <div className="graph-caption">
                      <span>Зависимость ведёт от условия к результату</span>
                      <span>{graph.edges.length} связей</span>
                    </div>
                    <div className="graph-canvas" ref={canvasRef}>
                      <ReactFlow
                        onInit={(instance) => {
                          flowRef.current = (options) => instance.fitView(options);
                        }}
                        key={`${boardId}-${revision?.number}-${filtered.map((t) => t.id).join()}`}
                        nodes={graph.nodes}
                        edges={graph.edges}
                        nodeTypes={nodeTypes}
                        nodesDraggable={false}
                        nodesConnectable={false}
                        edgesFocusable={false}
                        deleteKeyCode={null}
                        onNodeClick={(_, n) => setSelected(n.id)}
                        fitView
                        fitViewOptions={{ padding: 0.12, minZoom: 0.65, maxZoom: 1 }}
                        minZoom={0.3}
                      >
                        <Background />
                        <Controls showInteractive={false} />
                      </ReactFlow>
                    </div>
                  </>
                ) : (
                  <div className="empty">
                    <GitBranch />
                    <h2>{query ? 'Нет совпадений' : 'Граф начинается с задачи'}</h2>
                    <p>
                      {query
                        ? 'Измените поисковый запрос.'
                        : 'Добавьте первый результат и критерии его приёмки.'}
                    </p>
                    {editable && !query && (
                      <button onClick={() => setModal('task')}>Добавить задачу</button>
                    )}
                  </div>
                ))}
              {tab === 'list' && (
                <div className="task-list">
                  {filtered.length ? (
                    filtered.map((t) => (
                      <button
                        className={`task-row ${selected === t.id ? 'selected' : ''}`}
                        key={t.id}
                        onClick={() => setSelected(t.id)}
                      >
                        <span className="task-id" title={t.id}>
                          {shortId(t.id)}
                        </span>
                        <div>
                          <strong>{t.title}</strong>
                          <small>
                            {t.repositoryId} · {roleNames[t.role]}
                            {t.dependsOn.length ? ` · после ${t.dependsOn.join(', ')}` : ''}
                          </small>
                        </div>
                        <Badge value={status(t)}>{taskStatusName(t)}</Badge>
                        <ChevronRight />
                      </button>
                    ))
                  ) : (
                    <p className="empty">Нет задач для отображения.</p>
                  )}
                </div>
              )}
              {tab === 'changesets' && (
                <div className="history-list changesets">
                  <div className="section-title">
                    <h2>Изменения workspace</h2>
                    <button onClick={() => setModal('changeset')}>
                      <Plus />
                      Новый ChangeSet
                    </button>
                  </div>
                  <p>
                    Одна возможность продукта, несколько репозиториев. Приёмка фиксирует проверенную
                    комбинацию SHA.
                  </p>
                  {data.config.storage === 'component' && (
                    <p>
                      Задачи и журналы хранятся в компонентах. Здесь показан общий граф и
                      межпроектная приёмка.
                    </p>
                  )}
                  {!data.changeSets.length && (
                    <p>
                      Ведущий агент объединяет доски в ChangeSet и настраивает совместные проверки
                      продукта и библиотек.
                    </p>
                  )}
                  {[...data.changeSets].reverse().map((c) => {
                    const v = c.verifications.at(-1);
                    const delivery = c.deliveries?.filter((d) => d.verificationId === v?.id).at(-1);
                    const needsDelivery = data.config.completionMode === 'remote';
                    const state = c.acceptance
                      ? 'done'
                      : v?.status === 'failed'
                        ? 'failed'
                        : v?.status === 'active'
                          ? 'running'
                          : 'ready';
                    return (
                      <article key={c.id}>
                        <div>
                          <strong>
                            {c.id} · {c.title}
                          </strong>
                          <Badge value={state}>
                            {c.acceptance
                              ? 'Принят'
                              : v?.status === 'passed'
                                ? 'Проверен локально'
                                : v?.status === 'failed'
                                  ? 'Сбой проверки'
                                  : v?.status === 'active'
                                    ? 'Проверяется'
                                    : 'Ожидает проверки'}
                          </Badge>
                        </div>
                        <p>{c.description}</p>
                        {c.releaseId && (
                          <p>
                            Продуктовый релиз: <strong>{c.releaseId}</strong>
                          </p>
                        )}
                        <p>
                          Доски:{' '}
                          {c.boardIds
                            .map((id) => data.boards.find((b) => b.id === id)?.title ?? id)
                            .join(', ')}
                          {c.supersedes && ` · продолжает ${c.supersedes}`}
                        </p>
                        {v?.error && <p className="alert error">{v.error}</p>}
                        {needsDelivery && (
                          <p>Публикация человеком; DevContour проверяет merge и CI.</p>
                        )}
                        {delivery && (
                          <div>
                            <p>
                              Публикация:{' '}
                              {delivery.status === 'delivered'
                                ? 'Merge и CI подтверждены'
                                : delivery.status === 'active'
                                  ? 'Проверяется'
                                  : 'Ожидает публикации или CI'}
                            </p>
                            {delivery.error && <p className="alert error">{delivery.error}</p>}
                            {Object.entries(delivery.components).map(([id, component]) => (
                              <p key={id}>
                                <strong>{id}</strong> · {component.state} ·{' '}
                                <code>{component.sha.slice(0, 12)}</code>{' '}
                                {component.url && /^https?:\/\//.test(component.url) && (
                                  <a href={component.url} target="_blank" rel="noreferrer">
                                    PR/MR #{component.mr}
                                  </a>
                                )}
                                {component.checks?.map((check) => (
                                  <span key={check.name}>
                                    {' '}
                                    · {check.name}: {check.status}
                                  </span>
                                ))}
                              </p>
                            ))}
                          </div>
                        )}
                        {v?.manifest && (
                          <div className="manifest-list">
                            {Object.entries(v.manifest).map(([id, m]) => (
                              <p key={id}>
                                <strong>{id}</strong> <code>{m.sha}</code>
                              </p>
                            ))}
                          </div>
                        )}
                        {v?.evidence.map((e) => (
                          <p key={e.gate}>
                            <Badge value={e.passed ? 'done' : 'failed'}>
                              {e.passed ? 'PASS' : 'FAIL'}
                            </Badge>{' '}
                            {e.gate} · {e.summary}{' '}
                            <button
                              onClick={() =>
                                void act(
                                  async () => {
                                    const value = await api(
                                      `changesets/${c.id}/evidence?verification=${v.id}&gate=${encodeURIComponent(e.gate)}`,
                                    );
                                    setLog({ title: e.gate, content: value.content });
                                  },
                                  '',
                                  false,
                                )
                              }
                            >
                              Лог проверки
                            </button>
                          </p>
                        ))}
                        {c.acceptance && (
                          <p>
                            Принят {stamp(c.acceptance.at)} · {c.acceptance.approval.actor} ·
                            receipt <code>{c.acceptance.digest.slice(0, 16)}</code>
                          </p>
                        )}
                        <div className="changeset-actions">
                          {!c.acceptance && (
                            <button
                              disabled={
                                busy || v?.status === 'active' || delivery?.status === 'active'
                              }
                              onClick={() =>
                                void act(
                                  () => api(`changesets/${c.id}/verify`, {}),
                                  'Совместная проверка запущена',
                                  false,
                                )
                              }
                            >
                              <Play />
                              Проверить совместно
                            </button>
                          )}
                          {!c.acceptance && needsDelivery && v?.status === 'passed' && (
                            <button
                              disabled={busy || delivery?.status === 'active'}
                              onClick={() =>
                                void act(
                                  () => api(`changesets/${c.id}/handoff`, {}),
                                  'Инструкция ручной публикации сохранена в .devcontour-local/handoffs выбранного workspace',
                                  false,
                                )
                              }
                            >
                              Подготовить передачу
                            </button>
                          )}
                          {!c.acceptance &&
                            needsDelivery &&
                            v?.status === 'passed' &&
                            delivery?.status !== 'delivered' && (
                              <button
                                disabled={busy || delivery?.status === 'active'}
                                onClick={() =>
                                  void act(
                                    () => api(`changesets/${c.id}/remote-check`, {}),
                                    'Состояние публикации обновлено',
                                    false,
                                  )
                                }
                              >
                                Проверить публикацию
                              </button>
                            )}
                          {!c.acceptance &&
                            v?.status === 'passed' &&
                            (!needsDelivery || delivery?.status === 'delivered') && (
                              <button
                                disabled={busy}
                                onClick={() =>
                                  void act(
                                    () => api(`changesets/${c.id}/accept`, {}),
                                    'ChangeSet принят',
                                    false,
                                  )
                                }
                              >
                                <Check />
                                Принять ChangeSet
                              </button>
                            )}
                          <button
                            onClick={() =>
                              void act(
                                async () => {
                                  const value = await api(`changesets/${c.id}/journal`);
                                  setLog({ title: `Дневник ${c.id}`, content: value.content });
                                },
                                '',
                                false,
                              )
                            }
                          >
                            Дневник
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
              {tab === 'history' && (
                <div className="history-list">
                  <h2>История результата</h2>
                  <p>
                    Принятые снимки неизменяемы. Каждая корректировка имеет свой план и
                    доказательства.
                  </p>
                  {[...(board?.revisions ?? [])].reverse().map((r) => (
                    <article key={r.number}>
                      <div>
                        <span className="history-number">r{r.number}</span>
                        <div>
                          <strong>{r.reason}</strong>
                          <small>
                            {stamp(r.createdAt)} · {r.taskIds.length} задач
                          </small>
                        </div>
                        <Badge value={r.status === 'accepted' ? 'done' : 'ready'}>
                          {r.status === 'accepted' ? 'Принята' : 'В работе'}
                        </Badge>
                      </div>
                      {r.snapshot && (
                        <p>
                          Снимок <code>{r.snapshot.digest.slice(0, 12)}</code> · Git{' '}
                          <code>
                            {Object.entries(r.snapshot.repositories ?? { main: r.snapshot.sha })
                              .map(([id, sha]) => `${id}:${sha.slice(0, 8)}`)
                              .join(' · ')}
                          </code>
                        </p>
                      )}
                      <button
                        onClick={() => {
                          setRevisionNumber(r.number);
                          setTab('graph');
                        }}
                      >
                        Открыть ревизию {r.number}
                        <ArrowUpRight />
                      </button>
                    </article>
                  ))}
                </div>
              )}
              {tab === 'contracts' && (
                <div className="history-list">
                  <div className="section-title">
                    <h2>Утверждённые контракты</h2>
                    <button onClick={() => setModal('contract')}>
                      <Plus />
                      Контракт
                    </button>
                  </div>
                  <p>
                    Новая версия создаётся отдельным контрактом. Задачи закрепляют его содержимое
                    при утверждении.
                  </p>
                  {data.contracts.map((c) => (
                    <article key={c.id}>
                      <div>
                        <strong>{c.title}</strong>
                        <Badge value="done">{c.id}</Badge>
                      </div>
                      <pre>{c.content}</pre>
                      <small>
                        SHA-256 {c.digest.slice(0, 16)} · {stamp(c.approvedAt)}
                      </small>
                    </article>
                  ))}
                  {!data.contracts.length && (
                    <p>
                      Добавьте API, события или дизайн-контракт перед утверждением связанных задач.
                    </p>
                  )}
                </div>
              )}
            </section>
            {tab !== 'changesets' && tab !== 'product' && (
              <aside className="inspector" aria-label="Детали задачи">
                {task ? (
                  <>
                    <div className="inspector-top">
                      <span>{task.id}</span>
                      <Badge value={status(task)}>{taskStatusName(task)}</Badge>
                    </div>
                    <h2>{task.title}</h2>
                    <p>
                      Репозиторий: <code>{task.repositoryId}</code>
                    </p>
                    {task.assignee && (
                      <p>
                        Ответственный: <strong>{task.assignee}</strong>
                      </p>
                    )}
                    {task.sharedCompletion && (
                      <div>
                        <p>
                          Результат принят из Git: <code>{task.resultSha?.slice(0, 12)}</code>.
                          Проверки выполнены участником команды; локальная попытка не запускалась.
                        </p>
                        <details>
                          <summary>Свидетельство участника</summary>
                          <p>
                            {task.sharedCompletion.receipt.runtime} →{' '}
                            {task.sharedCompletion.receipt.reviewer}; Git{' '}
                            <code>{task.sharedCompletion.sourceCommit.slice(0, 12)}</code>
                          </p>
                          <ul>
                            {task.sharedCompletion.receipt.checks.map((check, index) => (
                              <li key={index}>
                                {check.phase} / {check.gate}: {check.passed ? 'PASS' : 'FAIL'} ·{' '}
                                <code>{check.sha.slice(0, 12)}</code>
                              </li>
                            ))}
                          </ul>
                        </details>
                      </div>
                    )}
                    <p className="task-description">{task.description}</p>
                    {!!task.progress?.reasons.length && (
                      <section className="task-next-step" aria-label="Что нужно для продолжения">
                        <h3>Что нужно для продолжения</h3>
                        <ul>
                          {task.progress.reasons.map((reason) => (
                            <li key={reason}>{waitingReasons[reason] ?? reason}</li>
                          ))}
                        </ul>
                      </section>
                    )}
                    {task.progress?.eligible && (
                      <p className="task-next-step">Задача доступна для выдачи исполнителю.</p>
                    )}
                    <dl>
                      <div>
                        <dt>Роль</dt>
                        <dd>{roleNames[task.role]}</dd>
                      </div>
                      <div>
                        <dt>Исполнитель</dt>
                        <dd>
                          {displayedWriter?.runtime}
                          {displayedWriter?.model && ` / ${displayedWriter.model}`}
                        </dd>
                      </div>
                      <div>
                        <dt>Ревью</dt>
                        <dd>
                          {displayedReviewer.runtime}
                          {displayedReviewer.model && ` / ${displayedReviewer.model}`}
                        </dd>
                      </div>
                      <div>
                        <dt>Попытки</dt>
                        <dd>{task.attempt}</dd>
                      </div>
                    </dl>
                    {task.supersedes && (
                      <p className="replacement">
                        Корректирует <strong>{task.supersedes}</strong>
                      </p>
                    )}
                    <h3>Критерии приёмки</h3>
                    <ul className="acceptance-list">
                      {task.acceptance.map((a, i) => (
                        <li key={i}>
                          <span className={task.status === 'done' ? 'checked' : ''}>
                            {task.status === 'done' ? <Check /> : i + 1}
                          </span>
                          {a}
                        </li>
                      ))}
                    </ul>
                    <h3>Зависимости</h3>
                    {task.dependsOn.length ? (
                      <div className="dependency-list">
                        {task.dependsOn.map((id) => {
                          const d = data.tasks.find((t) => t.id === id);
                          return (
                            <button
                              key={id}
                              onClick={() => {
                                if (tasks.some((t) => t.id === id)) setSelected(id);
                                else {
                                  const b = data.boards.find((b) =>
                                    b.revisions.at(-1)!.taskIds.includes(id),
                                  );
                                  if (b) {
                                    switchBoard(b.id);
                                    setSelected(id);
                                  }
                                }
                              }}
                            >
                              <span className={d?.status === 'done' ? 'dep-done' : 'dep-pending'}>
                                {d?.status === 'done' ? <Check /> : <Clock />}
                              </span>
                              <span>
                                {id}
                                <small>{d?.title}</small>
                              </span>
                              <ChevronRight />
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="muted">Можно начать независимо.</p>
                    )}
                    {task.contracts.length > 0 && (
                      <>
                        <h3>Контракты</h3>
                        <p className="muted">
                          {task.contracts.join(', ')}
                          {task.approvedDigest
                            ? ' · версии закреплены'
                            : ' · закрепятся при утверждении'}
                        </p>
                      </>
                    )}
                    <h3>Проверки и доказательства</h3>
                    {latestRun?.evidence.length ? (
                      <div className="evidence-list">
                        {latestRun.evidence.map((e) => (
                          <button
                            key={e.id}
                            onClick={() =>
                              void act(
                                async () => {
                                  const result = await api(`evidence/${e.id}`);
                                  setLog({
                                    title: `${e.gate} / ${e.phase}`,
                                    content: result.content,
                                  });
                                },
                                'Артефакт загружен',
                                false,
                              )
                            }
                          >
                            <span className={e.passed ? 'dep-done' : 'dep-error'}>
                              {e.passed ? <Check /> : <X />}
                            </span>
                            <span>
                              {e.kind === 'review' ? 'Независимое ревью' : e.gate}
                              <small>
                                {e.phase === 'integration' ? 'После интеграции' : 'Кандидат'} ·{' '}
                                {e.sha.slice(0, 7)}
                              </small>
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="muted">
                        {task.sharedCompletion
                          ? 'Свидетельство участника доступно выше. Логи хранятся в исходном контуре выполнения.'
                          : 'Появятся после запуска. Отсутствие отчёта не считается успехом.'}
                      </p>
                    )}
                    {task.resultSha && (
                      <p className="result-sha">
                        Принятый коммит <code>{task.resultSha.slice(0, 12)}</code>
                      </p>
                    )}
                    {task.failure && <p className="failure-detail">{task.failure}</p>}
                    <div className="task-actions">
                      {task.status === 'draft' && editable && (
                        <>
                          <button onClick={() => setModal('edit')}>Редактировать</button>
                          <button
                            disabled={busy}
                            onClick={() =>
                              void act(
                                () => api(`boards/${boardId}/approve`, { taskIds: [task.id] }),
                                'Задача утверждена',
                                false,
                              )
                            }
                          >
                            Утвердить задачу
                          </button>
                        </>
                      )}
                      {['failed', 'cancelled'].includes(task.status) && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act(
                              () => api(`tasks/${task.id}/retry`, {}),
                              'Новая попытка поставлена в очередь',
                              false,
                            )
                          }
                        >
                          <RotateCcw />
                          Повторить
                        </button>
                      )}
                      {!['done', 'cancelled'].includes(task.status) && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act(
                              () => api(`tasks/${task.id}/cancel`, {}),
                              'Задача отменена',
                              false,
                            )
                          }
                        >
                          Отменить задачу
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="empty">
                    <FileCheck />
                    <p>Выберите задачу, чтобы увидеть зависимости и результаты проверок.</p>
                  </div>
                )}
              </aside>
            )}
          </div>
          <footer className="workspace-footer">
            <span>
              <span className="dot active" /> SQLite · состояние сохранено локально
            </span>
            <span>
              {data.config.completionMode === 'remote'
                ? 'Приёмка ChangeSet = локальные проверки + merge + CI'
                : 'Приёмка = тесты + ревью + проверенная интеграция'}
            </span>
          </footer>
        </div>
      </main>
      {modal === 'changeset' && (
        <Modal error={error} title="Новый ChangeSet" onClose={() => setModal(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act(
                () =>
                  api('changesets', {
                    title: f.get('title'),
                    description: f.get('description'),
                    boardIds: f.getAll('boardIds'),
                    supersedes: f.get('supersedes') || undefined,
                    releaseId: f.get('releaseId') || undefined,
                  }),
                'ChangeSet создан',
              );
            }}
          >
            <label>
              Название
              <input name="title" required minLength={3} maxLength={180} />
            </label>
            <label>
              Ожидаемый результат продукта
              <textarea name="description" required minLength={10} maxLength={12000} />
            </label>
            <fieldset>
              <legend>Доски</legend>
              {data.boards.map((b) => (
                <label className="check-option" key={b.id}>
                  <input
                    type="checkbox"
                    name="boardIds"
                    value={b.id}
                    defaultChecked={b.id === boardId}
                  />
                  <span>{b.title}</span>
                </label>
              ))}
            </fieldset>
            <label>
              ID продуктового релиза (если принимаем релиз INTENT)
              <input name="releaseId" pattern="[A-Za-z0-9_-]{1,50}" placeholder="Например, mvp" />
            </label>
            <label>
              Продолжает принятый ChangeSet
              <select name="supersedes">
                <option value="">Новое изменение</option>
                {data.changeSets
                  .filter((c) => c.acceptance)
                  .map((c) => (
                    <option value={c.id} key={c.id}>
                      {c.id} · {c.title}
                    </option>
                  ))}
              </select>
            </label>
            <div className="form-actions">
              <button className="primary" disabled={busy}>
                Создать ChangeSet
              </button>
            </div>
          </form>
        </Modal>
      )}
      {modal === 'board' && (
        <Modal error={error} title="Новая доска" onClose={() => setModal(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act(async () => {
                const b = await api('boards', {
                  title: f.get('title'),
                  description: f.get('description'),
                });
                switchBoard(b.id);
              }, 'Доска создана');
            }}
          >
            <label>
              Название
              <input
                name="title"
                required
                minLength={3}
                maxLength={180}
                placeholder="Например, редизайн личного кабинета"
              />
            </label>
            <label>
              Цель
              <textarea name="description" rows={3} maxLength={5000} />
            </label>
            <div className="form-actions">
              <button type="button" onClick={() => setModal(null)}>
                Отмена
              </button>
              <button className="primary" disabled={busy}>
                Создать доску
              </button>
            </div>
          </form>
        </Modal>
      )}
      {(modal === 'task' || modal === 'edit') && board && (
        <Modal
          error={error}
          title={modal === 'edit' ? 'Редактировать черновик' : 'Новая задача'}
          onClose={() => setModal(null)}
        >
          <TaskForm
            data={data}
            task={modal === 'edit' ? task : undefined}
            busy={busy}
            onSubmit={(input) =>
              void act(
                () =>
                  modal === 'edit' && task
                    ? api(
                        `tasks/${task.id}`,
                        { ...input, expectedDigest: task.specDigest },
                        'PATCH',
                      )
                    : api(`boards/${boardId}/tasks`, input),
                'Задача сохранена',
              )
            }
          />
        </Modal>
      )}
      {modal === 'contract' && (
        <Modal error={error} title="Утвердить контракт" onClose={() => setModal(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act(
                () => api('contracts', { title: f.get('title'), content: f.get('content') }),
                'Контракт утверждён',
              );
            }}
          >
            <p className="muted">
              Подтверждая, вы фиксируете эту версию. Изменения оформляются новым контрактом.
            </p>
            <label>
              Название и версия
              <input name="title" required maxLength={180} />
            </label>
            <label>
              Содержимое
              <textarea name="content" required rows={10} maxLength={60000} />
            </label>
            <div className="form-actions">
              <button className="primary" disabled={busy}>
                Утвердить контракт
              </button>
            </div>
          </form>
        </Modal>
      )}
      {modal === 'correct' && (
        <Modal error={error} title="Корректировка принятой доски" onClose={() => setModal(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act(async () => {
                await api(`boards/${boardId}/correct`, { roots, reason: f.get('reason') });
                setRevisionNumber(null);
                setTab('graph');
              }, 'Создана новая ревизия. Проверьте и утвердите её задачи.');
            }}
          >
            <p>
              Прежние задачи и доказательства останутся в истории. Выберите результат, который нужно
              изменить.
            </p>
            <fieldset>
              <legend>Что требует изменения</legend>
              {tasks.map((t) => (
                <label className="check-option" key={t.id}>
                  <input
                    type="checkbox"
                    checked={roots.includes(t.id)}
                    onChange={(e) =>
                      setRoots(
                        e.target.checked ? [...roots, t.id] : roots.filter((id) => id !== t.id),
                      )
                    }
                  />
                  <span>
                    {t.id} · {t.title}
                  </span>
                </label>
              ))}
            </fieldset>
            {impact && (
              <div className="impact">
                <strong>Затронуто задач: {impact.taskIds.length}</strong>
                <p>Будут созданы черновики для выбранных задач и всех зависимых результатов.</p>
                <ul>
                  {impact.taskIds.map((id) => (
                    <li key={id}>
                      {id} · {data.tasks.find((t) => t.id === id)?.title}
                    </li>
                  ))}
                </ul>
                {impact.boards.length > 1 && (
                  <p>
                    Влияние выходит за одну доску: {impact.boards.map((b) => b.title).join(', ')}.
                    Новые проверки войдут в эту корректировку.
                  </p>
                )}
              </div>
            )}
            <label>
              Что и почему меняем
              <textarea
                name="reason"
                required
                minLength={10}
                maxLength={5000}
                rows={3}
                placeholder="Например, поиск должен учитывать архивные продукты…"
              />
            </label>
            <div className="form-actions">
              <button type="button" onClick={() => setModal(null)}>
                Отмена
              </button>
              <button className="primary" disabled={busy || !impact}>
                Создать ревизию {(revision?.number ?? 0) + 1}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {log && (
        <Modal error={error} title={log.title} onClose={() => setLog(undefined)}>
          <pre className="log-content">{log.content}</pre>
        </Modal>
      )}
    </div>
  );
}
function TaskForm({
  data,
  task,
  busy,
  onSubmit,
}: {
  data: Snapshot;
  task?: UITask;
  busy: boolean;
  onSubmit: (input: Record<string, unknown>) => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        onSubmit({
          title: f.get('title'),
          description: f.get('description'),
          role: f.get('role'),
          repositoryId: f.get('repositoryId'),
          acceptance: String(f.get('acceptance'))
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
          dependsOn: f.getAll('dependsOn'),
          contracts: f.getAll('contracts'),
        });
      }}
    >
      <label>
        Название
        <input name="title" defaultValue={task?.title} required minLength={3} maxLength={180} />
      </label>
      <label>
        Описание результата
        <textarea
          name="description"
          defaultValue={task?.description}
          required
          minLength={10}
          maxLength={12000}
          rows={3}
        />
      </label>
      <label>
        Репозиторий
        <select
          name="repositoryId"
          defaultValue={task?.repositoryId ?? data.config.repositories[0].id}
        >
          {data.config.repositories.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} · {r.kind}
            </option>
          ))}
        </select>
      </label>
      <label>
        Роль
        <select name="role" defaultValue={task?.role ?? 'backend'}>
          {Object.entries(roleNames).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Критерии приёмки, по одному на строку
        <textarea name="acceptance" defaultValue={task?.acceptance.join('\n')} required rows={3} />
      </label>
      <fieldset className="scroll-options">
        <legend>Зависит от задач</legend>
        {data.tasks
          .filter((t) => t.id !== task?.id && !data.tasks.some((x) => x.supersedes === t.id))
          .map((t) => (
            <label className="check-option" key={t.id}>
              <input
                name="dependsOn"
                type="checkbox"
                value={t.id}
                defaultChecked={task?.dependsOn.includes(t.id)}
              />
              <span>
                {t.id} · {t.title}
              </span>
            </label>
          ))}
        {data.tasks.length === 0 && <p>Пока нет других задач.</p>}
      </fieldset>
      {data.contracts.length > 0 && (
        <fieldset className="scroll-options">
          <legend>Контракты</legend>
          {data.contracts.map((c) => (
            <label className="check-option" key={c.id}>
              <input
                type="checkbox"
                name="contracts"
                value={c.id}
                defaultChecked={task?.contracts.includes(c.id)}
              />
              <span>
                {c.id} · {c.title}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="form-actions">
        <button className="primary" disabled={busy}>
          Сохранить черновик
        </button>
      </div>
    </form>
  );
}
