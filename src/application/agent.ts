import { Preparation } from '../core/preparation.ts';
import { preparationInputs, type PreparationOperation } from '../core/preparation-model.ts';
import {
  IntentService,
  intentInputs,
  storyBindingInput,
  storyGapMessage,
} from '../runner/intent.ts';
import { Observability, observabilityInputs } from './observability.ts';
import { ProjectMemory, memoryInputs } from './memory.ts';
import { DiscussionService, boundedWrite } from './discussion.ts';
import { discussionInputs } from '../core/discussion-model.ts';
import { SignalInbox, signalInput } from '../core/signals.ts';
import { LeadWorkflow, workflowInput } from '../core/lead-workflow.ts';
import { workflowMetrics } from './metrics.ts';
import { agentValueReport, valueReportInput } from './value-report.ts';
import { agentHandoff, handoffInput } from './handoff.ts';
import {
  requirementSnapshot,
  requirementReport,
  correctRequirements,
} from '../runner/requirements.ts';
import { repositories, repository } from '../core/repositories.ts';
import { z, ZodError } from 'zod';
import { readFileSync } from 'node:fs';
import { AgentContext, contextInputs, type ContextOperation } from './context.ts';
import { DevContour, SERVER_STOPPING, scopeGapWarning, specDigest } from '../core/service.ts';
import { taskIngest, DomainError, type Task } from '../core/model.ts';
import { planIngest } from '../core/plan.ts';
import { Workspace, changeSetInput } from '../core/workspace.ts';
import { servingPreview } from '../core/preview.ts';
import { attachJournal } from '../runner/journal.ts';
import { caseInput, runSpike, spikeInput, spikesOf, submitCase } from '../runner/checks.ts';
import { checksQuery, taskChecks } from './checks.ts';
import { CheckCorpus } from '../core/check-store.ts';
import { checkJsonBytes, operationCatalog, recoveryActions } from 'devcontour-harness';
import { applyCases } from '../runner/recovery.ts';
import { ContractChanges } from '../runner/contract-change.ts';
import { contractProposal, limitsMessage, proposalLimitIssues } from '../runner/agent-control.ts';
import { queueStopOf, quietAttempts, quietOperations } from './queue-stop.ts';
import { InputService, inputOperationInputs } from './input.ts';
import { AttentionService } from './attention.ts';
import { attentionInputs } from '../core/attention-model.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export { SERVER_STOPPING };
export const agentInputs = {
  ...preparationInputs,
  ...intentInputs,
  ...memoryInputs,
  ...discussionInputs,
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
  value_report: valueReportInput,
  session_handoff: handoffInput,
  requirements_snapshot: z.strictObject({ repositoryId: id, source: z.string().min(1).max(500) }),
  requirements_report: z.strictObject({ repositoryId: id }),
  requirements_correct: z.strictObject({ boardId: id, reason: z.string().min(10).max(5000) }),
  ...contextInputs,
  plan_import: z.object({ plan: planIngest, boardId: id.optional() }).strict(),
  board_create: z
    .object({
      title: z.string().min(3).max(180),
      description: z.string().max(5000).default(''),
      repositoryId: id.optional(),
    })
    .strict(),
  task_create: z.object({ boardId: id, task: taskIngest }).strict(),
  task_edit: z
    .object({ taskId: id, expectedDigest: z.string().regex(/^[a-f0-9]{64}$/), task: taskIngest })
    .strict(),
  task_retry: z.object({ taskId: id }).strict(),
  task_assign: z
    .object({ taskId: id, member: z.string().regex(/^[A-Za-z0-9_.@-]{1,80}$/) })
    .strict(),
  task_story: storyBindingInput,
  board_correct: z
    .object({
      boardId: id,
      roots: z.array(id).min(1).max(100),
      reason: z.string().min(10).max(5000),
    })
    .strict(),
  changeset_create: z.object({ changeSet: changeSetInput }).strict(),
  queue_set: z.object({ paused: z.boolean() }).strict(),
  preview_status: z.strictObject({}),
  feasibility_spike: spikeInput,
  feasibility_spikes: z.strictObject({ repositoryId: id.optional() }),
  checks_view: checksQuery,
  checks_case_submit: caseInput,
  checks_adopt: z.strictObject({
    suiteId: id,
    version: z.number().int().min(1).optional(),
    /** Однозначная ссылка на версию; номер после объединения клонов может совпасть. */
    digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    tasks: z.array(id).min(1).max(30),
    reason: z.string().trim().min(10).max(2000),
  }),
  recovery_decide: z.strictObject({
    taskId: id,
    recoveryId: id,
    expectedVersion: z.number().int().min(1),
    action: z.enum(recoveryActions),
    reason: z.string().trim().min(10).max(4000),
    evidence: z.array(z.string().max(2000)).max(20).default([]),
    hypothesis: z.string().max(4000).optional(),
    plan: z.string().max(4000).optional(),
    cases: z
      .array(
        z.strictObject({
          input: z
            .string()
            .min(1)
            .max(64 * 1024),
          expected: z
            .string()
            .max(64 * 1024)
            .nullable()
            .optional(),
        }),
      )
      .max(10)
      .optional(),
    proposal: z.string().max(8000).optional(),
    conflict: z.string().max(4000).optional(),
  }),
  contract_change_status: z.strictObject({ id: z.string().regex(/^CC-[A-Za-z0-9-]{1,80}$/) }),
  contract_change_revise: z.strictObject({
    id: z.string().regex(/^CC-[A-Za-z0-9-]{1,80}$/),
    expectedVersion: z.number().int().min(0),
    include: z.array(id).max(30).optional(),
    /**
     * Исправленное предложение того же контракта (как файл `--file` CLI):
     * текст, artifacts, checks, underTest. Проходит предпроверки старта до
     * вызова модели; без него пересмотр берёт прежнее предложение.
     */
    proposal: contractProposal.optional(),
  }),
  ...inputOperationInputs,
  attention_list: attentionInputs.agent,
};
/**
 * Операции, которые запускают внешние процессы: эксперимент, подтверждение
 * примера эталоном, пересмотр операции изменения контракта. Транспорты
 * вызывают их через `run`; синхронный `execute` их не выполняет.
 */
