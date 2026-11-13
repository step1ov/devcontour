import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, input, reapprove } from './helpers.ts';
import { reviewContract } from '../src/runner/agent-control.ts';
import { ContractChanges } from '../src/runner/contract-change.ts';
import { type AgentAdapter, type AgentRequest } from '../src/runner/adapters.ts';
import { pinContext } from '../src/runner/context.ts';
import { loadedDigest } from '../src/core/service.ts';
import { loadConfig } from '../src/runner/config.ts';

/** Ревьюер-фикстура: одобряет и считает вызовы по предмету ревью. */
// Аргументы git после глобальных флагов (`-c ключ=значение`, `--no-replace-objects`):
// git хоста (harness) ставит перед командой флаги, снимающие исполняемые настройки.
export function gitCommand(args: string[]) {
  let i = 0;
  while (args[i] === '-c' || args[i]?.startsWith('--')) i += args[i] === '-c' ? 2 : 1;
  return args.slice(i);
}
export function reviewers(calls: string[]) {
  const make = (name: 'codex' | 'claude'): AgentAdapter => ({
    name,
    execute(r: AgentRequest) {
      calls.push(/Independently review this ([a-z /]+)\./.exec(r.prompt)?.[1] ?? '?');
      return Promise.resolve({
        data: { approved: true, summary: 'Fixture', findings: [], discoveries: [] },
        log: 'Fixture only; no provider called',
        command: ['fixture'],
      });
    },
  });
  return { codex: make('codex'), claude: make('claude') };
}

export async function stage() {
  const f = fixture();
  const repo = await mkdtemp(join(tmpdir(), 'devcontour-change-'));
  f.h.config.repository = repo;
  f.h.config.mode = 'local';
  const sh = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: repo })
      .toString()
      .trim();
  sh('init', '-q', '-b', 'main');
  await mkdir(join(repo, 'docs/contracts'), { recursive: true });
  await writeFile(join(repo, 'docs/contracts/catalog.md'), '# Catalog\n\nSee schema.json.\n');
  await writeFile(join(repo, 'schema.json'), '{"price":"string"}\n');
  sh('add', '.');
  sh('commit', '-qm', 'contract');
  sh('branch', 'devcontour/accepted');
  const proposal = {
    title: 'Catalog API v1',
    file: 'docs/contracts/catalog.md',
    artifacts: [{ path: 'schema.json', purpose: 'Схема ответа' }],
  };
  const calls: string[] = [];
  await reviewContract(f.h, f.root, proposal, 'codex', reviewers(calls));
  const c1 = f.store.read().contracts[0];
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
  // Новая редакция схемы закоммичена в рабочую ветку.
  await writeFile(join(repo, 'schema.json'), '{"price":"number"}\n');
  sh('commit', '-qam', 'schema');
  calls.length = 0;
  const task = (id: string) => f.store.read().tasks.find((t) => t.id === id)!;
  return {
    ...f,
    repo,
    sh,
    proposal,
    calls,
    c1,
    board,
    api,
    screen,
    shipped,
    task,
    changes: (afterStep?: (step: string) => void) =>
      new ContractChanges(f.h, f.root, reviewers(calls), afterStep),
    async remove() {
      await rm(repo, { recursive: true, force: true });
      f.cleanup();
    },
  };
}

/**
 * Пакет контекста включает документ контракта и закреплён на прежней
 * редакции; конфигурация записана в `config.json` и загружена из него, как у
 * работающего сервера. Затем документ меняется вместе со схемой.
 */
export async function withContextPack(s: Awaited<ReturnType<typeof stage>>) {
  s.h.config.contextPacks = await pinContext({
    ...s.h.config,
    contextPacks: [
      {
        id: 'contracts',
        version: '1.0',
        repositoryId: 'main',
        roles: ['backend'],
        files: ['docs/contracts/catalog.md'],
        references: [],
      },
    ],
  });
  // Рабочая конфигурация local mode: исполнитель и ревьюер — разные
  // настоящие runtime (модели в тестах не вызываются: ревьюеры — фикстуры).
  for (const role of Object.values(s.h.config.roles)) {
    role.runtime = 'codex';
    if (role.reviewer) role.reviewer.runtime = 'claude';
  }
  s.h.config.reviewer = { ...s.h.config.reviewer, runtime: 'claude' };
  const path = join(s.root, 'config.json');
  await writeFile(path, JSON.stringify(s.h.config, null, 2) + '\n');
  s.h.config = loadConfig(path);
  // Роли сменились после утверждения плана фикстуры: план утверждается заново (D43).
  reapprove(s.h);
  await writeFile(join(s.repo, 'docs/contracts/catalog.md'), '# Catalog\n\nPrice is a number.\n');
  s.sh('commit', '-qam', 'contract text');
  const pinnedBefore = s.h.config.contextPacks[0].revision;
  return { path, pinnedBefore, digest: () => loadedDigest(loadConfig(path)) };
}
