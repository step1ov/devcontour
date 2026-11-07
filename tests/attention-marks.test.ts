import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AttentionService,
  ATTENTION_NAMESPACE,
  markState,
  withOccurrence,
} from '../src/application/attention.ts';
import { DiscussionService } from '../src/application/discussion.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import type { AttentionItem } from '../src/core/attention-model.ts';
import { budgetOverview } from '../src/harness/budget.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { byKey } from './attention-fixture.ts';
import { fixture, input, removeTestCheckoutRoot } from './helpers.ts';

// D04-B: отметки «прочитано» и «увидел» не меняют предметную область.
// D04-D (отметки): после перезапуска список и отметки те же.

/** Все строки базы, кроме отметок центра внимания и счётчика ревизий. */
function domainDump(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    // Таблица локальных записей создаётся первой записью: её отсутствие — пусто.
    const out: Record<string, unknown> = { local_workflow: [] };
    for (const { name } of tables) {
      if (name === 'revision') continue;
      const rows = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() as {
        namespace?: string;
      }[];
      out[name] =
        name === 'local_workflow' ? rows.filter((r) => r.namespace !== ATTENTION_NAMESPACE) : rows;
    }
    return JSON.stringify(out);
  } finally {
    db.close();
  }
}

const mark = (item: AttentionItem, kind: 'read' | 'ack', version = item.sourceVersion) => ({
  sourceKey: item.sourceKey,
  occurrenceId: item.occurrenceId,
  version,
  kind,
});

test('D04-B: отметки на карточках разных источников не меняют задачу, паузу, план, обсуждение и журнал', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const root = f.h.addTask(b.id, input('Root task'));
    const other = f.h.addTask(b.id, input('Other task'));
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('test')!;
    assert.equal(run.taskId, root.id);
    f.h.fail(run.id, run.token, 'fixture failure', false, 'gate');
    f.h.pause(true);
    const discussion = new DiscussionService(f.h);
    const request = discussion.post(
      {
        taskId: other.id,
        kind: 'change-request',
        text: 'Нужен ночной режим',
        idempotencyKey: 'attention-mark-1',
        expectedVersion: 0,
      },
      'operator',
    ).message;
    discussion.resolve({
      requestId: request.id,
      outcome: 'needs-answer',
      reason: 'Какой режим по умолчанию?',
      idempotencyKey: 'attention-mark-2',
      expectedVersion: f.store.discussionVersion(undefined, other.id),
    });
    f.h.config.approvalMode = 'operator';
    f.h.addTask(b.id, input('Draft task'));
    const service = new AttentionService(f.store, f.h);
    const view = await service.active();
    const sources = new Set(view.items.map((i) => i.source));
    for (const s of ['work', 'queue', 'plan', 'discussion-needs-answer'] as const)
      assert.ok(sources.has(s), s);
    const path = join(f.root, 'state.sqlite');
    const before = domainDump(path);
    const events = f.store.lastEventId();
    const state = JSON.stringify(f.store.read());
    const budgets = JSON.stringify(budgetOverview(f.h) ?? null);
    const jobs = JSON.stringify(new LeadWorkflow(f.h).view());
    const result = await service.mark({
      marks: view.items.flatMap((i, n) => [mark(i, n % 2 ? 'ack' : 'read')]),
    });
    assert.equal(result.marked.length, view.items.length);
    assert.deepEqual(result.ignored, []);
    assert.equal(domainDump(path), before);
    assert.equal(f.store.lastEventId(), events, 'отметка не пишет событие журнала');
    assert.equal(JSON.stringify(f.store.read()), state);
    assert.equal(JSON.stringify(budgetOverview(f.h) ?? null), budgets);
    assert.equal(JSON.stringify(new LeadWorkflow(f.h).view()), jobs);
    // Увиденная, но нерешённая карточка остаётся в списке.
    const after = await service.active();
    assert.deepEqual(
      after.items.map((i) => i.id),
      view.items.map((i) => i.id),
    );
    assert.ok(after.items.every((i) => i.state.read && !i.state.unread));
    assert.ok(after.items.filter((_, n) => n % 2).every((i) => i.state.acknowledged));
    assert.ok(after.items.filter((_, n) => !(n % 2)).every((i) => !i.state.acknowledged));
    assert.equal(after.counts.unread, 0);
  } finally {
    f.cleanup();
  }
});

