// F61: удержание ожидающей стадии доски под паузой очереди длится, пока не
// сменится отпечаток ожидания. Снятие блокирующего вопроса исполнителя
// (input_cancel) полей задачи не меняет — отпечаток видит сам вопрос, и
// стадия захватывается снова, не дожидаясь снятия паузы.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { controlled, inputDemos, inputFixture } from './input-fixture.ts';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';

after(() => inputDemos.close());

test('F61: под паузой ведущего снятие блокирующего вопроса снова захватывает ожидающую стадию доски', async () => {
  const runtimes = controlled();
  const f = await inputFixture(runtimes);
  try {
    const { boardId, taskId } = f.askingTask('Asking task');
    const job = new LeadWorkflow(f.h).start({ kind: 'board', id: boardId, authorRuntime: 'codex' });
    const lead = new LeadRunner(f.h, f.root, runtimes);
    await lead.tick(); // согласование (demo)
    await lead.tick(); // выдача
    await f.scheduler.drain();
    await lead.tick();
    const [request] = f.service.list({ taskId }).requests;
    assert.ok(request, 'исполнитель спросил');
    assert.equal(new LeadWorkflow(f.h).get(job.key, job.owner).stage, 2);

    let claims = 0;
    const claim = lead.workflow.claim.bind(lead.workflow);
    lead.workflow.claim = (...args) => {
      claims++;
      return claim(...args);
    };
    lead.idleWait = { initialMs: 100, maxMs: 200 };
    f.h.pause(true, 'operator', 'lead');
    await lead.tick();
    const start = claims;
    await sleep(250);
    await lead.tick();
    assert.equal(claims, start, 'удержание под паузой ведущего');

    f.service.cancel(
      { requestId: request.requestId, expectedVersion: request.version, reason: 'Not needed' },
      'lead',
    );
    await lead.tick();
    assert.equal(claims, start + 1, 'снятый вопрос — немедленный захват');
    await lead.stop();
  } finally {
    await f.cleanup();
  }
});
