import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowJob } from '../src/core/lead-workflow.ts';
import { DomainError } from '../src/core/model.ts';
import { SERVER_STOPPING } from '../src/core/service.ts';
import { git } from '../src/runner/process.ts';
import { requirementSnapshot } from '../src/runner/requirements.ts';
import { WorkspaceRunner } from '../src/runner/workspace.ts';
import { input } from './helpers.ts';
import { jointFixture, tickFor } from './joint-fixture.ts';

type Fixture = Awaited<ReturnType<typeof jointFixture>>;

/** Итог проверки, начатой циклом вне такта, — как его оставляет `launch`. */
function finishedFlight(f: Fixture, error: unknown) {
  const joints = (f.lead as unknown as { joints: Map<string, unknown> }).joints;
  joints.set(f.change.id, {
    runner: { stop: async () => {} },
    promise: Promise.resolve(),
    done: true,
    failed: true,
    error,
  });
}

async function untilSettled(f: Fixture, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (['queued', 'running'].includes(f.flow.get(f.job.key).status) && Date.now() < deadline)
    await tickFor(f.lead, 2000);
  return f.flow.get(f.job.key);
}

test('Ожидание при отложенном начале проверки (NOT_READY, остановка) — ожидание стадии, а не её провал', async () => {
  const f = await jointFixture({ gateMs: 200 });
  try {
    await f.lead.tick(); // стадия 0: доски приняты
    assert.equal(f.flow.get(f.job.key).stage, 1);
    // Попытку выдали в окне между ответом стадии и началом проверки.
    finishedFlight(
      f,
      Object.assign(new DomainError('Дождитесь текущих попыток перед совместной проверкой'), {
        code: 'NOT_READY',
      }),
    );
    await f.lead.tick();
    let job = f.flow.get(f.job.key);
    assert.equal(job.status, 'queued', JSON.stringify(job));
    assert.equal(job.attempts, 0);
    assert.equal(job.error, undefined);
    finishedFlight(f, new Error(SERVER_STOPPING));
    await f.lead.tick();
    job = f.flow.get(f.job.key);
    assert.equal(job.status, 'queued', JSON.stringify(job));
    assert.equal(job.attempts, 0);
    // Дальше стадия начинает проверку сама и доходит до приёмки.
    job = await untilSettled(f);
    assert.equal(job.status, 'completed', JSON.stringify(job));
    assert.deepEqual(
      f.verifications().map((v) => v.status),
      ['passed'],
    );
  } finally {
    await f.cleanup();
  }
});

test('Итог проверки не достаётся следующей попытке, если стадия упала по другой причине', async () => {
  // Проверка закончилась отказом gate, но такт, который её забирает, падает
  // раньше — изменились требования. После исправления требований повтор
  // задания должен начать новую проверку, а не повторить прежний отказ.
  const f = await jointFixture({ gateMs: 100, fail: true, start: false });
  try {
    const repo = f.config.repository;
    const spec = join(repo, 'docs/spec.md');
    const commit = async (text: string) => {
      await writeFile(spec, text);
      await git(repo, 'add', 'docs/spec.md');
      await git(repo, 'commit', '-qm', 'Spec');
    };
    await mkdir(join(repo, 'docs'), { recursive: true });
    const original = '## REQ-joint: Joint\nThe joint result works.\n';
    await commit(original);
    const snapshot = requirementSnapshot(repo, 'docs/spec.md');
    f.store.change('fixture.requirements', (s) => {
      for (const t of s.tasks)
        t.requirements = [
          {
            ...snapshot.requirements[0],
            source: snapshot.source,
            gate: f.config.gates[0].id,
            scenario: 'Joint result',
          },
        ] as typeof t.requirements;
    });
    const job = f.flow.start({ kind: 'changeset', id: f.change.id, authorRuntime: 'codex' });
    await f.lead.tick(); // стадия 0
    await f.lead.tick(); // стадия 1 начинает проверку
    await f.lead.settled();
    assert.deepEqual(
      f.verifications().map((v) => v.status),
      ['failed'],
    );
    await commit(original.replace('works', 'works offline'));
    await f.lead.tick();
    let current = f.flow.get(job.key);
    assert.equal(current.status, 'failed');
    assert.match(current.error ?? '', /Требования изменились/);
    await commit(original);
    f.flow.retry(job.key);
    await f.lead.tick();
    await f.lead.settled();
    current = f.flow.get(job.key);
    assert.notEqual(current.status, 'failed', JSON.stringify(current));
    assert.equal(f.verifications().length, 2);
  } finally {
    await f.cleanup();
  }
});

