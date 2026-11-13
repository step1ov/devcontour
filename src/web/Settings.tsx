import { forwardRef, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Cpu } from 'lucide-react';
import { Alert, AlertDescription } from '@/ui/alert.tsx';
import { Button } from '@/ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card.tsx';
import { InputPolicyCard, nextPhase, type InputPolicyConfig } from './InputPolicy.tsx';
import { roleName } from './roles.ts';

// Экран «Настройки» — выбор оператора: модели ролей и порог вопросов
// исполнителя. Агентской операции для них нет; граница HTTP — та же, что у
// прочих действий панели (защита от чужих страниц, не от локальных процессов). Модели меняются тем же путём,
// что `devcontour config-apply --keys models`: сервер сверяет digest
// конфигурации, которую видела панель, проверяет новую тем же загрузчиком
// (правило вендора ревью, профили инструментов), пишет файл объявления и
// запрос применения; такт сервера применяет его после работ под прежней
// конфигурацией.

type Binding = { runtime: string; model?: string; effort?: string };
export type ModelSlot = {
  id: string;
  kind: 'writer' | 'role-reviewer' | 'repository-reviewer' | 'reviewer' | 'review';
  repositoryId?: string;
  repositories?: string[];
  role?: string;
  title?: string;
  binding: Binding | null;
  own: boolean;
  fallback?: string;
  nullable: boolean;
  editable: boolean;
  reason?: string;
  note?: string;
  file?: string;
  toolProfile?: string;
};
export type SettingsView = InputPolicyConfig & {
  approvalMode?: string;
  models: {
    slots: ModelSlot[];
    runtimes: string[];
    models: Record<string, string[]>;
    efforts: string[];
    effortRuntimes: string[];
    error?: string;
  };
};
type Change = Pick<ModelSlot, 'kind' | 'repositoryId' | 'repositories' | 'role' | 'title'> & {
  slot: string;
  before: Binding | null;
  after: Binding | null;
};
type Effective = {
  repositoryId: string;
  role: string;
  title?: string;
  kind: 'writer' | 'reviewer';
  before: Binding | null;
  after: Binding | null;
};
type Effects = {
  changes: Change[];
  effective: Effective[];
  reviews: { kind: 'plan' | 'contract'; author: string; before: string; after: string }[];
  approvals: { stale: number; tasks: { id: string; title: string }[]; digest: string };
  waitingFor: string[];
  warnings: string[];
  files: string[];
  components: string[];
};
/** Запрос применения моделей из этой карточки и его исход. */
type Phase = 'submitted' | 'pending' | 'applied' | 'refused';
type Requested = { operation: string; digest: string; phase: Phase; effects: Effects };
/** Черновик привязки: пустой runtime — наследовать или правило по умолчанию. */
type Draft = { runtime: string; model: string; effort: string };

const INHERIT = '';
const draftOf = (slot: ModelSlot): Draft =>
  slot.own && slot.binding
    ? {
        runtime: slot.binding.runtime,
        model: slot.binding.model ?? '',
        effort: slot.binding.effort ?? '',
      }
    : { runtime: INHERIT, model: '', effort: '' };
const sameDraft = (a: Draft, b: Draft) =>
  a.runtime === b.runtime && a.model === b.model && a.effort === b.effort;

export const bindingText = (b: Binding | null | undefined) =>
  b
    ? [b.runtime, b.model ?? 'модель CLI по умолчанию', b.effort ? `effort ${b.effort}` : '']
        .filter(Boolean)
        .join(' · ')
    : 'не задан';

export const slotLabel = (s: Pick<ModelSlot, 'id' | 'kind' | 'repositoryId'>) =>
  s.kind === 'writer'
    ? 'Исполнитель'
    : s.kind === 'role-reviewer'
      ? 'Ревьюер кода'
      : s.kind === 'repository-reviewer'
        ? `Ревьюер компонента ${s.repositoryId}`
        : s.kind === 'reviewer'
          ? 'Общий ревьюер кода'
          : s.id === 'review:plan'
            ? 'Ревью плана'
            : s.id === 'review:contract'
              ? 'Ревью контракта'
              : 'Ревью кода (правило)';

