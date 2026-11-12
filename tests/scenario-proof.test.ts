import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentService } from '../src/application/agent.ts';
import { specDigest } from '../src/core/service.ts';
import { command } from '../src/runner/process.ts';
import { SCENARIO_PROOF, type ScenarioProof } from '../src/runner/scenario-proof.ts';
import { fixture, releaseScenario } from './product-fixture.ts';

test('task_scenario_proof proves a release scenario of an accepted task by running its existing test at the accepted SHA, without a writer or a spec change', async () => {
  const f = await fixture();
  const agent = new AgentService(f.h, f.root);
  const reason = 'The accepted policy test already checks this client behaviour';
  try {
    // Истории приняты, но связь называет сценарий без testcase: сценарий не
    // доказан, хотя тест поведения в репозитории уже есть.
    f.plan({ scenario: releaseScenario });
    await f.run();
    await f.accept();
    assert.equal(f.view().features[0].checks[0].status, 'missing');
    const issue = f.view().issues.find((i) => i.startsWith('сценариев релиза без доказательства'));
    assert.match(issue ?? '', /task_scenario_proof \(CLI scenario-proof\)/);
    assert.doesNotMatch(issue ?? '', /обычной корректировкой/);
    const tasks = () => f.store.read().tasks;
    const app = tasks().find((t) => t.repositoryId === 'app')!;
    const chat = tasks().find((t) => t.repositoryId === 'chat')!;
    const before = structuredClone(tasks());
    const runs = f.store.read().runs.length;
    const prove = (input: Record<string, unknown>) =>
      agent.run({
        operation: 'task_scenario_proof',
        input: {
          taskId: app.id,
          gate: 'local',
          scenario: releaseScenario,
          testId: 'policy type',
          reason,
          ...input,
        },
      });
    const records = (repositoryId: string) =>
      Object.values(f.store.localRecords<ScenarioProof>(SCENARIO_PROOF, repositoryId));

    // Отказы: несуществующий gate; testcase, который на принятом SHA не
    // выполнялся, — прогон есть, доказательства нет; в operator mode агент
    // сам не записывает.
    await assert.rejects(prove({ gate: 'absent' }), /Gate absent не объявлен как test gate/);
    await assert.rejects(
      prove({ testId: 'absent behaviour' }),
      (e: Error) =>
        e.message.includes('Сценарий не доказан прогоном local') &&
        e.message.includes('Тест absent behaviour не выполнялся'),
    );
    f.h.config.approvalMode = 'operator';
    await assert.rejects(prove({}), /записывает оператор: devcontour scenario-proof/);
    f.h.config.approvalMode = 'agent';
    assert.deepEqual(records('app'), []);
    assert.equal(f.view().features[0].checks[0].status, 'missing');

    const proved = await prove({});
    assert.equal(proved.level, 'testcase');
    assert.equal(proved.sha, app.resultSha);
    assert.equal(proved.actor, 'agent');
    const [record] = records('app');
    assert.equal(record.resultSha, app.resultSha);
    assert.equal(record.evidence.sha, app.resultSha);
    assert.equal(record.evidence.phase, 'integration');
    assert.ok(record.evidence.tests?.some((t) => t.id === 'policy type' && t.status === 'passed'));

    // Оператор доказывает тот же сценарий задачей библиотеки через CLI.
    const cli = await command(
      [
        process.execPath,
        '--import',
        'tsx',
        'src/cli.ts',
        'scenario-proof',
        '--task',
        chat.id,
        '--gate',
        'local',
        '--scenario',
        releaseScenario,
        '--test-id',
        'policy type',
        '--reason',
        reason,
        '--data',
        f.root,
      ],
      process.cwd(),
      { timeoutMs: 60000 },
    );
    assert.equal(cli.code, 0, cli.stderr);
    assert.equal((JSON.parse(cli.stdout) as { actor: string }).actor, 'operator');

    const view = f.view();
    assert.equal(view.features[0].checks[0].status, 'evidenced');
    assert.deepEqual(
      view.features[0].checks[0].evidence.toSorted((a, b) =>
        a.repositoryId.localeCompare(b.repositoryId),
      ),
      [
        { repositoryId: 'app', taskId: app.id, testId: 'policy type', afterAcceptance: true },
        { repositoryId: 'chat', taskId: chat.id, testId: 'policy type', afterAcceptance: true },
      ],
    );
    assert.equal(view.coverageComplete, true, JSON.stringify(view.issues));
    // Постановка, принятый результат и история задач не изменились; попыток
    // исполнителя не было.
    assert.deepEqual(tasks(), before);
    for (const t of tasks()) assert.equal(t.approvedDigest, specDigest(t));
    assert.equal(f.store.read().runs.length, runs);

    // Релиз проверяется и принимается обычным путём.
    const change = f.runner.workspace.create({
      title: 'Релиз модерации',
      description: 'Сценарий доказан существующим тестом.',
      boardIds: f.boards,
      releaseId: 'mvp',
    });
    await f.runner.verify(change.id);
    f.runner.workspace.accept(change.id);
    assert.equal(f.view().releaseAccepted, true);
  } finally {
    await f.close();
  }
});

test('A scenario proof counts only while its gate run proves the testcase at the task accepted SHA', async () => {
  const f = await fixture();
  const agent = new AgentService(f.h, f.root);
  try {
    f.plan({ scenario: releaseScenario }, ['chat']);
    await f.run();
    await f.accept();
    const app = f.store.read().tasks.find((t) => t.repositoryId === 'app')!;
    await agent.run({
      operation: 'task_scenario_proof',
      input: {
        taskId: app.id,
        gate: 'local',
        scenario: releaseScenario,
        testId: 'policy type',
        reason: 'The accepted policy test already checks this client behaviour',
      },
    });
    assert.equal(f.view().features[0].checks[0].status, 'evidenced');
    const [key, record] = Object.entries(
      f.store.localRecords<ScenarioProof>(SCENARIO_PROOF, 'app'),
    )[0];
    const save = (value: ScenarioProof) =>
      f.store.atomic(() => f.store.saveLocal(SCENARIO_PROOF, 'app', key, value));
    // Запись без прошедшего testcase или на другом SHA сценарий не доказывает:
    // правило перепроверяется при каждом чтении.
    save({
      ...record,
      evidence: {
        ...record.evidence,
        tests: record.evidence.tests!.map((t) => ({ ...t, status: 'failed' as const })),
      },
    });
    assert.equal(f.view().features[0].checks[0].status, 'missing');
    save({ ...record, resultSha: 'f'.repeat(40) });
    assert.equal(f.view().features[0].checks[0].status, 'missing');
    save({ ...record, approvedDigest: 'e'.repeat(64) });
    assert.equal(f.view().features[0].checks[0].status, 'missing');
    save(record);
    assert.equal(f.view().features[0].checks[0].status, 'evidenced');
    // Замена задачи корректировкой снимает её доказательство вместе с ней.
    f.h.correct(f.boards[0], [app.id], 'The client behaviour changes after review');
    assert.equal(f.view().features[0].checks[0].status, 'missing');
    await assert.rejects(
      agent.run({
        operation: 'task_scenario_proof',
        input: {
          taskId: app.id,
          gate: 'local',
          scenario: releaseScenario,
          testId: 'policy type',
          reason: 'The accepted policy test already checks this client behaviour',
        },
      }),
      /заменена корректировкой/,
    );
  } finally {
    await f.close();
  }
});