test('Утраченное владение заданием ведущего (истёкший срок) — прерывание стадии, а не провал', async () => {
  const f = await jointFixture({ gateMs: 200 });
  try {
    let expired = false;
    const finish = f.lead.workflow.finish.bind(f.lead.workflow);
    f.lead.workflow.finish = (job: WorkflowJob, wait?: boolean) => {
      if (!expired && job.kind === 'changeset') {
        expired = true;
        // Срок истёк раньше продления: процесс стоял дольше срока владения.
        const saved = f.flow.get(job.key);
        f.store.atomic(() =>
          f.store.saveLocal('lead', undefined, job.key, { ...saved, leaseUntil: 0 }),
        );
      }
      return finish(job, wait);
    };
    await f.lead.tick();
    assert.equal(expired, true);
    const job = f.flow.get(f.job.key);
    assert.equal(job.status, 'queued', JSON.stringify(job));
    assert.equal(job.stage, 0);
    assert.equal(job.attempts, 1);
    assert.ok(job.error);
    const done = await untilSettled(f);
    assert.equal(done.status, 'completed', JSON.stringify(done));
  } finally {
    await f.cleanup();
  }
});

test('Workspace.start: незавершённые задачи называются до снимка, исчерпанный предел набора — с путём', async () => {
  const f = await jointFixture({ gateMs: 100, fail: true, maxAttempts: 2, start: false });
  try {
    const late = f.h.createBoard('Late board', '', 'main');
    const open = f.h.addTask(late.id, input('Late task'));
    const mixed = f.workspace.create({
      title: 'Mixed result',
      description: 'An accepted board and an open one.',
      boardIds: [f.board.id, late.id],
    });
    assert.throws(
      () => f.workspace.start(mixed.id),
      (e: Error) =>
        e.message.startsWith('Сначала завершите все задачи ChangeSet: ') &&
        e.message.includes(open.id),
    );
    // Предел набора — 2 проверки на все ChangeSet над теми же задачами.
    const runner = new WorkspaceRunner(f.h, f.root);
    await assert.rejects(runner.verify(f.change.id));
    const second = f.workspace.create({
      title: 'Second result',
      description: 'The same tasks in a new ChangeSet.',
      boardIds: [f.board.id],
    });
    await assert.rejects(runner.verify(second.id));
    assert.equal(f.verifications(second.id).length, 1);
    assert.throws(
      () => f.workspace.start(second.id),
      (e: Error) =>
        e.message.startsWith('Исчерпан предел совместных проверок этого набора задач (2)') &&
        e.message.includes('новый ChangeSet над теми же задачами получит тот же отказ') &&
        e.message.includes('новая ревизия доски') &&
        // Обе проверки дошли до gate: прерванных нет.
        !e.message.includes('прерваны'),
    );
    await runner.stop();
  } finally {
    await f.cleanup();
  }
});

test('Постоянный отказ начала проверки (NOT_READY) ждёт ограниченно, с паузами, и затем проваливает стадию с причиной', async () => {
  const f = await jointFixture({ gateMs: 100 });
  const verify = Object.getOwnPropertyDescriptor(WorkspaceRunner.prototype, 'verify')!;
  const starts: number[] = [];
  // Причина не проходит: состояние задач продукта и движка разошлось.
  WorkspaceRunner.prototype.verify = function () {
    starts.push(Date.now());
    throw Object.assign(new DomainError('Сначала завершите все поручения набора'), {
      code: 'NOT_READY',
    });
  };
  try {
    f.lead.startRetry = { limit: 2, delayMs: 300 };
    const job = await untilSettled(f, 30_000);
    assert.equal(job.status, 'failed', JSON.stringify(job));
    assert.match(
      job.error ?? '',
      /Совместная проверка не начинается: Сначала завершите все поручения набора \(отказ начала 3 раз подряд\)/,
    );
    // Три начала, между ними — паузы 300 и 600 мс, а не каждый такт.
    assert.equal(starts.length, 3);
    assert.ok(starts[1] - starts[0] >= 300);
    assert.ok(starts[2] - starts[1] >= 600);
    assert.equal(f.verifications().length, 0);
  } finally {
    Object.defineProperty(WorkspaceRunner.prototype, 'verify', verify);
    await f.cleanup();
  }
});

test('Попытки стадии, исчерпанные потерей владения, оставляют в ошибке задания её причину', async () => {
  const f = await jointFixture({ gateMs: 100 });
  try {
    const finish = f.lead.workflow.finish.bind(f.lead.workflow);
    f.lead.workflow.finish = (job: WorkflowJob, wait?: boolean) => {
      if (job.kind === 'changeset') {
        const saved = f.flow.get(job.key);
        f.store.atomic(() =>
          f.store.saveLocal('lead', undefined, job.key, { ...saved, leaseUntil: 0 }),
        );
      }
      return finish(job, wait);
    };
    const job = await untilSettled(f, 30_000);
    assert.equal(job.status, 'failed', JSON.stringify(job));
    assert.equal(job.stage, 0);
    assert.match(
      job.error ?? '',
      /^Исчерпаны попытки стадии; последняя причина: Владение заданием утрачено/,
    );
  } finally {
    await f.cleanup();
  }
});