export const asyncOperations = new Set<string>([
  'feasibility_spike',
  'checks_case_submit',
  'recovery_decide',
  'contract_change_revise',
  'input_context',
  'input_review',
]);
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
  preparation_quick:
    'Start a quick change to one existing npm or pnpm repository from a short instruction and one observable result. The same requestKey returns the change it created; another payload under it is refused. Product and architecture stay operator-approved revisions (compact ones are fine); nothing is approved by this call.',
  preparation_setup:
    'Propose what setup will apply to a quick change: a profile (npm-project or pnpm-project for an existing repository) and, when the repository has its own check commands, the gates that run them (a test gate needs a JUnit report). The panel shows the files setup would create, keep or refuse before anything is written; setup --change applies exactly the latest proposal.',
  preparation_expand:
    'Move a quick change to the full route when it needs several components or dependent tasks. Keeps the instruction, criterion and all revisions; explain why.',
  preparation_product:
    'Save a new immutable product draft with optimistic concurrency: personas with goals and pains, releases as the scope boundary, and features whose scenarios name a persona and whose acceptance criteria name a release. Resolve ambiguity the way the relevant persona would. Never approves it; a revision invalidates the prior architecture for new work.',
  preparation_architecture:
    'Save architecture, justified stack and structured C1/C2 only after operator product approval. Does not approve development.',
  preparation_references:
    'Save the first design step: candidate references with the property taken from each and an optional screenshot stored beside them. The operator accepts or rejects each one. A change that touches no interface sets applicable=false with a reason, which ends the design track.',
  preparation_concept:
    'Save the second design step after the operator approved the references: the concept and the rendered sketches they choose between. Sketches are files or links, one of them marked accepted.',
  preparation_design:
    'Save the third design step after the operator approved the concept: the palette, semantic tokens, guidelines, what is shared and what differs per channel, and the handoff package. Screen layouts stay per-feature UI contracts inside development.',
  preparation_submit:
    'Validate the current draft and send it to the operator for approval. Unresolved questions or incomplete C1/C2 block submission.',
  preparation_progress:
    'Append a short note about the work in progress so the panel shows the session is active before any revision exists. Context only; never approves or reports evidence.',
  preparation_question:
    'Record open product or architecture questions for the operator, or withdraw ones that no longer apply. The operator answers them in the panel; an answered question cannot be withdrawn.',
  preparation_resolve:
    'Record a decision with its rationale in the durable journal, optionally closing an answered question, or withdraw decisions that no longer hold. Does not approve a stage.',

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
    'Read owner-local durable stage jobs, the queue stop and running attempts and checks without movement (liveness and operations: quiet or stalled, idle time, activity, next step). No model calls or execution leases are granted.',
  workflow_retry:
    'Retry a diagnosed failed stage within its original attempt budget. Never retries failed task implementations automatically.',
  workflow_metrics:
    'Read per-owner execution measurements, incomplete attempts and unknown cost. No model calls.',
  value_report:
    'Read the effect report: accepted tasks, first try, sent back by checks/review, approval-to-merge time, known spend per accepted task, environment failures and recorded interventions. Omit repositoryId for the whole workspace. Bounds are explicit: "lower" means at least, a range means unknown inputs, null/unknown is never zero; under 20 no percentages, under 5 no medians. JSON only; summary detail omits per-task rows and evidence links (the CLI report has them). Read-only, no model calls.',
  session_handoff:
    'Read the context handoff pack for a new lead session; start every new lead session with it instead of recalling the previous one. One store snapshot: task counts and limits, queue pause and who lifts it, controller, running and unfinished attempts, open tasks with their next step, stops and decisions awaiting the lead or user, recent failures, budgets and the next step of the board. Board lead workflow jobs count as the graph jobs: their repairs and planned retries are in the pack. next.command names harness CLI commands, never run them; host.next is the DevContour step decided from state by the rules of the lead job loop (also when the running server holds the controller role), with host.next.loop saying what the loop does next: wait for a live job (including one that lifts the queue pause), decide when the loop would stop the job (repair budget or failure class: fix or retry the task by hand first) or the attempts of the job are spent, workflow_retry {key, repositoryId} for a failed job a retry would move on, workflow_start for a board with an approved plan and no job for its current input, decide with decision plan for a board whose plan is not approved (draft tasks: choose the scope, e.g. review-plan --tasks, never workflow_start for the whole plan), fix-input when workflow_start would be refused, queue_set for an operator pause no job lifts, operator in approvalMode operator. When pack.next is a lead or user decision outside the queue, host.next invents no queue step (workflow_start, queue_set), only steps of that board: wait for its live job when the job loop acts next (a loop that only waits for tasks does not hide the decision), workflow_retry of its failed job, or a job or plan decision. repairs lists live jobs first, then jobs for the current input, then newest first. Omit boardId for the whole workspace. intentions are your own notes, the only text not from the store: trimmed, empty ones dropped, at most 20 non-empty, longer than 1000 chars clipped and counted in truncated. format md returns the same pack as Markdown. Over the response limit, entries are dropped in the pack order and counted in truncated (bySize), and full names the CLI that prints the whole pack. Not the ChangeSet delivery handoff (devcontour handoff --changeset). Read-only, no model calls.',
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
    "Import a draft task DAG. Without boardId it opens a new board; with boardId of an accepted board it opens the next stage as that board's next revision, so one release stays on one board. This does not approve the plan or execute agents. Do not blindly retry creation after an uncertain response.",
  board_create: 'Create a draft board in the selected repository or common workspace.',
  task_create: 'Add a draft task to an active board; DAG and component ownership are validated.',
  task_edit:
    'Edit a draft task using the specDigest read from task_briefing. Stale edits are rejected.',
  task_retry:
    'Explicitly retry a failed or cancelled task within the attempt budget. Diagnose the failure first.',
  task_assign: 'Assign a task to a team member. Assignment is not a distributed lease.',
  task_story:
    "Bind done tasks to an INTENT story without changing their approved spec, when they link the story's detailed REQs but not REQ-intent-<story>. Every detailed REQ of each task must be in that story's criteria; the story digest is pinned from committed HEAD and a reason is journaled. intent_report marks these tasks boundAfterAcceptance: the story text was not in the author's prompt. Drafts get the REQ-intent link in requirements instead.",
  board_correct:
    'Create a correction after board acceptance, preserving history and recalculating transitive impact.',
  changeset_create:
    'Declare a shared change across boards. Set releaseId to bind product release acceptance to the workspace INTENT map and mandatory joint tests. Verification and acceptance remain separate operations.',
  queue_set:
    'Pause or resume issuance of tasks. Resuming may invoke configured models in a running server; this does not launch a server or cancel active runs.',
  feasibility_spike:
    'Run a bounded feasibility experiment before implementation: the given argv of an oracle or prototype at a pinned commit, per input size (DEVCONTOUR_SPIKE_SIZE) and seed, under a time limit. Stores commands, versions, times, outcome and limits of inference. A timeout is inconclusive for that method and budget; it never proves hardness or permits weakening a requirement.',
  feasibility_spikes:
    'Read stored feasibility experiments of a component with their outcome, versions and limits of inference. No commands run.',
  checks_view:
    'Read the check contract of a task: effective check version, declared properties and actual coverage of the last gates, confirmed/proposed/disputed corpus cases (paginated with cursor), failure history by property, the recovery episode, remaining budgets and the next step with who must act. Read-only; starts nothing.',
  checks_case_submit:
    'Submit a concrete input for a declared property. The controller runs the pinned oracle and the implementation on the defective commit twice; only a reproducible discrepancy becomes an immutable corpus version adopted by the listed unfinished tasks (waiting for an active run). Wrong expectations are refuted, timeouts inconclusive; nothing in the input or a reproduction command is executed. Idempotent by key. Removal, replaced expectations, tolerance, checker or command changes are refused: use contract-change.',
  checks_adopt:
    'Adopt an existing corpus version by explicitly listed unfinished tasks of the same check contract. Waits for active runs and holds their issuance; accepted tasks are never changed.',
  recovery_decide:
    'Record the lead decision for a recovery episode (two failures on one property) with the expected record version: add confirmed cases under the pinned oracle, one retry with a new hypothesis, a proposal for normal review (strengthen checker, split task), a product conflict for the user, or an environment stop. Never resets attempts.',
  contract_change_status:
    'Read a contract-change operation: its step, holds, history, earlier redactions and the next step. Read-only.',
  contract_change_revise:
    'Revise a failed, stale or waiting contract change to the current committed redaction with the expected record version. An optional proposal replaces the stored one for the same contract (same file or inline title, repositoryId and component) — new text, artifacts, checks, underTest — after the start pre-checks (artifact pinning, import closure, check declaration) and before any model call. Before side effects the same operation is re-reviewed with its holds and history kept; after them a linked successor takes the holds over. Effects are never rolled back.',
  discussion_read:
    'Read a task discussion page in seq order: forward from cursor (the last seq returned; follow nextCursor), or backward with latest: true or before: <seq> (follow previousCursor). version is the thread version for writes. Notes, change requests and their dispositions are local history of the task owner: they never change the task, its approvals, queue or attempts, and Git sync does not carry them.',
  discussion_post:
    'Post a note or a change request to a task discussion as the lead. Needs idempotencyKey (a repeat returns the same message, another payload under it is refused) and expectedVersion (the thread version you read; a mismatch is 409 — re-read). Text: up to 16 KiB UTF-8, no control characters other than newline and tab; the reply carries an excerpt of long text. supersedes corrects your own latest version of a message. A change request does not alter an approved or accepted task: apply it through a new revision. kind answer answers a writer question: input {requestId, expectedVersion (the request version, which is the check instead of the thread version), optionId?, kind?}; the lead rule of input_answer applies, the answer text lives once in the request and the message links its revision; an answer to a question already cancelled or superseded is kept as discussion history (input.accepted false) and resumes nothing; an applied answer is not corrected (409).',
  discussion_resolve:
    'Record how a change request was handled: accepted (refs to the new board revision or tasks created for it), rejected with a reason, or needs-answer (the operator answers in the panel and the request returns to discussion_inbox). Only the latest version of a request is handled; accepted and rejected are final. expectedVersion is the thread version from discussion_inbox. Reading a request is not handling it.',
  discussion_inbox:
    'List change requests waiting for the lead across tasks, oldest event first: the latest version of each request without a disposition, or answered by the operator after needs-answer (reopened). Each entry is bounded: an excerpt, textBytes, truncated and the thread version for discussion_resolve; read the full text with discussion_read. Follow nextCursor.',
  input_list:
    'List writer questions (input requests) with state, severity, floors, version and who acts next: awaiting-answer, answer-saved, context-review, review-rejected (the reviewer rejected the answer), ready-to-apply, applied-awaiting-claim, delivered (only after the writer call with the answer started), stale, cancelled, superseded. No question or answer text. Read-only.',
  input_show:
    'Read one writer question: question, options, recommended option, severity and floors, draft files, the latest answer in full, earlier answers as digest and excerpt, review rounds, target and delivery. Read-only.',
  input_answer:
    'Answer a writer question with the expected request version. The lead may answer only a question without floors in approvalMode agent; otherwise the operator answers in the panel. A requirement-change answer is not continued: reopen and respecify the task, approve it, then input_supersede with the same task and carry the answer. Does not resume the task.',
  input_context:
    'Build the immutable context snapshot with the latest answer (the effective task snapshot plus input/<id>.md and its manifest) and store it by digest. The manifest lists the discussion messages that recorded the answers and the messageIds you select (id, seq, digest; their text is not added). Not activated; idempotent per digest.',
  input_review:
    'Review the answer snapshot with the plan reviewer (round subject input-<id>): approve only if the answer clarifies without changing the approved spec. Refused before the model call when the snapshot is missing or does not carry the latest answer. Approval does not activate anything.',
  input_target:
    'Propose the continuation target for a reviewed answer snapshot (or the carry target of a superseded question) and list why applying would be refused now. Read-only.',
  input_apply:
    'Apply the answer in one transaction with the exact request version, answer digest, snapshot and target digest: activates the snapshot for the task and requeues it. In approvalMode operator the operator applies in the panel. Busy graph attempts or exhausted limits return applied=false with the reason; the answer stays.',
  input_cancel:
    'Cancel a writer question with the expected version and a reason; also closes follow-ups (assumption accepted). A blocking question follows the answer rule: floored or approvalMode operator questions are cancelled by the operator.',
  input_supersede:
    'Supersede a writer question once the spec of its task has changed: reopen and respecify the task (draft or re-approved), then supersede with the same task and carry the answer (input_context, input_review, input_target, input_apply). Refused with 409 SPEC_UNCHANGED while the spec is unchanged; a blocking question the lead may not answer is superseded by the operator (403 OPERATOR_ANSWERS). The old task is not resumed by a requirement change without carry. A non-blocking follow-up may also be superseded by a newer task of the same board, for example the replacement created by board_correct.',
  attention_list:
    'List the attention center: one ordered list of current items that need someone to act, from the same source rules as the panel (preparation questions and stage reviews, writer questions, stopped tasks, lead job decisions, discussion requests, pauses, waits, budgets, contract changes, ChangeSet acceptance, preview problems, stalls). Default actor lead; each item has sourceKey, occurrenceId, sourceVersion, category, actor, reason, impact (covered tasks and the tasks waiting on them), subject and since. A cascade is one root item. Reading is not handling: act through the source operation (preparation_*, discussion_*, input_*, task_retry, workflow_*). Read-only; operator read marks are not included. Available before setup.',
  preview_status:
    'Read the local preview: which verified release serves the URL, its states (built, deployed, healthy, confirmed or unconfirmed), and past deployments with their errors. Deploying and rolling back are separate controlled actions through the CLI or panel.',
};
export const readOnly = (name: AgentOperation) =>
  [
    'preview_status',
    'preparation_status',
    'discussion_read',
    'discussion_inbox',
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
    'value_report',
    'session_handoff',
    'workflow_status',
    'signal_status',
    'feasibility_spikes',
    'checks_view',
    'contract_change_status',
    'input_list',
    'input_show',
    'input_target',
    'attention_list',
  ].includes(name);
