import { Preparation } from '../core/preparation.ts';
import { preparationInputs, type PreparationOperation } from '../core/preparation-model.ts';
import { IntentService, intentInputs } from '../runner/intent.ts';
import { Observability, observabilityInputs } from './observability.ts';
import { ProjectMemory, memoryInputs } from './memory.ts';
import { SignalInbox, signalInput } from '../core/signals.ts';
import { LeadWorkflow, workflowInput } from '../core/lead-workflow.ts';
import { workflowMetrics } from './metrics.ts';
import {
  requirementSnapshot,
  requirementReport,
  correctRequirements,
} from '../runner/requirements.ts';
import { repository } from '../core/repositories.ts';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { AgentContext, contextInputs, type ContextOperation } from './context.ts';
import { DevContour, specDigest } from '../core/service.ts';
import { taskInput, DomainError } from '../core/model.ts';
import { planResult } from '../core/plan.ts';
import { Workspace, changeSetInput } from '../core/workspace.ts';
import { attachJournal } from '../runner/journal.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const agentInputs = {
  ...preparationInputs,
  ...intentInputs,
  ...memoryInputs,
  ...observabilityInputs,
  signal_ingest: signalInput,
  signal_status: z.strictObject({ repositoryId: id }),
  workflow_start: workflowInput,
  workflow_status: z.strictObject({ repositoryId: id.optional() }),
  workflow_retry: z.strictObject({
    repositoryId: id.optional(),
    key: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  workflow_metrics: z.strictObject({ repositoryId: id.optional() }),
  requirements_snapshot: z.strictObject({ repositoryId: id, source: z.string().min(1).max(500) }),
  requirements_report: z.strictObject({ repositoryId: id }),
  requirements_correct: z.strictObject({ boardId: id, reason: z.string().min(10).max(5000) }),
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
  preparation_status:
    'Read product and architecture stages, exact revisions, operator feedback and linked development. Available before project setup.',
  preparation_create:
    'Create a product change. Product and architecture require explicit operator decisions in the web panel before development.',
  preparation_activate:
    'Select the change for subsequent development tasks. Does not approve any stage.',
  preparation_product:
    'Save a new immutable product draft with optimistic concurrency. Never approves it; a revision invalidates the prior architecture for new work.',
  preparation_architecture:
    'Save architecture, justified stack and structured C1/C2 only after operator product approval. Does not approve development.',
  preparation_submit:
    'Validate the current draft and send it to the operator for approval. Unresolved questions or incomplete C1/C2 block submission.',

  intent_render:
    'Render component intent from committed REQ sources, or a workspace product/application/feature map with pinned local story references. Returns Markdown only; does not write, approve or commit it.',
  intent_snapshot:
    'Read the committed intent source returned for the selected owner (docs/implementation-intent.md in embedded mode, otherwise INTENT.md) and exact story REQ bindings. Add a configured test gate/scenario, and bind the detailed requirements too.',
  intent_report:
    'Audit all release stories and REQ sources. Product maps add application/feature progress and current bound ChangeSet acceptance. Read-only; never accepts a release or copies local task text.',
  product_view:
    'Read the committed product/application/component map and computed feature progress for a release. Includes explicit deferred/not-applicable scope and joint verification. No writes or model calls.',
  usage_report:
    'Read paginated owner-local invocation costs, versions and telemetry coverage; never evidence.',
  decision_report:
    'Read recorded dispatch inputs and observed outcomes. Other component tasks appear only as dependency IDs.',
  strategy_replay:
    'Audit a fixed strategy against prefix-only dispatch inputs. Unobserved alternatives stay unsupported; no policy is installed.',
  memory_retain:
    'Save an immutable, source-pinned statement in its Git owner. References are local. This is context, never approval or evidence.',
  memory_recall:
    'Retrieve owner-local knowledge within a byte budget, excluding stale/conflicting statements and hypotheses by default. No model calls.',
  signal_ingest:
    'Record a normalized external observation in its component, deduplicate it and propose draft work or a correction. A resolved signal never supplies test evidence or accepts work.',
  signal_status:
    'Read external signal receipts in one component. No remote requests or model calls.',
  workflow_start:
    'Enqueue idempotent board review, execution and acceptance or ChangeSet verification. A running server may invoke models. Operator policy remains enforced.',
  workflow_status:
    'Read owner-local durable stage jobs. No model calls or execution leases are granted.',
  workflow_retry:
    'Retry a diagnosed failed stage within its original attempt budget. Never retries failed task implementations automatically.',
  workflow_metrics:
    'Read per-owner execution measurements, incomplete attempts and unknown cost. No model calls.',
  requirements_snapshot:
    'Read REQ sections from committed repository HEAD. Bind returned digest/text to a task and a configured test gate.',
  requirements_report:
    'Compare current requirement sections with task evidence. Historical done is unchanged; stale requirements are not current coverage.',
  requirements_correct:
    'Create draft replacements for changed requirements on an accepted board. Preserve history and require new plan review.',
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
    'Declare a shared change across boards. Set releaseId to bind product release acceptance to the workspace INTENT map and mandatory joint tests. Verification and acceptance remain separate operations.',
  queue_set:
    'Pause or resume issuance of tasks. Resuming may invoke configured models in a running server; this does not launch a server or cancel active runs.',
};
export const readOnly = (name: AgentOperation) =>
  [
    'preparation_status',
    'intent_render',
    'intent_snapshot',
    'intent_report',
    'product_view',
    'usage_report',
    'decision_report',
    'strategy_replay',
    'memory_recall',
    'project_context',
    'project_overview',
    'task_briefing',
    'checkpoint_changes',
    'requirements_snapshot',
    'requirements_report',
    'workflow_metrics',
    'workflow_status',
    'signal_status',
  ].includes(name);
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
  constructor(readonly h: DevContour) {}
  execute(raw: unknown): Record<string, unknown> {
    const result = this.dispatch(raw);
    if (Buffer.byteLength(JSON.stringify(result)) > 65536)
      throw new DomainError('Ответ превышает 64 KiB; сузьте запрос или используйте CLI-отчёт', 413);
    return result;
  }
  private workflowView(job: ReturnType<LeadWorkflow['start']>) {
    const { token: _token, ...publicJob } = job;
    return publicJob;
  }
  private dispatch(raw: unknown): Record<string, unknown> {
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
    if (operation in preparationInputs)
      return new Preparation(h.store).execute(operation as PreparationOperation, input);
    if (!readOnly(operation) && !h.store.onCommit) attachJournal(h);
    switch (operation) {
      case 'intent_render':
        return new IntentService(h).render(input);
      case 'intent_snapshot':
        return new IntentService(h).snapshot(input);
      case 'intent_report':
        return new IntentService(h).report(input);
      case 'product_view':
        return new IntentService(h).productView(input);
      case 'usage_report':
        return new Observability(h).usage(input);
      case 'decision_report':
        return new Observability(h).decisions(input);
      case 'strategy_replay':
        return new Observability(h).replay(input);
      case 'memory_retain':
        return new ProjectMemory(h).retain(input);
      case 'memory_recall':
        return new ProjectMemory(h).recall(input);
      case 'signal_ingest':
        return new SignalInbox(h).ingest(input);
      case 'signal_status':
        return {
          events: new SignalInbox(h).list(agentInputs.signal_status.parse(input).repositoryId),
        };
      case 'workflow_start':
        return this.workflowView(new LeadWorkflow(h).start(input));
      case 'workflow_status':
        return {
          jobs: new LeadWorkflow(h)
            .list(agentInputs.workflow_status.parse(input).repositoryId)
            .map((j) => this.workflowView(j)),
          operatorBlocked: h.config.approvalMode === 'operator',
        };
      case 'workflow_retry': {
        const v = agentInputs.workflow_retry.parse(input);
        return this.workflowView(new LeadWorkflow(h).retry(v.key, v.repositoryId));
      }
      case 'workflow_metrics':
        return workflowMetrics(h, agentInputs.workflow_metrics.parse(input).repositoryId);
      case 'requirements_snapshot': {
        const v = agentInputs.requirements_snapshot.parse(input);
        return requirementSnapshot(repository(h.config, v.repositoryId).path, v.source);
      }
      case 'requirements_report':
        return requirementReport(h, agentInputs.requirements_report.parse(input).repositoryId);
      case 'requirements_correct': {
        const v = agentInputs.requirements_correct.parse(input);
        return correctRequirements(h, v.boardId, v.reason);
      }
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
