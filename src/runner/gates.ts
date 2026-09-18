import { timed } from './timing.ts';
import { runEnvironment, assertDependencies } from './dependencies.ts';
import { readFile, writeFile, mkdir, rm, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { command, git } from './process.ts';
import { digest, DevContour } from '../core/service.ts';
import type { Run, Gate, Evidence } from '../core/model.ts';
export function junitSummary(xml: string): { tests: number; failures: number; skipped: number } {
  if (xml.includes('<!DOCTYPE') || XMLValidator.validate(xml) !== true)
    throw new Error('Некорректный JUnit XML');
  const document = new XMLParser({ ignoreAttributes: false, processEntities: false }).parse(xml);
  const summary = { tests: 0, failures: 0, skipped: 0 };
  function visit(value: unknown, key = '') {
    if (Array.isArray(value)) {
      value.forEach((v) => visit(v, key));
      return;
    }
    if (key === 'testcase') {
      summary.tests++;
      if (value && typeof value === 'object') {
        if ('failure' in value || 'error' in value) summary.failures++;
        if ('skipped' in value) summary.skipped++;
      }
      return;
    }
    if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, k);
  }
  visit(document);
  if (!summary.tests) throw new Error('JUnit не содержит выполненных testcases');
  return summary;
}
export async function runGate(...args: Parameters<typeof executeGate>) {
  return timed(args[0], args[1], `${args[4]}-test:${args[5].id}`, () => executeGate(...args));
}
async function executeGate(
  h: DevContour,
  run: Run,
  cwd: string,
  sha: string,
  phase: Evidence['phase'],
  gate: Gate,
  artifactDir: string,
  signal: AbortSignal,
) {
  const gateCwd = gate.cwd ? await realpath(resolve(cwd, gate.cwd)) : await realpath(cwd);
  if (gateCwd !== (await realpath(cwd)) && !gateCwd.startsWith((await realpath(cwd)) + sep))
    throw new Error('Gate cwd выходит из worktree');
  const reportPath = gate.report ? resolve(cwd, gate.report.path) : undefined;
  if (reportPath) {
    await mkdir(join(reportPath, '..'), { recursive: true });
    const parent = await realpath(join(reportPath, '..'));
    if (!parent.startsWith((await realpath(cwd)) + sep))
      throw new Error('Report выходит из worktree');
    await rm(reportPath, { force: true });
  }
  let passed = false,
    summary = '',
    log = '',
    exitCode = -1;
  try {
    const result = await command(gate.command, gateCwd, {
      signal,
      timeoutMs: gate.timeoutMs,
      env: { ...runEnvironment(h.config, run, phase, cwd).env, DEVCONTOUR_REPORT_PATH: reportPath },
      redact: runEnvironment(h.config, run, phase, cwd).redact,
    });
    exitCode = result.code;
    log = result.stdout + '\n' + result.stderr;
    if (result.timedOut || signal.aborted)
      throw new Error('Проверка прервана или превысила timeout');
    if (result.code !== 0) throw new Error(`Код выхода ${result.code}`);
    if (reportPath) {
      const real = await realpath(reportPath);
      if (!real.startsWith((await realpath(cwd)) + sep))
        throw new Error('Report symlink выходит из worktree');
      const xml = await readFile(real, 'utf8');
      const counts = junitSummary(xml);
      summary = `${counts.tests} tests, ${counts.failures} failures, ${counts.skipped} skipped`;
      if (counts.failures || counts.skipped) throw new Error(summary);
      await mkdir(artifactDir, { recursive: true });
      await writeFile(join(artifactDir, `${gate.id}.xml`), xml);
    } else summary = 'Команда завершилась успешно';
    await assertDependencies(run.dependencies ?? []);
    if ((await git(cwd, 'rev-parse', 'HEAD')) !== sha) throw new Error('Gate изменил HEAD');
    if (await git(cwd, 'status', '--porcelain', '--untracked-files=no'))
      throw new Error('Gate изменил отслеживаемые файлы');
    passed = true;
  } catch (error) {
    summary = error instanceof Error ? error.message : String(error);
    log += '\n' + summary;
  }
  await mkdir(artifactDir, { recursive: true });
  const logPath = join(artifactDir, `${gate.id}.log`);
  await writeFile(logPath, log);
  h.evidence(run.id, run.token, {
    kind: 'test',
    phase,
    sha,
    gate: gate.id,
    passed,
    command: gate.command,
    exitCode,
    log: logPath,
    digest: digest(log),
    summary,
  });
  if (!passed) throw new Error(`${phase}/${gate.id}: ${summary}`);
}
