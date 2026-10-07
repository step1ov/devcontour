import { randomUUID } from 'node:crypto';
import { arch, cpus, platform } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { DomainError } from '../core/model.ts';
import { digest, type DevContour } from '../core/service.ts';
import { repositories, repository } from '../core/repositories.ts';
import { executionEnvironment } from './environment.ts';
import { runCheck } from './gates.ts';
import { git } from './process.ts';

/**
 * Ограниченный эксперимент выполнимости (spike).
 *
 * Невыполнимые или неизмеримые обязательства обнаруживались после серии
 * попыток реализации. Для тяжёлого точного алгоритма или жёсткого времени до
 * реализации запускается короткий эксперимент: команда эталона или прототипа
 * на закреплённом SHA, seed и размеры входов, предел времени. Результат
 * сохраняется с версиями и пределами вывода. Таймаут — `inconclusive` для
 * выбранного способа и бюджета: он не доказывает трудность или
 * невозможность и не даёт права менять требование. Успех на выборке не
 * доказывает верхней границы на любом входе.
 */
export const spikeInput = z.strictObject({
  repositoryId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,80}$/)
    .optional(),
  /** Commit эталона или прототипа; по умолчанию — HEAD компонента. */
  sha: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .optional(),
  command: z.array(z.string().min(1)).min(1).max(50),
  sizes: z.array(z.number().int().min(0).max(1_000_000_000)).min(1).max(20),
  seed: z.number().int().min(0).max(4294967295).default(1),
  /** Предел на один размер. */
  timeoutMs: z.number().int().min(100).max(600000),
  /** Что исследуется: набор входов и вопрос эксперимента. */
  question: z.string().trim().min(10).max(2000),
});
export interface Spike {
  id: string;
  repositoryId: string;
  sha: string;
  command: string[];
  seed: number;
  sizes: number[];
  timeoutMs: number;
  question: string;
  results: {
    size: number;
    ms: number;
    outcome: 'ok' | 'timeout' | 'error';
    exitCode: number;
  }[];
  outcome: 'feasible' | 'inconclusive' | 'failed';
  /** Пределы вывода: что эксперимент показывает, а что — нет. */
  limits: string;
  environment: { platform: string; arch: string; node: string; cpus: number; isolation: string };
  at: string;
  digest: string;
}
const KIND = 'spikes';

export function spikesOf(h: DevContour, repositoryId: string) {
  return Object.values(h.store.localRecords<Spike>(KIND, repositoryId));
}
export function spikeRecord(h: DevContour, repositoryId: string, id: string) {
  return h.store.localRecords<Spike>(KIND, repositoryId)[id];
}

/** Каталоги, закрытые проверке: база контура и исходные checkout компонентов. */
export function controllerBoundary(h: DevContour, root: string) {
  const repos = repositories(h.config);
  return {
    hidden: [...new Set([root, ...repos.map((r) => r.path)])],
    readable: repos.map((r) => join(r.path, '.git')),
  };
}

export async function runSpike(h: DevContour, root: string, raw: unknown): Promise<Spike> {
  const input = spikeInput.parse(raw);
  const repo = repository(h.config, input.repositoryId ?? repositories(h.config)[0].id);
  const sha = input.sha ?? (await git(repo.path, 'rev-parse', 'HEAD'));
  await git(repo.path, 'cat-file', '-e', `${sha}^{commit}`).catch(() => {
    throw new DomainError(`Commit ${sha} недоступен в ${repo.id}`, 404);
  });
  const id = 'SP-' + randomUUID();
  const dir = join(root, 'spikes', id);
  await mkdir(join(root, 'spikes'), { recursive: true });
  await git(repo.path, 'worktree', 'add', '--detach', dir, sha);
  const results: Spike['results'] = [];
  try {
    const boundary = controllerBoundary(h, root);
    for (const size of input.sizes) {
      const environment = executionEnvironment([h.config.environment, repo.environment], {
        DEVCONTOUR_SPIKE_SIZE: String(size),
        DEVCONTOUR_SEED: String(input.seed),
      });
      const started = Date.now();
      const result = await runCheck(h, {
        argv: input.command,
        cwd: dir,
        env: environment.env,
        redact: environment.redact,
        timeoutMs: input.timeoutMs,
        signal: AbortSignal.timeout(input.timeoutMs + 60000),
        write: [dir],
        readable: boundary.readable,
        controller: boundary.hidden.filter((p) => p !== dir),
        settingsDir: join(root, 'spikes', `${id}-settings`),
      });
      const ms = Date.now() - started;
      results.push({
        size,
        ms,
        outcome: result.timedOut ? 'timeout' : result.code === 0 ? 'ok' : 'error',
        exitCode: result.code,
      });
      // После таймаута большие размеры ничего не добавят к выводу.
      if (result.timedOut) break;
    }
  } finally {
    await git(repo.path, 'worktree', 'remove', '--force', dir).catch(() => undefined);
  }
  const outcome = results.some((r) => r.outcome === 'timeout')
    ? 'inconclusive'
    : results.some((r) => r.outcome === 'error')
      ? 'failed'
      : 'feasible';
  const timeout = results.find((r) => r.outcome === 'timeout');
  const limits =
    outcome === 'inconclusive'
      ? `Таймаут ${input.timeoutMs} мс на размере ${timeout!.size}: для этого способа и бюджета вывод не сделан. Это не доказательство невыполнимости или трудности и не основание менять требование.`
      : outcome === 'failed'
        ? 'Команда эксперимента завершилась ошибкой: вывод о выполнимости не сделан.'
        : `Успех на размерах ${input.sizes.join(', ')} с seed ${input.seed} в указанной среде. Не доказывает верхней границы на любом входе и других размерах.`;
  const record = {
    id,
    repositoryId: repo.id,
    sha,
    command: input.command,
    seed: input.seed,
    sizes: input.sizes,
    timeoutMs: input.timeoutMs,
    question: input.question,
    results,
    outcome,
    limits,
    environment: {
      platform: platform(),
      arch: arch(),
      node: process.version,
      cpus: cpus().length,
      isolation: h.config.isolation.mode,
    },
    at: new Date().toISOString(),
  } satisfies Omit<Spike, 'digest'>;
  const spike: Spike = { ...record, digest: digest(record) };
  h.store.atomic(() => h.store.saveLocal(KIND, repo.id, id, spike));
  return spike;
}
