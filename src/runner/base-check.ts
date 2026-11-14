import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { runGatesAt, type EvidenceRecord } from 'devcontour-harness';
import { baseMovesOf, type DevContour } from '../core/service.ts';
import type { DevContourState } from '../core/model.ts';
import { repositories, repository } from '../core/repositories.ts';
import { executionOf } from '../harness/execution.ts';
import { git } from './process.ts';
import { controllerBoundary } from './checks.ts';
import { checkoutRootOption, workspaceCheckoutRoot } from './checkout-root.ts';
import { journalError } from './board-coverage.ts';
import {
  reviewedContractDocument,
  reviewedRedaction,
  sensitiveBaseEntries,
  type ReviewedContractDocument,
} from './sensitive-paths.ts';

/** Локальная запись проверки базы: компонент, SHA базы, договор и исход. */
export const BASE_CHECK = 'base-check';
/** Начало причины удержания переноса, который подтверждает только человек. */
export const BASE_HELD_DETAIL = 'Перенос базы меняет приёмку или настройку контура';
export interface BaseCheck {
  repositoryId: string;
  sha: string;
  policyDigest: string;
  runId: string;
  passed: boolean;
  gates: string[];
  failures: { gate: string; message: string }[];
  evidence: EvidenceRecord[];
  at: string;
  /** Прогонов этой базы под этим договором (нет поля — один). */
  tries?: number;
}
/**
 * Повторов провалившейся проверки базы. Провал gate базы бывает и сбоем среды
 * (бюджет времени под нагрузкой), поэтому один повтор — автоматически; после
 * него провал стоит до переноса базы, смены договора или `queue --start`.
 */
export const BASE_CHECK_RETRIES = 1;

/** SHA целевой ветки компонента — синхронно, внутри транзакции решения. */
const targetSha = (path: string, branch: string) =>
  execFileSync('git', ['-C', path, 'rev-parse', 'refs/heads/' + branch], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
  }).trim();

/**
 * Граница записи проверки: fencing задания и отмена. Закрывающее событие
 * (`*.passed`/`*.failed`) пишется и после отмены (`closing`), иначе начатая
 * проверка оставалась бы в журнале без окончания; fencing соблюдается и тогда.
 */
export type CheckGuard = (options?: { closing?: boolean }) => void;
/** Предел путей в причине удержания: остальные — в журнале переноса. */
const HELD_PATHS = 20;

/**
 * Причина удержанного переноса (`base.check.held`) — единственный источник,
 * из которого её читают остановка очереди (`stopReason`), центр внимания,
 * `session_handoff`, `workflow_start` и ответ `base-update`
 * (`heldBaseWait`/`heldBasePaths`): пути и действие оператора.
 */
export const heldBaseDetail = (paths: readonly string[]) =>
  `${BASE_HELD_DETAIL} (${paths.slice(0, HELD_PATHS).join(', ')}): gates этой базы его не подтверждают. Перенос проверяет и подтверждает оператор: «Подтвердить и запустить» в «Внимании» панели; ведущий агент это ожидание сам не снимает. Сам цикл снимает только документы контрактов в редакции, одобренной независимым ревью (review-contract); изменение приёмки — через contract-change`;

/**
 * Заменить причину ожидания `base-check` событием `type` — в одной
 * транзакции со сверкой: ожидание есть и, если передано `at`, это то же
 * ожидание (иначе его поставил более поздний перенос или оно снято).
 * `same` — причина уже та же, события нет; `gone` — ожидания нет.
 */
