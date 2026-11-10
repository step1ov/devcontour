import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowJob } from '../src/core/lead-workflow.ts';
import { DomainError } from '../src/core/model.ts';
import { jointDemos, jointFixture, sleep, tickFor } from './joint-fixture.ts';

after(() => jointDemos.close());

test('Совместная проверка ChangeSet переживает такт и потерю владения заданием ведущего', async () => {
  // Проверка дольше срока владения заданием. Продление владения однажды
  // не удаётся (процесс стоял дольше срока, как при синхронной работе на
  // большом наборе): прежде это прерывало саму проверку до первого gate, и
  // каждая прерванная проверка тратила предел совместных проверок набора.
  //
  // Отказ продления подставлен на всё время проверки: прежде стадия держала
  // владение, пока шла проверка, и отказ обрывал её. Теперь стадия на время
  // проверки владения не держит (такты ждут коротко), и отказ обычно не
  // срабатывает вовсе — проверка от владения заданием не зависит. Правило
  // «потеря владения — прерывание» проверяет отдельный тест
  // (lead-joint-flight.test.ts).
  const f = await jointFixture({ gateMs: 6000 });
  try {
    let lost = false;
    const heartbeat = f.lead.workflow.heartbeat.bind(f.lead.workflow);
    f.lead.workflow.heartbeat = (job: WorkflowJob) => {
      if (
        !lost &&
        job.kind === 'changeset' &&
        f.verifications().some((v) => v.status === 'active')
      ) {
        lost = true;
        throw new DomainError('Владение заданием утрачено');
      }
      heartbeat(job);
    };
    const deadline = Date.now() + 90_000;
    while (['queued', 'running'].includes(f.flow.get(f.job.key).status) && Date.now() < deadline) {
      await tickFor(f.lead, 2500);
    }
    const job = f.flow.get(f.job.key);
    assert.equal(job.status, 'completed', JSON.stringify(job));
    assert.deepEqual(
      f.verifications().map((v) => [v.status, v.error ?? null]),
      [['passed', null]],
    );
    const v = f.verifications()[0];
    // Проверка шла дольше такта и срока владения заданием.
    assert.ok(Date.parse(v.finishedAt!) - Date.parse(v.startedAt) > 5000);
    assert.ok(f.store.read().changeSets[0].acceptance);
  } finally {
    await f.cleanup();
  }
});

test('Остановка цикла ведущего (остановка сервера) прерывает идущую совместную проверку', async () => {
  const f = await jointFixture({ gateMs: 120_000 });
  try {
    const deadline = Date.now() + 60_000;
    while (!f.verifications().some((v) => v.status === 'active') && Date.now() < deadline)
      await tickFor(f.lead, 500);
    assert.ok(
      f.verifications().some((v) => v.status === 'active'),
      JSON.stringify(f.flow.get(f.job.key)),
    );
    // Gate уже идёт: проверка не закончилась бы ещё две минуты.
    await sleep(1500);
    const stopped = Date.now();
    await f.lead.stop();
    assert.ok(Date.now() - stopped < 30_000, 'stop waits for the gate instead of aborting it');
    const [v] = f.verifications();
    assert.equal(v.status, 'failed');
    // Задание не провалено: остановка — прерывание, стадия продолжится после запуска.
    assert.equal(f.flow.get(f.job.key).status, 'queued');
  } finally {
    await f.cleanup();
  }
});
