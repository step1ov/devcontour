import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { CLIP_SHORT, HarnessError, clipText, runGatesAt } from 'devcontour-harness';
import {
  BOARD_COVERAGE,
  boardCoverageKey,
  boardCoverageWorks,
  digest,
  uncoveredGates,
  type BoardCoverage,
  type DevContour,
} from '../core/service.ts';
import { DomainError, type Evidence, type Revision, type Task } from '../core/model.ts';
import { repositories, repository } from '../core/repositories.ts';
import { redactor } from './redaction.ts';
import { executionOf, toDomain } from '../harness/execution.ts';
import { controllerBoundary } from './checks.ts';

/**
 * Полный профиль доски на её итоговом SHA. Gates, которые не прошли
 * integration ни в одной задаче (области задач их не включали), исполняются
 * один раз на итоговом integration SHA компонента — тем же исполнением, что
 * integration задач (`runGatesAt` harness: рабочее дерево на SHA, снимки
 * зависимостей, ресурсы, lifecycle, prepare, окружение, песочница). Каждое
 * evidence записывается под fencing вызывающего (`guard`) вместе с привязкой
 * к ревизии, SHA и договору компонента; изменённая ревизия — отказ записи.
 * Уже прошедшая проверка того же SHA и договора не повторяется. Провал —
 * отказ приёмки с названным gate; приёмка без прошедших gates невозможна
 * (`DevContour.accept` пересчитывает покрытие сам).
 */
export async function coverBoard(
  h: DevContour,
  root: string,
  boardId: string,
  revision: Revision,
  tasks: Task[],
  heads: Record<string, string>,
  guard: () => void = () => {},
  signal?: AbortSignal,
) {
  const gaps = uncoveredGates(
    h,
    h.store.read(),
    tasks,
    boardCoverageWorks(h, boardId, revision, heads),
  );
  const runs: { repositoryId: string; sha: string; runId: string; gates: string[] }[] = [];
  // Все непрошедшие gates всех компонентов — одним отказом: иначе каждый
  // провал стоил бы отдельной попытки стадии.
  const failed: string[] = [];
  const event = (type: string, data: Record<string, unknown>) =>
    h.store.atomic(() => {
      guard();
      h.store.appendEvent(type, { boardId, revision: revision.number, ...data });
    });
  const revisionDigest = digest(revision);
  for (const gap of gaps) {
    const sha = heads[gap.repositoryId];
    if (!sha) throw new DomainError(`Нет итогового SHA доски в ${gap.repositoryId}`);
    const policyDigest = h.policyDigest(gap.repositoryId);
    // Запись одна на ревизию и компонент. Прошедшее evidence прежней проверки
    // того же SHA, договора и ревизии переносится: иначе повтор после
    // частичного провала перезаписал бы его, и уже прошедший gate снова
    // оказался бы непокрытым.
    const previous = h.store.localRecord<BoardCoverage>(
      BOARD_COVERAGE,
      gap.repositoryId,
      boardCoverageKey(boardId, revision.number),
    );
    const kept =
      previous &&
      previous.sha === sha &&
      previous.policyDigest === policyDigest &&
      previous.revisionDigest === revisionDigest
        ? previous.evidence.filter((e) => e.passed)
        : [];
    const record: BoardCoverage = {
      boardId,
      revision: revision.number,
      repositoryId: gap.repositoryId,
      sha,
      policyDigest,
      revisionDigest,
      runId: 'BC-' + randomUUID(),
      gates: gap.gates,
      evidence: [...kept],
      at: new Date().toISOString(),
    };
    const save = () =>
      h.store.atomic(() => {
        guard();
        const current = h.store
          .read()
          .boards.find((b) => b.id === boardId)
          ?.revisions.at(-1);
        if (
          !current ||
          current.status !== 'active' ||
          current.number !== revision.number ||
          digest(current) !== revisionDigest
        )
          throw new DomainError('Ревизия доски изменилась во время её проверки');
        if (h.policyDigest(gap.repositoryId) !== record.policyDigest)
          throw new DomainError('Договор компонента изменился во время проверки доски');
        h.store.saveLocal(
          BOARD_COVERAGE,
          gap.repositoryId,
          boardCoverageKey(boardId, revision.number),
          record,
        );
      });
    const { engine } = executionOf(h);
    event('board.coverage.started', {
      repositoryId: gap.repositoryId,
      sha,
      runId: record.runId,
      gates: gap.gates,
    });
    let result;
    try {
      result = await runGatesAt(
        {
          policy: engine.policy,
          stateDir: root,
          repoPath: (r) => repository(h.config, r.id).path,
          boundary: () => controllerBoundary(h, root),
          ...(h.config.resourceDatabase ? { resourceDatabase: h.config.resourceDatabase } : {}),
        },
        {
          id: record.runId,
          repositoryId: gap.repositoryId,
          sha,
          gates: gap.gates,
          record: (e) => {
            record.evidence.push(e as unknown as Evidence);
            save();
          },
          ...(signal ? { signal } : {}),
        },
      );
    } catch (error) {
      // Отказ самой проверки (окружение, отмена, утрата владения) — тоже
      // исход начатой проверки: журнал не остаётся с одним «started».
      try {
        event('board.coverage.failed', {
          repositoryId: gap.repositoryId,
          sha,
          runId: record.runId,
          gates: gap.gates,
          error: journalError(error, [root, ...repositories(h.config).map((r) => r.path)]),
        });
      } catch {
        // Без права записи событие не пишется; причина — исходная ошибка.
      }
      throw toDomain(error);
    }
    record.gates = [...new Set([...kept.map((e) => e.gate), ...result.gates])];
    if (result.failure) record.failure = result.failure;
    if (result.failures.length) record.failures = result.failures;
    save();
    event(result.failures.length ? 'board.coverage.failed' : 'board.coverage.passed', {
      repositoryId: gap.repositoryId,
      sha,
      runId: record.runId,
      gates: result.gates,
      ...(result.failures.length ? { failures: result.failures.map((f) => f.gate) } : {}),
    });
    for (const f of result.failures)
      failed.push(`${gap.repositoryId}/${f.gate} на ${sha}: ${f.message}`);
    if (result.failures.length) continue;
    runs.push({ repositoryId: gap.repositoryId, sha, runId: record.runId, gates: result.gates });
  }
  if (failed.length)
    throw new DomainError('Проверка доски на итоговом SHA не пройдена: ' + failed.join('; '));
  return runs;
}

/**
 * Ошибка проверки доски для журнала: код и короткое сообщение. Каталоги
 * контура и компонентов, домашний и временный каталоги маскируются тем же
 * redactor, что и прочие записи; длина — предел короткой строки.
 */
export function journalError(error: unknown, roots: string[]) {
  const raw = error instanceof Error ? error.message : String(error);
  const local = redactor([...roots, homedir(), tmpdir()]);
  return {
    code: error instanceof HarnessError ? error.code : 'CHECK_FAILED',
    message: clipText(local(raw), CLIP_SHORT) ?? '',
  };
}
