import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SignalInbox } from '../src/core/signals.ts';
import { Store } from '../src/core/store.ts';
import { Harness } from '../src/core/service.ts';
import { fixture, config, input, complete } from './helpers.ts';

const observation = (changes = {}) => ({
  source: 'corporate-ci',
  eventId: 'job-42-failed',
  incidentId: 'chat-regression',
  repositoryId: 'main',
  observedAt: '2026-01-01T10:00:00.000Z',
  state: 'open',
  title: 'Chat regression',
  summary: 'An API contract test fails for the chat library.',
  evidenceUrl: 'https://ci.example.invalid/jobs/42',
  ...changes,
});

test('Signals deduplicate transactionally, reject changed event payloads and never accept resolved work', () => {
  const f = fixture();
  try {
    const inbox = new SignalInbox(f.h),
      event = observation();
    const first = inbox.ingest(event),
      duplicate = inbox.ingest(event);
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(first.taskIds, duplicate.taskIds);
    assert.equal(f.store.read().tasks.length, 1);
    assert.throws(
      () => inbox.ingest({ ...event, summary: 'A different observation with the same event id.' }),
      /другим содержимым/,
    );
    inbox.ingest(
      observation({
        eventId: 'job-42-resolved',
        state: 'resolved',
        observedAt: '2026-01-01T11:00:00.000Z',
      }),
    );
    assert.equal(f.store.read().tasks[0].status, 'draft');
    assert.equal(f.store.read().runs.length, 0);
    assert.equal(inbox.ingest(observation({ eventId: 'old-delivery' })).action, 'out-of-order');
    f.h.config.signalPolicy.maxActionsPerHour = 1;
    assert.throws(
      () => inbox.ingest(observation({ eventId: 'another-event', incidentId: 'another-incident' })),
      /Лимит/,
    );
    assert.equal(inbox.list('main').length, 3, 'Rejected rate-limited event leaves no receipt');
    assert.equal(f.store.read().tasks.length, 1);
  } finally {
    f.cleanup();
  }
});

test('An incident on an accepted board creates a correction and retains its snapshot', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Accepted component', '', 'main'),
      task = f.h.addTask(b.id, input());
    f.h.approve(b.id);
    complete(f.h, task.id);
    f.h.accept(b.id, 'merged');
    const snapshot = f.store.read().boards[0].revisions[0].snapshot!.digest;
    const inbox = new SignalInbox(f.h);
    const result = inbox.ingest(observation({ boardId: b.id, roots: [task.id] }));
    assert.equal(result.action, 'corrected');
    assert.equal(f.store.read().boards[0].revisions[0].snapshot!.digest, snapshot);
    assert.equal(f.store.read().tasks.at(-1)!.status, 'draft');
    assert.equal(f.store.read().tasks.at(-1)!.supersedes, task.id);
    assert.equal(inbox.ingest(observation({ boardId: b.id, roots: [task.id] })).duplicate, true);
    assert.equal(f.store.read().boards[0].revisions.length, 2);
  } finally {
    f.cleanup();
  }
});

test('Component incident bodies and event receipts stay out of coordinator SQLite', () => {
  const f = fixture();
  const repo = join(f.root, 'library');
  mkdirSync(repo);
  const path = join(f.root, 'coordinator.sqlite');
  const local = new Store(path, [{ id: 'main', path: repo }]);
  try {
    const h = new Harness(local, config({ repository: repo, storage: 'component' }));
    const inbox = new SignalInbox(h);
    inbox.ingest(
      observation({ summary: 'PRIVATE_LIBRARY_DIAGNOSIS is stored only in the library.' }),
    );
    const db = new DatabaseSync(path);
    try {
      for (const table of ['state', 'events', 'objects', 'local_workflow']) {
        if (db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(table))
          assert.ok(
            !JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()).includes(
              'PRIVATE_LIBRARY_DIAGNOSIS',
            ),
          );
      }
    } finally {
      db.close();
    }
    assert.equal(inbox.list('main').length, 1);
    assert.deepEqual(local.localRecords('signals'), {});
  } finally {
    local.close();
    f.cleanup();
  }
});
