// workflow_status у долго живущего компонента: законченные задания копятся
// вместе с историей, и полный список перерастал предел ответа агентского API
// (64 KiB). Ответ по умолчанию сворачивает законченные, фильтры сужают его,
// а отказ по размеру называет существующий путь.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WORKSPACE_OWNER, checkJsonBytes } from 'devcontour-harness';
import { fixture } from './helpers.ts';
import { DomainError } from '../src/core/model.ts';
import { AgentService, oversized } from '../src/application/agent.ts';
import { executionOf } from '../src/harness/execution.ts';
import { LeadWorkflow, type WorkflowJob } from '../src/core/lead-workflow.ts';

type Fixture = ReturnType<typeof fixture>;
type Job = Partial<WorkflowJob> & {
  key: string;
  status: string;
  history?: unknown[];
  compact?: boolean;
  historyLength?: number;
  historyOmitted?: number;
  lastEvent?: { at?: string; stage: number; event: string };
  endedAt?: string;
  endedAtEstimated?: boolean;
  retryable?: boolean;
  waiting?: unknown;
};
type Status = {
  jobs: Job[];
  finished: {
    total: number;
    byStatus: Record<string, number>;
    retryable: number;
    listed: number;
    omitted: number;
    compact: boolean;
    hint?: string;
  };
  historyClipped?: boolean;
  queue: unknown;
};

const key = (n: string) => createHash('sha256').update(n).digest('hex');
const BASE = Date.parse('2026-01-01T00:00:00.000Z');
const at = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();
const ERROR = 'stage failed: ' + 'x'.repeat(900);

/** Запись задания прямо в local_workflow: накопленная история без прогона стадий. */
function put(f: Fixture, jobs: WorkflowJob[]) {
  const { engine } = executionOf(f.h);
  engine.host.store.transact('workflow.updated', (tx) => {
    for (const job of jobs) tx.putLocal('workflow-jobs', WORKSPACE_OWNER, job.key, job);
  });
}

/**
 * Задание с `events` событиями истории, последнее — за минуту до `end`.
 * Упавшее — как после отказа стадии в ходе работы: ни `finishedAt`, ни
 * события своего статуса; по умолчанию попытки исчерпаны (не повторяемое).
 */
function job(
  name: string,
  status: WorkflowJob['status'],
  end: number,
  events: number,
  o: { id?: string; attempts?: number; startedAt?: string; last?: string } = {},
): WorkflowJob {
  return {
    key: key(name),
    kind: 'board',
    id: o.id ?? 'B-' + name,
    authorRuntime: 'codex',
    maxAttempts: 3,
    inputDigest: key('input ' + name),
    stage: status === 'completed' ? 3 : 1,
    attempts: o.attempts ?? (status === 'failed' ? 3 : 1),
    status,
    repairs: 1,
    startedAt: o.startedAt ?? at(end - 30),
    ...(status === 'completed' ? { finishedAt: at(end) } : {}),
    ...(status === 'failed' ? { error: ERROR } : {}),
    history: Array.from({ length: events }, (_, i) => ({
      at: at(end - events + i),
      stage: 1,
      event: i === events - 1 && o.last ? o.last : i % 2 ? 'running' : 'waiting-input',
    })),
  };
}

const status = (f: Fixture, input: Record<string, unknown> = {}) =>
  new AgentService(f.h, f.root).execute({ operation: 'workflow_status', input }) as Status;
const keys = (jobs: { key: string }[]) => jobs.map((j) => j.key).sort();

/**
 * 80 законченных заданий (completed, failed, stale по кругу) с длинной
 * историей и одно действующее. Время конца законченного задания i — минута
 * (i+1)·10; самые новые — с наибольшим i. Задание 4 — давнее упавшее, которое
 * ещё можно повторить; прочие упавшие исчерпали попытки.
 */
