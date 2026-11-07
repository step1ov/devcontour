import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { AttentionService } from '../src/application/attention.ts';
import { DiscussionService } from '../src/application/discussion.ts';
import { DomainError } from '../src/core/model.ts';
import { digest, specDigest } from '../src/core/service.ts';
import { Workspace, changeSnapshot, snapshotDigest } from '../src/core/workspace.ts';
import { randomUUID } from 'node:crypto';
import { Preparation } from '../src/core/preparation.ts';
import { Store } from '../src/core/store.ts';
import type { AttentionItem } from '../src/core/attention-model.ts';
import { product } from './preparation-fixture.ts';
import { byKey, preparationFixture } from './attention-fixture.ts';
import { fixture, input } from './helpers.ts';

// D04-C: решение из старой вкладки после смены версии отклоняется, уже
// выполненное действие не повторяется.

const act = (item: AttentionItem, action: string, extra: Record<string, unknown> = {}) => ({
  sourceKey: item.sourceKey,
  occurrenceId: item.occurrenceId,
  expectedVersion: item.sourceVersion,
  action,
  ...extra,
});
const refusal = (code: string) => (error: unknown) =>
  error instanceof DomainError && error.status === 409 && error.details?.code === code;

test('План оператора: старая версия — attention-stale без изменений, двойная отправка — одно утверждение', async () => {
  const f = fixture();
  try {
    f.h.config.approvalMode = 'operator';
    const b = f.h.createBoard('Board');
    const one = f.h.addTask(b.id, input('One task'));
    const service = new AttentionService(f.store, f.h);
    const shown = byKey((await service.active()).items, `plan:${b.id}`)!;
    // Вторая вкладка: правка постановки между показом и решением.
    f.h.editTask(
      one.id,
      { ...input('One task, edited'), description: 'An edited observable outcome.' },
      specDigest(f.store.read().tasks.find((t) => t.id === one.id)!),
    );
    let stale: unknown;
    await assert.rejects(service.act(act(shown, 'approve')), (error) => {
      stale = error;
      return refusal('attention-stale')(error);
    });
    const current = (stale as DomainError).details!.item as AttentionItem;
    assert.equal(current.id, shown.id);
    assert.notEqual(current.sourceVersion, shown.sourceVersion);
    assert.equal(f.store.read().tasks.find((t) => t.id === one.id)!.status, 'draft');
    const done = await service.act(act(current, 'approve'));
    assert.deepEqual(done.resolved, true);
    const approvedAt = f.store.read().tasks.find((t) => t.id === one.id)!.approvedAt;
    assert.ok(approvedAt);
    await assert.rejects(service.act(act(current, 'approve')), refusal('attention-resolved'));
    assert.equal(f.store.read().tasks.find((t) => t.id === one.id)!.approvedAt, approvedAt);
  } finally {
    f.cleanup();
  }
});

test('Ответ оператора в обсуждении: повтор с тем же ключом — replayed, одно сообщение', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    const discussion = new DiscussionService(f.h);
    const request = discussion.post(
      {
        taskId: t.id,
        kind: 'change-request',
        text: 'Нужен ночной режим',
        idempotencyKey: 'attention-act-1',
        expectedVersion: 0,
      },
      'operator',
    ).message;
    discussion.resolve({
      requestId: request.id,
      outcome: 'needs-answer',
      reason: 'Какой режим по умолчанию?',
      idempotencyKey: 'attention-act-2',
      expectedVersion: f.store.discussionVersion(undefined, t.id),
    });
    const service = new AttentionService(f.store, f.h);
    const card = byKey((await service.active()).items, `discussion:na:${request.id}`)!;
    const body = act(card, 'answer', {
      input: { text: 'Дневной по умолчанию' },
      idempotencyKey: 'attention-act-answer-1',
    });
    const first = await service.act(body);
    assert.equal(first.resolved, true);
    const version = f.store.discussionVersion(undefined, t.id);
    const again = await service.act(body);
    assert.deepEqual((again.result as { replayed: boolean }).replayed, true);
    assert.equal(f.store.discussionVersion(undefined, t.id), version, 'второго сообщения нет');
    // Без ключа повтор — карточка уже решена.
    await assert.rejects(
      service.act({ ...body, idempotencyKey: undefined }),
      refusal('attention-resolved'),
    );
  } finally {
    f.cleanup();
  }
});

