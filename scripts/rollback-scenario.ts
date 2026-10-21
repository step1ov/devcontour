/**
 * Шаги состояния для проверки отката (`scripts/upgrade-check.mjs --rollback`,
 * T42): запускаются из checkout с той версией DevContour и пакета harness,
 * которая сейчас установлена, над одним и тем же каталогом workspace.
 * Тот же файл копируется в checkout прежней версии DevContour: он опирается
 * только на API, общий для обеих.
 *
 *   node --import tsx scripts/rollback-scenario.ts <шаг> <каталог> <central|component> [аргумент]
 *
 * init          — Git-репозитории продукта и workspace, доска с цепочкой
 *                 задач A ← B ← … ← E; A принята настоящим коммитом;
 *                 штатная остановка.
 * work <задача> — роль controller, выдача задачи, настоящий коммит в main
 *                 продукта, evidence обеих фаз, принятие; затем штатная
 *                 остановка (роль снята).
 * crash <задача>— то же, но процесс «падает»: роль controller не снята.
 * sync          — Git sync (экспорт receipts) и коммит `.devcontour` в обоих
 *                 репозиториях; штатная остановка.
 * read          — открыть состояние этой версией и прочитать (без записи):
 *                 задачи, попытки, роль; отказ открытия — в `refusal`.
 * write         — попытка записи этой версией (роль controller); отказ — в
 *                 `refusal`.
 * reconcile     — сверка Git: каждый result SHA принятой задачи достижим из
 *                 main продукта, и в main нет коммитов работы вне принятых
 *                 задач (коммиты общих записей `.devcontour` не в счёт).
 * sync-only     — Git sync без коммита; отказ — в `result.refusal`.
 *
 * Логическое содержимое баз (все таблицы всех баз) печатает каждый шаг в
 * `databases` — по нему проверяющий сверяет «без записи» и восстановление.
 * Итог шага — JSON в stdout; несоответствие — исключение и ненулевой exit.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configSchema } from '../src/core/model.ts';
import { repositories } from '../src/core/repositories.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { syncGit } from '../src/runner/git-sync.ts';

const [step, dir, topology, argument] = process.argv.slice(2);
if (!step || !dir || !['central', 'component'].includes(topology ?? '')) {
  console.error('rollback-scenario: <шаг> <каталог> <central|component> [задача]');
  process.exit(2);
}
const product = join(dir, 'product');
const workspace = join(dir, 'workspace');
const version = (path: string) =>
  (JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as { version: string }).version;
const devcontourVersion = version('../package.json');
const harnessVersion = existsSync(
  new URL('../node_modules/devcontour-harness/package.json', import.meta.url),
)
  ? version('../node_modules/devcontour-harness/package.json')
  : undefined;
const owner = 'controller-' + devcontourVersion + (harnessVersion ? '-' + harnessVersion : '');
const DIGEST = 'e'.repeat(64);
const TASKS = ['A', 'B', 'C', 'D', 'E'];
const titleOf = (letter: string) => 'Task ' + letter;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Rollback check',
      GIT_AUTHOR_EMAIL: 'rollback-check@example.invalid',
      GIT_COMMITTER_NAME: 'Rollback check',
      GIT_COMMITTER_EMAIL: 'rollback-check@example.invalid',
    },
  }).trim();
const config = configSchema.parse({
  version: 1,
  name: 'Rollback check',
  repository: product,
  workspaceRoot: workspace,
  storage: topology,
  mode: 'demo',
  concurrency: 1,
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
const database = join(workspace, '.devcontour-local', 'state.sqlite');
const open = () => {
  const store = new Store(
    database,
    config.storage === 'component' ? repositories(config) : undefined,
  );
  return { store, h: new DevContour(store, config) };
};

/** Логическое содержимое всех баз workspace (центральной и компонентов). */
function databases() {
  const files = [database, join(product, '.devcontour-local', 'state.sqlite')].filter(existsSync);
  const out: Record<string, string> = {};
  for (const file of files) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];
      const hash = createHash('sha256');
      for (const { name } of tables)
        hash.update(name + JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()));
      out[file.slice(dir.length + 1)] = hash.digest('hex');
    } finally {
      db.close();
    }
  }
  return out;
}

