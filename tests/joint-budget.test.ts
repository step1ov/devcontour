import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture, input, complete } from './helpers.ts';
import { DevContour, digest } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { Workspace } from '../src/core/workspace.ts';
import { executionOf } from '../src/harness/execution.ts';
import { devcontourHost } from '../src/harness/host.ts';
import {
  acceptedJointBudgetCheckpoints,
  settledJointVerifications,
} from '../src/core/joint-budget.ts';

function ready() {
  const f = fixture();
  f.h.config.maxAttempts = 3;
  f.h.config.workspaceGates = [{ ...f.h.config.gates[0], repositoryId: 'main', artifacts: [] }];
  f.h = new DevContour(f.store, f.h.config);
  const b = f.h.createBoard('Completed work');
  const t = f.h.addTask(b.id, input());
  f.h.approve(b.id);
  complete(f.h, t.id);
  const w = new Workspace(f.h);
  const create = (supersedes?: string) =>
    w.create({
      title: 'Joint result',
      description: 'Verify the same accepted work',
      boardIds: [b.id],
      ...(supersedes ? { supersedes } : {}),
    });
  const pass = (id: string) => {
    const v = w.start(id);
    w.manifest(id, v.token, { main: { sha: 'b'.repeat(40), tree: 'd'.repeat(40) } });
    w.evidence(id, v.token, {
      gate: 'test',
      passed: true,
      command: ['fixture'],
      exitCode: 0,
      log: 'fixture',
      digest: 'e'.repeat(64),
      summary: 'Deterministic protocol fixture',
      artifacts: [],
    });
    w.finish(id, v.token);
    return v.id;
  };
  const fail = (id: string) => {
    const v = w.start(id);
    w.fail(id, v.token, 'Fixture failure');
    return v.id;
  };
  return { ...f, b, t, w, create, pass, fail };
}

test('Accepted third verification opens a shared bounded budget; legacy/restart/order do not restore spent retries', () => {
  const f = ready();
  let reopened: Store | undefined;
  const restartConfig = structuredClone(f.h.config);
  try {
    const old = f.create();
    f.fail(old.id);
    f.fail(old.id);
    const anchor = f.pass(old.id);
    f.store.change('fixture.equal-times', (s) => {
      for (const v of s.changeSets[0].verifications) v.startedAt = '2026-01-01T00:00:00.000Z';
    });
    const verification = f.store.read().changeSets[0].verifications.at(-1)!;
    assert.equal(f.w.accept(old.id).status, 'accepted');
    assert.equal(f.store.read().changeSets[0].acceptance!.digest, digest(verification));
    assert.throws(() => f.w.start(old.id), /уже принят/);
    // Old installations have no checkpoint. Reading them must not migrate history.
    f.store.change('fixture.legacy', (s) => {
      delete s.changeSets[0].acceptance!.jointBudgetCheckpoint;
    });
    const historical = structuredClone(f.store.read().changeSets[0]);
    assert.equal(
      acceptedJointBudgetCheckpoints(f.store.read(), [f.t.id])[0].verificationId,
      anchor,
    );
    for (let i = 0; i < 3; i++) {
      const sibling = f.create(i === 1 ? undefined : old.id);
      f.h.config.roles.qa.model = `model-${i}`;
      f.h.config.workspaceGates[0].command = ['fixture', String(i)];
      f.store.change('fixture.spec', (s) => {
        s.boards[0].title = `Board revision ${i % 2}`;
      });
      f.fail(sibling.id);
    }
    assert.deepEqual(f.store.read().changeSets[0], historical);
    const blocked = f.create(old.id);
    assert.throws(() => f.w.start(blocked.id), /лимит|предел|budget|attempt/i);
    f.store.change('fixture.reorder', (s) => {
      s.changeSets.reverse();
    });
    assert.throws(() => f.w.start(blocked.id), /лимит|предел|budget|attempt/i);
    reopened = new Store(join(f.root, 'state.sqlite'));
    const h = new DevContour(reopened, restartConfig);
    assert.throws(() => new Workspace(h).start(blocked.id), /лимит|предел|budget|attempt/i);
    assert.deepEqual(
      reopened.read().changeSets.find((c) => c.id === old.id),
      historical,
    );
  } finally {
    reopened?.close();
    f.cleanup();
  }
});

