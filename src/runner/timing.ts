import { randomUUID } from 'node:crypto';
import type { Harness } from '../core/service.ts';
import type { Run } from '../core/model.ts';
export async function timed<T>(
  h: Harness,
  run: Run,
  stage: string,
  action: () => Promise<T>,
): Promise<T> {
  const id = randomUUID();
  try {
    h.withRun(run.id, run.token, 'run.timing.started', (r) => {
      (r.timings ??= []).push({ id, stage, startedAt: new Date().toISOString() });
      return { runId: run.id, timingId: id, stage };
    });
  } catch (e) {
    if (stage.endsWith(':cleanup')) return action();
    throw e;
  }
  const end = (outcome: 'passed' | 'failed') =>
    h.withRun(run.id, run.token, 'run.timing.finished', (r) => {
      Object.assign(
        r.timings!.find((t) => t.id === id)!,
        { finishedAt: new Date().toISOString(), outcome },
      );
      return { runId: run.id, timingId: id, stage, outcome };
    });
  try {
    const value = await action();
    end('passed');
    return value;
  } catch (e) {
    try {
      end('failed');
    } catch {
      /* A lost lease leaves an explicitly incomplete span. */
    }
    throw e;
  }
}
