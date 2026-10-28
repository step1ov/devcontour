/**
 * Утверждение плана закрепляет политику исполнения. Ослабленная после
 * утверждения политика (команда gate, правило вендора ревью) не применяется
 * к плану без повторного утверждения: движок задачу не выдаёт, прогресс
 * называет `approval_stale`, а review-plan утверждает план заново вместо
 * «already-approved». Реальный Git: учебный workspace демо.
 */
import { test } from 'node:test';
import { testDemo } from './demo-pool.ts';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import type { Config } from '../src/core/model.ts';
import { loadConfig } from '../src/runner/config.ts';
import { reviewPlan } from '../src/runner/agent-control.ts';
import type { AgentAdapter } from '../src/runner/adapters.ts';
import { executionOf } from '../src/harness/execution.ts';
import { taskProgress } from '../src/application/context.ts';
import { graphOf } from '../src/harness/projection.ts';
import { projectionOptions } from '../src/harness/host.ts';

/** Ревьюер-заглушка: одобряет и считает вызовы. Модель не вызывается. */
function reviewers() {
  let calls = 0;
  const make = (name: 'codex' | 'claude'): AgentAdapter => ({
    name,
    execute() {
      calls++;
      return Promise.resolve({
        data: { approved: true, summary: 'Fixture reviewer', findings: [] },
        log: 'Fixture only',
        command: ['fixture'],
      });
    },
  });
  return { calls: () => calls, adapters: { codex: make('codex'), claude: make('claude') } };
}