function setBaseWaitDetail(
  h: DevContour,
  type: string,
  detail: string,
  data: Record<string, unknown>,
  options: {
    guard?: CheckGuard;
    at?: string;
    /**
     * Удержание: пауза отказа runtime становится паузой `base-check`. Иначе
     * снятие причины отказа (`clearFailure` при повторе задачи) вернуло бы
     * выдачу, оставив удержанное ожидание неподтверждённым.
     */
    held?: boolean;
  } = {},
): 'set' | 'same' | 'gone' {
  return h.store.atomic(() => {
    options.guard?.();
    const state = h.store.read();
    const wait = state.waits?.find((w) => w.kind === 'base-check');
    if (!wait || (options.at !== undefined && wait.at !== options.at)) return 'gone';
    const repause = !!options.held && state.paused && state.pauseReason === 'runtime';
    if (wait.detail === detail && !repause) return 'same';
    h.store.change(type, (st) => {
      st.waits = (st.waits ?? []).map((w) => (w.kind === 'base-check' ? { ...w, detail } : w));
      if (repause) {
        st.pauseReason = 'base-check';
        st.pauseFailures = undefined;
      }
      return repause ? { ...data, pauseFrom: 'runtime' } : data;
    });
    return wait.detail === detail ? 'same' : 'set';
  });
}

/**
 * Разбор непроверенного переноса (`baseMoves` до текущих SHA целевых
 * веток): какие чувствительные пути (D42) держат его до подтверждения
 * человека (`held`, `компонент:путь`, не больше 20) и какие документы
 * контрактов перенесены в редакции, одобренной независимым ревью
 * (`reviewed`, их снимает цикл). Одно правило для проверки базы циклом и для
 * ответа `base-update`: ведущий узнаёт об удержании в момент переноса, а не
 * после первого такта задания.
 */
export async function baseMoveReview(
  h: DevContour,
  dataRoot: string,
  state: Readonly<DevContourState> = h.store.read(),
) {
  const bases = await Promise.all(
    repositories(h.config).map(async (repo) => ({
      repositoryId: repo.id,
      sha: await git(repo.path, 'rev-parse', 'refs/heads/' + repo.targetBranch),
    })),
  );
  const held: string[] = [];
  // Документы контрактов, которые перенос приносит в редакции, одобренной
  // независимым ревью: их снимает цикл, с доказательством в `base.checked`.
  const reviewed: ReviewedContractDocument[] = [];
  for (const m of baseMovesOf(state) ?? []) {
    const to = bases.find((b) => b.repositoryId === m.repositoryId)?.sha;
    if (!to) continue;
    const entries = await sensitiveBaseEntries(h, dataRoot, state, m.repositoryId, m.from, to);
    for (const e of entries) {
      const evidence = e.contractDocument
        ? await reviewedContractDocument(h, state, m.repositoryId, e.path, to)
        : undefined;
      if (evidence) reviewed.push(evidence);
      else held.push(`${m.repositoryId}:${e.path}`);
    }
  }
  return { bases, held: held.slice(0, HELD_PATHS), reviewed };
}

/**
 * Записать удержание переноса сразу после `base-update` в режиме агента —
 * тем же событием и той же причиной, что проверка базы циклом задания
 * (`checkBase` потом причину не переписывает). Возвращает пути удержания;
 * пусто — перенос снимут gates, или ожидания этого переноса уже нет.
 */
export async function holdSensitiveBaseMove(h: DevContour, dataRoot: string) {
  const state = h.store.read();
  if (h.config.approvalMode !== 'agent' || !baseMovesOf(state)) return [];
  const wait = state.waits?.find((w) => w.kind === 'base-check');
  if (!state.paused || !wait) return [];
  const { held } = await baseMoveReview(h, dataRoot, state);
  if (!held.length) return [];
  // Ожидание этого переноса (`at`): за время разбора его могли снять
  // (оператор запустил очередь) или заменить более поздним переносом.
  const set = setBaseWaitDetail(
    h,
    'base.check.held',
    heldBaseDetail(held),
    { paths: held, by: 'base-update' },
    { at: wait.at, held: true },
  );
  return set === 'gone' ? [] : held;
}

