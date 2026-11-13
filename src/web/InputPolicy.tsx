import { useEffect, useId, useRef, useState } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import { Alert, AlertDescription } from '@/ui/alert.tsx';
import { Button } from '@/ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card.tsx';
import { Textarea } from '@/ui/textarea.tsx';

// Порог вопросов исполнителя (`inputPolicy`) — выбор оператора: панель
// меняет его без ручной правки config.json. Сервер проверяет ожидаемый digest
// конфигурации, пишет файл и запрос применения; такт сервера применяет его
// тем же правилом, что `devcontour config-apply --keys inputPolicy`, и пишет
// в журнал `config.applied`. Объявленный в workspace.json порог панель только
// показывает: правка config.json пропала бы при следующем workspace-init.

export type InputPolicyValue = { threshold: number; criticalPaths?: string[] } | null;

export type InputPolicyConfig = {
  inputPolicy?: InputPolicyValue;
  inputPolicyDeclared?: boolean;
  configDigest?: string;
  configPending?: {
    operation: string;
    requestedAt: string;
    keys?: string[];
    appliedAt?: string;
    error?: string;
  } | null;
  configDrift?: { fileDigest: string | null; reason: string } | null;
};

/** Умолчание harness, когда поля нет. */
const DEFAULT_THRESHOLD = 7;

const thresholdLabel = (n: number) =>
  n === 11
    ? '11 — автономный режим'
    : n === 1
      ? '1 — спрашивать всегда'
      : n === DEFAULT_THRESHOLD
        ? `${n} — по умолчанию`
        : n === 10
          ? '10 — только о критическом'
          : String(n);

/**
 * Запрос этой вкладки — небольшой автомат по ответу маршрута (operation и
 * digest записанной конфигурации): `submitted` → `pending` (сводка видит свой
 * запрос) → `applied` (действующий digest равен записанному) или `refused`
 * (запрос снят, а digest другой). Решённый исход больше не пересчитывается:
 * позднейшая правка порога из CLI не превращает «применено» в отказ.
 */
type Phase = 'submitted' | 'pending' | 'applied' | 'refused';
type Requested = { operation: string; digest: string; threshold: number; phase: Phase };

export function nextPhase(
  requested: Pick<Requested, 'operation' | 'digest' | 'phase'>,
  config: InputPolicyConfig,
): Phase {
  if (requested.phase === 'applied' || requested.phase === 'refused') return requested.phase;
  if (config.configDigest === requested.digest) return 'applied';
  const pending = config.configPending;
  if (pending?.operation === requested.operation) return 'pending';
  // Свой запрос был виден и снят без нужного digest — отказ; без
  // увиденного запроса отказ виден по расхождению файла при свободном слоте.
  if (requested.phase === 'pending' || (!pending && config.configDrift)) return 'refused';
  return requested.phase;
}

function Current({ policy }: { policy: InputPolicyValue }) {
  const threshold = policy?.threshold ?? DEFAULT_THRESHOLD;
  const paths = policy?.criticalPaths ?? [];
  return (
    <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <dt className="text-muted-foreground">Порог</dt>
      <dd className="m-0" data-input-policy-threshold={threshold}>
        {thresholdLabel(threshold)}
        {!policy && <span className="text-muted-foreground"> (не задан в конфигурации)</span>}
      </dd>
      <dt className="text-muted-foreground">Критические пути</dt>
      <dd className="m-0 [overflow-wrap:anywhere]" data-input-policy-paths>
        {paths.length ? (
          <ul className="m-0 grid list-none gap-0.5 p-0">
            {paths.map((p) => (
              <li key={p}>
                <code className="font-mono text-xs">{p}</code>
              </li>
            ))}
          </ul>
        ) : (
          'нет'
        )}
      </dd>
    </dl>
  );
}

