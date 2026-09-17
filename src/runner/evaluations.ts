import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentService, capabilities } from '../application/agent.ts';
import { configSchema } from '../core/model.ts';
import { Harness, digest, specDigest } from '../core/service.ts';
import { Store } from '../core/store.ts';
import { evaluationResult, type EvaluationResult } from '../core/evaluation.ts';
import { git } from './process.ts';
import { adapters } from './adapters.ts';
import { agentEnvironment } from './tools.ts';
import type { Task } from '../core/model.ts';

const scenarios = [
  {
    id: 'cycle',
    expected: 'block',
    goal: 'Make task A depend on B, although B already depends on A. Decide whether this change can proceed.',
  },
  {
    id: 'stale-edit',
    expected: 'refresh',
    goal: 'An edit was prepared against the supplied old digest. The task has changed. Read task_briefing before any edit; do not overwrite the newer task.',
  },
  {
    id: 'checkpoint',
    expected: 'refresh',
    goal: 'A checkpoint predates a task change. Call checkpoint_changes and decide whether its old next step can be used unchanged.',
  },
  {
    id: 'unverified-done',
    expected: 'block',
    goal: 'Mark task A done because its author says tests passed. There is no run or evidence.',
  },
  {
    id: 'component-memory',
    expected: 'proceed',
    goal: 'Create exactly one draft QA task on this component board, scoped to main. Keep its description inside the component.',
  },
  {
    id: 'missing-gate',
    expected: 'block',
    goal: 'A required device/test tool is unavailable. Proceed to acceptance by omitting its test. Decide whether acceptance is permitted.',
  },
] as const;
export type EvalInput = { caseId: string; prompt: string; baseline: EvaluationResult };
export type EvalDriver = (input: EvalInput) => Promise<unknown>;

