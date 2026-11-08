/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any --
 * Генератор вызывает код прежней версии из другого checkout: его типов здесь
 * нет, модули загружаются по пути во время запуска.
 */
/**
 * База версии с обсуждениями задач, но до вопросов исполнителя: commit
 * aee0ed9 — слияние обсуждений, до слияния вопросов исполнителя (версия
 * пакета 0.4.0-alpha.17, локальная сборка движка 0.1.0-alpha.36).
 *
 * Запускается из checkout той версии — состояние пишет её собственный код
 * (`DevContour`, `Store`, движок через `executionOf`, `DiscussionService`).
 * Файл копируется внутрь checkout (там `"type": "module"` и её tsx):
 *
 *   git worktree add --detach <checkout> aee0ed9 && (cd <checkout> && npm ci)
 *   mkdir <checkout>/gen && cp <этот файл> <checkout>/gen/
 *   (cd <checkout> && node --import tsx gen/generate.ts <checkout> <ROOT>)
 *   cp -R <ROOT>/. tests/fixtures/<вариант>/
 *   npx prettier --write tests/fixtures/<вариант>/{central,component/coordinator}/config.json \
 *     tests/fixtures/<вариант>/{central,component}/expected.json
 *
 * Вариант Linux — в контейнере `node:24.3.0-bookworm`: исходники aee0ed9
 * (`git archive`) копируются в контейнер, там `npm ci --ignore-scripts` и тот
 * же запуск с `<ROOT>` = `/tmp/devcontour-legacy-discussion`; результат
 * выносится через смонтированный каталог.
 *
 * `<ROOT>` — канонический путь на платформе, где открывается вариант:
 * `tests/fixtures/legacy-discussion` — `/tmp/devcontour-legacy-discussion`
 * (Linux, записан в контейнере node), `tests/fixtures/legacy-discussion-darwin`
 * — `/private/tmp/devcontour-legacy-discussion` (macOS). Раскладка как у
 * tests/fixtures/legacy: central и component, Git-репозиторий компонента
 * рядом как `app.git`.
 *
 * Состояние: принятая задача, утверждённые задачи с закреплённой политикой
 * (`approvedPolicy`), незавершённая попытка с черновиком (`partial`, отказ по
 * времени), её продолжение (`continuedFrom`, активная попытка с истёкшим
 * сроком), учёт вызовов, заметки оператора и ведущего, обработанное и
 * открытое обращения к ведущему. Данные вымышленные, моделей нет.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

type Any = any;
const [baseline, out] = process.argv.slice(2) as [string, string];
const { Store } = await import(join(baseline, 'src/core/store.ts'));
const { DevContour, specDigest } = await import(join(baseline, 'src/core/service.ts'));
const { configSchema } = await import(join(baseline, 'src/core/model.ts'));
const { usageSchema } = await import(join(baseline, 'src/core/usage.ts'));
const { executionOf } = await import(join(baseline, 'src/harness/execution.ts'));
const { DiscussionService } = await import(join(baseline, 'src/application/discussion.ts'));

const sha = (c: string) => c.repeat(40);
const digest = (c: string) => c.repeat(64);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd })
    .toString()
    .trim();

const unit = {
  id: 'test',
  kind: 'test',
  command: ['node', 'verify.mjs'],
  report: { type: 'junit', path: '.reports/junit.xml' },
};
function config(root: string) {
  return configSchema.parse({
    gates: [unit],
    version: 1,
    name: 'Legacy discussion fixture',
    repository: join(root, 'app'),
    mode: 'demo',
    concurrency: 4,
    maxAttempts: 3,
    isolation: { mode: 'none' },
    roles: { qa: { runtime: 'demo' } },
    reviewer: { runtime: 'demo' },
    repositories: [{ id: 'app', name: 'App', path: join(root, 'app'), gates: [unit] }],
  });
}

function project(app: string) {
  mkdirSync(join(app, 'src'), { recursive: true });
  writeFileSync(join(app, 'verify.mjs'), "console.log('ok');\n");
  writeFileSync(join(app, 'src/greet.mjs'), "export const greet = () => 'hi';\n");
  writeFileSync(join(app, '.gitignore'), '.reports/\n.devcontour-local/\n');
  git(app, 'init', '-q', '-b', 'main');
  git(app, 'add', '-A');
  git(app, 'commit', '-qm', 'project');
  git(app, 'branch', 'devcontour/accepted');
  return git(app, 'rev-parse', 'HEAD');
}

function evidence(h: Any, run: Any, phase: 'candidate' | 'integration', at: string) {
  for (const kind of ['test', 'review'] as const)
    h.evidence(run.id, run.token, {
      kind,
      phase,
      sha: at,
      gate: kind === 'test' ? 'test' : 'independent-review',
      passed: true,
      command: kind === 'test' ? ['node', 'verify.mjs'] : ['demo', 'review-code'],
      exitCode: 0,
      log: `artifacts/${run.id}/${phase}/${kind}.log`,
      digest: digest(kind === 'test' ? 'a' : 'b'),
      summary: kind === 'test' ? '1 test, 0 failures' : 'Критерии выполнены',
      ...(kind === 'test'
        ? { tests: [{ id: 'greet.greets', status: 'passed' }] }
        : {
            inspection: {
              mode: 'diff-only',
              source: 'unavailable',
              commands: [],
              reason: 'Runtime не предоставил подтверждение выполненных команд.',
            },
          }),
    });
}

const noUsage = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reportedUsd: null,
  complete: false,
  source: 'unavailable',
};
const usage = (id: string, extra: Record<string, unknown>) => ({
  id,
  repositoryId: 'app',
  stage: 'implementation',
  runtime: 'claude',
  model: 'claude-model',
  runtimeVersion: '1.0.0',
  startedAt: at(3),
  promptBytes: 900,
  promptDigest: digest('c'),
  ...extra,
});

function populate(store: Any, root: string) {
  const app = join(root, 'app');
  const base = project(app);
  const h = new DevContour(store, config(root));
  const { engine } = executionOf(h);
  const approval = { actor: 'agent', authorRuntime: 'claude', reviewerRuntime: 'codex' };
  const taskId = (title: string) => store.read().tasks.find((t: Any) => t.title === title).id;
  const claim = (title: string) => {
    const run = h.claim('legacy-controller');
    if (run?.taskId !== taskId(title))
      throw new Error(`Выдана не та задача: ${title} (${JSON.stringify(run?.taskId)})`);
    return run;
  };
  h.pause(false);

  const { boardId } = h.importPlan({
    title: 'Релиз приветствий',
    description: 'Цель релиза: функции приветствия.',
    tasks: ['accepted', 'draft', 'pending'].map((key) => ({
      key,
      repositoryId: 'app',
      title: `Задача ${key}`,
      description: `Наблюдаемый результат задачи ${key} проверяется тестом.`,
      role: 'qa',
      dependsOn: [],
      acceptance: [`Сценарий ${key} проверен тестом.`],
      contracts: [],
      writePaths: ['src'],
      gates: ['test'],
    })),
  });
  // Утверждённые задачи: политика закрепляется в `approvedPolicy`.
  h.approve(boardId, [taskId('Задача accepted'), taskId('Задача draft')], approval);

  // Принятая задача.
  let run = claim('Задача accepted');
  h.phase(run.id, run.token, 'running', { baseSha: base });
  h.phase(run.id, run.token, 'verifying', { candidateSha: sha('2') });
  evidence(h, run, 'candidate', sha('2'));
  h.phase(run.id, run.token, 'integrating', { integrationSha: sha('3') });
  evidence(h, run, 'integration', sha('3'));
  h.finish(run.id, run.token, sha('3'));
  const accepted = run;

  // Незавершённая попытка: черновик реализации и отказ по времени.
  run = claim('Задача draft');
  h.phase(run.id, run.token, 'running', { baseSha: base, worktree: join(root, 'wt', run.id) });
  const patch = `artifacts/${run.id}/implementation/partial.patch`;
  const draftTask = store.read().tasks.find((t: Any) => t.id === run.taskId);
  engine.recordPartial(run.id, run.token, {
    patch,
    digest: sha256('diff --git a/src/greet.mjs b/src/greet.mjs\n'),
    files: ['src/greet.mjs'],
    spec: draftTask.approvedDigest,
    contracts: {},
  });
  h.fail(run.id, run.token, 'Время реализации истекло', false, 'timeout');
  const unfinished = run;
  const failed = store.read().tasks.find((t: Any) => t.id === unfinished.taskId);
  if (failed.status !== 'ready') h.retry(failed.id);

  // Продолжение: следующая попытка начала с черновика и ещё идёт (срок истёк).
  run = claim('Задача draft');
  h.phase(run.id, run.token, 'running', { baseSha: base, worktree: join(root, 'wt', run.id) });
  engine.continuation(run.id, run.token, {
    runId: unfinished.id,
    kind: 'unfinished',
    reason: 'timeout',
    applied: true,
    files: ['src/greet.mjs'],
  });
  const continued = run;
  store.change('legacy.expired', (s: Any) => {
    for (const r of s.runs) if (r.status === 'active') r.leaseUntil = Date.parse(at(30));
    return {};
  });

  h.approve(boardId, [taskId('Задача pending')], approval);

  // Учёт вызовов: сообщённая стоимость, неизвестная и «идущий» вызов умершего процесса.
  store.atomic(() => {
    const save = (r: Any) => {
      usageSchema.parse(r.usage);
      store.saveLocal('usage', 'app', r.id, r);
    };
    save(
      usage('call-reported', {
        runId: accepted.id,
        taskId: accepted.taskId,
        boardId,
        finishedAt: at(4),
        outcome: 'returned',
        durationMs: 60000,
        usage: {
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reportedUsd: 0.25,
          complete: true,
          source: 'claude-result',
        },
        costUsd: 0.25,
        costSource: 'provider-reported',
      }),
    );
    save(
      usage('call-timeout', {
        runId: unfinished.id,
        taskId: unfinished.taskId,
        boardId,
        finishedAt: at(8),
        outcome: 'error',
        durationMs: 300000,
        usage: noUsage,
        costUsd: null,
        costSource: 'unknown',
      }),
    );
    save(
      usage('call-active-dead', {
        runId: continued.id,
        taskId: continued.taskId,
        boardId,
        outcome: 'active',
        process: { id: 'dead-process', pid: 999999, startedAt: Date.parse(at(1)) },
        elapsedMs: 4000,
        usage: noUsage,
        costUsd: null,
        costSource: 'unknown',
      }),
    );
  });

  // Обсуждение: заметки оператора и ведущего, обращение с обработкой и
  // открытое обращение к ведущему.
  const d = new DiscussionService(h);
  const draftId = taskId('Задача draft');
  const pendingId = taskId('Задача pending');
  d.post(
    {
      taskId: draftId,
      kind: 'note',
      text: 'Черновик остался после таймаута; продолжение идёт.',
      idempotencyKey: 'legacy-note-operator',
      expectedVersion: 0,
    },
    'operator',
  );
  const request = d.post(
    {
      taskId: draftId,
      kind: 'change-request',
      text: 'Добавьте приветствие по имени.',
      idempotencyKey: 'legacy-request-rejected',
      expectedVersion: 1,
    },
    'operator',
  );
  d.resolve({
    requestId: request.message.id,
    outcome: 'rejected',
    reason: 'Вне цели релиза: отдельная задача.',
    idempotencyKey: 'legacy-disposition-1',
    expectedVersion: 2,
  });
  d.post(
    {
      taskId: draftId,
      kind: 'note',
      text: 'Заметка ведущего: ждём продолжения.',
      idempotencyKey: 'legacy-note-lead',
      expectedVersion: 3,
    },
    'lead',
  );
  const open = d.post(
    {
      taskId: pendingId,
      kind: 'change-request',
      text: 'Уточните текст приветствия в критериях.',
      idempotencyKey: 'legacy-request-open',
      expectedVersion: 0,
    },
    'operator',
  );

  const s = store.read();
  const expected = {
    source: { devcontour: '0.4.0-alpha.17', harness: '0.1.0-alpha.36', commit: 'aee0ed9' },
    tasks: Object.fromEntries(
      s.tasks.map((t: Any) => [
        t.title,
        { id: t.id, status: t.status, spec: specDigest(t), approvedPolicy: t.approvedPolicy },
      ]),
    ),
    planPolicy: h.planPolicyDigest(),
    runs: {
      accepted: accepted.id,
      unfinished: unfinished.id,
      continued: continued.id,
    },
    usage: ['call-active-dead', 'call-reported', 'call-timeout'],
    discussion: {
      [draftId]: d.read({ taskId: draftId }).messages.map((m: Any) => `${m.author}:${m.kind}`),
      [pendingId]: d.read({ taskId: pendingId }).messages.map((m: Any) => `${m.author}:${m.kind}`),
    },
    openRequests: [open.message.id],
  };
  writeFileSync(join(root, 'expected.json'), JSON.stringify(expected, null, 2) + '\n');
}

const ROOT = out;
if (realpathSync(dirname(ROOT)) !== dirname(ROOT))
  throw new Error('Каталог вывода — канонический путь: ' + realpathSync(dirname(ROOT)));

/** Репозиторий компонента — рядом как `app.git`; удаляются только отслеживаемые файлы. */
function packRepository(root: string) {
  const app = join(root, 'app');
  const tracked = git(app, 'ls-files', '-z').split('\0').filter(Boolean);
  renameSync(join(app, '.git'), join(root, 'app.git'));
  const hooks = join(root, 'app.git', 'hooks');
  for (const f of readdirSync(hooks)) if (f.endsWith('.sample')) unlinkSync(join(hooks, f));
  rmdirSync(hooks);
  for (const f of tracked) unlinkSync(join(app, f));
  rmdirSync(join(app, 'src'));
}

const croot = join(out, 'central');
mkdirSync(join(croot, 'app'), { recursive: true });
const central = new Store(join(croot, 'state.sqlite'), undefined, false, 'DELETE');
writeFileSync(join(croot, 'config.json'), JSON.stringify(config(croot), null, 2) + '\n');
populate(central, croot);
central.close();
packRepository(croot);

const root = join(out, 'component');
mkdirSync(join(root, 'app'), { recursive: true });
mkdirSync(join(root, 'coordinator'), { recursive: true });
const component = new Store(join(root, 'coordinator', 'state.sqlite'), [
  { id: 'app', path: join(root, 'app') },
]);
writeFileSync(
  join(root, 'coordinator', 'config.json'),
  JSON.stringify({ ...config(root), storage: 'component' }, null, 2) + '\n',
);
populate(component, root);
component.close();
packRepository(root);
writeFileSync(join(out, 'ROOT'), ROOT + '\n');
console.log('legacy discussion fixtures written to', out);
