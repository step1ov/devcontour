// Отчёт об эффекте: расчёт и отрисовка — общие функции devcontour-harness
// (`valueReport`, `reportMarkdown`, `reportHtml`) над тем же входом, что
// `harness report`: проекции исполнения DevContour (`collectReportInput`
// поверх адаптера хранилища). Вмешательства, которые harness-вход не
// принимает (явные повторы и сбросы бюджета попыток, перенос базы, паузы
// оператора, отмены, возвраты и корректировки), читаются из журнала
// DevContour и выводятся отдельным приложением: JSON отчёта harness не
// меняется и не дополняется полями.
import {
  collectReportInput,
  reportHtml,
  reportMarkdown,
  valueReport,
  type GraphState,
  type RunEvent,
  type ValueReport,
  type ValueReportInput,
} from 'devcontour-harness';
import { z } from 'zod';
import { DomainError } from '../core/model.ts';
import type { DevContour } from '../core/service.ts';
import { repository } from '../core/repositories.ts';
import { taskOwner } from '../core/sync-state.ts';
import { DevContourExecutionStore, harnessVersion } from '../harness/index.ts';
import { projectionOptions } from '../harness/host.ts';
import { toDomain } from '../harness/execution.ts';

export const reportFormats = ['json', 'md', 'html'] as const;
export type ReportFormat = (typeof reportFormats)[number];

export interface ReportRequest {
  /** Компонент; без него — весь workspace (компоненты не суммируются отдельно). */
  repositoryId?: string;
  since?: string;
  until?: string;
  asOf?: string;
  noTitles?: boolean;
}

/** Доля «k из n»: процент — только при знаменателе от 20 (правило отчёта harness). */
export interface HostRatio {
  value: number;
  n: number;
}

/**
 * Приложение DevContour: вмешательства из журнала контура за окно отчёта.
 * Только счётчики: причины сбросов, отмен и возвратов — свободный текст,
 * в отчёт не выводятся.
 */
export interface HostAppendix {
  source: 'devcontour-journal';
  /** Первая запись журнала: раньше вмешательства не наблюдаются. */
  journalFrom: string | null;
  /** Явные повторы задач (`task.retry`: оператор в панели или CLI, ведущий агент). */
  retries: number;
  /** Из них со сбросом бюджета попыток (`retry --reset` с причиной). */
  resets: number;
  /** Принятые в окне задачи без явного повтора до приёмки. */
  acceptedWithoutRetry: HostRatio;
  /** Принятые в окне задачи без сброса бюджета и без решения оператора по разбору. */
  acceptedWithoutResetOrDecision: HostRatio;
  /** Перенос базы прогонов вручную (`base-update`). */
  baseUpdates: number;
  /** Перемотка базы диспетчером — не вмешательство человека. */
  automaticBaseUpdates: number;
  /** Пауза очереди человеком. */
  operatorPauses: number;
  /** Отмены задач (с попытками и без). */
  cancellations: number;
  /** Возвраты задач без принятого результата в черновик. */
  reopened: number;
  /** Корректировки принятых досок: найденное после приёмки. */
  corrections: number;
}

export interface DevContourValueReport {
  /** Отчёт harness без изменений: схема `valueReportSchema` devcontour-harness. */
  report: ValueReport;
  /** Вмешательства, которых нет во входе harness: журнал DevContour. */
  host: HostAppendix;
}

const PAGE = 500;