test('Пауза оператора: запуск очереди с карточки; действие ведущего не предлагается оператору', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    f.h.pause(true);
    let ticks = 0;
    const service = new AttentionService(f.store, f.h);
    const queue = byKey((await service.active()).items, 'queue')!;
    await assert.rejects(
      service.act(act(queue, 'resume'), { stopping: () => true }),
      (e: unknown) => e instanceof DomainError && e.status === 409,
    );
    assert.equal(f.store.read().paused, true);
    const done = await service.act(act(queue, 'resume'), {
      tick: () => Promise.resolve(++ticks),
    });
    assert.equal(done.resolved, true);
    assert.equal(f.store.read().paused, false);
    assert.equal(ticks, 1);
    // Карточка ведущего: доменного действия у оператора нет.
    const run = f.h.claim('test')!;
    assert.equal(run.taskId, t.id);
    f.h.fail(run.id, run.token, 'fixture failure', false, 'gate');
    const work = byKey((await service.active()).items, `work:${t.id}`)!;
    await assert.rejects(
      service.act(act(work, 'retry')),
      (e: unknown) => e instanceof DomainError && e.status === 400,
    );
  } finally {
    f.cleanup();
  }
});

test('До setup: ответ на вопрос и согласование с карточки; гонка со второй базой — один победитель', async () => {
  const f = preparationFixture();
  try {
    f.p.execute('preparation_question', {
      changeId: f.changeId,
      stage: 'architecture',
      add: [{ text: 'Кто модерирует ночью?', options: ['Бот', 'Дежурный'] }],
    });
    f.p.execute('preparation_product', {
      changeId: f.changeId,
      expectedDigest: null,
      reason: 'Постановка',
      content: product,
    });
    const view = f.p.status(f.changeId);
    if (!view.enabled) throw new Error('preparation');
    f.p.execute('preparation_submit', {
      changeId: f.changeId,
      stage: 'product',
      expectedDigest: view.current!.product!.digest,
    });
    const service = new AttentionService(f.store, undefined);
    const items = (await service.active()).items;
    const question = items.find((i) => i.source === 'prep-question')!;
    const answered = await service.act(act(question, 'answer', { input: { optionId: '1' } }));
    assert.equal(answered.resolved, true);
    assert.equal(f.store.read().preparation!.changes[0].questions[0].answer!.text, 'Дежурный');
    // Решение из второго процесса раньше карточки: карточка отклоняется.
    const stage = byKey(items, `prep:stage:${f.changeId}:product`)!;
    const other = new Store(join(f.root, 'state.sqlite'));
    try {
      new Preparation(other).decide({
        changeId: f.changeId,
        stage: 'product',
        expectedDigest: view.current!.product!.digest,
        decision: 'approve',
        comment: 'Из другой вкладки',
      });
    } finally {
      other.close();
    }
    await assert.rejects(service.act(act(stage, 'approve')), refusal('attention-resolved'));
    const decisions = f.store.read().preparation!.changes[0].product.filter((r) => r.decision);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].decision!.comment, 'Из другой вкладки');
    // Действия движка до setup отсутствуют: карточек движка нет.
    await assert.rejects(
      service.act({
        sourceKey: 'queue',
        occurrenceId: 'initial',
        expectedVersion: 'x',
        action: 'resume',
      }),
      refusal('attention-resolved'),
    );
  } finally {
    f.cleanup();
  }
});

