import { useId } from 'react';
import type { HomeLoad, HomeProgress } from '../application/home.ts';
import { Bar } from '@/ui/progress-bar.tsx';
import { plural } from '@/lib/utils.ts';

// Графики главной: общий ход работ, нагрузка агентов за сутки и попытки по
// часам. Небольшой встроенный SVG на токенах панели, без библиотеки
// графиков. У каждого графика — заголовок, текстовая сводка, легенда и
// скрытая таблица данных: цвет не единственный носитель смысла.

const OUTCOMES = [
  { key: 'running', label: 'идёт', color: 'var(--status-active)' },
  { key: 'succeeded', label: 'принята', color: 'var(--status-done)' },
  { key: 'failed', label: 'сбой', color: 'var(--status-failed)' },
  { key: 'interrupted', label: 'прервана', color: 'var(--status-waiting)' },
] as const;

const hhmm = (ms: number) =>
  new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const agents = (n: number) => `${n} ${plural(n, 'агент', 'агента', 'агентов')}`;

function Legend({ items }: { items: readonly { label: string; color: string }[] }) {
  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-xs" aria-hidden="true">
      {items.map((i) => (
        <li key={i.label} className="text-muted-foreground flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-sm" style={{ background: i.color }} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

/** Подписи оси времени под графиком: начало, середина, конец. */
function TimeAxis({ from, to }: { from: number; to: number }) {
  return (
    <div className="text-muted-foreground flex justify-between text-xs" aria-hidden="true">
      <span>{hhmm(from)}</span>
      <span>{hhmm((from + to) / 2)}</span>
      <span>{hhmm(to)}</span>
    </div>
  );
}

const W = 960;
const H = 120;

/**
 * Столбики со стеком: ширина интервала с зазором 2 по оси, высота —
 * от общей шкалы `max`. Каждый столбик несёт подсказку `<title>`.
 */
function Stacked({
  rows,
  colors,
  max,
  titles,
  limit,
}: {
  rows: number[][];
  colors: readonly string[];
  max: number;
  titles: string[];
  limit?: number;
}) {
  const step = W / rows.length;
  const width = Math.max(1, step - 2);
  const y = (v: number) => (v / max) * (H - 4);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="block h-28 w-full"
      aria-hidden="true"
      focusable="false"
    >
      <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} stroke="var(--border)" strokeWidth="1" />
      {limit !== undefined && limit <= max && (
        <line
          x1="0"
          x2={W}
          y1={H - y(limit)}
          y2={H - y(limit)}
          stroke="var(--text-faint)"
          strokeWidth="1"
          strokeDasharray="6 4"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {rows.map((row, i) => {
        let base = H;
        return (
          <g key={i}>
            <title>{titles[i]}</title>
            {/* Невидимая цель шире столбика: подсказка и у пустого интервала. */}
            <rect x={i * step} y={0} width={step} height={H} fill="transparent" />
            {row.map((v, k) => {
              if (!v) return null;
              const h = y(v);
              base -= h;
              return (
                <rect
                  key={k}
                  x={i * step + 1}
                  y={base}
                  width={width}
                  height={Math.max(h - 1, 1)}
                  fill={colors[k]}
                />
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

/** Нагрузка агентов за сутки: пик одновременных попыток по 15 минут. */
export function LoadChart({ load, concurrency }: { load: HomeLoad; concurrency: number }) {
  const id = useId();
  const from = Date.parse(load.from);
  const totals = load.peaks.map((p) => p[0] + p[1] + p[2] + p[3]);
  const peak = Math.max(0, ...totals);
  const at = totals.indexOf(peak);
  const now = load.peaks.at(-1)?.[0] ?? 0;
  const max = Math.max(peak, concurrency, 1);
  const start = (i: number) => from + i * load.bucketMs;
  const split = (p: number[]) =>
    OUTCOMES.flatMap((o, k) => (p[k] ? [`${o.label} ${p[k]}`] : [])).join(', ');
  const titles = load.peaks.map(
    (p, i) =>
      `${hhmm(start(i))}–${hhmm(start(i + 1))}: ${totals[i] ? `пик ${agents(totals[i])} (${split(p)})` : 'никто не работал'}`,
  );
  const summary = peak
    ? `Пик ${agents(peak)} в ${hhmm(start(at))}, сейчас ${now}; слотов ${concurrency}.`
    : `За сутки агенты не работали; слотов ${concurrency}.`;
  const busy = load.peaks.map((p, i) => ({ p, i })).filter(({ i }) => totals[i] > 0);
  return (
    <figure className="m-0 grid min-w-0 gap-1.5" aria-labelledby={id}>
      <figcaption id={id} className="grid gap-0.5">
        <span className="font-medium">Нагрузка агентов за сутки</span>
        <span className="text-muted-foreground text-xs">{summary}</span>
      </figcaption>
      <Stacked
        rows={load.peaks}
        colors={OUTCOMES.map((o) => o.color)}
        max={max}
        titles={titles}
        limit={concurrency}
      />
      <TimeAxis from={from} to={Date.parse(load.to)} />
      <Legend
        items={[
          ...OUTCOMES,
          { label: `пунктир — слоты (${concurrency})`, color: 'var(--text-faint)' },
        ]}
      />
      <div className="sr-only">
        <table>
          <caption>Пик одновременных попыток по 15 минут, только интервалы с работой</caption>
          <thead>
            <tr>
              <th scope="col">Интервал</th>
              <th scope="col">Пик</th>
              {OUTCOMES.map((o) => (
                <th key={o.key} scope="col">
                  {o.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {busy.map(({ p, i }) => (
              <tr key={i}>
                <th scope="row">
                  {hhmm(start(i))}–{hhmm(start(i + 1))}
                </th>
                <td>{totals[i]}</td>
                {p.map((v, k) => (
                  <td key={k}>{v}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

const HOURLY = [
  { label: 'без сбоя', color: 'var(--status-ready)' },
  { label: 'со сбоем', color: 'var(--status-failed)' },
] as const;

/** Начатые попытки по часам за сутки, сбои — верхней частью столбика. */
export function HourlyChart({ load }: { load: HomeLoad }) {
  const id = useId();
  const from = Date.parse(load.from);
  const hour = 4 * load.bucketMs;
  const rows = load.hourly.map(([total, failed]) => [total - failed, failed]);
  const total = load.hourly.reduce((s, [n]) => s + n, 0);
  const failed = load.hourly.reduce((s, [, n]) => s + n, 0);
  const most = Math.max(0, ...load.hourly.map(([n]) => n));
  const mostAt = load.hourly.findIndex(([n]) => n === most);
  const start = (i: number) => from + i * hour;
  const titles = load.hourly.map(
    ([n, f], i) => `${hhmm(start(i))}–${hhmm(start(i + 1))}: начато ${n}, со сбоем ${f}`,
  );
  const summary = total
    ? `Начато ${total}, со сбоем ${failed}; больше всего в ${hhmm(start(mostAt))} (${most}).`
    : 'За сутки попыток не было.';
  return (
    <figure className="m-0 grid min-w-0 gap-1.5" aria-labelledby={id}>
      <figcaption id={id} className="grid gap-0.5">
        <span className="font-medium">Попытки по часам</span>
        <span className="text-muted-foreground text-xs">{summary}</span>
      </figcaption>
      <Stacked
        rows={rows}
        colors={HOURLY.map((x) => x.color)}
        max={Math.max(most, 1)}
        titles={titles}
      />
      <TimeAxis from={from} to={Date.parse(load.to)} />
      <Legend items={HOURLY} />
      <div className="sr-only">
        <table>
          <caption>Начатые попытки по часам</caption>
          <thead>
            <tr>
              <th scope="col">Час</th>
              <th scope="col">Начато</th>
              <th scope="col">Со сбоем</th>
            </tr>
          </thead>
          <tbody>
            {load.hourly.map(([n, f], i) =>
              n ? (
                <tr key={i}>
                  <th scope="row">{hhmm(start(i))}</th>
                  <td>{n}</td>
                  <td>{f}</td>
                </tr>
              ) : null,
            )}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

/**
 * Общий ход работ над плитками: выполненные задачи из живых (без отменённых)
 * и мини-полосы релизов.
 */
export function OverallProgress({ progress }: { progress: HomeProgress }) {
  const { tasks } = progress;
  const live = tasks.total - tasks.cancelled;
  return (
    <section
      aria-label="Общий ход работ"
      className="bg-card grid min-w-0 gap-3 rounded-md border p-4 text-sm"
    >
      <Bar done={tasks.done} total={live} label="Выполнено задач" />
      {progress.releases.length > 0 && (
        <ul
          className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-x-6 gap-y-2 p-0"
          aria-label="Релизы"
        >
          {progress.releases.map((r) => {
            const percent = r.tasks ? Math.round((r.done / r.tasks) * 100) : 0;
            return (
              <li key={r.id} className="grid min-w-0 gap-1">
                <span className="flex min-w-0 justify-between gap-2 text-xs">
                  <span className="truncate" title={r.title}>
                    {r.id} {r.title}
                  </span>
                  <span className="text-muted-foreground tabular shrink-0">
                    {r.done}/{r.tasks}
                  </span>
                </span>
                <span
                  className="bg-secondary block h-1.5 overflow-hidden rounded-full"
                  role="progressbar"
                  aria-valuenow={percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`Релиз ${r.id} ${r.title}`}
                >
                  <span
                    className={r.failed ? 'bg-destructive block h-full' : 'bg-success block h-full'}
                    style={{ width: percent + '%' }}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
