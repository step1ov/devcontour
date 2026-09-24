import { measuredExecute } from './usage.ts';
import { toolProfileFor, agentEnvironment } from './tools.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DevContour } from '../core/service.ts';
import { adapters } from './adapters.ts';
import {
  repositories,
  declaredRoles,
  roleBinding,
  requiresContract,
} from '../core/repositories.ts';
import { planResult } from '../core/plan.ts';
import type { Task } from '../core/model.ts';
export async function plan(
  h: DevContour,
  root: string,
  brief: string,
  runtime: 'codex' | 'claude',
  model?: string,
  runtimes: typeof adapters = adapters,
) {
  const artifactDir = join(root, 'plans', randomUUID());
  await mkdir(artifactDir, { recursive: true });
  // Роль для профиля инструментов берётся объявленная: конфигурация вправе не
  // содержать ни одной встроенной, и «architect» в ней может отсутствовать.
  const declared = declaredRoles(h.config);
  if (!declared.length)
    throw new Error(
      'В конфигурации не объявлено ни одной роли: планировать некому. Объявите роли в профиле или в workspace.',
    );
  const toolProfile = toolProfileFor(
    h.config,
    runtime,
    declared.includes('architect') ? 'architect' : declared[0],
    true,
  );
  // Планировщику называются объявленные роли с их границами и проверки
  // компонента. Прежде подсказка требовала четыре встроенные роли; с тех пор
  // роли объявляет workspace, и такой план отклоняется доменом как ссылка на
  // несуществующую роль — планирование ломалось там, ради чего роли и сделаны
  // расширяемыми.
  const roles = repositories(h.config).map((repo) => ({
    repositoryId: repo.id,
    roles: declaredRoles(h.config, repo.id).map((role) => {
      const binding = roleBinding(h.config, role, repo.id);
      return {
        role,
        title: binding?.title,
        writePaths: binding?.writePaths,
        requiresContract: requiresContract(h.config, role, repo.id),
      };
    }),
  }));
  const gates = repositories(h.config).map((repo) => ({
    repositoryId: repo.id,
    gates: repo.gates.map(({ id, kind }) => ({ id, kind })),
  }));
  const request = {
    toolProfile,
    execution: agentEnvironment(h.config, toolProfile),
    purpose: 'plan' as const,
    cwd: h.config.repository,
    artifactDir,
    review: true,
    task: {} as Task,
    model,
    signal: AbortSignal.timeout(h.config.runTimeoutMs),
    timeoutMs: h.config.runTimeoutMs,
    prompt: [
      'You are a product planner. Inspect the repository read-only. Propose a small first vertical slice, at most 15 tasks. Do not edit files, run implementation agents, commit, or mark tasks done. Independent plan review follows; the coordinator handles approval according to project policy.',
      "Declared roles, by repository. A task may only use a role declared for its own repository; no other role exists. Where a role has writePaths, the task's writePaths must lie inside them, or the executor can change nothing. A role marked requiresContract needs an approved contract bound to its task: " +
        JSON.stringify(roles),
      'Configured checks, by repository. A task proves itself with gates: a subset of these that must include a test gate. Requirements link to a test gate from that same subset: ' +
        JSON.stringify(gates),
      'Use a DAG with stable local keys. Roles owning separate surfaces can work in parallel once their shared contracts are agreed; test scenarios can be prepared early. Each task must have observable acceptance criteria. Include design references, prototype and semantic tokens when UI changes. Return only the requested JSON structure.',
      'Keep component tasks scoped to their repository. Use scope=workspace and relatedRepositories only for work spanning multiple components. Component rules and task histories are local; the coordinator owns shared contracts and dependency links.',
      'Available repositories: ' +
        JSON.stringify(
          repositories(h.config).map(({ id, name, kind, path }) => ({ id, name, kind, path })),
        ) +
        '. Every task must set repositoryId to a registered ID. Dependencies may cross repositories. Inspect the required repositories read-only.',
      'Assign narrow writePaths from actual repository structure. Use contextPacks IDs for relevant custom libraries and mobile testing; never invent IDs. Declare resources needed by task-level MCP work. Other-layer changes become dependent tasks, not scope expansion.',
      'When the specification has REQ-* sections, use requirements_snapshot through the lead agent and preserve exact id/source/text/digest bindings. Link each requirement to a configured test gate and an observable scenario; never invent a digest.',
      'Read the component intent when present (docs/implementation-intent.md for embedded workspace; INTENT.md otherwise). Use the source path returned by intent_snapshot. The lead prepares it from the specification, then uses intent_snapshot for exact story REQ bindings. Bind both the selected story and its detailed REQ sections to tasks. Cover only the requested release; preserve IDs, product purpose, constraints and non-goals. The release inventory must account for every declared source requirement, including work not yet decomposed. Do not weaken intent to fit implementation or mark a release complete from task counts.',
      'Available context packs: ' + JSON.stringify(h.config.contextPacks),
      'Available resource IDs: ' +
        JSON.stringify(h.config.resources.map(({ id, kind }) => ({ id, kind }))),
      'Approved contracts available (only reference these IDs, or use an empty contracts array): ' +
        JSON.stringify(h.store.read().contracts),
      'User brief:\n' + brief,
    ].join('\n\n'),
  };
  const result = await measuredExecute(h, runtimes[runtime], request, { stage: 'planning' });
  const parsed = planResult.parse(result.data);
  const output = join(artifactDir, 'plan.json');
  await writeFile(output, JSON.stringify(parsed, null, 2) + '\n');
  const imported = h.importPlan(parsed);
  return { ...imported, output };
}
