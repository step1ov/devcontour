import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttentionService } from '../src/application/attention.ts';
import { quickFactsCache } from '../src/application/quick-view.ts';
import { randomUUID } from 'node:crypto';
import type { Store } from '../src/core/store.ts';
import { digest, type DevContour } from '../src/core/service.ts';
import { Workspace, changeSnapshot, snapshotDigest } from '../src/core/workspace.ts';
import { fixture, input } from './helpers.ts';
import { DiscussionService } from '../src/application/discussion.ts';
import { AgentService } from '../src/application/agent.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { executionOf } from '../src/harness/execution.ts';
import { CheckCorpus, canonicalJson, sha256 } from '../src/core/check-store.ts';
import { declaration, propertyGate } from './check-fixture.ts';
import { architecture, product } from './preparation-fixture.ts';
import { byKey, preparationFixture } from './attention-fixture.ts';

// D04-A: для каждого источника — появление, повтор без дубликата,
// существенное обновление, устранение и повторное появление. Отметки
// «прочитано» по появлению проверяет attention-marks.test.ts.

const at = (now: number) => ({ now: () => now });

test('S1 вопрос ведущего: появление, повтор, ответ снимает, переспрос — новое появление', async () => {
  const f = preparationFixture();
  try {
    const now = Date.now();
    f.p.execute('preparation_question', {
      changeId: f.changeId,
      add: [{ text: 'Кто модерирует чат ночью?', options: ['Бот', 'Дежурный'] }],
    });
    const q = f.store.read().preparation!.changes[0].questions[0];
    const key = `prep:q:${f.changeId}:${q.id}`;
    const first = await new AttentionService(f.store, undefined, at(now)).active();
    const item = byKey(first.items, key)!;
    assert.equal(item.actor, 'operator');
    assert.equal(item.category, 'question');
    assert.equal(item.occurrenceId, q.id);
    assert.ok(item.actions.some((a) => a.id === 'answer'));
    // Повтор и ход времени: тот же id и версия, без дубликата.
    const again = await new AttentionService(f.store, undefined, at(now + 60_000)).active();
    assert.deepEqual(
      again.items.filter((i) => i.sourceKey === key).map((i) => [i.id, i.sourceVersion]),
      [[item.id, item.sourceVersion]],
    );
    // Вопрос неизменяем: существенного обновления у источника нет.
    f.p.answer({ changeId: f.changeId, questionId: q.id, text: 'Дежурный модератор' });
    const answered = await new AttentionService(f.store, undefined).active();
    assert.equal(byKey(answered.items, key), undefined);
    // Переспрос — новый вопрос, новый предмет и появление.
    f.p.execute('preparation_question', {
      changeId: f.changeId,
      add: [{ text: 'Кто модерирует чат в выходные?' }],
    });
    const q2 = f.store.read().preparation!.changes[0].questions[1];
    const reask = await new AttentionService(f.store, undefined).active();
    assert.equal(byKey(reask.items, `prep:q:${f.changeId}:${q2.id}`)!.occurrenceId, q2.id);
  } finally {
    f.cleanup();
  }
});

test('S2 ответ без решения ведущего: снятое решение — новое появление', async () => {
  const f = preparationFixture();
  try {
    f.p.execute('preparation_question', {
      changeId: f.changeId,
      add: [{ text: 'Нужна ли история сообщений?' }],
    });
    const q = f.store.read().preparation!.changes[0].questions[0];
    const key = `prep:qa:${f.changeId}:${q.id}`;
    const none = await new AttentionService(f.store, undefined).active();
    assert.equal(byKey(none.items, key), undefined);
    f.p.answer({ changeId: f.changeId, questionId: q.id, text: 'Да, за 30 дней' });
    const pending = byKey((await new AttentionService(f.store, undefined).active()).items, key)!;
    assert.equal(pending.actor, 'lead');
    assert.equal(pending.category, 'technical');
    assert.match(pending.occurrenceId, /^a:/);
    f.p.execute('preparation_resolve', {
      changeId: f.changeId,
      statement: 'История хранится 30 дней',
      rationale: 'Ответ оператора',
      questionId: q.id,
    });
    assert.equal(
      byKey((await new AttentionService(f.store, undefined).active()).items, key),
      undefined,
    );
    const record = f.store.read().preparation!.changes[0].decisions[0];
    f.p.execute('preparation_resolve', {
      changeId: f.changeId,
      withdraw: [{ id: record.id, reason: 'Пересмотрено' }],
    });
    const again = byKey((await new AttentionService(f.store, undefined).active()).items, key)!;
    assert.match(again.occurrenceId, /^w:/);
    assert.notEqual(again.occurrenceId, pending.occurrenceId);
  } finally {
    f.cleanup();
  }
});

