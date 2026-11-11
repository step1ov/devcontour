import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { changeSnapshot } from '../src/core/workspace.ts';
import { scenarioGaps } from '../src/runner/intent.ts';
import { command } from '../src/runner/process.ts';
import { AgentService } from '../src/application/agent.ts';
import { gateTestcases } from '../src/application/testcases.ts';
import { fixture, localDefinition, map, releaseScenario } from './product-fixture.ts';

test('A release scenario reworded or removed after acceptance needs the user to accept the release; the lead cannot', async () => {
  const second = 'Модератор видит причину блокировки в журнале.';
  const reworded = 'Модератор видит дату блокировки в журнале.';
  const reason = 'Журнал модератора — в следующем релизе.';
  const scoped = map();
  scoped.releases[0].features![0].checks.push({
    gate: 'moderation',
    scenario: second,
    deferred: reason,
  });
  const f = await fixture(localDefinition, scoped);
  try {
    f.plan();
    await f.run();
    await f.accept();
    const create = (title: string) =>
      f.runner.workspace.create({
        title,
        description: 'Приёмка объёма релиза.',
        boardIds: f.boards,
        releaseId: 'mvp',
      });
    const first = create('Первая приёмка');
    await f.runner.verify(first.id);
    assert.equal(f.runner.workspace.accept(first.id).status, 'accepted');
    // Образец объёма — сценарии, закреплённые в доказательстве принятой проверки.
    const proof = f.store
      .read()
      .changeSets.find((c) => c.id === first.id)!
      .verifications.at(-1)!.productRelease!;
    assert.deepEqual(
      proof.scenarios?.map((s) => s.scenario),
      [releaseScenario, second],
    );
    assert.deepEqual(f.view().unconfirmedScenarios, []);
    assert.equal(f.view().scopeReference?.changeSetId, first.id);
    // Обычный коммит INTENT переформулирует сценарий: объём релиза сузился
    // без решения пользователя.
    const changed = map();
    changed.releases[0].features![0].checks.push({
      gate: 'moderation',
      scenario: reworded,
      deferred: reason,
    });
    await f.save(changed);
    const expected = [
      {
        featureId: 'block',
        gate: 'moderation',
        scenario: second,
        change: 'changed',
        current: [reworded],
      },
    ];
    const view = f.view();
    assert.deepEqual(view.unconfirmedScenarios, expected);
    assert.equal(view.coverageComplete, true, JSON.stringify(view.issues));
    assert.ok(
      view.issues.some((i) => i.includes('без решения пользователя') && i.includes(first.id)),
      JSON.stringify(view.issues),
    );
    assert.ok(
      view.issues.some((i) => i.includes('изменён') && i.includes(second) && i.includes(reworded)),
    );
    const report = f.intent.report({ releaseId: 'mvp' }) as {
      unconfirmedScenarios: unknown;
      issues: string[];
    };
    assert.deepEqual(report.unconfirmedScenarios, expected);
    assert.ok(report.issues.some((i) => i.includes('без решения пользователя')));
    // Проверка идёт, но приёмку ведущего (agent) — и в режиме agent — заменяет
    // приёмка пользователя.
    const narrowed = create('Объём сужен');
    await f.runner.verify(narrowed.id);
    const lead = f.runner.workspace.accept(narrowed.id, { actor: 'agent' }) as {
      status: string;
      unconfirmedScenarios?: unknown;
    };
    assert.equal(lead.status, 'awaiting-operator');
    assert.deepEqual(lead.unconfirmedScenarios, expected);
    assert.equal(
      f.store.read().changeSets.find((c) => c.id === narrowed.id)!.acceptance,
      undefined,
    );
    assert.equal(f.view().releaseAccepted, false);
    // Карточка пользователя называет, что приёмка подтверждает сужение
    // объёма, — по доказательствам проверок в состоянии, без Git.
    const cards = new AgentService(f.h).execute({
      operation: 'attention_list',
      input: { actor: 'operator' },
    }) as { items: { sourceKey: string; reason: string }[] };
    const card = cards.items.find((i) => i.sourceKey === 'changeset:' + narrowed.id)!;
    assert.ok(
      card.reason.includes('подтверждаете сужение объёма релиза после приёмки ' + first.id) &&
        card.reason.includes(second) &&
        card.reason.includes(reworded),
      card.reason,
    );
    // Приёмка пользователя — решение: она становится новым образцом объёма.
    const confirmed = f.runner.workspace.accept(narrowed.id, { actor: 'operator' }) as {
      status: string;
      confirmedScenarioChanges?: unknown;
    };
    assert.equal(confirmed.status, 'accepted');
    assert.deepEqual(confirmed.confirmedScenarioChanges, expected);
    assert.deepEqual(f.view().unconfirmedScenarios, []);
    assert.equal(f.view().releaseAccepted, true);
    assert.equal(f.view().scopeReference?.changeSetId, narrowed.id);
    // Отсрочка сценария, проверенного в принятой карте, — тоже сужение.
    const postponed = map();
    postponed.releases[0].features![0].checks[0].deferred = 'Проверка на устройстве — позже.';
    postponed.releases[0].features![0].checks.push({
      gate: 'moderation',
      scenario: reworded,
      deferred: reason,
    });
    await f.save(postponed);
    assert.deepEqual(f.view().unconfirmedScenarios, [
      {
        featureId: 'block',
        gate: 'moderation',
        scenario: releaseScenario,
        change: 'deferred',
        reason: 'Проверка на устройстве — позже.',
      },
    ]);
    // Удалённый сценарий — то же сужение.
    await f.save(map());
    assert.deepEqual(f.view().unconfirmedScenarios, [
      { featureId: 'block', gate: 'moderation', scenario: reworded, change: 'removed' },
    ]);
    // Приёмка прежней версии сценариев не хранит: карту по digest находит
    // история Git workspace.
    f.store.change('fixture.legacy-proof', (s) => {
      delete s.changeSets.find((c) => c.id === narrowed.id)!.verifications.at(-1)!.productRelease!
        .scenarios;
    });
    assert.deepEqual(
      f.view().unconfirmedScenarios.map((u) => [u.scenario, u.change]),
      [[reworded, 'removed']],
    );
    // Найденная в Git карта — сверяемый образец: приёмку держит изменение
    // сценария, а не прежняя форма доказательства.
    const legacyCheck = create('Образец из истории Git');
    await f.runner.verify(legacyCheck.id);
    const pendingProof = () => {
      const s = f.store.read(),
        c = s.changeSets.find((x) => x.id === legacyCheck.id)!,
        v = c.verifications.at(-1)!;
      return f.intent.validate(v.productRelease!, changeSnapshot(s, c), v.manifest);
    };
    const legacyFound = pendingProof();
    assert.equal(legacyFound.scopeUnverifiable, false);
    assert.deepEqual(
      legacyFound.unconfirmedScenarios?.map((u) => [u.scenario, u.change]),
      [[reworded, 'removed']],
    );
    const operatorCard = (id: string) =>
      (
        new AgentService(f.h).execute({
          operation: 'attention_list',
          input: { actor: 'operator' },
        }) as { items: { sourceKey: string; reason: string }[] }
      ).items.find((i) => i.sourceKey === 'changeset:' + id)!.reason;
    // Сценарии прежней приёмки в состоянии не сохранены: карточка без Git
    // сравнить их не может и просит сверить объём в карте продукта.
    assert.match(operatorCard(legacyCheck.id), /^Сверьте объём релиза в карте продукта/);
    // Карты той приёмки в истории нет: сверка невозможна, и карта говорит это прямо.
    f.store.change('fixture.lost-map', (s) => {
      s.changeSets
        .find((c) => c.id === narrowed.id)!
        .verifications.at(-1)!.productRelease!.intentDigest = 'f'.repeat(64);
    });
    const lost = f.view();
    assert.equal(lost.scopeReference?.found, false);
    assert.ok(lost.issues.some((i) => i.includes('не найдена в истории Git')));
    // Сверка невозможна — приёмка закрыта так же: решает пользователь, и его
    // приёмка закрепляет новый образец.
    const unverifiable = create('Объём не сверить');
    await f.runner.verify(unverifiable.id);
    const refused = f.runner.workspace.accept(unverifiable.id, { actor: 'agent' }) as {
      status: string;
      scopeUnverifiable?: boolean;
    };
    assert.equal(refused.status, 'awaiting-operator');
    assert.equal(refused.scopeUnverifiable, true);
    assert.equal(
      f.store.read().changeSets.find((c) => c.id === unverifiable.id)!.acceptance,
      undefined,
    );
    assert.equal(
      f.runner.workspace.accept(unverifiable.id, { actor: 'operator' }).status,
      'accepted',
    );
    const healed = f.view();
    assert.equal(healed.scopeReference?.changeSetId, unverifiable.id);
    assert.equal(healed.scopeReference?.found, true);
    assert.deepEqual(healed.unconfirmedScenarios, []);
    // Объём не менялся: ведущий принимает следующий релиз сам — блок не
    // «залипает» после первой приёмки или ненайденного образца.
    const unchanged = create('Объём не менялся');
    await f.runner.verify(unchanged.id);
    const plainCard = operatorCard(unchanged.id);
    assert.ok(!/сужение|Сверьте/.test(plainCard), plainCard);
    assert.equal(f.runner.workspace.accept(unchanged.id, { actor: 'agent' }).status, 'accepted');
    assert.equal(f.view().scopeReference?.changeSetId, unchanged.id);
    // CLI ведущего — тоже agent: обходного пути нет. Последний шаг: процесс
    // CLI закрепляет свою политику исполнения, после чего процесс теста
    // писать уже не может. Отсрочка проверенного в образце сценария.
    const deferredLast = map();
    deferredLast.releases[0].features![0].checks[0].deferred = 'Проверка на устройстве — позже.';
    await f.save(deferredLast);
    const viaCli = create('Приёмка через CLI');
    await f.runner.verify(viaCli.id);
    const cliExpected = [
      {
        featureId: 'block',
        gate: 'moderation',
        scenario: releaseScenario,
        change: 'deferred',
        reason: 'Проверка на устройстве — позже.',
      },
    ];
    assert.deepEqual(f.view().unconfirmedScenarios, cliExpected);
    const cliAccept = (...extra: string[]) =>
      command(
        [
          process.execPath,
          '--import',
          'tsx',
          'src/cli.ts',
          'changeset-accept',
          '--changeset',
          viaCli.id,
          ...extra,
          '--data',
          f.root,
        ],
        process.cwd(),
        { timeoutMs: 20000 },
      );
    // Без обязательного --author-runtime команда отказывает до приёмки.
    const bare = await cliAccept();
    assert.notEqual(bare.code, 0);
    assert.match(bare.stderr, /--author-runtime/);
    const cli = await cliAccept('--author-runtime', 'claude');
    assert.equal(cli.code, 0, cli.stderr);
    const out = JSON.parse(cli.stdout) as { status: string; unconfirmedScenarios: unknown };
    assert.equal(out.status, 'awaiting-operator', cli.stdout);
    assert.deepEqual(out.unconfirmedScenarios, cliExpected);
    assert.equal(f.store.read().changeSets.find((c) => c.id === viaCli.id)!.acceptance, undefined);
  } finally {
    await f.close();
  }
});

