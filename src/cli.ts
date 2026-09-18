#!/usr/bin/env node
import { engineeringEvals } from './runner/engineering-evals.ts';
import { compareEvaluations } from './application/eval-comparison.ts';
import { workflowMetrics } from './application/metrics.ts';
import { evaluateAgents } from './runner/evaluations.ts';
import {
  requirementSnapshot,
  requirementReport,
  correctRequirements,
} from './runner/requirements.ts';
import { repository as selectedRepository } from './core/repositories.ts';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { AgentService, capabilities } from './application/agent.ts';
import { serveMcp } from './server/mcp.ts';
import { repositories } from './core/repositories.ts';
import { doctor } from './runner/doctor.ts';
import { cleanupEnvironment } from './runner/environment.ts';
import { importKnowledge } from './runner/knowledge.ts';
import { DeliveryRunner } from './runner/forge.ts';
import { lockContextFile, taskContext } from './runner/context.ts';
import { ResourcePool, resourceDatabase, processAlive } from './runner/resources.ts';
import { mkdir, writeFile, readFile, realpath, rename } from 'node:fs/promises';
import { join, resolve, dirname, sep } from 'node:path';
import { Store } from './core/store.ts';
import { Harness } from './core/service.ts';
import { configSchema } from './core/model.ts';
import { loadConfig, scopedConfig } from './runner/config.ts';
import { Scheduler } from './runner/scheduler.ts';
import { command, git } from './runner/process.ts';
import { serve } from './server/http.ts';
import { plan } from './runner/planner.ts';
import { profile } from './runner/packs.ts';
import { profileLock, projectConfig, setupProject } from './runner/setup.ts';
import { acceptBoard, reviewContract, reviewPlan } from './runner/agent-control.ts';
import { specDigest } from './core/service.ts';
import { WorkspaceRunner } from './runner/workspace.ts';
import { setupWorkspace } from './runner/workspace-setup.ts';
import { Workspace } from './core/workspace.ts';
import { attachJournal } from './runner/journal.ts';
import { commandScope } from './runner/scope.ts';
import { syncGit } from './runner/git-sync.ts';
import { setupDemo, exists } from './demo.ts';
const args = process.argv.slice(2),
  operation = args[0] ?? 'serve';
