import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentService } from '../src/application/agent.ts';
import { repositorySchema } from '../src/core/model.ts';
import { specDigest } from '../src/core/service.ts';
import { command } from '../src/runner/process.ts';
import { SCENARIO_PROOF, type ScenarioProof } from '../src/runner/scenario-proof.ts';
import { fixture, map, releaseScenario, sceneProof } from './product-fixture.ts';

const reason = 'The accepted policy test already checks this client behaviour';
type Fixture = Awaited<ReturnType<typeof fixture>>;

const proveWith =
  (agent: AgentService) =>
  (taskId: string, input: Record<string, unknown> = {}) =>
    agent.run({
      operation: 'task_scenario_proof',
      input: {
        taskId,
        gate: 'local',
        scenario: releaseScenario,
        testId: 'policy type',
        reason,
        ...input,
      },
    }) as Promise<{ runId: string; sha: string; level: string; actor: string }>;
const records = (f: Fixture, repositoryId: string) =>
  Object.values(f.store.localRecords<ScenarioProof>(SCENARIO_PROOF, repositoryId));
const taskOf = (f: Fixture, repositoryId: string) =>
  f.store.read().tasks.find((t) => t.repositoryId === repositoryId && t.status === 'done')!;
const cliProve = (f: Fixture, taskId: string) =>
  command(
    [
      process.execPath,
      '--import',
      'tsx',
      'src/cli.ts',
      'scenario-proof',
      '--task',
      taskId,
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

test('task_scenario_proof evidences a release scenario with an existing test at the accepted SHA; the release verification goes stale once and an identical re-proof keeps it', async () => {
  const f = await fixture();
  const prove = proveWith(new AgentService(f.h, f.root));
  try {
    // Сценарий доказывает связь задачи библиотеки; задача приложения той же
    // истории связи с testcase не имеет.
    f.plan(sceneProof, ['chat']);
    await f.run();
    await f.accept();
    const app = taskOf(f, 'app');
    const before = structuredClone(f.store.read().tasks);
    const runs = f.store.read().runs.length;
    const status = () => f.view().features[0].checks[0];
    assert.deepEqual(
      status().evidence.map((e) => e.repositoryId),
      ['chat'],
    );
    const change = f.runner.workspace.create({
      title: 'Релиз модерации',
      description: 'Сценарий доказан связью и существующим тестом.',
      boardIds: f.boards,
      releaseId: 'mvp',
    });
    await f.runner.verify(change.id);

    // Отказ без записи: testcase на принятом SHA не выполнялся; в operator
    // mode агент сам не записывает.
    await assert.rejects(
      prove(app.id, { testId: 'absent behaviour' }),
      (e: Error) =>
        e.message.includes('Сценарий не доказан прогоном local') &&
        e.message.includes('Тест absent behaviour не выполнялся'),
    );
    f.h.config.approvalMode = 'operator';
    await assert.rejects(prove(app.id), /записывает оператор: devcontour scenario-proof/);
    f.h.config.approvalMode = 'agent';
    assert.deepEqual(records(f, 'app'), []);

    const proved = await prove(app.id);
    assert.equal(proved.level, 'testcase');
    assert.equal(proved.sha, app.resultSha);
    assert.equal(proved.actor, 'agent');
    assert.match(proved.runId, /^SP-/);
    const [record] = records(f, 'app');
    // Запись — свежий прогон этой операции, а не evidence попытки задачи.
    assert.equal(record.runId, proved.runId);
    assert.equal((record.evidence as { runId?: string }).runId, proved.runId);
    const attemptIds = new Set(f.store.read().runs.flatMap((r) => r.evidence.map((e) => e.id)));
    assert.ok(!attemptIds.has(record.evidence.id));
    assert.equal(record.evidence.sha, app.resultSha);
    assert.deepEqual(
      status().evidence.toSorted((a, b) => a.repositoryId.localeCompare(b.repositoryId)),
      [
        { repositoryId: 'app', taskId: app.id, testId: 'policy type', afterAcceptance: true },
        { repositoryId: 'chat', taskId: taskOf(f, 'chat').id, testId: 'policy type' },
      ],
    );
    const listed = {
      featureId: 'block',
      gate: 'moderation',
      scenario: releaseScenario,
      repositoryId: 'app',
      taskId: app.id,
      testId: 'policy type',
      actor: 'agent',
      reason,
    };
    assert.deepEqual(f.view().afterAcceptanceScenarios, [listed]);
    // Засчитанное доказательство меняет покрытие: прежняя проверка устарела.
    assert.throws(
      () => f.runner.workspace.accept(change.id),
      /Покрытие или проверки релиза изменились/,
    );
    await f.runner.verify(change.id);
    // Тот же сценарий тем же тестом заново (оператор, CLI): новый прогон, но
    // покрытие то же — проверка остаётся актуальной.
    const cli = await cliProve(f, app.id);
    assert.equal(cli.code, 0, cli.stderr);
    const again = JSON.parse(cli.stdout) as { runId: string; actor: string };
    assert.equal(again.actor, 'operator');
    assert.notEqual(again.runId, proved.runId);
    assert.equal(records(f, 'app').length, 1);
    const accepted = f.runner.workspace.accept(change.id) as {
      status: string;
      afterAcceptanceScenarios?: unknown;
    };
    assert.equal(accepted.status, 'accepted');
    // Приёмка и её запись в журнале называют сопоставление теста сценарию.
    const byOperator = { ...listed, actor: 'operator' };
    assert.deepEqual(accepted.afterAcceptanceScenarios, [byOperator]);
    const journal = f.store.events().findLast((e) => e.type === 'changeset.accepted')!;
    assert.deepEqual(
      (journal.data as { afterAcceptanceScenarios?: unknown }).afterAcceptanceScenarios,
      [byOperator],
    );
    assert.equal(f.view().releaseAccepted, true);
    // Постановка, принятый результат и история задач не изменились.
    assert.deepEqual(f.store.read().tasks, before);
    for (const t of f.store.read().tasks) assert.equal(t.approvedDigest, specDigest(t));
    assert.equal(f.store.read().runs.length, runs);
    // Журнал: каждый прогон начат и закончен, с тем же runId.
    const byRun = new Map<string, string[]>();
    for (const e of f.store.events().filter((x) => x.type.startsWith('scenario.proof.'))) {
      const id = (e.data as { runId: string }).runId;
      byRun.set(id, [...(byRun.get(id) ?? []), e.type]);
    }
    const done = ['scenario.proof.recorded', 'scenario.proof.started'];
    assert.deepEqual(byRun.get(proved.runId)?.toSorted(), done);
    assert.deepEqual(byRun.get(again.runId)?.toSorted(), done);
    assert.ok(
      [...byRun.values()].some(
        (types) => types.toSorted().join() === 'scenario.proof.failed,scenario.proof.started',
      ),
    );
  } finally {
    await f.close();
  }
});

test('A scenario proof needs a fresh passing testcase of a test gate at the accepted SHA, a scenario of the feature the task serves and an intact accepted task', async () => {
  const f = await fixture();
  const prove = proveWith(new AgentService(f.h, f.root));
  try {
    // Сценарий фичи блокировки обслуживает только история приложения;
    // история библиотеки — другая фича с другим сценарием.
    const scoped = map();
    // Оба релиза карты (mvp и next) — одинаково: доказательство засчитал бы
    // любой релиз, где история задачи обслуживает фичу сценария.
    for (const release of scoped.releases) {
      const [block, exported] = release.features!;
      for (const channel of block.channels)
        if (channel.scope === 'included')
          channel.stories = channel.stories.filter((s) => s.repositoryId === 'app');
      exported.channels[0] = {
        channelId: 'admin',
        scope: 'included',
        stories: [{ repositoryId: 'chat', storyId: 'block' }],
      };
      exported.checks = [{ gate: 'moderation', scenario: 'Модератор получает журнал изменений.' }];
    }
    await f.save(scoped);
    f.plan({ scenario: releaseScenario });
    await f.run();
    await f.accept();
    const app = taskOf(f, 'app');
    const chat = taskOf(f, 'chat');
    const status = () => f.view().features[0].checks[0].status;
    assert.equal(status(), 'missing');
    // Gates, которых попытки задач не исполняли: доказательство может дать
    // только прогон самой операции.
    const repos = f.h.config.repositories;
    const appRepo = repos.find((r) => r.id === 'app')!;
    const report = (name: string) => ({ type: 'junit', path: '.reports/' + name + '.xml' });
    const node = (code: string) => [process.execPath, '-e', code];
    const write = (xml: string, exit = 0) =>
      `const fs=require('fs');const ok=JSON.parse(fs.readFileSync('policy.json','utf8')).canPost===false;fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,${JSON.stringify(xml)}.replace('STATE',ok?'':'<failure message="policy allows posting"/>'));process.exitCode=${exit}`;
    const scenarioCommand = node(
      write('<testsuite><testcase name="client shows block">STATE</testcase></testsuite>'),
    );
    const withGates = (scenario: string[]) =>
      repositorySchema.parse({
        ...appRepo,
        gates: [
          ...appRepo.gates,
          { id: 'scenario', kind: 'test', command: scenario, report: report('scenario') },
          {
            id: 'broken',
            kind: 'test',
            command: node(
              write(
                '<testsuite><testcase name="client allows posting"><failure message="posting is blocked"/></testcase></testsuite>',
                1,
              ),
            ),
            report: report('broken'),
          },
          { id: 'lint', kind: 'check', command: node('process.exitCode=0') },
        ],
      });
    const setGates = (scenario: string[]) => {
      f.h.config.repositories = f.h.config.repositories.map((r) =>
        r.id === 'app' ? withGates(scenario) : r,
      );
    };
    setGates(scenarioCommand);
    assert.ok(!f.store.read().runs.some((r) => r.evidence.some((e) => e.gate === 'scenario')));

    // Отказы до прогона: не test gate, сценарий не из карты, задача истории
    // вне фичи сценария, задача workspace, не выполненная и с изменённой
    // постановкой.
    await assert.rejects(prove(app.id, { gate: 'lint' }), /Gate lint не объявлен как test gate/);
    await assert.rejects(
      prove(app.id, { scenario: 'Сценарий, которого нет в карте релиза.' }),
      /не является сценарием проверки фичи/,
    );
    await assert.rejects(prove(chat.id), /не является сценарием проверки фичи/);
    const synthetic = [
      { ...app, id: 'T-ws-0001', scope: 'workspace' as const },
      { ...app, id: 'T-draft-0001', status: 'draft' as const },
      { ...app, id: 'T-edit-0001', title: app.title + ' (edited)' },
    ];
    f.store.change('fixture.synthetic-tasks', (s) => {
      s.tasks.push(...structuredClone(synthetic));
    });
    await assert.rejects(prove('T-ws-0001'), /задача workspace не доказывает/);
    await assert.rejects(prove('T-draft-0001'), /только выполненной задаче/);
    await assert.rejects(prove('T-edit-0001'), /постановка задачи изменилась/);
    f.store.change('fixture.drop-synthetic-tasks', (s) => {
      s.tasks = s.tasks.filter((t) => !synthetic.some((x) => x.id === t.id));
    });
    // Настоящий провал на принятом SHA: testcase падает, gate не проходит
    // (пропущенный testcase harness тоже считает провалом gate).
    await assert.rejects(
      prove(app.id, { gate: 'broken', testId: 'client allows posting' }),
      /Сценарий не доказан прогоном broken.*не прошла/,
    );
    assert.deepEqual(records(f, 'app'), []);
    assert.equal(status(), 'missing');

    const proved = await prove(app.id, { gate: 'scenario', testId: 'client shows block' });
    const [record] = records(f, 'app');
    assert.equal(record.runId, proved.runId);
    assert.equal(record.evidence.gate, 'scenario');
    assert.equal(record.evidence.sha, app.resultSha);
    assert.equal(status(), 'evidenced');

    const [key] = Object.keys(f.store.localRecords<ScenarioProof>(SCENARIO_PROOF, 'app'));
    const save = (value: ScenarioProof) =>
      f.store.atomic(() => f.store.saveLocal(SCENARIO_PROOF, 'app', key, value));
    // Правило перепроверяется при чтении: не прошедший testcase, код выхода,
    // другой SHA или постановка — не доказательство.
    for (const broken of [
      {
        ...record,
        evidence: {
          ...record.evidence,
          tests: record.evidence.tests!.map((t) => ({ ...t, status: 'failed' as const })),
        },
      },
      { ...record, evidence: { ...record.evidence, exitCode: 1 } },
      { ...record, resultSha: 'f'.repeat(40) },
      { ...record, approvedDigest: 'e'.repeat(64) },
    ]) {
      save(broken);
      assert.equal(status(), 'missing');
    }
    save(record);
    assert.equal(status(), 'evidenced');
    // Другое определение gate с тем же ID — другой gate.
    setGates([...scenarioCommand, '--']);
    assert.equal(status(), 'missing');
    setGates(scenarioCommand);
    assert.equal(status(), 'evidenced');
    // Замена задачи корректировкой снимает её доказательство.
    f.h.correct(f.boards[0], [app.id], 'The client behaviour changes after review');
    assert.equal(status(), 'missing');
    await assert.rejects(prove(app.id), /заменена корректировкой/);
  } finally {
    await f.close();
  }
});
