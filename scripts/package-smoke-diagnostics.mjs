/** Bounded failure context for the deterministic installed-package workflow check. */
export function packageWorkflowDiagnostics({ lastReport, state, taskId, boardId, serverOutput }) {
  const pick = (value, keys) =>
    Object.fromEntries(
      keys
        .filter((key) => value[key] !== undefined)
        .map((key) => [
          key,
          typeof value[key] === 'string' ? value[key].slice(0, 2000) : value[key],
        ]),
    );
  const withoutTokens = (key, value) => (/token/i.test(key) ? undefined : value);
  return {
    boardId,
    taskId,
    lastWorkflowReport: JSON.stringify(lastReport ?? null, withoutTokens).slice(0, 12000),
    tasks: (state?.tasks ?? [])
      .filter((task) => task.id === taskId)
      .map((task) => pick(task, ['id', 'status', 'attempt', 'resultSha'])),
    runs: (state?.runs ?? [])
      .filter((run) => run.taskId === taskId)
      .map((run) =>
        pick(run, [
          'id',
          'taskId',
          'status',
          'phase',
          'startedAt',
          'finishedAt',
          'leaseUntil',
          'error',
        ]),
      )
      .slice(-5),
    serverTail: serverOutput.split('\n').slice(-40).join('\n').slice(-4000),
  };
}