/** Вход отчёта: весь workspace или один компонент. */
function inputOf(h: DevContour, repositoryId?: string): ValueReportInput {
  const execution = new DevContourExecutionStore(h.store, projectionOptions(h));
  const input = collectReportInput(execution);
  if (!repositoryId) return input;
  const owners = new Map(h.store.view().tasks.map((t) => [t.id, taskOwner(t)]));
  const works = input.works.filter(
    (w) => (owners.has(w.id) ? owners.get(w.id) : w.order.repositoryId) === repositoryId,
  );
  const workIds = new Set(works.map((w) => w.id));
  const attempts = input.attempts.filter((a) => workIds.has(a.workId));
  const runIds = new Set(attempts.map((a) => a.id));
  const graphIds = new Set(works.map((w) => w.graphId));
  const contracts = new Set(
    h.store
      .view()
      .contracts.filter((c) => c.repositoryId === repositoryId)
      .map((c) => c.id),
  );
  const graphs: GraphState[] = (input.graphs ?? []).filter((g) => graphIds.has(g.id));
  // Событие без поручения, попытки и графа (пауза, возобновление очереди) —
  // общее для всех компонентов: очередь одна.
  const own = (e: RunEvent) =>
    e.workId
      ? workIds.has(e.workId)
      : e.runId
        ? runIds.has(e.runId)
        : e.graphId
          ? graphIds.has(e.graphId)
          : true;
  return {
    works,
    attempts,
    graphs,
    calls: (input.calls ?? []).filter(
      (c) =>
        (c.runId && runIds.has(c.runId)) ||
        (c.workId && workIds.has(c.workId)) ||
        (!c.runId && !c.workId && c.repositoryId === repositoryId),
    ),
    reviews: (input.reviews ?? []).filter((r) =>
      r.kind === 'plan' ? graphIds.has(r.subject) : contracts.has(r.subject),
    ),
    events: (input.events ?? []).filter(own),
  };
}

const ms = (iso: string) => Date.parse(iso);

