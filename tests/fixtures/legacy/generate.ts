/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument --
 * Генератор вызывает код прежней версии из другого checkout: его типов здесь
 * нет, модули загружаются по пути во время запуска.
 */
/**
 * Генератор баз прежней версии для проверки совместимости (T35).
 *
 * Запускается из checkout DevContour прежней версии — состояние пишет её
 * собственный код (`DevContour`, `Store`):
 *
 *   node --import tsx tests/fixtures/legacy/generate.ts <checkout прежней версии> <каталог вывода>
 *
 * Получаются две базы с вымышленными данными: central (`central/state.sqlite`)
 * и component (`component/coordinator/state.sqlite` и базы компонента `app` в
 * `component/app/.devcontour-local/`). В каждой: принятая задача с result
 * SHA, задача с историей отказов, ожидающая задача, активная попытка с
 * истёкшим сроком, попытка в окне после продвижения ветки (integration SHA и
 * полные evidence записаны, приёмка нет), учёт вызовов моделей, задание
 * ведущего и пауза отказа рантайма прежнего формата (`pauseFailure`).
 *
 * Пути component-базы абсолютны (реестр компонентов, владелец базы
 * компонента): тест копирует каталог и переносит реестр на новый корень.
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [baseline, out] = process.argv.slice(2) as [string, string];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const { Store } = await import(join(baseline, 'src/core/store.ts'));
const { DevContour } = await import(join(baseline, 'src/core/service.ts'));
const { configSchema } = await import(join(baseline, 'src/core/model.ts'));

const sha = (c: string) => c.repeat(40);
const digest = (c: string) => c.repeat(64);
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

const gates = [
  {
    id: 'test',
    kind: 'test',
    command: ['node', 'verify.mjs'],
    report: { type: 'junit', path: '.reports/junit.xml' },
  },
];
function config(root: string) {
  return configSchema.parse({
    gates,
    version: 1,
    name: 'Legacy fixture',
    repository: root,
    mode: 'demo',
    concurrency: 4,
    maxAttempts: 3,
    roles: { qa: { runtime: 'demo' } },
    reviewer: { runtime: 'demo' },
    repositories: [
      {
        id: 'app',
        name: 'App',
        path: join(root, 'app'),
        gates,
      },
    ],
  });
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
      summary: kind === 'test' ? '3 tests, 0 failures' : 'Критерии выполнены',
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

function populate(store: Any, root: string) {
  const h = new DevContour(store, config(root));
  const { boardId } = h.importPlan({
    title: 'Релиз приветствий',
    description: 'Цель релиза: функции приветствия.',
    tasks: ['accepted', 'failed', 'pending', 'active', 'window'].map((key, i) => ({
      key,
      repositoryId: 'app',
      title: `Задача ${key}`,
      description: `Наблюдаемый результат задачи ${key} проверяется тестом.`,
      role: 'qa',
      dependsOn: i === 2 ? ['accepted'] : [],
      acceptance: [`Сценарий ${key} проверен тестом.`],
      contracts: [],
      writePaths: ['src'],
    })),
  });
  const approval = { actor: 'agent', authorRuntime: 'claude', reviewerRuntime: 'codex' };
  const byTitle = (title: string) => store.read().tasks.find((t: Any) => t.title === title).id;
  // Задачи утверждаются по одной: выдаётся ровно та, которую ведёт генератор.
  const claim = (title: string) => {
    if (store.read().tasks.find((t: Any) => t.id === byTitle(title)).status === 'draft')
      h.approve(boardId, [byTitle(title)], approval);
    const run = h.claim('legacy-controller');
    if (run?.taskId !== byTitle(title)) throw new Error('Выдана не та задача: ' + title);
    return run;
  };
  h.pause(false);
  // Принятая задача.
  let run = claim('Задача accepted');
  h.phase(run.id, run.token, 'running', {
    baseSha: sha('1'),
    worktree: join(root, 'worktrees', run.id),
  });
  h.phase(run.id, run.token, 'verifying', { candidateSha: sha('2') });
  evidence(h, run, 'candidate', sha('2'));
  h.phase(run.id, run.token, 'integrating', { integrationSha: sha('3') });
  evidence(h, run, 'integration', sha('3'));
  h.finish(run.id, run.token, sha('3'));
  // История отказов: два содержательных отказа подряд, задача остаётся в отказе.
  run = claim('Задача failed');
  h.phase(run.id, run.token, 'running', { baseSha: sha('3') });
  h.fail(run.id, run.token, 'Нет PASS: candidate/test', false, 'gate');
  h.retry(byTitle('Задача failed'));
  run = claim('Задача failed');
  h.phase(run.id, run.token, 'running', { baseSha: sha('3') });
  h.fail(run.id, run.token, 'Ревью отклонило результат', false, 'review');
  // Активная попытка с истёкшим сроком владения.
  run = claim('Задача active');
  h.phase(run.id, run.token, 'running', { baseSha: sha('3') });
  // Попытка в окне после продвижения ветки: integration SHA и evidence есть.
  const window = claim('Задача window');
  h.phase(window.id, window.token, 'running', { baseSha: sha('3') });
  h.phase(window.id, window.token, 'verifying', { candidateSha: sha('4') });
  evidence(h, window, 'candidate', sha('4'));
  h.phase(window.id, window.token, 'integrating', { integrationSha: sha('5') });
  evidence(h, window, 'integration', sha('5'));
  store.change('legacy.expired', (s: Any) => {
    for (const r of s.runs) if (r.status === 'active') r.leaseUntil = Date.parse(at(30));
    return {};
  });
  // Ожидающая задача: утверждена, ждёт выдачи.
  h.approve(boardId, [byTitle('Задача pending')], approval);
  // Учёт вызовов — локальная запись прежней формы.
  const accepted = store.read().runs.find((r: Any) => r.status === 'succeeded');
  store.atomic(() => {
    store.saveLocal('usage', 'app', 'call-1', {
      id: 'call-1',
      repositoryId: 'app',
      runId: accepted.id,
      stage: 'implementation',
      runtime: 'claude',
      model: 'claude-model',
      runtimeVersion: '1.0.0',
      startedAt: at(3),
      finishedAt: at(4),
      outcome: 'returned',
      durationMs: 60000,
      taskId: accepted.taskId,
      boardId,
      promptBytes: 1200,
      promptDigest: digest('c'),
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
    });
  });
  // Пауза отказа рантайма прежнего формата: одна причина в `pauseFailure`.
  return h;
}

function legacyPause(file: string) {
  const db = new DatabaseSync(file);
  const raw = JSON.parse((db.prepare('SELECT data FROM state WHERE id=1').get() as Any).data);
  raw.paused = true;
  raw.pauseReason = 'runtime';
  raw.pauseFailure = 'provider-auth';
  delete raw.pauseFailures;
  db.prepare('UPDATE state SET data=? WHERE id=1').run(JSON.stringify(raw));
  db.close();
}

// central
const centralRoot = join(out, 'central');
mkdirSync(join(centralRoot, 'app'), { recursive: true });
const central = new Store(join(centralRoot, 'state.sqlite'), undefined, false, 'DELETE');
populate(central, realpathSync(centralRoot));
central.close();
legacyPause(join(centralRoot, 'state.sqlite'));

// component
const componentRoot = join(out, 'component');
mkdirSync(join(componentRoot, 'app'), { recursive: true });
mkdirSync(join(componentRoot, 'coordinator'), { recursive: true });
const root = realpathSync(componentRoot);
const component = new Store(join(root, 'coordinator', 'state.sqlite'), [
  { id: 'app', path: join(root, 'app') },
]);
populate(component, root);
component.close();
legacyPause(join(root, 'coordinator', 'state.sqlite'));
writeFileSync(join(out, 'ROOT'), root + '\n');
console.log('legacy fixtures written to', out);