test('intent-render output round-trips: computed fields of the devcontour-intent block are accepted and recomputed', async () => {
  const f = await fixture();
  try {
    const block = (markdown: string) =>
      JSON.parse(/```devcontour-intent\n([\s\S]*?)\n```/.exec(markdown)![1]) as Record<
        string,
        unknown
      >;
    const workspace = await readFile(join(f.control, 'INTENT.md'), 'utf8');
    const rendered = block(workspace);
    assert.equal(rendered.version, 1);
    const again = new AgentService(f.h).execute({
      operation: 'intent_render',
      input: { definition: rendered },
    }) as { markdown: string };
    assert.equal(again.markdown, workspace);
    // Вычисляемое поле пересчитывается, а не берётся со входа.
    const stale = structuredClone(rendered) as {
      releases: { components: { intentDigest: string }[] }[];
    };
    stale.releases[0].components[0].intentDigest = '0'.repeat(64);
    assert.equal(f.intent.render({ definition: stale }).markdown, workspace);
    // Карта компонента: digest требований и sourceSha вычисляются от HEAD,
    // поэтому вывод равен генерации исходного определения сейчас.
    const component = block(await readFile(join(f.repos[0].path, 'INTENT.md'), 'utf8'));
    assert.ok(component.sourceSha);
    assert.equal(
      f.intent.render({ repositoryId: 'app', definition: component }).markdown,
      f.intent.render({ repositoryId: 'app', definition: localDefinition }).markdown,
    );
  } finally {
    await f.close();
  }
});

