import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { outputRedactor, type Redactor } from './redaction.ts';
import type { RuntimeDiagnostics } from '../core/runtime-diagnostics.ts';
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  diagnostics: RuntimeDiagnostics;
}
export async function command(
  argv: string[],
  cwd: string,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    input?: string;
    env?: NodeJS.ProcessEnv;
    redact?: Redactor;
    onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
    /**
     * Владеть всеми потомками, включая сменивших группу или сессию: после
     * завершения они останавливаются, и результат не возвращается, пока
     * хотя бы один жив. Сигнал группе не достаёт отсоединившегося потомка.
     */
    contain?: boolean;
  } = {},
): Promise<CommandResult> {
  if (!argv.length) throw new Error('Пустая команда');
  return new Promise((resolve, reject) => {
    const startedAt = new Date().toISOString();
    let lastOutputAt: string | null = null;
    let processTree: RuntimeDiagnostics['processTree'];
    // Метку окружения наследуют все потомки, в том числе отсоединившиеся:
    // по ней их находят после завершения.
    const mark = options.contain ? randomUUID() : undefined;
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: mark
        ? { ...(options.env ?? process.env), DEVCONTOUR_PROCESS_MARK: mark }
        : (options.env ?? process.env),
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      timedOut = false,
      killTimer: NodeJS.Timeout | undefined;
    const stdoutDecoder = new StringDecoder('utf8'),
      stderrDecoder = new StringDecoder('utf8');
    const maskOut = outputRedactor(options.redact),
      maskErr = outputRedactor(options.redact);
    let outputError: Error | undefined;
    const append = (stream: 'stdout' | 'stderr', text: string) => {
      if (!text) return;
      if (stream === 'stdout') stdout = (stdout + text).slice(-2_000_000);
      else stderr = (stderr + text).slice(-2_000_000);
      try {
        options.onOutput?.(stream, text);
      } catch (error) {
        outputError = error instanceof Error ? error : new Error(String(error));
        stop();
      }
    };
    child.stdout.on('data', (d: Buffer) => {
      lastOutputAt = new Date().toISOString();
      append('stdout', maskOut(stdoutDecoder.write(d)));
    });
    child.stderr.on('data', (d: Buffer) => {
      lastOutputAt = new Date().toISOString();
      append('stderr', maskErr(stderrDecoder.write(d)));
    });
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* Process already exited. */
      }
    };
    const stop = () => {
      processTree ??= captureProcessTree(child.pid);
      signalGroup('SIGTERM');
      if (killTimer) return;
      killTimer = setTimeout(() => signalGroup('SIGKILL'), 1000);
      killTimer.unref();
    };
    const abort = () => stop();
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs ?? 120000);
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
    };
    child.once('error', (e) => {
      cleanup();
      reject(e);
    });
    child.once('close', async (code, signal) => {
      if (code !== 0 || options.signal?.aborted || timedOut) signalGroup('SIGKILL');
      cleanup();
      const survivors = mark ? await sweep(mark) : [];
      if (survivors.length) {
        reject(
          new Error(
            `Не удалось завершить процессы проверки: ${survivors.join(', ')}. Ресурсы не освобождены`,
          ),
        );
        return;
      }
      append('stdout', maskOut(stdoutDecoder.end(), true));
      append('stderr', maskErr(stderrDecoder.end(), true));
      if (outputError) {
        reject(outputError);
        return;
      }
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
        timedOut,
        diagnostics: {
          startedAt,
          finishedAt: new Date().toISOString(),
          lastOutputAt,
          exitCode: code,
          signal,
          timedOut,
          aborted: Boolean(options.signal?.aborted),
          stdoutTail: stdout.slice(-4000),
          stderrTail: stderr.slice(-4000),
          processTree,
        },
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
    if (options.signal?.aborted) stop();
  });
}
function captureProcessTree(pid?: number): RuntimeDiagnostics['processTree'] {
  if (!pid || process.platform === 'win32')
    return {
      available: false,
      reason: 'Process inventory unavailable on this platform',
      processes: [],
    };
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,comm='], {
    encoding: 'utf8',
    timeout: 250,
    maxBuffer: 1_000_000,
  });
  if (result.status !== 0)
    return { available: false, reason: 'OS denied or timed out process inventory', processes: [] };
  const rows = result.stdout.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return m
      ? [
          {
            pid: Number(m[1]),
            parentPid: Number(m[2]),
            groupPid: Number(m[3]),
            name: m[4].split('/').at(-1)!,
          },
        ]
      : [];
  });
  const ids = new Set([pid]);
  for (let size = -1; size !== ids.size;) {
    size = ids.size;
    for (const row of rows) if (ids.has(row.parentPid) || row.groupPid === pid) ids.add(row.pid);
  }
  return { available: true, processes: rows.filter((r) => ids.has(r.pid)).slice(0, 100) };
}
export async function git(cwd: string, ...args: string[]) {
  const result = await command(['git', ...args], cwd, {
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'DevContour',
      GIT_AUTHOR_EMAIL: 'devcontour@localhost',
      GIT_COMMITTER_NAME: 'DevContour',
      GIT_COMMITTER_EMAIL: 'devcontour@localhost',
    },
  });
  if (result.code !== 0)
    throw new Error(`git ${args[0]}: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout.trim();
}

/** Процессы пользователя, в окружении которых есть метка. */
function marked(mark: string): number[] {
  const needle = `DEVCONTOUR_PROCESS_MARK=${mark}`;
  if (process.platform === 'linux') {
    return readdirSync('/proc').flatMap((entry) => {
      if (!/^\d+$/.test(entry)) return [];
      try {
        return readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').includes(needle)
          ? [Number(entry)]
          : [];
      } catch {
        return [];
      }
    });
  }
  // macOS: -E добавляет окружение к команде для процессов своего пользователя.
  const result = spawnSync('ps', ['-Eww', '-ax', '-o', 'pid=,command='], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 64_000_000,
  });
  if (result.status !== 0) throw new Error('Не удалось перечислить процессы проверки');
  return result.stdout.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    return m && m[2].includes(needle) && Number(m[1]) !== process.pid ? [Number(m[1])] : [];
  });
}
/** Остановить всех помеченных потомков; вернуть тех, кто пережил попытки. */
async function sweep(mark: string): Promise<number[]> {
  let left: number[] = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      left = marked(mark);
    } catch {
      return [-1];
    }
    if (!left.length) return [];
    for (const pid of left)
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* Already gone. */
      }
    await new Promise((r) => setTimeout(r, 100));
  }
  return left;
}