/**
 * Проверка перенесённой базы gates компонентов в режиме `approvalMode: agent`.
 *
 * После `base-update` и автоматической перемотки очередь ждёт `base-check`:
 * новую базу проверяют gates до выдачи (D42). В режиме оператора это решение
 * человека, и ожидание снимает он. В режиме агента согласования ведёт контур,
 * и ручной `queue --start` был лишним шагом: цикл ведущего проверяет базу сам
 * тем же исполнением, что integration задач (`runGatesAt`), — весь профиль
 * каждого компонента на SHA его базы прогонов. Все прошли — ожидание снято и
 * очередь продолжена; провал — ожидание остаётся и называет gates.
 *
 * Автоматически снимается только перенос, который могла бы сделать и
 * автоматическая перемотка: непроверенный диапазон каждого компонента
 * (`baseMoves`) не трогает чувствительных путей и закреплённых редакций
 * артефактов (`sensitiveBasePaths`, D42). Перенос, меняющий приёмку или
 * настройку контура, gates той же базы не доказывают — они сами могли быть
 * ослаблены этим переносом; такое ожидание снимает только `queue --start`.
 * Исключение — документ контракта, единственная причина чувствительности
 * которого — сам документ, в редакции, одобренной независимым ревью
 * (`reviewedContractDocument`: blob на базе равен blob одобренного текста).
 * Его, как и обычный перенос, снимают gates; доказательство (ревью и blob)
 * пишется в `base.checked`. Любой другой чувствительный путь рядом держит
 * весь перенос.
 *
 * Исход хранится по SHA и договору; провал повторяется один раз
 * (`BASE_CHECK_RETRIES`), дальше база не проверяется повторно, пока её не
 * перенесут или не изменят договор. Сверка SHA баз и снятие ожидания — одна
 * транзакция.
 *
 * Возвращает `true`, когда ожидание снято (или его уже нет).
 */