const option = (name: string, fallback: string) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
let root: string;
let workspacePath: string | undefined;
const authorRuntime = () => {
  const value = option('--author-runtime', '');
  if (value !== 'codex' && value !== 'claude')
    throw new Error('Укажите --author-runtime codex|claude');
  return value;
};
async function main() {
  if (operation === 'eval-compare') {
    if (!args.includes('--baseline') || !args.includes('--candidate'))
      throw new Error('Укажите --baseline и --candidate JSON reports');
    console.log(
      JSON.stringify(
        compareEvaluations(
          JSON.parse(await readFile(resolve(option('--baseline', '')), 'utf8')),
          JSON.parse(await readFile(resolve(option('--candidate', '')), 'utf8')),
        ),
        null,
        2,
      ),
    );
    return;
  }
  if (operation === 'engineering-evals') {
    if (
      !args.includes('--live') &&
      (args.includes('--runtime') || args.includes('--model') || args.includes('--reviewer-model'))
    )
      throw new Error('Для моделей требуется --live');
    if (args.includes('--live') && !args.includes('--runtime'))
      throw new Error('Укажите --runtime codex|claude');
    const result = await engineeringEvals({
      runtime: args.includes('--live') ? option('--runtime', '') : undefined,
      model: args.includes('--model') ? option('--model', '') : undefined,
      reviewerModel: args.includes('--reviewer-model') ? option('--reviewer-model', '') : undefined,
      prices: args.includes('--prices')
        ? JSON.parse(await readFile(resolve(option('--prices', '')), 'utf8'))
        : undefined,
      repetitions: Number(option('--repetitions', '1')),
      maxCalls: Number(option('--max-calls', '9')),
      timeoutMs: Number(option('--timeout-ms', '120000')),
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
    return;
  }
  if (operation === 'evals') {
    const runtime = option('--runtime', '');
    if (args.includes('--live') && runtime !== 'codex' && runtime !== 'claude')
      throw new Error('Live evals требуют --runtime codex|claude');
    if (!args.includes('--live') && (runtime || args.includes('--model')))
      throw new Error('Для вызовов модели явно укажите --live');
    const result = await evaluateAgents({
      runtime: args.includes('--live') ? (runtime as 'codex' | 'claude') : undefined,
      model: args.includes('--model') ? option('--model', '') : undefined,
      prices: args.includes('--prices')
        ? JSON.parse(await readFile(resolve(option('--prices', '')), 'utf8'))
        : undefined,
      repetitions: Number(option('--repetitions', '1')),
      maxCalls: Number(option('--max-calls', '6')),
      timeoutMs: Number(option('--timeout-ms', '120000')),
      instructions: args.includes('--instructions')
        ? await readFile(resolve(option('--instructions', '')), 'utf8')
        : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
    return;
  }
  if (operation === 'skill-path') {
    console.log(fileURLToPath(new URL('../skills/devcontour', import.meta.url)));
    return;
  }
  if (operation === 'capabilities') {
    console.log(JSON.stringify(capabilities(), null, 2));
    return;
  }
  if (operation === 'help' || args.includes('--help')) {
    console.log(
      'devcontour engineering-evals [--live --runtime codex|claude --model ID --reviewer-model ID]\ndevcontour eval-compare --baseline report.json --candidate report.json',
    );
    console.log(
      'DevContour · AI-native разработка\nЗапуск: npm run devcontour -- <команда> [параметры]\n\n' +
        'devcontour evals [--live --runtime codex|claude --model MODEL --repetitions 3 --max-calls 18]\ndevcontour metrics [--repository-id main] --workspace ...\ndevcontour requirements-snapshot --repository-id main --file docs/spec.md --workspace ...\ndevcontour requirements-report --repository-id main --workspace ...\ndevcontour requirements-correct --board ID --reason ... --workspace ...\ndevcontour capabilities\ndevcontour mcp --workspace /absolute/workspace\ndevcontour agent --file request.json --workspace /absolute/workspace\n' +
        'devcontour sync [--member alice] [--allow-branch-change] [--resolutions file.json] --workspace ...\ndevcontour sync-status --workspace ...\ndevcontour assign-task --task <id> --member alice --workspace ...\n' +
        'devcontour storage-migrate --workspace ...\ndevcontour doctor [--probe] --workspace ...\ndevcontour handoff | remote-check --changeset CHG-1 --workspace ...\ndevcontour knowledge-import --source /donor --files README.md,docs/api.md [--ref HEAD] --workspace ...\ndevcontour environment-cleanup --receipt /absolute/receipt/environment.json --workspace ...\nДля нового проекта агент спрашивает абсолютный путь workspace. Все команды принимают --workspace /absolute/path вместо --data.\ndevcontour workspace-init --file /workspace/workspace.json [--data ...]\ndevcontour changeset-create --file changeset.json --data ...\ndevcontour workspace-verify | changeset-accept --changeset CHG-1 --data ...\ndevcontour journal --data ...\ndevcontour context-lock [--ref HEAD] | context-show --task T1 --workspace ...\ndevcontour resources | resource-release --key <key> --token <token> --cleanup-confirmed --workspace ...\ndevcontour setup --repository /absolute/product --profile <id> --workspace /absolute/workspace [--brief docs/spec.md] [--approval-mode agent|operator]\ndevcontour demo [--port 4317] | serve --workspace /absolute/workspace [--port 4317] [--dev]\ndevcontour init --repository /absolute/repo --data .harness/local\ndevcontour run | export | import-plan --file plan.json | doctor --data ...\ndevcontour plan --brief brief.md --runtime codex --data .harness/local\ndevcontour review-contract --file contract.json --author-runtime codex|claude --data ...\ndevcontour review-plan | accept --board B1 --author-runtime codex|claude --data ...\ndevcontour queue --start | --pause --data ...\ndevcontour retry --task T1 | edit-task --task T1 --file task.json | correct --board B1 --roots T1,T2 --reason ... --data ...',
    );
    return;
  }
  ({ data: root, workspace: workspacePath } = commandScope(args, operation));
  if (operation === 'workspace-init') {
    if (!args.includes('--file')) throw new Error('Укажите --file workspace.json');
    if (
      workspacePath &&
      (await realpath(workspacePath)) !== dirname(await realpath(resolve(option('--file', ''))))
    )
      throw new Error('--file должен находиться в выбранном workspace');
    console.log(
      JSON.stringify(
        await setupWorkspace(option('--file', ''), args.includes('--data') ? root : undefined),
        null,
        2,
      ),
    );
    return;
  }
  if (operation === 'setup') {
    if (!args.includes('--repository') || !args.includes('--profile'))
      throw new Error('Агент должен указать --repository и выбранный по ТЗ --profile');
    console.log(
      JSON.stringify(
        await setupProject({
          repository: option('--repository', ''),
          profile: option('--profile', ''),
          brief: option('--brief', 'docs/spec.md'),
          workspace: workspacePath,
          data: args.includes('--data') ? root : undefined,
          approvalMode: args.includes('--approval-mode')
            ? configSchema.shape.approvalMode.parse(option('--approval-mode', 'agent'))
            : undefined,
        }),
        null,
        2,
      ),
    );
    return;
  }
  if (operation === 'init') {
    if (!args.includes('--repository')) throw new Error('Укажите --repository');
    if (await exists(join(root, 'config.json'))) throw new Error('Конфигурация уже существует');
    const repository = await git(
      resolve(option('--repository', '.')),
      'rev-parse',
      '--show-toplevel',
    );
    if (
      workspacePath &&
      (workspacePath === repository || workspacePath.startsWith(repository + sep))
    )
      throw new Error('Workspace должен находиться вне репозитория продукта');
    await mkdir(root, { recursive: true });
    const selected = await profile(option('--profile', 'react-vite-admin'));
    const c = projectConfig(
      repository,
      selected,
      configSchema.shape.approvalMode.parse(option('--approval-mode', 'agent')),
    );
    if (workspacePath) {
      c.workspaceRoot = await realpath(workspacePath);
      c.storage = 'component';
    }
    await writeFile(join(root, 'config.json'), JSON.stringify(scopedConfig(c), null, 2) + '\n');
    await writeFile(
      join(root, 'packs.lock.json'),
      JSON.stringify(profileLock(selected), null, 2) + '\n',
    );
    console.log(
      `Создан ${join(root, 'config.json')}. Настройте обязательные gates и JUnit report до запуска.`,
    );
    return;
  }
  const agentOperations = [
    'sync',
    'sync-status',
    'assign-task',
    'handoff',
    'remote-check',
    'knowledge-import',
    'environment-cleanup',
    'context-lock',
    'context-show',
    'resources',
    'resource-release',
    'changeset-create',
    'workspace-verify',
    'changeset-accept',
    'journal',
    'review-contract',
    'review-plan',
    'accept',
    'queue',
    'retry',
    'edit-task',
    'correct',
  ];
  if (operation === 'demo') await setupDemo(root);
  const config = loadConfig(join(root, 'config.json'));
  if (workspacePath && config.workspaceRoot !== (await realpath(workspacePath)))
    throw new Error(
      'Конфигурация не принадлежит выбранному workspace; для прежней конфигурации используйте --data',
    );
  if (operation === 'storage-migrate') {
    const inspectDB = new DatabaseSync(join(root, 'state.sqlite'));
    const partitioned = Boolean(
      JSON.parse(
        (inspectDB.prepare('SELECT data FROM state WHERE id=1').get() as { data: string }).data,
      ).componentLayout,
    );
    inspectDB.close();
    if (!partitioned) {
      const legacy = new Store(join(root, 'state.sqlite'));
      try {
        const s = legacy.read();
        if (
          !s.paused ||
          s.runs.some((r) => r.status === 'active') ||
          s.changeSets.some(
            (c) =>
              c.verifications.some((v) => v.status === 'active') ||
              c.deliveries?.some((d) => d.status === 'active'),
          )
        )
          throw new Error('Остановите очередь и активные попытки перед миграцией');
      } finally {
        legacy.close();
      }
    }
    config.storage = 'component';
    const migrated = new Store(join(root, 'state.sqlite'), repositories(config), true);
    migrated.close();
    const tempConfig = join(root, `config.migrating-${process.pid}.json`);
    await writeFile(tempConfig, JSON.stringify(scopedConfig(config), null, 2) + '\n');
    await rename(tempConfig, join(root, 'config.json'));
    console.log(
      JSON.stringify({
        status: 'migrated',
        components: repositories(config).map((r) => ({
          id: r.id,
          database: join(r.path, '.harness/local/state.sqlite'),
        })),
      }),
    );
    return;
  }
  const store = new Store(
    join(root, 'state.sqlite'),
    config.storage === 'component' ? repositories(config) : undefined,
  );
  const h = new Harness(store, config);
  if (operation === 'mcp') {
    const server = await serveMcp(new AgentService(h));
    let closed = false;
    const close = () => {
      if (!closed) {
        closed = true;
        store.close();
      }
    };
    server.server.onclose = close;
    for (const event of ['SIGTERM', 'SIGINT'] as const)
      process.once(event, () => {
        void server.close().finally(close);
      });
    return;
  }
  if (operation === 'agent') {
    try {
      if (!args.includes('--file'))
        throw new Error('Укажите --file request.json с operation и input');
      const request = JSON.parse(await readFile(resolve(option('--file', '')), 'utf8'));
      console.log(JSON.stringify(new AgentService(h).execute(request), null, 2));
    } finally {
      store.close();
    }
    return;
  }
  if (
    ['requirements-snapshot', 'requirements-report', 'requirements-correct'].includes(operation)
  ) {
    try {
      const repositoryId = option('--repository-id', 'main');
      const result =
        operation === 'requirements-snapshot'
          ? requirementSnapshot(
              selectedRepository(config, repositoryId).path,
              option('--file', 'docs/spec.md'),
            )
          : operation === 'requirements-report'
            ? requirementReport(h, repositoryId)
            : correctRequirements(
                h,
                option('--board', ''),
                option('--reason', 'Актуализация изменившихся требований'),
              );
      console.log(JSON.stringify(result, null, 2));
    } finally {
      store.close();
    }
    return;
  }
  if (operation === 'metrics') {
    try {
      console.log(
        JSON.stringify(
          workflowMetrics(
            h,
            args.includes('--repository-id') ? option('--repository-id', '') : undefined,
          ),
          null,
          2,
        ),
      );
    } finally {
      store.close();
    }
    return;
  }
  attachJournal(h);
  const scheduler = new Scheduler(h, root);
  const workspace = new Workspace(h);
  const workspaceRunner = new WorkspaceRunner(h, root);
  if (agentOperations.includes(operation)) {
    try {
      let result: unknown;
      if (operation === 'sync' || operation === 'sync-status') {
        result = syncGit(h, {
          dryRun: operation === 'sync-status',
          member: args.includes('--member') ? option('--member', '') : undefined,
          allowBranchChange: args.includes('--allow-branch-change'),
          resolutions: args.includes('--resolutions')
            ? JSON.parse(await readFile(resolve(option('--resolutions', '')), 'utf8'))
            : undefined,
        });
        if ((result as { status: string }).status === 'conflict') process.exitCode = 1;
      } else if (operation === 'assign-task') {
        result = h.assign(option('--task', ''), option('--member', ''));
      } else if (operation === 'handoff' || operation === 'remote-check') {
        const runner = new DeliveryRunner(h, root);
        try {
          result = await runner[operation === 'handoff' ? 'prepare' : 'check'](
            option('--changeset', ''),
          );
        } finally {
          await runner.stop();
        }
      } else if (operation === 'knowledge-import') {
        if (!config.workspaceRoot || !args.includes('--source') || !args.includes('--files'))
          throw new Error('Нужны workspaceRoot, --source и --files');
        result = await importKnowledge(
          config.workspaceRoot,
          resolve(option('--source', '')),
          option('--files', '').split(','),
          option('--ref', 'HEAD'),
        );
      } else if (operation === 'environment-cleanup') {
        const s = store.read();
        if (
          !s.paused ||
          s.runs.some((r) => r.status === 'active') ||
          s.changeSets.some(
            (c) =>
              c.verifications.some((v) => v.status === 'active') ||
              c.deliveries?.some((d) => d.status === 'active'),
          )
        )
          throw new Error('Сначала остановите очередь и активные попытки');
        const receipt = await realpath(resolve(option('--receipt', '')));
        const allowedRoots = [
          await realpath(root),
          ...repositories(config).map((r) => resolve(r.path, '.harness/local')),
        ];
        if (
          !allowedRoots.some((r) => receipt.startsWith(r + sep)) ||
          !receipt.endsWith('/environment.json')
        )
          throw new Error('Receipt должен принадлежать выбранному workspace');
        result = await cleanupEnvironment(receipt, config, allowedRoots);
      } else if (operation === 'context-lock') {
        const s = store.read();
        if (!s.paused) throw new Error('Сначала приостановите очередь: queue --pause');
        if (
          s.runs.some((r) => r.status === 'active') ||
          s.changeSets.some((c) => c.verifications.some((v) => v.status === 'active'))
        )
          throw new Error('Дождитесь завершения попыток перед обновлением контекста');
        result = {
          packs: await lockContextFile(config, join(root, 'config.json'), option('--ref', 'HEAD')),
          next: 'Перезапустите сервер, чтобы загрузить закреплённый контекст.',
        };
      } else if (operation === 'context-show') {
        const task = store.read().tasks.find((t) => t.id === option('--task', ''));
        if (!task) throw new Error('Задача не найдена');
        result = await taskContext(config, task);
      } else if (operation === 'resources' || operation === 'resource-release') {
        const pool = new ResourcePool(resourceDatabase(config));
        try {
          if (operation === 'resource-release') {
            if (!args.includes('--cleanup-confirmed'))
              throw new Error(
                'Сначала остановите оставшиеся драйверы/процессы ресурса; затем передайте --cleanup-confirmed',
              );
            pool.clearAbandoned(option('--key', ''), option('--token', ''));
          }
          result = {
            database: resourceDatabase(config),
            leases: pool.list().map((r) => ({ ...r, alive: processAlive(r.pid) })),
          };
        } finally {
          pool.close();
        }
      } else if (operation === 'changeset-create')
        result = workspace.create(
          JSON.parse(await readFile(resolve(option('--file', 'changeset.json')), 'utf8')),
        );
      else if (operation === 'workspace-verify')
        result = await workspaceRunner.verify(option('--changeset', ''));
      else if (operation === 'changeset-accept')
        result = workspace.accept(option('--changeset', ''), {
          actor: 'agent',
          authorRuntime: authorRuntime(),
        });
      else if (operation === 'journal') {
        store.refreshProjection();
        if (store.projectionError) throw new Error(store.projectionError);
        result = {
          directory: config.workspaceRoot ? join(config.workspaceRoot, 'docs', 'journal') : null,
        };
      } else if (operation === 'review-contract')
        result = await reviewContract(
          h,
          root,
          JSON.parse(await readFile(resolve(option('--file', 'contract.json')), 'utf8')),
          authorRuntime(),
        );
      else if (operation === 'review-plan')
        result = await reviewPlan(h, root, option('--board', ''), authorRuntime());
      else if (operation === 'accept')
        result = await acceptBoard(h, option('--board', ''), authorRuntime());
      else if (operation === 'queue') {
        if (args.includes('--start') === args.includes('--pause'))
          throw new Error('Укажите только --start или --pause');
        result = h.pause(args.includes('--pause'));
      } else if (operation === 'retry') result = h.retry(option('--task', ''));
      else if (operation === 'edit-task') {
        const task = store.read().tasks.find((t) => t.id === option('--task', ''));
        if (!task) throw new Error('Задача не найдена');
        result = h.editTask(
          task.id,
          JSON.parse(await readFile(resolve(option('--file', 'task.json')), 'utf8')),
          specDigest(task),
        );
      } else if (operation === 'correct') {
        const roots = option('--roots', '').split(',').filter(Boolean);
        if (!roots.length || !args.includes('--reason'))
          throw new Error('Укажите --roots и --reason');
        result = h.correct(option('--board', ''), roots, option('--reason', ''));
      }
      console.log(JSON.stringify(result, null, 2));
      if (store.projectionError) console.error('Journal: ' + store.projectionError);
    } finally {
      await workspaceRunner.stop();
      store.close();
    }
    return;
  }
  if (operation === 'doctor') {
    try {
      const s = store.read();
      if (
        args.includes('--probe') &&
        (!s.paused ||
          s.runs.some((r) => r.status === 'active') ||
          s.changeSets.some(
            (c) =>
              c.verifications.some((v) => v.status === 'active') ||
              c.deliveries?.some((d) => d.status === 'active'),
          ))
      )
        throw new Error('doctor --probe требует остановленную очередь');
      const result = await doctor(config, root, args.includes('--probe'));
      console.log(JSON.stringify(result, null, 2));
      if (!result.ready) process.exitCode = 1;
    } finally {
      store.close();
    }
    return;
  }
  if (operation === 'export') {
    console.log(JSON.stringify({ state: store.read(), events: store.events() }, null, 2));
    store.close();
    return;
  }
  if (operation === 'import-plan') {
    const input = JSON.parse(await readFile(resolve(option('--file', 'plan.json')), 'utf8'));
    console.log(JSON.stringify(h.importPlan(input)));
    store.close();
    return;
  }
  if (operation === 'plan') {
    if (config.mode === 'demo')
      throw new Error('Планирование моделью требует локальной конфигурации: init --data ...');
    const runtime = option('--runtime', 'codex');
    if (runtime !== 'codex' && runtime !== 'claude') throw new Error('runtime: codex или claude');
    const brief = await readFile(resolve(option('--brief', 'brief.md')), 'utf8');
    console.log(
      JSON.stringify(
        await plan(
          h,
          root,
          brief,
          runtime,
          args.includes('--model') ? option('--model', '') : undefined,
        ),
        null,
        2,
      ),
    );
    store.close();
    return;
  }
  await scheduler.init();
  if (operation === 'run') {
    h.pause(false);
    await scheduler.drain();
    await scheduler.stop();
    console.log(
      JSON.stringify(
        store.read().tasks.map((t) => ({ id: t.id, status: t.status, failure: t.failure })),
        null,
        2,
      ),
    );
    const failed = store.read().tasks.some((t) => t.status === 'failed');
    store.close();
    if (failed) process.exitCode = 1;
    return;
  }
  if (!['serve', 'demo'].includes(operation)) throw new Error('Неизвестная команда: ' + operation);
  const port = Number(option('--port', process.env.PORT ?? '4317'));
  if (!Number.isInteger(port) || (port !== 0 && port < 1024) || port > 65535)
    throw new Error('Некорректный port');
  const app = await serve(h, scheduler, { port, dev: args.includes('--dev') });
  console.log(
    `DevContour: ${app.url}\n${config.mode === 'demo' ? 'Учебный режим: модели не вызываются.' : 'Локальный режим: запуск использует настроенные CLI и их авторизацию.'}`,
  );
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void close());
  process.on('SIGTERM', () => void close());
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