test('Missing release scenarios read as one hint line and one short line per scenario', () => {
  const missing = ['Первый сценарий.', 'Второй сценарий.', 'Третий сценарий.'].map((scenario) => ({
    featureId: 'block',
    gate: 'moderation',
    scenario,
    status: 'missing' as const,
    evidence: [],
  }));
  const lines = scenarioGaps(missing);
  assert.equal(lines.length, 4);
  assert.equal(lines.filter((l) => l.includes('testId')).length, 1);
  assert.match(lines[0], /без доказательства: 3/);
  for (const [i, s] of missing.entries()) {
    assert.ok(lines[i + 1].includes(s.scenario));
    assert.ok(lines[i + 1].length < 120, lines[i + 1]);
  }
  assert.deepEqual(scenarioGaps([{ ...missing[0], status: 'evidenced' }]), []);
});

test('requirements_testcases lists the testcase ids of the last gate record as testId must name them', async () => {
  const f = await fixture();
  try {
    f.plan();
    await f.run();
    const agent = new AgentService(f.h);
    const listed = agent.execute({
      operation: 'requirements_testcases',
      input: { gate: 'local', repositoryId: 'app' },
    }) as { found: boolean; taskId: string; testcases: { id: string; status: string }[] };
    assert.equal(listed.found, true);
    assert.deepEqual(listed.testcases, [{ id: 'policy type', status: 'passed' }]);
    assert.equal(f.store.read().tasks.find((t) => t.id === listed.taskId)!.repositoryId, 'app');
    const absent = agent.execute({
      operation: 'requirements_testcases',
      input: { gate: 'moderation' },
    }) as { found: boolean; testcases: unknown[] };
    assert.equal(absent.found, false);
    assert.deepEqual(absent.testcases, []);
    // Предел ответа: ID бывает до 1000 символов, список ограничен и байтами.
    const long = Array.from({ length: 200 }, (_, i) => ({
      id: String(i).padStart(4, '0') + 'x'.repeat(996),
      status: 'passed' as const,
    }));
    const capped = gateTestcases(
      {
        tasks: [],
        runs: [
          {
            id: 'R-long',
            taskId: 'T-long',
            evidence: [
              {
                kind: 'test',
                gate: 'wide',
                phase: 'integration',
                sha: 'a'.repeat(40),
                passed: true,
                createdAt: '2026-01-01T00:00:00.000Z',
                tests: long,
              },
            ],
          },
        ],
      } as unknown as Parameters<typeof gateTestcases>[0],
      { gate: 'wide' },
    );
    assert.ok(capped.testcases.length > 0 && capped.testcases.length < 200);
    assert.equal((capped as { omitted?: number }).omitted, 200 - capped.testcases.length);
    assert.ok(Buffer.byteLength(JSON.stringify(capped)) < 65536);
  } finally {
    await f.close();
  }
});
