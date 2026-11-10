import type { DevContour } from '../core/service.ts';
import type { ChangeSet, DevContourState, Task } from '../core/model.ts';
import { boardPhase } from '../core/work-status.ts';
import { repositories } from '../core/repositories.ts';
import { servingPreview, type Preview } from '../core/preview.ts';
import { currentVerification } from '../core/delivery.ts';
import { usageTotals, type UsageRecord } from '../core/usage.ts';
import { budgetOverview } from '../harness/budget.ts';

/**
 * Сводка для автора продукта.
 *
 * Автор идеи не должен разбирать leases, Run, ChangeSet и UUID зависимостей,
 * чтобы понять, что с его продуктом. Сводка отвечает на его вопросы: что
 * можно попробовать и где; что изменилось; сколько потрачено; почему работа
 * стоит и что делает система. Технические подробности остаются доступны по
 * ссылкам, но не в первой строке.
 *
 * Решения, которые ждут автора или ведущего агента, — карточки центра
 * внимания (`AttentionService`): одна очередь вместо второго списка здесь.
 * Правила приёмки, неисправностей preview и остановленных workflow
 * экспортируются отсюда и служат его источникам.
 */
export interface AuthorOverview {
  headline: string;
  /** Что можно открыть и попробовать прямо сейчас. */
  tryNow?: {
    url: string;
    changeSetTitle: string;
    release: string;
    /** confirmed — пользовательский сценарий прошёл; иначе здоровье подтверждено, сценарий — нет. */
    scenario: 'confirmed' | 'unconfirmed';
    since?: string;
    /** Когда здоровье последний раз подтверждено на деле: это не непрерывный мониторинг. */
    checkedAt?: string;
  };
  preview: {
    configured: boolean;
    deploying?: { changeSetTitle: string; status: Preview['status'] };
    lastFailure?: { changeSetTitle: string; error: string; rolledBack: boolean; at?: string };
    /** Версия в preview перестала отвечать и не восстановилась: состояние URL неизвестно. */
    lost?: { changeSetTitle: string; reason: string };
    canRollback: boolean;
  };
  changes: {
    title: string;
    kind: 'changeset' | 'board';
    status: 'accepted' | 'verified' | 'in-progress' | 'planned';
    at?: string;
  }[];
  spend: {
    calls: number;
    knownCostUsd: number;
    /** Вызовы без известной стоимости: сумма выше — нижняя граница. */
    unknownCalls: number;
    complete: boolean;
    /** Сообщено провайдером и оценено по тарифу — отдельно. */
    reportedUsd: number;
    estimatedUsd: number;
    /** Вызовы, прерванные падением процесса. */
    abandonedCalls: number;
    /** Бюджеты, если настроены. */
    budgets?: ReturnType<typeof budgetOverview>;
  };
  activity: {
    running: string[];
    paused: boolean;
    /** Что делает система — одной фразой. */
    doing: string;
  };
  counts: { tasks: number; done: number; failed: number; cancelled: number };
}

const title = (s: DevContourState, changeSetId: string) =>
  s.changeSets.find((c) => c.id === changeSetId)?.title ?? 'Изменение';

function verified(h: DevContour, s: DevContourState, c: ChangeSet) {
  try {
    return currentVerification(h, s, c);
  } catch {
    return undefined;
  }
}

/** Проверенное непринятое изменение и работает ли та же версия в preview. */
export function pendingAcceptances(h: DevContour, s: DevContourState) {
  const serving = servingPreview(s);
  return s.changeSets.flatMap((c) => {
    const v = !c.acceptance ? verified(h, s, c) : undefined;
    if (!v) return [];
    // В preview работает та же версия, если совпадает manifest: повторная
    // проверка того же кода или другой ChangeSet с тем же кодом не требуют
    // новой выкладки.
    const onPreview = !!serving && serving.manifestDigest === v.manifestDigest;
    return [{ changeSet: c, verification: v, onPreview }];
  });
}

/**
 * Неисправности preview сейчас: последняя выкладка упала (`failure`) или
 * версия, занимающая URL, перестала отвечать (`lost`).
 */
export function previewProblems(s: DevContourState) {
  const lastPreview = s.previews?.at(-1);
  const failure = lastPreview?.status === 'failed' ? lastPreview : undefined;
  // Неисправность — свойство того, кто занимает URL сейчас, а не истории.
  // Последняя потерянная выкладка из всей истории продолжала называться
  // «не отвечает» и после того, как её сменила здоровая. Занимающая URL —
  // последняя выкладка, дошедшая до обслуживания; потерянной она делает
  // текущий отказ, прежние отказы остаются в истории.
  const occupant = s.previews?.findLast(
    (p) =>
      (p.status === 'healthy' || p.status === 'confirmed' || p.status === 'unconfirmed') &&
      !p.active,
  );
  const lost = occupant?.lost ? occupant : undefined;
  return { failure, lost };
}

