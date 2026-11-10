import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interruptedJoint, jointBudgetRefusal } from '../src/core/joint-budget.ts';
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

test('Отказ по пределу совместных проверок называет прерванные проверки набора и путь', () => {
  const aborted = verification('V-1', { error: 'This operation was aborted' });
  const gated = verification('V-2', {
    evidence: [{ gate: 'test', passed: false } as Verification['evidence'][number]],
  });
  const other = verification('V-3', { tasks: [{ id: 'T-9' }] as Verification['tasks'] });
  assert.equal(interruptedJoint(aborted), true);
  assert.equal(interruptedJoint(gated), false);
  assert.equal(interruptedJoint(verification('V-4', { status: 'passed' })), false);
  const s = state([
    changeSet('CHG-1', { verifications: [aborted, gated] }),
    changeSet('CHG-2', { verifications: [verification('V-5'), other] }),
  ]);
  const set = jointBudgetRefusal(s, ['T-2', 'T-1'], 3, 'set');
  assert.match(set, /^Исчерпан предел совместных проверок этого набора задач \(3\)/);
  // Прерванные — только этого набора задач, из любых ChangeSet: V-1 и V-5.
  assert.match(set, /2 прерваны до первого gate/);
  assert.match(set, /новый ChangeSet над теми же задачами получит тот же отказ/);
  assert.match(set, /новая ревизия доски/);
  const own = jointBudgetRefusal(
    state([changeSet('CHG-1', { verifications: [gated] })]),
    ['T-1', 'T-2'],
    3,
    'changeset',
  );
  assert.match(own, /^Исчерпан лимит попыток ChangeSet \(3\)\. Предел/);
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
  assert.match(reason, /V-1: failed — This operation was aborted \(прервана до первого gate/);
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
