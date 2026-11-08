import { useId, useState } from 'react';
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
  configPending?: { operation: string; requestedAt: string; keys?: string[] } | null;
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

const samePolicy = (a: InputPolicyValue, b: { threshold: number; criticalPaths: string[] }) =>
  (a?.threshold ?? DEFAULT_THRESHOLD) === b.threshold &&
  JSON.stringify(a?.criticalPaths ?? []) === JSON.stringify(b.criticalPaths);

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
      <dd className="m-0 [overflow-wrap:anywhere]">
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
  const explanation = useId();
  const thresholdId = useId();
  const pathsId = useId();
  const pathsHint = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Запрос этой вкладки: по нему видно, ждёт он применения, применён или
  // отклонён сервером.
  const [requested, setRequested] = useState<{
    operation: string;
    threshold: number;
    criticalPaths: string[];
  }>();
  const pending = config.configPending ?? null;
  const ownPending = !!requested && pending?.operation === requested.operation;
  const outcome = !requested
    ? undefined
    : ownPending
      ? 'pending'
      : pending
        ? undefined
        : samePolicy(policy, requested)
          ? 'applied'
          : 'refused';

  const submit = async (form: HTMLFormElement) => {
    const data = new FormData(form);
    const threshold = Number(data.get('threshold'));
    const paths = data.get('criticalPaths');
    const criticalPaths = (typeof paths === 'string' ? paths : '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
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
        { error?: string; operation?: string } | undefined;
      if (!response.ok) throw new Error(body?.error ?? `сервер ответил ${response.status}`);
      setRequested({ operation: body!.operation!, threshold, criticalPaths });
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="input-policy-title" id="input-policy" data-input-policy>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle id="input-policy-title" className="flex items-center gap-2">
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
          {outcome === 'pending' && (
            <p role="status" className="m-0" data-input-policy-outcome="pending">
              Порог {requested!.threshold} записан в config.json. Сервер применит его, когда
              закончатся работы под прежней конфигурацией; до применения новые попытки не выдаются.
            </p>
          )}
          {outcome === 'applied' && (
            <p role="status" className="m-0" data-input-policy-outcome="applied">
              Применено: порог {requested!.threshold}, в журнале — событие{' '}
              <code className="font-mono text-xs">config.applied</code>. Действует со следующей
              попытки: идущая попытка работает с порогом, закреплённым при выдаче.
            </p>
          )}
          {outcome === 'refused' && (
            <p role="alert" className="text-destructive m-0" data-input-policy-outcome="refused">
              Сервер не применил порог {requested!.threshold}: причина — в журнале, событие{' '}
              <code className="font-mono text-xs">config.apply-refused</code>.
            </p>
          )}
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
          ) : pending && !ownPending ? (
            <p role="status" className="text-muted-foreground m-0">
              Конфигурацию сейчас применяет операция{' '}
              <code className="font-mono text-xs">{pending.operation}</code>: порог можно будет
              изменить после её применения.
            </p>
          ) : (
            !ownPending && (
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
            )
          )}
          {error && (
            <p role="alert" className="text-destructive m-0" data-input-policy-error>
              Порог не изменён: {error}
            </p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