test('S3/S4 согласование этапа: редакция, доработка, новая редакция, прежняя постановка', async () => {
  const f = preparationFixture();
  try {
    const submit = (stage: 'product' | 'architecture') => {
      const view = f.p.status(f.changeId);
      if (!view.enabled) throw new Error('preparation');
      f.p.execute('preparation_submit', {
        changeId: f.changeId,
        stage,
        expectedDigest: view.current![stage]!.digest,
      });
      return view.current![stage]!.digest;
    };
    const items = async () => (await new AttentionService(f.store, undefined).active()).items;
    f.p.execute('preparation_product', {
      changeId: f.changeId,
      expectedDigest: null,
      reason: 'Первая постановка',
      content: product,
    });
    const digest1 = submit('product');
    const stageKey = `prep:stage:${f.changeId}:product`;
    const review = byKey(await items(), stageKey)!;
    assert.equal(review.actor, 'operator');
    assert.equal(review.category, 'decision');
    assert.equal(review.occurrenceId, 'r1');
    assert.deepEqual(
      review.actions.filter((a) => a.kind === 'domain').map((a) => a.id),
      ['approve', 'request-changes'],
    );
    // Доработка: карточка оператора уходит, появляется карточка ведущего.
    f.p.decide({
      changeId: f.changeId,
      stage: 'product',
      expectedDigest: digest1,
      decision: 'request-changes',
      comment: 'Добавьте ночную модерацию',
    });
    const after = await items();
    assert.equal(byKey(after, stageKey), undefined);
    const rework = byKey(after, `prep:rework:${f.changeId}:product`)!;
    assert.equal(rework.actor, 'lead');
    assert.equal(rework.occurrenceId, 'r1');
    // Новая редакция снимает доработку и даёт новое появление согласования.
    f.p.execute('preparation_product', {
      changeId: f.changeId,
      expectedDigest: digest1,
      reason: 'Добавлена ночная модерация',
      content: { ...product, problem: product.problem + ' Ночью модерирует дежурный.' },
    });
    const digest2 = submit('product');
    const second = await items();
    assert.equal(byKey(second, `prep:rework:${f.changeId}:product`), undefined);
    assert.equal(byKey(second, stageKey)!.occurrenceId, 'r2');
    f.p.decide({
      changeId: f.changeId,
      stage: 'product',
      expectedDigest: digest2,
      decision: 'approve',
      comment: 'Хорошо',
    });
    assert.equal(byKey(await items(), stageKey), undefined);
    // Архитектура на ревью, затем новая редакция продукта утверждена: прежняя
    // архитектура относится к прежней постановке — версия меняется, кнопки нет.
    f.p.execute('preparation_architecture', {
      changeId: f.changeId,
      expectedDigest: null,
      reason: 'Стек',
      content: architecture,
    });
    submit('architecture');
    const arch = byKey(await items(), `prep:stage:${f.changeId}:architecture`)!;
    assert.equal(arch.actor, 'operator');
    f.p.execute('preparation_product', {
      changeId: f.changeId,
      expectedDigest: digest2,
      reason: 'Уточнение',
      content: { ...product, problem: product.problem + ' Уточнено.' },
    });
    const digest3 = submit('product');
    f.p.decide({
      changeId: f.changeId,
      stage: 'product',
      expectedDigest: digest3,
      decision: 'approve',
      comment: 'Ок',
    });
    const stale = byKey(await items(), `prep:stage:${f.changeId}:architecture`)!;
    assert.equal(stale.id, arch.id, 'та же редакция — то же появление');
    assert.notEqual(stale.sourceVersion, arch.sourceVersion);
    assert.equal(stale.actor, 'lead');
    assert.deepEqual(
      stale.actions.map((a) => a.kind),
      ['navigate'],
    );
  } finally {
    f.cleanup();
  }
});

test('S5 быстрый маршрут: подключение стоит, Git исправлен — карточки нет; тот же HEAD — то же появление (ограничение)', async () => {
  const f = preparationFixture();
  const repository = mkdtempSync(join(tmpdir(), 'devcontour-attention-repo-'));
  const workspace = mkdtempSync(join(tmpdir(), 'devcontour-attention-ws-'));
  try {
    writeFileSync(join(repository, 'package.json'), '{"name":"app","private":true}\n');
    writeFileSync(join(repository, 'package-lock.json'), '{"name":"app","lockfileVersion":3}\n');
    f.p.execute('preparation_quick', {
      requestKey: 'attention-quick-1',
      title: 'Быстрая правка',
      repository,
      brief: 'Исправить сложение отрицательных чисел',
      criterion: 'add(-2, -3) возвращает -5',
    });
    const changeId = f.store.read().preparation!.activeChangeId!;
    const key = `quick:${changeId}:connection`;
    // Без кэша: каждое чтение видит текущий Git.
    const service = () =>
      new AttentionService(f.store, undefined, {
        root: workspace,
        cachedFacts: quickFactsCache(0),
      });
    const blocked = byKey((await service().active()).items, key)!;
    assert.equal(blocked.actor, 'operator');
    assert.equal(blocked.category, 'access');
    assert.match(blocked.reason, /Git|git/);
    const repeat = byKey((await service().active()).items, key)!;
    assert.deepEqual([repeat.id, repeat.sourceVersion], [blocked.id, blocked.sourceVersion]);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repository, ...args], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'A',
          GIT_AUTHOR_EMAIL: 'a@example.test',
          GIT_COMMITTER_NAME: 'A',
          GIT_COMMITTER_EMAIL: 'a@example.test',
        },
      });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-qm', 'init');
    assert.equal(byKey((await service().active()).items, key), undefined);
    // Ограничение источника без журнала: та же причина при том же HEAD (здесь
    // — без HEAD вовсе) возвращает прежнее появление. Новое поручение — новое.
    rmSync(join(repository, '.git'), { recursive: true, force: true });
    const back = byKey((await service().active()).items, key)!;
    assert.equal(back.occurrenceId, blocked.occurrenceId);
  } finally {
    f.cleanup();
    rmSync(repository, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Источники движка                                                    */
/* ------------------------------------------------------------------ */

const engineItems = async (f: { store: Store; h: DevContour }, now?: number) =>
  (await new AttentionService(f.store, f.h, now ? at(now) : {}).active()).items;

/** Выданная попытка задачи падает на gate. */
function failNext(h: DevContour, taskId: string, kind: 'gate' | 'provider-auth' = 'gate') {
  h.pause(false);
  const run = h.claim('test')!;
  assert.equal(run.taskId, taskId);
  h.fail(run.id, run.token, `fixture failure (${kind})`, false, kind);
  return run;
}

test('S10 задача: появление по попытке, повтор, retry снимает, новая попытка с тем же отказом — новое появление', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const root = f.h.addTask(b.id, input('Root'));
    f.h.addTask(b.id, input('Dependent', [root.id]));
    f.h.approve(b.id);
    const run1 = failNext(f.h, root.id);
    const key = `work:${root.id}`;
    const items = await engineItems(f);
    const card = byKey(items, key)!;
    assert.equal(card.occurrenceId, run1.id, 'появление — id попытки');
    assert.equal(card.actor, 'lead');
    assert.equal(card.impact.tasks, 1);
    assert.equal(card.impact.waiting, 1);
    // Зависимая своей карточки не даёт: она — влияние корня.
    assert.equal(items.filter((i) => i.source === 'work').length, 1);
    const later = byKey(await engineItems(f, Date.now() + 3_600_000), key)!;
    assert.deepEqual([later.id, later.sourceVersion], [card.id, card.sourceVersion]);
    f.h.retry(root.id);
    assert.equal(byKey(await engineItems(f), key), undefined);
    const run2 = failNext(f.h, root.id);
    const again = byKey(await engineItems(f), key)!;
    assert.equal(again.occurrenceId, run2.id);
    assert.notEqual(again.id, card.id);
    assert.equal(
      again.sourceVersion,
      card.sourceVersion,
      'тот же отказ — та же версия, новое появление',
    );
  } finally {
    f.cleanup();
  }
});

