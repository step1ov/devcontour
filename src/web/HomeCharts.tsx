import { useId, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import type { HomeGateTrend, HomeLoad, HomeProgress, HomeSpend } from '../application/home.ts';
import { Bar } from '@/ui/progress-bar.tsx';
import { cn, plural } from '@/lib/utils.ts';

// Графики главной: общий ход работ, нагрузка агентов за сутки, попытки и
// проверки по часам, расход по дням. Небольшой встроенный SVG на токенах
// панели, без библиотеки графиков. У каждого графика — заголовок, текстовая
// сводка, легенда и скрытая таблица данных: цвет не единственный носитель
// смысла. Подписи поверх графика (слоты, «сейчас», предел) — HTML: SVG
// растянут по ширине, и текст в нём исказился бы.

const OUTCOMES = [
  { key: 'running', label: 'идёт', color: 'var(--status-active)' },
  { key: 'succeeded', label: 'принята', color: 'var(--status-done)' },
  { key: 'failed', label: 'сбой', color: 'var(--status-failed)' },
  { key: 'interrupted', label: 'прервана', color: 'var(--status-waiting)' },
] as const;

const hhmm = (ms: number) =>
  new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
/** Подпись календарной даты сервера (YYYY-MM-DD) — без пересчёта в пояс браузера. */
const dayName = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric' });
};
const agents = (n: number) => `${n} ${plural(n, 'агент', 'агента', 'агентов')}`;
const calls = (n: number) => `${n} ${plural(n, 'вызова', 'вызовов', 'вызовов')}`;
const usd = (v: number) => '$' + (v >= 100 ? v.toFixed(0) : v.toFixed(2));

type LegendItem = { label: string; color: string; dashed?: boolean };
function Legend({ items }: { items: readonly LegendItem[] }) {
  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-xs" aria-hidden="true">
      {items.map((i) => (
        <li key={i.label} className="text-muted-foreground flex items-center gap-1.5">
          {i.dashed ? (
            <span
              className="inline-block w-3 border-t-2 border-dashed"
              style={{ borderColor: i.color }}
            />
          ) : (
            <span className="inline-block size-2.5 rounded-sm" style={{ background: i.color }} />
          )}
          {i.label}
        </li>
      ))}
    </ul>
  );
}

/** Подписи оси времени под графиком: начало, середина, конец. */
function TimeAxis({ from, to }: { from: number; to: number }) {
  return (
    <div className="text-muted-foreground tabular flex justify-between text-xs" aria-hidden="true">
      <span>{hhmm(from)}</span>
      <span>{hhmm((from + to) / 2)}</span>
      <span>{hhmm(to)}</span>
    </div>
  );
}

/** Рамка графика: подпись с текстовой сводкой, сам график и скрытая таблица. */
function Figure({
  title,
  summary,
  children,
  table,
}: {
  title: string;
  summary: string;
  children: ReactNode;
  table: ReactNode;
}) {
  const id = useId();
  return (
    <figure className="m-0 grid min-w-0 content-start gap-1.5" aria-labelledby={id}>
      <figcaption id={id} className="grid gap-0.5">
        <span className="font-medium">{title}</span>
        <span className="text-muted-foreground text-xs">{summary}</span>
      </figcaption>
      {children}
      <div className="sr-only">{table}</div>
    </figure>
  );
}

const W = 960;
const H = 120;

/** Подпись поверх графика на высоте `value` шкалы `max` (у левого края). */
function Mark({ value, max, children }: { value: number; max: number; children: ReactNode }) {
  return (
    <span
      className="bg-card text-muted-foreground tabular pointer-events-none absolute left-0 translate-y-1/2 rounded-sm px-1 text-xs leading-4"
      style={{ bottom: `${Math.min(100, (value / max) * 100)}%` }}
      aria-hidden="true"
    >
      {children}
    </span>
  );
}

/**
 * Столбики со стеком: ширина — доля `fill` интервала, высота — от общей
 * шкалы `max`. Каждый столбик несёт подсказку `<title>`; линия `limit` —
 * пунктиром поверх столбиков.
 */
