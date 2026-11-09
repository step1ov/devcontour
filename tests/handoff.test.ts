// Пакет передачи контекста новой сессии ведущего агента: операция `session_handoff`
// и CLI `session-handoff` отдают пакет harness (`handoffPack`) над движком
// DevContour; вложенные чтения пакета идут одним снимком хранилища.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  stat,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handoffPackSchema, type HandoffPack } from 'devcontour-harness/contracts';
import { MERGED, complete, config, fixture, input } from './helpers.ts';
import { AgentService, capabilities } from '../src/application/agent.ts';
import { DevContour, specDigest } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { DomainError, repositorySchema, type Config } from '../src/core/model.ts';
import { LeadRunner } from '../src/runner/lead-workflow.ts';
import { loopAhead } from '../src/runner/lead-outlook.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { BASE_HELD_DETAIL } from '../src/runner/base-check.ts';
import { DevContourExecutionStore } from '../src/harness/store.ts';
import { projectionOptions } from '../src/harness/host.ts';
import {
  AGENT_HANDOFF_BYTES,
  HANDOFF_FULL_HINT,
  devcontourHandoff,
  devcontourHandoffWithin,
  handoffRedactor,
  handoffResponse,
  type DevContourHandoff,
} from '../src/application/handoff.ts';
import { command } from '../src/runner/process.ts';

const INTENT = 'Okapi intention: finish the payment board before the release';

/**
 * Две выпущенные доски (задача принята, задача упала) и черновая; с `job` —
 * действующее задание ведущего по доске B.
 */
function boards(h: DevContour, options: { job?: boolean } = {}) {
  const a = h.createBoard('Board A', '', 'main');
  const done = h.addTask(a.id, input('Accepted task')).id;
  const failed = h.addTask(a.id, input('Failing task')).id;
  h.approve(a.id);
  const b = h.createBoard('Board B', '', 'main');
  const other = h.addTask(b.id, input('Other board task')).id;
  h.approve(b.id);
  const draft = h.createBoard('Draft board', '', 'main');
  h.addTask(draft.id, input('Draft task'));
  complete(h, done);
  h.pause(false);
  const run = h.claim(h.store.read().leader?.owner ?? 'test')!;
  h.fail(run.id, run.token, 'gate failed: expected 2, got 3', false, 'gate');
  h.pause(true);
  if (options.job)
    new LeadWorkflow(h).start({ kind: 'board', id: b.id, authorRuntime: 'codex', maxAttempts: 3 });
  return { a: a.id, b: b.id, draft: draft.id, done, failed, other, failedTask: run.taskId };
}

type Host = DevContourHandoff['host'];
type JsonHandoff = {
  format: 'json';
  pack: HandoffPack;
  host: Host;
  commands: Record<string, string>;
  full?: string;
};
type MdHandoff = {
  format: 'md';
  markdown: string;
  host: Host;
  commands: Record<string, string>;
  full?: string;
};

/**
 * Логическое содержимое базы — все таблицы, в том числе локальные записи и
 * строка роли controller, — и байты файлов базы и журнала.
 */
function dbFingerprint(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const rows = tables.map((t) => [
      t.name,
      db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all(),
    ]);
    const files = [file, file + '-wal'].map((f) =>
      existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : 'missing',
    );
    return createHash('sha256').update(JSON.stringify({ rows, files })).digest('hex');
  } finally {
    db.close();
  }
}
const status = (e: unknown) => (e as { status?: number }).status;

test('session_handoff: в каталоге только чтения со схемой входа; JSON по схеме harness, ничего не пишет', () => {
  const tool = capabilities().tools.find((t) => t.name === 'session_handoff')!;
  assert.ok(tool, 'операция session_handoff в каталоге');
  assert.equal(tool.readOnly, true);
  assert.match(tool.description, /new lead session/);
  assert.match(tool.description, /Read-only, no model calls/);
  const schema = tool.inputSchema as { properties: Record<string, unknown> };
  assert.deepEqual(Object.keys(schema.properties).sort(), ['boardId', 'format', 'intentions']);
  const f = fixture();
  try {
    const ids = boards(f.h, { job: true });
    const agent = new AgentService(f.h, f.root);
    const events = f.store.lastEventId();
    const revision = f.store.revision();
    const before = dbFingerprint(join(f.root, 'state.sqlite'));
    const value = agent.execute({
      operation: 'session_handoff',
      input: {},
    }) as unknown as JsonHandoff;
    agent.execute({ operation: 'session_handoff', input: { format: 'md', boardId: ids.a } });
    assert.equal(value.format, 'json');
    const pack = handoffPackSchema.parse(value.pack);
    assert.equal(pack.handoffVersion, 1);
    assert.equal(pack.graphId, undefined);
    assert.equal(pack.summary.works, 4, 'черновые задачи не выпущены и в пакет не входят');
    assert.ok(pack.works.some((w) => w.id === ids.failedTask && w.status === 'failed'));
    assert.ok(pack.works.some((w) => w.id === ids.other));
    assert.ok(!pack.works.some((w) => w.id === ids.done), 'принятая задача не открыта');
    assert.ok(pack.failures.some((x) => x.workId === ids.failedTask));
    assert.ok(pack.queue.paused);
    assert.deepEqual(Object.keys(value.commands).sort(), ['harness resume', 'harness run']);
    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 65536);
    assert.equal(f.store.lastEventId(), events, 'операция ничего не пишет в журнал');
    assert.equal(f.store.revision(), revision, 'операция не меняет документ');
    assert.equal(
      dbFingerprint(join(f.root, 'state.sqlite')),
      before,
      'база, локальные записи и роль controller прежние',
    );
    assert.equal(value.full, undefined, 'пакет уложился в предел: подсказки нет');
    assert.deepEqual(value.host.liveBoards, [ids.b], 'задание доски B действует');
  } finally {
    f.cleanup();
  }
});

