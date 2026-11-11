import { z } from 'zod';
import type { DevContourState } from '../core/model.ts';
import { taskOwner } from '../core/sync-state.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
/** Вход `requirements_testcases`: gate и необязательные компонент или задача. */
export const testcasesInput = z.strictObject({
  gate: id,
  repositoryId: id.optional(),
  taskId: id.optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
const shownLimit = 200;

/**
 * Идентификаторы testcases из манифеста последней test-записи gate:
 * `testId` связи requirements пишется ровно так (`classname.name` отчёта
 * JUnit). Только чтение; записи совместных gates манифеста не несут.
 */
export function gateTestcases(state: DevContourState, raw: unknown) {
  const input = testcasesInput.parse(raw);
  const tasks = new Map(state.tasks.map((t) => [t.id, t]));
  const records = state.runs
    .filter(
      (r) =>
        (!input.taskId || r.taskId === input.taskId) &&
        (!input.repositoryId ||
          (tasks.has(r.taskId) && taskOwner(tasks.get(r.taskId)!) === input.repositoryId)),
    )
    .flatMap((r) =>
      (r.evidence ?? [])
        .filter((e) => e.kind === 'test' && e.gate === input.gate && e.tests)
        .map((e) => ({ run: r, evidence: e })),
    )
    .toSorted((a, b) => a.evidence.createdAt.localeCompare(b.evidence.createdAt));
  const last = records.at(-1);
  const format =
    'testId = classname + "." + name of the JUnit testcase (just name when classname is empty), verbatim with spaces; see docs/requirements.md for jest-junit, node:test and pytest.';
  if (!last)
    return {
      gate: input.gate,
      found: false,
      testcases: [],
      format,
      note: 'No test record of this gate with a testcase manifest: the gate needs report junit and at least one finished attempt.',
    };
  const tests = last.evidence.tests!;
  const limit = input.limit ?? shownLimit;
  return {
    gate: input.gate,
    found: true,
    taskId: last.run.taskId,
    runId: last.run.id,
    phase: last.evidence.phase,
    sha: last.evidence.sha,
    createdAt: last.evidence.createdAt,
    passed: last.evidence.passed,
    ...(last.evidence.testsTruncated ? { truncated: true } : {}),
    testcases: tests.slice(0, limit),
    ...(tests.length > limit ? { omitted: tests.length - limit } : {}),
    format,
  };
}