test('S12 пауза: оператор, отказ провайдера сворачивает задачи в одну карточку доступа', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t1 = f.h.addTask(b.id, input('One'));
    const t2 = f.h.addTask(b.id, input('Two'));
    f.h.approve(b.id);
    f.h.pause(true);
    const paused = byKey(await engineItems(f), 'queue')!;
    assert.equal(paused.actor, 'operator');
    assert.equal(paused.category, 'decision');
    assert.equal(paused.occurrenceId, f.store.read().pausedAt);
    assert.ok(paused.actions.some((a) => a.id === 'resume'));
    f.h.pause(false);
    assert.equal(byKey(await engineItems(f), 'queue'), undefined);
    await new Promise((r) => setTimeout(r, 5));
    f.h.pause(true);
    const again = byKey(await engineItems(f), 'queue')!;
    assert.notEqual(again.occurrenceId, paused.occurrenceId, 'новая пауза — новое появление');
    // Отказ провайдера: обе задачи упали на авторизации, выдача остановлена.
    failNext(f.h, t1.id, 'provider-auth');
    failNext(f.h, t2.id, 'provider-auth');
    f.store.change('fixture.pause', (s) => {
      s.paused = true;
      s.pauseReason = 'runtime';
      s.pauseFailures = ['provider-auth'];
    });
    const items = await engineItems(f);
    const access = byKey(items, 'queue')!;
    assert.equal(access.category, 'access');
    assert.notEqual(access.sourceVersion, again.sourceVersion);
    assert.deepEqual(access.impact.taskIds.sort(), [t1.id, t2.id].sort());
    assert.equal(items.filter((i) => i.source === 'work').length, 0);
  } finally {
    f.cleanup();
  }
});

test('S6 план в режиме operator: утверждение снимает, новый черновик после утверждения — новое появление', async () => {
  const f = fixture();
  try {
    f.h.config.approvalMode = 'operator';
    const b = f.h.createBoard('Board');
    const t1 = f.h.addTask(b.id, input('One'));
    const key = `plan:${b.id}`;
    const card = byKey(await engineItems(f), key)!;
    assert.equal(card.actor, 'operator');
    assert.equal(card.category, 'decision');
    assert.deepEqual(card.impact.taskIds, [t1.id]);
    // Существенное обновление: второй черновик в той же ревизии.
    const t2 = f.h.addTask(b.id, input('Two'));
    const updated = byKey(await engineItems(f), key)!;
    assert.equal(updated.id, card.id);
    assert.notEqual(updated.sourceVersion, card.sourceVersion);
    f.h.approve(b.id);
    assert.equal(byKey(await engineItems(f), key), undefined);
    f.h.addTask(b.id, input('Three', [t2.id]));
    const again = byKey(await engineItems(f), key)!;
    assert.notEqual(again.occurrenceId, card.occurrenceId);
  } finally {
    f.cleanup();
  }
});

test('S13 упавшая операция изменения контракта держит задачи: одна карточка ведущего', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const held = f.h.addTask(b.id, input('Held'));
    f.h.approve(b.id);
    const op = 'CC-' + randomUUID();
    f.h.hold([held.id], op, 'contract change');
    const record = (status: string, version: number, at: string) => ({
      id: op,
      key: 'main:openapi',
      owner: 'main',
      status,
      version,
      error: 'review rejected',
      held: [held.id],
      startedAt: '2026-01-01T00:00:00.000Z',
      history: [{ at, step: 'review', event: status }],
    });
    const save = (value: unknown) =>
      f.store.atomic(() => f.store.saveLocal('contract-change', 'main', op, value));
    save(record('failed', 3, '2026-01-01T00:01:00.000Z'));
    const items = await engineItems(f);
    const card = byKey(items, `contract-change:${op}`)!;
    assert.equal(card.actor, 'lead');
    assert.deepEqual(card.impact.taskIds, [held.id]);
    assert.equal(items.filter((i) => i.source === 'work').length, 0);
    save(record('running', 4, '2026-01-01T00:01:00.000Z'));
    assert.equal(byKey(await engineItems(f), `contract-change:${op}`), undefined);
    save({
      ...record('failed', 5, '2026-01-01T00:02:00.000Z'),
      history: [
        { at: '2026-01-01T00:01:00.000Z', step: 'review', event: 'failed' },
        { at: '2026-01-01T00:02:00.000Z', step: 'review', event: 'failed' },
      ],
    });
    const again = byKey(await engineItems(f), `contract-change:${op}`)!;
    assert.notEqual(again.occurrenceId, card.occurrenceId);
  } finally {
    f.cleanup();
  }
});

test('S14 ожидание блокировки контекста и подтверждения переноса базы', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    f.h.addTask(b.id, input());
    f.h.approve(b.id);
    f.h.waitFor('context-lock', 'op-1', 'Контекст закреплён другой операцией');
    const lock = byKey(await engineItems(f), 'wait:context-lock')!;
    assert.equal(lock.actor, 'lead');
    f.h.clearWait('context-lock', 'op-1');
    assert.equal(byKey(await engineItems(f), 'wait:context-lock'), undefined);
    f.store.change('fixture.base-wait', (s) => {
      s.paused = true;
      s.pauseReason = 'base-check';
      s.waits = [
        {
          kind: 'base-check',
          detail: 'Перенос меняет приёмку или настройку контура: AGENTS.md',
          at: new Date().toISOString(),
        },
      ];
    });
    const items = await engineItems(f);
    const base = byKey(items, 'wait:base-check')!;
    assert.equal(base.actor, 'operator');
    assert.ok(base.actions.some((a) => a.id === 'resume'));
    // Ожидание проверки базы — не пауза S12: без дубликата.
    assert.equal(byKey(items, 'queue'), undefined);
  } finally {
    f.cleanup();
  }
});

