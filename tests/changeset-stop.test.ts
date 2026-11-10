import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatelessJoint, interruptedJoint, jointBudgetRefusal } from '../src/core/joint-budget.ts';
import { changeSetStopReason, stoppedWorkflows } from '../src/application/overview.ts';
import type { ChangeSet, DevContourState, Verification } from '../src/core/model.ts';

const verification = (id: string, over: Partial<Verification> = {}): Verification =>
  ({
    id,
    token: 't',
    leaseUntil: 0,
    startedAt: '2026-01-01T00:00:00.000Z',
    status: 'failed',
    policyDigest: 'p',
    specDigest: 's',
    tasks: [{ id: 'T-1' }, { id: 'T-2' }],
    boards: [],
    evidence: [],
    ...over,
  }) as unknown as Verification;

const changeSet = (id: string, over: Partial<ChangeSet> = {}): ChangeSet => ({
  id,
  title: 'Release',
  description: 'Joint verification of the release.',
  boardIds: ['B-1'],
  createdAt: '2026-01-01T00:00:00.000Z',
  verifications: [],
  ...over,
});

const state = (changeSets: ChangeSet[]) =>
  ({ changeSets, tasks: [], boards: [] }) as unknown as DevContourState;

const gate = (passed: boolean) => [{ gate: 'test', passed } as Verification['evidence'][number]];
const opts = { changeSetId: 'CHG-1' };

test('Отказ по пределу: засчитанные, прерванные (не засчитываются), сброс оператора и путь', () => {
  const legacy = verification('V-1', { error: 'This operation was aborted' });
  const gated = verification('V-2', { evidence: gate(false) });
  const flagged = verification('V-6', { interrupted: true });
  const other = verification('V-3', { tasks: [{ id: 'T-9' }] as Verification['tasks'] });
  // Определение движка: отметка и нет evidence.
  assert.equal(interruptedJoint(flagged), true);
  assert.equal(interruptedJoint(legacy), false);
  assert.equal(
    interruptedJoint(verification('V-7', { interrupted: true, evidence: gate(false) })),
    false,
  );
  assert.equal(gatelessJoint(legacy), true);
  assert.equal(gatelessJoint(gated), false);
  const s = state([
    changeSet('CHG-1', { verifications: [legacy, gated, flagged] }),
    changeSet('CHG-2', { verifications: [verification('V-5'), other] }),
  ]);
  const set = jointBudgetRefusal(s, ['T-2', 'T-1'], 3, 'set', opts);
  // Только этот набор задач, из любых ChangeSet: V-1, V-2, V-5 засчитаны, V-6 — нет.
  assert.match(
    set,
    /^Исчерпан предел совместных проверок этого набора задач \(3\): засчитано проверок набора 3 из 3; прервано до результата gates 1/,
  );
  // Сброс снимает проверки без результата gates: V-1, V-5 и V-6.
  assert.match(set, /Без результата gates — 3: их снимает сброс бюджета оператором/);
  assert.match(set, /devcontour changeset-budget-reset --changeset CHG-1 --reason/);
  assert.match(set, /новый ChangeSet над теми же задачами получит тот же отказ/);
  // Предел самого ChangeSet при запасе у набора: новый ChangeSet проверку начнёт.
  const own = jointBudgetRefusal(
    state([changeSet('CHG-1', { verifications: [gated, flagged] })]),
    ['T-1', 'T-2'],
    3,
    'changeset',
    opts,
  );
  assert.match(
    own,
    /^Исчерпан лимит попыток ChangeSet \(3\): засчитано проверок набора 1 из 3; прервано до результата gates 1 \(в предел не засчитываются, их предел 3\)\. У набора задач осталось проверок: 2/,
  );
  assert.doesNotMatch(own, /тот же отказ|changeset-budget-reset/);
  // Снятые сбросом проверки окно не содержит.
  const reset = jointBudgetRefusal(s, ['T-1', 'T-2'], 3, 'changeset', {
    ...opts,
    resetIds: new Set(['V-1', 'V-5', 'V-6']),
  });
  assert.match(reset, /засчитано проверок набора 1 из 3\. У набора задач осталось проверок: 2/);
});

