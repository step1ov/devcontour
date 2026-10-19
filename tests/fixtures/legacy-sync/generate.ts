/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access --
 * Генератор вызывает код прежней версии из другого checkout: его типов здесь
 * нет, модули загружаются по пути во время запуска.
 */
/**
 * Git-синхронизация прежней версии DevContour для проверки совместимости (T36).
 *
 *   cd <checkout прежней версии>
 *   node --import tsx <этот файл> <checkout прежней версии> <пустой каталог вывода>
 *
 * Участник alice ведёт workspace (component storage) с двумя принятыми
 * задачами доски: одна подтверждает названный testcase требования, другая —
 * без требований. Writer — codex, reviewer — claude. Состояние экспортирует
 * `syncGit` прежней версии и коммитит в Git workspace и продукта. В вывод
 * попадают только Git-репозитории: `workspace.git` и `product.git` (каталог
 * `.git` нельзя хранить в репозитории). Тест клонирует их и импортирует новой
 * версией. Данные вымышленные.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [baseline, out] = process.argv.slice(2) as [string, string];
const { Store } = await import(join(baseline, 'src/core/store.ts'));
const { DevContour, digest } = await import(join(baseline, 'src/core/service.ts'));
const { configSchema } = await import(join(baseline, 'src/core/model.ts'));
const { repositories } = await import(join(baseline, 'src/core/repositories.ts'));
const { syncGit } = await import(join(baseline, 'src/runner/git-sync.ts'));
const { requirementSnapshot } = await import(join(baseline, 'src/runner/requirements.ts'));

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Sync Fixture',
  GIT_AUTHOR_EMAIL: 'sync@example.test',
  GIT_COMMITTER_NAME: 'Sync Fixture',
  GIT_COMMITTER_EMAIL: 'sync@example.test',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};
const git = (path: string, ...args: string[]) =>
  execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', env }).trim();

const scratch = mkdtempSync(join(tmpdir(), 'devcontour-legacy-sync-'));
const workspace = join(scratch, 'workspace');
const repo = join(scratch, 'product');
for (const path of [workspace, repo]) {
  mkdirSync(path);
  git(path, 'init', '-q', '-b', 'main');
  writeFileSync(join(path, '.gitignore'), '.devcontour-local/\n');
  writeFileSync(join(path, 'README.md'), 'A legacy sync fixture.\n');
  git(path, 'add', '.');
  git(path, 'commit', '-qm', 'baseline');
}
writeFileSync(
  join(repo, 'spec.md'),
  '## REQ-legacy: Observed behaviour\nNamed testcase must run.\n',
);
git(repo, 'add', '.');
git(repo, 'commit', '-qm', 'Requirement');

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
syncGit(h, { member: 'alice' });

const board = h.createBoard('Legacy sync board', 'Принятая работа прежней версии.', 'main');
const snap = requirementSnapshot(repo, 'spec.md');
const named = h.addTask(board.id, {
  title: 'Named testcase',
  description: 'Наблюдаемое поведение подтверждено названным тестом.',
  role: 'qa',
  dependsOn: [],
  acceptance: ['The named testcase passes.'],
  requirements: [
    {
      ...snap.requirements[0],
      source: snap.source,
      gate: 'test',
      scenario: 'Observed behaviour',
      testId: 'named-case',
    },
  ],
});
const plain = h.addTask(board.id, {
  title: 'Plain task',
  description: 'Наблюдаемый результат проверяется тестом.',
  role: 'qa',
  dependsOn: [],
  acceptance: ['The expected result is checked.'],
});
h.approve(board.id, undefined, {
  actor: 'agent',
  authorRuntime: 'codex',
  reviewerRuntime: 'claude',
});
h.pause(false);
const sha = git(repo, 'rev-parse', 'HEAD');
git(repo, 'update-ref', 'refs/heads/' + config.targetBranch, sha);
for (const task of [named, plain]) {
  const run = h.claim('legacy-controller');
  if (run?.taskId !== task.id) throw new Error('Выдана не та задача: ' + task.title);
  h.phase(run.id, run.token, 'integrating', { candidateSha: sha, integrationSha: sha });
  const gates = task.id === named.id ? ['test', 'requirement-source'] : ['test'];
  for (const phase of ['candidate', 'integration'] as const)
    for (const gate of [...gates, 'independent-review'])
      h.evidence(run.id, run.token, {
        kind: gate === 'independent-review' ? 'review' : 'test',
        phase,
        sha,
        gate,
        passed: true,
        exitCode: 0,
        command: ['fixture'],
        log: '',
        digest: digest('fixture-' + gate),
        summary: 'fixture',
        tests:
          gate === 'test'
            ? [
                { id: 'named-case', status: 'passed' },
                { id: 'other-case', status: 'passed' },
              ]
            : undefined,
      });
  h.finish(run.id, run.token, sha);
}
h.pause(true);
h.accept(board.id, sha);
syncGit(h);
for (const path of [repo, workspace]) {
  git(path, 'add', '.devcontour');
  if (git(path, 'diff', '--cached', '--name-only'))
    git(path, 'commit', '-qm', 'Sync development state');
}
store.close();

// Только Git: рабочее дерево восстанавливает тест, хуки-образцы не нужны.
for (const [name, path] of [
  ['workspace', workspace],
  ['product', repo],
] as const) {
  const target = join(out, name + '.git');
  cpSync(join(path, '.git'), target, { recursive: true });
  const hooks = join(target, 'hooks');
  for (const f of readdirSync(hooks)) if (f.endsWith('.sample')) unlinkSync(join(hooks, f));
}
rmSync(scratch, { recursive: true, force: true });
console.log('legacy sync fixture written to', out);