function seed(f: Fixture) {
  const statuses: WorkflowJob['status'][] = ['completed', 'failed', 'stale'];
  const finished = Array.from({ length: 80 }, (_, i) =>
    job('done-' + i, statuses[i % 3], (i + 1) * 10, 30, {
      ...(i < 70 ? { id: 'B-many' } : {}),
      ...(i === 4 ? { attempts: 1 } : {}),
    }),
  );
  const active = job('live', 'running', 2000, 30);
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
    assert.ok(bytes < 24576, `default response is ${bytes} bytes`);
    // Действующее — целиком, с историей и без токена.
    const live = s.jobs.find((j) => j.key === active.key)!;
    assert.equal(live.status, 'running');
    assert.equal(live.history?.length, 30);
    assert.equal(live.compact, undefined);
    assert.equal('token' in live, false);
    // Законченные: последние 10 по времени конца и давнее повторяемое упавшее.
    const done = s.jobs.filter((j) => j.key !== active.key);
    assert.deepEqual(keys(done), keys([...finished.slice(-10), finished[4]]));
    for (const j of done) {
      assert.equal(j.compact, true);
      assert.equal(j.history, undefined);
      assert.equal(j.historyLength, 30);
      assert.equal('inputDigest' in j, false);
      // Последнее событие не противоречит статусу.
      assert.equal(j.lastEvent?.event, j.status);
      assert.ok(j.endedAt);
    }
    // Ошибка упавших — целиком (очередь хранит до 1000 знаков).
    const failed = done.filter((j) => j.status === 'failed');
    assert.deepEqual(keys(failed), keys([70, 73, 76, 79, 4].map((i) => finished[i])));
    for (const j of failed) assert.equal(j.error, ERROR);
    const retry = done.find((j) => j.key === finished[4].key)!;
    assert.equal(retry.retryable, true);
    assert.equal(done.filter((j) => j.retryable).length, 1);
    assert.deepEqual(
      { ...s.finished, hint: undefined },
      {
        total: 80,
        byStatus: { completed: 27, failed: 27, stale: 26 },
        retryable: 1,
        listed: 11,
        omitted: 69,
        compact: true,
        hint: undefined,
      },
    );
    assert.match(s.finished.hint ?? '', /store order, not time order/);
    assert.match(s.finished.hint ?? '', /key returns one job in full \(whole error and history\)/);
    assert.match(s.finished.hint ?? '', /kind and id.*active.*limit/);
    assert.ok(s.queue, 'the rest of the envelope stays');
  } finally {
    f.cleanup();
  }
});

test('workflow_status: фильтры key, kind/id, active и limit', () => {
  const f = fixture();
  try {
    const { finished, active } = seed(f);
    // active: true — только действующие; законченные не перечислены, но счёт есть.
    const live = status(f, { active: true });
    assert.deepEqual(
      live.jobs.map((j) => j.key),
      [active.key],
    );
    assert.deepEqual([live.finished.total, live.finished.listed], [80, 0]);
    assert.match(live.finished.hint ?? '', /^active true lists no finished jobs; 80 match/);
    // active: false и limit — только законченные: последние limit и повторяемое.
    const three = status(f, { active: false, limit: 3 });
    assert.deepEqual(keys(three.jobs), keys([...finished.slice(-3), finished[4]]));
    assert.deepEqual(
      [three.finished.total, three.finished.listed, three.finished.omitted],
      [80, 4, 76],
    );
    // key — одно задание целиком, даже давно законченное.
    const old = finished[4];
    const one = status(f, { key: old.key });
    assert.equal(one.jobs.length, 1);
    assert.equal(one.jobs[0].key, old.key);
    assert.equal(one.jobs[0].history?.length, 30);
    assert.equal(one.jobs[0].compact, undefined);
    assert.equal(one.jobs[0].inputDigest, old.inputDigest);
    assert.equal(one.jobs[0].error, ERROR);
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
    // id без kind — задания предмета любого вида.
    assert.deepEqual(
      status(f, { id: other.id }).jobs.map((j) => j.key),
      [other.key],
    );
    // Неизвестный ключ — пустой список, не отказ.
    assert.deepEqual(status(f, { key: key('none') }).jobs, []);
    // Вход проверяется схемой.
    for (const bad of [{ limit: 0 }, { limit: 201 }, { key: 'abc' }, { boardId: 'B-x' }])
      assert.throws(() => status(f, bad));
  } finally {
    f.cleanup();
  }
});

test('workflow_status: время окончания упавшего без отметки — лучшее доступное, оценкой', () => {
  const f = fixture();
  try {
    // Упал в ходе работы: последнее событие — взятие стадии (минута 500),
    // начало — минута 100. Другой — без истории, начат на минуте 300.
    const late = job('late', 'failed', 501, 3, { startedAt: at(100) });
    const bare = job('bare', 'failed', 330, 0);
    // Отказ при взятии стадии: событие со статусом, время точное.
    const claimed = job('claimed', 'failed', 401, 2, { last: 'failed' });
    put(f, [late, bare, claimed]);
    const s = status(f, { limit: 1 });
    assert.deepEqual(
      s.jobs.map((j) => j.key),
      [late.key],
    );
    assert.equal(s.jobs[0].endedAt, at(500));
    assert.equal(s.jobs[0].endedAtEstimated, true);
    assert.deepEqual(s.jobs[0].lastEvent, { stage: 1, event: 'failed' });
    const all = status(f, { limit: 3 });
    const of = (k: string) => all.jobs.find((j) => j.key === k)!;
    assert.equal(of(bare.key).endedAt, at(300));
    assert.equal(of(bare.key).endedAtEstimated, true);
    assert.equal(of(claimed.key).endedAt, at(400));
    assert.equal(of(claimed.key).endedAtEstimated, undefined);
    assert.deepEqual(of(claimed.key).lastEvent, { at: at(400), stage: 1, event: 'failed' });
    // Порядок «последние»: late (500), claimed (400), bare (300).
    assert.deepEqual(
      status(f, { limit: 2 })
        .jobs.map((j) => j.key)
        .sort(),
      [late.key, claimed.key].sort(),
    );
  } finally {
    f.cleanup();
  }
});