test('Текст предела считает только проверки после принятого ChangeSet набора', () => {
  const passed = verification('V-2', { status: 'passed', evidence: gate(true) });
  const before = verification('V-1', { error: 'This operation was aborted' });
  const after = verification('V-3', { error: 'This operation was aborted' });
  const s = state([
    changeSet('CHG-1', {
      verifications: [before, passed],
      acceptance: {
        verificationId: 'V-2',
        jointBudgetCheckpoint: { verificationId: 'V-2', settledVerificationIds: ['V-1', 'V-2'] },
      } as unknown as ChangeSet['acceptance'],
    }),
    changeSet('CHG-2', { verifications: [after] }),
  ]);
  const text = jointBudgetRefusal(s, ['T-1', 'T-2'], 3, 'set', opts);
  // V-1 и V-2 до принятия в предел больше не входят.
  assert.match(text, /засчитано проверок набора 1 из 3\. Без результата gates — 1/);
});

test('Карточка остановленного задания ChangeSet называет причину и пути и закрывается принятием другого ChangeSet релиза', () => {
  const job = {
    id: 'CHG-1',
    key: 'job-key',
    kind: 'changeset',
    status: 'failed',
    error: 'Исчерпаны попытки стадии',
    attempts: 3,
    maxAttempts: 3,
    startedAt: '2026-01-01T00:00:00.000Z',
  };
  const failed = changeSet('CHG-1', {
    releaseId: 'r1',
    verifications: [verification('V-1', { error: 'This operation was aborted' })],
  });
  const reason = changeSetStopReason(state([failed]), job);
  assert.match(reason, /Задание ChangeSet CHG-1 остановлено: Исчерпаны попытки стадии\./);
  assert.match(
    reason,
    /V-1: failed — This operation was aborted \(без результата gates: предел проверок набора расходует, его снимает сброс оператора\)/,
  );
  assert.match(reason, /devcontour changeset-budget-reset --changeset CHG-1 --reason/);
  assert.match(
    changeSetStopReason(
      state([{ ...failed, verifications: [verification('V-1', { interrupted: true })] }]),
      job,
    ),
    /V-1: failed \(прервана до результата gates: в предел проверок набора не засчитывается\)/,
  );
  assert.match(reason, /workflow_retry его не примет/);
  assert.match(
    reason,
    /workspace-verify --changeset CHG-1, затем changeset-accept --changeset CHG-1/,
  );
  assert.match(
    changeSetStopReason(state([failed]), { ...job, attempts: 1 }),
    /workflow_retry \{"key": "job-key"\}/,
  );
  assert.deepEqual(
    stoppedWorkflows(state([failed]), [job]).map((w) => w.id),
    ['CHG-1'],
  );
  const accepted = (id: string, over: Partial<ChangeSet>) =>
    changeSet(id, {
      createdAt: '2026-01-02T00:00:00.000Z',
      acceptance: { verificationId: 'V-9' } as ChangeSet['acceptance'],
      ...over,
    });
  // Принят другой ChangeSet того же релиза — решение больше не нужно.
  assert.deepEqual(
    stoppedWorkflows(state([failed, accepted('CHG-2', { releaseId: 'r1', boardIds: ['B-7'] })]), [
      job,
    ]),
    [],
  );
  // Принят более поздний ChangeSet, включающий все доски.
  assert.deepEqual(
    stoppedWorkflows(
      state([{ ...failed, releaseId: undefined }, accepted('CHG-3', { boardIds: ['B-1', 'B-2'] })]),
      [job],
    ),
    [],
  );
  // Принятый ChangeSet другого релиза и других досок карточку не закрывает.
  assert.deepEqual(
    stoppedWorkflows(state([failed, accepted('CHG-4', { releaseId: 'r2', boardIds: ['B-7'] })]), [
      job,
    ]).map((w) => w.id),
    ['CHG-1'],
  );
  // Принятый раньше ChangeSet того же релиза (и тех же досок) упавший не
  // закрывает: упавший — следующий ChangeSet релиза после принятого.
  const earlier = accepted('CHG-0', {
    releaseId: 'r1',
    boardIds: ['B-1'],
    createdAt: '2025-12-31T00:00:00.000Z',
  });
  assert.deepEqual(
    stoppedWorkflows(state([earlier, { ...failed, supersedes: 'CHG-0' }]), [job]).map((w) => w.id),
    ['CHG-1'],
  );
});
