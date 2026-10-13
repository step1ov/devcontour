import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { largeHistory, type HistoryShape } from './large-history.ts';
import { Store } from '../src/core/store.ts';
import { DevContour } from '../src/core/service.ts';
import { loadConfig } from '../src/runner/config.ts';
import { input } from './helpers.ts';
import {
  panelChangeSet,
  panelContract,
  panelContractAttempts,
  panelContractAttemptFindings,
  panelEvents,
  panelRecoveryHistory,
  panelRevision,
  panelQueue,
  panelRun,
  panelRuns,
  panelSummary,
  panelTask,
  panelTaskSearch,
  type PanelSummary,
} from '../src/application/panel.ts';
import { taskChecks } from '../src/application/checks.ts';

/**
 * Проекции панели на настоящей большой истории (учебное демо, размноженное):
 * периодическая сводка ограничена и не несёт тел истории, а детали приходят
 * по запросу страницами.
 */
async function history(shape: HistoryShape) {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-panel-'));
  await largeHistory(join(root, 'data'), shape);
  const store = new Store(join(root, 'data', 'state.sqlite'));
  const h = new DevContour(store, loadConfig(join(root, 'data', 'config.json')));
  return {
    root,
    store,
    h,
    summary: (query: Record<string, string> = {}) =>
      panelSummary(h, join(root, 'data'), query) as PanelSummary,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
/** Предел строки диагностики в проекциях (вместе с маркером обрезки). */
const DIAGNOSTIC_MAX = 2000;
const small: HistoryShape = {
  copies: 4,
  failedAttempts: 4,
  events: 500,
  changeSets: 6,
  verifications: 3,
};

test('The polled summary is bounded, carries no history bodies and does not grow with finished attempts, checks and events', async () => {
  const a = await history(small);
  const b = await history({ ...small, failedAttempts: 12, events: 5000, verifications: 9 });
  try {
    const sa = a.summary();
    const sb = b.summary();
    // Другая история той же формы досок: больше отказавших попыток, проверок
    // ChangeSet и событий. Размер сводки от этого не зависит.
    assert.ok(b.store.read().runs.length > a.store.read().runs.length * 2);
    assert.ok(bytes(sb) < bytes(sa) * 1.1, `${bytes(sb)} vs ${bytes(sa)}`);
    const text = JSON.stringify(sb);
    // Тела истории — только в деталях.
    assert.equal(text.includes('step 39: fixture assertion output'), false, 'логи не в сводке');
    assert.equal(text.includes('Fixture finding'), false, 'findings не в сводке');
    for (const c of sb.changeSets)
      for (const v of c.verifications) {
        assert.equal('tasks' in v, false);
        assert.ok(v.taskCount > 0);
        for (const e of v.evidence) assert.equal(e.log, '');
      }
    for (const r of sb.runs) assert.equal('token' in r, false);
    // Попытки — только активные и последняя по каждой задаче сводки.
    const ids = new Set(sb.tasks.map((t) => t.id));
    assert.ok(sb.runs.every((r) => r.status === 'active' || ids.has(r.taskId)));
    assert.ok(
      sb.runs.length <= sb.tasks.length + sb.runs.filter((r) => r.status === 'active').length,
    );
    // Доски — компактными строками; списки задач — только у выбранной.
    assert.ok(sb.boards.every((x) => x.revisions.every((r) => r.taskIds.length === 0)));
    assert.ok(sb.board!.revisions.at(-1)!.taskIds.length > 0);
    assert.ok(sb.events.length <= 40);
  } finally {
    a.close();
    b.close();
  }
});

test('Doubling the boards grows the summary only by compact board and change set lines', async () => {
  const a = await history(small);
  const b = await history({ ...small, copies: small.copies * 2, changeSets: small.changeSets * 2 });
  try {
    const sa = a.summary();
    const sb = b.summary();
    const extraBoards = sb.boards.length - sa.boards.length;
    const extraChanges = sb.changeSets.length - sa.changeSets.length;
    const perBoard = bytes(sb.boards) / sb.boards.length;
    const perChange = bytes(sb.changeSets) / sb.changeSets.length;
    const growth = bytes(sb) - bytes(sa);
    assert.ok(perBoard < 1500, `строка доски ${perBoard}`);
    assert.ok(
      growth <= extraBoards * perBoard * 1.2 + extraChanges * perChange * 1.2 + 2000,
      `рост ${growth}`,
    );
    // Задачи сводки — выбранная доска и текущая работа, а не все задачи.
    assert.ok(sb.tasks.length < b.store.read().tasks.length / 2);
  } finally {
    a.close();
    b.close();
  }
});

test('An unchanged revision answers with the number only; lease renewals do not count as changes', async () => {
  const d = await history({ ...small, copies: 1 });
  try {
    const first = d.summary();
    const same = panelSummary(d.h, d.root, { revision: first.revision });
    assert.deepEqual(same, { revision: first.revision, unchanged: true });
    assert.ok(bytes(same) < 1024);
    // Продление lease не меняет видимых данных.
    d.h.leader('panel-probe');
    assert.equal(String(d.store.revision()), first.revision);
    // Видимое изменение — новая ревизия и полный ответ.
    d.h.pause(false);
    const next = panelSummary(d.h, d.root, { revision: first.revision }) as PanelSummary;
    assert.notEqual(next.revision, first.revision);
    assert.equal(next.paused, false);
  } finally {
    d.close();
  }
});

test('Details arrive on request: task with attempt pages, run with log tails, change set history, contract text, event pages, task search', async () => {
  const d = await history(small);
  try {
    const state = d.store.read();
    const busy = state.tasks.find((t) => state.runs.filter((r) => r.taskId === t.id).length >= 5)!;
    const detail = panelTask(d.h, busy.id, { limit: '2' });
    assert.equal(detail.task.id, busy.id);
    assert.equal(detail.runs.total, 5);
    assert.equal(detail.runs.items.length, 2);
    assert.equal(detail.runs.next, 2);
    // Новые сначала; страницы не пересекаются и покрывают всё.
    const rest = panelRuns(d.h, busy.id, { limit: '50', cursor: '2' });
    const all = [...detail.runs.items, ...rest.items].map((r) => r.attempt);
    assert.deepEqual(all, [5, 4, 3, 2, 1]);
    assert.equal(rest.next, null);
    assert.throws(() => panelRuns(d.h, busy.id, { limit: '51' }), /51|too_big|less than/i);
    const run = panelRun(d.h, detail.runs.items[1].id);
    assert.equal(run.token, '');
    for (const e of run.evidence) assert.ok(e.log.length <= 4001);
    // ChangeSet: последняя проверка в строке, прежние — страницей, снимок задач
    // только по явному запросу.
    const change = state.changeSets[0];
    const c = panelChangeSet(d.h, change.id, { limit: '2' });
    assert.equal(c.history.total, small.verifications);
    assert.equal(c.history.items.length, 2);
    // Снимок задач — только адресно, по проверке; в истории его нет.
    assert.ok(c.history.items.every((v) => !('tasks' in v) && v.taskCount > 0));
    const withTasks = panelChangeSet(d.h, change.id, {
      verification: change.verifications.at(-1)!.id,
    });
    assert.ok(withTasks.snapshot!.items.length > 0);
    assert.equal(panelContract(d.h, state.contracts[0].id).content, state.contracts[0].content);
    const events = panelEvents(d.h, { limit: '30' });
    assert.equal(events.items.length, 30);
    const older = panelEvents(d.h, { limit: '30', before: String(events.next) });
    assert.ok(older.items.every((e) => e.id < events.next!));
    const found = panelTaskSearch(d.h, { q: 'копия 2', limit: '5' });
    assert.ok(found.items.length > 0 && found.items.every((t) => t.title.includes('копия 2')));
    assert.throws(() => panelTask(d.h, 'T-missing', {}), /не найдена/);
  } finally {
    d.close();
  }
});

test('P-F01: recent events, change sets and their details carry no contract texts, tokens or snapshots', async () => {
  const d = await history({ ...small, copies: 1, events: 0 });
  try {
    const secret = 'CONTRACT-BODY-'.repeat(4000);
    d.h.contract('Large contract', secret);
    d.h.pause(false);
    d.store.change('fixture.verification', (s) => {
      const v = s.changeSets[0].verifications.at(-1)!;
      v.token = 'verification-token-7';
      s.changeSets[0].deliveries = [
        {
          id: 'D-1',
          token: 'delivery-token-7',
          verificationId: v.id,
          status: 'delivered',
          startedAt: v.startedAt,
          leaseUntil: 0,
          components: {},
        } as never,
      ];
      return { verification: v, contract: secret, token: 'event-token-7' };
    });
    const summary = d.summary();
    const text = JSON.stringify(summary);
    assert.ok(Buffer.byteLength(text) < 256 * 1024, String(Buffer.byteLength(text)));
    for (const leaked of [
      'CONTRACT-BODY-',
      'verification-token-7',
      'delivery-token-7',
      'event-token-7',
    ])
      assert.equal(text.includes(leaked), false, leaked);
    assert.ok(summary.events.every((e) => Object.keys(e).sort().join() === 'at,id,type'));
    const change = panelChangeSet(d.h, summary.changeSets[0].id, {});
    const details = JSON.stringify(change);
    assert.equal(details.includes('verification-token-7'), false);
    assert.equal(details.includes('delivery-token-7'), false);
    const events = JSON.stringify(panelEvents(d.h, { limit: '10' }));
    assert.equal(events.includes('CONTRACT-BODY-'), false);
    assert.equal(events.includes('event-token-7'), false);
    assert.ok(Buffer.byteLength(events) < 64 * 1024);
  } finally {
    d.close();
  }
});

test('P-F01: long diagnostics written by runner and gates stay bounded in the summary and in every detail', async () => {
  const d = await history({ ...small, copies: 1, events: 0 });
  try {
    const long = (marker: string) => marker + 'x'.repeat(300000);
    const state = d.store.read();
    const busy = state.tasks.find((t) => state.runs.some((r) => r.taskId === t.id))!;
    // Запись — отказ scheduler: его событие несёт текст ошибки для stopReason.
    d.store.change('scheduler.error', (s) => {
      for (const c of s.changeSets) {
        const v = c.verifications.at(-1)!;
        v.error = long('VERIFICATION-ERROR');
        v.impact = { note: long('IMPACT') } as never;
        for (const e of v.evidence) e.summary = long('WORKSPACE-SUMMARY');
        c.deliveries = [
          {
            id: 'D-' + c.id,
            token: 't',
            verificationId: v.id,
            manifestDigest: 'm',
            policyDigest: 'p',
            status: 'failed',
            startedAt: v.startedAt,
            leaseUntil: 0,
            error: long('DELIVERY-ERROR'),
            components: {
              main: { sha: 'a', sourceBranch: 'b', tree: 'c', state: 'pending', url: long('URL') },
            },
          },
        ];
      }
      const task = s.tasks.find((t) => t.id === busy.id)!;
      task.status = 'failed';
      task.failure = long('TASK-FAILURE');
      task.hold = { operation: 'probe', reason: long('HOLD-REASON') };
      const run = s.runs.findLast((r) => r.taskId === busy.id)!;
      run.error = long('RUN-ERROR');
      for (const e of run.evidence) {
        e.summary = long('EVIDENCE-SUMMARY');
        e.findings = Array.from({ length: 100 }, () => ({
          severity: 'major',
          message: 'FINDING' + 'x'.repeat(5000),
        }));
      }
      s.contractAttempts = [
        {
          id: 'CA-1',
          at: run.startedAt,
          summary: long('ATTEMPT'),
          findings: Array.from({ length: 1000 }, (_, k) => ({
            severity: 'major',
            message: `FINDING-${k} ` + 'x'.repeat(400),
          })),
        } as never,
      ];
      s.changeSets[0].description = 'CHANGESET-DESCRIPTION ' + 'd'.repeat(5000);
      // Договор с 30 обязательствами проверки: тела — только в деталях.
      s.contracts.push({
        ...s.contracts[0],
        id: 'C-obligations',
        checks: {
          obligations: Array.from({ length: 30 }, (_, k) => ({
            property: `p-${k}`,
            promise: 'OBLIGATION-BODY ' + 'o'.repeat(15000),
          })),
        },
      } as never);
      // 650 содержательных отказов по свойству: история карточки проверки.
      for (let k = 0; k < 650; k++)
        s.runs.push({
          ...structuredClone(run),
          id: `R-history-${k}`,
          evidence: [],
          properties: ['p-0'],
          unboundProperties: [`unbound-${k}`],
          error: 'PROPERTY-FAILURE ' + 'f'.repeat(300),
        });
      // 55 корректировок другой, принятой доски с длинными причинами.
      const other = s.boards.find((b) => !b.revisions.some((r) => r.taskIds.includes(busy.id)))!;
      const last = other.revisions.at(-1)!;
      for (let k = 0; k < 55; k++)
        other.revisions.push({
          ...structuredClone(last),
          number: last.number + k + 1,
          reason: `REVISION-REASON-${k} ` + 'r'.repeat(5000),
        });
      // Эпизод восстановления с длинной причиной и тысячей записей истории.
      task.recovery = {
        id: 'REC-1',
        property: 'p-0',
        basis: 'b',
        runs: [],
        openedAt: run.startedAt,
        status: 'awaiting-user',
        calls: 1,
        reason: long('RECOVERY-REASON'),
        history: Array.from({ length: 1000 }, (_, k) => ({
          at: run.startedAt,
          event: `decision-${k}`,
          detail: 'HISTORY ' + 'h'.repeat(300),
        })),
        version: 1,
      } as never;
      // Очередь остановлена отказом scheduler с длинным текстом ошибки.
      s.paused = true;
      s.pauseReason = 'runtime';
      return { error: long('SCHEDULER-ERROR') };
    });
    d.store.projectionError = long('PROJECTION-ERROR');
    const limit = 256 * 1024;
    // Выбрана доска задачи; доска с длинной историей ревизий — чужая.
    const own = d.store
      .read()
      .boards.find((b) => b.revisions.some((r) => r.taskIds.includes(busy.id)))!;
    const summary = d.summary({ task: busy.id, board: own.id });
    assert.ok(bytes(summary) < limit, `сводка ${bytes(summary)}`);
    const text = JSON.stringify(summary);
    assert.equal(text.includes('x'.repeat(DIAGNOSTIC_MAX + 2)), false);
    assert.equal(text.includes('IMPACT'), false);
    assert.ok(summary.stopReason?.startsWith('SCHEDULER-ERROR'));
    assert.equal(text.includes('OBLIGATION-BODY'), false);
    // Строка чужой доски — только текущая ревизия; причина — целиком в деталях.
    assert.equal(text.includes('REVISION-REASON-0 '), false);
    const otherLine = summary.boards.find((b) => b.revisionCount > 50)!;
    assert.equal(otherLine.revisions.length, 1);
    assert.ok(otherLine.revisions[0].reasonTruncated);
    const revision = panelRevision(d.h, otherLine.id, otherLine.revisions[0].number);
    assert.ok(revision.reason.startsWith('REVISION-REASON-54 ') && revision.reason.length > 5000);
    // Выбранная доска с той же историей: ранние причины короче, свежие — до 2000.
    const selected = d.summary({ board: otherLine.id });
    assert.ok(bytes(selected) < limit, `выбранная доска ${bytes(selected)}`);
    assert.equal(summary.contracts.find((x) => x.id === 'C-obligations')!.obligationCount, 30);
    // История эпизода: последние записи со счётчиком, остальные — страницами.
    const detail = panelTask(d.h, busy.id, { limit: '1' });
    assert.equal(detail.task.recovery!.historyCount, 1000);
    assert.equal(detail.task.recovery!.history.length, 20);
    // Страницы истории — по стабильному курсору: новая запись между
    // страницами не даёт дублей.
    const first = panelRecoveryHistory(d.h, busy.id, { limit: '20' });
    assert.equal(first.items[0].event, 'decision-999');
    d.store.change('fixture.recovery-append', (s) => {
      s.tasks
        .find((t) => t.id === busy.id)!
        .recovery!.history.push({ at: '2026-01-01T00:00:00.000Z', event: 'decision-1000' });
    });
    const second = panelRecoveryHistory(d.h, busy.id, {
      limit: '50',
      before: String(first.nextBefore),
    });
    assert.equal(second.total, 1001);
    assert.equal(second.items[0].event, 'decision-979');
    assert.ok(bytes(second) < limit);
    const checks = taskChecks(d.h, { taskId: busy.id, limit: 1, cursor: 0 });
    assert.ok(bytes(checks) < 64 * 1024, `checks ${bytes(checks)}`);
    assert.equal(checks.history.counts['p-0'], 650);
    assert.equal(checks.history.byProperty['p-0'].length, 10);
    assert.equal(checks.history.unboundCount, 650);
    assert.equal(JSON.stringify(checks).includes('x'.repeat(DIAGNOSTIC_MAX + 2)), false);
    assert.ok(summary.journalError?.startsWith('PROJECTION-ERROR'));
    // Описание ChangeSet сокращено с признаком, целиком — в деталях.
    const changeSet = summary.changeSets.find((x) => x.descriptionTruncated)!;
    assert.ok(changeSet.description.length <= DIAGNOSTIC_MAX + 1);
    assert.equal(
      panelChangeSet(d.h, changeSet.id, { limit: '1' }).description,
      d.store.read().changeSets.find((x) => x.id === changeSet.id)!.description,
    );
    // Находки попытки ревью: первые со счётчиком, остальные — страницами.
    const review = panelContractAttempts(d.h, { limit: '1' });
    assert.ok(bytes(review) < 64 * 1024, `ревью ${bytes(review)}`);
    assert.equal(review.items[0].findingsCount, 1000);
    assert.equal(review.items[0].findings.length, 20);
    const pageOf = panelContractAttemptFindings(d.h, 'CA-1', { limit: '50', cursor: '20' });
    assert.equal(pageOf.total, 1000);
    assert.equal(pageOf.items.length, 50);
    assert.ok(pageOf.items[0].message.startsWith('FINDING-20 '));
    assert.equal(pageOf.next, 70);
    assert.ok(bytes(pageOf) < limit);
    assert.throws(() => panelContractAttemptFindings(d.h, 'CA-missing', {}), /не найдена/);
    const c = d.store.read().changeSets[0];
    for (const [name, value] of [
      ['задача', panelTask(d.h, busy.id, { limit: '50' })],
      ['попытки', panelRuns(d.h, busy.id, { limit: '50' })],
      ['попытка', panelRun(d.h, d.store.read().runs.findLast((r) => r.taskId === busy.id)!.id)],
      [
        'ChangeSet',
        panelChangeSet(d.h, c.id, { limit: '50', verification: c.verifications[0].id }),
      ],
      ['ревью', panelContractAttempts(d.h, { limit: '50' })],
    ] as const) {
      assert.ok(bytes(value) < limit, `${name} ${bytes(value)}`);
      assert.equal(JSON.stringify(value).includes('x'.repeat(DIAGNOSTIC_MAX + 2)), false, name);
    }
  } finally {
    d.close();
  }
});

test('P-F03/P-F12: lease renewals keep the summary number and the parsed cache; after the shown expiry the summary carries the renewed lease', async () => {
  const d = await history({ ...small, copies: 1 });
  try {
    const now = Date.now();
    d.store.change('fixture.operation', (s) => {
      const v = s.changeSets[0].verifications.at(-1)!;
      v.status = 'active';
      v.leaseUntil = now + 400;
    });
    const first = d.summary();
    assert.equal(first.expiresAt, now + 400);
    const cached = d.store.readShared(() => false).state;
    // Продление lease операции, heartbeat лидера и попытки: номер тот же,
    // ответ короткий, разобранное состояние не перечитывается.
    d.store.change('heartbeat', (s) => {
      s.changeSets[0].verifications.at(-1)!.leaseUntil = now + 60000;
    });
    d.h.leader('panel-probe');
    for (let i = 0; i < 3; i++) {
      d.h.leader('panel-probe');
      assert.deepEqual(panelSummary(d.h, d.root, { revision: first.revision }), {
        revision: first.revision,
        unchanged: true,
      });
    }
    assert.equal(d.store.readShared(() => false).state, cached);
    // После показанного срока клиент берёт сводку целиком: в ней продлённый
    // lease, а не снятая блокировка.
    while (Date.now() <= now + 400) await new Promise((r) => setTimeout(r, 20));
    const renewed = d.summary();
    assert.equal(renewed.revision, first.revision);
    assert.equal(renewed.expiresAt, now + 60000);
    // Истёкший lease срока не даёт: опрос не становится полным навсегда.
    d.store.change('fixture.operation-expired', (s) => {
      s.changeSets[0].verifications.at(-1)!.leaseUntil = Date.now() - 1;
    });
    assert.equal(d.summary().expiresAt, undefined);
    // Без кэш-подсказки (обычное чтение) продление lease видно сразу.
    d.store.change('heartbeat', (s) => {
      s.changeSets[0].verifications.at(-1)!.leaseUntil = now + 90000;
    });
    assert.equal(
      d.store.readShared().state.changeSets[0].verifications.at(-1)!.leaseUntil,
      now + 90000,
    );
  } finally {
    d.close();
  }
});

test('P-F17: a lease renewed by another process while the summary snapshot was open is not shown as released', async () => {
  const d = await history({ ...small, copies: 1 });
  const writer = new Store(join(d.root, 'data', 'state.sqlite'));
  try {
    const now = Date.now();
    d.store.change('fixture.operation', (s) => {
      const v = s.changeSets[0].verifications.at(-1)!;
      v.status = 'active';
      v.leaseUntil = now + 300;
    });
    // Снимок сводки открыт до продления; разбор идёт уже после старого срока.
    const inside = d.store.snapshot(() => {
      d.store.version();
      writer.change('heartbeat', (s) => {
        s.changeSets[0].verifications.at(-1)!.leaseUntil = now + 60000;
      });
      while (Date.now() <= now + 300);
      return d.summary();
    });
    assert.equal(inside.expiresAt, undefined, 'старый снимок видит только старый срок');
    // Опрос с номером этого ответа не получает «без изменений»: блокировка
    // действует, и номер другой. Полный ответ несёт продлённый lease.
    const next = panelSummary(d.h, d.root, { revision: inside.revision }) as PanelSummary;
    assert.notEqual(next.revision, inside.revision);
    assert.equal(next.expiresAt, now + 60000);
    // Дальнейшие продления номер не меняют.
    writer.change('heartbeat', (s) => {
      s.changeSets[0].verifications.at(-1)!.leaseUntil = now + 90000;
    });
    assert.deepEqual(panelSummary(d.h, d.root, { revision: next.revision }), {
      revision: next.revision,
      unchanged: true,
    });
  } finally {
    writer.close();
    d.close();
  }
});

test('P-F17: a lease that expires while the summary parses and was renewed meanwhile is never shown released', async () => {
  const d = await history({ ...small, copies: 1 });
  const writer = new Store(join(d.root, 'data', 'state.sqlite'));
  try {
    const now = Date.now();
    d.store.change('fixture.operation', (s) => {
      const v = s.changeSets[0].verifications.at(-1)!;
      v.status = 'active';
      v.leaseUntil = now + 300;
    });
    // Снимок сводки уже открыт; пока разбирается состояние, другой процесс
    // продлевает lease, а старый срок истекает.
    const store = d.store as unknown as { readUnlocked(): unknown };
    const original = store.readUnlocked.bind(d.store);
    let raced = false;
    store.readUnlocked = () => {
      if (!raced) {
        raced = true;
        writer.change('heartbeat', (s) => {
          s.changeSets[0].verifications.at(-1)!.leaseUntil = now + 60000;
        });
        while (Date.now() <= now + 300);
      }
      return original();
    };
    const summary = d.summary();
    assert.ok(raced);
    assert.equal(summary.expiresAt, now + 60000, 'блокировка не мигает снятой');
    assert.match(summary.revision, /\.1$/);
  } finally {
    writer.close();
    d.close();
  }
});

test('P-F13: a nested read inside a snapshot works with component storage', () => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-panel-components-'));
  try {
    const locations = ['product', 'library'].map((id) => {
      const path = join(root, id);
      mkdirSync(path);
      return { id, path };
    });
    const store = new Store(join(root, 'state.sqlite'), locations);
    try {
      const value = store.snapshot(() => ({
        state: store.read(),
        shared: store.readShared().state,
        revision: store.revision(),
      }));
      assert.equal(value.state.version, 1);
      assert.equal(value.shared.version, 1);
      assert.equal(typeof value.revision, 'number');
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P-F04/P-F05: task search spans boards and knows replacements; the queue pages all boards; the workspace graph keeps dependencies on accepted boards', async () => {
  const d = await history(small);
  try {
    const state = d.store.read();
    const accepted = state.boards.find((b) => b.revisions.at(-1)!.status === 'accepted')!;
    const done = accepted.revisions.at(-1)!.taskIds[0];
    const b = d.h.createBoard('Depends on accepted');
    const draft = d.h.addTask(b.id, { ...input('Uses accepted result'), dependsOn: [done] });
    const other = d.h.createBoard('Another draft board');
    const remote = d.h.addTask(other.id, input('Remote draft'));
    // Поиск находит задачу другой доски и отмечает заменённые.
    const found = panelTaskSearch(d.h, { q: 'Remote draft' });
    assert.equal(found.items[0].id, remote.id);
    assert.equal(found.items[0].boardId, other.id);
    // Очередь — по всем доскам, с черновиками.
    const queue = panelQueue(d.h, { limit: '50' });
    assert.ok(queue.items.some((t) => t.id === remote.id));
    assert.ok(queue.items.some((t) => t.id === draft.id));
    assert.equal(
      queue.total,
      d.store
        .read()
        .tasks.filter(
          (t) =>
            !['done', 'cancelled'].includes(t.status) &&
            !['running', 'verifying', 'reviewing', 'integrating'].includes(t.status),
        ).length,
    );
    // Общий граф: зависимость от принятой доски видна, принятые целиком — по запросу.
    const graph = d.summary({ view: 'workspace' });
    assert.ok(graph.workspaceTaskIds!.includes(draft.id));
    assert.ok(graph.workspaceTaskIds!.includes(done));
    assert.ok(graph.acceptedBoards > 0);
    const all = d.summary({ view: 'workspace', accepted: '1' });
    assert.ok(all.workspaceTaskIds!.length > graph.workspaceTaskIds!.length);
  } finally {
    d.close();
  }
});

test('P-F06/P-F07/P-F08/P-F09: attempt pages use a stable cursor, any verification snapshot is addressable, event pages stay within 50 and review attempts are paged with a total', async () => {
  const d = await history(small);
  try {
    const state = d.store.read();
    const busy = state.tasks.find((t) => state.runs.filter((r) => r.taskId === t.id).length >= 5)!;
    const head = panelRuns(d.h, busy.id, { limit: '2' });
    // Новая попытка появляется после загрузки первой страницы.
    d.store.change('fixture.new-run', (s) => {
      const last = s.runs.findLast((r) => r.taskId === busy.id)!;
      s.runs.push({ ...structuredClone(last), id: 'R-new', attempt: 6 });
    });
    const older = panelRuns(d.h, busy.id, { limit: '50', before: head.nextBefore! });
    const seen = [...head.items, ...older.items].map((r) => r.attempt);
    assert.deepEqual(seen, [5, 4, 3, 2, 1], 'без потерь и повторов');
    // Снимок задач прежней проверки.
    const change = state.changeSets[0];
    const previous = change.verifications[0];
    const c = panelChangeSet(d.h, change.id, { verification: previous.id, taskLimit: '2' });
    assert.equal(c.snapshot!.verificationId, previous.id);
    assert.equal(c.snapshot!.total, previous.tasks.length);
    assert.ok(c.snapshot!.items.length > 0 && c.snapshot!.items.length <= 2);
    assert.throws(() => panelEvents(d.h, { limit: '51' }));
    // Попытки ревью: в сводке — счётчик и последние без находок, все — страницами.
    d.store.change('fixture.attempts', (s) => {
      s.contractAttempts = Array.from({ length: 25 }, (_, i) => ({
        id: 'CA-' + i,
        at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        subject: 'contract',
        attempt: i + 1,
        title: 'Review ' + i,
        approved: i === 24,
        summary: 'fixture',
        findings: [{ severity: 'major', message: 'finding ' + i }],
        artifact: 'a',
        authorRuntime: 'codex',
        reviewerRuntime: 'claude',
      }));
    });
    const summary = d.summary();
    assert.equal(summary.contractAttemptCount, 25);
    assert.equal(summary.contractAttempts.length, 20);
    assert.equal(JSON.stringify(summary.contractAttempts).includes('finding '), false);
    const first = panelContractAttempts(d.h, { limit: '20' });
    const rest = panelContractAttempts(d.h, { limit: '20', cursor: '20' });
    assert.equal(first.total, 25);
    assert.deepEqual(
      [...first.items, ...rest.items].map((a) => a.id),
      Array.from({ length: 25 }, (_, i) => 'CA-' + (24 - i)),
    );
  } finally {
    d.close();
  }
});

test('P-F10/P-F11: the shared state is frozen, a rolled back write does not stay cached, and the summary number belongs to its data', async () => {
  const d = await history({ ...small, copies: 1 });
  try {
    const shared = d.store.readShared().state;
    assert.throws(() => {
      (shared.tasks[0] as { title: string }).title = 'MUTATED';
    }, TypeError);
    assert.notEqual(d.store.read().tasks[0].title, 'MUTATED');
    const before = d.store.read().tasks[0].title;
    assert.throws(() =>
      d.store.atomic(() => {
        d.store.change('fixture.rollback', (s) => {
          s.tasks[0].title = 'ROLLED BACK';
        });
        assert.equal(d.store.readShared().state.tasks[0].title, 'ROLLED BACK');
        throw new Error('rollback');
      }),
    );
    d.store.change('fixture.commit', (s) => {
      s.tasks[1].title = 'COMMITTED';
    });
    const after = d.store.readShared().state;
    assert.equal(after.tasks[0].title, before);
    assert.equal(after.tasks[1].title, 'COMMITTED');
    // Запись другого соединения между запросом и чтением: номер и данные — из
    // одного снимка.
    const other = new Store(join(d.root, 'data', 'state.sqlite'));
    try {
      const original = d.store.readShared.bind(d.store);
      let injected = false;
      d.store.readShared = () => {
        if (!injected) {
          injected = true;
          other.change('fixture.concurrent', (s) => {
            s.boards[0].title = 'CONCURRENT';
          });
        }
        return original();
      };
      const summary = d.summary();
      const revision = Number(summary.revision.split('.')[0]);
      assert.equal(revision, d.store.revision());
      assert.ok(summary.boards.some((b) => b.title === 'CONCURRENT'));
    } finally {
      other.close();
    }
  } finally {
    d.close();
  }
});
