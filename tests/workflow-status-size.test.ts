// workflow_status у долго живущего компонента: законченные задания копятся
// вместе с историей, и полный список перерастал предел ответа агентского API
// (64 KiB). Ответ по умолчанию сворачивает законченные, фильтры сужают его,
// а отказ по размеру называет существующий путь.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WORKSPACE_OWNER, checkJsonBytes } from 'devcontour-harness';
import { fixture } from './helpers.ts';
import { AgentService, oversized } from '../src/application/agent.ts';
import { executionOf } from '../src/harness/execution.ts';
import type { WorkflowJob } from '../src/core/lead-workflow.ts';

type Fixture = ReturnType<typeof fixture>;
type Job = Partial<WorkflowJob> & {
  key: string;
  status: string;
  history?: unknown[];
  compact?: boolean;
  historyLength?: number;
  historyOmitted?: number;
  lastEvent?: unknown;
};
type Status = {
  jobs: Job[];
  finished: { total: number; listed: number; omitted: number; compact: boolean; hint?: string };
  historyClipped?: boolean;
  queue: unknown;
};

const key = (n: string) => createHash('sha256').update(n).digest('hex');
const BASE = Date.parse('2026-01-01T00:00:00.000Z');
const at = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();

/** Запись задания прямо в local_workflow: накопленная история без прогона стадий. */
function put(f: Fixture, jobs: WorkflowJob[]) {
  const { engine } = executionOf(f.h);
  engine.host.store.transact('workflow.updated', (tx) => {
    for (const job of jobs) tx.putLocal('workflow-jobs', WORKSPACE_OWNER, job.key, job);
  });
}

function job(
  name: string,
  status: WorkflowJob['status'],
  end: number,
  events: number,
  id = 'B-' + name,
): WorkflowJob {
  return {
    key: key(name),
    kind: 'board',
    id,
    authorRuntime: 'codex',
    maxAttempts: 3,
    inputDigest: key('input ' + name),
    stage: status === 'completed' ? 3 : 1,
    attempts: 1,
    status,
    repairs: 1,
    startedAt: at(end - 30),
    ...(status === 'completed' ? { finishedAt: at(end) } : {}),
    ...(status === 'failed' ? { error: 'stage failed: ' + 'x'.repeat(900) } : {}),
    history: Array.from({ length: events }, (_, i) => ({
      at: at(end - events + i),
      stage: 1,
      event: i % 2 ? 'running' : 'waiting-input',
    })),
  };
}

const status = (f: Fixture, input: Record<string, unknown> = {}) =>
  new AgentService(f.h, f.root).execute({ operation: 'workflow_status', input }) as Status;

/**
 * 80 законченных заданий (completed, failed, stale вперемешку) с длинной
 * историей и одно действующее. Время конца законченного задания i — минута
 * i·10; самые новые — с наибольшим i.
 */
function seed(f: Fixture) {
  const statuses: WorkflowJob['status'][] = ['completed', 'failed', 'stale'];
  const finished = Array.from({ length: 80 }, (_, i) =>
    job('done-' + i, statuses[i % 3], (i + 1) * 10, 30, i < 70 ? 'B-many' : undefined),
  );
  const active = job('live', 'running', 2000, 12);
  put(f, [...finished, active]);
  return { finished, active };
}

test('workflow_status по умолчанию сворачивает законченные задания и помещается в ответ', () => {
  const f = fixture();
  try {
    const { finished, active } = seed(f);
    // Прежний ответ — все задания целиком — превышал предел: тест воспроизводит отказ.
    assert.equal(checkJsonBytes([...finished, active], 65536).within, false);
    const s = status(f);
    const bytes = checkJsonBytes(s, 65536).bytes;
    assert.ok(bytes < 16384, `default response is ${bytes} bytes`);
    // Действующее — целиком, с историей и без токена.
    const live = s.jobs.find((j) => j.key === active.key)!;
    assert.equal(live.status, 'running');
    assert.equal(live.history?.length, 12);
    assert.equal(live.compact, undefined);
    assert.equal('token' in live, false);
    // Законченные: последние 10 по времени конца, компактные.
    const done = s.jobs.filter((j) => j.key !== active.key);
    const latest = finished
      .slice(-10)
      .map((j) => j.key)
      .sort();
    assert.deepEqual(done.map((j) => j.key).sort(), latest);
    for (const j of done) {
      assert.equal(j.compact, true);
      assert.equal(j.history, undefined);
      assert.equal(j.historyLength, 30);
      assert.ok(j.lastEvent);
      assert.equal('inputDigest' in j, false);
      if (j.error) assert.ok(j.error.length <= 301, 'error is clipped');
    }
    assert.deepEqual(
      { ...s.finished, hint: undefined },
      { total: 80, listed: 10, omitted: 70, compact: true, hint: undefined },
    );
    assert.match(s.finished.hint ?? '', /key .*kind and id.*active.*limit/);
    assert.ok(s.queue, 'the rest of the envelope stays');
  } finally {
    f.cleanup();
  }
});

