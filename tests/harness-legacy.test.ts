import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { WORKSPACE_OWNER, digestOf } from 'devcontour-harness';
import { configSchema, type Config } from '../src/core/model.ts';
import { canonical, type CompletionReceipt } from '../src/core/sync-model.ts';
import type { UsageRecord } from '../src/core/usage.ts';
import { Store } from '../src/core/store.ts';
import {
  DevContour,
  contextDigest,
  dependencyDigest,
  scopeDigest,
  specDigest,
} from '../src/core/service.ts';
import { CheckCorpus } from '../src/core/check-store.ts';
import { effectiveChecks } from '../src/core/checks.ts';
import { LeadWorkflow } from '../src/core/lead-workflow.ts';
import { Workspace } from '../src/core/workspace.ts';
import { repositories } from '../src/core/repositories.ts';
import { DevContourExecutionStore } from '../src/harness/store.ts';
import { executionOf } from '../src/harness/execution.ts';
import { dataDoctor } from '../src/runner/doctor.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { syncGit } from '../src/runner/git-sync.ts';
import { requirementReport } from '../src/runner/requirements.ts';
import { closePrevious, complete, config as testConfig } from './helpers.ts';
import { reviewContract, reviewPlan } from '../src/runner/agent-control.ts';
import type { AgentAdapter, AgentRequest } from '../src/runner/adapters.ts';

// Базы, записанные кодом прежней версии (tests/fixtures/legacy/generate.ts).
// Новый код открывает их копии без setup, миграции и правки базы.
/**
 * Абсолютные пути компонента входят в digest политики попыток прежней версии,
 * поэтому копия открывается по тому же пути, по которому её записала прежняя
 * версия, и тем же загрузчиком, что у `serve` (`loadConfig` разрешает ссылки).
 * Путь канонический для своей платформы: на macOS `/tmp` — ссылка, поэтому
 * вариант `legacy-darwin` записан по `/private/tmp/…`, а `legacy` (Linux) —
 * по `/tmp/…`. Берётся вариант, чей путь на этой машине канонический.
 */
const canonicalPath = (path: string) => {
  try {
    return realpathSync(dirname(path)) === dirname(path);
  } catch {
    return false;
  }
};
const variant = ['legacy', 'legacy-darwin']
  .map((name) => fileURLToPath(new URL(`./fixtures/${name}/`, import.meta.url)))
  .map((dir) => ({ dir, root: readFileSync(join(dir, 'ROOT'), 'utf8').trim() }))
  .find((v) => canonicalPath(v.root));
if (!variant) throw new Error('Нет варианта legacy fixtures с каноническим путём на этой машине');
const fixtures = variant.dir;
const ROOT = variant.root;
/**
 * Вариант согласован со своим ROOT: пути конфигураций и владелец базы
 * компонента записаны под ним. Вариант, записанный по чужому пути, иначе
 * падал бы отказом владельца глубоко внутри сценариев.
 */
function recordedPaths() {
  const db = new DatabaseSync(join(fixtures, 'component/app/.devcontour-local/state.sqlite'), {
    readOnly: true,
  });
  const owner = db.prepare('SELECT coordinator FROM owner').get() as { coordinator: string };
  db.close();
  return [
    ...['central/config.json', 'component/coordinator/config.json'].map((f) => [
      f,
      (JSON.parse(readFileSync(join(fixtures, f), 'utf8')) as Config).repository,
    ]),
    ['component/app/.devcontour-local/state.sqlite', owner.coordinator],
  ];
}
for (const [file, recorded] of recordedPaths())
  if (!recorded.startsWith(ROOT + '/'))
    throw new Error(`Вариант ${fixtures}: ${file} записан не под ${ROOT}: ${recorded}`);
const MARK = join(ROOT, '.devcontour-legacy-test');
const options = { policyDigest: () => digestOf('policy') };

