import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IntentService } from '../src/runner/intent.ts';
import { command } from '../src/runner/process.ts';
import { fixture, localDefinition, map, releaseScenario, sceneProof } from './product-fixture.ts';

test('A release scenario needs its own testcase or a recorded deferral; story coverage alone does not accept the release', async () => {
  const f = await fixture();
  try {
    // Истории покрыты принятыми задачами, но связь называет сценарий без
    // testcase: зелёный gate не доказывает, что сценарий кто-то проверил.
    f.plan({ scenario: releaseScenario });
    await f.run();
    await f.accept();
    const unmet = f.view();
    assert.equal(unmet.coverageComplete, false);
    assert.equal(unmet.features[0].checks[0].status, 'missing');
    assert.ok(
      unmet.issues.some(
        (i) =>
          i.includes('сценарий релиза block (gate moderation) без доказательства') &&
          i.includes(releaseScenario),
      ),
      JSON.stringify(unmet.issues),
    );
    const report = f.intent.report({ releaseId: 'mvp' }) as {
      coverageComplete: boolean;
      scenarios: { status: string }[] | null;
    };
    assert.equal(report.coverageComplete, false);
    assert.deepEqual(
      report.scenarios?.map((s) => s.status),
      ['missing'],
    );
    const change = f.runner.workspace.create({
      title: 'Релиз модерации',
      description: 'Сценарий без своего теста.',
      boardIds: f.boards,
      releaseId: 'mvp',
    });
    assert.throws(
      () => f.runner.verify(change.id),
      (e: Error) => /не покрыт/.test(e.message) && e.message.includes('testId'),
    );
    // Записанная причина отложить сценарий — явное решение, видимое в карте.
    const deferred = map();
    deferred.releases[0].features![0].checks[0].deferred =
      'Проверка на устройстве переносится в следующий релиз.';
    await f.save(deferred);
    const view = f.view();
    assert.equal(view.coverageComplete, true, JSON.stringify(view.issues));
    assert.equal(view.features[0].checks[0].status, 'deferred');
    assert.equal(view.features[0].checks[0].passed, false);
    // Отложенный сценарий не проверен: карта, отчёт и приёмка называют его.
    const listed = [
      {
        featureId: 'block',
        gate: 'moderation',
        scenario: releaseScenario,
        reason: 'Проверка на устройстве переносится в следующий релиз.',
      },
    ];
    assert.deepEqual(view.deferredScenarios, listed);
    assert.deepEqual(
      (f.intent.report({ releaseId: 'mvp' }) as { deferredScenarios: unknown }).deferredScenarios,
      listed,
    );
    await f.runner.verify(change.id);
    const accepted = f.runner.workspace.accept(change.id) as { deferredScenarios?: unknown };
    assert.deepEqual(accepted.deferredScenarios, listed);
    assert.equal(f.view().releaseAccepted, true);
    // Релиз без карты фич сценариев не объявляет: отчёт говорит об этом прямо.
    const legacy = map();
    delete legacy.product;
    for (const release of legacy.releases) delete release.features;
    await f.save(legacy);
    const plain = f.intent.report({ releaseId: 'mvp' }) as {
      scenarios: unknown;
      note: string;
    };
    assert.equal(plain.scenarios, null);
    assert.match(plain.note, /scenarios are not tracked/);
  } finally {
    await f.close();
  }
});

test('A release accepted under the earlier rule without proven scenarios is not accepted now, and its pending verification cannot be accepted', async () => {
  const f = await fixture();
  // Прежняя версия не знала сценариев: покрытие считалось по историям, а
  // сценарий не требовал testcase. Так записываются проверка и приёмка
  // прежней версии; затем правило возвращается.
  const proto = IntentService.prototype as unknown as {
    workspaceCoverage: (...args: unknown[]) => {
      issues: string[];
      components: { coverageComplete: boolean }[];
      scenarios: unknown[];
      complete: boolean;
    };
  };
  const current = proto.workspaceCoverage;
  proto.workspaceCoverage = function (this: unknown, ...args: unknown[]) {
    const coverage = current.apply(this, args);
    return {
      ...coverage,
      scenarios: [],
      complete: !coverage.issues.length && coverage.components.every((c) => c.coverageComplete),
    };
  };
  try {
    f.plan({ scenario: releaseScenario });
    await f.run();
    await f.accept();
    const create = (title: string) =>
      f.runner.workspace.create({
        title,
        description: 'Проверка прежней версии.',
        boardIds: f.boards,
        releaseId: 'mvp',
      });
    const pending = create('Проверен, но не принят');
    await f.runner.verify(pending.id);
    const old = create('Принят прежней версией');
    await f.runner.verify(old.id);
    f.runner.workspace.accept(old.id);
    assert.equal(f.view().releaseAccepted, true);
    proto.workspaceCoverage = current;
    assert.throws(
      () => f.runner.workspace.accept(pending.id),
      (e: Error) =>
        e.message.startsWith('Сценарии релиза не подтверждены') &&
        e.message.includes(releaseScenario),
    );
    const view = f.view();
    assert.equal(view.releaseAccepted, false);
    assert.equal(view.features[0].status, 'verified');
    assert.match(view.issues[0], /принят по прежнему правилу/);
    assert.ok(view.acceptanceOverridden);
    const cli = await command(
      [
        process.execPath,
        '--import',
        'tsx',
        'src/cli.ts',
        'product-view',
        '--release',
        'mvp',
        '--require-accepted',
        '--data',
        f.root,
      ],
      process.cwd(),
      { timeoutMs: 20000 },
    );
    assert.equal(cli.code, 1);
    assert.equal((JSON.parse(cli.stdout) as { releaseAccepted: boolean }).releaseAccepted, false);
  } finally {
    proto.workspaceCoverage = current;
    await f.close();
  }
});