/** Вмешательства из журнала за окно `report.window`. */
function appendixOf(
  h: DevContour,
  input: ValueReportInput,
  report: ValueReport,
  repositoryId?: string,
): HostAppendix {
  const since = report.window.since ? ms(report.window.since) : -Infinity;
  const until = report.window.until ? ms(report.window.until) : Infinity;
  const inWindow = (at: string) => ms(at) >= since && ms(at) < until;
  const workIds = new Set(input.works.map((w) => w.id));
  const retriesOf = new Map<string, { at: number; reset: boolean }[]>();
  const counts = {
    retries: 0,
    resets: 0,
    baseUpdates: 0,
    automaticBaseUpdates: 0,
    operatorPauses: 0,
    cancellations: 0,
    reopened: 0,
    corrections: 0,
  };
  let journalFrom: string | null = null;
  const boards = new Set(
    repositoryId
      ? h.store
          .view()
          .boards.filter((b) => b.revisions.some((r) => r.taskIds.some((id) => workIds.has(id))))
          .map((b) => b.id)
      : [],
  );
  for (let after = 0; ;) {
    const page = h.store.eventsAfter(after, PAGE);
    for (const e of page) {
      journalFrom ??= e.at;
      const data = (e.data ?? {}) as {
        taskId?: string;
        reset?: unknown;
        reason?: string;
        boardId?: string;
        updated?: { repositoryId?: string }[];
      };
      const ownTask = !!data.taskId && workIds.has(data.taskId);
      if (e.type === 'task.retry' && ownTask) {
        const list = retriesOf.get(data.taskId!) ?? [];
        list.push({ at: ms(e.at), reset: !!data.reset });
        retriesOf.set(data.taskId!, list);
      }
      if (!inWindow(e.at)) continue;
      if (e.type === 'task.retry' && ownTask) {
        counts.retries++;
        if (data.reset) counts.resets++;
      } else if (e.type === 'base.updated') {
        if (!repositoryId || data.updated?.some((u) => u.repositoryId === repositoryId))
          counts.baseUpdates++;
      } else if (e.type === 'base.fast-forwarded') counts.automaticBaseUpdates++;
      else if (e.type === 'scheduler.paused' && data.reason === 'operator') counts.operatorPauses++;
      else if (e.type === 'task.cancelled' && ownTask) counts.cancellations++;
      else if (e.type === 'task.reopened' && ownTask) counts.reopened++;
      else if (
        e.type === 'board.corrected' &&
        (!repositoryId || (data.boardId && boards.has(data.boardId)))
      )
        counts.corrections++;
    }
    if (page.length < PAGE) break;
    after = page.at(-1)!.id;
  }
  // Принятые в окне — то же правило, что у отчёта harness: последняя успешная
  // попытка выполненного поручения, время приёмки — её конец.
  const accepted = input.works.flatMap((w) => {
    if (w.status !== 'done') return [];
    const accepting = input.attempts
      .filter((a) => a.workId === w.id && a.status === 'succeeded')
      .sort((x, y) => ms(x.startedAt) - ms(y.startedAt) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
      .at(-1);
    return accepting?.finishedAt && inWindow(accepting.finishedAt)
      ? [{ work: w, at: ms(accepting.finishedAt) }]
      : [];
  });
  const before = (id: string, at: number) => (retriesOf.get(id) ?? []).filter((r) => r.at <= at);
  const decided = (w: (typeof accepted)[number]['work']) =>
    [...(w.recoveryHistory ?? []), ...(w.recovery ? [w.recovery] : [])].some(
      (r) => r.decision?.source.kind === 'operator',
    );
  return {
    source: 'devcontour-journal',
    journalFrom,
    ...counts,
    acceptedWithoutRetry: {
      value: accepted.filter((a) => !before(a.work.id, a.at).length).length,
      n: accepted.length,
    },
    acceptedWithoutResetOrDecision: {
      value: accepted.filter(
        (a) => !before(a.work.id, a.at).some((r) => r.reset) && !decided(a.work),
      ).length,
      n: accepted.length,
    },
  };
}

/**
 * Отчёт об эффекте workspace или компонента. Только чтение: хранилище
 * может быть открыто только для чтения (CLI рядом с работающим serve).
 */
export function devcontourValueReport(
  h: DevContour,
  request: ReportRequest,
  meta: { label?: string; stateDir?: string } = {},
): DevContourValueReport {
  if (request.repositoryId) repository(h.config, request.repositoryId);
  // Снимок поручений и попыток — одним чтением, журнал — страницами вне
  // транзакции чтения (`collectReportInput`): writer рядом не ждёт отчёта.
  const input = inputOf(h, request.repositoryId);
  let report: ValueReport;
  try {
    report = valueReport(input, {
      ...(request.since ? { since: request.since } : {}),
      ...(request.until ? { until: request.until } : {}),
      ...(request.asOf ? { asOf: request.asOf } : {}),
      ...(request.noTitles ? { noTitles: true } : {}),
      harnessVersion,
      ...(meta.label
        ? { label: request.repositoryId ? `${meta.label} · ${request.repositoryId}` : meta.label }
        : {}),
      ...(meta.stateDir ? { stateDir: meta.stateDir } : {}),
    });
  } catch (error) {
    throw toDomain(error);
  }
  return { report, host: appendixOf(h, input, report, request.repositoryId) };
}

/** «k из n»; процент — только при знаменателе от 20. */
const ratio = (r: HostRatio) =>
  r.n >= 20
    ? `${r.value} из ${r.n} (${Math.round((r.value * 100) / r.n)}%)`
    : `${r.value} из ${r.n}`;

/** Строки приложения DevContour: заголовок, пояснение и пункты. */
function appendixLines(host: HostAppendix) {
  return {
    title: 'Приложение DevContour: вмешательства по журналу контура',
    note:
      'Журнал DevContour за то же окно' +
      (host.journalFrom ? ` (записи с ${host.journalFrom})` : '') +
      '. Отчёт harness этих событий не получает: в его разделе Autonomy повторы, сбросы и перенос базы — unknown. Повтор — явная команда оператора или ведущего агента; автоматические повторы движка сюда не входят. Причины не выводятся.',
    items: [
      `Явные повторы задач: ${host.retries}, из них со сбросом бюджета попыток: ${host.resets}`,
      `Принято без явного повтора: ${ratio(host.acceptedWithoutRetry)}`,
      `Принято без сброса бюджета и решения оператора по разбору: ${ratio(host.acceptedWithoutResetOrDecision)}`,
      `Перенос базы вручную: ${host.baseUpdates}; перемотка диспетчером: ${host.automaticBaseUpdates}`,
      `Паузы очереди оператором: ${host.operatorPauses}`,
      `Отмены задач: ${host.cancellations}; возвраты в черновик: ${host.reopened}; корректировки принятых досок: ${host.corrections}`,
    ],
  };
}

const escMd = (text: string) => text.replace(/[\r\n]+/g, ' ').replace(/([\\`*_[\]<>|#])/g, '\\$1');
const escHtml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Текст отчёта. JSON — `{report, host}`: `report` — отчёт harness без
 * изменений. Markdown и HTML — отрисовка harness и приложение DevContour
 * в конце; HTML остаётся самодостаточным (без скриптов и внешних ресурсов).
 */
export function renderValueReport(value: DevContourValueReport, format: ReportFormat): string {
  if (format === 'json') return JSON.stringify(value, null, 2) + '\n';
  const lines = appendixLines(value.host);
  if (format === 'md')
    return (
      reportMarkdown(value.report).replace(/\n*$/, '\n') +
      `\n## ${escMd(lines.title)}\n\n${escMd(lines.note)}\n\n` +
      lines.items.map((i) => `- ${escMd(i)}`).join('\n') +
      '\n'
    );
  const html = reportHtml(value.report);
  const section =
    `<h2>${escHtml(lines.title)}</h2>\n<p class="muted">${escHtml(lines.note)}</p>\n<ul>` +
    lines.items.map((i) => `<li>${escHtml(i)}</li>`).join('') +
    '</ul>';
  const end = html.lastIndexOf('\n</main>');
  if (end < 0) throw new DomainError('Отчёт harness: неожиданная разметка HTML', 500);
  return html.slice(0, end) + '\n' + section + html.slice(end);
}

export const parseReportFormat = (value: string | undefined): ReportFormat => {
  const format = value ?? 'json';
  if (!(reportFormats as readonly string[]).includes(format))
    throw new DomainError('format: ожидается json, md или html', 400);
  return format as ReportFormat;
};

/** Граница окна: ISO-время с поясом, дата `YYYY-MM-DD` или `7d`/`4w` (разбирает harness). */
const windowBound = z.string().trim().min(1).max(40);

/** Окно, владелец и приватность отчёта (общие для HTTP и агентского API). */
export const reportRequestInput = z.strictObject({
  repositoryId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,80}$/)
    .optional(),
  since: windowBound.optional(),
  until: windowBound.optional(),
  asOf: windowBound.optional(),
  noTitles: z.boolean().optional(),
});