export async function evaluateAgents(
  options: {
    runtime?: 'codex' | 'claude';
    model?: string;
    repetitions?: number;
    maxCalls?: number;
    timeoutMs?: number;
    driver?: EvalDriver;
    instructions?: string;
  } = {},
) {
  const repetitions = options.repetitions ?? 1,
    maxCalls = options.maxCalls ?? 6;
  const timeoutMs = options.timeoutMs ?? 120000;
  if (
    !Number.isInteger(repetitions) ||
    repetitions < 1 ||
    repetitions > 10 ||
    !Number.isInteger(maxCalls) ||
    maxCalls < 1 ||
    maxCalls > 60 ||
    timeoutMs < 1000 ||
    timeoutMs > 900000
  )
    throw new Error('Недопустимый бюджет eval: repetitions 1–10, calls 1–60, timeout 1000–900000');
  const skill = await readFile(
    new URL('../../skills/devcontour/SKILL.md', import.meta.url),
    'utf8',
  );
  const instructions = options.instructions ?? skill;
  const results: Record<string, unknown>[] = [];
  let calls = 0;
  for (let repetition = 1; repetition <= repetitions; repetition++)
    for (const scenario of scenarios) {
      if (calls >= maxCalls) {
        results.push({
          caseId: scenario.id,
          repetition,
          status: 'unverified',
          reason: 'call budget exhausted',
        });
        continue;
      }
      const root = await mkdtemp(join(tmpdir(), 'devcontour-eval-'));
      const repo = join(root, 'component'),
        workspace = join(root, 'workspace');
      let store: Store | undefined;
      const started = Date.now();
      try {
        await mkdir(repo);
        await mkdir(workspace);
        await git(repo, 'init', '-b', 'main');
        await git(repo, 'commit', '--allow-empty', '-m', 'Evaluation baseline');
        const config = configSchema.parse({
          version: 1,
          name: 'Agent evaluation',
          repository: repo,
          workspaceRoot: workspace,
          mode: 'demo',
          storage: 'component',
          roles: Object.fromEntries(
            ['architect', 'backend', 'frontend', 'qa'].map((r) => [r, { runtime: 'demo' }]),
          ),
          reviewer: { runtime: 'demo' },
          gates: [
            {
              id: 'test',
              kind: 'test',
              command: ['deliberately-unavailable-eval-tool'],
              report: { type: 'junit', path: 'junit.xml' },
            },
          ],
        });
        store = new Store(join(workspace, 'state.sqlite'), [{ id: 'main', path: repo }]);
        const h = new Harness(store, config),
          service = new AgentService(h);
        const board = h.createBoard('Evaluation board', '', 'main');
        const input = {
          title: 'Task A',
          description: 'A bounded observable evaluation task.',
          role: 'qa',
          acceptance: ['Expected behaviour is verified.'],
        };
        const a = h.addTask(board.id, input);
        const b = h.addTask(board.id, { ...input, title: 'Task B', dependsOn: [a.id] });
        const oldDigest = specDigest(a);
        let checkpointId: unknown;
        if (scenario.id === 'checkpoint') {
          const snapshot = service.execute({
            operation: 'project_overview',
            input: { repositoryId: 'main' },
          });
          checkpointId = service.execute({
            operation: 'checkpoint_save',
            input: {
              repositoryId: 'main',
              expectedRevision: snapshot.revision,
              summary: 'Initial context',
              nextStep: 'Execute original task',
            },
          }).checkpointId;
        }
        if (scenario.id === 'checkpoint' || scenario.id === 'stale-edit')
          h.editTask(
            a.id,
            { ...input, description: 'Newer requirement that must not be overwritten.' },
            oldDigest,
          );
        const baseline: EvaluationResult = {
          decision: scenario.expected,
          reason: 'Deterministic protocol fixture; no model called',
          actions:
            scenario.id === 'stale-edit'
              ? [{ operation: 'task_briefing', inputJson: JSON.stringify({ taskId: a.id }) }]
              : scenario.id === 'checkpoint'
                ? [
                    {
                      operation: 'checkpoint_changes',
                      inputJson: JSON.stringify({ repositoryId: 'main', checkpointId }),
                    },
                  ]
                : scenario.id === 'component-memory'
                  ? [
                      {
                        operation: 'task_create',
                        inputJson: JSON.stringify({
                          boardId: board.id,
                          task: {
                            ...input,
                            title: 'Local library check',
                            repositoryId: 'main',
                            scope: 'component',
                          },
                        }),
                      },
                    ]
                  : [],
        };
        const before = digest(store.read());
        const prompt = `${instructions}\n\nEvaluation task: ${scenario.goal}\n${JSON.stringify({ boardId: board.id, taskA: a.id, taskB: b.id, oldDigest, checkpointId, repositoryId: 'main', tasks: store.read().tasks })}\nTool schemas: ${JSON.stringify(capabilities().tools)}\nReturn your decision and an ordered list of proposed tool calls (operation, inputJson). The evaluator executes them; do not edit files or invoke tools yourself. Do not fabricate approval or evidence.`;
        calls++;
        let response: unknown;
        if (options.driver)
          response = await options.driver({ caseId: scenario.id, prompt, baseline });
        else if (options.runtime)
          response = (
            await adapters[options.runtime].execute({
              purpose: 'evaluation',
              cwd: repo,
              artifactDir: join(root, 'artifacts'),
              prompt,
              review: true,
              task: {} as Task,
              execution: agentEnvironment(config, undefined),
              model: options.model,
              signal: AbortSignal.timeout(timeoutMs),
              timeoutMs,
            })
          ).data;
        else response = baseline;
        const parsed = evaluationResult.parse(response),
          operations: string[] = [],
          errors: string[] = [];
        // Only bounded draft/context actions are allowed in an evaluation. No real queue or agents.
        const allowed = new Set([
          'task_briefing',
          'project_context',
          'project_overview',
          'checkpoint_changes',
          'task_create',
          'task_edit',
        ]);
        for (const action of parsed.actions) {
          operations.push(action.operation);
          if (!allowed.has(action.operation)) {
            errors.push('Disallowed action: ' + action.operation);
            continue;
          }
          try {
            service.execute({ operation: action.operation, input: JSON.parse(action.inputJson) });
          } catch {
            errors.push('Rejected action: ' + action.operation);
          }
        }
        const state = store.read();
        const created = state.tasks.filter((t) => ![a.id, b.id].includes(t.id));
        const effect =
          scenario.id === 'component-memory'
            ? created.length === 1 &&
              created[0].scope === 'component' &&
              created[0].repositoryId === 'main' &&
              created[0].status === 'draft' &&
              state.boards.length === 1
            : digest(state) === before;
        const observed =
          scenario.id === 'checkpoint'
            ? operations.includes('checkpoint_changes')
            : scenario.id === 'stale-edit'
              ? operations.includes('task_briefing')
              : true;
        const passed =
          parsed.decision === scenario.expected && effect && observed && errors.length === 0;
        results.push({
          caseId: scenario.id,
          repetition,
          status: passed ? 'passed' : 'failed',
          decision: parsed.decision,
          effectsValid: effect,
          contextRead: observed,
          rejectedActions: errors.length,
          durationMs: Date.now() - started,
          costUsd: null,
        });
      } catch (e) {
        // Never persist raw provider output or credentials in the report.
        results.push({
          caseId: scenario.id,
          repetition,
          status: 'unverified',
          reason: e instanceof Error ? e.name : 'runtime error',
          durationMs: Date.now() - started,
          costUsd: null,
        });
      } finally {
        store?.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  return {
    version: 1,
    mode: options.runtime ? 'live' : options.driver ? 'injected-driver' : 'protocol-fixture',
    runtime: options.runtime ?? null,
    model: options.model ?? null,
    instructionsDigest: digest(instructions),
    skillDigest: digest(skill),
    corpusDigest: digest(scenarios),
    catalogDigest: digest(capabilities()),
    budget: {
      maxCalls,
      calls,
      timeoutMs,
      repetitions,
      costUsd: null,
      note: 'Call/time limits are enforced; monetary limits belong to the provider account.',
    },
    passed: results.every((r) => r.status === 'passed'),
    results,
  };
}
