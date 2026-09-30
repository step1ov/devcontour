import { appendFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import type { Config } from '../core/model.ts';
import { redactor } from './redaction.ts';
import { runCheck } from './gates.ts';
import { probeServer, probeTool } from './tools.ts';

/**
 * Пробные проверки ревьюера под пределами контура.
 *
 * Ревьюер, запускавший проверки своим shell, зависал на проверяемом коде: срок
 * команды задавал сам CLI модели, и одна зависшая команда съедала весь срок
 * ревью — готовый кандидат падал без вердикта. Здесь срок задаёт контур:
 * команда исполняется тем же исполнителем, что и гейты (песочница ОС,
 * исходники только для чтения, уборка потомков), с пределом на команду,
 * общим бюджетом проверок и резервом времени на заключение. Превышение —
 * результат, который получает модель, а не зависание.
 */
export const probeSpec = z.object({
  cwd: z.string().min(1),
  /** Закрытое проверке и открытое на чтение — граница ревьюера. */
  controller: z.array(z.string()),
  readable: z.array(z.string()),
  isolation: z.object({ mode: z.enum(['os', 'none']), domains: z.array(z.string()) }),
  commandTimeoutMs: z.number().int().min(1000),
  budgetMs: z.number().int().min(1000),
  /** Момент, к которому ревью должно быть готово дать заключение (epoch ms). */
  deadline: z.number().int(),
  /** Переменные окружения, передаваемые по имени; значения на диск не пишутся. */
  env: z.array(z.string()),
  secrets: z.array(z.string()),
  settingsDir: z.string().min(1),
  log: z.string().min(1),
});
export type ProbeSpec = z.infer<typeof probeSpec>;

export const probeInput = z.object({
  argv: z.array(z.string().min(1)).min(1).max(64),
  timeoutMs: z.number().int().min(1).optional(),
});

export type ProbeResult = {
  argv: string[];
  /**
   * `timeout` — команда не уложилась в предел и остановлена вместе с
   * потомками; это наблюдение о команде на данном входе, а не доказанный
   * дефект. `budget-exhausted` — команда не запускалась: бюджет проверок или
   * время до заключения исчерпаны. `error` — команда не запустилась.
   */
  status: 'passed' | 'failed' | 'timeout' | 'budget-exhausted' | 'error';
  exitCode: number | null;
  durationMs: number;
  limitMs: number;
  budgetLeftMs: number;
  stdout: string;
  stderr: string;
  note?: string;
};

const tail = (text: string) => (text.length > 8000 ? '…' + text.slice(-8000) : text);

export class ReviewProbes {
  private spent = 0;
  constructor(
    readonly spec: ProbeSpec,
    private readonly now = () => Date.now(),
  ) {}
  /** Сколько может длиться следующая команда: меньшее из трёх пределов. */
  limit(requested?: number) {
    return Math.max(
      0,
      Math.min(
        requested ?? this.spec.commandTimeoutMs,
        this.spec.commandTimeoutMs,
        this.spec.budgetMs - this.spent,
        this.spec.deadline - this.now(),
      ),
    );
  }
  async run(input: z.infer<typeof probeInput>, signal = new AbortController().signal) {
    const env = Object.fromEntries(
      this.spec.env.flatMap((name) =>
        process.env[name] === undefined ? [] : [[name, process.env[name]]],
      ),
    ) as NodeJS.ProcessEnv;
    const redact = redactor(
      this.spec.secrets.flatMap((name) => (process.env[name] ? [process.env[name]] : [])),
    );
    const limitMs = this.limit(input.timeoutMs);
    const base = { argv: input.argv, limitMs, stdout: '', stderr: '' };
    let result: ProbeResult;
    // Меньше секунды на команду — это уже не проверка, а гарантированный
    // таймаут: честнее сказать, что время кончилось.
    if (limitMs < 1000)
      result = {
        ...base,
        status: 'budget-exhausted',
        exitCode: null,
        durationMs: 0,
        budgetLeftMs: Math.max(0, this.spec.budgetMs - this.spent),
        note: 'Бюджет проверок ревью или время до заключения исчерпаны; дай заключение по уже собранному.',
      };
    else {
      const started = this.now();
      try {
        const r = await runCheck(
          { config: { isolation: this.spec.isolation } },
          {
            argv: input.argv,
            cwd: this.spec.cwd,
            env: { ...env, CI: '1' },
            redact,
            timeoutMs: limitMs,
            signal,
            // Проверяемые исходники — только чтение; пишет проверка во
            // временный каталог, который runCheck создаёт и убирает сам.
            write: [],
            readable: this.spec.readable,
            controller: this.spec.controller,
            settingsDir: this.spec.settingsDir,
          },
        );
        const durationMs = this.now() - started;
        this.spent += durationMs;
        result = {
          ...base,
          status: r.timedOut ? 'timeout' : r.code === 0 ? 'passed' : 'failed',
          exitCode: r.timedOut ? null : r.code,
          durationMs,
          budgetLeftMs: Math.max(0, this.spec.budgetMs - this.spent),
          stdout: tail(r.stdout),
          stderr: tail(r.stderr),
          ...(r.timedOut
            ? {
                note: `Команда не завершилась за ${limitMs} мс и остановлена вместе с потомками. Это наблюдение о команде на этом входе, а не доказанный дефект: назови вход и предел, если делаешь из него замечание.`,
              }
            : {}),
        };
      } catch (error) {
        const durationMs = this.now() - started;
        this.spent += durationMs;
        result = {
          ...base,
          status: 'error',
          exitCode: null,
          durationMs,
          budgetLeftMs: Math.max(0, this.spec.budgetMs - this.spent),
          note:
            'Команда не запустилась — это отказ среды, а не результат проверки: ' +
            redact(error instanceof Error ? error.message : String(error)),
        };
      }
    }
    // Журнал — наблюдение контура, а не самоотчёт модели.
    await appendFile(
      this.spec.log,
      JSON.stringify({ at: new Date().toISOString(), ...result }) + '\n',
    ).catch(() => undefined);
    return result;
  }
}

/** Stdio MCP-сервер с одним инструментом — его запускает CLI ревьюера. */
export async function serveReviewProbes(specPath: string) {
  const probes = new ReviewProbes(probeSpec.parse(JSON.parse(await readFile(specPath, 'utf8'))));
  const server = new McpServer({ name: probeServer, version: '1' });
  server.registerTool<StandardSchemaWithJSON, StandardSchemaWithJSON>(
    probeTool,
    {
      description: `Run a check command (argv, no shell) in the candidate's directory with read-only sources. The controller stops it after ${probes.spec.commandTimeoutMs} ms per command and a total probe budget of ${probes.spec.budgetMs} ms; a timeout is returned as a result.`,
      inputSchema: probeInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input: unknown) => {
      const result = await probes.run(probeInput.parse(input));
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );
  await server.connect(new StdioServerTransport(process.stdin, process.stdout));
  return server;
}

/** Пределы проверок ревью, выведенные из срока фазы. */
export function probeLimits(config: Pick<Config, 'runTimeoutMs' | 'reviewProbes'>) {
  const reserveMs = Math.max(config.reviewProbes.reserveMs, Math.round(config.runTimeoutMs * 0.2));
  return {
    commandTimeoutMs: Math.min(config.reviewProbes.commandTimeoutMs, config.runTimeoutMs),
    budgetMs: Math.max(
      1000,
      Math.min(config.reviewProbes.budgetMs, config.runTimeoutMs - reserveMs),
    ),
    reserveMs,
  };
}

/**
 * Команда, которой CLI ревьюера запускает сервер проверок: этот же DevContour.
 * CLI ревьюера стартует её из проверяемого каталога, поэтому загрузчик
 * исходников указан абсолютным путём — из worktree он бы не разрешился.
 */
export function probeCommand(specPath: string) {
  const source = import.meta.url.endsWith('.ts');
  const cli = fileURLToPath(new URL(source ? '../cli.ts' : '../cli.js', import.meta.url));
  return {
    command: process.execPath,
    args: [
      ...(source ? ['--import', import.meta.resolve('tsx')] : []),
      cli,
      'review-probe',
      '--spec',
      specPath,
    ],
  };
}