test('ChangeSet: выкладка preview и приёмка с карточки; новая проверка делает старую карточку устаревшей', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    f.h.addTask(b.id, input());
    f.h.approve(b.id);
    const change = new Workspace(f.h).create({
      title: 'Каталог',
      description: 'Поиск по каталогу',
      boardIds: [b.id],
    });
    f.h.config.preview = {
      compose: 'main/c.yml',
      service: 'web',
      port: 45998,
      health: { path: '/health', timeoutMs: 1000 },
    };
    const manifest = { main: { sha: 'a'.repeat(40), tree: 'b'.repeat(40) } };
    const verify = () =>
      f.store.change('fixture.verified', (s) => {
        const cs = s.changeSets.find((x) => x.id === change.id)!;
        cs.verifications.push({
          id: randomUUID(),
          token: randomUUID(),
          leaseUntil: 0,
          startedAt: new Date().toISOString(),
          status: 'passed',
          finishedAt: new Date().toISOString(),
          policyDigest: new Workspace(f.h).policyDigest(),
          specDigest: snapshotDigest(changeSnapshot(s, cs)),
          tasks: [],
          boards: [],
          manifest,
          manifestDigest: digest(manifest),
          evidence: [],
        });
      });
    verify();
    const service = new AttentionService(f.store, f.h);
    const key = `changeset:${change.id}`;
    const card = byKey((await service.active()).items, key)!;
    assert.deepEqual(
      card.actions.filter((a) => a.kind === 'domain').map((a) => a.id),
      ['deploy-preview', 'accept'],
    );
    // Выкладка: без работающего раннера — отказ; с ним — начата один раз.
    await assert.rejects(
      service.act(act(card, 'deploy-preview')),
      (e: unknown) => e instanceof DomainError && e.status === 409,
    );
    const deployed: string[] = [];
    const started = await service.act(act(card, 'deploy-preview'), {
      deploy: (id) => (deployed.push(id), Promise.resolve()),
    });
    assert.deepEqual(started.result, { status: 'started', changeSetId: change.id });
    assert.deepEqual(deployed, [change.id]);
    // Повторная проверка: показанная карточка устарела, приёмка по ней не идёт.
    verify();
    await assert.rejects(service.act(act(card, 'accept')), refusal('attention-stale'));
    assert.equal(f.store.read().changeSets[0].acceptance, undefined);
    const current = byKey((await service.active()).items, key)!;
    const accepted = await service.act(act(current, 'accept'));
    assert.equal(accepted.resolved, true);
    const acceptance = f.store.read().changeSets[0].acceptance!;
    assert.equal(acceptance.approval.actor, 'operator');
    assert.equal(acceptance.verificationId, current.occurrenceId);
    await assert.rejects(service.act(act(current, 'accept')), refusal('attention-resolved'));
  } finally {
    f.cleanup();
  }
});

test('Расхождение между проверкой карточки и утверждением ловит сам approve; блокировка записи в промежутке не держится', async () => {
  const f = fixture();
  try {
    f.h.config.approvalMode = 'operator';
    const b = f.h.createBoard('Board');
    const one = f.h.addTask(b.id, input('One task'));
    let wrote = false;
    const service = new AttentionService(f.store, f.h, {
      afterCheck: (a) => {
        // Другой процесс пишет в базу между проверкой и операцией: блокировки нет.
        const other = new Store(join(f.root, 'state.sqlite'));
        try {
          other.atomic(() => other.saveLocal('fixture', undefined, 'probe', { v: 1 }));
          wrote = true;
        } finally {
          other.close();
        }
        // И правит черновик: показанные поля ревью больше не совпадают.
        f.h.editTask(
          one.id,
          { ...input('One task, edited'), description: 'An edited observable outcome.' },
          specDigest(f.store.read().tasks.find((t) => t.id === one.id)!),
        );
        return a;
      },
    });
    const card = byKey((await service.active()).items, `plan:${b.id}`)!;
    await assert.rejects(service.act(act(card, 'approve')), /План изменился во время ревью/);
    assert.equal(wrote, true);
    assert.equal(f.store.read().tasks.find((t) => t.id === one.id)!.status, 'draft');
  } finally {
    f.cleanup();
  }
});

test('Заметка в треде после показа вопроса оператору делает карточку устаревшей', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    const discussion = new DiscussionService(f.h);
    const version = () => f.store.discussionVersion(undefined, t.id);
    const request = discussion.post(
      {
        taskId: t.id,
        kind: 'change-request',
        text: 'Нужен ночной режим',
        idempotencyKey: 'attention-drift-1',
        expectedVersion: version(),
      },
      'operator',
    ).message;
    discussion.resolve({
      requestId: request.id,
      outcome: 'needs-answer',
      reason: 'Какой режим по умолчанию?',
      idempotencyKey: 'attention-drift-2',
      expectedVersion: version(),
    });
    const service = new AttentionService(f.store, f.h);
    const card = byKey((await service.active()).items, `discussion:na:${request.id}`)!;
    discussion.post(
      {
        taskId: t.id,
        kind: 'note',
        text: 'Уточнение ведущего: режим влияет на тему',
        idempotencyKey: 'attention-drift-3',
        expectedVersion: version(),
      },
      'lead',
    );
    await assert.rejects(
      service.act(act(card, 'answer', { input: { text: 'Дневной' } })),
      refusal('attention-stale'),
    );
  } finally {
    f.cleanup();
  }
});
