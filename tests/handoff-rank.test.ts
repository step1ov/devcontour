// Порядок шага ведущего в пакете передачи: блокеры живой работы (ответ на
// вопрос исполнителя ждёт применения, упало задание доски) — раньше решения о
// плане другой доски, например разбора находок. Пакет harness называет первую
// по порядку работ остановку, и черновик ранней доски заслонял их.
// Модели не вызываются: demo-исполнитель и управляемый reviewer ответа.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { controlled, inputDemos, inputFixture, untilQuestion } from './input-fixture.ts';
import { devcontourHandoff } from '../src/application/handoff.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';

after(() => inputDemos.close());

test('session_handoff: an answered question and a failed board job rank above the plan decision of a findings board', async () => {
  const f = await inputFixture(controlled());
  try {
    // Доска находок создана раньше: её черновик — первая остановка пакета.
    const findings = f.h.createBoard('Agent findings');
    const finding = f.plainTask(findings.id, 'Draft finding');
    const { taskId, boardId } = f.askingTask();
    await untilQuestion(f, boardId);
    const [request] = f.service.list({ taskId }).requests;

    // Вопрос без ответа пакет называет сам: answer-input, как и прежде.
    const pending = devcontourHandoff(f.h, {});
    assert.equal(pending.host.next?.action, 'answer-input', JSON.stringify(pending.host.next));
    assert.equal(pending.host.next?.input?.requestId, request.requestId);
    // Ссылка на вопрос — адрес панели, а не путь, которого у панели нет.
    assert.ok(
      pending.host.next?.detail.includes(`(/?view=boards&tab=list&task=${taskId}#input)`),
      pending.host.next?.detail,
    );
    assert.doesNotMatch(pending.host.next?.detail ?? '', /\/tasks\//);

    f.service.answer(
      {
        requestId: request.requestId,
        text: 'Use JSON.',
        optionId: 'json',
        expectedVersion: request.version,
      },
      'operator',
    );
    // Записанный ответ пакет ставит после черновика находок: шаг ведущего
    // всё равно apply-input, а не план находок.
    const answered = devcontourHandoff(f.h, {});
    assert.equal(answered.pack.next.workId, finding, 'пакет называет черновик находок');
    assert.equal(answered.host.next?.action, 'apply-input', JSON.stringify(answered.host.next));
    assert.equal(answered.host.next?.boardId, boardId);
    assert.equal(answered.host.next?.input?.state, 'answer-saved');
    assert.match(answered.host.next.detail, /input_context, input_review/);

    // Вопрос снят — остаётся упавшее задание доски с вопросом: шаг по
    // заданию раньше плана находок.
    f.service.cancel(
      {
        requestId: request.requestId,
        expectedVersion: f.service.show({ requestId: request.requestId }).version,
        reason: 'Withdrawn for the ranking test',
      },
      'operator',
    );
    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: boardId, authorRuntime: 'codex', maxAttempts: 3 });
    flow.fail(flow.claim(job.key, job.owner)!, 'runtime unavailable');
    const failed = devcontourHandoff(f.h, {});
    assert.equal(failed.host.next?.boardId, boardId, JSON.stringify(failed.host.next));
    assert.ok(
      failed.host.next?.action === 'workflow_retry' ||
        (failed.host.next?.action === 'decide' && failed.host.next.decision === 'job'),
      JSON.stringify(failed.host.next),
    );
    assert.equal(failed.host.next?.job?.key, job.key);
  } finally {
    await f.cleanup();
  }
});
