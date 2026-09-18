import { mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { Config } from '../core/model.ts';
import type { Environment, Lifecycle, Step } from '../core/integrations.ts';
import { CleanupFailure } from '../core/integrations.ts';
import { processAlive } from './resources.ts';
import { digest } from '../core/service.ts';
import { command } from './process.ts';

export function executionEnvironment(
  profiles: (Environment | undefined)[],
  devcontour: NodeJS.ProcessEnv = {},
  source = process.env,
) {
  const env: NodeJS.ProcessEnv = {
    PATH: source.PATH,
    HOME: source.HOME,
    TMPDIR: source.TMPDIR,
    CI: '1',
  };
  const secretValues: string[] = [];
  for (const profile of profiles) {
    if (!profile) continue;
    for (const key of profile.inherit) {
      if (source[key] === undefined) throw new Error(`Не задана переменная окружения: ${key}`);
      env[key] = source[key];
      // Inherited values are also redacted: callers need not classify every provider token.
      if (source[key]) secretValues.push(source[key]);
    }
    Object.assign(env, profile.values);
    for (const [key, from] of Object.entries(profile.secrets)) {
      if (!source[from]) throw new Error(`Не задан секрет окружения: ${from} (для ${key})`);
      env[key] = source[from];
      secretValues.push(source[from]);
    }
  }
  Object.assign(env, devcontour);
  return { env, redact: redactor(secretValues) };
}
export function redactor(values: string[]) {
  const secrets = [
    ...new Set(values.filter(Boolean).flatMap((s) => [s, encodeURIComponent(s)])),
  ].sort((a, b) => b.length - a.length);
  return (text: string) =>
    secrets.reduce((result, secret) => result.split(secret).join('[REDACTED]'), text);
}
export async function runSteps(
  steps: Step[],
  cwd: string,
  dir: string,
  execution: ReturnType<typeof executionEnvironment>,
  signal: AbortSignal,
) {
  await mkdir(dir, { recursive: true });
  for (const step of steps) {
    signal.throwIfAborted();
    const result = await command(step.command, cwd, {
      signal,
      timeoutMs: step.timeoutMs,
      env: execution.env,
      redact: execution.redact,
    });
    await writeFile(join(dir, step.id + '.log'), result.stdout + '\n' + result.stderr);
    if (result.code || result.timedOut || signal.aborted)
      throw new Error(`Шаг ${step.id}: exit=${result.code}; timeout=${result.timedOut}`);
  }
}

// Teardown uses a fresh deadline: cancellation must not cancel cleanup itself.
// The receipt is retained after crashes and can be explicitly resumed with environment-cleanup.
export async function withEnvironment<T>(
  lifecycle: Lifecycle | undefined,
  cwd: string,
  dir: string,
  execution: ReturnType<typeof executionEnvironment>,
  signal: AbortSignal,
  action: () => Promise<T>,
  measure: <R>(stage: string, action: () => Promise<R>) => Promise<R> = (_stage, action) =>
    action(),
): Promise<T> {
  if (!lifecycle) return action();
  await mkdir(dir, { recursive: true });
  const receiptPath = join(dir, 'environment.json');
  const receipt = {
    version: 1,
    ownerPid: process.pid,
    devcontourEnv: Object.fromEntries(
      Object.entries(execution.env).filter(([key]) => key.startsWith('DEVCONTOUR_')),
    ),
    cwd,
    lifecycle,
    policyDigest: digest(lifecycle),
    status: 'active',
    startedAt: new Date().toISOString(),
    runId: execution.env.DEVCONTOUR_RUN_ID,
  };
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  let result: T | undefined, failure: Error | undefined;
  try {
    await measure('setup', () =>
      runSteps(lifecycle.setup, cwd, join(dir, 'setup'), execution, signal),
    );
    await measure('ready', () =>
      runSteps(lifecycle.ready, cwd, join(dir, 'ready'), execution, signal),
    );
    result = await action();
  } catch (error) {
    // A thrown undefined/false must still fail the attempt after cleanup.
    failure =
      error instanceof Error
        ? error
        : new Error('Операция окружения завершилась ошибкой', { cause: error });
  }
  try {
    await measure('cleanup', () => teardown(lifecycle, cwd, dir, execution));
    receipt.status = 'cleaned';
  } catch (error) {
    receipt.status = 'cleanup-failed';
    failure = new CleanupFailure(
      `${failure instanceof Error ? failure.message + '; ' : ''}Очистка окружения не завершена: ${error instanceof Error ? error.message : error}`,
    );
  }
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  if (failure) throw failure;
  return result as T;
}
async function teardown(
  lifecycle: Lifecycle,
  cwd: string,
  dir: string,
  execution: ReturnType<typeof executionEnvironment>,
) {
  const failures: string[] = [];
  for (const step of lifecycle.teardown) {
    try {
      await runSteps(
        [step],
        cwd,
        join(dir, 'teardown'),
        execution,
        AbortSignal.timeout(step.timeoutMs + 2000),
      );
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (failures.length) throw new Error(failures.join('; '));
}
export async function cleanupEnvironment(
  receiptPath: string,
  config: Config,
  allowedRoots: string[],
) {
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  const cwd = await realpath(receipt.cwd);
  if (!allowedRoots.some((root) => cwd.startsWith(root + sep)))
    throw new Error('Окружение находится вне рабочих каталогов выбранного workspace');
  const repositoryId = receipt.devcontourEnv?.DEVCONTOUR_REPOSITORY_ID;
  const repo = repositoryId ? config.repositories.find((r) => r.id === repositoryId) : undefined;
  if (repositoryId && !repo && repositoryId !== 'main')
    throw new Error('Неизвестный компонент сохранённого окружения');
  const candidates = (
    repositoryId
      ? [repo?.lifecycle ?? config.lifecycle]
      : [config.workspaceLifecycle, config.lifecycle]
  ).filter(Boolean);
  const lifecycle = candidates.find((l) => digest(l) === receipt.policyDigest);
  if (!lifecycle)
    throw new Error('Политика очистки изменилась; сверьте сохранённое окружение вручную');
  if (receipt.status === 'cleaned') return { status: 'already-cleaned' };
  if (receipt.ownerPid && processAlive(receipt.ownerPid))
    throw new Error('Процесс владельца окружения ещё существует; сначала остановите его');
  const execution = executionEnvironment([config.environment, repo?.environment], {
    ...receipt.devcontourEnv,
    DEVCONTOUR_RUN_ID: receipt.runId,
  });
  await teardown(lifecycle, cwd, join(receiptPath, '..'), execution);
  await writeFile(receiptPath, JSON.stringify({ ...receipt, status: 'cleaned' }, null, 2));
  return { status: 'cleaned' };
}