test('workflow_status: не помещающийся ответ сокращает историю, затем отбрасывает старейшие законченные', () => {
  const f = fixture();
  const original = Object.getOwnPropertyDescriptor(LeadWorkflow.prototype, 'waitingOf')!;
  try {
    const { finished } = seed(f);
    // 70 заданий одной доски целиком (id назван) — больше предела: история
    // сокращена, затем ушли старейшие неповторяемые; повторяемое осталось.
    const many = status(f, { kind: 'board', id: 'B-many', limit: 200 });
    assert.ok(checkJsonBytes(many, 60000).within);
    assert.equal(many.historyClipped, true);
    assert.equal(many.finished.total, 70);
    assert.ok(many.finished.omitted > 0 && many.finished.listed > 1);
    assert.equal(many.finished.listed + many.finished.omitted, 70);
    for (const j of many.jobs) {
      assert.equal(j.history?.length, 20);
      assert.equal(j.historyOmitted, 10);
    }
    const ofBoard = finished.filter((j, i) => j.id === 'B-many' && i !== 4);
    assert.deepEqual(
      keys(many.jobs),
      keys([...ofBoard.slice(-(many.finished.listed - 1)), finished[4]]),
    );
    assert.match(
      many.finished.hint ?? '',
      /^Finished jobs are listed in full; a history longer than 20 events is cut.*the oldest \d+ were dropped/,
    );
    // Законченное задание, названное ключом, с историей больше предела —
    // в ответе, с хвостом истории.
    const long = job('long', 'completed', 9000, 1500);
    put(f, [long]);
    const one = status(f, { key: long.key });
    assert.deepEqual(
      one.jobs.map((j) => j.key),
      [long.key],
    );
    assert.equal(one.jobs[0].history?.length, 20);
    assert.equal(one.jobs[0].historyOmitted, 1480);
    assert.deepEqual([one.finished.listed, one.finished.omitted], [1, 0]);
    assert.ok(checkJsonBytes(one, 60000).within);
    // Даже хвост истории не помещается (события по 5000 знаков): задание,
    // названное ключом, не отбрасывается молча — отказ 413 называет поля.
    const wide = job('wide', 'completed', 9100, 40);
    for (const e of wide.history) e.event = 'e'.repeat(5000);
    put(f, [wide]);
    assert.throws(
      () => status(f, { key: wide.key }),
      (e: unknown) => e instanceof DomainError && e.status === 413 && /key.*limit/.test(e.message),
    );
    // Без фильтра место освобождают законченные, история действующих цела.
    const retryables = Array.from({ length: 120 }, (_, i) =>
      job('retry-' + i, 'failed', 100 + i, 2, { attempts: 1 }),
    );
    put(f, retryables);
    const crowded = status(f);
    assert.ok(checkJsonBytes(crowded, 60000).within);
    assert.equal(crowded.historyClipped, undefined);
    assert.equal(crowded.jobs.find((j) => j.key === key('live'))!.history?.length, 30);
    assert.ok(crowded.finished.omitted > 69);
    // Уходят сначала неповторяемые: из последних 10 законченных (без
    // повторяемых) не осталось ни одного, а повторяемые — самые новые.
    const listed = crowded.jobs.filter((j) => j.status !== 'running');
    assert.ok(listed.every((j) => j.retryable === true));
    // Действующее задание с огромной историей: хвост последних 20 событий,
    // ожидание стадии сохраняется.
    put(f, [job('huge', 'queued', 5000, 3000)]);
    LeadWorkflow.prototype.waitingOf = function (j) {
      return 'key' in j && j.key === key('huge')
        ? { kind: 'input' as const, requestIds: ['R-1'] }
        : undefined;
    };
    const huge = status(f, { active: true });
    const j = huge.jobs.find((x) => x.key === key('huge'))!;
    assert.equal(huge.historyClipped, true);
    assert.equal(j.history?.length, 20);
    assert.equal(j.historyOmitted, 2980);
    assert.deepEqual(j.waiting, { kind: 'input', requestIds: ['R-1'] });
    assert.ok(checkJsonBytes(huge, 60000).within);
    // Без нехватки места история не сокращается.
    assert.equal(status(f, { key: key('live') }).historyClipped, undefined);
  } finally {
    Object.defineProperty(LeadWorkflow.prototype, 'waitingOf', original);
    f.cleanup();
  }
});

test('Отказ по пределу ответа называет существующий путь сузить запрос', () => {
  const own = oversized('workflow_status');
  assert.match(own, /workflow_status/);
  assert.match(own, /key.*kind и id.*active.*limit/);
  for (const operation of ['usage_report', 'project_context', 'preparation_status']) {
    const generic = oversized(operation);
    assert.match(generic, new RegExp(operation));
    assert.match(generic, /inputSchema/);
  }
  for (const text of [own, oversized('x')]) assert.doesNotMatch(text, /CLI-отчёт/);
});
