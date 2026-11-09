import { useEffect, useRef, useState } from 'react';
import { Check, CircleDashed, CircleDot, Copy, OctagonAlert, UserRound } from 'lucide-react';
import { Alert, AlertDescription } from '@/ui/alert.tsx';
import { Badge } from '@/ui/badge.tsx';
import { Button } from '@/ui/button.tsx';
import { Input } from '@/ui/input.tsx';
import { Label } from '@/ui/label.tsx';
import { Textarea } from '@/ui/textarea.tsx';
import { cn } from '@/lib/utils.ts';
import type { AssumptionLine } from '../application/assumptions.ts';
import { WriterDecisions } from './WriterDecisions.tsx';

// Заголовок предупреждения — абзац, а не h5 AlertTitle: внутри раздела с h2
// пропуск уровней ломает порядок заголовков для читалок экрана.
// Быстрый маршрут: одно существующее npm/pnpm-репозиторий, короткое поручение
// и наблюдаемый результат. Экран — проекция `GET /api/preparation/quick`:
// своих статусов он не хранит и ничего не утверждает сам. Решения остаются
// отдельными согласованиями этапов ниже.

type StepState = 'done' | 'current' | 'waiting' | 'blocked';
interface QuickStep {
  id: 'connection' | 'decisions' | 'preparation' | 'execution' | 'result';
  title: string;
  state: StepState;
  actor?: 'operator' | 'lead';
  detail: string;
  action?: 'start-queue';
}
interface Diagnostic {
  code: string;
  severity: 'blocker' | 'warning' | 'info';
  message: string;
  action: string;
  path?: string;
}
interface Facts {
  facts: {
    git: {
      root: string | null;
      baseSha: string | null;
      branch: string | null;
      dirty: boolean | null;
      changes: string[];
    };
    lockfiles: string[];
    packageManager: { status: string; name?: string; lockfile?: string };
    scripts: { name: string; command: string }[];
    checks: string[];
    tools: { name: string; status: string; version?: string; required?: { version: string } }[];
    runtimes: { runtime: string; status: string; version?: string; auth: 'unknown' }[];
  };
  diagnostics: Diagnostic[];
  profiles: { id: string; version: string; digest: string }[];
  ready: boolean;
}
interface Gate {
  id?: string;
  kind?: string;
  command?: string[];
  dependsOn?: string[];
}
interface CheckEntry {
  gate: string;
  kind: 'test' | 'review';
  passed: boolean;
  sha: string;
  summary: string;
}
interface QuickResult {
  taskId: string;
  title: string;
  status: string;
  /** Ревизия доски, в которой задача появилась: этап изменения. */
  revision?: number | null;
  boardId: string | null;
  resultSha: string | null;
  attempts: number;
  /** Задачу держит вопрос исполнителя: ожидание ответа, а не сбой попытки. */
  waitingInput?: boolean;
  run: {
    id: string;
    status: string;
    baseSha: string | null;
    candidateSha: string | null;
    integrationSha: string | null;
    candidate: CheckEntry[];
    integration: CheckEntry[];
    /** Решения исполнителя ниже порога вопросов; у ответов прежних версий поля нет. */
    assumptions?: AssumptionLine[];
  } | null;
  usage: {
    calls: number;
    costUsd: number | null;
    knownCostUsd: number;
    complete: boolean;
    unknownCalls: number;
  };
  board: { id: string; title: string; state: 'active' | 'accepted' | null } | null;
  changeSet: { id: string; title: string; accepted: boolean } | null;
  next: string | null;
  diff: {
    count: number;
    added: number;
    removed: number;
    files: { path: string; added: number | null; removed: number | null }[];
  } | null;
}
export interface QuickView {
  changeId: string;
  title: string;
  intake: { repository: string; brief: string; criterion: string; actor: 'operator' | 'lead' };
  setup?: { number: number; profile: string; gates?: Gate[]; reason: string; digest: string };
  expanded?: { at: string; reason: string };
  findings: { taskId: string; title: string; status: string }[];
  setupApplied: boolean;
  facts?: Facts;
  factsError?: string;
  plan?: {
    proposal: string;
    files: PlanFile[];
    refusal?: string;
    /** Проверки, которые будут действовать после setup. */
    gates?: { id: string; kind?: string; command?: string[] }[];
    /** Файл компонента: сохранённый закоммиченный файл действует вместо предложения. */
    component?: { path: string; action: 'create' | 'preserve'; precedence: boolean; note?: string };
    /** Сеть песочницы, которую setup открывает: домены реестра пакетов. */
    isolation?: { domains: string[]; skipped?: string[]; note?: string };
    /** Профили инструментов, которые setup создаёт для ролей файла компонента. */
    toolProfiles?: Record<string, { runtime: string }>;
    /** Срок фазы попытки (`runTimeoutMs`), который setup запишет, и почему. */
    runTimeout?: { ms: number; source: string; gatesMs: number; reason: string };
  };
  steps: QuickStep[];
  lead: { lastActivityAt: string | null; present: boolean };
  result: QuickResult[];
}