export function InputPolicyCard({
  config,
  onChanged,
}: {
  config: InputPolicyConfig;
  onChanged?: () => void;
}) {
  const policy = config.inputPolicy ?? null;
  const titleId = useId();
  const explanation = useId();
  const thresholdId = useId();
  const pathsId = useId();
  const pathsHint = useId();
  const status = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [requested, setRequested] = useState<Requested>();
  const phase = requested && nextPhase(requested, config);
  useEffect(() => {
    if (requested && phase && phase !== requested.phase) setRequested({ ...requested, phase });
  }, [requested, phase]);
  // Форма уступает место состоянию запроса: фокус — на нём, а не на body
  // (после отрисовки: пустая область скрыта и фокуса не принимает).
  const operation = requested?.operation;
  useEffect(() => {
    if (operation) status.current?.focus();
  }, [operation]);
  // Ошибка прежней правки не переживает смену конфигурации.
  useEffect(() => setError(''), [config.configDigest]);

  const pending = config.configPending ?? null;
  const own = phase === 'submitted' || phase === 'pending';
  const otherPending = !!pending && pending.operation !== requested?.operation;
  const drift = config.configDrift ?? null;

  const submit = async (form: HTMLFormElement) => {
    const data = new FormData(form);
    const threshold = Number(data.get('threshold'));
    const paths = data.get('criticalPaths');
    const criticalPaths = [
      ...new Set(
        (typeof paths === 'string' ? paths : '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      ),
    ];
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/config/input-policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DevContour-Request': '1' },
        body: JSON.stringify({
          threshold,
          // Пустой список при заданных путях снимает их; без путей поле не пишется.
          ...(criticalPaths.length || policy?.criticalPaths ? { criticalPaths } : {}),
          expectedConfigDigest: config.configDigest,
        }),
      });
      const body = (await response.json().catch(() => undefined)) as
        { error?: string; operation?: string; digest?: string } | undefined;
      if (!response.ok) throw new Error(body?.error ?? `сервер ответил ${response.status}`);
      if (!body?.operation || !body.digest)
        throw new Error('сервер не назвал запрос применения; обновите страницу');
      setRequested({
        operation: body.operation,
        digest: body.digest,
        threshold,
        phase: 'submitted',
      });
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const statusText = !requested
    ? ''
    : own
      ? `Порог ${requested.threshold} записан в config.json. Сервер применит его, когда закончатся работы под прежней конфигурацией; до применения новые попытки не выдаются.`
      : phase === 'applied'
        ? `Применено: порог ${requested.threshold}, в журнале — событие config.applied. Действует со следующей попытки: идущая попытка работает с порогом, закреплённым при выдаче.`
        : '';
  const alertText =
    phase === 'refused'
      ? `Сервер не применил порог ${requested!.threshold}: причина — в журнале, событие config.apply-refused.`
      : error
        ? `Порог не изменён: ${error}`
        : '';

  return (
    <section aria-labelledby={titleId} data-input-policy>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle id={titleId} className="flex items-center gap-2">
            <MessageCircleQuestion className="text-primary size-4" aria-hidden="true" />
            Вопросы исполнителя
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm">
          <p id={explanation} className="text-muted-foreground m-0">
            Порог 1–10 — серьёзность, с которой исполнитель останавливается и задаёт вопрос: 1 —
            спрашивать всегда, 10 — только о критическом. 11 — автономный режим: исполнитель решает
            сам и записывает допущения, критические решения уходят ведущему. Изменение критических
            путей делает вопрос критическим — на него отвечает только оператор. Без настройки порог
            7.
          </p>
          <Current policy={policy} />
          {/* Живые области стоят всегда: меняется только текст, и его читают. */}
          <div
            ref={status}
            role="status"
            tabIndex={-1}
            className="outline-offset-2 empty:hidden"
            data-input-policy-status
            data-input-policy-outcome={phase === 'refused' ? undefined : phase}
          >
            {statusText}
          </div>
          <div
            role="alert"
            className="text-destructive empty:hidden"
            data-input-policy-alert
            data-input-policy-outcome={phase === 'refused' ? 'refused' : undefined}
          >
            {alertText}
          </div>
          {config.inputPolicyDeclared ? (
            <Alert variant="info" data-input-policy-declared>
              <AlertDescription>
                Порог объявлен в <code className="font-mono text-xs">workspace.json</code>, поэтому
                здесь только показан: правку config.json заменил бы следующий workspace-init.
                Измените <code className="font-mono text-xs">inputPolicy</code> в workspace.json и
                выполните{' '}
                <code className="font-mono text-xs [overflow-wrap:anywhere]">
                  devcontour workspace-init --file &lt;workspace.json&gt;
                </code>
                , затем{' '}
                <code className="font-mono text-xs [overflow-wrap:anywhere]">
                  devcontour config-apply --keys inputPolicy
                </code>
                .
              </AlertDescription>
            </Alert>
          ) : own ? null : otherPending ? (
            <p className="text-muted-foreground m-0" data-input-policy-busy>
              Конфигурацию сейчас применяет операция{' '}
              <code className="font-mono text-xs">{pending.operation}</code>
              {pending.appliedAt ? ' (применена, ещё не завершена)' : ''}
              {pending.error ? ` (сервер отклонил: ${pending.error})` : ''}: порог можно будет
              изменить, когда она завершится.
            </p>
          ) : drift ? (
            <Alert variant="warning" data-input-policy-drift>
              <AlertDescription>
                config.json отличается от действующей конфигурации сервера ({drift.reason}), поэтому
                порог здесь не меняется: сервер сверяет файл. Примените правку файла —{' '}
                <code className="font-mono text-xs [overflow-wrap:anywhere]">
                  devcontour config-apply --keys …
                </code>{' '}
                с изменёнными ключами (budgets, prices, stallSweep, inputPolicy, gateTimeoutFloorMs;
                прочие поля — перезапуском сервера) — или верните файл к действующему содержимому.
              </AlertDescription>
            </Alert>
          ) : (
            <form
              // Новая конфигурация — новые значения формы по умолчанию.
              key={config.configDigest}
              className="grid max-w-xl gap-3"
              aria-label="Изменить порог вопросов"
              onSubmit={(e) => {
                e.preventDefault();
                void submit(e.currentTarget);
              }}
            >
              <div className="grid gap-1">
                <label htmlFor={thresholdId} className="font-medium">
                  Порог
                </label>
                <select
                  id={thresholdId}
                  name="threshold"
                  defaultValue={policy?.threshold ?? DEFAULT_THRESHOLD}
                  aria-describedby={explanation}
                  className="border-input bg-card h-(--control-height-form) rounded-sm border px-3 text-sm"
                >
                  {Array.from({ length: 11 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {thresholdLabel(n)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-1">
                <label htmlFor={pathsId} className="font-medium">
                  Критические пути
                </label>
                <span id={pathsHint} className="text-muted-foreground text-xs">
                  По одному относительному пути в строке, не больше 50.
                </span>
                <Textarea
                  id={pathsId}
                  aria-describedby={pathsHint}
                  name="criticalPaths"
                  rows={3}
                  defaultValue={(policy?.criticalPaths ?? []).join('\n')}
                  className="font-mono text-xs"
                />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" disabled={busy || !config.configDigest}>
                  Применить порог
                </Button>
                <span className="text-muted-foreground text-xs">
                  Новый порог действует со следующей попытки.
                </span>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