/** Штатная остановка: пауза и снятие роли controller этого процесса. */
async function stop(h: DevContour, store: Store) {
  h.pause(true);
  try {
    const { executionOf } = await import('../src/harness/execution.ts');
    executionOf(h).engine.release(owner);
  } catch (error) {
    if ((error as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') throw error;
    // Версия без пакета harness: роль — запись состояния.
    (store as unknown as { change: (k: string, f: (s: any) => void) => void }).change(
      'heartbeat',
      (s) => {
        if (s.leader?.owner === owner) s.leader = undefined;
      },
    );
  }
}

function accept(h: DevContour, letter: string) {
  const title = titleOf(letter);
  const team = (h.store.read() as { team?: { member: string } }).team;
  const target = h.store.read().tasks.find((t) => t.title === title)!;
  // После первого Git sync выдаётся только задача, назначенная участнику.
  if (team && target.assignee !== team.member) h.assign(target.id, team.member);
  h.pause(false);
  assert.equal(h.leader(owner), true, 'роль controller не получена');
  const run = h.claim(owner);
  assert.ok(run, 'задача не выдана');
  const task = h.store.read().tasks.find((t) => t.id === run.taskId)!;
  assert.equal(task.title, title, `выдана ${task.title}, ожидалась ${title}`);
  mkdirSync(join(product, 'tasks'), { recursive: true });
  writeFileSync(join(product, 'tasks', `${letter}-${run.id}.txt`), `${title} ${run.id}\n`);
  git(product, 'add', 'tasks');
  git(product, 'commit', '-qm', `Task ${title}, attempt ${run.id}`);
  const sha = git(product, 'rev-parse', 'HEAD');
  h.phase(run.id, run.token, 'integrating', { candidateSha: sha, integrationSha: sha });
  for (const phase of ['candidate', 'integration'] as const)
    for (const kind of ['test', 'review'] as const)
      h.evidence(run.id, run.token, {
        kind,
        phase,
        sha,
        gate: kind === 'test' ? 'test' : 'independent-review',
        passed: true,
        command: ['fixture'],
        exitCode: 0,
        log: 'fixture',
        digest: DIGEST,
        summary: 'Rollback fixture: evidence recorded by the check, no model or gate called',
      });
  h.finish(run.id, run.token, sha);
  return { run: run.id, sha };
}

function summary(store: Store) {
  const s = store.read();
  return {
    leader: s.leader,
    tasks: Object.fromEntries(
      s.tasks.map((t) => [
        t.title,
        {
          status: t.status,
          resultSha: t.resultSha,
          runs: s.runs.filter((r) => r.taskId === t.id).length,
        },
      ]),
    ),
    runs: s.runs.map((r) => ({
      id: r.id,
      task: s.tasks.find((t) => t.id === r.taskId)?.title,
      status: r.status,
      engineVersion: (r as { engineVersion?: string }).engineVersion,
    })),
  };
}

function reconcile(store: Store) {
  const s = store.read();
  const accepted = s.tasks.filter((t) => t.status === 'done' && t.resultSha);
  const unreachable = accepted.filter((t) => {
    try {
      git(product, 'merge-base', '--is-ancestor', t.resultSha!, 'main');
      return false;
    } catch {
      return true;
    }
  });
  const unrecorded = git(
    product,
    'rev-list',
    'main',
    ...accepted.map((t) => '^' + t.resultSha),
    '^' + git(product, 'rev-list', '--max-parents=0', 'main'),
    // Коммиты общих записей `.devcontour` — не работа задач.
    '--',
    '.',
    ':(exclude).devcontour',
  )
    .split('\n')
    .filter(Boolean)
    .map((sha) => ({ sha, subject: git(product, 'log', '-1', '--format=%s', sha) }));
  return {
    consistent: unreachable.length === 0 && unrecorded.length === 0,
    main: git(product, 'rev-parse', 'main'),
    unreachable: unreachable.map((t) => ({ task: t.title, resultSha: t.resultSha })),
    unrecorded,
  };
}

const out = (value: object) =>
  console.log(
    JSON.stringify(
      { step, topology, devcontourVersion, harnessVersion, ...value, databases: databases() },
      null,
      2,
    ),
  );

if (step === 'init') {
  for (const repo of [product, workspace]) {
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, '.gitignore'), '.devcontour-local/\n.reports/\n');
    writeFileSync(join(repo, 'README.md'), 'Rollback check fixture.\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'fixture');
  }
  const { store, h } = open();
  const board = h.createBoard('Rollback', '', 'main');
  // Цепочка A ← B ← … ← E: выдаётся ровно следующая задача.
  let previous: string | undefined;
  for (const letter of TASKS)
    previous = h.addTask(board.id, {
      title: titleOf(letter),
      description: 'An observable outcome that builds on the previous task.',
      role: 'qa',
      dependsOn: previous ? [previous] : [],
      acceptance: ['The expected result is checked.'],
    }).id;
  h.approve(board.id);
  const a = accept(h, 'A');
  await stop(h, store);
  const result = summary(store);
  store.close();
  out({ accepted: a, ...result });
} else if (step === 'work' || step === 'crash') {
  assert.ok(argument, 'укажите задачу');
  const { store, h } = open();
  const accepted = accept(h, argument);
  if (step === 'work') await stop(h, store);
  const result = summary(store);
  store.close();
  out({ accepted, ...result });
} else if (step === 'sync') {
  const { store, h } = open();
  h.pause(true);
  const result = syncGit(h, { member: owner });
  const committed: string[] = [];
  for (const repo of [product, workspace]) {
    if (!existsSync(join(repo, '.devcontour'))) continue;
    git(repo, 'add', '.devcontour');
    if (git(repo, 'status', '--porcelain', '.devcontour')) {
      git(repo, 'commit', '-qm', `Share DevContour records (${devcontourVersion})`);
      committed.push(repo.slice(dir.length + 1) + '@' + git(repo, 'rev-parse', 'HEAD'));
    }
  }
  const receipts = [product, workspace].flatMap((repo) =>
    existsSync(join(repo, '.devcontour'))
      ? readdirSync(join(repo, '.devcontour'), { recursive: true, encoding: 'utf8' })
          .filter((f) => f.endsWith('.json') && statSync(join(repo, '.devcontour', f)).isFile())
          .map((f) => readFileSync(join(repo, '.devcontour', f), 'utf8'))
          .filter((text) => text.includes('resultSha'))
      : [],
  );
  await stop(h, store);
  store.close();
  out({
    status: result.status,
    conflicts: result.conflicts,
    committed,
    receiptsWithIdentity: receipts.filter((r) => r.includes('gateIdentity')).length,
    receipts: receipts.length,
  });
} else if (step === 'read') {
  let result: object = {};
  try {
    const { store } = open();
    try {
      result = summary(store);
    } finally {
      store.close();
    }
  } catch (error) {
    result = { refusal: String((error as Error).message ?? error).slice(0, 400) };
  }
  out(result);
} else if (step === 'write') {
  let refusal: string | undefined;
  try {
    const { store, h } = open();
    try {
      h.leader(owner);
      h.claim(owner);
    } finally {
      store.close();
    }
  } catch (error) {
    refusal = String((error as Error).message ?? error).slice(0, 400);
  }
  out({ refusal });
} else if (step === 'sync-only') {
  // Git sync без коммита: отказ прежней версии на чужом receipt.
  let result: unknown;
  try {
    const { store, h } = open();
    try {
      h.pause(true);
      result = syncGit(h, { member: owner });
    } finally {
      store.close();
    }
  } catch (error) {
    result = { refusal: String((error as Error).message ?? error).slice(0, 400) };
  }
  out({ result });
} else if (step === 'reconcile') {
  const { store } = open();
  const result = reconcile(store);
  store.close();
  out(result);
} else {
  console.error('rollback-scenario: неизвестный шаг ' + step);
  process.exit(2);
}