test('S16/S17 проверенное изменение ждёт приёмки; сбой выкладки preview — ведущему', async () => {
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
    const manifest = { main: { sha: 'a'.repeat(40), tree: 'b'.repeat(40) } };
    const verify = () => {
      const id = randomUUID();
      f.store.change('fixture.verified', (s) => {
        const cs = s.changeSets.find((x) => x.id === change.id)!;
        cs.verifications.push({
          id,
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
      return id;
    };
    const v1 = verify();
    const card = byKey(await engineItems(f), `changeset:${change.id}`)!;
    assert.equal(card.occurrenceId, v1);
    assert.equal(card.actor, 'operator');
    assert.ok(card.actions.some((a) => a.id === 'accept'));
    const v2 = verify();
    assert.equal(byKey(await engineItems(f), `changeset:${change.id}`)!.occurrenceId, v2);
    f.store.change('fixture.preview', (s) => {
      s.previews = [
        {
          id: 'PV-1',
          changeSetId: change.id,
          verificationId: v2,
          manifestDigest: digest(manifest),
          policyDigest: 'p',
          release: 'r1',
          project: 'dc-r1',
          token: 't',
          leaseUntil: 0,
          status: 'failed',
          failure: 'build',
          error: 'docker build failed',
          active: false,
          startedAt: new Date().toISOString(),
        },
      ];
    });
    const failed = byKey(await engineItems(f), 'preview:failed')!;
    assert.equal(failed.actor, 'lead');
    assert.equal(failed.occurrenceId, 'PV-1');
  } finally {
    f.cleanup();
  }
});

test('Тексты отказов проходят маску секретов пакета передачи', async () => {
  const f = fixture();
  const secret = 'attention-secret-token-value-123';
  process.env.ATTENTION_TEST_TOKEN = secret;
  try {
    (f.h.config as unknown as { forge: unknown }).forge = { tokenEnv: 'ATTENTION_TEST_TOKEN' };
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('test')!;
    assert.equal(run.taskId, t.id);
    f.h.fail(run.id, run.token, `push refused with ${secret}`, false, 'gate');
    const card = byKey(await engineItems(f), `work:${t.id}`)!;
    assert.doesNotMatch(card.reason, new RegExp(secret));
  } finally {
    delete process.env.ATTENTION_TEST_TOKEN;
    f.cleanup();
  }
});

test('S7/S8 обращение к ведущему: исправление — версия, «нужен ответ» — оператору, ответ — новое появление', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    const service = new DiscussionService(f.h);
    const version = () => f.store.discussionVersion(undefined, t.id);
    let n = 0;
    const key = () => `attention-key-${++n}`;
    const request = service.post(
      {
        taskId: t.id,
        kind: 'change-request',
        text: 'Добавьте ночной режим',
        idempotencyKey: key(),
        expectedVersion: version(),
      },
      'operator',
    ).message;
    const crKey = `discussion:cr:${request.id}`;
    const first = byKey(await engineItems(f), crKey)!;
    assert.equal(first.actor, 'lead');
    assert.equal(first.occurrenceId, request.id);
    const repeat = byKey(await engineItems(f), crKey)!;
    assert.deepEqual([repeat.id, repeat.sourceVersion], [first.id, first.sourceVersion]);
    // Исправление необработанного обращения — та же карточка, новая версия.
    const corrected = service.post(
      {
        taskId: t.id,
        kind: 'change-request',
        text: 'Добавьте ночной и дневной режимы',
        supersedes: request.id,
        idempotencyKey: key(),
        expectedVersion: version(),
      },
      'operator',
    ).message;
    const updated = byKey(await engineItems(f), crKey)!;
    assert.equal(updated.id, first.id);
    assert.notEqual(updated.sourceVersion, first.sourceVersion);
    // Ведущему нужен ответ: карточка ведущего уходит, у оператора — вопрос.
    const disposition = service.resolve({
      requestId: corrected.id,
      outcome: 'needs-answer',
      reason: 'Какой режим по умолчанию?',
      idempotencyKey: key(),
      expectedVersion: version(),
    }).message;
    const asked = await engineItems(f);
    assert.equal(byKey(asked, crKey), undefined);
    const question = byKey(asked, `discussion:na:${request.id}`)!;
    assert.equal(question.actor, 'operator');
    assert.equal(question.category, 'question');
    assert.equal(question.occurrenceId, disposition.id);
    assert.ok(question.actions.some((a) => a.id === 'answer'));
    // Ответ оператора возвращает обращение ведущему новым появлением.
    service.post(
      {
        taskId: t.id,
        kind: 'note',
        text: 'Дневной по умолчанию',
        replyTo: disposition.id,
        idempotencyKey: key(),
        expectedVersion: version(),
      },
      'operator',
    );
    const reopened = await engineItems(f);
    assert.equal(byKey(reopened, `discussion:na:${request.id}`), undefined);
    const back = byKey(reopened, crKey)!;
    assert.equal(back.occurrenceId, disposition.id);
    assert.notEqual(back.id, first.id);
    service.resolve({
      requestId: corrected.id,
      outcome: 'rejected',
      reason: 'Вне объёма этой доски',
      idempotencyKey: key(),
      expectedVersion: version(),
    });
    assert.equal(byKey(await engineItems(f), crKey), undefined);
  } finally {
    f.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* S9, S17 (варианты), S18, S19                                        */
/* ------------------------------------------------------------------ */

test('S9 задание ведущего: упало — карточка, обновление плана — версия, повтор снимает, новый сбой — новое появление', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    f.h.addTask(b.id, input('Task one'));
    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex', maxAttempts: 3 });
    const key = `board:${b.id}`;
    assert.equal(byKey(await engineItems(f), key), undefined, 'живое задание — карточки нет');
    flow.fail(flow.claim(job.key, job.owner)!, 'review failed');
    const card = byKey(await engineItems(f), key)!;
    assert.equal(card.actor, 'lead');
    assert.equal(card.occurrenceId, `job:${job.key}:1`);
    assert.ok(card.actions.some((a) => a.kind === 'handoff'));
    const repeat = byKey(await engineItems(f, Date.now() + 3_600_000), key)!;
    assert.deepEqual([repeat.id, repeat.sourceVersion], [card.id, card.sourceVersion]);
    // План утверждён: цикл повтора сделает другое — то же появление, новая версия.
    f.h.approve(b.id);
    const updated = byKey(await engineItems(f), key)!;
    assert.equal(updated.id, card.id);
    assert.notEqual(updated.sourceVersion, card.sourceVersion);
    flow.retry(job.key, job.owner);
    assert.equal(byKey(await engineItems(f), key), undefined);
    flow.fail(flow.claim(job.key, job.owner)!, 'review failed again');
    const again = byKey(await engineItems(f), key)!;
    assert.equal(again.occurrenceId, `job:${job.key}:2`);
  } finally {
    f.cleanup();
  }
});

test('S9 свёртка: задание стоит на упавшей задаче — одна карточка задачи с доской', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input('Task one'));
    f.h.approve(b.id);
    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex', maxAttempts: 3 });
    failNext(f.h, t.id);
    flow.fail(flow.claim(job.key, job.owner)!, 'task failed');
    const items = await engineItems(f);
    assert.equal(byKey(items, `board:${b.id}`), undefined);
    const work = byKey(items, `work:${t.id}`)!;
    assert.deepEqual(work.impact.boards, [b.id]);
  } finally {
    f.cleanup();
  }
});

