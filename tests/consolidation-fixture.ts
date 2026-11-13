import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, input } from './helpers.ts';
import { reviewContract } from '../src/runner/agent-control.ts';
import { ContractChanges } from '../src/runner/contract-change.ts';
import { type AgentAdapter, type AgentRequest } from '../src/runner/adapters.ts';

/**
 * Контракт, накопивший поправки этапов, и его консолидированный текст.
 * Ссылка соседнего контракта `orders.md` на раздел `#prices` должна
 * пережить консолидацию; ID-токены REQ-1…REQ-3 — тоже.
 */
export const AMENDED = [
  '# Catalog',
  '',
  '## Prices',
  '',
  'REQ-1. Price is a string.',
  '',
  'Amendment (stage 2): REQ-1 is replaced — price is a number.',
  '',
  '## Listing',
  '',
  'REQ-2. The listing returns at most 50 items.',
  '',
  'Amendment (stage 3): REQ-3. The listing is sorted by name.',
  '',
  'Amendment (stage 4): REQ-2 now allows at most 100 items.',
  '',
].join('\n');
export const CONSOLIDATED = [
  '# Catalog',
  '',
  '## Prices',
  '',
  'REQ-1. Price is a number.',
  '',
  '## Listing',
  '',
  'REQ-2. At most 100 items. REQ-3. Sorted by name.',
  '',
].join('\n');

export type Decide = (
  request: AgentRequest,
  subject: string,
) => { approved: boolean; summary: string; findings?: unknown[] } | undefined;

/** Ревьюер-фикстура: записывает предмет и запрос, решает по `decide` (по умолчанию одобряет). */
export function reviewers(calls: string[], prompts: string[], decide: Decide = () => undefined) {
  const make = (name: 'codex' | 'claude'): AgentAdapter => ({
    name,
    execute(r: AgentRequest) {
      const subject = /Independently review this ([a-z /]+)\./.exec(r.prompt)?.[1] ?? '?';
      calls.push(subject);
      prompts.push(r.prompt);
      const decision = decide(r, subject) ?? { approved: true, summary: 'Fixture' };
      return Promise.resolve({
        data: { findings: [], discoveries: [], ...decision },
        log: 'Fixture only; no provider called',
        command: ['fixture'],
      });
    },
  });
  return { codex: make('codex'), claude: make('claude') };
}

export async function consolidationStage() {
  const f = fixture();
  const repo = await mkdtemp(join(tmpdir(), 'devcontour-consolidate-'));
  f.h.config.repository = repo;
  f.h.config.mode = 'local';
  const sh = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: repo })
      .toString()
      .trim();
  sh('init', '-q', '-b', 'main');
  await mkdir(join(repo, 'docs/contracts'), { recursive: true });
  await writeFile(join(repo, 'docs/contracts/catalog.md'), AMENDED);
  await writeFile(
    join(repo, 'docs/contracts/orders.md'),
    '# Orders\n\nAn order line uses the price of [catalog](catalog.md#prices).\n',
  );
  await writeFile(join(repo, 'schema.json'), '{"price":"number"}\n');
  sh('add', '.');
  sh('commit', '-qm', 'contracts');
  sh('branch', 'devcontour/accepted');
  const proposal = {
    title: 'Catalog API',
    file: 'docs/contracts/catalog.md',
    artifacts: [{ path: 'schema.json', purpose: 'Схема ответа' }],
  };
  const calls: string[] = [];
  const prompts: string[] = [];
  await reviewContract(
    f.h,
    f.root,
    { title: 'Orders API', file: 'docs/contracts/orders.md' },
    'codex',
    reviewers(calls, prompts),
  );
  await reviewContract(f.h, f.root, proposal, 'codex', reviewers(calls, prompts));
  const c1 = f.store.read().contracts.at(-1)!;
  const board = f.h.createBoard('Catalog');
  const api = f.h.addTask(board.id, { ...input('API'), role: 'backend', contracts: [c1.id] });
  const screen = f.h.addTask(board.id, { ...input('Screen', [api.id]), role: 'qa' });
  f.h.approve(board.id);
  const shipped = f.h.addTask(f.h.createBoard('Shipped').id, {
    ...input('Shipped API'),
    role: 'backend',
    contracts: [c1.id],
  });
  f.store.change('fixture.done', (s) => {
    s.tasks.find((t) => t.id === shipped.id)!.status = 'done';
  });
  calls.length = 0;
  prompts.length = 0;
  const task = (id: string) => f.store.read().tasks.find((t) => t.id === id)!;
  /** Записать и закоммитить документ контракта в рабочую ветку. */
  const commitDoc = async (text: string, file = 'docs/contracts/catalog.md') => {
    await writeFile(join(repo, file), text);
    sh('add', file);
    sh('commit', '-qm', 'doc ' + file);
  };
  return {
    ...f,
    repo,
    sh,
    proposal,
    calls,
    prompts,
    c1,
    board,
    api,
    screen,
    shipped,
    task,
    commitDoc,
    changes: (decide?: Decide, afterStep?: (step: string) => void) =>
      new ContractChanges(f.h, f.root, reviewers(calls, prompts, decide), afterStep),
    async remove() {
      await rm(repo, { recursive: true, force: true });
      f.cleanup();
    },
  };
}
