import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { configSchema } from '../core/model.ts';
import { DevContour, digest } from '../core/service.ts';
import { Store } from '../core/store.ts';
import { priceSchema, usageTotals, type UsageRecord } from '../core/usage.ts';
import { adapters, type AgentAdapter } from './adapters.ts';
import { Scheduler } from './scheduler.ts';
import { git } from './process.ts';
import { capabilities } from '../application/agent.ts';

const corpus = [
  {
    id: 'api-consumer',
    goal: 'Change list() to return {items, total}. Keep names() returning the joined item names; update the consumer to the new contract.',
    before: {
      'api.mjs': 'export const list = () => [{name:"Ada"},{name:"Lin"}];',
      'consumer.mjs':
        'import {list} from "./api.mjs"; export const names=()=>list().map(x=>x.name).join(",");',
    },
    after: {
      'api.mjs': 'export const list = () => ({items:[{name:"Ada"},{name:"Lin"}],total:2});',
      'consumer.mjs':
        'import {list} from "./api.mjs"; export const names=()=>list().items.map(x=>x.name).join(",");',
    },
    check:
      'const {list}=await import("./src/api.mjs"); const {names}=await import("./src/consumer.mjs"); assert.deepEqual(list(),{items:[{name:"Ada"},{name:"Lin"}],total:2});assert.equal(names(),"Ada,Lin");',
  },
  {
    id: 'migration',
    goal: 'Implement migrate(db) for an existing SQLite messages(id,body) table. Add is_read INTEGER NOT NULL DEFAULT 0, preserve existing rows and allow migration to be called twice.',
    before: { 'migrate.mjs': 'export function migrate(db) {}' },
    after: {
      'migrate.mjs':
        'export function migrate(db) { if(!db.prepare("PRAGMA table_info(messages)").all().some(c=>c.name==="is_read")) db.exec("ALTER TABLE messages ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0"); }',
    },
    check:
      'const {DatabaseSync}=await import("node:sqlite");const {migrate}=await import("./src/migrate.mjs");const db=new DatabaseSync(":memory:");db.exec("CREATE TABLE messages(id INTEGER PRIMARY KEY,body TEXT); INSERT INTO messages VALUES(1,\'hello\')");migrate(db);migrate(db);assert.deepEqual({...db.prepare("SELECT * FROM messages").get()},{id:1,body:"hello",is_read:0});assert.throws(()=>db.exec("INSERT INTO messages VALUES(2,\'x\',NULL)"));db.close();',
  },
  {
    id: 'pagination-regression',
    goal: 'Fix page(items, offset, limit): return at most limit items from the zero-based offset, allow zero limit, reject negative or non-integer offset/limit with RangeError, and never mutate items.',
    before: { 'page.mjs': 'export const page=(items,offset,limit)=>items.splice(offset,limit+1);' },
    after: {
      'page.mjs':
        'export function page(items,offset,limit) {if(!Number.isInteger(offset)||!Number.isInteger(limit)||offset<0||limit<0) throw new RangeError();return items.slice(offset,offset+limit);}',
    },
    check:
      'const {page}=await import("./src/page.mjs");const items=[1,2,3,4];assert.deepEqual(page(items,1,2),[2,3]);assert.deepEqual(items,[1,2,3,4]);assert.deepEqual(page(items,0,0),[]);assert.deepEqual(page(items,9,1),[]);for(const [a,b] of [[-1,1],[0,-1],[0.2,1],[0,1.2]])assert.throws(()=>page(items,a,b),RangeError);',
  },
] as const;
const optionsSchema = z.strictObject({
  prices: z.array(priceSchema).max(100).default([]),
  runtime: z.enum(['codex', 'claude']).optional(),
  model: z.string().min(1).optional(),
  reviewerModel: z.string().min(1).optional(),
  repetitions: z.number().int().min(1).max(5).default(1),
  maxCalls: z.number().int().min(1).max(45).default(9),
  timeoutMs: z.number().int().min(1000).max(900000).default(120000),
});
export async function engineeringEvals(raw: unknown = {}, fixtureAdapter?: AgentAdapter) {
  const options = optionsSchema.parse(raw);
  if (options.runtime && (!options.model || !options.reviewerModel))
    throw new Error('Live corpus requires explicit author and reviewer models');
  if (!options.runtime && (options.model || options.reviewerModel))
    throw new Error('Models require explicit live runtime');
  if (options.runtime && fixtureAdapter)
    throw new Error('Injected fixture cannot be combined with live mode');
  const results: {
    caseId: string;
    repetition: number;
    status: 'passed' | 'failed' | 'unverified';
    durationMs: number;
    costUsd: number | null;
    candidateChecked?: boolean;
    integrationChecked?: boolean;
  }[] = [];
  const usages: UsageRecord[] = [];
  let calls = 0;
  const runtimeVersions: Record<string, string | null> = {};
  for (let repetition = 1; repetition <= options.repetitions; repetition++)
    for (const scenario of corpus) {
      if (calls + 3 > options.maxCalls) {
        results.push({
          caseId: scenario.id,
          repetition,
          status: 'unverified',
          durationMs: 0,
          costUsd: null,
        });
        continue;
      }
      const root = await mkdtemp(join(tmpdir(), 'devcontour-engineering-')),
        repo = join(root, 'repo');
      let store: Store | undefined, scheduler: Scheduler | undefined;
      const started = Date.now();
      try {
        await mkdir(join(repo, 'src'), { recursive: true });
        await git(repo, 'init', '-b', 'main');
        await git(repo, 'config', 'user.name', 'Evaluation');
        await git(repo, 'config', 'user.email', 'fixture@example.invalid');
        for (const [path, contents] of Object.entries(scenario.before))
          await writeFile(join(repo, 'src', path), contents);
        await writeFile(join(repo, '.gitignore'), '.reports/\n.devcontour-local/\n.devcontour/\n');
        await writeFile(
          join(repo, 'verify.mjs'),
          `import assert from 'node:assert/strict';import {mkdirSync,writeFileSync} from 'node:fs';let failed=false;try {${scenario.check}}catch {failed=true;}mkdirSync('.reports',{recursive:true});writeFileSync('.reports/tests.xml', '<testsuite tests="1" failures="'+(failed?1:0)+'"><testcase name="${scenario.id}">'+(failed?'<failure message="behavior mismatch"/>':'')+'</testcase></testsuite>');if(failed)process.exitCode=1;`,
        );
        await git(repo, 'add', '.');
        await git(repo, 'commit', '-m', 'Isolated evaluation input');
        const reviewer = options.runtime === 'codex' ? 'claude' : 'codex';
        const config = configSchema.parse({
          version: 1,
          prices: options.prices,
          name: 'Engineering eval',
          repository: repo,
          mode: options.runtime ? 'local' : 'demo',
          concurrency: 1,
          maxAttempts: 1,
          runTimeoutMs: options.timeoutMs,
          resourceDatabase: join(root, 'resources.sqlite'),
          roles: Object.fromEntries(
            ['architect', 'backend', 'frontend', 'qa'].map((role) => [
              role,
              { runtime: options.runtime ?? 'demo', model: options.model },
            ]),
          ),
          reviewer: { runtime: options.runtime ? reviewer : 'demo', model: options.reviewerModel },
          gates: [
            {
              id: 'behavior',
              kind: 'test',
              command: ['node', 'verify.mjs'],
              report: { type: 'junit', path: '.reports/tests.xml' },
            },
          ],
          protectedPaths: ['verify.mjs', '.gitignore'],
        });
        store = new Store(join(root, 'state.sqlite'));
        const h = new DevContour(store, config);
        const board = h.createBoard('Engineering ' + scenario.id, '', 'main');
        const contract = h.contract(
          'Evaluation contract',
          scenario.goal,
          { actor: 'operator' },
          'main',
        );
        h.addTask(board.id, {
          contracts: [contract.id],
          title: scenario.id,
          description: scenario.goal,
          role: 'backend',
          acceptance: [scenario.goal],
          writePaths: ['src/'],
        });
        h.approve(board.id, undefined, { actor: 'operator' }); // Fixed corpus specification, not a model-approved product plan.
        const fixture: AgentAdapter = fixtureAdapter ?? {
          name: 'demo',
          version: 'engineering-fixture-v1',
          execute: async (request) => {
            if (request.review)
              return {
                data: {
                  approved: true,
                  summary: 'Protocol fixture review; quality is checked by the executable oracle',
                  findings: [],
                  discoveries: [],
                },
                log: 'fixture',
                command: [],
              };
            for (const [path, contents] of Object.entries(scenario.after))
              await writeFile(join(request.cwd, 'src', path), contents);
            return {
              data: {
                completed: true,
                summary: 'Reference fixture patch',
                tests: [],
                discoveries: [],
              },
              log: 'fixture',
              command: [],
            };
          },
        };
        const bounded = (adapter: AgentAdapter): AgentAdapter => ({
          ...adapter,
          execute: async (request) => {
            if (calls >= options.maxCalls) throw new Error('Invocation budget exhausted');
            calls++;
            return adapter.execute(request);
          },
        });
        scheduler = new Scheduler(h, root, {
          codex: bounded(adapters.codex),
          claude: bounded(adapters.claude),
          demo: bounded(fixture),
        });
        await scheduler.init();
        h.pause(false);
        await scheduler.drain();
        const run = store.read().runs[0],
          task = store.read().tasks[0];
        const usage = Object.values(store.localRecords<UsageRecord>('usage', 'main'));

        for (const call of usage) runtimeVersions[call.runtime] = call.runtimeVersion;
        const checked = (phase: string) =>
          run?.evidence.some((e) => e.kind === 'test' && e.phase === phase && e.passed) ?? false;
        results.push({
          caseId: scenario.id,
          repetition,
          status:
            task.status === 'done'
              ? 'passed'
              : run?.evidence.some((e) => !e.passed)
                ? 'failed'
                : 'unverified',
          durationMs: Date.now() - started,
          costUsd: usageTotals(usage).costUsd,
          candidateChecked: checked('candidate'),
          integrationChecked: checked('integration'),
        });
      } catch (error) {
        if (!options.runtime) throw error;
        results.push({
          caseId: scenario.id,
          repetition,
          status: 'unverified',
          durationMs: Date.now() - started,
          costUsd: null,
        });
      } finally {
        if (store) usages.push(...Object.values(store.localRecords<UsageRecord>('usage', 'main')));
        await scheduler?.stop();
        store?.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  return {
    version: 1,
    caseIds: corpus.map((s) => s.id),
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    mode: options.runtime
      ? 'live-engineering'
      : fixtureAdapter
        ? 'injected-engineering'
        : 'engineering-fixture',
    runtime: options.runtime ?? null,
    model: options.model ?? null,
    reviewerModel: options.reviewerModel ?? null,
    runtimeVersions,
    priceTableDigest: digest(options.prices),
    corpusDigest: digest(corpus),
    catalogDigest: digest(capabilities()),
    instructionsDigest: digest(corpus.map((c) => c.goal)),
    budget: {
      ...usageTotals(
        usages,
        results.some((r) => r.status === 'unverified'),
      ),
      calls,
      maxCalls: options.maxCalls,
      repetitions: options.repetitions,
      timeoutMs: options.timeoutMs,
    },
    passed: results.every((r) => r.status === 'passed'),
    results,
  };
}