test('Политика после утверждения плана: смена gate и правила вендора ревью держат выдачу до review-plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-approval-policy-'));
  const stores: Store[] = [];
  try {
    await testDemo(root);
    const base = loadConfig(join(root, 'config.json'));
    // Новый процесс с изменённым config.json — как перезапуск после правки.
    const open = (config: Config) => {
      writeFileSync(join(root, 'config.json'), JSON.stringify(config));
      const store = new Store(join(root, 'state.sqlite'));
      stores.push(store);
      return new DevContour(store, loadConfig(join(root, 'config.json')));
    };
    const first = open(base);
    const s0 = first.store.read();
    const board = s0.boards.find((b) => b.title === 'Каталог продуктов')!;
    const root0 = s0.tasks.find(
      (t) => board.revisions.at(-1)!.taskIds.includes(t.id) && !t.dependsOn.length,
    )!;
    assert.equal(root0.status, 'ready');
    assert.equal(root0.approvedPolicy, first.planPolicyDigest(), 'утверждение закрепило политику');

    const progressOf = (h: DevContour) => {
      const s = h.store.read();
      return taskProgress(
        h,
        s,
        s.tasks.find((t) => t.id === root0.id)!,
        Date.now(),
      );
    };
    const blockers = (h: DevContour) => {
      const { engine } = executionOf(h);
      return engine.read((v) => engine.blockers(v.work(root0.id)!, v)).map((b) => b.code);
    };
    const replan = async (h: DevContour) => {
      // AI-согласование — только в local mode; исполнение остаётся demo.
      const r = reviewers();
      h.config.mode = 'local';
      try {
        return {
          result: await reviewPlan(h, root, board.id, 'codex', r.adapters),
          calls: r.calls(),
        };
      } finally {
        h.config.mode = 'demo';
      }
    };
    const claim = (h: DevContour, owner: string) => {
      const { engine } = executionOf(h);
      // Как такт controller: роль, применение своей конфигурации, выдача.
      assert.ok(engine.lead(owner));
      h.recordConfig(owner);
      h.pause(false);
      const attempt = engine.claim(owner);
      h.pause(true);
      if (!attempt) engine.release(owner);
      return attempt;
    };

    // 1. Ослабленная команда gate.
    const weaker = structuredClone(base);
    weaker.gates[0].command = ['node', '-e', 'process.exit(0)'];
    const h1 = open(weaker);
    assert.notEqual(h1.planPolicyDigest(), root0.approvedPolicy);
    assert.ok(blockers(h1).includes('APPROVAL_STALE'), blockers(h1).join(','));
    const stale = progressOf(h1);
    assert.ok(stale.reasons.includes('approval_stale'), stale.reasons.join(','));
    assert.equal(stale.eligible, false);
    assert.match(stale.approvalStale!.hint, new RegExp(`review-plan --board ${board.id}`));
    assert.equal(claim(h1, 'controller-weaker'), undefined, 'выдачи нет до повторного утверждения');
    const g = graphOf(h1.store.read(), board, projectionOptions(h1));
    assert.equal(g?.policyDigest, root0.approvedPolicy, 'граф несёт закреплённую политику');

    const again = await replan(h1);
    assert.equal(again.result.status, 'approved', JSON.stringify(again.result));
    assert.equal(again.calls, 1, 'план прошёл ревью заново');
    assert.ok(
      'repinned' in again.result && again.result.repinned?.includes(root0.id),
      JSON.stringify(again.result),
    );
    assert.ok(!blockers(h1).includes('APPROVAL_STALE'));
    assert.ok(!progressOf(h1).reasons.includes('approval_stale'));
    // Повтор при той же политике — уже утверждено, без вызова модели.
    const same = await replan(h1);
    assert.equal(same.result.status, 'already-approved');
    assert.equal(same.calls, 0);

    // 2. Правило вендора ревью плана: тот же вендор разрешён (ослабление).
    const vendor = structuredClone(weaker);
    vendor.review = { ...vendor.review, plan: { vendor: 'same-vendor-allowed' } };

    const h2 = open(vendor);
    assert.notEqual(h2.planPolicyDigest(), h1.planPolicyDigest());
    assert.ok(blockers(h2).includes('APPROVAL_STALE'), blockers(h2).join(','));
    assert.ok(progressOf(h2).reasons.includes('approval_stale'));
    assert.equal(claim(h2, 'controller-vendor'), undefined);
    assert.equal((await replan(h2)).result.status, 'approved');
    const attempt = claim(h2, 'controller-vendor');
    assert.equal(attempt?.workId, root0.id, 'после повторного утверждения задача выдана');
  } finally {
    for (const s of stores) s.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Утверждения прежней версии закрепляются за текущей политикой один раз, без повторного утверждения', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-approval-legacy-'));
  const store = new Store(join(root, 'state.sqlite'));
  try {
    const { config, input } = await import('./helpers.ts');
    const withGate = (command: string) => {
      const c = config();
      c.gates[0].command = command.split(' ');
      return c;
    };
    const h = new DevContour(store, config());
    const b = h.createBoard('Release board');
    const t = h.addTask(b.id, input());
    h.approve(b.id);
    // Утверждение прежней версии: закрепления нет.
    store.change('fixture.legacy', (s) => {
      delete s.tasks.find((x) => x.id === t.id)!.approvedPolicy;
    });
    const changed = new DevContour(store, withGate('node other.mjs'));
    assert.notEqual(changed.planPolicyDigest(), h.planPolicyDigest());
    const progress = () => {
      const s = store.read();
      return taskProgress(
        changed,
        s,
        s.tasks.find((x) => x.id === t.id)!,
        Date.now(),
      );
    };
    assert.ok(!progress().reasons.includes('approval_stale'), 'прежнее утверждение действует');
    assert.deepEqual(changed.pinLegacyApprovals(), { tasks: [t.id] });
    assert.equal(
      store.read().tasks.find((x) => x.id === t.id)!.approvedPolicy,
      changed.planPolicyDigest(),
    );
    assert.deepEqual(changed.pinLegacyApprovals(), [], 'второй раз ничего не пишет');
    // Эксплуатационные пределы план не меняют: повторного утверждения нет.
    const operational = config({ maxAttempts: 9, concurrency: 1, runTimeoutMs: 1000 });
    operational.gates[0].command = ['node', 'other.mjs'];
    const tuned = new DevContour(store, operational);
    const st = store.read();
    assert.ok(
      !taskProgress(
        tuned,
        st,
        st.tasks.find((x) => x.id === t.id)!,
        Date.now(),
      ).reasons.includes('approval_stale'),
    );
    // Закреплённое утверждение дальше сверяется с политикой.
    const later = new DevContour(store, withGate('node third.mjs'));
    const s = store.read();
    assert.ok(
      taskProgress(
        later,
        s,
        s.tasks.find((x) => x.id === t.id)!,
        Date.now(),
      ).reasons.includes('approval_stale'),
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
