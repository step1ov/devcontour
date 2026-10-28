import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { runGatesAt, type EvidenceRecord } from 'devcontour-harness';
import { baseMovesOf, type DevContour } from '../core/service.ts';
import { repositories, repository } from '../core/repositories.ts';
import { executionOf } from '../harness/execution.ts';
import { git } from './process.ts';
import { controllerBoundary } from './checks.ts';
import { journalError } from './board-coverage.ts';
import { sensitiveBasePaths } from './sensitive-paths.ts';

/** Локальная запись проверки базы: компонент, SHA базы, договор и исход. */
export const BASE_CHECK = 'base-check';
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
  guard: () => void,
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
  for (const m of moves) {
    const to = bases.find((b) => b.repositoryId === m.repositoryId)?.sha;
    if (!to) continue;
    const paths = await sensitiveBasePaths(h, roots.data, state, m.repositoryId, m.from, to);
    touched.push(...paths.map((p) => `${m.repositoryId}:${p}`));
  }
  if (touched.length)
    return hold(
      'base.check.held',
      `Перенос базы меняет приёмку или настройку контура (${touched.slice(0, 20).join(', ')}): gates этой базы его не подтверждают. Проверьте перенос и выполните queue --start; изменение приёмки — через contract-change`,
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
      const event = (type: string, data: Record<string, unknown>) =>
        h.store.atomic(() => {
          guard();
          h.store.appendEvent(type, {
            repositoryId: base.repositoryId,
            sha: base.sha,
            runId,
            ...data,
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
            ...(h.config.resourceDatabase ? { resourceDatabase: h.config.resourceDatabase } : {}),
          },
          {
            id: runId,
            repositoryId: base.repositoryId,
            sha: base.sha,
            gates,
            record: () => guard(),
            ...(signal ? { signal } : {}),
          },
        );
      } catch (error) {
        try {
          event('base.check.failed', {
            error: journalError(error, [roots.state, ...repositories(h.config).map((r) => r.path)]),
          });
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
      h.store.atomic(() => {
        guard();
        h.store.saveLocal(BASE_CHECK, base.repositoryId, base.sha, saved);
      });
      event(saved.passed ? 'base.check.passed' : 'base.check.failed', {
        gates: saved.gates,
        ...(saved.passed ? {} : { failures: saved.failures.map((f) => f.gate) }),
      });
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
    for (const b of bases) {
      const repo = repository(h.config, b.repositoryId);
      if (targetSha(repo.path, repo.targetBranch) !== b.sha) return 'moved';
    }
    if (failed.length) return 'failed';
    h.store.appendEvent('base.checked', { bases });
    h.pause(false);
    return 'cleared';
  });
  if (decision === 'failed')
    return hold(
      'base.check.waiting',
      `Проверка базы не пройдена: ${failed.join(', ')}. Исправьте базу и выполните base-update; если провал вызван средой — проверьте и выполните queue --start`,
      { failures: failed },
    );
  return decision === 'cleared';
}