test('S17 preview: нет Docker — доступ оператора; потерянная версия — ведущему; новая выкладка снимает', async () => {
  const f = fixture();
  try {
    const record = (id: string, extra: Record<string, unknown>) => ({
      id,
      changeSetId: 'CS-1',
      verificationId: 'V-1',
      manifestDigest: 'm',
      policyDigest: 'p',
      release: 'r-' + id,
      project: 'dc-' + id,
      token: 't',
      leaseUntil: 0,
      active: false,
      startedAt: new Date().toISOString(),
      ...extra,
    });
    const set = (previews: unknown[]) =>
      f.store.change('fixture.preview', (s) => {
        s.previews = previews as typeof s.previews;
      });
    set([record('PV-1', { status: 'failed', failure: 'docker-unavailable', error: 'no docker' })]);
    const docker = byKey(await engineItems(f), 'preview:docker')!;
    assert.equal(docker.actor, 'operator');
    assert.equal(docker.category, 'access');
    assert.equal(docker.occurrenceId, 'PV-1');
    const repeat = byKey(await engineItems(f, Date.now() + 60_000), 'preview:docker')!;
    assert.deepEqual([repeat.id, repeat.sourceVersion], [docker.id, docker.sourceVersion]);
    // Healthy выкладка снимает отказ; потом она перестаёт отвечать.
    const healthy = record('PV-2', { status: 'healthy', url: 'http://127.0.0.1:1' });
    set([record('PV-1', { status: 'failed', failure: 'docker-unavailable' }), healthy]);
    const items = await engineItems(f);
    assert.equal(byKey(items, 'preview:docker'), undefined);
    assert.equal(byKey(items, 'preview:lost'), undefined);
    set([{ ...healthy, lost: 'health check timed out' }]);
    const lost = byKey(await engineItems(f), 'preview:lost')!;
    assert.equal(lost.actor, 'lead');
    assert.equal(lost.occurrenceId, 'PV-2');
    // Существенное обновление потерянной версии: другая причина.
    set([{ ...healthy, lost: 'container exited' }]);
    const updated = byKey(await engineItems(f), 'preview:lost')!;
    assert.equal(updated.id, lost.id);
    assert.notEqual(updated.sourceVersion, lost.sourceVersion);
    // Новая здоровая выкладка — потерянная уходит; потеря новой — новое появление.
    const next = record('PV-3', { status: 'healthy', url: 'http://127.0.0.1:1' });
    set([{ ...healthy, lost: 'container exited' }, next]);
    assert.equal(byKey(await engineItems(f), 'preview:lost'), undefined);
    set([
      { ...healthy, lost: 'container exited' },
      { ...next, lost: 'timeout' },
    ]);
    assert.equal(byKey(await engineItems(f), 'preview:lost')!.occurrenceId, 'PV-3');
  } finally {
    f.cleanup();
  }
});

test('S19 зависшая попытка при report: время простоя не меняет версию, движение снимает, новое зависание — новое появление', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input('Long migration'));
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('test')!;
    assert.equal(run.taskId, t.id);
    const { engine } = executionOf(f.h);
    const move = (state: 'active' | 'quiet' | 'stalled', previous: string, idleMs: number) => {
      const now = Date.now();
      const lastMovementAt = new Date(now - idleMs).toISOString();
      const activity = { kind: 'gate' as const, label: 'unit' };
      engine.liveness(
        run.id,
        run.token,
        {
          state,
          at: new Date(now).toISOString(),
          lastMovementAt,
          ...(state === 'active' ? {} : { activity, action: 'report' as const }),
        },
        {
          state,
          previous: previous as 'active',
          lastMovementAt,
          idleMs,
          ...(state === 'active' ? {} : { activity, action: 'report' as const }),
        },
      );
    };
    const key = `stall:${run.id}`;
    move('quiet', 'active', 4 * 60_000);
    assert.equal(byKey(await engineItems(f), key), undefined, 'тишина без report — не карточка');
    move('stalled', 'quiet', 12 * 60_000);
    const card = byKey(await engineItems(f), key)!;
    assert.equal(card.actor, 'operator');
    assert.equal(card.sourceVersion, 'stalled');
    const later = byKey(await engineItems(f, Date.now() + 3_600_000), key)!;
    assert.deepEqual([later.id, later.sourceVersion], [card.id, card.sourceVersion]);
    move('active', 'stalled', 0);
    assert.equal(byKey(await engineItems(f), key), undefined);
    await new Promise((r) => setTimeout(r, 5));
    move('stalled', 'active', 13 * 60_000);
    const again = byKey(await engineItems(f), key)!;
    assert.notEqual(again.occurrenceId, card.occurrenceId);
  } finally {
    f.cleanup();
  }
});

test('S18 версия корпуса ждёт оператора: карточка держит задачу, подтверждение снимает, новый запрос — новое появление', async () => {
  const f = fixture();
  try {
    f.h.config.gates = [propertyGate()];
    f.h.config.maxAttempts = 8;
    const corpus = new CheckCorpus(f.h);
    const c = f.h.contract(
      'Check contract',
      'Pinned independent check fixture.',
      undefined,
      undefined,
      undefined,
      undefined,
      declaration(),
    );
    const add = (title: string) => {
      const b = f.h.createBoard(title);
      const t = f.h.addTask(b.id, {
        ...input(title),
        contracts: [c.id],
        properties: ['knapsack-optimal'],
      });
      f.h.approve(b.id);
      return t.id;
    };
    const t1 = add('Corpus seed task');
    const ref = corpus.suiteFor(
      f.store.read().tasks.find((t) => t.id === t1)!,
      'knapsack-optimal',
    );
    const key = 'attention-corpus-case-1';
    const begun = corpus.begin(ref, key);
    const text = canonicalJson({ items: [{ w: 0, v: 5 }], cap: 0 });
    const recorded = corpus.record(
      corpus.get(ref.suite.id),
      key,
      begun.token!,
      {
        property: 'knapsack-optimal',
        input: text,
        inputHash: sha256(text),
        outcome: 'confirmed',
        reason: 'Deterministic confirmed fixture',
        source: { sha: 'a'.repeat(40), taskId: t1 },
        observed: { expected: '5', actual: '0', equal: false, repeats: 2, durationsMs: [1, 1] },
        origin: { kind: 'agent' },
      },
      () => 'b'.repeat(40),
      { tasks: [], actor: 'agent' },
    );
    if (recorded.pending) corpus.adopt(recorded.suite.id, recorded.pending.id);
    const suite = corpus.get(recorded.suite.id);
    f.h.config.approvalMode = 'operator';
    const request = async (taskId: string) =>
      (await new AgentService(f.h, f.root).run({
        operation: 'checks_adopt',
        input: {
          suiteId: suite.id,
          digest: suite.versions[0].digest,
          tasks: [taskId],
          reason: 'Агент запрашивает принятие в operator mode.',
        },
      })) as { pendingId: string; awaitingOperator: boolean };
    const t2 = add('Corpus adopting task');
    const first = await request(t2);
    assert.equal(first.awaitingOperator, true);
    const cardKey = `corpus:${suite.id}:${first.pendingId}`;
    const card = byKey(await engineItems(f), cardKey)!;
    assert.equal(card.actor, 'operator');
    assert.equal(card.occurrenceId, first.pendingId);
    assert.deepEqual(card.impact.taskIds, [t2]);
    assert.equal(byKey(await engineItems(f), `work:${t2}`), undefined);
    const repeat = byKey(await engineItems(f, Date.now() + 60_000), cardKey)!;
    assert.deepEqual([repeat.id, repeat.sourceVersion], [card.id, card.sourceVersion]);
    // Действие с карточки — то же подтверждение оператора, что CLI и панель.
    const service = new AttentionService(f.store, f.h);
    const done = await service.act({
      sourceKey: card.sourceKey,
      occurrenceId: card.occurrenceId,
      expectedVersion: card.sourceVersion,
      action: 'approve',
    });
    assert.equal(done.resolved, true);
    assert.equal(
      f.store.read().tasks.find((t) => t.id === t2)!.checkVersion?.digest,
      suite.versions[0].digest,
    );
    // Новый запрос принятия — новый предмет и появление (запрос неизменяем).
    const t3 = add('Corpus second task');
    const second = await request(t3);
    assert.notEqual(second.pendingId, first.pendingId);
    assert.ok(byKey(await engineItems(f), `corpus:${suite.id}:${second.pendingId}`));
  } finally {
    f.cleanup();
  }
});