/**
 * Упавшие workflow ведущего, которые ещё требуют решения: не вытеснены
 * новым workflow того же предмета, доска не принята и не отменена целиком,
 * ChangeSet не принят.
 */
export function stoppedWorkflows<
  W extends {
    id: string;
    key: string;
    kind: string;
    status: string;
    error?: string;
    startedAt: string;
  },
>(s: DevContourState, jobs: readonly W[]): W[] {
  const tasks = s.tasks.filter((t: Task) => t.status !== 'cancelled');
  // Упавший workflow, чья работа ушла дальше, решения не требует: доска
  // принята или вся её работа отменена, либо по тому же входу запущен новый
  // workflow. На пилоте три таких записи после перепланирования держали
  // заголовок «нужен разбор», пока исполнители работали.
  const superseded = (w: W) => {
    // Решение относится к последнему workflow доски или ChangeSet: прежний,
    // упавший раньше, — история, даже если упал и новый. Иначе панель
    // показывала устаревший отказ рядом с актуальным.
    if (jobs.some((x) => x.id === w.id && x.key !== w.key && x.startedAt > w.startedAt))
      return true;
    if (w.kind === 'board') {
      const board = s.boards.find((b) => b.id === w.id);
      const r = board?.revisions.at(-1);
      if (!board || !r || r.status === 'accepted') return true;
      return !tasks.some((t) => r.taskIds.includes(t.id) && t.status !== 'cancelled');
    }
    const c = s.changeSets.find((c) => c.id === w.id);
    if (!c || c.acceptance) return true;
    // ChangeSet закрыт другим, созданным позже и принятым: того же
    // продуктового релиза или включающим все его доски. Операции закрытия у
    // ChangeSet нет, и без этого карточка упавшего задания оставалась
    // навсегда — после ручного маршрута и после нового ChangeSet. Принятый
    // раньше ChangeSet упавший не закрывает: упавший — продолжение после
    // него (следующий ChangeSet того же релиза), и его остановка — решение.
    return s.changeSets.some(
      (x) =>
        x.id !== c.id &&
        !!x.acceptance &&
        x.createdAt > c.createdAt &&
        ((!!c.releaseId && x.releaseId === c.releaseId) ||
          c.boardIds.every((id) => x.boardIds.includes(id))),
    );
  };
  return jobs.filter((w) => w.status === 'failed' && w.error && !superseded(w));
}

/**
 * Остановка задания ChangeSet словами оператора: причина задания, итог
 * последней совместной проверки (прерванная до первого gate — отдельно: она
 * не дала результата о коде, но расходует предел проверок набора) и пути.
 * Прежде карточка повторяла лишь «Исчерпаны попытки стадии».
 */
export function changeSetStopReason(
  s: DevContourState,
  w: { id: string; key: string; error?: string; attempts: number; maxAttempts: number },
) {
  const c = s.changeSets.find((x) => x.id === w.id);
  const last = c?.verifications.at(-1);
  const parts = [`Задание ChangeSet ${w.id} остановлено: ${w.error ?? 'без причины'}.`];
  if (last)
    parts.push(
      `Последняя совместная проверка ${last.id}: ${last.status}` +
        (last.error ? ` — ${last.error}` : '') +
        (last.status === 'failed' && !last.evidence.length
          ? ' (прервана до первого gate: результата о коде нет, но предел проверок набора расходует)'
          : '') +
        '.',
    );
  parts.push(
    (w.attempts < w.maxAttempts
      ? `Когда причина устранена — workflow_retry {"key": ${JSON.stringify(w.key)}}. `
      : 'Попытки задания исчерпаны: workflow_retry его не примет. ') +
      `Ручной путь: devcontour workspace-verify --changeset ${w.id}, затем changeset-accept --changeset ${w.id}. ` +
      'Если исчерпан предел совместных проверок набора задач, новый ChangeSet над теми же задачами получит тот же отказ: измените набор (новая ревизия доски), примите доску и создайте ChangeSet по ней. ' +
      'Карточка закрывается, когда принят этот ChangeSet или созданный после него ChangeSet того же релиза (или включающий его доски).',
  );
  return parts.join(' ');
}

/** Заголовок отказа выкладки preview по его классу: сборка — не выкладка. */
export function previewFailureTitle(failure: Preview['failure']) {
  return failure === 'compose-policy'
    ? 'Preview не выложен: Compose выходит за границы preview'
    : failure === 'build'
      ? 'Preview не собрался'
      : 'Preview не выложен';
}