export async function checkBase(
  h: DevContour,
  roots: {
    /** Каталог данных контура (чувствительные пути embedded-режима). */
    data: string;
    /** Каталог состояния прогона gates. */
    state: string;
  },
  guard: CheckGuard,
  signal?: AbortSignal,
): Promise<boolean> {
  const waiting = () => {
    const s = h.store.read();
    return s.paused && s.pauseReason === 'base-check';
  };
  const ranges = () => JSON.stringify(baseMovesOf(h.store.read()) ?? null);
  if (h.config.approvalMode !== 'agent' || !waiting()) return !waiting();
  const state = h.store.read();
  const range = ranges();
  // Ожидание без диапазона (поставлено до переноса или прежней версией) —
  // решение человека.
  const moves = baseMovesOf(state);
  if (!moves) return false;
  /** Ожидание остаётся и называет причину; событие — только при новой причине. */
  const hold = (type: string, detail: string, data: Record<string, unknown>) => {
    setBaseWaitDetail(h, type, detail, data, { guard });
    return false;
  };
  const { bases, held: touched, reviewed } = await baseMoveReview(h, roots.data, state);
  if (touched.length) return hold('base.check.held', heldBaseDetail(touched), { paths: touched });
  const { engine } = executionOf(h);
  const failed: string[] = [];
  for (const base of bases) {
    const repo = repository(h.config, base.repositoryId);
    const gates = repo.gates.map((g) => g.id);
    if (!gates.length) continue;
    const policyDigest = h.policyDigest(base.repositoryId);
    const previous = h.store.localRecord<BaseCheck>(BASE_CHECK, base.repositoryId, base.sha);
    let record = previous?.policyDigest === policyDigest ? previous : undefined;
    while (!record || (!record.passed && (record.tries ?? 1) <= BASE_CHECK_RETRIES)) {
      const tries = (record?.tries ?? 0) + 1;
      const runId = 'BK-' + randomUUID();
      const event = (type: string, data: Record<string, unknown>, closing = false) =>
        h.store.atomic(() => {
          guard(closing ? { closing } : undefined);
          h.store.appendEvent(type, {
            repositoryId: base.repositoryId,
            sha: base.sha,
            runId,
            ...data,
            // Владелец роли controller в той же записи: переход живости
            // оборванной перезапуском проверки новый сервер не выдаёт за идущий.
            ...(type.endsWith('.liveness') ? { owner: h.store.read().leader?.owner } : {}),
          });
        });
      event('base.check.started', { gates, ...(tries > 1 ? { retry: tries - 1 } : {}) });
      let result;
      try {
        result = await runGatesAt(
          {
            policy: engine.policy,
            stateDir: roots.state,
            repoPath: (r) => repository(h.config, r.id).path,
            boundary: () => controllerBoundary(h, roots.state),
            // Тот же корень рабочих деревьев, что у попыток планировщика.
            ...checkoutRootOption(workspaceCheckoutRoot(h)),
            ...(h.config.resourceDatabase ? { resourceDatabase: h.config.resourceDatabase } : {}),
          },
          {
            id: runId,
            repositoryId: base.repositoryId,
            sha: base.sha,
            gates,
            record: () => guard(),
            // Переход живости проверки — событие журнала: при `report` это
            // единственный след зависания до конца проверки.
            onLiveness: (report) => {
              try {
                event('base.check.liveness', { ...report });
              } catch {
                // Без права записи переход не пишется; проверка идёт дальше.
              }
            },
            ...(signal ? { signal } : {}),
          },
        );
      } catch (error) {
        try {
          event(
            'base.check.failed',
            {
              error: journalError(error, [
                roots.state,
                ...repositories(h.config).map((r) => r.path),
              ]),
            },
            true,
          );
        } catch {
          // Без права записи событие не пишется; причина — исходная ошибка.
        }
        throw error;
      }
      const saved: BaseCheck = {
        repositoryId: base.repositoryId,
        sha: base.sha,
        policyDigest,
        runId,
        passed: !result.failures.length,
        gates: result.gates,
        failures: result.failures,
        evidence: result.evidence,
        at: new Date().toISOString(),
        tries,
      };
      try {
        h.store.atomic(() => {
          guard();
          h.store.saveLocal(BASE_CHECK, base.repositoryId, base.sha, saved);
        });
      } catch (error) {
        // Начатая проверка кончается событием и тогда, когда исход не
        // записался: иначе её последний переход живости висел бы как идущий.
        try {
          event(
            'base.check.failed',
            {
              // Не провал gates: исход проверки не записался.
              reason: signal?.aborted ? 'cancelled' : 'record',
              ...(saved.passed ? { gatesPassed: true } : {}),
              error: journalError(error, [
                roots.state,
                ...repositories(h.config).map((r) => r.path),
              ]),
            },
            true,
          );
        } catch {
          // Без права записи событие не пишется; причина — исходная ошибка.
        }
        throw error;
      }
      event(
        saved.passed ? 'base.check.passed' : 'base.check.failed',
        {
          gates: saved.gates,
          ...(saved.passed ? {} : { failures: saved.failures.map((f) => f.gate) }),
        },
        true,
      );
      record = saved;
    }
    for (const f of record.failures) failed.push(`${base.repositoryId}/${f.gate}`);
  }
  // Решение — в одной транзакции со сверкой: ожидание и его диапазон те же,
  // базы не сдвинулись с проверенных SHA.
  const decision = h.store.atomic(() => {
    guard();
    if (!waiting()) return 'cleared';
    if (ranges() !== range) return 'moved';
    // Доказательство ревью сверяется заново по текущему состоянию: новая
    // редакция документа или возвращённая в работу задача, закреплённая за
    // прежней, за время gates — проверить на следующем такте.
    const now = h.store.read();
    if (
      reviewed.some(
        (r) => reviewedRedaction(h.config, now, r.repositoryId, r.path)?.id !== r.contractId,
      )
    )
      return 'moved';
    for (const b of bases) {
      const repo = repository(h.config, b.repositoryId);
      if (targetSha(repo.path, repo.targetBranch) !== b.sha) return 'moved';
    }
    if (failed.length) return 'failed';
    h.store.appendEvent('base.checked', {
      bases,
      // Кто снял чувствительный перенос и на каком доказательстве: ревью
      // документа и blob одобренного текста, равный blob на базе.
      ...(reviewed.length ? { liftedBy: 'agent', reviewedContracts: reviewed } : {}),
    });
    h.pause(false);
    return 'cleared';
  });
  if (decision === 'failed')
    return hold(
      'base.check.waiting',
      `Проверка базы не пройдена: ${failed.join(', ')}. Исправьте базу и выполните base-update (ведущий агент — с --by host); если провал вызван средой — проверьте и выполните queue --start`,
      { failures: failed },
    );
  return decision === 'cleared';
}
