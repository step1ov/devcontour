import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DiscussionService } from '../src/application/discussion.ts';
import { Preparation } from '../src/core/preparation.ts';
import { Store } from '../src/core/store.ts';
import { dataDoctor, doctorState, newStateCheck, newStateInventory } from '../src/runner/doctor.ts';
import { markQuickSetup } from '../src/runner/quick.ts';
import { fixture, input } from './helpers.ts';

// Опись записей, которых не знает выпуск 0.4.0-alpha.17: doctor называет
// каждую, версию-читателя и откат копией, но готовность не снимает.

const EMPTY = {
  quickIntakes: 0,
  setupProposals: 0,
  expansions: 0,
  discussions: 0,
  standIns: 0,
  rulings: 0,
  attentionMarks: 0,
  inputRequests: 0,
  openInputRequests: 0,
  quickSetupMarks: 0,
};

const found = (checks: { id: string; status: string; detail: string }[]) => {
  const check = checks.find((c) => c.id === 'compat:new-state');
  assert.ok(check, 'проверка compat:new-state есть');
  return check;
};

test('compat:new-state: без новых записей — passed и ничего не перечисляет', () => {
  const f = fixture();
  try {
    const store = new Store(join(f.root, 'state.sqlite'), undefined, false, undefined, true);
    try {
      assert.deepEqual(newStateInventory(store, store.read(), f.root), EMPTY);
    } finally {
      store.close();
    }
    const check = newStateCheck(EMPTY);
    assert.equal(check.status, 'passed');
    assert.match(check.detail, /нет$/);
    assert.doesNotMatch(check.detail, /Откат/);
    const data = dataDoctor(f.h.config, f.root);
    assert.equal(data.compatible, true);
    assert.deepEqual(found(data.checks), check);
    assert.deepEqual(doctorState(f.h.config, f.root).newState, check);
  } finally {
    f.cleanup();
  }
});

test('compat:new-state: каждая запись новой версии названа с читателем и откатом, без отказа', () => {
  const f = fixture();
  try {
    const board = f.h.createBoard('Board');
    const task = f.h.addTask(board.id, input('Task with a thread')).id;
    f.h.approve(board.id);
    const discussion = new DiscussionService(f.h);
    const note = discussion.post(
      {
        taskId: task,
        kind: 'note',
        text: 'Первая заметка',
        idempotencyKey: 'compat-note-1',
        expectedVersion: 0,
      },
      'operator',
    );
    discussion.post(
      {
        taskId: task,
        kind: 'change-request',
        text: 'Нужен ночной режим',
        idempotencyKey: 'compat-request-1',
        expectedVersion: note.version,
      },
      'operator',
    );
    new Preparation(f.store, 'operator').execute('preparation_quick', {
      requestKey: 'compat-quick-1',
      title: 'Quick change',
      repository: f.root,
      brief: 'Add a footer link to the docs page.',
      criterion: 'The footer shows the link.',
    });
    const quick = { changeId: f.store.read().preparation!.activeChangeId! };
    f.store.atomic(() =>
      f.store.change('fixture.quick', (s) => {
        const c = s.preparation!.changes.find((x) => x.id === quick.changeId)!;
        c.setup = [
          {
            number: 1,
            digest: 'a'.repeat(64),
            createdAt: new Date().toISOString(),
            profile: 'npm-project',
            reason: 'Fixture proposal',
          },
        ];
        c.expanded = { at: new Date().toISOString(), reason: 'Fixture switch to the full route' };
      }),
    );
    markQuickSetup(f.root, quick.changeId, 'a'.repeat(64));
    f.store.atomic(() => {
      f.store.saveLocal('attention', undefined, 'board:B1', { v: 1, occurrenceId: 'o1' });
      f.store.saveLocal('input-requests', undefined, 'IR-' + '1'.repeat(24), {
        lifecycle: 'pending',
      });
      f.store.saveLocal('input-requests', undefined, 'IR-' + '2'.repeat(24), {
        lifecycle: 'applied',
      });
    });
    const store = new Store(join(f.root, 'state.sqlite'), undefined, false, undefined, true);
    let inventory;
    try {
      inventory = newStateInventory(store, store.read(), f.root);
    } finally {
      store.close();
    }
    assert.deepEqual(inventory, {
      quickIntakes: 1,
      setupProposals: 1,
      expansions: 1,
      discussions: 2,
      standIns: 0,
      rulings: 0,
      attentionMarks: 1,
      inputRequests: 2,
      openInputRequests: 1,
      quickSetupMarks: 1,
    });
    const check = newStateCheck(inventory);
    assert.equal(check.status, 'passed');
    for (const expected of [
      /быстрый маршрут: поручений 1, предложений setup 1, переходов на полный маршрут 1 — читает DevContour после 0\.4\.0-alpha\.17 с движком 0\.1\.0-alpha\.36 и новее; 0\.4\.0-alpha\.17 строгой схемой отклоняет запись состояния, Git sync записи подготовки/,
      /обсуждения задач: сообщений 2 — .*движком 0\.1\.0-alpha\.36.*после отката обсуждения не видны, после повторного обновления видны снова/,
      /отметки центра внимания: 1 — .*движком 0\.1\.0-alpha\.37/,
      /вопросы исполнителя: запросов 2, открытых 1 — .*движком 0\.1\.0-alpha\.37/,
      /отметка quick-setup\.json каталога данных: изменений 1 — .*в backup не входит/,
      /Откат к 0\.4\.0-alpha\.17 — восстановлением копии .*снятой до обновления/,
    ])
      assert.match(check.detail, expected);
    // Обе формы doctor показывают ту же опись и не снимают готовность.
    const data = dataDoctor(f.h.config, f.root);
    assert.deepEqual(found(data.checks), check);
    assert.deepEqual(doctorState(f.h.config, f.root).newState, check);
  } finally {
    f.cleanup();
  }
});

test('compat:new-state: решения за владельца и решения владельца названы с последствиями отката', () => {
  const f = fixture();
  try {
    const board = f.h.createBoard('Board');
    const task = f.h.addTask(board.id, input());
    const d = new DiscussionService(f.h);
    const posted = d.post(
      {
        taskId: task.id,
        kind: 'stand-in',
        text: 'Решение',
        standIn: { question: 'Вопрос', impact: 'Влияние' },
        idempotencyKey: 'doctor-si-1',
        expectedVersion: 0,
      },
      'lead',
    );
    d.rule(
      {
        messageId: posted.message.id,
        ruling: 'reversed',
        text: 'Иначе',
        idempotencyKey: 'doctor-si-2',
        expectedVersion: posted.version,
      },
      'operator',
    );
    const store = new Store(join(f.root, 'state.sqlite'), undefined, false, undefined, true);
    let inventory;
    try {
      inventory = newStateInventory(store, store.read(), f.root);
    } finally {
      store.close();
    }
    assert.equal(inventory.standIns, 1);
    assert.equal(inventory.rulings, 1);
    assert.match(
      newStateCheck(inventory).detail,
      /решения за владельца: 1, решений владельца по ним 1 — .*discussion_inbox, session_handoff и весь центр внимания/,
    );
  } finally {
    f.cleanup();
  }
});