export function authorOverview(h: DevContour): AuthorOverview {
  const s = h.store.read();
  const tasks = s.tasks.filter((t: Task) => t.status !== 'cancelled');
  const counts = {
    tasks: tasks.length,
    done: tasks.filter((t) => t.status === 'done').length,
    failed: tasks.filter((t) => t.status === 'failed').length,
    cancelled: s.tasks.length - tasks.length,
  };
  const serving = servingPreview(s);
  const deploying = s.previews?.find((p) => p.active && p.leaseUntil > Date.now());
  const { failure, lost } = previewProblems(s);
  const running = tasks.filter((t) => t.activeRunId).map((t) => t.title);
  const verifying = s.changeSets.some((c) => c.verifications.some((v) => v.status === 'active'));
  const doing = deploying
    ? `Выкладывается preview «${title(s, deploying.changeSetId)}»`
    : running.length
      ? `Исполнители работают над задачами: ${running.length}`
      : verifying
        ? 'Идёт совместная проверка изменения'
        : s.paused
          ? s.pauseReason === 'runtime'
            ? 'Выдача остановлена системой'
            : s.pauseReason === 'reconfigure'
              ? 'Применяется новая конфигурация после изменения контракта'
              : 'Выдача задач на паузе'
          : counts.tasks && counts.done === counts.tasks
            ? 'Все задачи выполнены'
            : 'Ждёт работы';

  const records = [undefined, ...repositories(h.config).map((r) => r.id)].flatMap((owner) =>
    Object.values(h.store.localRecords<UsageRecord>('usage', owner)),
  );
  const totals = usageTotals(records);

  const changes: AuthorOverview['changes'] = [
    ...s.changeSets.map((c) => ({
      title: c.title,
      kind: 'changeset' as const,
      status: c.acceptance
        ? ('accepted' as const)
        : verified(h, s, c)
          ? ('verified' as const)
          : ('in-progress' as const),
      at: c.acceptance?.at ?? c.verifications.at(-1)?.finishedAt,
    })),
    // Доска, вся работа которой отменена, — след перепланирования, а не
    // изменение продукта: на пилоте семь таких досок значились «в работе».
    ...s.boards
      .filter((b) => {
        const ids = new Set(b.revisions.flatMap((r) => r.taskIds));
        const own = s.tasks.filter((t) => ids.has(t.id));
        return !own.length || own.some((t) => t.status !== 'cancelled');
      })
      .map((b) => {
        const r = b.revisions.at(-1)!;
        // Черновой план — ещё не работа: «в работе» звало ждать результата.
        const phase = boardPhase(b, s.tasks);
        return {
          title: b.title,
          kind: 'board' as const,
          status:
            r.status === 'accepted'
              ? ('accepted' as const)
              : phase === 'draft'
                ? ('planned' as const)
                : ('in-progress' as const),
          at: r.acceptedAt ?? r.createdAt,
        };
      }),
  ]
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
    .slice(0, 8);

  const tryNow = serving
    ? {
        url: serving.url!,
        changeSetTitle: title(s, serving.changeSetId),
        release: serving.release,
        scenario:
          serving.status === 'confirmed' ? ('confirmed' as const) : ('unconfirmed' as const),
        since: serving.healthyAt,
        checkedAt: serving.checkedAt,
      }
    : undefined;
  // Решения автора и ведущего — в центре внимания; заголовок сводки без
  // них, панель дополняет его карточками центра.
  const headline =
    !counts.tasks && !counts.cancelled && !s.changeSets.length
      ? 'Разработка ещё не началась: задач пока нет.'
      : !counts.tasks && counts.cancelled
        ? `Работа отменена: отменено задач — ${counts.cancelled}.`
        : tryNow
          ? 'Проверенную версию можно попробовать.'
          : doing + '.';

  return {
    headline,
    tryNow,
    preview: {
      configured: !!h.config.preview,
      deploying: deploying
        ? { changeSetTitle: title(s, deploying.changeSetId), status: deploying.status }
        : undefined,
      lastFailure: failure
        ? {
            changeSetTitle: title(s, failure.changeSetId),
            error: failure.error ?? '',
            rolledBack: !!failure.rolledBack,
            at: failure.finishedAt,
          }
        : undefined,
      lost: lost ? { changeSetTitle: title(s, lost.changeSetId), reason: lost.lost! } : undefined,
      canRollback: !!serving?.previous,
    },
    changes,
    spend: {
      calls: totals.calls,
      knownCostUsd: totals.knownCostUsd,
      unknownCalls: totals.unknownCalls,
      complete: totals.complete,
      reportedUsd: totals.reportedUsd,
      estimatedUsd: totals.estimatedUsd,
      abandonedCalls: totals.abandonedCalls,
      budgets: budgetOverview(h),
    },
    activity: { running, paused: s.paused, doing },
    counts,
  };
}