test('S10 существенное обновление: исчерпание попыток меняет действие той же попытки — версия, не появление', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input('Root'));
    f.h.approve(b.id);
    const run = failNext(f.h, t.id);
    const key = `work:${t.id}`;
    const service = new AttentionService(f.store, f.h);
    const card = byKey((await service.active()).items, key)!;
    await service.mark({
      marks: [
        {
          sourceKey: key,
          occurrenceId: card.occurrenceId,
          version: card.sourceVersion,
          kind: 'ack',
        },
      ],
    });
    // Предел попыток понижен до сделанных: повтор больше не план, нужен сброс.
    f.h.config.maxAttempts = 1;
    const updated = byKey((await service.active()).items, key)!;
    assert.equal(updated.occurrenceId, run.id);
    assert.equal(updated.id, card.id);
    assert.notEqual(updated.sourceVersion, card.sourceVersion);
    assert.deepEqual(updated.state, { read: false, acknowledged: false, unread: true });
  } finally {
    f.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* Решение 8: повторное появление — новый факт источника               */
/* ------------------------------------------------------------------ */

test('S10 отменённый корень: зависимые сняты — решено; новая зависимая — новое появление', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const root = f.h.addTask(b.id, input('Root task'));
    const dep = f.h.addTask(b.id, input('Dependent task', [root.id]));
    f.h.approve(b.id);
    f.h.cancel(root.id, 'replanned', 'operator');
    const key = `work:${root.id}`;
    const service = new AttentionService(f.store, f.h);
    const card = byKey((await service.active()).items, key)!;
    assert.match(card.occurrenceId, /^cancelled:/);
    await service.mark({
      marks: [
        {
          sourceKey: key,
          occurrenceId: card.occurrenceId,
          version: card.sourceVersion,
          kind: 'ack',
        },
      ],
    });
    f.h.cancel(dep.id, 'replanned', 'operator');
    assert.equal(byKey((await service.active()).items, key), undefined);
    await new Promise((r) => setTimeout(r, 5));
    f.h.addTask(b.id, input('New dependent task', [root.id]));
    const again = byKey((await service.active()).items, key)!;
    assert.notEqual(again.occurrenceId, card.occurrenceId);
    assert.equal(again.state.unread, true);
  } finally {
    f.cleanup();
  }
});

test('S11 бюджет: предел поднят и возвращён тем же применением конфигурации — новое появление', async () => {
  const f = fixture();
  try {
    f.h.config.budgets = { workspace: { usd: 0.01 }, onUnknown: 'stop' };
    const b = f.h.createBoard('Board');
    f.h.addTask(b.id, input('Budget task'));
    f.h.approve(b.id);
    f.store.atomic(() =>
      f.store.saveLocal('usage', undefined, 'U1', {
        id: 'U1',
        stage: 'implementation',
        runtime: 'codex',
        model: 'fixture-model',
        runtimeVersion: null,
        startedAt: new Date().toISOString(),
        outcome: 'returned',
        promptBytes: 1,
        promptDigest: 'd'.repeat(64),
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reportedUsd: 1,
          complete: true,
          source: 'fixture',
        },
        costUsd: 1,
        costSource: 'provider-reported',
      }),
    );
    const apply = (at: string) =>
      f.store.change('fixture.config-applied', (s) => {
        s.appliedConfig = { digest: f.h.configDigest, at, by: 'fixture' };
      });
    apply('2026-01-01T00:00:00.000Z');
    const budget = async () =>
      (await new AttentionService(f.store, f.h).active()).items.find((i) => i.source === 'budget');
    const first = (await budget())!;
    const repeat = (await budget())!;
    assert.deepEqual([repeat.id, repeat.sourceVersion], [first.id, first.sourceVersion]);
    f.h.config.budgets = { workspace: { usd: 5 }, onUnknown: 'stop' };
    apply('2026-01-01T00:01:00.000Z');
    assert.equal(await budget(), undefined);
    // Откат к прежнему пределу: тот же предел, новый факт применения.
    f.h.config.budgets = { workspace: { usd: 0.01 }, onUnknown: 'stop' };
    apply('2026-01-01T00:02:00.000Z');
    const again = (await budget())!;
    assert.notEqual(again.occurrenceId, first.occurrenceId);
  } finally {
    f.cleanup();
  }
});