test('Отметка старой версии и исчезнувшего появления; существенное обновление снова непрочитано', async () => {
  const f = fixture();
  try {
    f.h.config.approvalMode = 'operator';
    const b = f.h.createBoard('Board');
    f.h.addTask(b.id, input('One task'));
    const service = new AttentionService(f.store, f.h);
    const key = `plan:${b.id}`;
    const shown = byKey((await service.active()).items, key)!;
    assert.equal(shown.state.unread, true);
    await service.mark({ marks: [mark(shown, 'ack')] });
    const seen = byKey((await service.active()).items, key)!;
    assert.deepEqual(seen.state, { read: true, acknowledged: true, unread: false });
    // Существенное обновление: прочитанное и «увидел» относятся к прежней версии.
    f.h.addTask(b.id, input('Two task'));
    const updated = byKey((await service.active()).items, key)!;
    assert.equal(updated.id, shown.id);
    assert.deepEqual(updated.state, { read: false, acknowledged: false, unread: true });
    // Вторая вкладка отмечает старую версию: текущая остаётся непрочитанной.
    await service.mark({ marks: [mark(shown, 'read')] });
    assert.equal(byKey((await service.active()).items, key)!.state.unread, true);
    // Текущая версия прочитана; запоздалая отметка старой её не отменяет.
    await service.mark({ marks: [mark(updated, 'read')] });
    await service.mark({ marks: [mark(updated, 'read', shown.sourceVersion)] });
    assert.equal(byKey((await service.active()).items, key)!.state.read, true);
    // Исчезнувшее появление: отметка не хранится.
    const result = await service.mark({
      marks: [{ sourceKey: key, occurrenceId: 'r9:none', version: 'x', kind: 'read' }],
    });
    assert.equal(result.ignored.length, 1);
    // Решено и возникло снова: новое появление непрочитано.
    f.h.approve(b.id);
    f.h.addTask(b.id, input('Three task'));
    const again = byKey((await service.active()).items, key)!;
    assert.notEqual(again.occurrenceId, shown.occurrenceId);
    assert.equal(again.state.unread, true);
  } finally {
    f.cleanup();
  }
});

test('D04-D: после перезапуска список и отметки те же; старые отметки исчезнувших карточек удаляются', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    f.h.addTask(b.id, input('Root task'));
    f.h.approve(b.id);
    f.h.pause(true);
    const service = new AttentionService(f.store, f.h);
    const view = await service.active();
    await service.mark({ marks: view.items.map((i) => mark(i, 'ack')) });
    const marked = await service.active();
    f.store.close();
    const store = new Store(join(f.root, 'state.sqlite'));
    try {
      const h = new DevContour(store, f.h.config);
      const reopened = await new AttentionService(store, h).active();
      assert.deepEqual(
        reopened.items.map((i) => [i.id, i.sourceVersion, i.state]),
        marked.items.map((i) => [i.id, i.sourceVersion, i.state]),
      );
      // Пауза снята — карточки нет; через 31 день отметка удаляется при записи.
      h.pause(false);
      const later = Date.now() + 31 * 24 * 60 * 60_000;
      assert.equal(
        Object.keys(store.localRecords(ATTENTION_NAMESPACE, undefined)).includes('queue'),
        true,
      );
      await new AttentionService(store, h, { now: () => later }).mark({
        marks: [{ sourceKey: 'queue', occurrenceId: 'gone', version: 'x', kind: 'read' }],
      });
      assert.equal(
        Object.keys(store.localRecords(ATTENTION_NAMESPACE, undefined)).includes('queue'),
        false,
      );
    } finally {
      store.close();
    }
  } finally {
    // Хранилище fixture закрыто перезапуском выше: каталоги удаляются здесь.
    rmSync(f.root, { recursive: true, force: true });
    removeTestCheckoutRoot(f.h.config.checkoutRoot!);
  }
});

test('Отметка активной карточки старше 30 дней не удаляется при записи других отметок', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input('Root task'));
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('test')!;
    assert.equal(run.taskId, t.id);
    f.h.fail(run.id, run.token, 'fixture failure', false, 'gate');
    f.h.pause(true);
    const service = new AttentionService(f.store, f.h);
    const queue = byKey((await service.active()).items, 'queue')!;
    await service.mark({ marks: [mark(queue, 'ack')] });
    // Через 31 день карточка паузы всё ещё активна; отмечается другая карточка.
    const later = new AttentionService(f.store, f.h, {
      now: () => Date.now() + 31 * 24 * 60 * 60_000,
    });
    const work = byKey((await later.active()).items, `work:${t.id}`)!;
    await later.mark({ marks: [mark(work, 'read')] });
    assert.ok(
      Object.keys(f.store.localRecords(ATTENTION_NAMESPACE, undefined)).includes('queue'),
      'отметка активной карточки осталась',
    );
    const after = byKey((await later.active()).items, 'queue')!;
    assert.deepEqual(after.state, { read: true, acknowledged: true, unread: false });
  } finally {
    f.cleanup();
  }
});

