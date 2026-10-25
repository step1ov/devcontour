import { measuredAgentCall } from '../harness/measured.ts';
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
import { planningRequest } from 'devcontour-harness';
import type { Task } from '../core/model.ts';
/**
 * Продуктовые инструкции DevContour к общему запросу планирования: роль
 * планировщика продукта, дизайн-трек, требования и intent через ведущего.
 */
export const hostInstructions = [
  'You are a product planner.',
  'Include design references, prototype and semantic tokens when UI changes.',
  'Obtain REQ-* bindings with requirements_snapshot through the lead agent.',
  'Read the component intent when present (docs/implementation-intent.md for embedded workspace; INTENT.md otherwise). Use the source path returned by intent_snapshot. The lead prepares it from the specification, then uses intent_snapshot for exact story REQ bindings. Bind both the selected story and its detailed REQ sections to tasks. Cover only the requested release; preserve IDs, product purpose, constraints and non-goals. The release inventory must account for every declared source requirement, including work not yet decomposed. Do not weaken intent to fit implementation or mark a release complete from task counts.',
];

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
  // Общий запрос планирования — harness (`planningRequest`): read-only срез,
  // объявленные роли с границами и проверки компонента, DAG, репозитории,
  // пакеты контекста, ресурсы и контракты (записи целиком). Хост собирает
  // факты из своей конфигурации и добавляет продуктовые инструкции отдельным
  // блоком перед постановкой. Роли называются объявленные: прежде подсказка
  // требовала четыре встроенные, и такой план отклонялся доменом как ссылка
  // на несуществующую роль.
  const facts = {
    repositories: repositories(h.config).map(({ id, name, kind, path }) => ({
      id,
      name,
      kind,
      path,
    })),
    roles: repositories(h.config).map((repo) => ({
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
    })),
    gates: repositories(h.config).map((repo) => ({
      repositoryId: repo.id,
      gates: repo.gates.map(({ id, kind }) => ({ id, kind })),
      ...(repo.gateGroups ? { groups: repo.gateGroups } : {}),
    })),
    contextPacks: h.config.contextPacks,
    resources: h.config.resources,
    // Записи контрактов целиком: источник и декларация проверки видны планировщику.
    contracts: h.store.read().contracts.map((c) => ({ ...c })),
  };
  const { prompt } = planningRequest({ brief, facts, hostInstructions });
  // Роль для профиля инструментов берётся объявленная: конфигурация вправе не
  // содержать ни одной встроенной, и «architect» в ней может отсутствовать.
  const declared = declaredRoles(h.config);
  const toolProfile = toolProfileFor(
    h.config,
    runtime,
    declared.includes('architect') ? 'architect' : declared[0],
    true,
  );
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
    prompt,
  };
  const result = await measuredAgentCall(h, runtimes[runtime], request, { stage: 'planning' });
  const parsed = planResult.parse(result.data);
  const output = join(artifactDir, 'plan.json');
  await writeFile(output, JSON.stringify(parsed, null, 2) + '\n');
  const imported = h.importPlan(parsed);
  return { ...imported, output };
}