test('workflow_status: фильтры key, kind/id, active и limit', () => {
  const f = fixture();
  try {
    const { finished, active } = seed(f);
    // active: true — только действующие, законченных нет в списке, но счёт есть.
    const live = status(f, { active: true });
    assert.deepEqual(
      live.jobs.map((j) => j.key),
      [active.key],
    );
    assert.equal(live.finished.total, 0);
    // active: false и limit — только законченные, последние limit.
    const three = status(f, { active: false, limit: 3 });
    assert.deepEqual(
      three.jobs.map((j) => j.key).sort(),
      finished
        .slice(-3)
        .map((j) => j.key)
        .sort(),
    );
    assert.deepEqual(
      { ...three.finished, hint: undefined },
      { total: 80, listed: 3, omitted: 77, compact: true, hint: undefined },
    );
    // key — одно задание целиком, даже давно законченное.
    const old = finished[4];
    const one = status(f, { key: old.key });
    assert.equal(one.jobs.length, 1);
    assert.equal(one.jobs[0].key, old.key);
    assert.equal(one.jobs[0].history?.length, 30);
    assert.equal(one.jobs[0].compact, undefined);
    assert.equal(one.jobs[0].inputDigest, old.inputDigest);
    assert.equal(one.finished.compact, false);
    assert.equal(one.finished.hint, undefined);
    // kind и id — задания одной доски целиком.
    const other = finished[75];
    const byId = status(f, { kind: 'board', id: other.id });
    assert.deepEqual(
      byId.jobs.map((j) => j.key),
      [other.key],
    );
    assert.equal(byId.jobs[0].history?.length, 30);
    assert.equal(status(f, { kind: 'changeset', id: other.id }).jobs.length, 0);
    // Неизвестный ключ — пустой список, не отказ.
    assert.deepEqual(status(f, { key: key('none') }).jobs, []);
    // Вход проверяется схемой.
    for (const bad of [{ limit: 0 }, { limit: 201 }, { key: 'abc' }, { boardId: 'B-x' }])
      assert.throws(() => status(f, bad));
  } finally {
    f.cleanup();
  }
});

test('workflow_status: не помещающийся ответ сокращает историю действующих, затем отбрасывает старейшие законченные', () => {
  const f = fixture();
  try {
    const { finished } = seed(f);
    // 70 заданий одной доски целиком (id назван) — больше предела.
    const many = status(f, { kind: 'board', id: 'B-many', limit: 200 });
    assert.ok(checkJsonBytes(many, 60000).within);
    assert.equal(many.finished.total, 70);
    assert.ok(many.finished.omitted > 0 && many.finished.listed > 0);
    assert.equal(many.finished.listed + many.finished.omitted, 70);
    // Ушли самые старые: оставшиеся — последние по времени конца.
    const ofBoard = finished.filter((j) => j.id === 'B-many');
    assert.deepEqual(
      many.jobs.map((j) => j.key).sort(),
      ofBoard
        .slice(-many.finished.listed)
        .map((j) => j.key)
        .sort(),
    );
    assert.match(many.finished.hint ?? '', /limit/);
    // Место освободили законченные: действующие помещаются, их история цела.
    assert.equal(many.historyClipped, undefined);
    // Действующее задание с огромной историей: хвост последних 20 событий.
    put(f, [job('huge', 'queued', 5000, 3000)]);
    const huge = status(f, { active: true });
    const j = huge.jobs.find((x) => x.key === key('huge'))!;
    assert.equal(huge.historyClipped, true);
    assert.equal(j.history?.length, 20);
    assert.equal(j.historyOmitted, 2980);
    assert.ok(checkJsonBytes(huge, 60000).within);
    // Без фильтра: история сокращена, а законченные перечислены все 10 —
    // место освобождает хвост истории, а не они.
    const both = status(f);
    assert.equal(both.historyClipped, true);
    assert.equal(both.jobs.find((x) => x.key === key('huge'))!.history?.length, 20);
    assert.equal(both.jobs.find((x) => x.key === key('live'))!.history?.length, 12);
    assert.deepEqual([both.finished.listed, both.finished.omitted], [10, 70]);
    // Без нехватки места история не сокращается.
    assert.equal(status(f, { key: key('live') }).historyClipped, undefined);
  } finally {
    f.cleanup();
  }
});

test('Отказ по пределу ответа называет существующий путь сузить запрос', () => {
  const own = oversized('workflow_status');
  assert.match(own, /workflow_status/);
  assert.match(own, /key.*kind и id.*active.*limit/);
  const generic = oversized('usage_report');
  assert.match(generic, /usage_report/);
  assert.match(generic, /inputSchema/);
  for (const text of [own, generic]) assert.doesNotMatch(text, /CLI-отчёт/);
});
