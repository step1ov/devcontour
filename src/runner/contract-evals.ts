import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { configSchema } from '../core/model.ts';
import { DevContour, digest } from '../core/service.ts';
import { Store } from '../core/store.ts';
import { adapters, type AgentAdapter } from './adapters.ts';
import { FEASIBILITY, reviewContract } from './agent-control.ts';
import { git } from './process.ts';

/**
 * Корпус постановок для суждения ревьюера о выполнимости обязательств.
 *
 * Детерминированные тесты проверяют протокол: блокирующая находка класса
 * feasibility возвращает контракт. Способность модели заметить невыполнимое
 * обязательство и не отклонить выполнимое они не проверяют — для этого нужен
 * разрешённый живой прогон на неизменном корпусе. `either` — постановка без
 * однозначного ответа: учитывается вердикт, но не балл.
 */
const corpus = [
  {
    id: 'bounded-exact',
    expect: 'approve',
    content:
      'O-1: Given up to 20 items (integer weights and values ≤ 10^6) and a capacity, return a subset of maximum total value within the capacity. Exact optimum. Inputs with more than 20 items are refused with TooLarge. Time: ≤ 1 s for n = 20 on the reference machine, measured by the acceptance benchmark; memory ≤ 256 MB.',
  },
  {
    id: 'unbounded-exact',
    expect: 'reject',
    content:
      'O-1: Given any number of items with arbitrary integer weights and values and a capacity, return a subset of maximum total value within the capacity. Exact optimum for every input, in O(n log n) time. No input is refused.',
  },
  {
    id: 'unmeasurable',
    expect: 'reject',
    content:
      'O-1: Search must always be fast and must return the most relevant results for every query. No limits on catalog size are assumed.',
  },
  {
    id: 'contradictory-resources',
    expect: 'reject',
    content:
      'O-1: Return the exact shortest path between two vertices of a weighted graph with up to 10^9 edges, read from the input file, within 1 ms and 1 MB of memory on a single core.',
  },
  {
    id: 'measurable-sort',
    expect: 'approve',
    content:
      'O-1: Sort up to 10^6 32-bit integers in non-decreasing order. Stable. Time ≤ 2 s and memory ≤ 512 MB for n = 10^6 on the reference machine, measured by the acceptance benchmark. Empty input returns an empty array.',
  },
  {
    // Трудность спрятана в ограничении на каждую сторону: при произвольных
    // длинах вопрос «поместится ли выбор поровну в два отсека» — разбиение.
    id: 'hidden-partition',
    expect: 'reject',
    content:
      'O-1: Given up to 60 parcels, each with an integer weight ≤ 10^5 g and a real length ≤ 200 cm, and two identical cargo bays of length L ≤ 300 cm, return the complete set of total weights achievable by loading the same number of parcels into each bay without exceeding L in either bay. Complete for every input, no refusal and no approximation. Time ≤ 2 s for n = 60 on the reference machine, measured by the acceptance benchmark; memory ≤ 512 MB.',
  },
  {
    id: 'partition-with-flag',
    expect: 'approve',
    content:
      'O-1: Given up to 60 parcels, each with an integer weight ≤ 10^5 g and a real length ≤ 200 cm, and two identical cargo bays of length L ≤ 300 cm, return total weights achievable by loading the same number of parcels into each bay without exceeding L in either bay. Every returned weight is achievable. The answer carries complete = true when the set is exhaustive; complete = true is required when no bay can overflow or when the parcels have at most two distinct lengths, otherwise complete = false is allowed. Time ≤ 2 s for n = 60 on the reference machine, measured by the acceptance benchmark; memory ≤ 512 MB.',
  },
  {
    id: 'exact-with-fallback',
    expect: 'either',
    content:
      'O-1: Schedule up to 40 jobs with precedence constraints on 3 machines minimizing makespan. Search for the exact optimum for at most 2 s; if the limit is reached, return the best schedule found with approximate = true and its lower bound. Measured by the acceptance benchmark at n = 40.',
  },
] as const;

const optionsSchema = z.strictObject({
  runtime: z.enum(['codex', 'claude']).optional(),
  reviewerModel: z.string().min(1).optional(),
  maxCalls: z.number().int().min(1).max(30).default(corpus.length),
  timeoutMs: z.number().int().min(1000).max(900000).default(300000),
});

type Verdict = 'approved' | 'rejected' | 'unverified';

