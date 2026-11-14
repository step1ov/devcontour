import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  changedPaths,
  gateBasis,
  gateDecisions,
  HARNESS_VERSION,
  runGatesAt,
  type ChangedPaths,
  type EvidenceRecord,
  type GateApplicability,
} from 'devcontour-harness';
import { baseMovesOf, type DevContour } from '../core/service.ts';
import { dependsOnRepository, repositories, repository } from '../core/repositories.ts';
import { executionOf } from '../harness/execution.ts';
import { git, isAncestor } from './process.ts';
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
  /**
   * Основание каждого gate профиля (`gateBasis` harness: определение,
   * ресурсы, предпосылки, окружение, lifecycle, изоляция, версия harness).
   * Нет поля — запись прежней версии: её результат не переносится (D51).
   */
  basis?: Record<string, string>;
  /**
   * SHA баз компонентов, от которых этот зависит (`dependsOn`, транзитивно):
   * снимки зависимостей — вход gates. Перенос результата требует тех же SHA.
   */
  providers?: Record<string, string>;
  /**
   * Gates, результат которых перенесён с прошедшей проверки предка, а не
   * исполнен на этом SHA (D51): gate с `when.paths`, чьих путей и неявных
   * входов diff от SHA его исполнения до этой базы не задел. Их evidence —
   * исходное, на SHA исполнения (`from`).
   */
  carried?: BaseCarry[];
}
/** Перенесённый результат gate проверки базы и diff, по которому он перенесён. */
export interface BaseCarry {
  gate: string;
  /** SHA, на котором gate исполнялся и прошёл (его evidence). */
  from: string;
  /** Прошедшая проверка базы, из записи которой взят результат. */
  anchor: string;
  /** Сведения о diff `from..sha`: шаблоны, число, первые пути, digest списка. */
  applicability: GateApplicability;
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

/** Что проверка базы исполняет и что переносит с прошедшей проверки предка. */
interface BasePlan {
  /** Gates к исполнению на этом SHA (с предпосылками — их добавит harness). */
  run: string[];
  carried: BaseCarry[];
  /** Исходное evidence перенесённых gates (на SHA их исполнения). */
  evidence: EvidenceRecord[];
  basis: Record<string, string>;
  providers: Record<string, string>;
}
/**
 * План проверки базы `sha` компонента (D51). Результат gate переносится с
 * последней прошедшей проверки базы-предка, только когда harness сам не
 * исполнил бы его в фазе задачи (`gateDecisions` — то же правило, что у
 * попыток, F22): у gate есть `when.paths`; его основание (`gateBasis`) и
 * договор компонента те же; его evidence — PASS на SHA-предке; полный diff
 * от этого SHA до базы не задевает ни его путей, ни неявных входов
 * (защищённые пути, каталог harness, манифесты и lockfiles, пути из команды);
 * он не предпосылка исполняемого gate. Gate без `when`, неизвестный или
 * пустой diff, иное основание — исполнение. Базы компонентов-поставщиков
 * (`providers`) должны совпадать с записанными при той проверке: diff
 * поставщика правило путей не видит. Без прошедшего предка — весь профиль,
 * как прежде.
 */
async function basePlan(
  h: DevContour,
  policy: ReturnType<typeof executionOf>['engine']['policy'],
  repositoryId: string,
  sha: string,
  policyDigest: string,
  providers: Record<string, string>,
): Promise<BasePlan> {
  const repo = repository(h.config, repositoryId);
  const all = repo.gates.map((g) => g.id);
  const policyRepo = policy.repositories.find((r) => r.id === repositoryId);
  if (!policyRepo) return { run: all, carried: [], evidence: [], basis: {}, providers };
  const basis = Object.fromEntries(
    policyRepo.gates.map((g) => [g.id, gateBasis(policy, policyRepo, g, HARNESS_VERSION)]),
  );
  const full: BasePlan = { run: all, carried: [], evidence: [], basis, providers };
  if (!policyRepo.gates.some((g) => g.when)) return full;
  // Последняя прошедшая проверка базы-предка под тем же договором и с теми
  // же базами поставщиков.
  const sameProviders = (r: BaseCheck) =>
    JSON.stringify(Object.entries(r.providers ?? {}).sort()) ===
    JSON.stringify(Object.entries(providers).sort());
  const records = Object.values(h.store.localRecords<BaseCheck>(BASE_CHECK, repositoryId))
    .filter(
      (r) =>
        r.passed && r.sha !== sha && r.policyDigest === policyDigest && r.basis && sameProviders(r),
    )
    .sort((a, b) => b.at.localeCompare(a.at));
  let anchor: BaseCheck | undefined;
  for (const r of records)
    if (await isAncestor(repo.path, r.sha, sha)) {
      anchor = r;
      break;
    }
  if (!anchor) return full;
  const diffs = new Map<string, Promise<ChangedPaths>>();
  const changed = new Map<string, ChangedPaths>();
  for (const g of policyRepo.gates) {
    if (!g.when || anchor.basis?.[g.id] !== basis[g.id]) continue;
    const own = anchor.evidence.filter((e) => e.gate === g.id);
    // Только исполненный PASS gate (не потребителя) на одном SHA:
    // неприменимость не переносится.
    if (
      !own.length ||
      own.some(
        (e) => e.kind !== 'test' || e.consumer !== undefined || !e.passed || e.sha !== own[0].sha,
      )
    )
      continue;
    const at = own[0].sha;
    if (!(await isAncestor(repo.path, at, sha))) continue;
    if (!diffs.has(at)) diffs.set(at, changedPaths(repo.path, [{ from: at, to: sha }]));
    changed.set(g.id, await diffs.get(at)!);
  }
  const decisions = gateDecisions({
    repo: policyRepo,
    scope: policyRepo.gates,
    proof: new Set(),
    changedFor: (g) => changed.get(g.id),
  });
  const carried: BaseCarry[] = [];
  for (const d of decisions)
    if (!d.run && d.record)
      carried.push({
        gate: d.gate.id,
        from: changed.get(d.gate.id)!.ranges[0].from,
        anchor: anchor.sha,
        applicability: d.record,
      });
  if (!carried.length) return full;
  const ids = new Set(carried.map((c) => c.gate));
  return {
    run: all.filter((id) => !ids.has(id)),
    carried,
    evidence: anchor.evidence.filter((e) => ids.has(e.gate)),
    basis,
    providers,
  };
}
/**
 * Граница записи проверки: fencing задания и отмена. Закрывающее событие
 * (`*.passed`/`*.failed`) пишется и после отмены (`closing`), иначе начатая
 * проверка оставалась бы в журнале без окончания; fencing соблюдается и тогда.
 */
export type CheckGuard = (options?: { closing?: boolean }) => void;
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
 * Gate с `when.paths`, прошедший на базе-предке под тем же основанием, чьих
 * путей и неявных входов diff до новой базы не задел, не исполняется: его
 * результат переносится с указанием diff (`basePlan`, D51).
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
    if (h.store.read().waits?.some((w) => w.kind === 'base-check' && w.detail !== detail))
      h.store.change(type, (s) => {
        guard();
        s.waits = (s.waits ?? []).map((w) => (w.kind === 'base-check' ? { ...w, detail } : w));
        return data;
      });
    return false;
  };
  const bases = await Promise.all(
    repositories(h.config).map(async (repo) => ({
      repositoryId: repo.id,
      sha: await git(repo.path, 'rev-parse', 'refs/heads/' + repo.targetBranch),
    })),
  );
  const touched: string[] = [];
  // Документы контрактов, которые перенос приносит в редакции, одобренной
  // независимым ревью: их снимает цикл, с доказательством в `base.checked`.
  const reviewed: ReviewedContractDocument[] = [];
  for (const m of moves) {
    const to = bases.find((b) => b.repositoryId === m.repositoryId)?.sha;
    if (!to) continue;
    const entries = await sensitiveBaseEntries(h, roots.data, state, m.repositoryId, m.from, to);
    for (const e of entries) {
      const evidence = e.contractDocument
        ? await reviewedContractDocument(h, state, m.repositoryId, e.path, to)
        : undefined;
      if (evidence) reviewed.push(evidence);
      else touched.push(`${m.repositoryId}:${e.path}`);
    }
  }
  if (touched.length)
    return hold(
      'base.check.held',
      `${BASE_HELD_DETAIL} (${touched.slice(0, 20).join(', ')}): gates этой базы его не подтверждают. Перенос проверяет и подтверждает оператор: «Подтвердить и запустить» в «Внимании» панели; ведущий агент это ожидание сам не снимает. Сам цикл снимает только документы контрактов в редакции, одобренной независимым ревью (review-contract); изменение приёмки — через contract-change`,
      { paths: touched.slice(0, 20) },
    );
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
      const providers = Object.fromEntries(
        bases
          .filter((b) => dependsOnRepository(h.config, base.repositoryId, b.repositoryId))
          .map((b) => [b.repositoryId, b.sha]),
      );
      const plan = await basePlan(
        h,
        engine.policy,
        base.repositoryId,
        base.sha,
        policyDigest,
        providers,
      );
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
      event('base.check.started', {
        gates: plan.run,
        ...(plan.carried.length
          ? { carried: plan.carried.map((c) => c.gate), anchor: plan.carried[0].anchor }
          : {}),
        ...(tries > 1 ? { retry: tries - 1 } : {}),
      });
      let result: Pick<Awaited<ReturnType<typeof runGatesAt>>, 'gates' | 'failures' | 'evidence'>;
      try {
        // Всё перенесено — исполнять нечего.
        result = !plan.run.length
          ? { gates: [], failures: [], evidence: [] }
          : await runGatesAt(
              {
                policy: engine.policy,
                stateDir: roots.state,
                repoPath: (r) => repository(h.config, r.id).path,
                boundary: () => controllerBoundary(h, roots.state),
                // Тот же корень рабочих деревьев, что у попыток планировщика.
                ...checkoutRootOption(workspaceCheckoutRoot(h)),
                ...(h.config.resourceDatabase
                  ? { resourceDatabase: h.config.resourceDatabase }
                  : {}),
              },
              {
                id: runId,
                repositoryId: base.repositoryId,
                sha: base.sha,
                gates: plan.run,
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
        evidence: [...result.evidence, ...plan.evidence],
        at: new Date().toISOString(),
        tries,
        basis: plan.basis,
        ...(Object.keys(plan.providers).length ? { providers: plan.providers } : {}),
        ...(plan.carried.length ? { carried: plan.carried } : {}),
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
          // Перенесённые gates и diff, по которому они не исполнялись (D51).
          ...(plan.carried.length
            ? {
                carried: plan.carried.map((c) => ({
                  gate: c.gate,
                  from: c.from,
                  count: c.applicability.count,
                  files: c.applicability.files.slice(0, 20),
                  pathsDigest: c.applicability.pathsDigest,
                })),
              }
            : {}),
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