/**
 * Каталог операций DevContour — общий построитель harness (`operationCatalog`)
 * над каталогом хоста: имена, описания, readOnly и схемы входа в прежнем
 * порядке, protocolVersion 1 и прежние пределы. Общие операции harness в
 * каталог DevContour не входят — это разные каталоги.
 */
export function capabilities() {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    name: string;
    version: string;
  };
  return operationCatalog({
    name: pkg.name,
    version: pkg.version,
    protocolVersion: 1,
    maxInputBytes: 100000,
    maxResultBytes: 65536,
    operations: Object.fromEntries(
      agentOperations.map((name) => [
        name,
        { description: descriptions[name], readOnly: readOnly(name), input: agentInputs[name] },
      ]),
    ),
  });
}

// CLI, HTTP and MCP use this layer. Review/evidence remain owned by existing runners.
/** Путь поля так, как его пишет автор запроса: `plan.tasks[0].dependsOn`. */
const fieldPath = (path: readonly PropertyKey[]) =>
  path.map((p, i) => (typeof p === 'number' ? `[${p}]` : (i ? '.' : '') + String(p))).join('') ||
  'input';
/** Отказ схемы входа запроса — по названным полям, со статусом 400. */
function inputRefusal(error: ZodError, operation: unknown) {
  const shown = error.issues.slice(0, 10).map((i) => `${fieldPath(i.path)}: ${i.message}`);
  const rest = error.issues.length - shown.length;
  // Имя операции приходит от автора запроса: в сообщение — не длиннее 80 символов.
  const name = typeof operation === 'string' ? ' ' + operation.slice(0, 80) : '';
  return new DomainError(
    `Запрос${name} не принят: ` + shown.join('; ') + (rest > 0 ? `; и ещё ${rest}` : ''),
    400,
  );
}
type ParsedAgentRequest = z.infer<typeof agentRequest>;
/**
 * Разбор запроса: размер и имя операции. Отказ схемы — по названным полям, а
 * не сырым массивом zod: CLI (`agent --file`), HTTP и MCP показывали JSON с
 * `code` и `path`, и автор запроса искал поле сам.
 */
