/**
 * Шаги состояния для проверки обновления (`scripts/upgrade-check.mjs`):
 * запускаются из checkout с той версией пакета harness, которая сейчас
 * установлена, над одним и тем же каталогом состояния.
 *
 *   node --import tsx scripts/upgrade-scenario.ts <шаг> <каталог состояния>
 *
 * before        — версия «до»: задача A принята, задача B выдана и активна,
 *                 роль controller жива (процесс остановлен аварийно).
 * after         — версия «после»: живую роль прежнего процесса не перенимает,
 *                 попытку B прежней версии не продолжает; после истечения
 *                 попытка завершается явно (задача ждёт повтора), явный
 *                 повтор — новая попытка с новым владением; A не меняется.
 *                 Новая версия пишет по одной записи нового вида: поручение
 *                 быстрого маршрута, вопрос исполнителя (неблокирующий запрос
 *                 ведущему от новой попытки), заметку обсуждения и отметку
 *                 центра внимания.
 * crash         — версия «после» оставляет живую роль (аварийная остановка);
 *                 записи нового вида и журнал до них не изменились.
 * old-refuses   — версия «до» над состоянием с ролью новой версии: отказ до
 *                 записи или (движок, знающий версию роли) роль не перенята и
 *                 ничего не выдано; база не меняется.
 *
 * Итог шага — JSON в stdout; несоответствие — исключение и ненулевой exit.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configSchema } from '../src/core/model.ts';
import { Preparation } from '../src/core/preparation.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { AttentionService } from '../src/application/attention.ts';
import { DiscussionService } from '../src/application/discussion.ts';
import { executionOf } from '../src/harness/execution.ts';

const [step, dir] = process.argv.slice(2);
if (!step || !dir) {
  console.error('upgrade-scenario: <before|after|crash|old-refuses> <каталог состояния>');
  process.exit(2);
}
const harnessVersion = (
  JSON.parse(
    readFileSync(
      new URL('../node_modules/devcontour-harness/package.json', import.meta.url),
      'utf8',
    ),
  ) as { version: string }
).version;
const database = join(dir, 'state.sqlite');
const snapshotFile = join(dir, 'snapshot.json');
const seededFile = join(dir, 'seeded.json');
// Срок роли и попытки: с запасом на запуск шага «после», но короткий.
const LEASE_MS = 20_000;
const SHA_CANDIDATE = 'c'.repeat(40);
const SHA_MERGED = 'b'.repeat(40);
const DIGEST = 'e'.repeat(64);

const config = configSchema.parse({
  version: 1,
  name: 'Upgrade check',
  repository: dir,
  mode: 'demo',
  concurrency: 2,
  leaseMs: LEASE_MS,
  roles: { qa: { runtime: 'demo' } },
  reviewer: { runtime: 'demo' },
  gates: [
    {
      id: 'test',
      kind: 'test',
      command: ['node', 'verify.mjs'],
      report: { type: 'junit', path: '.reports/junit.xml' },
    },
  ],
});
const task = (title: string) => ({
  title,
  description: 'An observable independent outcome.',
  role: 'qa',
  dependsOn: [],
  acceptance: ['The expected result is checked.'],
});
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const open = () => {
  const store = new Store(database);
  return { store, h: new DevContour(store, config) };
};
/** Версия движка из записи (поле harness, в модели DevContour не объявлено). */
const engineOf = (record: object | undefined) =>
  (record as { engineVersion?: string } | undefined)?.engineVersion;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (value: unknown) =>
  console.log(JSON.stringify({ step, harnessVersion, ...(value as object) }, null, 2));

function accept(h: DevContour, owner: string, id: string) {
  const run = h.claim(owner);
  assert.equal(run?.taskId, id);
  complete(h, run);
  return run;
}

/** Обе фазы с прошедшими проверками и принятие выданной попытки. */
function complete(h: DevContour, run: { id: string; token: string }) {
  h.phase(run.id, run.token, 'integrating', {
    candidateSha: SHA_CANDIDATE,
    integrationSha: SHA_MERGED,
  });
  for (const phase of ['candidate', 'integration'] as const)
    for (const kind of ['test', 'review'] as const)
      h.evidence(run.id, run.token, {
        kind,
        phase,
        sha: phase === 'candidate' ? SHA_CANDIDATE : SHA_MERGED,
        gate: kind === 'test' ? 'test' : 'independent-review',
        passed: true,
        command: ['fixture'],
        exitCode: 0,
        log: 'fixture',
        digest: DIGEST,
        summary: 'Upgrade fixture',
      });
  h.finish(run.id, run.token, SHA_MERGED);
}

/**
 * Записи нового вида и журнал: по ним шаг «crash» видит, что новая версия
 * при следующем открытии ничего из записанного не потеряла и не переписала.
 */
