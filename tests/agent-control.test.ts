import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture, input } from './helpers.ts';
import { reviewContract, reviewPlan, acceptBoard } from '../src/runner/agent-control.ts';
import { specDigest } from '../src/core/service.ts';
import type { AgentAdapter, AgentRequest } from '../src/runner/adapters.ts';

function runtimes(action?: (r: AgentRequest) => void, blocking = false) {
  const make = (name: 'codex' | 'claude'): AgentAdapter => ({
    name,
    async execute(r) {
      action?.(r);
      return {
        data: {
          approved: true,
          summary: 'Explicit test fixture',
          findings: blocking ? [{ severity: 'blocking', message: 'Missing behavior' }] : [],
        },
        log: 'Fixture only; no provider called',
        command: ['fixture'],
      };
    },
  });
  return { codex: make('codex'), claude: make('claude') };
}

test('Agent contracts require another runtime, retain review proof and deduplicate repeated content', async () => {
  const f = fixture();
  try {
    f.h.config.mode = 'local';
    const proposal = {
      title: 'Catalog API v1',
      content: 'GET /products returns a documented list and errors.',
    };
    let calls = 0;
    const r = await reviewContract(
      f.h,
      f.root,
      proposal,
      'codex',
      runtimes(() => {
        calls++;
      }),
    );
    assert.equal(r.status, 'approved');
    const contract = f.store.read().contracts[0];
    assert.equal(contract.approval?.authorRuntime, 'codex');
    assert.equal(contract.approval?.reviewerRuntime, 'claude');
    const saved = JSON.parse(await readFile(contract.approval.artifact + '/proposal.json', 'utf8'));
    assert.deepEqual(saved, proposal);
    await reviewContract(
      f.h,
      f.root,
      proposal,
      'codex',
      runtimes(() => {
        calls++;
      }),
    );
    assert.equal(calls, 1);
    assert.equal(f.store.read().contracts.length, 1);
  } finally {
    f.cleanup();
  }
});

test('Operator mode reviews but does not register contracts or approve draft tasks', async () => {
  const f = fixture();
  try {
    f.h.config.mode = 'local';
    f.h.config.approvalMode = 'operator';
    const b = f.h.createBoard('Operator mode');
    f.h.addTask(b.id, input());
    assert.equal(
      (
        await reviewContract(
          f.h,
          f.root,
          { title: 'Contract', content: 'Concrete agreed interface' },
          'claude',
          runtimes(),
        )
      ).status,
      'awaiting-operator',
    );
    assert.equal(
      (await reviewPlan(f.h, f.root, b.id, 'claude', runtimes())).status,
      'awaiting-operator',
    );
    assert.equal(f.store.read().contracts.length, 0);
    assert.equal(f.store.read().tasks[0].status, 'draft');
  } finally {
    f.cleanup();
  }
});

test('Blocking findings reject even approved=true and do not enable execution', async () => {
  const f = fixture();
  try {
    f.h.config.mode = 'local';
    const b = f.h.createBoard('Blocked plan');
    f.h.addTask(b.id, input());
    await assert.rejects(
      reviewPlan(f.h, f.root, b.id, 'codex', runtimes(undefined, true)),
      /отклонено/,
    );
    assert.equal(f.store.read().tasks[0].status, 'draft');
    await assert.rejects(
      reviewContract(
        f.h,
        f.root,
        { title: 'API', content: 'Ambiguous' },
        'codex',
        runtimes(undefined, true),
      ),
      /отклонено/,
    );
    assert.equal(f.store.read().contracts.length, 0);
    // Отклонённая попытка стоила вызова модели и остаётся в состоянии с
    // находками: иначе процесс виден только файлами на диске.
    const attempts = f.store.read().contractAttempts ?? [];
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].approved, false);
    assert.equal(attempts[0].title, 'API');
    assert.ok(attempts[0].findings.some((finding) => finding.severity === 'blocking'));
    assert.ok(attempts[0].artifact.length > 0);
  } finally {
    f.cleanup();
  }
});

test('Agent plan approval is bound to reviewed specifications and preserves contract requirements', async () => {
  const f = fixture();
  try {
    f.h.config.mode = 'local';
    const b = f.h.createBoard('Changed plan');
    const task = f.h.addTask(b.id, input());
    await assert.rejects(
      reviewPlan(
        f.h,
        f.root,
        b.id,
        'codex',
        runtimes(() => {
          f.h.editTask(
            task.id,
            { ...input(), description: 'A different requirement after the review started.' },
            specDigest(task),
          );
        }),
      ),
      /изменился/,
    );
    assert.equal(f.store.read().tasks[0].status, 'draft');
    const result = await reviewPlan(f.h, f.root, b.id, 'codex', runtimes());
    assert.equal(result.status, 'approved');
    assert.equal(f.store.read().tasks[0].approval?.actor, 'agent');
    const second = f.h.createBoard('Missing API contract');
    f.h.addTask(second.id, { ...input(), role: 'backend' });
    await assert.rejects(reviewPlan(f.h, f.root, second.id, 'codex', runtimes()), /контракт/);
    assert.equal(f.store.read().tasks.at(-1)!.status, 'draft');
    const third = f.h.createBoard('Task added during review');
    f.h.addTask(third.id, input());
    await assert.rejects(
      reviewPlan(
        f.h,
        f.root,
        third.id,
        'codex',
        runtimes(() => {
          f.h.addTask(third.id, input('A late addition'));
        }),
      ),
      /изменился/,
    );
    assert.ok(
      f.store
        .read()
        .tasks.slice(-2)
        .every((t) => t.status === 'draft'),
    );
  } finally {
    f.cleanup();
  }
});

test('Agent cannot accept a board containing unverified work', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Unfinished work');
    f.h.addTask(b.id, input());
    await assert.rejects(acceptBoard(f.h, b.id, 'codex'), /done/);
    assert.equal(f.store.read().boards[0].revisions[0].status, 'active');
  } finally {
    f.cleanup();
  }
});