test('Acceptance freezes terminal same-work IDs, excludes active proofs and waits for operator', () => {
  const f = ready();
  try {
    const debt = f.create();
    const debtId = f.fail(debt.id);
    const accepted = f.create();
    const anchor = f.pass(accepted.id);
    const active = f.create();
    const activeId = f.w.start(active.id).id;
    f.h.config.approvalMode = 'operator';
    assert.equal(f.w.accept(accepted.id).status, 'awaiting-operator');
    assert.equal(
      f.store.read().changeSets.find((c) => c.id === accepted.id)!.acceptance,
      undefined,
    );
    assert.equal(f.w.accept(accepted.id, { actor: 'operator' }).status, 'accepted');
    const checkpoint = f.store.read().changeSets.find((c) => c.id === accepted.id)!.acceptance!
      .jointBudgetCheckpoint!;
    assert.deepEqual(checkpoint, {
      verificationId: anchor,
      settledVerificationIds: [debtId, anchor].sort(),
    });
    const v = f.store.read().changeSets.find((c) => c.id === active.id)!.verifications[0];
    f.w.fail(active.id, v.token, 'After acceptance');
    assert.ok(!checkpoint.settledVerificationIds.includes(activeId));
    for (let i = 0; i < 2; i++) f.fail(f.create(accepted.id).id);
    assert.throws(() => f.w.start(f.create(accepted.id).id), /лимит|предел|budget|attempt/i);
  } finally {
    f.cleanup();
  }
});

test('Host checkpoint hook reads the current transaction and passed but unaccepted proof creates no checkpoint', () => {
  const f = ready();
  try {
    const c = f.create();
    const anchor = f.pass(c.id);
    const { store } = executionOf(f.h);
    const host = devcontourHost(f.h, store);
    assert.deepEqual(
      store.read((view) => host.basis.jointBudgetCheckpoints!([f.t.id], view)),
      [],
    );
    store.host('fixture.accept-and-read', ({ tx }) => {
      f.w.accept(c.id);
      const checkpoints = host.basis.jointBudgetCheckpoints!([f.t.id], tx);
      assert.equal(checkpoints.length, 1);
      assert.equal(checkpoints[0].verificationId, anchor);
    });
    assert.equal(
      store.read((view) => host.basis.jointBudgetCheckpoints!([f.t.id], view)).length,
      1,
    );
    // Transaction rollback must remove the accepted checkpoint as well.
    const next = f.create(c.id);
    f.pass(next.id);
    assert.throws(
      () =>
        store.host('fixture.rollback', () => {
          f.w.accept(next.id);
          throw new Error('rollback');
        }),
      /rollback/,
    );
    assert.equal(f.store.read().changeSets.find((x) => x.id === next.id)!.acceptance, undefined);
  } finally {
    f.cleanup();
  }
});

test('Legacy accepted prefix leaves sibling debt and unaccepted PASS charged', () => {
  const f = ready();
  try {
    const debt = f.create();
    f.fail(debt.id);
    const old = f.create();
    f.pass(old.id);
    f.w.accept(old.id);
    f.store.change('fixture.legacy', (s) => {
      delete s.changeSets.find((c) => c.id === old.id)!.acceptance!.jointBudgetCheckpoint;
    });
    f.pass(f.create(old.id).id); // Unaccepted PASS still consumes an attempt.
    f.fail(f.create(old.id).id);
    assert.throws(() => f.w.start(f.create(old.id).id), /лимит|предел|budget|attempt/i);
  } finally {
    f.cleanup();
  }
});

test('Local accepted checkpoint must point to its actual accepted anchor', () => {
  const f = ready();
  try {
    const c = f.create();
    f.pass(c.id);
    f.w.accept(c.id);
    f.store.change('fixture.invalid-checkpoint', (s) => {
      s.changeSets[0].acceptance!.jointBudgetCheckpoint = {
        verificationId: 'unaccepted-anchor',
        settledVerificationIds: ['unaccepted-anchor'],
      };
    });
    assert.throws(() => f.w.start(f.create(c.id).id), /checkpoint/);
  } finally {
    f.cleanup();
  }
});

test('Present malformed checkpoint never falls back to legacy, and duplicate work IDs cannot settle another work set', () => {
  const f = ready();
  try {
    const c = f.create();
    const anchor = f.pass(c.id);
    f.w.accept(c.id);
    for (const invalid of [null, false, {}, { verificationId: anchor }]) {
      f.store.change('fixture.malformed-checkpoint', (s) => {
        Object.assign(s.changeSets[0].acceptance!, { jointBudgetCheckpoint: invalid });
      });
      assert.throws(
        () => f.w.start(f.create(c.id).id),
        /checkpoint|settled|вериф|verification|массив|array|missing|идентифик|бюджет/i,
      );
    }
    const state = structuredClone(f.store.read());
    const verification = structuredClone(state.changeSets[0].verifications[0]);
    verification.tasks.push(structuredClone(verification.tasks[0]));
    state.changeSets[0].verifications = [verification];
    delete state.changeSets[0].acceptance!.jointBudgetCheckpoint;
    assert.deepEqual(settledJointVerifications(state, [f.t.id, 'other-work']), []);
    assert.deepEqual(acceptedJointBudgetCheckpoints(state, [f.t.id, 'other-work']), []);
  } finally {
    f.cleanup();
  }
});