async function send<T>(path: string, value?: unknown): Promise<T> {
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
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? 'Сервер ответил ошибкой ' + response.status);
  return data;
}

const stateNames: Record<StepState, string> = {
  done: 'Готово',
  current: 'Сейчас',
  waiting: 'Ждёт',
  blocked: 'Остановлено',
};
const stateTone: Record<StepState, 'success' | 'ready' | 'waiting' | 'destructive'> = {
  done: 'success',
  current: 'ready',
  waiting: 'waiting',
  blocked: 'destructive',
};
const actorNames = { operator: 'Действуете вы', lead: 'Действует ведущий агент' } as const;
const severityNames = { blocker: 'Блокирует', warning: 'Требует внимания', info: 'Сведения' };
const fileActions = {
  create: { label: 'создастся', tone: 'ready' },
  preserve: { label: 'сохранится', tone: 'secondary' },
  conflict: { label: 'конфликт', tone: 'destructive' },
} as const;
const taskStatusNames: Record<string, string> = {
  draft: 'Черновик задачи',
  ready: 'Ждёт исполнителя',
  running: 'Исполнитель пишет код',
  verifying: 'Идут проверки',
  reviewing: 'На независимом ревью',
  integrating: 'Интеграция',
  done: 'Задача принята',
  failed: 'Попытка не прошла',
  cancelled: 'Отменена',
};
// Конфликты и сохраняемые файлы человека — первыми: их проверяют глазами,
// созданные из шаблона идут ниже.
const fileOrder = { conflict: 0, preserve: 1, create: 2 } as const;
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 12) : '—');
const relative = (path: string, root: string | null | undefined) =>
  root && path.startsWith(root + '/') ? path.slice(root.length + 1) : path;