const roleTitle = (role: string, title?: string) =>
  roleName(role, { roles: { [role]: { title } } });
const SHARED = '*';
/** Название привязки в списке изменений: то же имя роли, что в форме. */
const changeLabel = (c: Change) =>
  c.role
    ? `${roleTitle(c.role, c.title)}${c.repositoryId === SHARED ? ' (все компоненты без своей роли)' : ''}, ${c.kind === 'writer' ? 'исполнитель' : 'ревьюер кода'}`
    : slotLabel({ ...c, id: c.slot });

const selectClass =
  'border-input bg-card h-(--control-height-form) min-w-0 rounded-sm border px-2 text-sm';

function SlotRow({
  slot,
  draft,
  view,
  disabled,
  onChange,
}: {
  slot: ModelSlot;
  draft: Draft;
  view: SettingsView['models'];
  disabled: boolean;
  onChange: (draft: Draft) => void;
}) {
  const runtimeId = useId();
  const modelId = useId();
  const effortId = useId();
  const label = slotLabel(slot);
  // Подпись поля называет роль: на экране несколько одинаковых полей.
  const lead = slot.role
    ? `${roleName(slot.role, { roles: { [slot.role]: slot } })}, ${label.toLowerCase()}`
    : label;
  const models = draft.runtime ? (view.models[draft.runtime] ?? []) : [];
  // Текущая модель остаётся в списке, даже если workspace её уже не называет.
  const options = draft.model && !models.includes(draft.model) ? [draft.model, ...models] : models;
  const effortAllowed = view.effortRuntimes.includes(draft.runtime);
  return (
    <div className="grid gap-2 border-t py-3 first:border-t-0 first:pt-0" data-model-slot={slot.id}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <strong className="font-medium">{label}</strong>
        <span className="text-muted-foreground text-xs" data-model-current>
          {slot.binding ? bindingText(slot.binding) : (slot.fallback ?? 'по умолчанию')}
          {!slot.own && slot.binding && slot.fallback ? ` (наследуется: ${slot.fallback})` : ''}
        </span>
      </div>
      {slot.editable ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-2">
          <div className="grid gap-1">
            <label htmlFor={runtimeId} className="text-muted-foreground text-xs">
              {lead}: runtime
            </label>
            <select
              id={runtimeId}
              className={selectClass}
              value={draft.runtime}
              disabled={disabled}
              onChange={(e) => {
                const runtime = e.target.value;
                onChange({
                  runtime,
                  // Модель и effort принадлежат runtime: смена runtime их сбрасывает.
                  model: runtime === draft.runtime ? draft.model : '',
                  effort: view.effortRuntimes.includes(runtime) ? draft.effort : '',
                });
              }}
            >
              {slot.nullable && (
                <option value={INHERIT}>
                  {slot.kind === 'review'
                    ? (slot.fallback ?? 'по умолчанию')
                    : `наследовать${slot.fallback ? ` — ${slot.fallback}` : ''}`}
                </option>
              )}
              {view.runtimes.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          {draft.runtime && (
            <div className="grid gap-1">
              <label htmlFor={modelId} className="text-muted-foreground text-xs">
                {lead}: модель
              </label>
              <select
                id={modelId}
                className={selectClass}
                value={draft.model}
                disabled={disabled}
                onChange={(e) => onChange({ ...draft, model: e.target.value })}
              >
                <option value="">модель CLI по умолчанию</option>
                {options.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          )}
          {draft.runtime && effortAllowed && (
            <div className="grid gap-1">
              <label htmlFor={effortId} className="text-muted-foreground text-xs">
                {lead}: уровень рассуждения
              </label>
              <select
                id={effortId}
                className={selectClass}
                value={draft.effort}
                disabled={disabled}
                onChange={(e) => onChange({ ...draft, effort: e.target.value })}
              >
                <option value="">по умолчанию</option>
                {view.efforts.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      ) : (
        <p className="text-muted-foreground m-0 text-xs" data-model-readonly>
          Только просмотр: {slot.reason}
        </p>
      )}
      {slot.note && (
        <p className="text-muted-foreground m-0 text-xs" data-model-note>
          {slot.note}
        </p>
      )}
      {(slot.file || slot.toolProfile) && (
        <p className="text-muted-foreground m-0 text-xs">
          {slot.file && (
            <>
              Файл: <code className="font-mono">{slot.file}</code>
            </>
          )}
          {slot.file && slot.toolProfile ? ' · ' : ''}
          {slot.toolProfile && (
            <>
              профиль инструментов <code className="font-mono">{slot.toolProfile}</code> (только для
              своего runtime)
            </>
          )}
        </p>
      )}
    </div>
  );
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DevContour-Request': '1' },
    body: JSON.stringify(body),
  });
  const result = (await response.json().catch(() => undefined)) as
    (T & { error?: string }) | undefined;
  if (!response.ok) throw new Error(result?.error ?? `сервер ответил ${response.status}`);
  if (!result) throw new Error('сервер не ответил; обновите страницу');
  return result;
}

const EffectsView = forwardRef<HTMLDivElement, { effects: Effects }>(function EffectsView(
  { effects },
  ref,
) {
  const headingId = useId();
  return (
    // Последствия появляются после проверки: фокус переходит на них, и
    // область объявляется читателю экрана целиком.
    <div
      ref={ref}
      tabIndex={-1}
      role="region"
      aria-labelledby={headingId}
      className="grid gap-2 outline-offset-2"
      data-model-effects
    >
      <h4 id={headingId} className="m-0 font-medium">
        Что изменится
      </h4>
      <ul className="m-0 grid list-disc gap-0.5 pl-5">
        {effects.changes.map((c) => (
          <li key={c.slot}>
            {changeLabel(c)}: {bindingText(c.before)} →{' '}
            {c.after ? bindingText(c.after) : 'наследовать'}
          </li>
        ))}
      </ul>
      {effects.effective.length > 0 && (
        <div data-model-effective>
          <p className="m-0">Действующие привязки по компонентам:</p>
          <ul className="m-0 grid list-disc gap-0.5 pl-5">
            {effects.effective.map((e) => (
              <li key={`${e.repositoryId}:${e.role}:${e.kind}`}>
                {e.repositoryId} · {roleTitle(e.role, e.title)},{' '}
                {e.kind === 'writer' ? 'исполнитель' : 'ревьюер кода'}: {bindingText(e.before)} →{' '}
                {bindingText(e.after)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {effects.reviews.length > 0 && (
        <div data-model-reviews>
          <p className="m-0">Ревью плана и контракта (кто проверит автора каждого runtime):</p>
          <ul className="m-0 grid list-disc gap-0.5 pl-5">
            {effects.reviews.map((r) => (
              <li key={`${r.kind}:${r.author}`}>
                {r.kind === 'plan' ? 'План' : 'Контракт'}, автор {r.author}: {r.before} → {r.after}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="m-0">
        Когда действует: со следующей попытки и следующего ревью после применения. Идущие работы
        заканчиваются с прежними моделями
        {effects.waitingFor.length
          ? ` (сейчас идут: ${effects.waitingFor.length}); до применения новые попытки не выдаются`
          : ''}
        .
      </p>
      {effects.approvals.stale > 0 ? (
        <Alert variant="warning" data-model-reapproval>
          <AlertDescription>
            Модели входят в утверждённый план. Утверждение {effects.approvals.stale} задач
            закреплено при прежних моделях: после применения они не выдаются, пока план не утверждён
            заново (ревью плана). Панель утверждения не перезакрепляет.
            {effects.approvals.tasks.length > 0 && (
              <>
                {' '}
                Задачи: {effects.approvals.tasks.map((t) => t.title || t.id).join(', ')}
                {effects.approvals.stale > effects.approvals.tasks.length ? ' и другие' : ''}.
              </>
            )}
          </AlertDescription>
        </Alert>
      ) : (
        <p className="text-muted-foreground m-0">
          Утверждённых задач, которые потребуют повторного утверждения, нет: новые и ещё не
          утверждённые планы закрепят новые модели при утверждении.
        </p>
      )}
      {effects.warnings.length > 0 && (
        <Alert variant="warning" data-model-warnings>
          <AlertDescription>
            <ul className="m-0 grid list-disc gap-0.5 pl-5">
              {effects.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      <p className="text-muted-foreground m-0 text-xs">
        Изменятся файлы: {effects.files.join(', ')}.
      </p>
      {effects.components.length > 0 && (
        <Alert variant="info" data-model-commit>
          <AlertDescription>
            {effects.components.join(', ')} — файл компонента в основном checkout репозитория
            продукта. Сервер читает его оттуда, поэтому модели действуют без коммита; до коммита
            checkout считается изменённым. Коммит — правка настройки контура в базе прогонов:
            диспетчер не перематывает базу через неё, и очередь остановится. Тогда выполните{' '}
            <code className="font-mono text-xs">devcontour base-update --workspace …</code>, затем
            проверьте базу гейтами и продолжите очередь (
            <code className="font-mono text-xs">devcontour queue --start</code>; в режиме агента
            базу проверяет цикл ведущего).
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
});

export function ModelSettingsCard({
  view,
  onChanged,
}: {
  view: SettingsView;
  onChanged?: () => void;
}) {
  const titleId = useId();
  const ackId = useId();
  const status = useRef<HTMLDivElement>(null);
  const shownEffects = useRef<HTMLDivElement>(null);
  const slots = view.models.slots;
  const initial = () =>
    Object.fromEntries(slots.map((s) => [s.id, draftOf(s)])) as Record<string, Draft>;
  // Опрос приносит новый массив каждые несколько секунд: черновик сбрасывает только
  // изменившаяся конфигурация, а не повтор того же ответа.
  const slotsKey = JSON.stringify(slots.map((s) => [s.id, s.binding, s.own, s.editable]));
  const [drafts, setDrafts] = useState(initial);
  const [effects, setEffects] = useState<Effects>();
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [requested, setRequested] = useState<Requested>();
  const phase = requested && nextPhase(requested, view);
  useEffect(() => {
    if (requested && phase && phase !== requested.phase) setRequested({ ...requested, phase });
  }, [requested, phase]);
  // Новая конфигурация — новые значения формы; проверка прежнего черновика устарела.
  const shown = useRef(`${view.configDigest}|${slotsKey}`);
  useEffect(() => {
    const key = `${view.configDigest}|${slotsKey}`;
    if (shown.current === key) return;
    shown.current = key;
    setDrafts(
      Object.fromEntries(
        (JSON.parse(slotsKey) as [string][]).map(([id]) => {
          const slot = view.models.slots.find((s) => s.id === id)!;
          return [id, draftOf(slot)];
        }),
      ),
    );
    setEffects(undefined);
    setAck(false);
    setError('');
  }, [view.configDigest, slotsKey, view.models.slots]);
  const operation = requested?.operation;
  useEffect(() => {
    if (operation) status.current?.focus();
  }, [operation]);
  // Последствия проверки — на них фокус: читатель экрана слышит их сразу.
  useEffect(() => {
    if (effects) shownEffects.current?.focus();
  }, [effects]);

  const changes = slots
    .filter((s) => s.editable && drafts[s.id] && !sameDraft(drafts[s.id], draftOf(s)))
    .map((s) => {
      const d = drafts[s.id];
      return {
        slot: s.id,
        binding: d.runtime
          ? { runtime: d.runtime, model: d.model || null, effort: d.effort || null }
          : null,
      };
    });
  const pending = view.configPending ?? null;
  const own = phase === 'submitted' || phase === 'pending';
  const otherPending = !!pending && pending.operation !== requested?.operation;
  const drift = view.configDrift ?? null;
  const locked = own || otherPending || !!drift || busy;
  const body = { changes, expectedConfigDigest: view.configDigest };

  const check = async (keepError = false) => {
    setBusy(true);
    if (!keepError) setError('');
    try {
      setEffects(await post<Effects>('/api/config/models/preview', body));
      setAck(false);
    } catch (e) {
      setEffects(undefined);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    setBusy(true);
    setError('');
    try {
      // Подтверждение — ровно показанного набора задач: изменился — сервер откажет.
      const result = await post<Effects & { operation?: string; digest?: string }>(
        '/api/config/models',
        {
          ...body,
          ...(ack && effects ? { acknowledgedApprovals: effects.approvals.digest } : {}),
        },
      );
      if (!result.operation || !result.digest)
        throw new Error('сервер не назвал запрос применения; обновите страницу');
      setRequested({
        operation: result.operation,
        digest: result.digest,
        phase: 'submitted',
        effects: result,
      });
      setEffects(undefined);
      setBusy(false);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      // Отказ сервера мог сменить последствия (новые утверждения, другой
      // набор): показ проверяется заново, ошибка остаётся видна.
      void check(true);
    }
  };

  const statusText = !requested
    ? ''
    : own
      ? 'Модели записаны. Сервер применит их, когда закончатся работы под прежней конфигурацией; до применения новые попытки не выдаются.'
      : phase === 'applied'
        ? `Применено: в журнале — событие config.applied. Новые модели действуют со следующей попытки и следующего ревью.${
            requested.effects.approvals.stale
              ? ` ${requested.effects.approvals.stale} задач ждут повторного утверждения плана.`
              : ''
          }`
        : '';
  const alertText =
    phase === 'refused'
      ? 'Сервер не применил модели: причина — в журнале, событие config.apply-refused.'
      : error
        ? `Модели не изменены: ${error}`
        : '';
  const groups = [
    ...new Set(slots.filter((s) => s.role).map((s) => `${s.repositoryId}\u0000${s.role}`)),
  ];
  const repositories = new Set(slots.map((s) => s.repositoryId).filter(Boolean));
  const shared = slots.filter((s) => !s.role);
  const view_ = view.models;

  return (
    <section aria-labelledby={titleId} data-model-settings>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle id={titleId} className="flex items-center gap-2">
            <Cpu className="text-primary size-4" aria-hidden="true" />
            Модели ролей
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm">
          <p className="text-muted-foreground m-0 max-w-[75ch]">
            Кто пишет код и кто его проверяет: runtime, модель и уровень рассуждения. Доступны
            только модели, которые workspace уже знает — из конфигурации, тарифов и сделанных
            вызовов. Ревьюер того же вендора, что исполнитель, допускается только явным правилом
            вендора; правило ревью здесь не меняется. Ведущий агент — ваш AI-клиент: его модель
            выбирается в самом клиенте.
          </p>
          {view_.error && (
            <Alert variant="warning">
              <AlertDescription>Привязки не прочитаны: {view_.error}</AlertDescription>
            </Alert>
          )}
          <div
            ref={status}
            role="status"
            tabIndex={-1}
            className="outline-offset-2 empty:hidden"
            data-model-status
            data-model-outcome={phase === 'refused' ? undefined : phase}
          >
            {statusText}
          </div>
          <div
            role="alert"
            className="text-destructive empty:hidden [overflow-wrap:anywhere]"
            data-model-alert
            data-model-outcome={phase === 'refused' ? 'refused' : undefined}
          >
            {alertText}
          </div>
          {otherPending && !own && (
            <p className="text-muted-foreground m-0" data-model-busy>
              Конфигурацию сейчас применяет операция{' '}
              <code className="font-mono text-xs">{pending.operation}</code>
              {pending.appliedAt ? ' (применена, ещё не завершена)' : ''}: модели можно будет
              изменить, когда она завершится.
            </p>
          )}
          {drift && !own && (
            <Alert variant="warning" data-model-drift>
              <AlertDescription>
                Файлы конфигурации отличаются от действующей конфигурации сервера ({drift.reason}),
                поэтому модели здесь не меняются: примените правку файла{' '}
                <code className="font-mono text-xs">devcontour config-apply --keys …</code> или
                верните файл к действующему содержимому.
              </AlertDescription>
            </Alert>
          )}
          <form
            className="grid gap-4"
            aria-label="Изменить модели ролей"
            onSubmit={(e) => {
              e.preventDefault();
              void (effects ? apply() : check());
            }}
          >
            {groups.map((key) => {
              const [repositoryId, role] = key.split('\u0000');
              const rows = slots.filter((s) => s.repositoryId === repositoryId && s.role === role);
              const title = roleName(role, { roles: { [role]: { title: rows[0]?.title } } });
              return (
                <fieldset
                  key={key}
                  className="m-0 grid gap-1 rounded-sm border p-3"
                  data-model-role={role}
                >
                  <legend className="px-1 font-medium">
                    {title}
                    {repositoryId === SHARED
                      ? ` · все компоненты без своей роли (${rows[0]?.repositories?.join(', ') ?? ''})`
                      : repositories.size > 1
                        ? ` · ${repositoryId}`
                        : ''}
                    {title !== role && (
                      <span className="text-muted-foreground font-mono text-xs"> {role}</span>
                    )}
                  </legend>
                  {rows.map((slot) => (
                    <SlotRow
                      key={slot.id}
                      slot={slot}
                      draft={drafts[slot.id] ?? draftOf(slot)}
                      view={view_}
                      disabled={locked}
                      onChange={(d) => {
                        setDrafts({ ...drafts, [slot.id]: d });
                        setEffects(undefined);
                      }}
                    />
                  ))}
                </fieldset>
              );
            })}
            {shared.length > 0 && (
              <fieldset className="m-0 grid gap-1 rounded-sm border p-3" data-model-role="">
                <legend className="px-1 font-medium">Ревьюеры по умолчанию и ревью плана</legend>
                {shared.map((slot) => (
                  <SlotRow
                    key={slot.id}
                    slot={slot}
                    draft={drafts[slot.id] ?? draftOf(slot)}
                    view={view_}
                    disabled={locked}
                    onChange={(d) => {
                      setDrafts({ ...drafts, [slot.id]: d });
                      setEffects(undefined);
                    }}
                  />
                ))}
              </fieldset>
            )}
            {effects && <EffectsView ref={shownEffects} effects={effects} />}
            {effects && effects.approvals.stale > 0 && (
              <div className="flex items-start gap-2">
                <input
                  id={ackId}
                  type="checkbox"
                  className="mt-1"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                />
                <label htmlFor={ackId}>
                  Понимаю: {effects.approvals.stale} задач потребуют повторного утверждения плана
                </label>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              {effects ? (
                <>
                  <Button type="submit" disabled={locked || (effects.approvals.stale > 0 && !ack)}>
                    Применить модели
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setEffects(undefined)}>
                    Изменить выбор
                  </Button>
                </>
              ) : (
                <Button type="submit" disabled={locked || !changes.length || !view.configDigest}>
                  Проверить изменения
                </Button>
              )}
              <span className="text-muted-foreground text-xs">
                {changes.length
                  ? `Изменено привязок: ${changes.length}`
                  : 'Выберите новые значения, затем проверьте последствия.'}
              </span>
            </div>
          </form>
        </CardContent>
      </Card>
    </section>
  );
}

/** Экран «Настройки»: модели ролей и порог вопросов исполнителя. */
export function SettingsScreen({ revision }: { revision?: string }) {
  const [view, setView] = useState<SettingsView>();
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/config/settings');
      const body = (await response.json()) as SettingsView & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `сервер ответил ${response.status}`);
      setView(body);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  // Применение идёт на такте сервера: экран перечитывает настройки, пока открыт.
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load, revision]);
  if (!view)
    return (
      <p className="text-muted-foreground m-0" role={error ? 'alert' : undefined}>
        {error ? `Настройки не загружены: ${error}` : 'Загружаем настройки…'}
      </p>
    );
  return (
    <div className="grid max-w-4xl gap-6" data-settings>
      {/* Карточки — h3: заголовок раздела держит порядок уровней под h1 экрана. */}
      <h2 className="sr-only">Настройки владельца: модели и вопросы</h2>
      {error && (
        <Alert variant="warning">
          <AlertDescription>Настройки не обновились: {error}</AlertDescription>
        </Alert>
      )}
      <ModelSettingsCard view={view} onChanged={() => void load()} />
      <InputPolicyCard config={view} onChanged={() => void load()} />
    </div>
  );
}