test('Предел 2000 строк: запись сверх него удаляет сначала отсутствующие предметы до 1900, отметки активных карточек остаются', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input('Root task'));
    f.h.approve(b.id);
    f.h.pause(false);
    const run = f.h.claim('test')!;
    assert.equal(run.taskId, t.id);
    f.h.fail(run.id, run.token, 'fixture failure', false, 'gate');
    f.h.pause(true);
    let full = 0;
    const service = new AttentionService(f.store, f.h, {
      sources: [{ id: 'preview', collect: () => (full++, []) }],
    });
    const items = (await service.active()).items;
    const queue = byKey(items, 'queue')!;
    const work = byKey(items, `work:${t.id}`)!;
    await service.mark({ marks: [mark(queue, 'ack')] });
    // 1999 свежих отметок предметов, которых больше нет: до предела ровно.
    const at = new Date().toISOString();
    f.store.atomic(() => {
      for (let i = 0; i < 1999; i++)
        f.store.saveLocal(ATTENTION_NAMESPACE, undefined, `prep:q:gone:${i}`, {
          v: 1,
          occurrenceId: 'o',
          readVersion: 'v',
          readAt: new Date(Date.parse(at) - (2000 - i) * 1000).toISOString(),
        });
    });
    const rows = () => Object.keys(f.store.localRecords(ATTENTION_NAMESPACE, undefined));
    assert.equal(rows().length, 2000);
    full = 0;
    // Новая отметка переходит предел: удаление до 1900, отсутствующие первыми.
    await service.mark({ marks: [mark(work, 'read')] });
    const after = rows();
    assert.equal(after.length, 1900);
    assert.ok(after.includes('queue'), 'отметка активной карточки осталась');
    assert.ok(after.includes(work.sourceKey));
    assert.ok(!after.includes('prep:q:gone:0'), 'самые старые отсутствующие удалены');
    assert.ok(full > 0, 'на пределе пересчитаны все источники');
    // Ниже предела следующая запись полного пересчёта не делает.
    full = 0;
    await service.mark({ marks: [mark(work, 'ack')] });
    assert.equal(full, 0);
    assert.equal(byKey((await service.active()).items, 'queue')!.state.acknowledged, true);
  } finally {
    f.cleanup();
  }
});

test('История двух появлений: отметки прежнего появления сохраняются после отметки нового', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Board');
    const t = f.h.addTask(b.id, input('Flaky'));
    f.h.approve(b.id);
    const service = new AttentionService(f.store, f.h);
    const key = `work:${t.id}`;
    const fail = () => {
      f.h.pause(false);
      const run = f.h.claim('test')!;
      assert.equal(run.taskId, t.id);
      f.h.fail(run.id, run.token, 'fixture failure', false, 'gate');
      return run;
    };
    const run1 = fail();
    // Строка прежнего вида — одно появление без `earlier` — читается.
    const first = byKey((await service.active()).items, key)!;
    f.store.atomic(() =>
      f.store.saveLocal(ATTENTION_NAMESPACE, undefined, key, {
        v: 1,
        occurrenceId: run1.id,
        readVersion: first.sourceVersion,
        readAt: new Date().toISOString(),
      }),
    );
    assert.equal(byKey((await service.active()).items, key)!.state.read, true);
    f.h.retry(t.id);
    const run2 = fail();
    const second = byKey((await service.active()).items, key)!;
    assert.equal(second.occurrenceId, run2.id);
    assert.equal(second.state.unread, true, 'новое появление не прочитано');
    await service.mark({ marks: [mark(second, 'ack')] });
    f.h.retry(t.id);
    fail();
    const history = service.history().items.filter((i) => i.sourceKey === key);
    const byRun = new Map(history.map((i) => [i.occurrenceId, i.state]));
    assert.deepEqual(byRun.get(run1.id), { read: true, acknowledged: false, unread: false });
    assert.deepEqual(byRun.get(run2.id), { read: true, acknowledged: true, unread: false });
    // Одна строка на предмет: прежние появления — внутри неё, в пределе.
    const rows = f.store.localRecords<{ earlier?: { occurrenceId: string }[] }>(
      ATTENTION_NAMESPACE,
      undefined,
    );
    assert.deepEqual(
      rows[key].earlier?.map((e) => e.occurrenceId),
      [run1.id],
    );
    for (let i = 0; i < 6; i++) {
      await service.mark({ marks: [mark(byKey((await service.active()).items, key)!, 'read')] });
      f.h.retry(t.id, { reason: 'fixture: next occurrence' });
      fail();
    }
    assert.equal(
      f.store.localRecords<{ earlier?: unknown[] }>(ATTENTION_NAMESPACE, undefined)[key].earlier
        ?.length,
      4,
      'хранятся последние 5 появлений',
    );
  } finally {
    f.cleanup();
  }
});

test('Вернувшееся прежнее появление продолжает свою отметку', () => {
  let row = withOccurrence(undefined, 'a');
  row.readVersion = 'va';
  row = withOccurrence(row, 'b');
  row.readVersion = 'vb';
  row = withOccurrence(row, 'a');
  assert.equal(row.occurrenceId, 'a');
  assert.deepEqual(markState(row, 'a', 'va'), { read: true, acknowledged: false, unread: false });
  assert.deepEqual(markState(row, 'b', 'vb'), { read: true, acknowledged: false, unread: false });
  assert.deepEqual(
    row.earlier?.map((e) => e.occurrenceId),
    ['b'],
  );
});