test('S9 вход задания не построить: ограничение — тот же отказ в той же ревизии остаётся прежним появлением', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    f.h.addTask(b.id, input('Task one'));
    f.h.approve(b.id);
    const key = `board:${b.id}`;
    const enable = () =>
      f.store.change('fixture.prep', (s) => {
        s.preparation = { id: 'workspace-preparation', changes: [] };
      });
    enable();
    const card = byKey(await engineItems(f), key)!;
    assert.match(card.reason, /would be refused/);
    assert.match(card.occurrenceId, /^input:r1:/);
    f.store.change('fixture.prep-off', (s) => {
      delete s.preparation;
    });
    assert.equal(byKey(await engineItems(f), key), undefined);
    // У отказа входа нет своего факта в журнале: тот же текст в той же ревизии
    // — прежнее появление (ограничение источника, названо в docs/attention.md).
    enable();
    assert.equal(byKey(await engineItems(f), key)!.occurrenceId, card.occurrenceId);
  } finally {
    f.cleanup();
  }
});

test('Маска секретов для любого источника: вопрос ведущего, сбой инспекции Git, ожидание', async () => {
  const leaked = 'https://deploy:s3cr3t-token@git.example.test/app.git';
  const f = preparationFixture();
  try {
    f.p.execute('preparation_question', {
      changeId: f.changeId,
      add: [{ text: `Можно ли использовать ${leaked} для зеркала?` }],
    });
    f.p.execute('preparation_quick', {
      requestKey: 'attention-mask-1',
      title: 'Быстрая правка',
      repository: '/nonexistent/attention-mask',
      brief: 'Исправить сложение отрицательных чисел',
      criterion: 'add(-2, -3) возвращает -5',
    });
    const view = await new AttentionService(f.store, undefined, {
      root: f.root,
      cachedFacts: () => Promise.reject(new Error(`fatal: could not read ${leaked}`)),
    }).active();
    const question = view.items.find((i) => i.source === 'prep-question')!;
    const connection = view.items.find((i) => i.sourceKey.endsWith(':connection'))!;
    for (const item of [question, connection]) {
      assert.doesNotMatch(item.reason + item.title, /s3cr3t-token/);
      assert.match(item.reason, /\[REDACTED\]@git\.example\.test/);
    }
    // Агентский список ведущего — та же маска.
    const agent = new AttentionService(f.store, undefined).agentList({ actor: 'operator' });
    assert.doesNotMatch(JSON.stringify(agent), /s3cr3t-token/);
  } finally {
    f.cleanup();
  }
  const e = fixture();
  const token = 'attention-config-secret-value-42';
  process.env.ATTENTION_MASK_TOKEN = token;
  try {
    (e.h.config as unknown as { forge: unknown }).forge = { tokenEnv: 'ATTENTION_MASK_TOKEN' };
    const b = e.h.createBoard('Board');
    e.h.addTask(b.id, input());
    e.h.approve(b.id);
    e.h.waitFor('context-lock', 'op-1', `Контекст закреплён: ${leaked} и ${token}`);
    const wait = byKey(await engineItems(e), 'wait:context-lock')!;
    assert.doesNotMatch(wait.reason, /s3cr3t-token/);
    assert.doesNotMatch(wait.reason, new RegExp(token));
  } finally {
    delete process.env.ATTENTION_MASK_TOKEN;
    e.cleanup();
  }
});

