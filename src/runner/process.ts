import { spawn } from 'node:child_process';
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
export async function command(
  argv: string[],
  cwd: string,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    input?: string;
    env?: NodeJS.ProcessEnv;
    redact?: (text: string) => string;
  } = {},
): Promise<CommandResult> {
  if (!argv.length) throw new Error('Пустая команда');
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: options.env ?? process.env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      timedOut = false,
      killTimer: NodeJS.Timeout | undefined;
    const append = (current: string, data: Buffer) => (current + data.toString()).slice(-2_000_000);
    child.stdout.on('data', (d) => {
      stdout = append(stdout, d);
    });
    child.stderr.on('data', (d) => {
      stderr = append(stderr, d);
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
      signalGroup('SIGTERM');
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
    child.once('close', (code) => {
      if (code !== 0 || options.signal?.aborted || timedOut) signalGroup('SIGKILL');
      cleanup();
      resolve({
        code: code ?? -1,
        stdout: options.redact ? options.redact(stdout) : stdout,
        stderr: options.redact ? options.redact(stderr) : stderr,
        timedOut,
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
    if (options.signal?.aborted) stop();
  });
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
