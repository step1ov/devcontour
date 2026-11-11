import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { input } from './helpers.ts';
import { changeSnapshot } from '../src/core/workspace.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import { fixture, localDefinition, map, source } from './product-fixture.ts';

test('Changing the product map after joint verification blocks acceptance and requires a new pinned verification', async () => {
  const f = await fixture();
  const lead = new LeadRunner(f.h, f.root);
  try {
    f.plan();
    await f.run();
    await f.accept();
    const change = f.runner.workspace.create({
      title: 'Первый релиз',
      description: 'Проверяем неизменность общей постановки.',
      boardIds: f.boards,
      releaseId: 'mvp',
    });
    await f.runner.verify(change.id);
    const oldProof = structuredClone(f.store.read().changeSets[0].verifications[0].productRelease);
    const changed = map();
    if (changed.kind !== 'workspace') throw new Error('Expected workspace');
    changed.product!.features[0].outcome += ' Сохранить понятное объяснение пользователю.';
    await f.save(changed);
    assert.equal(f.view().features[0].status, 'awaiting-verification');
    assert.throws(() => f.runner.workspace.accept(change.id), /карта изменилась/);
    const workflow = new LeadWorkflow(f.h);
    const job = workflow.start({ kind: 'changeset', id: change.id, authorRuntime: 'codex' });
    // Стадий три, но стадия вправе ответить «жду» — например, пока не истёк
    // lease прежней проверки, — и под нагрузкой полного прогона одного tick на
    // стадию не хватает. Ждём итога с дедлайном; failed и stale — итог, не
    // повод ждать дальше, и при отказе печатается история задания.
    const deadline = Date.now() + 60_000;
    let current = workflow.get(job.key);
    while (['queued', 'running'].includes(current.status) && Date.now() < deadline) {
      await lead.tick();
      current = workflow.get(job.key);
      if (['queued', 'running'].includes(current.status))
        await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(current.status, 'completed', JSON.stringify(current));
    assert.equal(f.view().releaseAccepted, true);
    assert.deepEqual(f.store.read().changeSets[0].verifications[0].productRelease, oldProof);
    await writeFile(join(f.repos[1].path, 'spec.md'), source + 'Новое обязательное условие.\n');
    await f.commit(f.repos[1].path, 'Change local requirement');
    assert.equal(f.view().releaseAccepted, false);
    assert.equal(f.view().coverageComplete, false);
  } finally {
    await lead.stop();
    await f.close();
  }
});

test('A release proof pins only its own tasks: other work in the component keeps it current, relevant changes invalidate it', async () => {
  // В компоненте есть история следующего релиза на тот же REQ: её задачи
  // явно назначены своей истории и не входят в покрытие этого релиза.
  const local = structuredClone(localDefinition);
  local.releases.push({ id: 'later', title: 'Аудит' });
  local.stories.push({
    ...structuredClone(local.stories[0]),
    id: 'audit',
    title: 'Аудит блокировки',
    releaseId: 'later',
    criteria: [{ ...structuredClone(local.stories[0].criteria[0]), id: 'audited' }],
  });
  const f = await fixture(local);
  try {
    f.plan();
    await f.run();
    await f.accept();
    const change = f.runner.workspace.create({
      title: 'Релиз модерации',
      description: 'Приёмка идёт, пока в компоненте работает следующий релиз.',
      boardIds: f.boards,
      releaseId: 'mvp',
    });
    await f.runner.verify(change.id);
    const check = () => {
      const s = f.store.read(),
        c = s.changeSets.find((x) => x.id === change.id)!,
        v = c.verifications.at(-1)!;
      f.intent.validate(v.productRelease!, changeSnapshot(s, c), v.manifest);
    };
    const stale = /Покрытие или проверки релиза изменились; нужна новая проверка/;
    check();
    // (a) Задача другой доски того же компонента проходит ready → running →
    // failed с попытками, выдачей и отказом: приёмка релиза от неё не зависит.
    const next = f.h.createBoard('Следующий релиз', '', 'app');
    const other = f.h.addTask(next.id, {
      ...input('Работа следующего релиза'),
      repositoryId: 'app',
    });
    check();
    for (const [status, extra] of [
      ['ready', {}],
      [
        'running',
        { attempt: 1, activeRunId: 'R-other', budgetBlock: { reason: 'лимит', at: '2026-01-01' } },
      ],
      ['failed', { attempt: 2, activeRunId: undefined, failure: 'Тест упал', neutralFailures: 1 }],
    ] as const) {
      f.store.change('fixture.other-work', (s) => {
        Object.assign(
          s.tasks.find((t) => t.id === other.id)!,
          { status, ...extra },
        );
      });
      check();
    }
    assert.ok(f.view().verification, 'чужая работа не снимает проверку релиза');
    const relevant = f.store
      .read()
      .tasks.find((t) => t.repositoryId === 'app' && t.id !== other.id)!;
    const mutate = (name: string, apply: (s: ReturnType<typeof f.store.read>) => void) => {
      const before = structuredClone(f.store.read());
      f.store.change('fixture.' + name, apply);
      assert.throws(check, stale, name);
      f.store.change('fixture.restore-' + name, (s) => {
        s.tasks = before.tasks;
        s.runs = before.runs;
        s.boards = before.boards;
      });
      check();
    };
    const task = (s: ReturnType<typeof f.store.read>) => s.tasks.find((t) => t.id === relevant.id)!;
    // (b) Поля задачи релиза, которые читают покрытие и приёмка.
    mutate('result-sha', (s) => (task(s).resultSha = 'f'.repeat(40)));
    mutate('status', (s) => (task(s).status = 'running'));
    mutate('requirements', (s) => (task(s).requirements![1].testId = 'other case'));
    mutate('story-bindings', (s) => {
      task(s).storyBindings = [
        { source: 'INTENT.md', id: 'REQ-intent-block', digest: 'x', boundAt: '2026-01-01' },
      ];
    });
    // (c) Новая успешная попытка задачи релиза с другим evidence.
    mutate('new-run', (s) => {
      const last = s.runs.findLast((r) => r.taskId === relevant.id && r.status === 'succeeded')!;
      s.runs.push({ ...structuredClone(last), id: last.id + '-again', evidence: [] });
    });
    // (d) Новая задача в выбранной доске — даже без новой ревизии и без связи
    // с историями релиза: её закрепляет состав доски, а не покрытие.
    mutate('board-task', (s) => {
      const added = {
        ...structuredClone(task(s)),
        id: relevant.id + '-added',
        requirements: undefined,
      };
      s.tasks.push(added);
      s.boards
        .find((b) => b.id === f.boards[0])!
        .revisions.at(-1)!
        .taskIds.push(added.id);
    });
    const detailed = relevant.requirements!.filter((r) => r.source !== 'INTENT.md');
    assert.equal(detailed.length, 1);
    // (iv) Контроль: задача невыбранной доски на тот же подробный REQ, но
    // явно назначенная истории другого релиза, покрытие этого не меняет.
    const audit = f.intent.snapshot({ repositoryId: 'app', storyId: 'audit' });
    if (!audit.stories) throw new Error('Expected stories');
    const assigned = f.h.addTask(next.id, {
      ...input('Аудит блокировки'),
      repositoryId: 'app',
      requirements: [
        { ...audit.stories[0].requirement, gate: 'local', scenario: 'Аудит.' },
        ...structuredClone(detailed),
      ],
    });
    check();
    f.store.change('fixture.assigned-running', (s) => {
      s.tasks.find((t) => t.id === assigned.id)!.status = 'running';
    });
    check();
    // (iii) Задача другой доски заменяет задачу релиза: та становится
    // исключённой — покрытие релиза изменилось.
    mutate('superseded', (s) => {
      const replacement = {
        ...structuredClone(s.tasks.find((t) => t.id === other.id)!),
        id: other.id + '-replacement',
        supersedes: relevant.id,
      };
      s.tasks.push(replacement);
      s.boards
        .find((b) => b.id === next.id)!
        .revisions.at(-1)!
        .taskIds.push(replacement.id);
    });
    // Вид и отчёт совместного gate доказательство не закрепляет: их смена
    // меняет договор проверки ChangeSet (`workspacePolicyDigest`), и прежняя
    // проверка перестаёт быть актуальной до проверки доказательства.
    const gate = structuredClone(f.c.workspaceGates[0]);
    f.c.workspaceGates[0] = { ...gate, kind: 'check' };
    try {
      assert.equal(f.view().verification, undefined);
      assert.throws(() => f.runner.workspace.accept(change.id), /актуальной/);
    } finally {
      f.c.workspaceGates[0] = gate;
    }
    assert.ok(f.view().verification);
    // (i) Живой неназначенный вклад: задача невыбранной доски несёт подробный
    // REQ истории релиза без своей связи REQ-intent — она входит в историю
    // (`belongs`), и прежняя проверка релиза больше не действует.
    const stray = f.h.createBoard('Сторонняя правка', '', 'app');
    const contributor = f.h.addTask(stray.id, {
      ...input('Сторонняя правка блокировки'),
      repositoryId: 'app',
      requirements: structuredClone(detailed),
    });
    assert.throws(check, stale, 'unassigned contributor');
    // (ii) Отменённая, она остаётся в отчёте истории исключённой — набор
    // задач релиза всё равно отличается от закреплённого: нужна новая проверка.
    f.h.cancel(contributor.id, 'Правка не нужна');
    const report = f.intent.report({ repositoryId: 'app', releaseId: 'mvp' }) as {
      stories: { excludedTasks: { id: string }[] }[];
    };
    assert.ok(report.stories[0].excludedTasks.some((t) => t.id === contributor.id));
    assert.throws(check, stale, 'cancelled contributor');
  } finally {
    await f.close();
  }
});