export function parseAgentRequest(raw: unknown): ParsedAgentRequest {
  if (!checkJsonBytes(raw, 100000).within)
    throw new DomainError('Запрос превышает 100000 байт', 413);
  const request = agentRequest.safeParse(raw);
  if (!request.success)
    throw inputRefusal(request.error, (raw as { operation?: unknown } | null)?.operation);
  return request.data;
}
/**
 * Вход операции по её схеме — после проверок, которые объясняют, как
 * вызывать операцию (409). Так переводится только разбор самого запроса:
 * сбой разбора сохранённых данных или конфигурации при исполнении остаётся
 * внутренней ошибкой.
 */
function checkAgentInput({ operation, input = {} }: ParsedAgentRequest) {
  // Пределы предложения — тем же понятным отказом, что у CLI, до схемы.
  if (operation === 'contract_change_revise') {
    const issues = proposalLimitIssues((input as { proposal?: unknown } | null)?.proposal);
    if (issues.length) throw new DomainError(limitsMessage(issues), 400);
  }
  const parsed = (agentInputs[operation] as z.ZodType).safeParse(input);
  if (!parsed.success) throw inputRefusal(parsed.error, operation);
}
export class AgentService {
  constructor(
    readonly h: DevContour,
    /** Каталог данных контура: в нём асинхронные операции создают рабочие деревья. */
    readonly root?: string,
    readonly options: {
      /**
       * Процесс сервера останавливается: снятие паузы через `queue_set`
       * отклоняется, иначе оно сняло бы паузу остановки и такт выдал бы
       * попытку, которую уже некому довести. Есть только у агента внутри
       * процесса `serve` (`/api/agent`).
       */
      stopping?: () => boolean;
    } = {},
  ) {}
  execute(raw: unknown): Record<string, unknown> {
    return this.bounded(this.dispatch(parseAgentRequest(raw)));
  }
  private bounded(result: Record<string, unknown>) {
    if (!checkJsonBytes(result, 65536).within)
      throw new DomainError('Ответ превышает 64 KiB; сузьте запрос или используйте CLI-отчёт', 413);
    return result;
  }
  /** Общий вход транспортов: синхронные операции и операции с внешними процессами. */
  async run(raw: unknown): Promise<Record<string, unknown>> {
    const request = parseAgentRequest(raw);
    if (!asyncOperations.has(request.operation)) return this.bounded(this.dispatch(request));
    if (!this.root)
      throw new DomainError('Операция запускает процессы и требует каталога данных контура', 409);
    checkAgentInput(request);
    if (this.h.store.projectionKind !== 'full') attachJournal(this.h);
    const input = request.input ?? {};
    switch (request.operation) {
      case 'feasibility_spike':
        return this.bounded({ spike: await runSpike(this.h, this.root, input) });
      case 'checks_case_submit':
        return this.bounded(await submitCase(this.h, this.root, input));
      case 'recovery_decide': {
        const v = agentInputs.recovery_decide.parse(input);
        const decided = this.h.recoveryDecide(
          v.taskId,
          v.recoveryId,
          {
            action: v.action,
            reason: v.reason,
            evidence: v.evidence,
            ...(v.hypothesis ? { hypothesis: v.hypothesis } : {}),
            ...(v.plan ? { plan: v.plan } : {}),
            ...(v.cases
              ? { cases: v.cases.map((c) => ({ input: c.input, expected: c.expected ?? null })) }
              : {}),
            ...(v.proposal ? { proposal: v.proposal } : {}),
            ...(v.conflict ? { conflict: v.conflict } : {}),
            source: { kind: 'operator' },
            decidedAt: new Date().toISOString(),
          },
          v.expectedVersion,
        );
        if (decided.status === 'applying') {
          const task = this.h.store.read().tasks.find((t) => t.id === v.taskId)!;
          this.h.recoveryApplied(v.taskId, v.recoveryId, await applyCases(this.h, this.root, task));
        }
        const task = this.h.store.read().tasks.find((t) => t.id === v.taskId)!;
        return this.bounded({
          taskId: v.taskId,
          recovery: task.recovery
            ? {
                id: task.recovery.id,
                status: task.recovery.status,
                reason: task.recovery.reason ?? null,
                version: task.recovery.version,
              }
            : null,
          nextStep:
            task.recovery?.status === 'retry'
              ? 'A running server retries the task within its attempt budget (workflow_retry if the board workflow stopped).'
              : 'checks_view',
        });
      }
      case 'contract_change_revise': {
        // Пределы предложения — тем же понятным отказом, что у CLI, а не
        // массивом схемы.
        const issues = proposalLimitIssues((input as { proposal?: unknown } | null)?.proposal);
        if (issues.length) throw new DomainError(limitsMessage(issues), 400);
        const v = agentInputs.contract_change_revise.parse(input);
        return this.bounded(
          await new ContractChanges(this.h, this.root).revise(
            v.id,
            v.expectedVersion,
            v.include,
            v.proposal,
          ),
        );
      }
      case 'input_context':
        return this.bounded(await new InputService(this.h, this.root).context(input));
      case 'input_review':
        return this.bounded(await new InputService(this.h, this.root).review(input));
      default:
        throw new DomainError('Неизвестная операция', 400);
    }
  }
  private workflowView(job: ReturnType<LeadWorkflow['start']>) {
    const { token: _token, ...publicJob } = job;
    return publicJob;
  }
  /**
   * Предупреждение, не отказ: черновики, которые утверждение отклонит из-за
   * отсутствующей связи с историей INTENT. Ведущий исправляет их до ревью
   * плана, не тратя вызов модели.
   */
  private storyWarning(boardId?: string, tasks?: Task[]) {
    const state = this.h.store.read();
    const revision = boardId && state.boards.find((b) => b.id === boardId)?.revisions.at(-1);
    const drafts =
      tasks ??
      (revision
        ? state.tasks.filter((t) => revision.taskIds.includes(t.id) && t.status === 'draft')
        : []);
    try {
      const storyGaps = new IntentService(this.h).storyGaps(drafts);
      return storyGaps.length ? { storyGaps, storyWarning: storyGapMessage(storyGaps) } : {};
    } catch (error) {
      // Нечитаемая карта — тоже предупреждение: утверждение её отклонит.
      return { storyWarning: error instanceof Error ? error.message : String(error) };
    }
  }
  private dispatch(request: ParsedAgentRequest): Record<string, unknown> {
    const { operation } = request;
    const input = request.input ?? {};
    if (asyncOperations.has(operation))
      throw new DomainError('Операция запускает процессы: вызовите её через run', 409);
    checkAgentInput(request);
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
    if (!readOnly(operation) && h.store.projectionKind !== 'full') attachJournal(h);
    switch (operation) {
      case 'intent_render':
        return new IntentService(h).render(input);
      case 'intent_snapshot':
        return new IntentService(h).snapshot(input);
      case 'intent_report':
        return new IntentService(h).report(input);
      case 'product_view':
        return new IntentService(h).productView(input);
      case 'discussion_read':
        // Ответ агентского API ограничен 64 KiB: страница — с запасом под конверт.
        return new DiscussionService(h).read(input, 60000);
      case 'discussion_post':
        return boundedWrite(new DiscussionService(h).post(input, 'lead'));
      case 'discussion_resolve':
        return boundedWrite(new DiscussionService(h).resolve(input));
      case 'discussion_inbox':
        return new DiscussionService(h).inbox(input, 60000);
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
      case 'workflow_start': {
        const workflow = new LeadWorkflow(h);
        const job = workflow.start(input);
        const gaps = workflow.scopeGaps(job.kind, job.id);
        return {
          ...this.workflowView(job),
          ...(gaps.length ? { coverageGaps: gaps, warning: scopeGapWarning(gaps) } : {}),
        };
      }
      case 'workflow_status': {
        const owner = agentInputs.workflow_status.parse(input).repositoryId;
        const state = h.store.read();
        const now = Date.now();
        return {
          jobs: (() => {
            const workflow = new LeadWorkflow(h);
            return workflow.list(owner).map((j) => {
              // Стадия ждёт только ответов на вопросы исполнителя: «ждёт ответа», не сбой.
              const waiting = ['queued', 'running'].includes(j.status)
                ? workflow.waitingOf(j, state)
                : undefined;
              return { ...this.workflowView(j), ...(waiting ? { waiting } : {}) };
            });
          })(),
          operatorBlocked: h.config.approvalMode === 'operator',
          // Стадии ждут выдачи: остановленная очередь и её причина — рядом.
          queue: queueStopOf(h, state),
          // Идущие попытки без движения: зависание замечают без запроса журнала.
          liveness: quietAttempts(state, now, owner),
          // Проверки вне попыток (совместная, базы, доски) без движения.
          operations: quietOperations(h, state, now, 'agent', owner),
        };
      }
      case 'workflow_retry': {
        const v = agentInputs.workflow_retry.parse(input);
        return this.workflowView(new LeadWorkflow(h).retry(v.key, v.repositoryId));
      }
      case 'workflow_metrics':
        return workflowMetrics(h, agentInputs.workflow_metrics.parse(input).repositoryId);
      case 'value_report':
        return agentValueReport(h, agentInputs.value_report.parse(input));
      case 'session_handoff':
        return agentHandoff(h, agentInputs.session_handoff.parse(input));
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
      case 'plan_import': {
        const value = agentInputs.plan_import.parse(input);
        const result = h.importPlan(value.plan, value.boardId);
        return { ...result, ...this.storyWarning(result.boardId) };
      }
      case 'board_create': {
        const value = agentInputs.board_create.parse(input);
        const board = h.createBoard(value.title, value.description, value.repositoryId);
        return { boardId: board.id };
      }
      case 'task_create': {
        const value = agentInputs.task_create.parse(input),
          task = h.addTask(value.boardId, value.task);
        return {
          taskId: task.id,
          status: task.status,
          specDigest: specDigest(task),
          ...this.storyWarning(undefined, [task]),
        };
      }
      case 'task_edit': {
        const value = agentInputs.task_edit.parse(input),
          task = h.editTask(value.taskId, value.task, value.expectedDigest);
        return { taskId: task.id, status: task.status, specDigest: specDigest(task) };
      }
      case 'task_retry': {
        const taskId = agentInputs.task_retry.parse(input).taskId;
        // Повтор ведущим агентом: не человек (`operator` отчёт относит к
        // действиям человека) и не правило восстановления — актёр не назван.
        h.retry(taskId, undefined, 'host');
        return { taskId };
      }
      case 'task_assign': {
        const value = agentInputs.task_assign.parse(input);
        h.assign(value.taskId, value.member);
        return value;
      }
      case 'task_story':
        // Привязка подтверждает историю принятой работой — решение того, кто
        // утверждает. В operator mode агент её не делает сам.
        if (h.config.approvalMode === 'operator')
          throw new DomainError(
            'В approvalMode operator привязку к истории выполняет оператор: devcontour task-story --story ID --tasks T1,T2 --reason ...',
            409,
          );
        return new IntentService(h).bindStory(input, 'agent');
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
      // Вопросы исполнителя: актёр — ведущий агент (транспорт), не вход операции.
      case 'attention_list':
        return new AttentionService(h.store, h, this.root ? { root: this.root } : {}).agentList(
          input,
        );
      case 'input_list':
        return new InputService(h, this.root).list(input);
      case 'input_show':
        return new InputService(h, this.root).show(input);
      case 'input_answer':
        return new InputService(h, this.root).answer(input, 'lead');
      case 'input_target':
        return new InputService(h, this.root).target(input);
      case 'input_apply':
        return new InputService(h, this.root).apply(input, 'lead');
      case 'input_cancel':
        return new InputService(h, this.root).cancel(input, 'lead');
      case 'input_supersede':
        return new InputService(h, this.root).supersede(input, 'lead');
      case 'preview_status': {
        const s = h.store.read();
        const serving = servingPreview(s);
        return {
          configured: !!h.config.preview,
          url: serving?.url,
          serving: serving?.release,
          previews: (s.previews ?? []).slice(-20).map(({ token: _token, ...p }) => p),
        };
      }
      case 'checks_view':
        return taskChecks(h, input);
      case 'checks_adopt': {
        const v = agentInputs.checks_adopt.parse(input);
        // В operator mode агент только запрашивает принятие: задачи
        // удерживаются, подтверждает человек (checks-approve в CLI или панели).
        const manual = h.config.approvalMode === 'operator';
        if (v.version === undefined && !v.digest)
          throw new DomainError(
            'Укажите digest версии корпуса (или номер, если он однозначен)',
            400,
          );
        const result = new CheckCorpus(h).request(
          v.suiteId,
          { number: v.version, digest: v.digest },
          v.tasks,
          'agent',
          v.reason,
          manual,
        );
        return {
          suiteId: v.suiteId,
          pendingId: result.pending.id,
          version: result.pending.version,
          digest: result.pending.digest,
          status: result.pending.status,
          results: result.pending.results,
          ...(manual
            ? {
                awaitingOperator: true,
                nextStep: `operator: devcontour checks-approve --suite ${v.suiteId} --pending ${result.pending.id}`,
              }
            : {}),
        };
      }
      case 'contract_change_status': {
        const v = agentInputs.contract_change_status.parse(input);
        const changes = new ContractChanges(h, this.root ?? '');
        return changes.view(changes.get(v.id));
      }
      case 'feasibility_spikes': {
        const v = agentInputs.feasibility_spikes.parse(input);
        return {
          spikes: spikesOf(
            h,
            v.repositoryId ??
              (repositories(h.config).find((r) => r.id === 'main') ?? repositories(h.config)[0]).id,
          )
            .sort((a, b) => b.at.localeCompare(a.at))
            .slice(0, 20),
        };
      }
      case 'queue_set': {
        const value = agentInputs.queue_set.parse(input);
        if (!value.paused && this.options.stopping?.()) throw new DomainError(SERVER_STOPPING, 409);
        h.pause(value.paused);
        return { ...value, queue: queueStopOf(h), serverRequiredForExecution: true };
      }
      default:
        throw new DomainError('Неизвестная операция', 400);
    }
  }
}