test('Карточка ведущего несёт передачу контекста и переход, доменных действий у неё нет', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    failNext(f.h, t.id);
    f.h.waitFor('context-lock', 'op-1', 'Контекст закреплён другой операцией');
    const items = await engineItems(f);
    const lead = items.filter((i) => i.actor === 'lead');
    assert.ok(lead.length >= 2);
    for (const item of lead) {
      assert.deepEqual(item.actions.map((a) => a.kind).sort(), ['handoff', 'navigate'], item.id);
      assert.equal(
        item.actions.some((a) => a.kind === 'domain'),
        false,
      );
    }
  } finally {
    f.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* Недостающие фазы: S16, S8, S13, S14                                 */
/* ------------------------------------------------------------------ */

test('S16 пять фаз: повтор, выкладка в preview — версия, новая проверка — появление, приёмка снимает', async () => {
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
    const verify = () => {
      const id = randomUUID();
      f.store.change('fixture.verified', (s) => {
        const cs = s.changeSets.find((x) => x.id === change.id)!;
        cs.verifications.push({
          id,
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
      return id;
    };
    const v1 = verify();
    const key = `changeset:${change.id}`;
    const card = byKey(await engineItems(f), key)!;
    const repeat = byKey(await engineItems(f, Date.now() + 60_000), key)!;
    assert.deepEqual([repeat.id, repeat.sourceVersion], [card.id, card.sourceVersion]);
    // Та же проверка выложена в preview: приёмка без выкладки — версия.
    f.store.change('fixture.preview', (s) => {
      s.previews = [
        {
          id: 'PV-1',
          changeSetId: change.id,
          verificationId: v1,
          manifestDigest: digest(manifest),
          policyDigest: 'p',
          release: 'r1',
          project: 'dc-r1',
          token: 't',
          leaseUntil: 0,
          status: 'unconfirmed',
          active: false,
          startedAt: new Date().toISOString(),
          url: 'http://127.0.0.1:45998',
        },
      ];
    });
    const onPreview = byKey(await engineItems(f), key)!;
    assert.equal(onPreview.id, card.id);
    assert.notEqual(onPreview.sourceVersion, card.sourceVersion);
    assert.equal(
      onPreview.actions.some((a) => a.id === 'deploy-preview'),
      false,
    );
    const v2 = verify();
    assert.equal(byKey(await engineItems(f), key)!.occurrenceId, v2);
    new Workspace(f.h).accept(change.id, { actor: 'operator' });
    assert.equal(byKey(await engineItems(f), key), undefined);
  } finally {
    f.cleanup();
  }
});

test('S8, S13, S14: существенное обновление при том же появлении', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    // S8: заметка в треде меняет версию вопроса оператору, не появление.
    const discussion = new DiscussionService(f.h);
    const version = () => f.store.discussionVersion(undefined, t.id);
    const request = discussion.post(
      {
        taskId: t.id,
        kind: 'change-request',
        text: 'Нужен ночной режим',
        idempotencyKey: 'attention-phase-1',
        expectedVersion: version(),
      },
      'operator',
    ).message;
    discussion.resolve({
      requestId: request.id,
      outcome: 'needs-answer',
      reason: 'Какой режим по умолчанию?',
      idempotencyKey: 'attention-phase-2',
      expectedVersion: version(),
    });
    const na = `discussion:na:${request.id}`;
    const asked = byKey(await engineItems(f), na)!;
    discussion.post(
      {
        taskId: t.id,
        kind: 'note',
        text: 'Уточнение ведущего',
        idempotencyKey: 'attention-phase-3',
        expectedVersion: version(),
      },
      'lead',
    );
    const asked2 = byKey(await engineItems(f), na)!;
    assert.equal(asked2.id, asked.id);
    assert.notEqual(asked2.sourceVersion, asked.sourceVersion);
    // S13: упавшая операция сохранена заново (версия записи) без новой остановки.
    const op = 'CC-' + randomUUID();
    const record = (version: number) => ({
      id: op,
      key: 'main:openapi',
      owner: 'main',
      status: 'failed',
      version,
      error: 'review rejected',
      held: [],
      startedAt: '2026-01-01T00:00:00.000Z',
      history: [{ at: '2026-01-01T00:01:00.000Z', step: 'review', event: 'failed' }],
    });
    const save = (value: unknown) =>
      f.store.atomic(() => f.store.saveLocal('contract-change', 'main', op, value));
    save(record(3));
    const cc = byKey(await engineItems(f), `contract-change:${op}`)!;
    save(record(4));
    const cc2 = byKey(await engineItems(f), `contract-change:${op}`)!;
    assert.equal(cc2.id, cc.id);
    assert.notEqual(cc2.sourceVersion, cc.sourceVersion);
    // S14: подробность ожидания изменилась при том же моменте ожидания.
    const at = new Date().toISOString();
    const setWait = (detail: string) =>
      f.store.change('fixture.wait', (s) => {
        s.waits = [{ kind: 'context-lock', detail, at, operation: 'op-1' }];
      });
    setWait('Контекст закреплён операцией A');
    const lock = byKey(await engineItems(f), 'wait:context-lock')!;
    setWait('Контекст закреплён операцией A; ждёт снятия');
    const lock2 = byKey(await engineItems(f), 'wait:context-lock')!;
    assert.equal(lock2.id, lock.id);
    assert.notEqual(lock2.sourceVersion, lock.sourceVersion);
  } finally {
    f.cleanup();
  }
});

test('Ссылки карточек ведут к предмету; у вопроса подготовки — полный текст и варианты под маской', async () => {
  const f = preparationFixture();
  try {
    f.p.execute('preparation_question', {
      changeId: f.changeId,
      stage: 'architecture',
      add: [
        {
          text: 'Где хранить историю? Зеркало https://u:s3cr3t@git.example.test/x.git тоже возможно.',
          why: 'Влияет на стоимость',
          options: ['Postgres', 'Файлы https://u:s3cr3t@files.example.test'],
        },
      ],
    });
    const items = (await new AttentionService(f.store, undefined).active()).items;
    const q = items.find((i) => i.source === 'prep-question')!;
    assert.match(q.subject.href, /stage=architecture#questions-architecture$/);
    const answer = q.actions.find((a) => a.id === 'answer') as {
      prompt?: string;
      choices?: { id: string; label: string }[];
    };
    assert.match(answer.prompt!, /Где хранить историю\?.*\n\nВлияет на стоимость/s);
    assert.doesNotMatch(JSON.stringify(answer), /s3cr3t/);
    assert.deepEqual(
      answer.choices!.map((c) => c.id),
      ['0', '1'],
    );
    assert.equal(answer.choices![0].label, 'Postgres');
  } finally {
    f.cleanup();
  }
  const e = fixture();
  try {
    const b = e.h.createBoard('Board');
    const t = e.h.addTask(b.id, input());
    e.h.approve(b.id);
    failNext(e.h, t.id);
    const discussion = new DiscussionService(e.h);
    const request = discussion.post(
      {
        taskId: t.id,
        kind: 'change-request',
        text: 'Нужен ночной режим',
        idempotencyKey: 'attention-link-1',
        expectedVersion: 0,
      },
      'operator',
    ).message;
    const items = await engineItems(e);
    const work = byKey(items, `work:${t.id}`)!;
    assert.equal(work.subject.href, `/?view=boards&tab=list&task=${t.id}`);
    const cr = byKey(items, `discussion:cr:${request.id}`)!;
    assert.equal(cr.subject.href, `/?view=boards&tab=list&task=${t.id}#dm-${request.id}`);
    assert.equal(cr.evidence[0].href, `/?view=boards&tab=list&task=${t.id}#dm-${request.id}`);
    const disposition = discussion.resolve({
      requestId: request.id,
      outcome: 'needs-answer',
      reason: 'Какой режим?',
      idempotencyKey: 'attention-link-2',
      expectedVersion: e.store.discussionVersion(undefined, t.id),
    }).message;
    const na = byKey(await engineItems(e), `discussion:na:${request.id}`)!;
    assert.match(na.subject.href, new RegExp(`#dm-${disposition.id}$`));
    assert.ok(na.evidence.every((ev) => ev.href?.includes('#dm-')));
  } finally {
    e.cleanup();
  }
});

test('Карточки ведущего по подготовке тоже несут передачу, команда — настоящая', async () => {
  const f = preparationFixture();
  try {
    f.p.execute('preparation_product', {
      changeId: f.changeId,
      expectedDigest: null,
      reason: 'Постановка',
      content: product,
    });
    const view = f.p.status(f.changeId);
    if (!view.enabled) throw new Error('preparation');
    const digest = view.current!.product!.digest;
    f.p.execute('preparation_submit', {
      changeId: f.changeId,
      stage: 'product',
      expectedDigest: digest,
    });
    f.p.decide({
      changeId: f.changeId,
      stage: 'product',
      expectedDigest: digest,
      decision: 'request-changes',
      comment: 'Добавьте ночную модерацию',
    });
    const items = (await new AttentionService(f.store, undefined, { root: f.root }).active()).items;
    const rework = byKey(items, `prep:rework:${f.changeId}:product`)!;
    assert.deepEqual(rework.actions.map((a) => a.kind).sort(), ['handoff', 'navigate']);
    const command = (rework.actions.find((a) => a.kind === 'handoff') as { command: string })
      .command;
    assert.match(command, /preparation_status/);
    assert.ok(command.includes(f.root), 'команда называет workspace');
  } finally {
    f.cleanup();
  }
  const e = fixture();
  try {
    const b = e.h.createBoard('Board');
    const t = e.h.addTask(b.id, input());
    e.h.approve(b.id);
    failNext(e.h, t.id);
    const work = byKey(await engineItems(e), `work:${t.id}`)!;
    const command = (work.actions.find((a) => a.kind === 'handoff') as { command: string }).command;
    assert.match(command, /devcontour session-handoff --workspace \S+/);
    assert.doesNotMatch(command, /…/);
  } finally {
    e.cleanup();
  }
});