export async function contractEvals(
  raw: unknown = {},
  fixture?: (content: string) => { approved: boolean; feasibility: boolean },
) {
  const options = optionsSchema.parse(raw);
  if (options.runtime && !options.reviewerModel)
    throw new Error('Live corpus requires an explicit reviewer model');
  if (!options.runtime && options.reviewerModel)
    throw new Error('Models require explicit live runtime');
  if (options.runtime && fixture) throw new Error('Injected fixture cannot be combined with live');
  const author = options.runtime ?? 'codex';
  const reviewer = author === 'codex' ? 'claude' : 'codex';
  // Без live модель не вызывается: фикстура по умолчанию отвечает ожидаемым
  // вердиктом и проверяет только подсчёт и протокол, не качество суждения.
  const answer =
    fixture ??
    ((content: string) => {
      const c = corpus.find((x) => x.content === content)!;
      return { approved: c.expect !== 'reject', feasibility: c.expect === 'reject' };
    });
  const scripted = (name: 'codex' | 'claude'): AgentAdapter => ({
    name,
    async execute(request) {
      // Ревью сохраняет предложение рядом со своими артефактами до вызова.
      const proposal = JSON.parse(
        await readFile(join(request.artifactDir, 'proposal.json'), 'utf8'),
      ) as { content: string };
      const r = answer(proposal.content);
      return {
        data: {
          approved: r.approved,
          summary: 'Protocol fixture; no model called',
          findings: r.feasibility
            ? [{ severity: 'blocking', message: 'O-1 fixture finding', rule: FEASIBILITY }]
            : [],
          discoveries: [],
        },
        log: 'fixture',
        command: [],
      };
    },
  });
  let calls = 0;
  const bounded = (adapter: AgentAdapter): AgentAdapter => ({
    ...adapter,
    execute: (request) => {
      if (calls >= options.maxCalls) throw new Error('Invocation budget exhausted');
      calls++;
      return adapter.execute(request);
    },
  });
  const runtimes = options.runtime
    ? { codex: bounded(adapters.codex), claude: bounded(adapters.claude) }
    : { codex: bounded(scripted('codex')), claude: bounded(scripted('claude')) };
  const results: {
    caseId: string;
    expect: 'approve' | 'reject' | 'either';
    verdict: Verdict;
    feasibilityFinding: boolean;
    status: 'correct' | 'false-rejection' | 'missed' | 'recorded' | 'unverified';
    durationMs: number;
  }[] = [];
  for (const scenario of corpus) {
    const started = Date.now();
    const root = await mkdtemp(join(tmpdir(), 'devcontour-contract-eval-'));
    const repo = join(root, 'repo');
    let store: Store | undefined;
    let verdict: Verdict = 'unverified';
    let feasibilityFinding = false;
    try {
      await git(root, 'init', '-q', '-b', 'main', repo);
      await writeFile(join(repo, 'README.md'), 'Contract feasibility evaluation input.\n');
      await git(repo, 'add', '.');
      await git(
        repo,
        '-c',
        'user.name=Evaluation',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'input',
      );
      const config = configSchema.parse({
        version: 1,
        name: 'Contract eval',
        repository: repo,
        mode: 'local',
        runTimeoutMs: options.timeoutMs,
        resourceDatabase: join(root, 'resources.sqlite'),
        roles: { architect: { runtime: author } },
        reviewer: { runtime: reviewer, model: options.reviewerModel },
        // Ревью контракта гейтов не запускает; конфигурация требует хотя бы один.
        gates: [{ id: 'none', kind: 'test', command: ['node', '--version'] }],
        protectedPaths: [],
      });
      store = new Store(join(root, 'state.sqlite'));
      const h = new DevContour(store, config);
      try {
        const r = await reviewContract(
          h,
          join(root, 'data'),
          { title: scenario.id, content: scenario.content },
          author,
          runtimes,
        );
        verdict = r.status === 'approved' ? 'approved' : 'unverified';
      } catch (error) {
        if (!(error instanceof Error) || !/Независимое ревью отклонено/.test(error.message))
          throw error;
        verdict = 'rejected';
      }
      feasibilityFinding = (store.read().contractAttempts ?? []).some((a) =>
        a.findings.some((f) => f.severity === 'blocking' && f.rule === FEASIBILITY),
      );
    } catch (error) {
      // Без live сбой — дефект самого прогона, а не «не проверено».
      if (!options.runtime) throw error;
      verdict = 'unverified';
    } finally {
      store?.close();
      await rm(root, { recursive: true, force: true });
    }
    results.push({
      caseId: scenario.id,
      expect: scenario.expect,
      verdict,
      feasibilityFinding,
      // Балл — только за суждение о выполнимости: отказ выполнимого контракта
      // по другой причине не ложный отказ по выполнимости.
      status:
        verdict === 'unverified'
          ? 'unverified'
          : scenario.expect === 'either'
            ? 'recorded'
            : scenario.expect === 'reject'
              ? verdict === 'rejected' && feasibilityFinding
                ? 'correct'
                : 'missed'
              : feasibilityFinding
                ? 'false-rejection'
                : 'correct',
      durationMs: Date.now() - started,
    });
  }
  const count = (status: string) => results.filter((r) => r.status === status).length;
  return {
    version: 1,
    mode: options.runtime ? 'live-contract' : fixture ? 'injected-contract' : 'contract-fixture',
    // Фикстура отвечает ожидаемым вердиктом: зелёный результат без live
    // говорит о протоколе, а не о суждении модели.
    judgementMeasured: Boolean(options.runtime),
    authorRuntime: author,
    reviewerRuntime: reviewer,
    reviewerModel: options.reviewerModel ?? null,
    corpusDigest: digest(corpus),
    budget: { calls, maxCalls: options.maxCalls, timeoutMs: options.timeoutMs },
    summary: {
      correct: count('correct'),
      falseRejections: count('false-rejection'),
      missed: count('missed'),
      recorded: count('recorded'),
      unverified: count('unverified'),
    },
    passed: results.every((r) => r.status === 'correct' || r.status === 'recorded'),
    results,
  };
}
