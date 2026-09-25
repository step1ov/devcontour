import type { DevContour } from '../core/service.ts';
import type { ChangeSet, DevContourState, Task } from '../core/model.ts';
import { LeadWorkflow } from '../core/lead-workflow.ts';
import { repositories } from '../core/repositories.ts';
import { servingPreview, type Preview } from '../core/preview.ts';
import { currentVerification } from '../core/delivery.ts';
import { usageTotals, type UsageRecord } from '../core/usage.ts';

/**
 * Сводка для автора продукта.
 *
 * Автор идеи не должен разбирать leases, Run, ChangeSet и UUID зависимостей,
 * чтобы понять, что с его продуктом. Сводка отвечает на его вопросы: что
 * можно попробовать и где; что изменилось; какое решение нужно от него;
 * сколько потрачено; почему работа стоит и что делает система. Технические
 * подробности остаются доступны по ссылкам, но не в первой строке.
 *
 * Решения разделены по природе, потому что их принимают разные люди и
 * по-разному: продуктовый выбор — автор; техническое исправление — ведущий
 * агент; внешний доступ — тот, у кого есть учётная запись.
 */
export type DecisionKind = 'product' | 'technical' | 'access';
export interface Decision {
  kind: DecisionKind;
  title: string;
  detail: string;
  action?:
    | { type: 'accept-changeset'; changeSetId: string }
    | { type: 'deploy-preview'; changeSetId: string }
    | { type: 'resume-queue' };
  /** Технические идентификаторы — для раскрытия, не для первой строки. */
  refs?: string[];
}
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
  };
  preview: {
    configured: boolean;
    deploying?: { changeSetTitle: string; status: Preview['status'] };
    lastFailure?: { changeSetTitle: string; error: string; rolledBack: boolean; at?: string };
    canRollback: boolean;
  };
  changes: {
    title: string;
    kind: 'changeset' | 'board';
    status: 'accepted' | 'verified' | 'in-progress';
    at?: string;
  }[];
  decisions: Decision[];
  spend: {
    calls: number;
    knownCostUsd: number;
    /** Вызовы без известной стоимости: сумма выше — нижняя граница. */
    unknownCalls: number;
    complete: boolean;
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
  const lastPreview = s.previews?.at(-1);
  const failure = lastPreview?.status === 'failed' ? lastPreview : undefined;

  const decisions: Decision[] = [];
  // Внешний доступ: выдача остановлена отказом провайдера — ни повтор, ни
  // агент этого не исправят, нужен человек с учётной записью.
  if (s.paused && s.pauseReason === 'runtime' && s.pauseFailures?.includes('provider-auth'))
    decisions.push({
      kind: 'access',
      title: 'Нужен доступ к провайдеру моделей',
      detail:
        'Исполнитель не авторизован или закончился баланс. Авторизуйте CLI исполнителя или пополните баланс, затем продолжите выдачу.',
      action: { type: 'resume-queue' },
    });
  if (failure && /docker/i.test(failure.error ?? ''))
    decisions.push({
      kind: 'access',
      title: 'Нужен Docker для preview',
      detail: 'Preview собирается и запускается в Docker. Запустите Docker и повторите выкладку.',
    });
  // Продуктовые решения: проверенное изменение ждёт приёмки автора.
  for (const c of s.changeSets)
    if (!c.acceptance && verified(h, s, c)) {
      const onPreview =
        serving?.changeSetId === c.id && serving.verificationId === c.verifications.at(-1)?.id;
      decisions.push({
        kind: 'product',
        title: `Принять «${c.title}»`,
        detail: onPreview
          ? 'Изменение прошло совместную проверку и работает в preview: попробуйте и примите.'
          : 'Изменение прошло совместную проверку. Можно выложить его в preview и попробовать до приёмки.',
        action: onPreview
          ? { type: 'accept-changeset', changeSetId: c.id }
          : h.config.preview
            ? { type: 'deploy-preview', changeSetId: c.id }
            : { type: 'accept-changeset', changeSetId: c.id },
        refs: [c.id],
      });
    }
  // Технические исправления: восстановление остановлено — дальше нужен
  // ведущий агент, автору достаточно знать почему.
  for (const w of new LeadWorkflow(h).view())
    if (w.status === 'failed' && w.error)
      decisions.push({
        kind: 'technical',
        title: 'Автоматическое восстановление остановлено',
        detail: w.error,
        refs: [w.id],
      });
  if (failure && !/docker/i.test(failure.error ?? ''))
    decisions.push({
      kind: 'technical',
      title: 'Preview не выложен',
      detail:
        (failure.rolledBack ? 'Возвращена прежняя версия. ' : '') +
        (failure.error ?? 'Причина не записана'),
      refs: [failure.changeSetId],
    });

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
    ...s.boards.map((b) => {
      const r = b.revisions.at(-1)!;
      return {
        title: b.title,
        kind: 'board' as const,
        status: r.status === 'accepted' ? ('accepted' as const) : ('in-progress' as const),
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
      }
    : undefined;
  const headline =
    !counts.tasks && !s.changeSets.length
      ? 'Разработка ещё не началась: задач пока нет.'
      : decisions.some((d) => d.kind === 'access')
        ? 'Работа стоит: нужен внешний доступ.'
        : decisions.some((d) => d.kind === 'product')
          ? 'Нужно ваше решение по готовому изменению.'
          : tryNow
            ? 'Проверенную версию можно попробовать.'
            : decisions.some((d) => d.kind === 'technical')
              ? 'Работа остановилась на технической проблеме; её разбирает ведущий агент.'
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
      canRollback: !!serving?.previous,
    },
    changes,
    decisions,
    spend: {
      calls: totals.calls,
      knownCostUsd: totals.knownCostUsd,
      unknownCalls: totals.unknownCalls,
      complete: totals.complete,
    },
    activity: { running, paused: s.paused, doing },
    counts,
  };
}