/** Вход операции `value_report` агентского API. */
export const valueReportInput = reportRequestInput.extend({
  /** `summary` — без строк поручений и ссылок на evidence; `full` — с ними. */
  detail: z.enum(['summary', 'full']).default('summary'),
});

/** Предел ответа операции: каталог обещает не больше 64 KiB. */
const AGENT_REPORT_BYTES = 60_000;

/**
 * Отчёт для ведущего агента: только JSON, ограниченный по размеру. Сводка
 * (`summary`) опускает строки поручений и ссылки на evidence — списки
 * пустые, флаги усечения подняты, так что ответ по-прежнему соответствует
 * схеме отчёта harness. `full` возвращает их, если ответ укладывается в
 * предел, иначе — ту же сводку с пометкой `omitted`.
 */
export function agentValueReport(h: DevContour, input: z.infer<typeof valueReportInput>) {
  const { detail, ...request } = input;
  const value = devcontourValueReport(h, request);
  const size = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
  if (detail === 'full' && size(value) <= AGENT_REPORT_BYTES)
    return { ...value, detail: 'full', omitted: [] as string[] };
  const { report } = value;
  return {
    report: {
      ...report,
      works: { ...report.works, rows: [], truncated: report.works.total > 0 },
      defects: { ...report.defects, items: [], itemsTruncated: report.defects.itemsTotal > 0 },
    },
    host: value.host,
    detail: 'summary',
    omitted: ['report.works.rows', 'report.defects.items'],
    full: 'devcontour report --workspace <path> --format json|md|html',
  };
}