function newRecords(store: Store, h: DevContour, accepted: string) {
  const change = store.read().preparation?.changes.find((c) => c.intake);
  return {
    quick: change && { id: change.id, intake: change.intake },
    discussion: new DiscussionService(h).read({ taskId: accepted }).messages,
    attention: new AttentionService(store, h).marks(),
    input: executionOf(h).engine.inputRequests(),
    events: store.allEvents(),
  };
}

if (step === 'before') {
  const { store, h } = open();
  const board = h.createBoard('Upgrade');
  const a = h.addTask(board.id, task('Accepted before the upgrade'));
  const b = h.addTask(board.id, task('Active during the upgrade'));
  h.approve(board.id);
  h.pause(false);
  assert.equal(h.leader('controller-1'), true);
  accept(h, 'controller-1', a.id);
  const active = h.claim('controller-1');
  assert.equal(active?.taskId, b.id);
  h.heartbeat(active.id, active.token);
  const s = store.read();
  const snapshot = {
    a: { task: s.tasks.find((t) => t.id === a.id), runs: s.runs.filter((r) => r.taskId === a.id) },
    b: { id: b.id, run: active.id, token: active.token },
    leader: s.leader,
  };
  store.close();
  writeFileSync(snapshotFile, JSON.stringify(snapshot));
  out({ accepted: a.id, active: { task: b.id, run: active.id }, leader: s.leader });
} else if (step === 'after') {
  const before = JSON.parse(readFileSync(snapshotFile, 'utf8')) as {
    a: { task: unknown; runs: unknown[] };
    b: { id: string; run: string; token: string };
    leader: { owner: string; leaseUntil: number };
  };
  const { store, h } = open();
  // Живая роль прежнего процесса (тот же владелец, роль без версии движка):
  // новая версия её не перенимает и ничего не выдаёт.
  const live = before.leader.leaseUntil > Date.now() + 2000;
  if (live) {
    assert.equal(h.leader(before.leader.owner), false, 'живая роль прежней версии перенята');
    assert.equal(h.claim(before.leader.owner), undefined, 'выдача под живой ролью прежней версии');
    const run = store.read().runs.find((r) => r.id === before.b.run)!;
    assert.equal(run.status, 'active', 'попытка прежней версии изменена до истечения роли');
  }
  // Роль и попытка истекают: recovery завершает попытку прежней версии.
  await sleep(Math.max(0, before.leader.leaseUntil - Date.now()) + LEASE_MS + 200);
  h.expire();
  const old = store.read().runs.find((r) => r.id === before.b.run)!;
  assert.notEqual(old.status, 'active', 'попытка прежней версии продолжается');
  assert.notEqual(old.status, 'succeeded', 'ложный успех попытки прежней версии');
  assert.throws(() => h.heartbeat(old.id, before.b.token), 'старый token принят');
  // Истёкшая попытка завершена явно: задача ждёт явного повтора человека, а
  // не продолжается под новой версией сама.
  const stopped = store.read().tasks.find((t) => t.id === before.b.id)!;
  assert.equal(stopped.status, 'failed', 'задача прежней попытки не завершена явно');
  h.retry(before.b.id);
  assert.equal(h.leader('controller-2'), true);
  const next = h.claim('controller-2');
  assert.equal(next?.taskId, before.b.id, 'B не выдана новой попыткой');
  assert.notEqual(next.id, before.b.run);
  assert.notEqual(next.token, before.b.token);
  const s = store.read();
  const fresh = s.runs.find((r) => r.id === next.id)!;
  assert.equal(engineOf(fresh), harnessVersion, 'новая попытка не под новой версией движка');
  assert.equal(engineOf(s.leader), harnessVersion, 'роль controller без версии движка');
  assert.deepEqual(
    {
      task: s.tasks.find((t) => t.id === (before.a.task as { id: string }).id),
      runs: s.runs.filter((r) => r.taskId === (before.a.task as { id: string }).id),
    },
    before.a,
    'принятая задача изменена обновлением',
  );
  // Новая попытка оставляет неблокирующий запрос ведущему (без модели: тот же
  // вызов движка, что и после ответа исполнителя), оператор пишет заметку к
  // принятой задаче и отмечает первую карточку центра внимания прочитанной.
  executionOf(h).engine.recordAssumptions(next.id, next.token, {
    assumptions: [],
    followUps: [
      {
        question: {
          question: 'Which name should the footer link use?',
          options: [],
          recommended: null,
          severity: 3,
          rationale: 'Upgrade fixture follow-up',
          affects: [],
        },
        effectiveSeverity: 3,
        floors: [],
      },
    ],
    criticalHits: [],
    callId: null,
  });
  // Новая попытка доходит до принятия: неблокирующий запрос её не держит.
  complete(h, next);
  assert.equal(store.read().tasks.find((t) => t.id === before.b.id)!.status, 'done');
  // Поручение быстрого маршрута — после работы очереди: оно включает
  // подготовку, а включение требует, чтобы активных попыток не было.
  new Preparation(store, 'operator').execute('preparation_quick', {
    requestKey: 'upgrade-quick-1',
    title: 'Quick change after the upgrade',
    repository: dir,
    brief: 'Add a footer link to the docs page.',
    criterion: 'The footer shows the link.',
  });
  const acceptedId = (before.a.task as { id: string }).id;
  new DiscussionService(h).post(
    {
      taskId: acceptedId,
      kind: 'note',
      text: 'Accepted before the upgrade; checked after it.',
      idempotencyKey: 'upgrade-note-1',
      expectedVersion: 0,
    },
    'operator',
  );
  const attention = new AttentionService(store, h);
  const [card] = (await attention.active()).items;
  assert.ok(card, 'центр внимания без карточек');
  const marked = await attention.mark({
    marks: [
      {
        sourceKey: card.sourceKey,
        occurrenceId: card.occurrenceId,
        version: card.sourceVersion,
        kind: 'read',
      },
    ],
  });
  assert.equal(marked.marked.length, 1, 'отметка центра внимания не записана');
  const seeded = newRecords(store, h, acceptedId);
  assert.ok(seeded.quick, 'поручение быстрого маршрута не записано');
  assert.equal(seeded.discussion.length, 1, 'заметка обсуждения не записана');
  assert.equal(Object.keys(seeded.attention).length, 1, 'отметка центра внимания не записана');
  assert.deepEqual(
    seeded.input.map((r) => [r.kind, r.blocking, r.workId, r.lifecycle]),
    [['follow-up', false, before.b.id, 'pending']],
    'запрос ведущему не записан',
  );
  store.close();
  writeFileSync(seededFile, JSON.stringify({ accepted: acceptedId, ...seeded }));
  out({
    seeded: {
      quick: seeded.quick?.id,
      discussion: seeded.discussion.map((m) => m.id),
      attention: Object.keys(seeded.attention),
      input: seeded.input.map((r) => r.id),
    },
    liveRefused: live,
    previousAttempt: { id: old.id, status: old.status, task: stopped.status },
    newAttempt: { id: fresh.id, engineVersion: engineOf(fresh) },
    leader: s.leader,
  });
} else if (step === 'crash') {
  const { store, h } = open();
  // Тот же процесс новой версии продлевает роль и останавливается аварийно.
  assert.equal(h.leader('controller-2'), true);
  const s = store.read();
  assert.equal(engineOf(s.leader), harnessVersion);
  // Записи нового вида пережили повторное открытие: те же, журнал до них
  // прежний (продление роли событий не пишет — допускаются только новые).
  const seeded = JSON.parse(readFileSync(seededFile, 'utf8')) as ReturnType<typeof newRecords> & {
    accepted: string;
  };
  const now = JSON.parse(JSON.stringify(newRecords(store, h, seeded.accepted))) as ReturnType<
    typeof newRecords
  >;
  store.close();
  assert.deepEqual(now.quick, seeded.quick, 'поручение быстрого маршрута изменилось');
  assert.deepEqual(now.discussion, seeded.discussion, 'обсуждение изменилось');
  assert.deepEqual(now.attention, seeded.attention, 'отметки центра внимания изменились');
  assert.deepEqual(now.input, seeded.input, 'запрос ведущему изменился');
  assert.deepEqual(
    now.events.slice(0, seeded.events.length),
    seeded.events,
    'журнал до записей нового вида изменился',
  );
  out({ leader: s.leader, newRecords: 'unchanged' });
} else if (step === 'old-refuses') {
  const hash = sha256(database);
  // Версия «до» над живой ролью новой версии: либо отказ до записи (движок,
  // не знающий поля версии в роли), либо роль не перенята и ничего не выдано
  // (движок, знающий его). В обоих случаях база не меняется.
  let refusal: string | undefined;
  let lead: boolean | undefined;
  let issued: boolean | undefined;
  try {
    const { store, h } = open();
    try {
      lead = h.leader('controller-old');
      issued = Boolean(h.claim('controller-old'));
    } finally {
      store.close();
    }
  } catch (error) {
    refusal = String((error as Error).message ?? error);
  }
  assert.ok(
    refusal || (lead === false && issued === false),
    'версия «до» перенята роль новой версии или выдала работу',
  );
  assert.equal(sha256(database), hash, 'база изменилась');
  out({
    ...(refusal ? { refusal: refusal.slice(0, 300) } : { lead, issued }),
    unchanged: true,
  });
} else {
  console.error('upgrade-scenario: неизвестный шаг ' + step);
  process.exit(2);
}