function Stacked({
  rows,
  colors,
  max,
  titles,
  limit,
  fill = 0.7,
}: {
  rows: number[][];
  colors: readonly string[];
  max: number;
  titles: string[];
  limit?: number;
  fill?: number;
}) {
  const step = W / rows.length;
  const width = Math.max(2, step * fill);
  const y = (v: number) => (v / max) * (H - 2);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="block h-32 w-full"
      aria-hidden="true"
      focusable="false"
    >
      <line
        x1="0"
        x2={W}
        y1={H - 0.5}
        y2={H - 0.5}
        stroke="var(--border)"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
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
                  x={i * step + (step - width) / 2}
                  y={base}
                  width={width}
                  // Зазор цвета листа между сегментами стека.
                  height={Math.max(h - 1.5, 1)}
                  fill={colors[k]}
                />
              );
            })}
          </g>
        );
      })}
      {limit !== undefined && limit <= max && (
        <line
          x1="0"
          x2={W}
          y1={H - y(limit)}
          y2={H - y(limit)}
          stroke="var(--text-secondary)"
          strokeWidth="1.5"
          strokeDasharray="6 4"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

/**
 * Нагрузка агентов за сутки: пик одновременных попыток по 15 минут —
 * сплошные столбики без зазора (читаются как область) со стеком исходов,
 * пунктир слотов с подписью и точка текущего значения у правого края.
 */
export function LoadChart({ load, concurrency }: { load: HomeLoad; concurrency: number }) {
  const from = Date.parse(load.from);
  const totals = load.peaks.map((p) => p[0] + p[1] + p[2] + p[3]);
  const peak = Math.max(0, ...totals);
  const at = totals.indexOf(peak);
  const now = load.current;
  const max = Math.max(peak, concurrency, now, 1);
  const start = (i: number) => from + i * load.bucketMs;
  const split = (p: number[]) =>
    OUTCOMES.flatMap((o, k) => (p[k] ? [`${o.label} ${p[k]}`] : [])).join(', ');
  const titles = load.peaks.map(
    (p, i) =>
      `${hhmm(start(i))}–${hhmm(start(i + 1))}: ${totals[i] ? `пик ${agents(totals[i])} (${split(p)})` : 'никто не работал'}`,
  );
  const summary = peak
    ? `Пик ${agents(peak)} в ${hhmm(start(at))}, сейчас ${now}; слотов ${concurrency}.`
    : `За сутки агенты не работали; сейчас ${now}; слотов ${concurrency}.`;
  const busy = load.peaks.map((p, i) => ({ p, i })).filter(({ i }) => totals[i] > 0);
  return (
    <Figure
      title="Нагрузка агентов за сутки"
      summary={summary}
      table={
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
      }
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-1.5">
        <div className="relative mt-2">
          <Stacked
            rows={load.peaks}
            colors={OUTCOMES.map((o) => o.color)}
            max={max}
            titles={titles}
            limit={concurrency}
            fill={1}
          />
          <Mark value={concurrency} max={max}>
            слоты {concurrency}
          </Mark>
        </div>
        {/* Текущее значение — точка на шкале у правого края. */}
        <div className="relative mt-2 w-6" aria-hidden="true">
          <span
            className="absolute left-0 flex translate-y-1/2 items-center gap-1 text-xs leading-4 font-semibold"
            style={{ bottom: `${(now / max) * 100}%` }}
            data-current={now}
          >
            <span
              className="border-card inline-block size-2.5 rounded-full border-2"
              style={{ background: 'var(--status-active)' }}
            />
            {now}
          </span>
        </div>
        <TimeAxis from={from} to={Date.parse(load.to)} />
      </div>
      <Legend
        items={[
          ...OUTCOMES,
          { label: 'слоты', color: 'var(--text-secondary)', dashed: true },
          { label: 'точка — сейчас', color: 'var(--status-active)' },
        ]}
      />
    </Figure>
  );
}

const HOURLY = [
  { label: 'без сбоя', color: 'var(--status-ready)' },
  { label: 'со сбоем', color: 'var(--status-failed)' },
] as const;

/** Начатые попытки по часам за сутки, сбои — верхней частью столбика. */
export function HourlyChart({ load }: { load: HomeLoad }) {
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
    <Figure
      title="Попытки по часам"
      summary={summary}
      table={
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
      }
    >
      <div className="relative mt-2">
        <Stacked
          rows={rows}
          colors={HOURLY.map((x) => x.color)}
          max={Math.max(most, 1)}
          titles={titles}
        />
        {most > 0 && (
          <Mark value={most} max={most}>
            {most}
          </Mark>
        )}
      </div>
      <TimeAxis from={from} to={Date.parse(load.to)} />
      <Legend items={HOURLY} />
    </Figure>
  );
}

const GATES = [
  { label: 'прошло', color: 'var(--status-done)' },
  { label: 'отказ', color: 'var(--status-failed)' },
  { label: 'взято из кандидата', color: 'var(--status-waiting)' },
] as const;

/** Записи проверок по часам за сутки: прошло, отказ, взято из кандидата. */
export function GateTrendChart({ trend }: { trend: HomeGateTrend }) {
  const from = Date.parse(trend.from);
  const start = (i: number) => from + i * 3_600_000;
  const sum = (k: number) => trend.hourly.reduce((s, row) => s + row[k], 0);
  const [passed, failed, reused] = [sum(0), sum(1), sum(2)];
  const totals = trend.hourly.map((r) => r[0] + r[1] + r[2]);
  const most = Math.max(0, ...totals);
  const worst = Math.max(0, ...trend.hourly.map((r) => r[1]));
  const worstAt = trend.hourly.findIndex((r) => r[1] === worst);
  // Отказы — у основания: их высоту видно и при большом числе прошедших.
  const rows = trend.hourly.map(([p, f, r]) => [f, p, r]);
  const colors = [GATES[1].color, GATES[0].color, GATES[2].color];
  const titles = trend.hourly.map(
    ([p, f, r], i) =>
      `${hhmm(start(i))}–${hhmm(start(i + 1))}: прошло ${p}, отказов ${f}, взято из кандидата ${r}`,
  );
  const summary =
    passed + failed + reused
      ? `Прошло ${passed}, отказов ${failed}, взято из кандидата ${reused}` +
        (worst ? `; больше всего отказов в ${hhmm(start(worstAt))} (${worst}).` : '; отказов нет.')
      : 'За сутки проверки не запускались.';
  return (
    <Figure
      title="Проверки по часам"
      summary={summary}
      table={
        <table>
          <caption>Записи проверок по часам</caption>
          <thead>
            <tr>
              <th scope="col">Час</th>
              {GATES.map((g) => (
                <th key={g.label} scope="col">
                  {g.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {trend.hourly.map((row, i) =>
              totals[i] ? (
                <tr key={i}>
                  <th scope="row">{hhmm(start(i))}</th>
                  {row.map((v, k) => (
                    <td key={k}>{v}</td>
                  ))}
                </tr>
              ) : null,
            )}
          </tbody>
        </table>
      }
    >
      <div className="relative mt-2">
        <Stacked rows={rows} colors={colors} max={Math.max(most, 1)} titles={titles} />
        {most > 0 && (
          <Mark value={most} max={most}>
            {most}
          </Mark>
        )}
      </div>
      <TimeAxis from={from} to={Date.parse(trend.to)} />
      <Legend items={GATES} />
    </Figure>
  );
}

/**
 * Расход по дням за неделю. С денежным пределом workspace — накопленная
 * сумма против предела: столбик дня — потрачено раньше и за день, пунктир —
 * предел. Без предела — сумма за день. Вызовы с неизвестной стоимостью
 * названы под днём: при них сумма — нижняя граница.
 */
export function SpendChart({ spend, estimate }: { spend: HomeSpend; estimate: string }) {
  const limit = spend.limitUsd;
  let running = spend.beforeUsd;
  const rows = spend.days.map((d) => {
    const row = limit !== undefined ? [running, d.usd] : [d.usd];
    running += d.usd;
    return row;
  });
  const week = spend.days.reduce((s, d) => s + d.usd, 0);
  const unknown = spend.days.reduce((s, d) => s + d.unknown, 0) + spend.beforeUnknown;
  const total = running;
  const top = Math.max(...rows.map((r) => r.reduce((a, b) => a + b, 0)), limit ?? 0, 0.01);
  const colors =
    limit !== undefined ? ['var(--canvas-edge)', 'var(--data-accent)'] : ['var(--data-accent)'];
  const items: LegendItem[] =
    limit !== undefined
      ? [
          { label: 'раньше', color: colors[0] },
          { label: 'за день', color: colors[1] },
          { label: 'предел workspace', color: 'var(--text-secondary)', dashed: true },
        ]
      : [{ label: 'за день', color: colors[0] }];
  const titles = spend.days.map(
    (d, i) =>
      `${dayName(d.date)}: ${usd(d.usd)}, вызовов ${d.calls}` +
      (d.unknown ? `, стоимость неизвестна у ${calls(d.unknown)}` : '') +
      (limit !== undefined ? `; всего к концу дня ${usd(rows[i][0] + d.usd)}` : ''),
  );
  const summary =
    `За неделю ${usd(week)}` +
    (limit !== undefined
      ? `, всего ${usd(total)} из предела ${usd(limit)} (${Math.round((total / limit) * 100)}%)`
      : '; денежный предел workspace не задан') +
    (unknown ? `; стоимость неизвестна у ${calls(unknown)} — суммы занижены` : '') +
    `. ${estimate[0].toUpperCase()}${estimate.slice(1)}.`;
  return (
    <Figure
      title="Расход по дням"
      summary={summary}
      table={
        <table>
          <caption>Расход вызовов моделей по дням</caption>
          <thead>
            <tr>
              <th scope="col">День</th>
              <th scope="col">Сумма, USD</th>
              <th scope="col">Вызовов</th>
              <th scope="col">Стоимость неизвестна</th>
              {limit !== undefined && <th scope="col">Всего к концу дня, USD</th>}
            </tr>
          </thead>
          <tbody>
            {spend.days.map((d, i) => (
              <tr key={d.start}>
                <th scope="row">{dayName(d.date)}</th>
                <td>{d.usd.toFixed(2)}</td>
                <td>{d.calls}</td>
                <td>{d.unknown}</td>
                {limit !== undefined && <td>{(rows[i][0] + d.usd).toFixed(2)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      <div className="relative mt-2">
        <Stacked rows={rows} colors={colors} max={top} titles={titles} limit={limit} fill={0.55} />
        {(limit !== undefined || week > 0) && (
          <Mark value={limit ?? top} max={top}>
            {limit !== undefined ? `предел ${usd(limit)}` : usd(top)}
          </Mark>
        )}
      </div>
      <ol
        className="text-muted-foreground tabular m-0 grid list-none p-0 text-center text-xs"
        style={{ gridTemplateColumns: `repeat(${spend.days.length}, minmax(0, 1fr))` }}
        aria-hidden="true"
      >
        {spend.days.map((d) => (
          <li key={d.start} className="grid min-w-0">
            <span className="truncate">{dayName(d.date)}</span>
            {d.unknown > 0 && <span className="text-warning truncate">?{d.unknown}</span>}
          </li>
        ))}
      </ol>
      <Legend items={items} />
      {unknown > 0 && (
        <p className="text-muted-foreground m-0 text-xs" aria-hidden="true">
          ?N под днём — у N вызовов стоимость неизвестна
        </p>
      )}
    </Figure>
  );
}

/**
 * Кольцо доли: дуга `done / total` и процент в центре. Доступное имя —
 * `label` с долей текстом; цвет не единственный носитель.
 */
export function Ring({
  done,
  total,
  label,
  tone = 'var(--status-done)',
}: {
  done: number;
  total: number;
  label: string;
  tone?: string;
}) {
  const r = 16;
  const c = 2 * Math.PI * r;
  const part = total ? Math.min(1, done / total) : 0;
  return (
    <span
      role="img"
      aria-label={`${label}: ${done} из ${total}`}
      className="relative inline-grid size-12 shrink-0 place-items-center"
    >
      <svg viewBox="0 0 40 40" className="absolute inset-0 size-full -rotate-90" aria-hidden="true">
        <circle cx="20" cy="20" r={r} fill="none" stroke="var(--surface-active)" strokeWidth="5" />
        {part > 0 && (
          <circle
            cx="20"
            cy="20"
            r={r}
            fill="none"
            stroke={tone}
            strokeWidth="5"
            strokeLinecap={part < 1 ? 'round' : 'butt'}
            strokeDasharray={`${c * part} ${c}`}
          />
        )}
      </svg>
      <span
        className="tabular relative text-[0.6875rem] leading-none font-semibold"
        aria-hidden="true"
      >
        {!total ? (
          '—'
        ) : part >= 1 ? (
          <Check className="size-4" strokeWidth={3} />
        ) : (
          `${Math.floor(part * 100)}%`
        )}
      </span>
    </span>
  );
}

type Readiness = HomeProgress['releases'][number]['readiness'];
const readinessTone: Record<Readiness, string> = {
  done: 'bg-success',
  failed: 'bg-destructive',
  'in-progress': 'bg-info',
  unplanned: 'bg-control',
};
const readinessLabel: Record<Readiness, string> = {
  done: 'готов',
  failed: 'есть сбой',
  'in-progress': 'в работе',
  unplanned: 'не начат',
};

/**
 * Общий ход работ над плитками: выполненные задачи из живых (без отменённых)
 * и мини-полосы релизов — постановки или карты продукта.
 */
export function OverallProgress({ progress }: { progress: HomeProgress }) {
  const { tasks } = progress;
  const live = tasks.total - tasks.cancelled;
  const map = progress.releasesFrom === 'product-map';
  return (
    <section
      aria-label="Общий ход работ"
      className="bg-card grid min-w-0 gap-3 rounded-md border p-4 text-sm"
    >
      <Bar done={tasks.done} total={live} label="Выполнено задач" />
      {progress.releases.length > 0 && (
        <ul
          className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-x-6 gap-y-2 p-0"
          aria-label={map ? 'Релизы карты продукта' : 'Релизы'}
        >
          {progress.releases.map((r) => {
            const measured = r.measured !== false;
            const percent = !measured
              ? r.readiness === 'done'
                ? 100
                : 0
              : r.tasks
                ? Math.round((r.done / r.tasks) * 100)
                : 0;
            const unit = r.unit === 'features' ? 'фич' : 'задач';
            return (
              <li key={r.id} className="grid min-w-0 gap-1">
                <span className="flex min-w-0 items-baseline justify-between gap-2 text-xs">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span
                      className={cn(
                        'inline-block size-2 shrink-0 rounded-full',
                        readinessTone[r.readiness],
                      )}
                      aria-hidden="true"
                    />
                    <span className="truncate" title={r.title}>
                      {r.id} {r.title}
                    </span>
                  </span>
                  <span className="text-muted-foreground tabular shrink-0">
                    {measured ? `${r.done}/${r.tasks} ${unit} · ` : ''}
                    {readinessLabel[r.readiness]}
                  </span>
                </span>
                <span
                  className={cn(
                    'bg-active block h-2 overflow-hidden rounded-full',
                    !measured && r.readiness !== 'done' && 'border-control border border-dashed',
                  )}
                  role="progressbar"
                  aria-valuenow={percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuetext={
                    measured
                      ? `${r.done} из ${r.tasks} ${unit}, ${readinessLabel[r.readiness]}`
                      : `${readinessLabel[r.readiness]}; фичи этого релиза карта не считает`
                  }
                  aria-label={`Релиз ${r.id} ${r.title}`}
                >
                  <span
                    className={cn('block h-full rounded-full', readinessTone[r.readiness])}
                    style={{ width: percent + '%' }}
                  />
                </span>
              </li>
            );
          })}
          {progress.releasesTotal > progress.releases.length && (
            <li className="text-muted-foreground self-end text-xs">
              и ещё релизов: {progress.releasesTotal - progress.releases.length}
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
