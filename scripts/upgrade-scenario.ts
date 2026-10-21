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
 *                 попытку B прежней версии не продолжает; после истечения —
 *                 recovery и новая попытка с новым владением; A не меняется.
 * crash         — версия «после» оставляет живую роль (аварийная остановка).
 * old-refuses   — версия «до» над состоянием с ролью новой версии: отказ до
 *                 записи и выдачи.
 *
 * Итог шага — JSON в stdout; несоответствие — исключение и ненулевой exit.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configSchema } from '../src/core/model.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';

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
  return run;
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
  store.close();
  out({
    liveRefused: live,
    previousAttempt: { id: old.id, status: old.status },
    newAttempt: { id: fresh.id, engineVersion: engineOf(fresh) },
    leader: s.leader,
  });
} else if (step === 'crash') {
  const { store, h } = open();
  assert.equal(h.leader('controller-3'), true);
  const s = store.read();
  assert.equal(engineOf(s.leader), harnessVersion);
  store.close();
  out({ leader: s.leader });
} else if (step === 'old-refuses') {
  const hash = sha256(database);
  let refusal: string | undefined;
  try {
    const { store, h } = open();
    try {
      h.leader('controller-old');
      h.claim('controller-old');
    } finally {
      store.close();
    }
  } catch (error) {
    refusal = String((error as Error).message ?? error);
  }
  assert.ok(refusal, 'версия «до» открыла состояние с ролью новой версии');
  assert.equal(sha256(database), hash, 'отказ после записи: база изменилась');
  out({ refusal: refusal.slice(0, 300), unchanged: true });
} else {
  console.error('upgrade-scenario: неизвестный шаг ' + step);
  process.exit(2);
}