test('Scenario evidence counts only for the feature whose stories the task serves, and one gate tracks several scenarios separately', async () => {
  const f = await fixture();
  try {
    const second = 'Модератор видит причину блокировки в журнале.';
    const scoped = map();
    const [block, exported] = scoped.releases[0].features!;
    // Два сценария на одном gate: каждый доказывается отдельно.
    block.checks.push({ gate: 'moderation', scenario: second });
    // Вторая фича обслуживается только историей библиотеки, а её сценарий
    // дословно совпадает со сценарием первой фичи.
    exported.channels[0] = {
      channelId: 'admin',
      scope: 'included',
      stories: [{ repositoryId: 'chat', storyId: 'block' }],
    };
    exported.checks = [{ gate: 'moderation', scenario: releaseScenario }];
    await f.save(scoped);
    // Сценарий связывает только задача приложения.
    f.plan(sceneProof, ['app']);
    await f.run();
    await f.accept();
    const view = f.view();
    const status = (featureId: string) =>
      view.features
        .find((x) => x.id === featureId)!
        .checks.map((c) => [c.scenario, c.status, c.evidence.map((e) => e.repositoryId)]);
    assert.deepEqual(status('block'), [
      [releaseScenario, 'evidenced', ['app']],
      [second, 'missing', []],
    ]);
    assert.deepEqual(status('export'), [[releaseScenario, 'missing', []]]);
    assert.equal(view.coverageComplete, false);
    assert.ok(view.issues.some((i) => i.includes('сценарий релиза export (gate moderation)')));
    assert.ok(view.issues.some((i) => i.includes(second)));
    // Повтор той же пары gate и сценария — ошибка карты.
    const repeated = map();
    repeated.releases[0].features![0].checks.push({
      gate: 'moderation',
      scenario: ' ' + releaseScenario,
    });
    assert.throws(() => f.intent.render({ definition: repeated }), /Повтор feature scenario/);
    // Доказательство сопоставляется по тексту, а не по gate: тот же текст на
    // другом gate фичи был бы доказан тем же testcase, и карта его отклоняет.
    const otherGate = map();
    otherGate.releases[0].features![0].checks.push({
      gate: 'release-acceptance',
      scenario: releaseScenario,
    });
    assert.throws(() => f.intent.render({ definition: otherGate }), /Повтор feature scenario/);
  } finally {
    await f.close();
  }
});

test('Scenario evidence is scoped by story, not by repository: another story of the same component does not prove the feature', async () => {
  // Вторая история в тех же репозиториях: фича export обслуживается ею, а
  // доказательство сценария несёт задача истории block того же репозитория.
  const local = structuredClone(localDefinition);
  local.stories.push({
    id: 'audit',
    title: 'Журнал блокировок',
    releaseId: 'mvp',
    criteria: [
      {
        id: 'audited',
        text: 'Блокировка видна в журнале модератора.',
        requirements: [{ source: 'spec.md', id: 'REQ-moderation' }],
      },
    ],
  });
  const scoped = map();
  const exported = scoped.releases[0].features![1];
  exported.channels[0] = {
    channelId: 'admin',
    scope: 'included',
    stories: [
      { repositoryId: 'app', storyId: 'audit' },
      { repositoryId: 'chat', storyId: 'audit' },
    ],
  };
  exported.checks = [{ gate: 'moderation', scenario: releaseScenario }];
  scoped.releases.pop();
  const f = await fixture(local, scoped);
  try {
    f.plan();
    await f.run();
    const view = f.view();
    const status = (featureId: string) =>
      view.features
        .find((x) => x.id === featureId)!
        .checks.map((c) => [c.status, [...new Set(c.evidence.map((e) => e.repositoryId))]]);
    assert.deepEqual(status('block'), [['evidenced', ['app', 'chat']]]);
    // Те же репозитории, тот же текст сценария, но другая история.
    assert.deepEqual(status('export'), [['missing', []]]);
  } finally {
    await f.close();
  }
});