/** Содержимое всех таблиц базы: по нему видно, что чтение ничего не записало. */
function dump(file: string) {
  const db = new DatabaseSync(file);
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((t) => t.name);
  const out = Object.fromEntries(
    tables
      .filter((t) => t !== 'revision')
      .map((t) => [t, db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()]),
  );
  db.close();
  return JSON.stringify(out);
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Удалить копию: только каталог с меткой этого теста. */
function release() {
  if (existsSync(MARK)) rmSync(ROOT, { recursive: true, force: true });
}

/**
 * Занять путь прежней версии. Другой процесс тестов держит его — подождать;
 * копия умершего процесса узнаётся по метке и удаляется. Каталог без метки
 * не трогается.
 */
async function acquire() {
  for (let i = 0; ; i++) {
    try {
      mkdirSync(ROOT);
      writeFileSync(MARK, String(process.pid));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (existsSync(MARK) && !alive(Number(readFileSync(MARK, 'utf8')))) {
        release();
        continue;
      }
      if (!existsSync(MARK) && i > 50) throw new Error(`${ROOT} занят каталогом без метки теста`);
      if (i > 1200) throw new Error(`${ROOT} занят другим процессом тестов`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

type Kind = 'central' | 'component';
type Copy = ReturnType<typeof copy>;

/**
 * Копия базы прежней версии на её месте: Git-репозиторий компонента
 * возвращается на место (`app.git` → `app/.git`), рабочее дерево — из него.
 */
function copy(kind: Kind) {
  const root = join(ROOT, kind);
  cpSync(join(fixtures, kind), root, { recursive: true });
  mkdirSync(join(root, 'app'), { recursive: true });
  renameSync(join(root, 'app.git'), join(root, 'app', '.git'));
  execFileSync('git', ['reset', '-q', '--hard'], { cwd: join(root, 'app') });
  const data = kind === 'central' ? root : join(root, 'coordinator');
  const files =
    kind === 'central'
      ? [join(root, 'state.sqlite')]
      : [join(data, 'state.sqlite'), join(root, 'app', '.devcontour-local', 'state.sqlite')];
  return { kind, root, data, app: join(root, 'app'), files };
}

/** Конфигурация workspace прежней версии — обычным загрузчиком, как у `serve`. */
function configOf(c: Copy): Config {
  return loadConfig(join(c.data, 'config.json'));
}

function openStore(c: Copy) {
  return new Store(
    join(c.data, 'state.sqlite'),
    c.kind === 'component' ? [{ id: 'app', path: c.app }] : undefined,
  );
}

/** Workspace прежней версии, открытый новой так же, как его открывает сервер. */
function workspace(c: Copy) {
  const config = configOf(c);
  const store = new Store(
    join(c.data, 'state.sqlite'),
    c.kind === 'component' ? repositories(config) : undefined,
  );
  const h = new DevContour(store, config);
  return { config, store, h, scheduler: new Scheduler(h, c.data) };
}

async function withLegacy(kind: Kind, body: (c: Copy) => Promise<void> | void) {
  await acquire();
  try {
    await body(copy(kind));
  } finally {
    release();
  }
}

for (const kind of ['central', 'component'] as const) {
  test(`T35 ${kind}: база прежней версии читается адаптером без setup и записи; новые поля не выдумываются`, () =>
    withLegacy(kind, (c) => {
      const before = c.files.map(dump);
      const s = new DevContourExecutionStore(openStore(c), options);
      const works = s.read((v) => v.works());
      const attempts = s.read((v) => v.attempts());
      const byTitle = (title: string) => {
        const w = works.find((x) => x.order.title === title);
        assert.ok(w, title);
        return w;
      };
      // Принятая задача: result SHA и evidence обеих фаз прежней попытки.
      const accepted = byTitle('Задача accepted');
      assert.equal(accepted.status, 'done');
      assert.equal(accepted.resultSha, '3'.repeat(40));
      const done = attempts.find((a) => a.workId === accepted.id && a.status === 'succeeded')!;
      assert.deepEqual(done.evidence.map((e) => `${e.phase}/${e.gate}`).sort(), [
        'candidate/independent-review',
        'candidate/test',
        'integration/independent-review',
        'integration/test',
      ]);
      // Прежняя попытка не получает сведений, которых у неё не было.
      for (const a of attempts) {
        assert.equal(a.engineVersion, undefined);
        assert.equal(a.consumerVersion, undefined);
        assert.equal(a.contextSnapshot, undefined);
        assert.equal(a.pinned, undefined);
        assert.equal(a.runtime, 'fixture', 'runtime demo прежней версии — fixture на границе');
      }
      // История отказов, ожидающая задача, активная и попытка в окне update-ref — как записаны.
      const failed = byTitle('Задача failed');
      assert.equal(failed.status, 'failed');
      assert.deepEqual(
        attempts.filter((a) => a.workId === failed.id).map((a) => a.failureKind),
        ['gate', 'review'],
      );
      assert.equal(byTitle('Задача pending').status, 'ready');
      const active = attempts.find((a) => a.workId === byTitle('Задача active').id)!;
      assert.equal(active.status, 'active');
      assert.ok(active.leaseUntil < Date.now(), 'срок владения истёк');
      const window = attempts.find((a) => a.workId === byTitle('Задача window').id)!;
      assert.equal(window.phase, 'integrating');
      assert.match(window.integrationSha ?? '', /^[0-9a-f]{40}$/);
      // Графы досок — задачи активных ревизий; утверждения задач — согласование.
      const graphs = s.read((v) => v.graphs());
      assert.deepEqual(graphs.map((g) => g.graph.orders.length).sort(), [1, 1, 5]);
      for (const g of graphs) assert.equal(g.approval?.digest, g.digest);
      // Пауза прежнего формата читается по её правилам.
      const control = s.read((v) => v.control());
      assert.equal(control.paused, true);
      if (kind === 'central') {
        assert.equal(control.pauseReason, 'runtime');
        assert.deepEqual(control.pauseFailures, ['provider-auth']);
      } else assert.equal(control.pauseReason, 'operator');
      // Учёт вызовов прежней формы: задача и доска вызова — поручение и группа.
      const calls = s.read((v) => v.locals('usage'));
      assert.equal(calls.length, 6);
      const reported = calls.find((x) => x.value.id === 'call-reported')!;
      assert.equal(reported.owner, 'app');
      assert.equal(reported.value.workId, accepted.id);
      assert.equal(reported.value.groupId, graphs.find((g) => g.graph.orders.length === 5)!.id);
      assert.equal(reported.value.costUsd, 0.25);
      // События прежних версий в нейтральный поток не попадают и не теряются для хоста.
      assert.deepEqual(s.events(), []);
      assert.ok(s.store.allEvents().length > 10);
      assert.equal(
        s.read((v) => v.local('delivery', WORKSPACE_OWNER, 'nothing')),
        undefined,
      );
      s.close();
      assert.deepEqual(c.files.map(dump), before, 'чтение не записало ничего');
    }));

  test(`T35 ${kind}: запись прежних задач и попыток без изменений не меняет их записи (поля хоста сохранены)`, () =>
    withLegacy(kind, (c) => {
      const s = new DevContourExecutionStore(openStore(c), options);
      const before = s.store.read();
      s.transact('run.phase', (tx) => {
        for (const w of tx.works()) tx.putWork(w);
        for (const a of tx.attempts()) tx.putAttempt(a);
      });
      const after = s.store.read();
      assert.deepEqual(after.tasks, before.tasks);
      assert.deepEqual(after.runs, before.runs);
      s.close();
    }));

  test(`T35 ${kind}: digest прежних попыток, проверок и заданий совпадают с формулами новой версии`, () =>
    withLegacy(kind, (c) => {
      const config = configOf(c);
      const store = new Store(
        join(c.data, 'state.sqlite'),
        kind === 'component' ? repositories(config) : undefined,
      );
      const h = new DevContour(store, config);
      const s = store.read();
      // Digest, посчитанные прежней версией для этого состояния (generate.ts).
      const expected = JSON.parse(readFileSync(join(c.root, 'expected.json'), 'utf8')) as {
        tasks: Record<string, Record<string, string>>;
        workspacePolicy: string;
        lead: Record<string, string>;
        corpus: Record<string, { suite: string; basis: string }>;
      };
      assert.equal(Object.keys(expected.tasks).length, 7);
      for (const t of s.tasks) {
        const policy = h.taskPolicyDigest(t);
        assert.deepEqual(
          {
            policy,
            legacyPolicy: h.policyDigest(t.repositoryId, true),
            checks: effectiveChecks(t, policy),
            spec: specDigest(t),
            scope: scopeDigest(t),
            dependency: dependencyDigest(t),
            context: contextDigest(t),
          },
          expected.tasks[t.title],
          t.title,
        );
      }
      // Попытки прежней версии закреплены под той же политикой, что считает новая.
      assert.equal(s.runs.length, 8);
      for (const r of s.runs)
        assert.equal(r.policyDigest, h.taskPolicyDigest(s.tasks.find((t) => t.id === r.taskId)!));
      assert.equal(new Workspace(h).policyDigest(), expected.workspacePolicy);
      const changeSet = s.changeSets[0];
      assert.equal(changeSet.verifications.length, 2);
      for (const v of changeSet.verifications)
        assert.equal(v.policyDigest, expected.workspacePolicy);
      const lead = new LeadWorkflow(h);
      const jobs = lead.list('app');
      assert.equal(jobs.length, 2);
      for (const job of jobs) {
        assert.equal(lead.input(job.kind, job.id).digest, expected.lead[job.key]);
        assert.equal(job.inputDigest, expected.lead[job.key]);
      }
      // Корпус договора: прежний ID и основание (KS-<id> по формуле хоста).
      const corpus = new CheckCorpus(h);
      for (const t of s.tasks.filter((t) => t.properties?.length)) {
        const { suite } = corpus.suiteFor(t, t.properties![0]);
        assert.deepEqual({ suite: suite.id, basis: suite.basis }, expected.corpus[t.title]);
        assert.match(suite.id, /^KS-C-/);
        assert.equal(suite.versions.length, 1);
      }
      store.close();
    }));

  test(`T35 ${kind}: новая версия продолжает работу прежней без setup — окно update-ref принимается один раз, активная истекает, ожидающая выполняется`, () =>
    withLegacy(kind, async (c) => {
      const config = configOf(c);
      const store = new Store(
        join(c.data, 'state.sqlite'),
        kind === 'component' ? repositories(config) : undefined,
      );
      const h = new DevContour(store, config);
      const scheduler = new Scheduler(h, c.data);
      const before = store.read();
      const taskOf = (s: typeof before, title: string) => s.tasks.find((t) => t.title === title)!;
      const runsOf = (s: typeof before, title: string) =>
        s.runs.filter((r) => r.taskId === taskOf(s, title).id);
      const usage = () =>
        Object.fromEntries(
          store.localEntries<UsageRecord>('usage').map((e) => [e.value.id, e.value]),
        );
      const [windowBefore] = runsOf(before, 'Задача window');
      // Принятия попытки окна: продуктовое событие recovery и событие движка.
      const accepted = () =>
        store
          .allEvents()
          .map((e) => ({
            type: e.type,
            data: e.data as { runId?: string; harnessEvents?: { type: string }[] },
          }))
          .filter((e) => e.data.runId === windowBefore.id)
          .flatMap((e) => [
            ...(e.type === 'run.recovered' ? [e.type] : []),
            ...(e.data.harnessEvents ?? [])
              .filter((x) => x.type === 'work.accepted')
              .map((x) => x.type),
          ]);
      const [activeBefore] = runsOf(before, 'Задача active');
      const finished = before.runs.filter((r) => r.status !== 'active');
      const callsBefore = usage();

      // Запуск новой версии: роль controller, применение конфигурации, recovery.
      await scheduler.init();
      await scheduler.tick();
      let s = store.read();

      // Окно после update-ref: integration SHA уже в ветке интеграции, evidence
      // обеих фаз записаны прежней версией — recovery принимает ту же попытку.
      const window = taskOf(s, 'Задача window');
      const [windowRun] = runsOf(s, 'Задача window');
      assert.equal(window.status, 'done');
      assert.equal(window.resultSha, windowBefore.integrationSha);
      assert.equal(windowRun.id, windowBefore.id);
      assert.equal(windowRun.attempt, windowBefore.attempt);
      assert.equal(windowRun.status, 'succeeded');
      assert.deepEqual(windowRun.evidence, windowBefore.evidence, 'evidence не дописаны');
      assert.notEqual(windowRun.token, windowBefore.token, 'старый token не продолжается');
      assert.deepEqual(accepted(), ['run.recovered', 'work.accepted']);

      // Активная без integration SHA — истекла с отказом окружения, без успеха.
      const active = taskOf(s, 'Задача active');
      const [activeRun] = runsOf(s, 'Задача active');
      assert.equal(runsOf(s, 'Задача active').length, 1);
      assert.equal(activeRun.status, 'expired');
      assert.equal(activeRun.failureKind, 'environment');
      assert.deepEqual(activeRun.evidence, activeBefore.evidence);
      assert.equal(active.status, 'failed');
      assert.equal(active.resultSha, undefined);
      assert.throws(() => h.heartbeat(activeBefore.id, activeBefore.token));

      // Завершённые попытки и принятые задачи прежней версии не изменились.
      for (const r of finished)
        assert.deepEqual(
          s.runs.find((x) => x.id === r.id),
          r,
          `попытка ${r.id}`,
        );
      // Единственная запись в них — закрепление политики за открытыми
      // утверждениями прежней версии на первом такте (D42); принятые задачи
      // его не получают.
      for (const title of [
        'Задача accepted',
        'Задача release',
        'Задача failed',
        'Задача property',
      ]) {
        const { approvedPolicy, ...rest } = taskOf(s, title);
        assert.deepEqual(rest, taskOf(before, title), title);
        const open = !['done', 'cancelled', 'draft'].includes(rest.status) && !!rest.approvedDigest;
        assert.equal(approvedPolicy, open ? h.planPolicyDigest() : undefined, title);
      }
      assert.deepEqual(s.contracts, before.contracts);
      assert.deepEqual(s.contractAttempts, before.contractAttempts);
      assert.deepEqual(s.boards, before.boards);

      // Пауза прежней версии запуском и recovery не снимается.
      assert.equal(s.paused, true);
      assert.equal(s.pauseReason, kind === 'central' ? 'runtime' : 'operator');

      // Вызов умершего процесса закрыт как прерванный, остальные — как были.
      // Вызов о доске без задач получает состав доски на момент запуска (как
      // и в прежней версии): расход остаётся за ними при переносе задач.
      const calls = usage();
      assert.equal(calls['call-active-dead'].outcome, 'abandoned');
      assert.equal(calls['call-active-dead'].costUsd, null, 'неизвестное не становится нулём');
      const board = s.boards.find((b) => b.id === callsBefore['call-unknown'].boardId)!;
      assert.equal(callsBefore['call-unknown'].taskIds, undefined);
      assert.deepEqual(
        calls['call-unknown'].taskIds,
        board.revisions.flatMap((r) => r.taskIds),
      );
      for (const id of Object.keys(callsBefore).filter((id) => id !== 'call-active-dead')) {
        const { taskIds, ...rest } = calls[id];
        assert.deepEqual(
          id === 'call-unknown' ? rest : { ...rest, ...(taskIds ? { taskIds } : {}) },
          callsBefore[id],
          id,
        );
      }

      // Повторный recovery ничего не дублирует.
      await scheduler.tick();
      s = store.read();
      assert.deepEqual(accepted(), ['run.recovered', 'work.accepted']);
      assert.equal(runsOf(s, 'Задача window').length, 1);
      assert.deepEqual(runsOf(s, 'Задача window')[0], windowRun);
      executionOf(h).engine.abandonCalls();
      assert.deepEqual(usage(), calls, 'прерванный вызов закрывается один раз');

      // Ожидающая задача выдаётся без повторного утверждения и принимается.
      const pending = taskOf(s, 'Задача pending');
      assert.equal(pending.status, 'ready');
      complete(h, pending.id);
      s = store.read();
      assert.equal(taskOf(s, 'Задача pending').status, 'done');
      assert.equal(runsOf(s, 'Задача pending').length, 1);
      // Отказавшая задача повторяется в пределах прежнего maxAttempts.
      h.retry(taskOf(s, 'Задача failed').id);
      assert.equal(taskOf(store.read(), 'Задача failed').status, 'ready');

      await scheduler.stop();
      store.close();
    }));

  test(`T35 ${kind}: integration SHA прежней попытки не в ветке интеграции — recovery отказывает без ложного успеха`, () =>
    withLegacy(kind, async (c) => {
      const { store, scheduler } = workspace(c);
      const before = store.read();
      const task = before.tasks.find((t) => t.title === 'Задача window')!;
      const run = before.runs.find((r) => r.taskId === task.id)!;
      // Продвижения ветки не было: ветка интеграции — на основании попытки.
      execFileSync('git', ['update-ref', 'refs/heads/devcontour/accepted', run.baseSha!], {
        cwd: c.app,
      });
      await scheduler.init();
      await scheduler.tick();
      const s = store.read();
      const after = s.runs.find((r) => r.id === run.id)!;
      assert.equal(after.status, 'expired');
      assert.deepEqual(after.evidence, run.evidence);
      const t = s.tasks.find((t) => t.id === task.id)!;
      assert.equal(t.status, 'failed');
      assert.equal(t.resultSha, undefined);
      assert.equal(
        s.runs.filter((r) => r.taskId === task.id && r.status === 'succeeded').length,
        0,
      );
      await scheduler.stop();
      store.close();
    }));

  test(`T35 ${kind}: задания ведущего, ChangeSet, корпус и разбор по свойству прежней версии продолжаются`, () =>
    withLegacy(kind, async (c) => {
      const { store, h, scheduler } = workspace(c);
      const before = store.read();
      const corpus = new CheckCorpus(h);
      const suitesBefore = corpus.all();
      await scheduler.init();
      await scheduler.tick();

      // Задание стадии 1 с истёкшим владением продолжается с той же стадии,
      // без повторного ревью плана; упавшее ждёт явного повтора.
      const lead = new LeadWorkflow(h);
      const jobs = lead.list('app');
      const running = jobs.find((j) => j.status === 'running')!;
      const failed = jobs.find((j) => j.status === 'failed')!;
      assert.equal(running.stage, 1);
      assert.equal(failed.error, 'Стадия согласования упала: ревью недоступно');
      const claimed = lead.claim(running.key, 'app')!;
      assert.equal(claimed.stage, 1);
      // Перехват после истечения — следующая попытка той же стадии (как прежде).
      assert.equal(claimed.attempts, running.attempts + 1);
      assert.notEqual(claimed.token, running.token);
      assert.equal(lead.claim(failed.key, 'app'), undefined);
      const retried = lead.retry(failed.key, 'app');
      assert.equal(retried.status, 'queued');
      assert.equal(retried.stage, 0);

      // ChangeSet принимается по прошедшей проверке прежней версии: основание и
      // политика не менялись.
      const changeSet = before.changeSets[0];
      const [failedCheck, passedCheck] = changeSet.verifications;
      assert.equal(failedCheck.status, 'failed');
      const acceptance = new Workspace(h).accept(changeSet.id) as {
        status: string;
        verificationId?: string;
      };
      assert.equal(acceptance.status, 'accepted');
      assert.equal(acceptance.verificationId, passedCheck.id);
      assert.deepEqual(
        store.read().changeSets[0].verifications,
        changeSet.verifications,
        'проверки прежней версии не переписаны',
      );

      // Корпус: прежний ID, подтверждённый случай и принятая версия — как были.
      assert.deepEqual(corpus.all(), suitesBefore);
      const [suite] = suitesBefore;
      assert.match(suite.id, /^KS-C-/);
      assert.equal(suite.decisions[0].outcome, 'confirmed');
      const property = before.tasks.find((t) => t.title === 'Задача property')!;
      assert.equal(property.checkVersion?.suite, suite.id);

      // Эпизод разбора по свойству не закрывается как «новое основание»:
      // повтор возвращает задачу, но выдача удержана до решения ведущего.
      h.pause(false);
      h.retry(property.id);
      let s = store.read();
      assert.equal(s.tasks.find((t) => t.id === property.id)!.status, 'ready');
      assert.equal(s.tasks.find((t) => t.id === property.id)!.recovery?.status, 'awaiting-lead');
      const issued: string[] = [];
      for (let run = h.claim(scheduler.owner); run; run = h.claim(scheduler.owner)) {
        const { taskId } = run;
        issued.push(s.tasks.find((t) => t.id === taskId)!.title);
      }
      assert.deepEqual(issued, ['Задача pending']);
      s = store.read();
      assert.equal(s.tasks.find((t) => t.id === property.id)!.status, 'ready');

      await scheduler.stop();
      store.close();
    }));
}

// Git-синхронизация прежней версии (tests/fixtures/legacy-sync/generate.ts):
// receipts принятых задач, экспортированные её syncGit.
const syncFixture = fileURLToPath(new URL('./fixtures/legacy-sync/', import.meta.url));
const gitIn = (path: string, ...args: string[]) =>
  execFileSync('git', ['-C', path, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Sync Test',
      GIT_AUTHOR_EMAIL: 'sync@example.test',
      GIT_COMMITTER_NAME: 'Sync Test',
      GIT_COMMITTER_EMAIL: 'sync@example.test',
    },
  }).trim();

/** Новый участник: клоны Git прежней версии и пустая база новой. */
function syncPeer(root: string, name: string, tamper?: (receipts: string) => void) {
  const base = join(root, name);
  const workspace = join(base, 'workspace');
  const repo = join(base, 'product');
  mkdirSync(base);
  for (const [path, from] of [
    [workspace, 'workspace.git'],
    [repo, 'product.git'],
  ] as const) {
    execFileSync('git', ['clone', '-q', '--no-local', join(syncFixture, from), path]);
    gitIn(path, 'config', 'user.name', 'Sync Test');
    gitIn(path, 'config', 'user.email', 'sync@example.test');
  }
  if (tamper) {
    tamper(join(repo, '.devcontour', 'receipts'));
    gitIn(repo, 'commit', '-qam', 'tampered receipt');
  }
  const config = configSchema.parse({
    version: 1,
    name: 'Legacy sync fixture',
    repository: repo,
    workspaceRoot: workspace,
    storage: 'component',
    mode: 'local',
    concurrency: 2,
    roles: { qa: { runtime: 'codex' } },
    reviewer: { runtime: 'claude' },
    gates: [
      {
        id: 'test',
        kind: 'test',
        command: ['node', 'verify.mjs'],
        report: { type: 'junit', path: '.reports/junit.xml' },
      },
    ],
  });
  const store = new Store(join(workspace, '.devcontour-local/state.sqlite'), repositories(config));
  const h = new DevContour(store, config);
  gitIn(repo, 'update-ref', 'refs/heads/' + config.targetBranch, 'HEAD');
  return { h, store, repo };
}

/** Изменить документ состояния копии напрямую, как его оставила бы ранняя версия. */
function editState(file: string, edit: (state: { runs: Record<string, unknown>[] }) => void) {
  const db = new DatabaseSync(file);
  const row = db.prepare('SELECT data FROM main.state WHERE id=1').get() as { data: string };
  const state = JSON.parse(row.data) as { runs: Record<string, unknown>[] };
  edit(state);
  db.prepare('UPDATE main.state SET data=? WHERE id=1').run(JSON.stringify(state));
  db.close();
}

/**
 * Формы `continuedFrom`, записанные ранними версиями и перенесённые 0.3.0 как
 * есть: без `kind` (продолжался только черновик по времени), `timeout` и
 * `review`; рядом — текущая форма, которая не меняется. Попытки — из базы
 * прежней версии, источники продолжения вымышленные.
 */
const earlyContinuations: Record<string, [Record<string, unknown>, Record<string, unknown>]> = {
  'af5fb1da-11b2-4562-9f48-76773f735c7c': [
    { runId: 'e7f8ae26-663a-4aef-a968-515bd8c57573', applied: true, files: ['src/a.ts'] },
    { kind: 'unfinished', reason: 'timeout' },
  ],
  '3a999852-de00-4651-9320-8eecb36d3292': [
    {
      runId: 'af5fb1da-11b2-4562-9f48-76773f735c7c',
      kind: 'review',
      applied: true,
      files: ['src/a.ts', 'src/b.ts'],
    },
    { kind: 'candidate', reason: 'review' },
  ],
  '62397b3d-3bb0-4ca5-b537-27d72749dcdf': [
    { runId: 'cd460b1d-c592-4472-bd37-db4c80c7e3f6', kind: 'timeout', applied: false, files: [] },
    { kind: 'unfinished', reason: 'timeout' },
  ],
  // Прежняя форма с записанным классом отказа: класс сохраняется.
  'e7f8ae26-663a-4aef-a968-515bd8c57573': [
    {
      runId: '0facc6e5-580b-4958-903f-7943fc77339e',
      kind: 'timeout',
      reason: 'environment',
      applied: true,
      files: [],
    },
    { kind: 'unfinished' },
  ],
  'cd460b1d-c592-4472-bd37-db4c80c7e3f6': [
    {
      runId: '4cc47c4f-1d29-4929-8067-d08e8aaeac7b',
      kind: 'review',
      reason: 'gate',
      applied: false,
      files: ['src/d.ts'],
    },
    { kind: 'candidate' },
  ],
  '8dbafef9-9e3b-4e37-a0be-51bac7d2fd5f': [
    {
      runId: '62397b3d-3bb0-4ca5-b537-27d72749dcdf',
      kind: 'candidate',
      reason: 'gate',
      respecified: true,
      applied: true,
      files: ['src/c.ts'],
    },
    {},
  ],
};

test('T35 central: продолжения попыток ранних версий читаются по смыслу, запись и проверка данных их не меняют', () =>
  withLegacy('central', (c) => {
    editState(c.files[0], (state) => {
      for (const run of state.runs) {
        const early = earlyContinuations[run.id as string];
        if (early) run.continuedFrom = early[0];
      }
    });
    const before = c.files.map(dump);
    const s = new DevContourExecutionStore(openStore(c), options);
    const attempts = new Map(s.read((v) => v.attempts()).map((a) => [a.id, a.continuedFrom]));
    for (const [id, [recorded, meaning]] of Object.entries(earlyContinuations))
      assert.deepEqual(attempts.get(id), { ...recorded, ...meaning }, id);
    assert.deepEqual(c.files.map(dump), before, 'чтение не записало ничего');
    const runs = s.store.read().runs;
    // Неизменённая попытка записывается с той формой продолжения, что была.
    s.transact('run.phase', (tx) => {
      for (const a of tx.attempts()) tx.putAttempt(a);
    });
    assert.deepEqual(s.store.read().runs, runs, 'прежние формы не переписаны');
    // Движок изменил продолжение прежней попытки — записано новое значение.
    const changed = '3a999852-de00-4651-9320-8eecb36d3292';
    s.transact('run.phase', (tx) => {
      const a = tx.attempts().find((x) => x.id === changed)!;
      tx.putAttempt({ ...a, continuedFrom: { ...a.continuedFrom!, applied: false, files: [] } });
    });
    assert.deepEqual(s.store.read().runs.find((r) => r.id === changed)?.continuedFrom, {
      runId: 'af5fb1da-11b2-4562-9f48-76773f735c7c',
      kind: 'candidate',
      reason: 'review',
      applied: false,
      files: [],
    });
    s.close();
    const result = dataDoctor(configOf(c), c.data);
    assert.equal(result.compatible, true, JSON.stringify(result.checks));
    // Неизвестная форма не подменяется: её отклоняет договор harness.
    editState(c.files[0], (state) => {
      const run = state.runs.find((r) => r.id === '3a999852-de00-4651-9320-8eecb36d3292')!;
      (run.continuedFrom as Record<string, unknown>).kind = 'other';
    });
    const unknown = dataDoctor(configOf(c), c.data);
    assert.equal(unknown.compatible, false);
    assert.match(
      unknown.checks.find((x) => x.id === 'execution-state')?.detail ?? '',
      /3a999852.*continuedFrom\.kind/,
    );
  }));

/** Изменить receipt задачи по названию в клоне участника. */
const editReceipt =
  (title: string, change: (receipt: CompletionReceipt) => void) => (receipts: string) => {
    for (const name of readdirSync(receipts)) {
      const file = join(receipts, name);
      const record = JSON.parse(readFileSync(file, 'utf8')) as { data: CompletionReceipt };
      const tasks = join(receipts, '..', 'tasks', record.data.taskId + '.json');
      const task = JSON.parse(readFileSync(tasks, 'utf8')) as { data: { title: string } };
      if (task.data.title !== title) continue;
      change(record.data);
      writeFileSync(file, canonical(record));
    }
  };

test('T36: receipts Git-синхронизации прежней версии импортируются новой версией тем же уровнем; подделки отклоняются', () => {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-legacy-sync-'));
  const opened: Store[] = [];
  try {
    const bob = syncPeer(root, 'bob');
    opened.push(bob.store);
    syncGit(bob.h, { member: 'bob' });
    const s = bob.store.read();
    assert.deepEqual(s.tasks.map((t) => t.status).sort(), ['done', 'done']);
    for (const t of s.tasks) {
      assert.ok(t.sharedCompletion?.sourceCommit, t.title);
      assert.equal(t.resultSha, t.sharedCompletion.receipt.resultSha);
      assert.equal(t.sharedCompletion.receipt.runtime, 'codex');
      assert.equal(t.sharedCompletion.receipt.reviewer, 'claude');
    }
    assert.equal(s.runs.length, 0, 'чужая работа не становится локальной попыткой');
    assert.equal(s.boards[0].revisions.at(-1)!.status, 'accepted');
    // Названный testcase подтверждён тем же уровнем, что у отправителя.
    const namedTask = s.tasks.find((t) => t.title === 'Named testcase')!;
    const named = requirementReport(bob.h, 'main').tasks.find((t) => t.taskId === namedTask.id)!;
    assert.equal(named.requirements[0].proof, 'testcase');
    assert.deepEqual(syncGit(bob.h).changes, [], 'повторный sync ничего не меняет');

    const forgeries: [string, (receipts: string) => void, RegExp][] = [
      [
        'PASS теста интеграции снят',
        editReceipt('Plain task', (r) => {
          for (const c of r.checks)
            if (c.gate === 'test' && c.phase === 'integration') c.passed = false;
        }),
        /Нет PASS: integration\/test/,
      ],
      [
        'PASS с ненулевым кодом выхода',
        editReceipt('Plain task', (r) => {
          for (const c of r.checks) if (c.gate === 'test') c.exitCode = 1;
        }),
        /ненулевым кодом выхода/,
      ],
      [
        'ревью тем же вендором',
        editReceipt('Plain task', (r) => (r.reviewer = 'codex')),
        /того же вендора/,
      ],
      [
        'исполнитель demo вне режима demo',
        editReceipt('Plain task', (r) => (r.runtime = 'demo')),
        /writer fixture не используется политикой/,
      ],
      [
        'проверка источника требований убрана',
        editReceipt('Named testcase', (r) => {
          r.requiredGates = r.requiredGates.filter((g) => g !== 'requirement-source');
          r.checks = r.checks.filter((c) => c.gate !== 'requirement-source');
        }),
        /requirement-source/,
      ],
      [
        'названный testcase не выполнялся',
        editReceipt('Named testcase', (r) => {
          for (const c of r.checks)
            if (c.tests) c.tests = c.tests.filter((t) => t.id !== 'named-case');
        }),
        /named-case/,
      ],
      [
        'запись под другой версией проверок',
        editReceipt('Plain task', (r) => (r.checks[0].checks = 'f'.repeat(64))),
        /другой версией проверок/,
      ],
      [
        'область проверок сокращена',
        editReceipt('Plain task', (r) => (r.requiredGates = ['other'])),
        /область результата/,
      ],
    ];
    for (const [name, tamper, pattern] of forgeries) {
      const peer = syncPeer(root, 'carol-' + forgeries.findIndex((f) => f[0] === name), tamper);
      opened.push(peer.store);
      assert.throws(() => syncGit(peer.h, { member: 'carol' }), pattern, name);
      assert.equal(
        peer.store.read().tasks.filter((t) => t.status === 'done').length,
        0,
        `${name}: подделка не импортирована`,
      );
    }
  } finally {
    for (const store of opened) store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// Ревью прежней версии (tests/fixtures/legacy-review/generate.ts): контракт и
// план отклонены блокирующей находкой. Новая версия продолжает их историю.
const reviewFixture = fileURLToPath(new URL('./fixtures/legacy-review/', import.meta.url));

test('S3-R1-03/T35: первое ревью новой версии получает находки отклонённого ревью прежней и продолжает нумерацию; контракт и план', async () => {
  const meta = JSON.parse(readFileSync(join(reviewFixture, 'meta.json'), 'utf8')) as {
    boardId: string;
    finding: string;
  };
  const root = mkdtempSync(join(tmpdir(), 'devcontour-legacy-review-'));
  try {
    cpSync(join(reviewFixture, 'state.sqlite'), join(root, 'state.sqlite'));
    const store = new Store(join(root, 'state.sqlite'));
    const before = structuredClone(store.read().contractAttempts!);
    const cfg = testConfig();
    cfg.mode = 'local';
    cfg.roles = { qa: { runtime: 'codex' } } as never;
    cfg.reviewer = { runtime: 'claude' };
    const h = new DevContour(store, cfg);
    const prompts: string[] = [];
    // Отвечает, не разобрав прежние находки (silent), либо закрывая их.
    const runtimes = (silent: boolean) => {
      const make = (name: 'codex' | 'claude'): AgentAdapter => ({
        name,
        execute(r: AgentRequest) {
          prompts.push(r.prompt);
          return Promise.resolve({
            data: {
              approved: true,
              summary: 'Reviewed',
              findings: [],
              previous: silent ? [] : closePrevious(r.prompt),
              execution: { commands: [], noCommandsReason: 'Read-only analysis' },
            },
            log: 'Controlled adapter',
            command: ['fixture'],
          });
        },
      });
      return { codex: make('codex'), claude: make('claude') };
    };
    const proposal = { title: 'Legacy contract', content: 'Documented API returns the value.' };
    // Ответ без состояния прежней находки — не одобрение.
    await assert.rejects(
      reviewContract(h, root, proposal, 'codex', runtimes(true)),
      /Независимое ревью отклонено/,
    );
    assert.match(prompts.at(-1)!, new RegExp(meta.finding));
    const contract = await reviewContract(h, root, proposal, 'codex', runtimes(false));
    assert.equal((contract as { status: string }).status, 'approved');
    await reviewPlan(h, root, meta.boardId, 'codex', runtimes(false));
    assert.match(prompts.at(-1)!, new RegExp(meta.finding));
    const attempts = store.read().contractAttempts!;
    // Прежние записи не переписаны; номера продолжаются после них.
    assert.deepEqual(attempts.slice(0, before.length), before);
    const numbers = (subject: string) =>
      attempts.filter((a) => a.subject === subject).map((a) => [a.attempt, a.approved]);
    assert.deepEqual(numbers(before[0].subject), [
      [1, false],
      [2, false],
      [3, true],
    ]);
    assert.deepEqual(numbers(before[1].subject), [
      [1, false],
      [2, true],
    ]);
    // Раунды движка начинаются со второго: прежнему раунду ничего не приписано.
    const { engine } = executionOf(h);
    assert.deepEqual(
      engine.reviews('plan', meta.boardId).map((r) => r.round),
      [2],
    );
    assert.equal(
      engine.reviews('plan', meta.boardId)[0].findings.find((f) => f.message === meta.finding)
        ?.status,
      'closed',
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
