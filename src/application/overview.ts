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
  /** Доказательства решения: проверка и выкладка, которые автор может открыть. */
  evidence?: Evidence;
}
export interface Evidence {
  changeSetId: string;
  verifiedAt?: string;
  manifestDigest?: string;
  preview?: {
    release: string;
    artifactDigest?: string;
    checkedAt?: string;
    scenario: 'confirmed' | 'unconfirmed';
    smoke?: string;
  };
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
  const lost = s.previews?.findLast((p) => p.lost);
  const evidence = (c: ChangeSet): Evidence => {
    const v = c.verifications.at(-1);
    const deployed =
      serving && v && serving.manifestDigest === v.manifestDigest ? serving : undefined;
    return {
      changeSetId: c.id,
      verifiedAt: v?.finishedAt,
      manifestDigest: v?.manifestDigest,
      preview: deployed
        ? {
            release: deployed.release,
            artifactDigest: deployed.artifactDigest,
            checkedAt: deployed.checkedAt,
            scenario: deployed.status === 'confirmed' ? 'confirmed' : 'unconfirmed',
            smoke: deployed.smoke
              ? `${deployed.smoke.summary}: ${deployed.smoke.log.slice(-400)}`
              : undefined,
          }
        : undefined,
    };
  };

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
  if (failure?.failure === 'docker-unavailable')
    decisions.push({
      kind: 'access',
      title: 'Нужен Docker для preview',
      detail: 'Preview собирается и запускается в Docker. Запустите Docker и повторите выкладку.',
    });
  // Продуктовые решения: проверенное изменение ждёт приёмки автора.
  for (const c of s.changeSets) {
    const v = !c.acceptance ? verified(h, s, c) : undefined;
    if (!v) continue;
    // В preview работает та же версия, если совпадает manifest: повторная
    // проверка того же кода или другой ChangeSet с тем же кодом не требуют
    // новой выкладки.
    const onPreview = !!serving && serving.manifestDigest === v.manifestDigest;
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
      evidence: evidence(c),
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
  if (lost)
    decisions.push({
      kind: 'technical',
      title: 'Версия в preview не отвечает',
      detail: lost.lost!,
      refs: [lost.changeSetId],
    });
  if (failure && failure.failure !== 'docker-unavailable')
    decisions.push({
      kind: 'technical',
      title:
        failure.failure === 'compose-policy'
          ? 'Preview не выложен: Compose выходит за границы preview'
          : failure.failure === 'build'
            ? 'Preview не собрался'
            : 'Preview не выложен',
      detail:
        (failure.rolledBack ? 'Возвращена прежняя версия. ' : '') +
        (failure.error ?? 'Причина не записана'),
      refs: [failure.changeSetId],
    });

  // Упавшая задача без действующего восстановления — тоже остановка, даже
  // если записи ведущего цикла нет. Зависимые от неё задачи ждут.
  const workflows = new LeadWorkflow(h).view();
  const covered = new Set(
    workflows.filter((w) => ['failed', 'queued', 'running'].includes(w.status)).map((w) => w.id),
  );
  for (const t of tasks.filter((t) => t.status === 'failed')) {
    const board = s.boards.find((b) => b.revisions.at(-1)?.taskIds.includes(t.id));
    if (board && covered.has(board.id)) continue;
    const waiting = tasks.filter((x) => x.dependsOn.includes(t.id) && x.status !== 'done').length;
    decisions.push({
      kind: 'technical',
      title: `Задача «${t.title}» не прошла`,
      detail:
        (t.failure ?? 'Причина не записана') +
        (waiting ? ` Ждут её результата: ${waiting}.` : '') +
        ' Автоматическое восстановление для неё не запущено.',
      refs: [t.id],
    });
  }
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
        checkedAt: serving.checkedAt,
      }
    : undefined;
  const headline =
    !counts.tasks && !counts.cancelled && !s.changeSets.length
      ? 'Разработка ещё не началась: задач пока нет.'
      : !counts.tasks && counts.cancelled
        ? `Работа отменена: отменено задач — ${counts.cancelled}.`
        : decisions.some((d) => d.kind === 'access')
          ? 'Работа стоит: нужен внешний доступ.'
          : decisions.some((d) => d.kind === 'product')
            ? 'Нужно ваше решение по готовому изменению.'
            : tryNow
              ? 'Проверенную версию можно попробовать.'
              : decisions.some((d) => d.kind === 'technical')
                ? 'Работа остановилась на технической проблеме — нужен разбор.'
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