/** Поле факта: подпись и значение в одну строку определений. */
function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-muted-foreground text-sm">{term}</dt>
      <dd className="min-w-0 text-left break-words">{children}</dd>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t pt-4">
      <h3 className="text-md mb-3 font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Connection({ facts, error }: { facts?: Facts; error?: string }) {
  if (!facts && error)
    return (
      <Alert variant="destructive">
        <p className="mb-1 leading-none font-medium">Репозиторий не удалось проверить</p>
        <AlertDescription className="break-words">{error}</AlertDescription>
      </Alert>
    );
  if (!facts)
    return (
      <p className="text-muted-foreground" role="status">
        Факты репозитория пока не получены: путь недоступен или проверка ещё идёт.
      </p>
    );
  const f = facts.facts;
  const groups = (['blocker', 'warning', 'info'] as const)
    .map((severity) => ({
      severity,
      items: facts.diagnostics.filter((d) => d.severity === severity),
    }))
    .filter((g) => g.items.length > 0);
  return (
    <div className="grid gap-4">
      <dl className="grid gap-2" aria-label="Факты репозитория">
        <Fact term="Корень Git">
          <code className="font-mono text-xs break-all">{f.git.root ?? 'не найден'}</code>
        </Fact>
        <Fact term="Ветка и base SHA">
          <code className="font-mono text-xs">
            {f.git.branch ?? 'без ветки'} · {short(f.git.baseSha)}
          </code>
          {f.git.dirty ? (
            <span className="text-muted-foreground ml-2 text-sm">
              есть незакоммиченные изменения
            </span>
          ) : null}
        </Fact>
        <Fact term="Менеджер пакетов">
          {f.packageManager.name ?? 'не определён'}
          {f.lockfiles.length > 0 && (
            <span className="text-muted-foreground text-sm">
              {' '}
              · lockfile: {f.lockfiles.join(', ')}
            </span>
          )}
        </Fact>
        <Fact term="Проверки проекта">
          {f.checks.length ? (
            <ul className="grid gap-1">
              {f.checks.map((name) => (
                <li key={name}>
                  <code className="font-mono text-xs break-all">
                    {name}: {f.scripts.find((s) => s.name === name)?.command ?? ''}
                  </code>
                </li>
              ))}
            </ul>
          ) : (
            'scripts проверок не найдены'
          )}
        </Fact>
        <Fact term="Профиль DevContour">
          {facts.profiles.length
            ? facts.profiles.map((p) => (
                <code key={p.id} className="font-mono text-xs">
                  {p.id}@{p.version} · {p.digest.slice(0, 12)}
                </code>
              ))
            : 'не определён'}
        </Fact>
        <Fact term="Инструменты">
          <ul className="grid gap-1">
            {f.tools.map((t) => (
              <li key={t.name}>
                {t.name} {t.version ?? ''}{' '}
                <span className="text-muted-foreground text-sm">
                  {t.status === 'ok'
                    ? 'найден'
                    : t.status === 'missing'
                      ? 'не найден'
                      : t.status === 'mismatch'
                        ? 'версия не совпадает' + (t.required ? ' с ' + t.required.version : '')
                        : 'версию не удалось прочитать'}
                </span>
              </li>
            ))}
          </ul>
        </Fact>
        <Fact term="Агентские CLI">
          <ul className="grid gap-1">
            {f.runtimes.map((r) => (
              <li key={r.runtime}>
                {r.runtime} {r.version ?? ''}{' '}
                <span className="text-muted-foreground text-sm">
                  {r.status === 'available'
                    ? 'установлен, вход не проверялся'
                    : r.status === 'missing'
                      ? 'не найден'
                      : 'версию не удалось прочитать'}
                </span>
              </li>
            ))}
          </ul>
        </Fact>
      </dl>
      {groups.length === 0 ? (
        <p className="text-muted-foreground text-sm">Замечаний к репозиторию нет.</p>
      ) : (
        groups.map((g) => (
          <div key={g.severity}>
            <h4 className="mb-2 text-sm font-semibold">
              {severityNames[g.severity]} ({g.items.length})
            </h4>
            <ul className="grid gap-2">
              {g.items.map((d, i) => (
                <li
                  key={d.code + i}
                  className={cn(
                    'border-l-[3px] p-3',
                    g.severity === 'blocker'
                      ? 'border-destructive bg-destructive-foreground'
                      : g.severity === 'warning'
                        ? 'border-warning bg-warning-foreground'
                        : 'border-border bg-secondary',
                  )}
                >
                  <p className="break-words">{d.message}</p>
                  <p className="text-muted-foreground mt-1 text-sm break-words">
                    Что сделать: {d.action}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}

function Preparation({ view }: { view: QuickView }) {
  const { setup, plan } = view;
  const root = view.facts?.facts.git.root ?? view.intake.repository;
  if (!setup)
    return (
      <p className="text-muted-foreground max-w-[78ch]">
        Ведущий агент ещё не предложил профиль и проверки проекта. Пока предложения нет, в
        репозиторий ничего не записывается.
      </p>
    );
  return (
    <div className="grid gap-4">
      <Alert variant="info">
        <AlertDescription>
          {view.setupApplied
            ? 'Setup применён: файлы записаны по этому предложению. Дальше ведущий агент делает bootstrap-коммит и ставит задачу.'
            : 'Это план, а не выполненная настройка: файлы не записаны. Их создаст ведущий агент, когда запустит setup по этому предложению после ваших решений.'}
        </AlertDescription>
      </Alert>
      <dl className="grid gap-2" aria-label="Предложение setup">
        <Fact term="Предложение">
          Версия {setup.number}{' '}
          <code className="text-muted-foreground font-mono text-xs">
            {setup.digest.slice(0, 12)}
          </code>
        </Fact>
        <Fact term="Профиль">
          <code className="font-mono text-xs">{setup.profile}</code>
        </Fact>
        <Fact term="Почему так">
          <span className="whitespace-pre-wrap">{setup.reason}</span>
        </Fact>
        <Fact term={plan?.component?.precedence ? 'Проверки в предложении' : 'Проверки'}>
          {setup.gates?.length ? (
            <ul className="grid gap-1">
              {setup.gates.map((g, i) => (
                <li key={(g.id ?? '') + i}>
                  <strong className="font-medium">{g.id}</strong>{' '}
                  <span className="text-muted-foreground text-sm">{g.kind}</span>{' '}
                  {g.command && (
                    <code className="font-mono text-xs break-all">{g.command.join(' ')}</code>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            'проверки профиля по умолчанию'
          )}
        </Fact>
        {plan?.component?.precedence && (
          <Fact term="Действующие проверки">
            {plan.gates?.length ? (
              <ul className="grid gap-1" aria-label="Действующие проверки">
                {plan.gates.map((g, i) => (
                  <li key={g.id + i}>
                    <strong className="font-medium">{g.id}</strong>{' '}
                    {g.kind && <span className="text-muted-foreground text-sm">{g.kind}</span>}{' '}
                    {g.command && (
                      <code className="font-mono text-xs break-all">{g.command.join(' ')}</code>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              'файл компонента не объявляет проверок'
            )}
          </Fact>
        )}
        {plan?.isolation && (
          <Fact term="Сеть песочницы">
            {plan.isolation.domains.length ? (
              <span className="font-mono text-xs break-all">
                {plan.isolation.domains.join(', ')}
              </span>
            ) : (
              'внешняя сеть закрыта'
            )}
            {plan.isolation.note && (
              <span className="text-muted-foreground block text-sm">{plan.isolation.note}</span>
            )}
          </Fact>
        )}
        {plan?.runTimeout && (
          <Fact term="Срок фазы попытки">
            <span data-run-timeout={plan.runTimeout.ms}>
              {Math.round(plan.runTimeout.ms / 60_000)} мин{' '}
              <code className="font-mono text-xs">runTimeoutMs: {plan.runTimeout.ms}</code>
            </span>
            <span className="text-muted-foreground block text-sm">{plan.runTimeout.reason}</span>
          </Fact>
        )}
        {plan?.toolProfiles && Object.keys(plan.toolProfiles).length > 0 && (
          <Fact term="Профили инструментов">
            <span className="font-mono text-xs break-all">
              {Object.entries(plan.toolProfiles)
                .map(([name, p]) => `${name} (${p.runtime})`)
                .join(', ')}
            </span>
          </Fact>
        )}
      </dl>
      {plan?.component?.precedence && (
        <Alert variant="warning">
          <p className="mb-1 leading-none font-medium">Действует файл компонента репозитория</p>
          <AlertDescription className="break-words">{plan.component.note}</AlertDescription>
        </Alert>
      )}
      {plan?.refusal && (
        <Alert variant="destructive">
          <p className="mb-1 leading-none font-medium">Setup по этому плану будет отклонён</p>
          <AlertDescription className="break-words">{plan.refusal}</AlertDescription>
        </Alert>
      )}
      {plan && plan.files.length > 0 && (
        <div className="overflow-x-auto">
          <p className="mb-2 text-sm">
            Создастся: {plan.files.filter((f) => f.action === 'create').length} · сохранится без
            изменений: {plan.files.filter((f) => f.action === 'preserve').length} · конфликтов:{' '}
            {plan.files.filter((f) => f.action === 'conflict').length}
          </p>
          {/* Сохраняемые файлы и конфликты решают, можно ли применять план, —
              они видны сразу; новые файлы setup раскрываются по запросу. */}
          <FileTable
            label="План файлов setup"
            files={plan.files.filter((f) => f.action !== 'create')}
            root={root}
          />
          {plan.files.some((f) => f.action === 'create') && (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm font-medium">
                Новые файлы ({plan.files.filter((f) => f.action === 'create').length})
              </summary>
              <FileTable
                label="Новые файлы setup"
                files={plan.files.filter((f) => f.action === 'create')}
                root={root}
              />
            </details>
          )}
        </div>
      )}
      {!plan && (
        <p className="text-muted-foreground text-sm">
          План файлов показывается до применения setup; после него репозиторий уже настроен.
        </p>
      )}
    </div>
  );
}

function Checks({ label, entries }: { label: string; entries: CheckEntry[] }) {
  if (!entries.length)
    return <p className="text-muted-foreground text-sm">{label}: записей ещё нет.</p>;
  return (
    <div>
      <h4 className="mb-1 text-sm font-semibold">{label}</h4>
      <ul className="grid gap-1 text-sm">
        {entries.map((e, i) => (
          <li key={e.gate + i} className="flex flex-wrap items-baseline gap-2">
            <Badge variant={e.passed ? 'success' : 'destructive'}>
              {e.passed ? 'прошла' : 'не прошла'}
            </Badge>
            <span>{e.kind === 'review' ? 'Ревью' : 'Проверка'}</span>
            <code className="font-mono text-xs">{e.gate}</code>
            <code className="text-muted-foreground font-mono text-xs">{short(e.sha)}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TaskStatus({ task }: { task: QuickResult }) {
  return (
    <Badge
      variant={
        task.status === 'done'
          ? 'success'
          : task.waitingInput
            ? 'waiting'
            : task.status === 'failed'
              ? 'destructive'
              : 'ready'
      }
    >
      {task.waitingInput ? 'Ждёт ответа на вопрос' : (taskStatusNames[task.status] ?? task.status)}
    </Badge>
  );
}

/**
 * Все задачи изменения одним списком со статусом каждой: следующий этап
 * принятой доски добавляет задачи, и без сводки вторая терялась под
 * подробной карточкой первой.
 */
function TaskSummary({ tasks }: { tasks: QuickResult[] }) {
  const live = tasks.filter((t) => t.status !== 'cancelled');
  const done = live.filter((t) => t.status === 'done').length;
  return (
    <div className="grid gap-2">
      <p className="text-sm">
        Задачи изменения: принято {done} из {live.length}
        {live.length < tasks.length ? `, отменено ${tasks.length - live.length}` : ''}
      </p>
      <ol aria-label="Задачи изменения" className="grid list-none gap-1 p-0 text-sm">
        {tasks.map((task) => (
          <li key={task.taskId} className="flex flex-wrap items-baseline gap-2">
            <TaskStatus task={task} />
            {task.revision ? (
              <span className="text-muted-foreground">Этап {task.revision}</span>
            ) : null}
            <span className="break-words">{task.title}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Result({ view }: { view: QuickView }) {
  if (!view.result.length)
    return (
      <p className="text-muted-foreground">
        Задачи ещё нет: её поставит ведущий агент после setup. Здесь появятся статус, SHA, проверки,
        ревью и расход.
      </p>
    );
  return (
    <div className="grid gap-4">
      {view.result.length > 1 && <TaskSummary tasks={view.result} />}
      <ul className="grid gap-4">
        {view.result.map((task) => {
          const params = new URLSearchParams({
            change: view.changeId,
            view: 'boards',
            tab: 'kanban',
            task: task.taskId,
          });
          if (task.boardId) params.set('board', task.boardId);
          const u = task.usage;
          return (
            <li key={task.taskId} className="bg-secondary grid gap-3 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <strong className="break-words">{task.title}</strong>
                <TaskStatus task={task} />
              </div>
              <dl className="grid gap-2">
                <Fact term="Попыток">{task.attempts}</Fact>
                {task.run && (
                  <>
                    <Fact term="Base SHA">
                      <code className="font-mono text-xs">{short(task.run.baseSha)}</code>
                    </Fact>
                    <Fact term="Candidate SHA">
                      <code className="font-mono text-xs">{short(task.run.candidateSha)}</code>
                    </Fact>
                    <Fact term="Integration SHA">
                      <code className="font-mono text-xs">{short(task.run.integrationSha)}</code>
                    </Fact>
                  </>
                )}
                <Fact term="Расход">
                  {u.calls === 0
                    ? 'вызовов не было'
                    : u.complete
                      ? `$${(u.costUsd ?? u.knownCostUsd).toFixed(2)} за ${u.calls} вызов(ов)`
                      : `известно $${u.knownCostUsd.toFixed(2)}, неизвестно ${u.unknownCalls} вызов(ов)`}
                </Fact>
              </dl>
              {task.diff && task.diff.count > 0 && (
                <details>
                  <summary className="cursor-pointer text-sm font-medium">
                    Изменение: {task.diff.count} файл(ов), +{task.diff.added} / −{task.diff.removed}
                  </summary>
                  <ul className="mt-2 grid gap-1 text-sm">
                    {task.diff.files.map((f) => (
                      <li key={f.path} className="flex flex-wrap gap-x-3">
                        <code className="font-mono text-xs break-all">{f.path}</code>
                        <span className="text-muted-foreground text-xs">
                          {f.added === null ? 'двоичный' : `+${f.added} −${f.removed}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {(task.board || task.changeSet || task.next) && (
                <dl className="grid gap-2">
                  {task.board && (
                    <Fact term="Доска">
                      {task.board.title}:{' '}
                      {task.board.state === 'accepted' ? 'принята' : 'не принята'}
                    </Fact>
                  )}
                  {task.changeSet && (
                    <Fact term="ChangeSet">
                      {task.changeSet.title}: {task.changeSet.accepted ? 'принят' : 'не принят'}
                    </Fact>
                  )}
                  {task.next && <Fact term="Следующий шаг">{task.next}</Fact>}
                </dl>
              )}
              {task.run && (
                <div className="grid gap-3">
                  <Checks label="Candidate: проверки и ревью" entries={task.run.candidate} />
                  <Checks label="Integration: проверки и ревью" entries={task.run.integration} />
                  <WriterDecisions items={task.run.assumptions} />
                </div>
              )}
              <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <a className="text-info underline" href={'/?' + params.toString()}>
                  Карточка задачи и доказательства
                </a>
                <a
                  className="text-info underline"
                  href="/api/report?format=html"
                  target="_blank"
                  rel="noreferrer"
                >
                  Отчёт workspace
                </a>
              </p>
            </li>
          );
        })}
      </ul>
      <p className="text-muted-foreground max-w-[78ch] text-sm">
        «Задача принята» значит, что задача прошла проверки и независимое ревью в двух фазах. Это не
        приёмка доски или ChangeSet, не публикация и не готовность всего продукта.
      </p>
    </div>
  );
}

/** Поручение ведущему агенту, когда его нет: человек копирует его в Claude Code. */
function LeadMissing({ view, workspace }: { view: QuickView; workspace?: string }) {
  const [copied, setCopied] = useState('');
  const text =
    `Продолжи быстрое изменение «${view.title}» (${view.changeId}) в workspace ${workspace ?? '<путь workspace>'}: ` +
    `прочитай START.md, раздел «Быстрое изменение существующего репозитория», ` +
    `выполни quick-facts для репозитория ${view.intake.repository}, подготовь компактные продукт, ` +
    `архитектуру и референсы мне на утверждение в панели, предложи setup операцией preparation_setup ` +
    `и дальше веди изменение по шагам START.md.`;
  return (
    <Alert variant="warning" className="grid gap-3">
      <p className="mb-1 flex items-center gap-2 leading-none font-medium">
        <UserRound className="size-4" aria-hidden="true" />
        Нужен ведущий агент
      </p>
      <AlertDescription className="grid gap-3">
        <span>
          Следующий шаг выполняет ведущий агент, а он давно не писал в журнал. Сам по себе маршрут
          не продвинется: откройте Claude Code и передайте ему поручение.
        </span>
        <Label htmlFor={'lead-instruction-' + view.changeId}>Поручение ведущему агенту</Label>
        <Textarea
          id={'lead-instruction-' + view.changeId}
          readOnly
          rows={5}
          value={text}
          className="font-mono text-xs"
          onFocus={(e) => e.currentTarget.select()}
        />
        <span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              void navigator.clipboard
                ?.writeText(text)
                .then(() => setCopied('Скопировано'))
                .catch(() => setCopied('Не удалось скопировать — выделите текст вручную'))
            }
          >
            <Copy aria-hidden="true" />
            Скопировать поручение
          </Button>
          <span role="status" className="ml-3 text-sm">
            {copied}
          </span>
        </span>
      </AlertDescription>
    </Alert>
  );
}

function StepIcon({ state }: { state: StepState }) {
  if (state === 'done') return <Check className="text-success size-4" aria-hidden="true" />;
  if (state === 'blocked')
    return <OctagonAlert className="text-destructive size-4" aria-hidden="true" />;
  if (state === 'current') return <CircleDot className="text-info size-4" aria-hidden="true" />;
  return <CircleDashed className="text-muted-foreground size-4" aria-hidden="true" />;
}

export function QuickRoute({ changeId, workspace }: { changeId: string; workspace?: string }) {
  const [view, setView] = useState<QuickView>();
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const next = await send<QuickView>(
          'preparation/quick?change=' + encodeURIComponent(changeId),
        );
        if (!disposed) {
          setView(next);
          setError('');
        }
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    const visible = () => void refresh();
    document.addEventListener('visibilitychange', visible);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [changeId]);
  const current = view?.steps.find((s) => s.state === 'current' || s.state === 'blocked');
  return (
    <section aria-label="Быстрое изменение" className="mb-8 grid gap-6 border-b pb-8">
      <header className="grid gap-2">
        <span className="text-primary text-sm font-semibold">Быстрое изменение</span>
        <h2 className="text-lg font-semibold break-words">{view?.title ?? 'Загрузка…'}</h2>
        {view && (
          <dl className="grid gap-2">
            <Fact term="Поручение">
              <span className="whitespace-pre-wrap">{view.intake.brief}</span>
            </Fact>
            <Fact term="Наблюдаемый результат">
              <span className="whitespace-pre-wrap">{view.intake.criterion}</span>
            </Fact>
            <Fact term="Репозиторий">
              <code className="font-mono text-xs break-all">{view.intake.repository}</code>
            </Fact>
          </dl>
        )}
      </header>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>Состояние быстрого изменения недоступно: {error}</AlertDescription>
        </Alert>
      )}
      {view?.expanded && (
        <Alert variant="info">
          <p className="mb-1 leading-none font-medium">Изменение продолжается полным маршрутом</p>
          <AlertDescription className="break-words">
            {view.expanded.reason}. Введённые поручение, критерий и предложения setup сохранены;
            дальше работайте с этапами ниже.
          </AlertDescription>
        </Alert>
      )}
      {view && (
        <ol
          aria-label="Шаги быстрого изменения"
          className="grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-5"
        >
          {view.steps.map((step, i) => (
            <li
              key={step.id}
              aria-current={step === current ? 'step' : undefined}
              className={cn(
                'grid min-w-0 content-start gap-2 rounded-sm border p-3',
                step === current && 'border-primary bg-accent',
              )}
            >
              <span className="flex items-center gap-2">
                <StepIcon state={step.state} />
                <span className="text-muted-foreground text-sm">{i + 1}</span>
                <strong>{step.title}</strong>
              </span>
              <Badge variant={stateTone[step.state]} className="justify-self-start">
                {stateNames[step.state]}
              </Badge>
              {step.actor && step.state !== 'done' && (
                <span className="text-sm font-medium">{actorNames[step.actor]}</span>
              )}
              <span className="text-muted-foreground text-sm [overflow-wrap:anywhere]">
                {step.detail}
              </span>
              {step.action === 'start-queue' && <StartQueue />}
            </li>
          ))}
        </ol>
      )}
      {view && !view.lead.present && current?.actor === 'lead' && !view.expanded && (
        <LeadMissing view={view} workspace={workspace} />
      )}
      {view && (
        <>
          <Block title="1. Подключение">
            <Connection facts={view.facts} error={view.factsError} />
          </Block>
          <Block title="2. Решения">
            <p className="max-w-[78ch]">
              Продуктовую часть, архитектуру и применимость дизайна вы утверждаете отдельно — в
              этапах ниже, как в полном маршруте. Здесь кнопок утверждения нет.
            </p>
          </Block>
          <Block title="3. Подготовка">
            <Preparation view={view} />
          </Block>
          <Block title="4–5. Выполнение и результат">
            <Result view={view} />
            {view.findings.length > 0 && (
              <p className="text-muted-foreground mt-3 text-sm">
                Находки исполнителя (отдельная работа, не часть этого изменения):{' '}
                {view.findings.map((f) => f.title).join('; ')}
              </p>
            )}
          </Block>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Форма поручения. Ключ запроса создаётся при первой отправке и живёт, пока
// текст не меняется: повтор, двойной щелчок и перезагрузка после сбоя
// отправляют тот же ключ, и сервер вернёт то же изменение. Правка текста —
// это другое поручение и другой ключ.

const draftKey = 'devcontour.quick-draft';
interface Draft {
  repository: string;
  brief: string;
  criterion: string;
  title: string;
  requestKey: string;
}
const emptyDraft: Draft = { repository: '', brief: '', criterion: '', title: '', requestKey: '' };
function loadDraft(): Draft | undefined {
  try {
    const raw = window.sessionStorage.getItem(draftKey);
    return raw ? { ...emptyDraft, ...(JSON.parse(raw) as Partial<Draft>) } : undefined;
  } catch {
    return undefined;
  }
}
function saveDraft(draft: Draft | undefined) {
  try {
    if (draft) window.sessionStorage.setItem(draftKey, JSON.stringify(draft));
    else window.sessionStorage.removeItem(draftKey);
  } catch {
    // Хранилище недоступно (приватное окно): форма работает и без него.
  }
}
const newKey = () =>
  'q' +
  (typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replaceAll('-', '')
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join(''));
/** Название из первой строки поручения: 3..180 символов, по границе слова. */
export function titleFrom(brief: string) {
  const line = brief.trim().split('\n')[0].replace(/\s+/g, ' ').trim();
  if (line.length <= 80) return line.length >= 3 ? line : 'Быстрое изменение: ' + line;
  const cut = line.slice(0, 80);
  const space = cut.lastIndexOf(' ');
  return (space > 40 ? cut.slice(0, space) : cut) + '…';
}

export function QuickForm({
  workspace,
  onCreated,
}: {
  workspace?: { mode: 'embedded' | 'separate'; path: string };
  onCreated: (changeId: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => loadDraft() ?? emptyDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  // Embedded workspace — корень репозитория: подставляем его, пока человек
  // не ввёл своё.
  useEffect(() => {
    if (workspace?.mode === 'embedded')
      setDraft((d) => (d.repository ? d : { ...d, repository: workspace.path }));
  }, [workspace?.mode, workspace?.path]);
  const edit = (field: Exclude<keyof Draft, 'requestKey'>, value: string) => {
    const next = { ...draft, [field]: value, requestKey: '' };
    setDraft(next);
    saveDraft(next);
  };
  const submit = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const requestKey = draft.requestKey || newKey();
    const pending = { ...draft, requestKey };
    setDraft(pending);
    saveDraft(pending);
    setBusy(true);
    setError('');
    try {
      const title = draft.title.trim() || titleFrom(draft.brief);
      const next = await send<{ enabled: boolean; activeChangeId?: string; changeId?: string }>(
        'preparation/quick',
        {
          requestKey,
          title,
          repository: draft.repository.trim(),
          brief: draft.brief.trim(),
          criterion: draft.criterion.trim(),
        },
      );
      saveDraft(undefined);
      setDraft({ ...emptyDraft, repository: workspace?.mode === 'embedded' ? workspace.path : '' });
      if (next.changeId) onCreated(next.changeId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <form
      className="mt-8 grid gap-3 border-t pt-6"
      aria-labelledby="quick-form-title"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2 id="quick-form-title" className="text-md font-semibold">
        Быстрое изменение
      </h2>
      <p className="text-muted-foreground text-sm">
        Небольшая правка одного существующего npm- или pnpm-репозитория. Решения вы всё равно
        утверждаете сами.
      </p>
      <Label htmlFor="quick-repository">Репозиторий (абсолютный путь)</Label>
      <Input
        id="quick-repository"
        value={draft.repository}
        onChange={(e) => edit('repository', e.target.value)}
        pattern="/.*"
        title="Абсолютный путь, начинается с /"
        placeholder="/home/me/projects/app"
        required
        className="font-mono text-xs"
      />
      <Label htmlFor="quick-brief">Что изменить</Label>
      <Textarea
        id="quick-brief"
        value={draft.brief}
        onChange={(e) => edit('brief', e.target.value)}
        minLength={10}
        maxLength={4000}
        rows={4}
        required
        placeholder={
          'Например:\n• add() должна правильно складывать отрицательные числа\n• кнопка «Сохранить» неактивна, пока форма пуста\n• в README описан запуск тестов'
        }
      />
      <Label htmlFor="quick-criterion">Как проверить результат</Label>
      <Textarea
        id="quick-criterion"
        value={draft.criterion}
        onChange={(e) => edit('criterion', e.target.value)}
        minLength={5}
        maxLength={1000}
        rows={2}
        required
        placeholder="Например: add(-2, -3) возвращает -5"
      />
      <Label htmlFor="quick-title">Название (необязательно)</Label>
      <Input
        id="quick-title"
        value={draft.title}
        onChange={(e) => edit('title', e.target.value)}
        minLength={3}
        maxLength={180}
        placeholder="Возьмём из первой строки поручения"
      />
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="break-words">
            {error}. Текст формы сохранён: исправьте его или отправьте ещё раз.
          </AlertDescription>
        </Alert>
      )}
      <Button disabled={busy} type="submit" variant="outline">
        {busy ? 'Отправляем…' : 'Начать быстрое изменение'}
      </Button>
    </form>
  );
}

type PlanFile = { path: string; action: 'create' | 'preserve' | 'conflict'; conflict?: string };

function FileTable(props: { label: string; files: PlanFile[]; root: string }) {
  if (!props.files.length) return null;
  return (
    <table className="w-full text-left text-sm" aria-label={props.label}>
      <thead>
        <tr className="border-b">
          <th scope="col" className="py-2 pr-3 font-semibold">
            Файл
          </th>
          <th scope="col" className="py-2 pr-3 font-semibold">
            Что будет
          </th>
        </tr>
      </thead>
      <tbody>
        {[...props.files]
          .sort((x, y) => fileOrder[x.action] - fileOrder[y.action])
          .map((file) => (
            <tr key={file.path} className="border-b">
              <td className="py-2 pr-3 align-top">
                <code className="font-mono text-xs break-all">
                  {relative(file.path, props.root)}
                </code>
              </td>
              <td className="py-2 pr-3 align-top">
                <Badge variant={fileActions[file.action].tone}>
                  {fileActions[file.action].label}
                </Badge>
                {file.conflict && (
                  <span className="text-muted-foreground ml-2 text-xs">{file.conflict}</span>
                )}
              </td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}

/** Решение оператора из шага: штатный запуск очереди (тот же, что в панели). */
function StartQueue() {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState('');
  return (
    <span className="grid gap-1">
      <Button
        type="button"
        size="sm"
        disabled={state !== 'idle'}
        onClick={() => {
          setState('busy');
          setError('');
          send('scheduler', { start: true }).then(
            () => setState('done'),
            (e: unknown) => {
              setState('idle');
              setError(e instanceof Error ? e.message : String(e));
            },
          );
        }}
      >
        {state === 'done' ? 'Очередь запущена' : 'Подтвердить и запустить очередь'}
      </Button>
      {error && (
        <span role="alert" className="text-destructive text-sm">
          {error}
        </span>
      )}
    </span>
  );
}