test('session_handoff: намерения по правилу пакета — пробелы сняты, пустые отброшены, длинные усечены; Markdown', () => {
  const f = fixture();
  try {
    boards(f.h);
    const agent = new AgentService(f.h, f.root);
    const json = agent.execute({
      operation: 'session_handoff',
      input: { intentions: [INTENT, '  second  ', '   ', ''] },
    }) as unknown as JsonHandoff;
    assert.deepEqual(handoffPackSchema.parse(json.pack).intentions, [INTENT, 'second']);
    const long = agent.execute({
      operation: 'session_handoff',
      input: { intentions: ['x'.repeat(1001)] },
    }) as unknown as JsonHandoff;
    assert.equal(long.pack.intentions[0].length, 1001, '1000 знаков и «…»');
    assert.ok(long.pack.intentions[0].endsWith('…'));
    assert.equal(long.pack.truncated.intentions, 1);
    // Пустые не считаются: 20 непустых и пустая — в пределе.
    const twenty = Array.from({ length: 20 }, (_, i) => 'intent ' + i);
    const fits = agent.execute({
      operation: 'session_handoff',
      input: { intentions: [...twenty, ' '] },
    }) as unknown as JsonHandoff;
    assert.equal(fits.pack.intentions.length, 20);
    assert.throws(
      () =>
        agent.execute({
          operation: 'session_handoff',
          input: { intentions: [...twenty, 'one more'] },
        }),
      (e) => status(e) === 400,
    );
    const md = agent.execute({
      operation: 'session_handoff',
      input: { format: 'md', intentions: [INTENT] },
    }) as unknown as MdHandoff;
    assert.equal(md.format, 'md');
    assert.match(md.markdown, /^# Передача контекста/);
    assert.match(md.markdown, /## Намерения/);
    assert.match(md.markdown, /## В DevContour/);
    assert.ok(md.markdown.includes(INTENT));
    assert.ok(!('pack' in md));
    assert.ok(md.host.liveBoards);
    assert.throws(
      () => agent.execute({ operation: 'session_handoff', input: { format: 'html' } }),
      (e) => status(e) === 400,
    );
  } finally {
    f.cleanup();
  }
});

test('session_handoff: boardId — граф harness той же доски; неизвестная доска — 404, черновая — 409', () => {
  const f = fixture();
  try {
    const ids = boards(f.h);
    const agent = new AgentService(f.h, f.root);
    const a = handoffPackSchema.parse(
      (
        agent.execute({
          operation: 'session_handoff',
          input: { boardId: ids.a },
        }) as unknown as JsonHandoff
      ).pack,
    );
    assert.equal(a.graphId, ids.a);
    assert.equal(a.summary.works, 2);
    assert.ok(
      a.works.every((w) => w.id !== ids.other),
      'задачи другой доски не входят',
    );
    assert.ok(a.failures.every((x) => x.workId !== ids.other));
    const b = handoffPackSchema.parse(devcontourHandoff(f.h, { boardId: ids.b }).pack);
    assert.equal(b.graphId, ids.b);
    assert.deepEqual(
      b.works.map((w) => w.id),
      [ids.other],
    );
    assert.deepEqual(b.failures, []);
    assert.throws(
      () => agent.execute({ operation: 'session_handoff', input: { boardId: 'missing' } }),
      (e) => status(e) === 404,
    );
    // Черновая доска: отказ называет черновики и следующий шаг, а не только «не выпущена».
    const refusal = (boardId: string) => {
      try {
        agent.execute({ operation: 'session_handoff', input: { boardId } });
      } catch (e) {
        assert.equal(status(e), 409);
        return (e as Error).message;
      }
      assert.fail('ожидался отказ');
    };
    const draft = refusal(ids.draft);
    assert.match(draft, /не выпущена: черновиков задач — 1, утверждённых или выпущенных нет/);
    assert.match(draft, /session_handoff без boardId, в CLI — без --board/);
    assert.match(draft, /после утверждения плана \(review-plan\)/);
    const empty = refusal(f.h.createBoard('Empty board', '', 'main').id);
    assert.match(empty, /задач в работе нет/);
    assert.match(empty, /task_create или plan_import/);
  } finally {
    f.cleanup();
  }
});

test('session_handoff: предел ответа — maxBytes пакета harness за вычетом приложения DevContour; порядок отбрасывания пакета', () => {
  const f = fixture();
  try {
    boards(f.h);
    const intentions = [
      INTENT,
      ...Array.from({ length: 6 }, (_, i) => `intention ${i} ` + 'x'.repeat(900)),
    ];
    const full = devcontourHandoffWithin(f.h, { intentions });
    assert.equal(full.trimmed, false);
    const size = (v: DevContourHandoff, format: 'json' | 'md') =>
      Buffer.byteLength(JSON.stringify(handoffResponse(v, format)));
    for (const format of ['json', 'md'] as const) {
      const total = size(full.value, format);
      const one = devcontourHandoffWithin(f.h, { intentions }, { bytes: total - 1, format });
      const pack = handoffPackSchema.parse(one.value.pack);
      assert.equal(one.trimmed, true, format);
      assert.equal(pack.truncated.bySize, true);
      // Первыми уходят намерения с конца. В JSON — ровно одно; Markdown в ответе
      // экранирован как строка JSON и мера пакета `markdown` берёт больший из
      // размеров, поэтому там может уйти и больше.
      const dropped = pack.truncated.intentionsDropped;
      if (format === 'json') assert.equal(dropped, 1, 'json: ровно последнее намерение');
      else assert.ok(dropped >= 1 && pack.truncated.failures === 0, 'md: только намерения');
      assert.deepEqual(pack.intentions, intentions.slice(0, intentions.length - dropped));
      assert.ok(size(one.value, format) <= total - 1, format + ': весь ответ в пределе');
      assert.deepEqual(one.value.host, full.value.host, 'приложение — по полному пакету');
      const limit = total - 4000;
      const tight = devcontourHandoffWithin(f.h, { intentions }, { bytes: limit, format });
      handoffPackSchema.parse(tight.value.pack);
      assert.ok(size(tight.value, format) <= limit, format + ': и при узком пределе');
      assert.deepEqual(
        tight.value.pack.intentions,
        intentions.slice(0, tight.value.pack.intentions.length),
      );
      assert.ok(tight.value.pack.truncated.intentionsDropped >= 2);
    }
    assert.equal(full.value.pack.truncated.bySize, false, 'полный пакет не урезан');
  } finally {
    f.cleanup();
  }
});

test('ExecutionStore.read: вложенное чтение — тот же снимок и вид, без второго снимка Store', () => {
  const root = mkdtempSyncSafe();
  const file = join(root, 'state.sqlite');
  const h = new DevContour(new Store(file), config());
  const writer = new DevContour(new Store(file), config());
  try {
    h.createBoard('Before', '', 'main');
    const store = new DevContourExecutionStore(h.store, projectionOptions(h));
    let snapshots = 0;
    const snapshot = h.store.snapshot.bind(h.store);
    h.store.snapshot = <T>(read: () => T): T => {
      snapshots++;
      return snapshot(read);
    };
    const seen = store.read((outer) => {
      const before = store.stateOf(outer).boards.map((b) => b.title);
      // Другой процесс (соединение) пишет между чтениями внешнего снимка.
      writer.createBoard('Written meanwhile', '', 'main');
      const inner = store.read((v) => ({
        same: v === outer,
        titles: store.stateOf(v).boards.map((b) => b.title),
        deeper: store.read((w) => w === outer),
      }));
      return { before, ...inner };
    });
    assert.equal(snapshots, 1, 'вложенные чтения не открывают второй снимок');
    assert.equal(seen.same, true);
    assert.equal(seen.deeper, true);
    assert.deepEqual(seen.titles, seen.before, 'вложенное чтение видит внешний снимок');
    assert.ok(!seen.titles.includes('Written meanwhile'));
    // После внешнего чтения вид снят: следующее чтение — новый снимок.
    const after = store.read((v) => store.stateOf(v).boards.map((b) => b.title));
    assert.ok(after.includes('Written meanwhile'));
    assert.equal(snapshots, 2);
    // Исключение во вложенном чтении снимает вид внешнего.
    assert.throws(() =>
      store.read(() =>
        store.read(() => {
          throw new Error('inner');
        }),
      ),
    );
    store.read((v) => assert.ok(store.stateOf(v).boards.length >= 2));
    assert.equal(snapshots, 4);
    // Пакет передачи — одно чтение снимка Store на весь пакет (движок уже
    // собран первым вызовом: его сборка читает конфигурацию отдельно).
    const live = h.createBoard('Board with a live job', '', 'main');
    h.addTask(live.id, input('Task under the live job'));
    h.approve(live.id);
    new LeadWorkflow(h).start({
      kind: 'board',
      id: live.id,
      authorRuntime: 'codex',
      maxAttempts: 3,
    });
    devcontourHandoff(h);
    snapshots = 0;
    const withJob = devcontourHandoff(h, { boardId: live.id });
    handoffPackSchema.parse(withJob.pack);
    assert.deepEqual(withJob.host.liveBoards, [live.id]);
    assert.equal(snapshots, 1, 'пакет и задания досок читаются одним снимком');
  } finally {
    writer.store.close();
    h.store.close();
    rmFixture(root);
  }
});

test('session_handoff: компонентное хранение — центральная база и базы компонентов одним снимком', () => {
  const f = fixture();
  let store: Store | undefined;
  try {
    const workspace = join(f.root, 'workspace');
    mkdirSync(workspace);
    const repos = ['product', 'library'].map((id) => {
      const path = join(f.root, id);
      mkdirSync(path);
      return repositorySchema.parse({ id, name: id, path, gates: f.h.config.gates });
    });
    store = new Store(join(workspace, 'state.sqlite'), repos);
    const h = new DevContour(
      store,
      config({ storage: 'component', workspaceRoot: workspace, repositories: repos }),
    );
    const ids = repos.map((r) => {
      const board = h.createBoard(`Board of ${r.id}`, '', r.id);
      const task = h.addTask(board.id, { ...input(`Task of ${r.id}`), repositoryId: r.id });
      h.approve(board.id);
      return { board: board.id, task: task.id };
    });
    devcontourHandoff(h);
    let snapshots = 0;
    const snapshot = store.snapshot.bind(store);
    store.snapshot = <T>(read: () => T): T => {
      snapshots++;
      return snapshot(read);
    };
    const all = handoffPackSchema.parse(devcontourHandoff(h).pack);
    assert.equal(snapshots, 1, 'базы компонентов читаются одним снимком');
    assert.deepEqual(all.works.map((w) => w.id).sort(), ids.map((i) => i.task).sort());
    const library = handoffPackSchema.parse(devcontourHandoff(h, { boardId: ids[1].board }).pack);
    assert.deepEqual(
      library.works.map((w) => w.id),
      [ids[1].task],
    );
  } finally {
    store?.close();
    f.cleanup();
  }
});

/** Доска с одной утверждённой задачей и пакет по ней. */
function oneBoard(h: DevContour) {
  const board = h.createBoard('Board with job', '', 'main');
  const task = h.addTask(board.id, input('Task under the job')).id;
  h.approve(board.id);
  const at = () => {
    const value = devcontourHandoff(h, { boardId: board.id });
    return { ...value, pack: handoffPackSchema.parse(value.pack) };
  };
  const start = (maxAttempts = 3) =>
    new LeadWorkflow(h).start({ kind: 'board', id: board.id, authorRuntime: 'codex', maxAttempts });
  return { board: board.id, task, at, start };
}

/** Время идёт: метки ISO одной миллисекунды не упорядочены. */
function tick() {
  const until = Date.now() + 3;
  while (Date.now() < until);
}

test('session_handoff: задание ведущего по доске — задание графа: повтор назначен, восстановления видны', () => {
  const f = fixture();
  try {
    const { board, task, at, start } = oneBoard(f.h);
    assert.deepEqual(at().pack.repairs, []);
    start();
    const live = at();
    assert.deepEqual(live.host.liveBoards, [board]);
    assert.deepEqual(
      live.pack.repairs.map((r) => ({ graphId: r.graphId, used: r.used })),
      [{ graphId: board, used: 0 }],
    );
    f.h.pause(false);
    const run = f.h.claim('test')!;
    assert.equal(run.taskId, task);
    f.h.fail(run.id, run.token, 'candidate/typecheck: error', false, 'gate');
    const failed = at();
    const stop = failed.pack.stops.find((s) => s.workId === task);
    assert.ok(stop, 'остановка упавшей задачи');
    assert.equal(stop.code, 'GATE_FAILED');
    assert.equal(stop.retryPlanned, true, 'цикл задания повторит задачу в бюджете');
    assert.equal(stop.actor, 'controller');
    const work = failed.pack.works.find((w) => w.id === task)!;
    assert.equal(work.next.actor, 'controller');
    assert.equal(work.next.step, 'retry-within-budget');
    assert.equal(failed.pack.repairs.length, 1);
    assert.equal(failed.pack.repairs[0].budget, f.h.config.repairBudget);
    assert.equal(failed.host.next?.action, 'wait');
  } finally {
    f.cleanup();
  }
});

test('session_handoff: host.next по состоянию — сервер, задание, пауза остановки и человека', async () => {
  // Сервер работает (роль controller жива), задания нет: исходную паузу
  // снимает только цикл задания доски — шаг workflow_start.
  {
    const f = fixture();
    try {
      const { board, at, start } = oneBoard(f.h);
      assert.ok(f.h.leader('server'));
      const running = at();
      assert.equal(running.pack.controller?.live, true);
      assert.equal(running.pack.queue.paused, true);
      assert.equal(running.host.next?.action, 'workflow_start');
      assert.equal(running.host.next?.boardId, board);
      start();
      const live = at();
      assert.equal(live.host.next?.action, 'wait', 'задание продолжит работающий сервер');
      assert.deepEqual(live.host.liveBoards, [board]);
    } finally {
      f.cleanup();
    }
  }
  // Пауза штатной остановки при живом controller и без задания.
  {
    const f = fixture();
    try {
      const { at } = oneBoard(f.h);
      f.h.pause(true, 'shutdown');
      assert.ok(f.h.leader('server'));
      assert.equal(at().host.next?.action, 'workflow_start');
    } finally {
      f.cleanup();
    }
  }
  // Пауза человека до начала задания снимает цикл стадии — ждать; после
  // начала задания — решение пользователя (queue_set).
  {
    const f = fixture();
    try {
      const { at, start } = oneBoard(f.h);
      f.h.pause(true);
      assert.equal(at().host.next?.action, 'queue_set', 'без задания — только решение человека');
      tick();
      start();
      assert.equal(at().host.next?.action, 'wait');
      tick();
      f.h.pause(true);
      assert.equal(f.store.read().pauseReason, 'operator');
      assert.equal(at().host.next?.action, 'queue_set');
      assert.deepEqual(at().host.next?.params, {});
      assert.match(at().host.next?.detail ?? '', /paused by the operator/);
      // Пауза ведущего поверх паузы человека её не переписывает.
      await new AgentService(f.h, f.root).run({ operation: 'queue_set', input: { paused: true } });
      assert.deepEqual(at().host.next?.params, {});
      // Ту же паузу поставил ведущий (queue_set) на идущей очереди: шаг называет
      // его, а не решение пользователя.
      f.h.pause(false);
      tick();
      await new AgentService(f.h, f.root).run({ operation: 'queue_set', input: { paused: true } });
      const lead = at().host.next;
      assert.equal(lead?.action, 'queue_set');
      assert.deepEqual(lead?.params, { by: 'lead' });
      assert.match(lead?.detail ?? '', /paused by the lead \(queue_set\)/);
      // Под паузой ведущего удержанный перенос базы: снятие паузы сняло бы и
      // ожидание, которое подтверждает только человек, — шаг снова решение
      // пользователя.
      f.store.change('fixture', (s) => {
        s.waits = [
          {
            kind: 'base-check',
            detail: `${BASE_HELD_DETAIL} (main:contracts/api.md)`,
            at: new Date().toISOString(),
          },
        ];
        return {};
      });
      const held = at().host.next;
      assert.equal(held?.code, 'pause-operator');
      assert.deepEqual(held?.params, {});
      assert.match(held?.detail ?? '', /only on the user's decision/);
      // Обычное ожидание переноса базы (не удержанное) под паузой ведущего —
      // тоже решение человека: снятие паузы сняло бы его без проверки базы.
      f.store.change('fixture', (s) => {
        s.waits = [
          {
            kind: 'base-check',
            detail: 'База прогонов перенесена (main): проверьте её гейтами и продолжите очередь',
            at: new Date().toISOString(),
          },
        ];
        return {};
      });
      const plain = at().host.next;
      assert.equal(plain?.code, 'pause-operator');
      assert.deepEqual(plain?.params, {});
      assert.match(plain?.detail ?? '', /only on the user's decision/);
    } finally {
      f.cleanup();
    }
  }
});

test('session_handoff: задание доски упало после приёмки всех задач — host.next называет workflow_retry', () => {
  const f = fixture();
  try {
    const { board, task, at, start } = oneBoard(f.h);
    const flow = new LeadWorkflow(f.h);
    const job = start(3);
    complete(f.h, task);
    flow.fail(flow.claim(job.key, job.owner)!, 'gate coverage timed out after 900000 ms');
    // Открытых поручений нет: прежде шага не было вовсе (host.next: null).
    const failed = at();
    assert.equal(failed.pack.summary.open, 0);
    assert.equal(failed.host.next?.action, 'workflow_retry', JSON.stringify(failed.host.next));
    assert.equal(failed.host.next?.code, 'job-retry');
    assert.equal(failed.host.next?.boardId, board);
    assert.equal(failed.host.next?.job?.key, job.key);
    assert.match(failed.host.next.detail, /gate coverage timed out/);
    assert.equal(devcontourHandoff(f.h, {}).host.next?.action, 'workflow_retry', 'и без --board');
    assert.equal(flow.retry(job.key, job.owner).status, 'queued');
    assert.notEqual(at().host.next?.action, 'workflow_retry');
  } finally {
    f.cleanup();
  }
});

test('session_handoff: host.next по заданию — упавшее (повтор или решение) и устаревшее', () => {
  {
    const f = fixture();
    try {
      const { board, at, start } = oneBoard(f.h);
      const flow = new LeadWorkflow(f.h);
      const job = start(3);
      flow.fail(flow.claim(job.key, job.owner)!, 'plan review unavailable');
      assert.equal(flow.get(job.key, job.owner).status, 'failed');
      const failed = at();
      assert.deepEqual(failed.host.liveBoards, []);
      assert.equal(failed.host.next?.action, 'workflow_retry');
      assert.equal(failed.host.next?.boardId, board);
      assert.equal(failed.host.next?.job?.key, job.key);
      assert.equal(failed.host.next?.job?.repositoryId, job.owner);
      // Названный шаг исполним: повтор принимает это задание.
      assert.equal(flow.retry(job.key, job.owner).status, 'queued');
      assert.equal(at().host.next?.action, 'wait');
    } finally {
      f.cleanup();
    }
  }
  {
    const f = fixture();
    try {
      const { at, start } = oneBoard(f.h);
      const flow = new LeadWorkflow(f.h);
      const job = start(1);
      flow.fail(flow.claim(job.key, job.owner)!, 'plan review unavailable');
      const exhausted = at();
      assert.equal(exhausted.host.next?.action, 'decide');
      assert.match(exhausted.host.next.detail, /plan review unavailable/);
      assert.equal(start(1).key, job.key, 'workflow_start вернул бы то же упавшее задание');
    } finally {
      f.cleanup();
    }
  }
  {
    const f = fixture();
    try {
      const board = f.h.createBoard('Board with a stale job', '', 'main');
      const task = f.h.addTask(board.id, input('Task before the change'));
      const flow = new LeadWorkflow(f.h);
      const request = { kind: 'board', id: board.id, authorRuntime: 'codex', maxAttempts: 3 };
      const job = flow.start(request);
      f.h.editTask(task.id, { ...input('Task after the change') }, specDigest(task));
      assert.equal(flow.claim(job.key, job.owner), undefined);
      assert.equal(flow.get(job.key, job.owner).status, 'stale');
      f.h.approve(board.id);
      const stale = devcontourHandoff(f.h, { boardId: board.id });
      assert.equal(stale.host.next?.action, 'workflow_start');
      assert.equal(stale.host.next?.job?.status, 'stale');
      assert.notEqual(flow.start(request).key, job.key, 'новый вход — новое задание');
    } finally {
      f.cleanup();
    }
  }
});

/**
 * Задание доски на стадии `stage`, как его оставил цикл: стадия записана, а
 * задание ждёт следующего такта (`queued`, без владельца).
 */
function atStage(h: DevContour, key: string, owner: string | undefined, stage: number, extra = {}) {
  const flow = new LeadWorkflow(h);
  const job = flow.get(key, owner);
  const next: Record<string, unknown> = { ...job, stage, status: 'queued', ...extra };
  delete next.token;
  delete next.leaseUntil;
  h.store.atomic(() => h.store.saveLocal('lead', owner, key, next));
  return flow.get(key, owner);
}

test('session_handoff: wait — цикл ведущего действительно снимает паузу (исходную и человека до старта, по всему workspace)', async () => {
  // Исходная пауза: задание на стадии задач снимает её на ближайшем такте.
  {
    const f = fixture();
    try {
      const { board, start } = oneBoard(f.h);
      const job = atStage(f.h, start().key, 'main', 1);
      assert.ok(f.h.leader('server'), 'сервер держит роль controller');
      const value = devcontourHandoff(f.h, { boardId: board });
      assert.equal(value.host.next?.action, 'wait');
      assert.deepEqual(value.host.next?.loop, { step: 'lift-pause', pause: 'initial' });
      await new LeadRunner(f.h, f.root).tick();
      assert.equal(f.store.read().paused, false, 'обещанное снятие паузы выполнено');
      assert.equal(new LeadWorkflow(f.h).get(job.key, job.owner).status, 'queued');
    } finally {
      f.cleanup();
    }
  }
  // Пауза человека до старта задания: пакет всего workspace (без boardId,
  // шаг пакета — возобновление очереди) — тоже ждать; цикл снимает её.
  {
    const f = fixture();
    try {
      const { start } = oneBoard(f.h);
      f.h.pause(true);
      tick();
      const job = atStage(f.h, start().key, 'main', 1);
      const value = devcontourHandoff(f.h);
      assert.equal(value.host.next?.action, 'wait');
      assert.deepEqual(value.host.next?.loop, { step: 'lift-pause', pause: 'operator' });
      await new LeadRunner(f.h, f.root).tick();
      assert.equal(f.store.read().paused, false);
      // На стадии приёмки цикл снимает только паузу остановки.
      f.h.pause(true);
      // Пауза поставлена до старта задания: на стадии задач цикл снял бы её.
      const late = atStage(f.h, job.key, job.owner, 2, { startedAt: '2999-01-01T00:00:00.000Z' });
      assert.ok(f.store.read().pausedAt! < late.startedAt);
      assert.equal(devcontourHandoff(f.h).host.next?.action, 'queue_set');
      await new LeadRunner(f.h, f.root).tick();
      assert.equal(f.store.read().paused, true, 'стадия 2 паузу человека не снимает');
    } finally {
      f.cleanup();
    }
  }
});

test('session_handoff: исчерпанный бюджет восстановлений — decide, а не workflow_retry; повтор после ручного исправления продвигает задание', async () => {
  const f = fixture();
  try {
    const { board, task, start } = oneBoard(f.h);
    const flow = new LeadWorkflow(f.h);
    const job = atStage(f.h, start().key, 'main', 1, { repairs: f.h.config.repairBudget });
    f.h.pause(false);
    const run = f.h.claim('test')!;
    assert.equal(run.taskId, task);
    f.h.fail(run.id, run.token, 'candidate/typecheck: error', false, 'gate');
    const runner = new LeadRunner(f.h, f.root);
    await runner.tick();
    const failed = flow.get(job.key, job.owner);
    assert.equal(failed.status, 'failed', 'цикл остановил задание');
    assert.equal(failed.attempts, 1);
    assert.equal(f.store.read().paused, false, 'очередь не на паузе');
    const value = devcontourHandoff(f.h, { boardId: board });
    assert.equal(value.host.next?.action, 'decide', 'повтор задания упал бы снова');
    assert.equal(value.host.next?.loop?.step, 'stop');
    assert.ok(failed.error && value.host.next.detail.includes(failed.error));
    assert.match(value.host.next.detail, /devcontour retry --task/);
    const whole = devcontourHandoff(f.h);
    assert.equal(whole.host.next?.action, 'decide', 'и в пакете всего workspace');
    // Проверка обещания: повтор задания без исправления падает с той же причиной.
    flow.retry(job.key, job.owner);
    await runner.tick();
    const again = flow.get(job.key, job.owner);
    assert.equal(again.status, 'failed');
    assert.equal(again.attempts, 2);
    assert.equal(again.error, failed.error);
    // Ручное исправление задачи: теперь шаг — повтор задания, и он продвигает его.
    f.h.retry(task);
    const fixed = devcontourHandoff(f.h, { boardId: board });
    assert.equal(fixed.host.next?.action, 'workflow_retry');
    assert.equal(fixed.host.next?.job?.key, job.key);
    flow.retry(job.key, job.owner);
    await runner.tick();
    const progressed = flow.get(job.key, job.owner);
    assert.notEqual(progressed.status, 'failed', 'обещанный повтор не падает');
    assert.equal(progressed.attempts, 0, 'такт засчитан как успешный');
  } finally {
    f.cleanup();
  }
});

test('session_handoff: вход доски не построить — fix-input с причиной; возвращённый вход — decide', () => {
  {
    const f = fixture();
    const original = Object.getOwnPropertyDescriptor(LeadWorkflow.prototype, 'input')!
      .value as LeadWorkflow['input'];
    try {
      const { board } = oneBoard(f.h);
      const reason = 'Сначала пользователь должен утвердить референсы';
      LeadWorkflow.prototype.input = function (kind, id, s) {
        if (id === board) throw new DomainError(reason, 409);
        return original.call(this, kind, id, s);
      };
      const value = devcontourHandoff(f.h, { boardId: board });
      assert.equal(value.host.next?.action, 'fix-input');
      assert.ok(value.host.next.detail.includes(reason));
      assert.throws(
        () => new LeadWorkflow(f.h).start({ kind: 'board', id: board, authorRuntime: 'codex' }),
        new RegExp(reason),
        'workflow_start отказал бы с той же причиной',
      );
    } finally {
      LeadWorkflow.prototype.input = original;
      f.cleanup();
    }
  }
  {
    const f = fixture();
    try {
      const board = f.h.createBoard('Board with a reverted input', '', 'main');
      const task = f.h.addTask(board.id, input('Original task title'));
      const flow = new LeadWorkflow(f.h);
      const request = { kind: 'board', id: board.id, authorRuntime: 'codex', maxAttempts: 3 };
      const job = flow.start(request);
      const changed = f.h.editTask(task.id, { ...input('Changed task title') }, specDigest(task));
      assert.equal(flow.claim(job.key, job.owner), undefined);
      assert.equal(flow.get(job.key, job.owner).status, 'stale');
      f.h.editTask(task.id, { ...input('Original task title') }, specDigest(changed));
      f.h.approve(board.id);
      const value = devcontourHandoff(f.h, { boardId: board.id });
      assert.equal(value.host.next?.action, 'decide');
      assert.match(value.host.next.detail, /returns it unchanged/);
      assert.equal(flow.start(request).key, job.key, 'workflow_start вернул то же задание');
      assert.equal(flow.get(job.key, job.owner).status, 'stale');
    } finally {
      f.cleanup();
    }
  }
  {
    // Попытка идёт, задания нет: workflow_start с пометкой о ручном пути.
    const f = fixture();
    try {
      const { board } = oneBoard(f.h);
      f.h.pause(false);
      f.h.claim('test');
      const value = devcontourHandoff(f.h, { boardId: board });
      assert.equal(value.host.next?.action, 'workflow_start');
      assert.match(value.host.next.detail, /attempt is running/);
    } finally {
      f.cleanup();
    }
  }
});

test('session_handoff: пауза человека и решение по заданию — decide и wait по правилам цикла', async () => {
  // P1: задание упало на исчерпанном бюджете, очередь на паузе человека —
  // decide: снятие паузы задание не вернёт.
  {
    const f = fixture();
    try {
      const { board, task, start } = oneBoard(f.h);
      const flow = new LeadWorkflow(f.h);
      const job = atStage(f.h, start().key, 'main', 1, { repairs: f.h.config.repairBudget });
      f.h.pause(false);
      const run = f.h.claim('test')!;
      assert.equal(run.taskId, task);
      f.h.fail(run.id, run.token, 'candidate/typecheck: error', false, 'gate');
      const runner = new LeadRunner(f.h, f.root);
      await runner.tick();
      assert.equal(flow.get(job.key, job.owner).status, 'failed');
      f.h.pause(true);
      const value = devcontourHandoff(f.h, { boardId: board });
      assert.equal(value.host.next?.action, 'decide');
      assert.equal(value.host.next?.loop?.step, 'stop');
      // Проверка: снятие паузы задание не продвигает.
      f.h.pause(false);
      await runner.tick();
      assert.equal(flow.get(job.key, job.owner).status, 'failed');
    } finally {
      f.cleanup();
    }
  }
  // P2: действующее задание на стадии задач, упавшая задача в бюджете,
  // пауза человека до старта задания — wait: такт 1 чинит задачу (пауза
  // остаётся), такт 2 снимает паузу.
  {
    const f = fixture();
    try {
      const { board, task, start } = oneBoard(f.h);
      f.h.pause(false);
      const run = f.h.claim('test')!;
      assert.equal(run.taskId, task);
      f.h.fail(run.id, run.token, 'candidate/typecheck: error', false, 'gate');
      f.h.pause(true);
      tick();
      const job = atStage(f.h, start().key, 'main', 1);
      const value = devcontourHandoff(f.h, { boardId: board });
      assert.equal(value.host.next?.action, 'wait');
      assert.equal(value.host.next?.loop?.step, 'repair');
      const runner = new LeadRunner(f.h, f.root);
      await runner.tick();
      assert.equal(f.store.read().tasks.find((t) => t.id === task)!.status, 'ready');
      assert.equal(f.store.read().paused, true, 'такт 1 только чинит задачу');
      await runner.tick();
      assert.equal(f.store.read().paused, false, 'такт 2 снимает паузу');
      assert.notEqual(new LeadWorkflow(f.h).get(job.key, job.owner).status, 'failed');
    } finally {
      f.cleanup();
    }
  }
  // P3: действующее задание, исчерпанный бюджет, пауза человека после
  // старта — decide с остановкой цикла: следующий такт останавливает задание.
  {
    const f = fixture();
    try {
      const { board, task, start } = oneBoard(f.h);
      const job = atStage(f.h, start().key, 'main', 1, { repairs: f.h.config.repairBudget });
      f.h.pause(false);
      const run = f.h.claim('test')!;
      assert.equal(run.taskId, task);
      f.h.fail(run.id, run.token, 'candidate/typecheck: error', false, 'gate');
      tick();
      f.h.pause(true);
      const value = devcontourHandoff(f.h, { boardId: board });
      assert.equal(value.host.next?.action, 'decide');
      assert.equal(value.host.next?.loop?.step, 'stop');
      const whole = devcontourHandoff(f.h);
      assert.equal(whole.host.next?.action, 'decide', 'и в пакете всего workspace');
      await new LeadRunner(f.h, f.root).tick();
      const stopped = new LeadWorkflow(f.h).get(job.key, job.owner);
      assert.equal(stopped.status, 'failed', 'обещанная остановка произошла');
      assert.ok(
        value.host.next.loop?.step === 'stop' && stopped.error === value.host.next.loop.reason,
      );
    } finally {
      f.cleanup();
    }
  }
});

test('session_handoff: доска без согласованного плана — decide о плане, а не workflow_start', async () => {
  const f = fixture();
  try {
    const board = f.h.createBoard('Board with later findings', '', 'main');
    f.h.addTask(board.id, input('Approved task'));
    f.h.approve(board.id);
    const drafts = ['Finding one', 'Finding two'].map((t) => f.h.addTask(board.id, input(t)).id);
    for (const value of [devcontourHandoff(f.h), devcontourHandoff(f.h, { boardId: board.id })]) {
      assert.equal(value.host.next?.action, 'decide');
      assert.equal(value.host.next?.decision, 'plan');
      assert.equal(value.host.next?.boardId, board.id);
      assert.deepEqual(value.host.next?.plan?.drafts.sort(), [...drafts].sort());
      assert.match(value.host.next.detail, /review-plan --board .* --tasks/);
      for (const id of drafts)
        assert.ok(value.host.next.detail.includes(id), 'id задачи в подсказке');
      assert.match(value.host.next.detail, /--workspace/);
      assert.doesNotMatch(value.host.next.detail, /^No live/);
    }
    // Почему не workflow_start: задание отправило бы весь план на ревью, и
    // после одобрения (в режиме demo — сразу) черновики выпущены все.
    const job = new LeadWorkflow(f.h).start({
      kind: 'board',
      id: board.id,
      authorRuntime: 'codex',
      maxAttempts: 3,
    });
    assert.deepEqual(loopAhead(f.h, f.store.read(), job).outlook, { step: 'review-plan' });
    await new LeadRunner(f.h, f.root).tick();
    const released = f.store.read().tasks.filter((t) => drafts.includes(t.id));
    assert.ok(
      released.every((t) => t.status !== 'draft'),
      'workflow_start выпустил все черновики',
    );
  } finally {
    f.cleanup();
  }
});

test('session_handoff: решение ведущего или пользователя вне очереди — без придуманного шага очереди', () => {
  const f = fixture();
  try {
    const h = new DevContour(
      f.store,
      config({ checkoutRoot: f.h.config.checkoutRoot, maxAttempts: 1 }),
    );
    const board = h.createBoard('Board with an exhausted task', '', 'main');
    const task = h.addTask(board.id, input('Exhausted task')).id;
    h.approve(board.id);
    // Вторая доска без задания: её workflow_start был бы выдуманным шагом.
    const other = h.createBoard('Other board', '', 'main');
    h.addTask(other.id, input('Other task'));
    h.approve(other.id);
    h.pause(false);
    const run = h.claim('test')!;
    assert.equal(run.taskId, task);
    h.fail(run.id, run.token, 'gate failed', false, 'gate');
    const value = devcontourHandoff(h);
    assert.equal(value.pack.next.actor, 'user');
    assert.equal(value.pack.next.action, 'reset-attempts');
    assert.equal(value.host.next, undefined, 'шаг пакета стоит; шага очереди нет');
    // Решение по заданию доски этого решения остаётся: цикл задания
    // остановил бы его на исчерпанной задаче.
    const job = new LeadWorkflow(h).start({
      kind: 'board',
      id: board.id,
      authorRuntime: 'codex',
      maxAttempts: 3,
    });
    atStage(h, job.key, job.owner, 1);
    const decided = devcontourHandoff(h);
    assert.equal(decided.host.next?.action, 'decide');
    assert.equal(decided.host.next?.decision, 'job');
    assert.equal(decided.host.next?.loop?.step, 'stop');
  } finally {
    f.cleanup();
  }
});

test('session_handoff: решение о плане с заданием доски — wait при живом задании, workflow_retry при упавшем', async () => {
  // Живое задание стадии 0: план ревьюирует оно само — ведущий ждёт, а не
  // ревьюирует вручную наперегонки с ним.
  {
    const f = fixture();
    try {
      const board = f.h.createBoard('Board under plan review', '', 'main');
      f.h.addTask(board.id, input('Approved task'));
      f.h.approve(board.id);
      const draft = f.h.addTask(board.id, input('Later finding')).id;
      new LeadWorkflow(f.h).start({
        kind: 'board',
        id: board.id,
        authorRuntime: 'codex',
        maxAttempts: 3,
      });
      for (const value of [devcontourHandoff(f.h), devcontourHandoff(f.h, { boardId: board.id })]) {
        assert.equal(value.pack.next.action, 'review-plan');
        assert.equal(value.host.next?.action, 'wait');
        assert.equal(value.host.next?.loop?.step, 'review-plan');
      }
      await new LeadRunner(f.h, f.root).tick();
      assert.notEqual(
        f.store.read().tasks.find((t) => t.id === draft)!.status,
        'draft',
        'план разобрало задание',
      );
    } finally {
      f.cleanup();
    }
  }
  // Задание стадии 0 упало, попытки остались — повтор задания, и он
  // продвигает его.
  {
    const f = fixture();
    try {
      const board = f.h.createBoard('Board with a failed plan review', '', 'main');
      f.h.addTask(board.id, input('Approved task'));
      f.h.approve(board.id);
      f.h.addTask(board.id, input('Later finding'));
      const flow = new LeadWorkflow(f.h);
      const job = flow.start({
        kind: 'board',
        id: board.id,
        authorRuntime: 'codex',
        maxAttempts: 3,
      });
      flow.fail(flow.claim(job.key, job.owner)!, 'plan review runtime unavailable');
      const value = devcontourHandoff(f.h, { boardId: board.id });
      assert.equal(value.host.next?.action, 'workflow_retry');
      assert.equal(value.host.next?.job?.key, job.key);
      assert.equal(value.host.next?.loop?.step, 'review-plan');
      flow.retry(job.key, job.owner);
      await new LeadRunner(f.h, f.root).tick();
      assert.notEqual(flow.get(job.key, job.owner).status, 'failed');
    } finally {
      f.cleanup();
    }
  }
});

test('session_handoff: принятой доске без открытых задач шаг не нужен — и с её заданием', () => {
  for (const status of ['completed', 'failed'] as const) {
    const f = fixture();
    try {
      const accepted = f.h.createBoard('Accepted board', '', 'main');
      const done = f.h.addTask(accepted.id, input('Done task')).id;
      const cancelled = f.h.addTask(accepted.id, input('Cancelled task')).id;
      f.h.approve(accepted.id);
      complete(f.h, done);
      f.h.cancel(cancelled, 'not needed any more');
      f.h.accept(accepted.id, MERGED);
      assert.equal(f.store.read().boards[0].revisions.at(-1)!.status, 'accepted');
      // Открытая работа есть, но на другой доске (без задания).
      const other = f.h.createBoard('Open board', '', 'main');
      f.h.addTask(other.id, input('Open task'));
      f.h.approve(other.id);
      // Задание по текущему входу принятой доски: завершённое или упавшее.
      const job = new LeadWorkflow(f.h).start({
        kind: 'board',
        id: accepted.id,
        authorRuntime: 'codex',
        maxAttempts: 3,
      });
      atStage(f.h, job.key, job.owner, 2, { status, attempts: 1 });
      const value = devcontourHandoff(f.h);
      assert.ok(value.pack.summary.open > 0);
      // Отменённой задаче без ждущих решение не нужно (harness alpha.33):
      // шаг — по открытой доске, принятая доска не называется.
      assert.notEqual(value.pack.next.workId, cancelled);
      assert.equal(
        value.host.next?.boardId,
        other.id,
        status + ': заданию принятой доски делать нечего',
      );
      assert.equal(value.host.next?.action, 'workflow_start');
    } finally {
      f.cleanup();
    }
  }
});

test('session_handoff: пауза человека важнее решения о плане другой доски', () => {
  for (const before of [true, false]) {
    const f = fixture();
    try {
      const planned = f.h.createBoard('Board with an unapproved plan', '', 'main');
      f.h.addTask(planned.id, input('Approved task'));
      f.h.approve(planned.id);
      f.h.addTask(planned.id, input('Later finding'));
      const running = f.h.createBoard('Running board', '', 'main');
      f.h.addTask(running.id, input('Running task'));
      f.h.approve(running.id);
      const start = () =>
        atStage(
          f.h,
          new LeadWorkflow(f.h).start({
            kind: 'board',
            id: running.id,
            authorRuntime: 'codex',
            maxAttempts: 3,
          }).key,
          'main',
          1,
        );
      if (before) {
        f.h.pause(true);
        tick();
        start();
      } else {
        start();
        tick();
        f.h.pause(true);
      }
      const value = devcontourHandoff(f.h);
      assert.equal(value.pack.next.action, 'resume-queue', 'шаг пакета — снять паузу');
      if (before) {
        // Пауза до старта задания: цикл задания снимет её.
        assert.equal(value.host.next?.action, 'wait');
        assert.equal(value.host.next?.boardId, running.id);
        assert.deepEqual(value.host.next?.loop, { step: 'lift-pause', pause: 'operator' });
      } else {
        // Пауза после старта: решение пользователя, не решение о плане.
        assert.equal(value.host.next?.action, 'queue_set');
      }
    } finally {
      f.cleanup();
    }
  }
});

test('session_handoff: решение пакета не прячется за ожиданием задания, которое лишь ждёт задач', () => {
  const f = fixture();
  try {
    const board = f.h.createBoard('Board past plan review', '', 'main');
    f.h.addTask(board.id, input('Approved task'));
    f.h.approve(board.id);
    const draft = f.h.addTask(board.id, input('Finding after plan review')).id;
    // Задание по текущему входу (с черновиком) уже на стадии приёмки: его
    // цикл ждёт задач и черновик не выпустит.
    const job = new LeadWorkflow(f.h).start({
      kind: 'board',
      id: board.id,
      authorRuntime: 'codex',
      maxAttempts: 3,
    });
    atStage(f.h, job.key, job.owner, 2);
    const value = devcontourHandoff(f.h, { boardId: board.id });
    assert.equal(value.pack.next.action, 'review-plan');
    assert.deepEqual(value.host.liveBoards, [board.id], 'задание действует');
    assert.equal(
      loopAhead(f.h, f.store.read(), new LeadWorkflow(f.h).get(job.key, job.owner)).outlook.step,
      'wait',
      'задание стадии 2 только ждёт задач',
    );
    assert.equal(value.host.next?.action, 'decide');
    assert.equal(value.host.next?.decision, 'plan');
    assert.deepEqual(value.host.next?.plan?.drafts, [draft]);
  } finally {
    f.cleanup();
  }
});

test('session_handoff: подсказка ревью плана называет не больше 20 задач', () => {
  const f = fixture();
  try {
    const board = f.h.createBoard('Board with many findings', '', 'main');
    f.h.addTask(board.id, input('Approved task'));
    f.h.approve(board.id);
    const drafts = Array.from(
      { length: 25 },
      (_, i) => f.h.addTask(board.id, input(`Finding ${i}`)).id,
    );
    let value = devcontourHandoff(f.h, { boardId: board.id });
    assert.equal(value.host.next?.decision, 'plan');
    // Область — весь план: ревью без --tasks, id в подсказке не перечисляются.
    let detail = value.host.next.detail;
    assert.match(detail, /the whole plan, 25 tasks: no --tasks needed/);
    assert.doesNotMatch(detail, /--tasks T/);
    assert.equal(value.host.next?.plan?.drafts.length, 25, 'полный список — в plan');
    assert.equal(value.host.next?.plan?.review.length, 20);
    assert.equal(value.host.next?.plan?.reviewCount, 25);
    // Область меньше плана и длиннее подсказки: усечение сказано прямо.
    f.h.addTask(board.id, { ...input('Unbound backend'), role: 'backend' });
    value = devcontourHandoff(f.h, { boardId: board.id });
    detail = value.host.next!.detail;
    const named = drafts.filter((id) => detail.includes(id));
    assert.equal(named.length, 20);
    assert.match(detail, /scope truncated: the first 20 of 25 reviewable tasks/);
  } finally {
    f.cleanup();
  }
});

test('session_handoff: решение о плане называет черновики, которые утверждение отвергнет, и неразобранные находки', () => {
  const f = fixture();
  try {
    const board = f.h.createBoard('Board with findings', '', 'main');
    const source = f.h.addTask(board.id, input('Approved task'));
    f.h.approve(board.id);
    f.h.pause(false);
    const run = f.h.claim('writer')!;
    assert.equal(run.taskId, source.id);
    const [found] = f.h.discoveries(run.id, run.token, 'a'.repeat(40), [
      {
        kind: 'bug',
        title: 'Raw finding',
        path: 'src/a.ts',
        line: 1,
        observation: 'Observation text',
        consequence: 'Consequence',
        reproduction: 'Reproduction',
      },
    ]);
    const findings = f.store.read().boards.find((b) => b.title === 'Находки агентов')!;
    // Сырая находка: ведущий разбирает её до ревью, ревью не предлагается.
    let next = devcontourHandoff(f.h).host.next;
    assert.equal(next?.decision, 'plan');
    assert.equal(next?.boardId, findings.id);
    assert.deepEqual(next?.plan?.unverified, [found]);
    assert.equal(next?.plan?.blocked.length, 0);
    assert.match(next.detail, /unverified agent findings/);
    assert.match(next.detail, /cancel --task ID .*--by host/);
    assert.doesNotMatch(next.detail, /review-plan --board/, 'ревью сырых находок не предлагается');
    assert.match(
      next.detail,
      /fields absent from the file are kept, except repositoryId, scope, dependsOn and contracts.*copy them from the current task/,
    );
    // Правка черновика — явный разбор: даже с прежней приёмкой находка
    // отмечена triaged и идёт в область ревью.
    const t = f.store.read().tasks.find((x) => x.id === found)!;
    f.h.editTask(
      found,
      {
        repositoryId: t.repositoryId,
        role: t.role,
        title: t.title,
        description: t.description,
        acceptance: t.acceptance,
      },
      specDigest(t),
    );
    assert.ok(f.store.read().tasks.find((x) => x.id === found)?.triagedAt);
    // Повтор разобранной находки нового черновика не создаёт.
    assert.deepEqual(
      f.h.discoveries(run.id, run.token, 'b'.repeat(40), [
        {
          kind: 'bug',
          title: 'Raw finding',
          path: 'src/a.ts',
          line: 1,
          observation: 'Observation text',
          consequence: 'Consequence',
          reproduction: 'Reproduction',
        },
      ]),
      [],
    );
    next = devcontourHandoff(f.h).host.next;
    assert.equal(next?.boardId, findings.id);
    assert.deepEqual(next?.plan?.unverified, []);
    assert.deepEqual(next?.plan?.review, [found]);
    assert.match(next.detail, new RegExp(`--tasks ${found} --author-runtime`));
    // Обратное направление: находка proposed с иной приёмкой не разобрана.
    const manual = f.h.addTask(findings.id, {
      ...input('Manual finding'),
      finding: { ...t.finding!, fingerprint: 'manual', verification: 'proposed' },
    }).id;
    next = devcontourHandoff(f.h).host.next;
    assert.deepEqual(next?.plan?.unverified, [manual]);
    // Список неразобранных ограничен, полный счёт — в unverifiedCount.
    const more = Array.from(
      { length: 21 },
      (_, i) =>
        f.h.addTask(findings.id, {
          ...input(`Manual finding ${i}`),
          finding: { ...t.finding!, fingerprint: `manual-${i}`, verification: 'proposed' },
        }).id,
    );
    next = devcontourHandoff(f.h).host.next;
    assert.equal(next?.plan?.unverifiedCount, 22);
    assert.deepEqual(next?.plan?.unverified, [manual, ...more].slice(0, 20));
    assert.match(next.detail, /… ещё 2: host\.next\.plan\.unverified/);
    for (const id of more) f.h.cancel(id, 'Duplicate of the manual finding');
    assert.deepEqual(next?.plan?.review, [found]);
    // Роль с обязательным контрактом без контракта: утверждение откажет, такой
    // черновик в область ревью не входит; списки с причинами ограничены.
    const unbound = Array.from(
      { length: 22 },
      (_, i) => f.h.addTask(board.id, { ...input(`Unbound backend ${i}`), role: 'backend' }).id,
    );
    const ready = f.h.addTask(board.id, input('Ready draft')).id;
    next = devcontourHandoff(f.h, { boardId: board.id }).host.next;
    assert.equal(next?.decision, 'plan');
    assert.equal(next?.plan?.blockedCount, 22);
    assert.deepEqual(
      next?.plan?.blocked.map((b) => b.id),
      unbound.slice(0, 20),
    );
    assert.deepEqual(next?.plan?.review, [ready]);
    assert.match(
      next.plan.blocked[0].reason,
      /^для backend сначала привяжите утверждённый контракт/,
    );
    assert.ok(next.detail.includes(`${unbound[0]} — для backend`), 'id не повторяется');
    assert.match(next.detail, /fail approval preconditions/);
    assert.match(next.detail, /… ещё 2: host\.next\.plan\.blocked/);
    assert.match(next.detail, /edit-task --task ID/);
    assert.match(next.detail, new RegExp(`--tasks ${ready} --author-runtime`));
    assert.match(next.detail, /story bindings/);
  } finally {
    f.cleanup();
  }
});

test('session_handoff: approvalMode operator — задания не идут, шаг оператора', () => {
  const f = fixture();
  try {
    const h = new DevContour(
      f.store,
      config({ checkoutRoot: f.h.config.checkoutRoot, approvalMode: 'operator' }),
    );
    const { board, task, at, start } = oneBoard(h);
    start();
    h.pause(false);
    const run = h.claim('test')!;
    assert.equal(run.taskId, task);
    h.fail(run.id, run.token, 'candidate/typecheck: error', false, 'gate');
    const value = at();
    assert.deepEqual(value.host.liveBoards, [], 'в режиме оператора задания не продолжаются');
    assert.equal(value.host.next?.action, 'operator');
    assert.match(value.host.next.detail, /devcontour queue --start/);
    assert.ok(value.pack.works.some((w) => w.id === task));
    assert.ok(!value.pack.stops.some((s) => s.workId === task && s.retryPlanned));
    assert.ok(value.pack.repairs.every((r) => r.graphId === board));
  } finally {
    f.cleanup();
  }
});

test('session_handoff: маска — секреты контура, политики и профилей инструментов, MCP и forge; короткие наследуемые значения не маскируются', () => {
  const names = [
    'DC_HANDOFF_SECRET',
    'DC_HANDOFF_INHERIT',
    'DC_HANDOFF_SHORT',
    'DC_HANDOFF_TOOL',
    'DC_HANDOFF_MCP',
    'DC_HANDOFF_MCPENV_SHORT',
    'DC_HANDOFF_MCPENV_LONG',
  ] as const;
  const previous = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  const SECRET = 'okapi-secret-value-4815162342';
  const INHERITED = 'okapi-inherited-value-2342';
  const TOOL = 'okapi-tool-profile-secret-77';
  const MCP = 'okapi-mcp-bearer-token-99';
  process.env.DC_HANDOFF_SECRET = SECRET;
  process.env.DC_HANDOFF_INHERIT = INHERITED;
  process.env.DC_HANDOFF_SHORT = '3';
  process.env.DC_HANDOFF_TOOL = TOOL;
  process.env.DC_HANDOFF_MCP = MCP;
  const MCP_ENV = 'okapi-mcp-env-credential-55';
  process.env.DC_HANDOFF_MCPENV_SHORT = 'of';
  process.env.DC_HANDOFF_MCPENV_LONG = MCP_ENV;
  const f = fixture();
  try {
    const h = new DevContour(
      f.store,
      config({
        checkoutRoot: f.h.config.checkoutRoot,
        environment: {
          inherit: ['DC_HANDOFF_INHERIT', 'DC_HANDOFF_SHORT'],
          values: {},
          secrets: { API_TOKEN: 'DC_HANDOFF_SECRET' },
        },
        toolProfiles: {
          reviewer: {
            runtime: 'claude',
            environment: { inherit: [], values: {}, secrets: { TOOL_TOKEN: 'DC_HANDOFF_TOOL' } },
            mcp: {
              docs: {
                transport: 'http',
                url: 'https://mcp.example.test/',
                bearerTokenEnv: 'DC_HANDOFF_MCP',
                env: ['DC_HANDOFF_MCPENV_SHORT', 'DC_HANDOFF_MCPENV_LONG'],
                tools: ['search'],
              },
            },
          },
        },
      } as unknown as Partial<Config>),
    );
    const board = h.createBoard('Secret board', '', 'main');
    h.addTask(board.id, input('Task with a secret in its error'));
    h.approve(board.id);
    h.pause(false);
    const run = h.claim('test')!;
    h.fail(
      run.id,
      run.token,
      `attempt 3 of 3: ${SECRET} ${INHERITED} ${TOOL} ${MCP} ${MCP_ENV} leaked`,
      false,
      'gate',
    );
    const text = JSON.stringify(devcontourHandoff(h).pack);
    assert.ok(text.includes('attempt 3 of 3'), 'короткое наследуемое значение не маскирует текст');
    assert.ok(text.includes('leaked'));
    for (const value of [SECRET, INHERITED, TOOL, MCP, MCP_ENV])
      assert.ok(!text.includes(value), 'замаскировано: ' + value);
    const forge = handoffRedactor(
      {
        ...h.config,
        forgeConnections: { origin: { tokenEnv: 'DC_HANDOFF_FORGE' } },
      } as unknown as Config,
      {},
      { DC_HANDOFF_FORGE: 'forge-token-123456789' },
    );
    assert.ok(!forge('auth forge-token-123456789').includes('forge-token-123456789'));
    // Секрет политики harness без пары в конфигурации — тоже маскируется.
    const policy = handoffRedactor(
      h.config,
      { repositories: [{ environment: { secrets: { X: 'DC_POLICY_ONLY' } } }] },
      { DC_POLICY_ONLY: 'policy-only-secret-1234' },
    );
    assert.ok(!policy('policy-only-secret-1234').includes('policy-only-secret-1234'));
  } finally {
    for (const n of names)
      if (previous[n] === undefined) delete process.env[n];
      else process.env[n] = previous[n];
    f.cleanup();
  }
});

test('session_handoff: предел ответа 64 KiB на настоящем пакете — JSON и Markdown, подсказка полного пакета', () => {
  const f = fixture();
  try {
    const board = f.h.createBoard('Large board', '', 'main');
    const tasks = Array.from(
      { length: 50 },
      (_, i) =>
        f.h.addTask(board.id, input(`Task ${i} ` + 'with a long descriptive title '.repeat(5))).id,
    );
    f.h.approve(board.id);
    const long = (i: number) =>
      `failure ${i}: ` + 'expected value differs from actual; '.repeat(12);
    for (let i = 0; i < tasks.length; i++) {
      f.h.pause(false);
      const run = f.h.claim('test')!;
      f.h.fail(run.id, run.token, long(i), false, 'gate');
    }
    const intentions = Array.from({ length: 20 }, (_, i) => `intention ${i} ` + 'y'.repeat(900));
    const whole = devcontourHandoff(f.h, { intentions }).pack;
    assert.ok(
      Buffer.byteLength(JSON.stringify(whole)) > AGENT_HANDOFF_BYTES,
      'полный пакет больше предела ответа',
    );
    const agent = new AgentService(f.h, f.root);
    for (const format of ['json', 'md'] as const) {
      const value = agent.execute({
        operation: 'session_handoff',
        input: { format, intentions },
      }) as unknown as JsonHandoff | MdHandoff;
      const bytes = Buffer.byteLength(JSON.stringify(value));
      assert.ok(bytes <= 65536, format + ': весь ответ в пределе каталога');
      // Без подсказки `full` ответ — в пределе операции.
      const response = JSON.stringify({ ...value, full: undefined });
      assert.ok(
        Buffer.byteLength(response) <= AGENT_HANDOFF_BYTES,
        format + ': ответ без подсказки в пределе операции',
      );
      // Урезано не сильно ниже предела: не дальше 10% от него.
      assert.ok(
        bytes >= AGENT_HANDOFF_BYTES * 0.9,
        `${format}: ответ ${bytes} байт — слишком далеко ниже предела ${AGENT_HANDOFF_BYTES}`,
      );
      assert.equal(value.full, HANDOFF_FULL_HINT, format + ': подсказка полного пакета');
      assert.match(value.full, /--intent TEXT/);
      if (value.format === 'json') {
        const pack = handoffPackSchema.parse(value.pack);
        assert.equal(pack.truncated.bySize, true);
        assert.ok(pack.truncated.intentionsDropped > 0, 'первыми уходят намерения');
      } else assert.match(value.markdown, /^# Передача контекста/);
    }
  } finally {
    f.cleanup();
  }
});

test('session-handoff: CLI читает базу только для чтения; ответ того же вида, что у операции; --intent=, --out', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dc-handoff-')));
  const data = join(root, 'data');
  const out = join(root, 'handoff.md');
  try {
    await mkdir(data);
    const c = config();
    await writeFile(join(data, 'config.json'), JSON.stringify(c));
    const h = new DevContour(new Store(join(data, 'state.sqlite')), c);
    let ids: ReturnType<typeof boards>;
    try {
      ids = boards(h, { job: true });
    } finally {
      h.store.close();
    }
    const before = dbFingerprint(join(data, 'state.sqlite'));
    const cli = (...args: string[]) =>
      command(
        ['node', '--import', 'tsx', 'src/cli.ts', 'session-handoff', ...args, '--data', data],
        process.cwd(),
      );
    // Каталог данных без права записи: writer базу открыть не смог бы.
    const files = (await readdir(data)).map((n) => join(data, n));
    for (const file of files) await chmod(file, 0o444);
    await chmod(data, 0o555);
    let json, md, html, written;
    try {
      json = await cli('--board', ids.a, '--intent', INTENT, '--intent=--starts with dashes');
      md = await cli('--format', 'md');
      html = await cli('--format', 'html');
      written = await cli('--format', 'md', '--out', out);
    } finally {
      await chmod(data, 0o755);
      for (const file of files) await chmod(file, 0o644);
    }
    assert.equal(json.code, 0, json.stderr);
    const value = JSON.parse(json.stdout) as JsonHandoff;
    assert.deepEqual(Object.keys(value).sort(), ['commands', 'format', 'host', 'pack']);
    assert.equal(value.format, 'json');
    const pack = handoffPackSchema.parse(value.pack);
    assert.equal(pack.graphId, ids.a);
    assert.deepEqual(pack.intentions, [INTENT, '--starts with dashes']);
    assert.ok(value.commands['harness run']);
    assert.deepEqual(value.host.liveBoards, [ids.b]);
    assert.equal(md.code, 0, md.stderr);
    assert.match(md.stdout, /^# Передача контекста/);
    assert.match(md.stdout, /## В DevContour/);
    assert.notEqual(html.code, 0);
    assert.match(html.stderr, /json или md/);
    assert.equal(written.code, 0, written.stderr);
    const receipt = JSON.parse(written.stdout) as { out: string; format: string; bytes: number };
    assert.equal(receipt.out, out);
    assert.equal(receipt.format, 'md');
    const text = await readFile(out, 'utf8');
    assert.equal(Buffer.byteLength(text), receipt.bytes);
    assert.match(text, /^# Передача контекста/);
    assert.equal((await stat(out)).mode & 0o777, 0o600, 'новый файл только для владельца');
    const inside = await cli('--out', join(data, 'handoff.json'));
    assert.notEqual(inside.code, 0, 'в каталог данных контура не пишет');
    assert.equal(dbFingerprint(join(data, 'state.sqlite')), before, 'база не изменилась');
  } finally {
    assert.ok(root.startsWith(await realpath(tmpdir())) && root.includes('dc-handoff-'));
    await rm(root, { recursive: true, force: true });
  }
});

function mkdtempSyncSafe() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'dc-handoff-read-')));
}
/** Удаление только созданного здесь временного каталога. */
function rmFixture(root: string) {
  assert.ok(root.startsWith(realpathSync(tmpdir())) && root.includes('dc-handoff-read-'));
  rmSync(root, { recursive: true, force: true });
}

test('session_handoff: задание стоит на задаче, отменённой ведущим после бюджетного отказа — host.next называет законные пути', async () => {
  for (const othersDone of [true, false]) {
    const f = fixture();
    try {
      const b = f.h.createBoard('Budget stop', '', 'main');
      const stopped = f.h.addTask(b.id, input('Hits the workspace budget'));
      const kept = f.h.addTask(b.id, input('Kept'));
      f.h.approve(b.id);
      const flow = new LeadWorkflow(f.h);
      const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
      f.h.pause(false);
      const run = f.h.claim('test')!;
      assert.equal(run.taskId, stopped.id);
      f.h.fail(run.id, run.token, 'workspace budget exceeded', false, 'budget');
      f.h.cancel(stopped.id, 'Budget stop', 'host');
      if (othersDone) complete(f.h, kept.id);
      const runner = new LeadRunner(f.h, f.root);
      for (let i = 0; i < 4; i++) await runner.tick();
      await runner.stop();
      assert.equal(flow.get(job.key, 'main').status, 'failed');
      for (const value of [devcontourHandoff(f.h, {}), devcontourHandoff(f.h, { boardId: b.id })]) {
        const next = value.host.next;
        assert.equal(next?.code, 'job-cancelled-task', JSON.stringify(next));
        assert.equal(next?.action, 'decide');
        assert.equal(next?.decision, 'job');
        assert.equal(next?.boardId, b.id);
        assert.equal(next?.job?.key, job.key);
        assert.deepEqual(
          { ...(next?.params as Record<string, unknown>), error: undefined },
          { taskId: stopped.id, by: 'host', budget: true, live: false, error: undefined },
        );
        // Законные пути: подъём бюджета пользователем и повтор задачи и задания,
        // либо приёмка ревизии без задачи пользователем.
        assert.match(next.detail, /devcontour config-apply --keys budgets/);
        assert.match(next.detail, new RegExp(`devcontour retry --task ${stopped.id} --by host`));
        assert.match(next.detail, /workflow_retry \{"key": /);
        // Приёмку без задачи ведущему называют действием оператора в панели,
        // а не командой, которую он выполнил бы сам.
        assert.doesNotMatch(next.detail, /devcontour accept/);
        assert.match(next.detail, /the operator accepts the revision without task .* in the panel/);
        assert.match(
          next.detail,
          /do not raise budgets, retry the task or accept the board yourself/,
        );
      }
      // Правило D46 не ослаблено: повтор задания без решения падает снова.
      flow.retry(job.key, 'main');
      const again = new LeadRunner(f.h, f.root);
      for (let i = 0; i < 3; i++) await again.tick();
      await again.stop();
      assert.equal(flow.get(job.key, 'main').status, 'failed');
      assert.notEqual(f.store.read().boards[0].revisions.at(-1)!.status, 'accepted');
    } finally {
      f.cleanup();
    }
  }
});

test('session_handoff: отмена ведущим выданной задачи без бюджета — повтор задачи ведущим, приёмка без неё — пользователем', async () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Lead cut after issue', '', 'main');
    const stopped = f.h.addTask(b.id, input('Fails its gate'));
    const kept = f.h.addTask(b.id, input('Kept'));
    f.h.approve(b.id);
    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
    f.h.pause(false);
    const run = f.h.claim('test')!;
    f.h.fail(run.id, run.token, 'gate failed', false, 'gate');
    f.h.cancel(stopped.id, 'Not worth it', 'host');
    complete(f.h, kept.id);
    const runner = new LeadRunner(f.h, f.root);
    for (let i = 0; i < 4; i++) await runner.tick();
    await runner.stop();
    const next = devcontourHandoff(f.h, {}).host.next;
    assert.equal(next?.code, 'job-cancelled-task');
    assert.equal((next?.params as { budget: boolean }).budget, false);
    assert.doesNotMatch(next.detail, /config-apply/);
    assert.match(next.detail, /if the task is still needed, task_retry/);
    assert.match(next.detail, /Accepting without the task is the user's decision/);
    // Повтор задачи ведущим снимает отмену: шаг больше не о ней.
    f.h.retry(stopped.id, undefined, 'host');
    assert.notEqual(devcontourHandoff(f.h, {}).host.next?.code, 'job-cancelled-task');
    assert.ok(job.key);
  } finally {
    f.cleanup();
  }
});

/** Доска с задачей, упавшей на бюджете после выдачи, и задание доски. */
function budgetStop(h: DevContour) {
  const b = h.createBoard('Budget stop', '', 'main');
  const stopped = h.addTask(b.id, input('Hits the workspace budget'));
  const kept = h.addTask(b.id, input('Kept'));
  h.approve(b.id);
  const flow = new LeadWorkflow(h);
  const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex' });
  h.pause(false);
  const run = h.claim('test')!;
  assert.equal(run.taskId, stopped.id);
  h.fail(run.id, run.token, 'workspace budget exceeded', false, 'budget');
  return { board: b.id, stopped: stopped.id, kept: kept.id, flow, job };
}

test('session_handoff: бюджетная остановка и отмена человеком — задачу повторяет пользователь, task_retry ведущего отказан', async () => {
  for (const legacy of [false, true]) {
    const f = fixture();
    try {
      const { stopped, kept, flow, job } = budgetStop(f.h);
      f.h.cancel(stopped, 'Not worth the budget', 'operator');
      if (legacy)
        f.store.change('fixture.legacy', (s) => {
          delete s.tasks.find((t) => t.id === stopped)!.cancelledBy;
        });
      complete(f.h, kept);
      const runner = new LeadRunner(f.h, f.root);
      for (let i = 0; i < 4; i++) await runner.tick();
      await runner.stop();
      assert.equal(flow.get(job.key, 'main').status, 'failed');
      const next = devcontourHandoff(f.h, {}).host.next!;
      assert.equal(next.code, 'job-cancelled-task');
      assert.equal((next.params as { by: string }).by, legacy ? 'unknown' : 'operator');
      assert.doesNotMatch(
        next.detail,
        /--by host/,
        'ведущему не предлагают повторить отмену человека',
      );
      assert.match(
        next.detail,
        /the user retries the task in the panel \(the retry action on the task page; ask the user\), then workflow_retry/,
      );
      // Ни одной команды повтора: CLI retry без --by — повтор человеком, он
      // обошёл бы отказ сервиса.
      assert.doesNotMatch(next.detail, /devcontour retry/);
      // Сервис отказывает ведущему и при попытке повторить такую задачу.
      await assert.rejects(
        new AgentService(f.h, f.root).run({ operation: 'task_retry', input: { taskId: stopped } }),
        (e: unknown) => status(e) === 409 && /решение пользователя/.test(String(e)),
      );
      assert.equal(f.store.read().tasks.find((t) => t.id === stopped)!.status, 'cancelled');
      // Повтор оператором допустим.
      f.h.retry(stopped, undefined, 'operator');
      assert.notEqual(f.store.read().tasks.find((t) => t.id === stopped)!.status, 'cancelled');
    } finally {
      f.cleanup();
    }
  }
});

test('session_handoff: исчерпанное задание на отменённой задаче остаётся job-exhausted, действующее — без workflow_retry', () => {
  // Исчерпанное: workflow_retry его не примет — шаг прежний job-exhausted.
  {
    const f = fixture();
    try {
      const { stopped, kept, job } = budgetStop(f.h);
      f.h.cancel(stopped, 'Budget stop', 'host');
      complete(f.h, kept);
      const exhausted = atStage(f.h, job.key, 'main', 1, {
        status: 'failed',
        attempts: job.maxAttempts,
        error: `${stopped}: Работа остановлена человеком.`,
      });
      assert.equal(exhausted.status, 'failed');
      const next = devcontourHandoff(f.h, {}).host.next;
      assert.equal(next?.code, 'job-exhausted', JSON.stringify(next));
    } finally {
      f.cleanup();
    }
  }
  // Действующее: после повтора задачи задание продолжится само.
  {
    const f = fixture();
    try {
      const { stopped, job } = budgetStop(f.h);
      f.h.cancel(stopped, 'Budget stop', 'host');
      atStage(f.h, job.key, 'main', 1);
      const next = devcontourHandoff(f.h, {}).host.next!;
      assert.equal(next.code, 'job-cancelled-task', JSON.stringify(next));
      assert.equal((next.params as { live: boolean }).live, true);
      assert.doesNotMatch(next.detail, /workflow_retry \{/);
      assert.match(next.detail, /the live job then continues on its own/);
    } finally {
      f.cleanup();
    }
  }
});

test('session_handoff: задачу убрала новая редакция графа (by graph) — так и названо', async () => {
  const f = fixture();
  try {
    const { stopped, kept, flow, job } = budgetStop(f.h);
    f.h.cancel(stopped, 'Budget stop', 'host');
    f.store.change('fixture.graph', (s) => {
      s.tasks.find((t) => t.id === stopped)!.cancelledBy = 'graph';
    });
    complete(f.h, kept);
    const runner = new LeadRunner(f.h, f.root);
    for (let i = 0; i < 4; i++) await runner.tick();
    await runner.stop();
    assert.equal(flow.get(job.key, 'main').status, 'failed');
    const next = devcontourHandoff(f.h, {}).host.next!;
    assert.equal(next.code, 'job-cancelled-task');
    assert.equal((next.params as { by: string }).by, 'graph');
    assert.match(next.detail, /removed by a new revision of the board graph/);
    assert.doesNotMatch(next.detail, /without a recorded actor/);
  } finally {
    f.cleanup();
  }
});

test('session_handoff: задача, отменённая до выдачи, — не job-cancelled-task (отмена объёма плана, а не остановка работы)', () => {
  const f = fixture();
  try {
    const b = f.h.createBoard('Replanned board', '', 'main');
    const dropped = f.h.addTask(b.id, input('Dropped before issue'));
    f.h.addTask(b.id, input('Kept'));
    f.h.approve(b.id);
    f.h.cancel(dropped.id, 'Replanned', 'operator');
    const flow = new LeadWorkflow(f.h);
    const job = flow.start({ kind: 'board', id: b.id, authorRuntime: 'codex', maxAttempts: 3 });
    flow.fail(flow.claim(job.key, job.owner)!, 'review failed');
    const next = devcontourHandoff(f.h, {}).host.next;
    assert.ok(next, 'шаг есть');
    assert.notEqual(next.code, 'job-cancelled-task', JSON.stringify(next));
  } finally {
    f.cleanup();
  }
});
