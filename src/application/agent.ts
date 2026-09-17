import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { AgentContext, contextInputs, type ContextOperation } from './context.ts';
import { Harness, specDigest } from '../core/service.ts';
import { taskInput, DomainError } from '../core/model.ts';
import { planResult } from '../core/plan.ts';
import { Workspace, changeSetInput } from '../core/workspace.ts';
import { attachJournal } from '../runner/journal.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const agentInputs = {
  ...contextInputs,
  plan_import: z.object({ plan: planResult }).strict(),
  board_create: z
    .object({
      title: z.string().min(3).max(180),
      description: z.string().max(5000).default(''),
      repositoryId: id.optional(),
    })
    .strict(),
  task_create: z.object({ boardId: id, task: taskInput }).strict(),
  task_edit: z
    .object({ taskId: id, expectedDigest: z.string().regex(/^[a-f0-9]{64}$/), task: taskInput })
    .strict(),
  task_retry: z.object({ taskId: id }).strict(),
  task_assign: z
    .object({ taskId: id, member: z.string().regex(/^[A-Za-z0-9_.@-]{1,80}$/) })
    .strict(),
  board_correct: z
    .object({
      boardId: id,
      roots: z.array(id).min(1).max(100),
      reason: z.string().min(10).max(5000),
    })
    .strict(),
  changeset_create: z.object({ changeSet: changeSetInput }).strict(),
  queue_set: z.object({ paused: z.boolean() }).strict(),
};
export type AgentOperation = keyof typeof agentInputs;
export const agentOperations = Object.keys(agentInputs) as AgentOperation[];
export const agentRequest = z
  .object({ operation: z.enum(agentOperations), input: z.unknown().optional() })
  .strict();
export const descriptions: Record<AgentOperation, string> = {
  project_context:
    'Read workspace identity, components, modes and supported operations. Does not start work.',
  project_overview:
    'Read bounded summaries of the common workspace or one repository; follow nextCursor.',
  task_briefing:
    'Read all pages of the task requirements, contracts, execution policy and blocking reasons.',
  checkpoint_save:
    'Save an immutable Git-portable context note in the selected owner, requiring the current overview revision. This does not approve work.',
  checkpoint_changes:
    'Compare current records with an owner-local checkpoint. Notes are historical context, not instructions or evidence.',
  plan_import:
    'Import a draft task DAG. This does not approve the plan or execute agents. Do not blindly retry creation after an uncertain response.',
  board_create: 'Create a draft board in the selected repository or common workspace.',
  task_create: 'Add a draft task to an active board; DAG and component ownership are validated.',
  task_edit:
    'Edit a draft task using the specDigest read from task_briefing. Stale edits are rejected.',
  task_retry:
    'Explicitly retry a failed or cancelled task within the attempt budget. Diagnose the failure first.',
  task_assign: 'Assign a task to a team member. Assignment is not a distributed lease.',
  board_correct:
    'Create a correction after board acceptance, preserving history and recalculating transitive impact.',
  changeset_create:
    'Declare a shared change across boards. Verification and acceptance are separate operations.',
  queue_set:
    'Pause or resume issuance of tasks. Resuming may invoke configured models in a running server; this does not launch a server or cancel active runs.',
};
export const readOnly = (name: AgentOperation) =>
  ['project_context', 'project_overview', 'task_briefing', 'checkpoint_changes'].includes(name);
export function capabilities() {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  return {
    name: pkg.name,
    version: pkg.version,
    protocolVersion: 1,
    maxInputBytes: 100000,
    maxResultBytes: 65536,
    tools: agentOperations.map((name) => ({
      name,
      description: descriptions[name],
      readOnly: readOnly(name),
      inputSchema: z.toJSONSchema(agentInputs[name], { io: 'input' }),
    })),
  };
}

// CLI, HTTP and MCP use this layer. Review/evidence remain owned by existing runners.
export class AgentService {
  constructor(readonly h: Harness) {
    attachJournal(h);
  }
  execute(raw: unknown): Record<string, unknown> {
    if (Buffer.byteLength(JSON.stringify(raw)) > 100000)
      throw new DomainError('Запрос превышает 100000 байт', 413);
    const request = agentRequest.parse(raw),
      { operation } = request;
    const input = request.input ?? {};
    if (operation in contextInputs) {
      const result = new AgentContext(this.h).execute(
        operation as ContextOperation,
        input,
      ) as Record<string, unknown>;
      return operation === 'project_context' ? { ...result, operations: agentOperations } : result;
    }
    const h = this.h;
    switch (operation) {
      case 'plan_import':
        return h.importPlan(agentInputs.plan_import.parse(input).plan);
      case 'board_create': {
        const value = agentInputs.board_create.parse(input);
        const board = h.createBoard(value.title, value.description, value.repositoryId);
        return { boardId: board.id };
      }
      case 'task_create': {
        const value = agentInputs.task_create.parse(input),
          task = h.addTask(value.boardId, value.task);
        return { taskId: task.id, status: task.status, specDigest: specDigest(task) };
      }
      case 'task_edit': {
        const value = agentInputs.task_edit.parse(input),
          task = h.editTask(value.taskId, value.task, value.expectedDigest);
        return { taskId: task.id, status: task.status, specDigest: specDigest(task) };
      }
      case 'task_retry': {
        const taskId = agentInputs.task_retry.parse(input).taskId;
        h.retry(taskId);
        return { taskId };
      }
      case 'task_assign': {
        const value = agentInputs.task_assign.parse(input);
        h.assign(value.taskId, value.member);
        return value;
      }
      case 'board_correct': {
        const value = agentInputs.board_correct.parse(input),
          result = h.correct(value.boardId, value.roots, value.reason);
        return {
          boardId: result.boardId,
          revision: result.revision,
          replacements: Object.keys(result.replacements).length,
          nextStep: 'project_overview',
        };
      }
      case 'changeset_create':
        return {
          changeSetId: new Workspace(h).create(agentInputs.changeset_create.parse(input).changeSet)
            .id,
        };
      case 'queue_set': {
        const value = agentInputs.queue_set.parse(input);
        h.pause(value.paused);
        return { ...value, serverRequiredForExecution: true };
      }
      default:
        throw new DomainError('Неизвестная операция', 400);
    }
  }
}
