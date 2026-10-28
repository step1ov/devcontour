import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, type Config } from '../src/core/model.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
/**
 * Корень рабочих деревьев теста — свой временный каталог, а не кэш
 * пользователя. Внутри каталога данных фикстуры его держать нельзя: harness
 * отклоняет корень внутри каталога состояния. Убирается при завершении
 * процесса (и раньше — `cleanup` фикстуры); удаляются только каталоги,
 * созданные здесь.
 */
const testCheckoutRoots = new Set<string>();
let removeOnExit = false;
export function testCheckoutRoot() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-test-checkouts-')));
  testCheckoutRoots.add(dir);
  if (!removeOnExit) {
    removeOnExit = true;
    process.once('exit', () => {
      for (const d of testCheckoutRoots) rmSync(d, { recursive: true, force: true });
    });
  }
  return dir;
}
export function removeTestCheckoutRoot(dir: string) {
  if (!testCheckoutRoots.delete(dir)) return;
  rmSync(dir, { recursive: true, force: true });
}
export const config = (overrides: Partial<Config> = {}): Config =>
  configSchema.parse({
    version: 1,
    name: 'Test',
    repository: '/tmp',
    mode: 'demo',
    concurrency: 2,
    roles: {
      architect: { runtime: 'demo' },
      backend: { runtime: 'demo' },
      frontend: { runtime: 'demo' },
      qa: { runtime: 'demo' },
    },
    reviewer: { runtime: 'demo' },
    gates: [
      {
        id: 'test',
        kind: 'test',
        command: ['node', 'verify.mjs'],
        report: { type: 'junit', path: '.reports/junit.xml' },
      },
    ],
    ...overrides,
  });
export const input = (title = 'Example task', dependsOn: string[] = []) => ({
  title,
  description: 'An observable independent outcome.',
  role: 'qa',
  dependsOn,
  acceptance: ['The expected result is checked.'],
});
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devcontour-test-'));
  const store = new Store(join(root, 'state.sqlite'));
  // Рабочие деревья — в своём временном каталоге, а не в кэше пользователя.
  const checkouts = testCheckoutRoot();
  const h = new DevContour(store, config({ checkoutRoot: checkouts }));
  return {
    root,
    store,
    h,
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
      removeTestCheckoutRoot(checkouts);
    },
  };
}
/**
 * Довести задачу до принятого результата.
 *
 * `tests` задаёт манифест выполненных testcases: без него проверка
 * сообщает только «прошла», и критерий с названным тестом подтвердить
 * нечем — это и есть разница уровней доказательства.
 */
/** SHA кандидата и интеграции в тестовых записях: движок принимает только полные SHA. */
export const CANDIDATE = 'c'.repeat(40);
export const MERGED = 'b'.repeat(40);
const FIXTURE_DIGEST = 'e'.repeat(64);

/**
 * Повторное утверждение открытых досок после правки политики в тесте (D43):
 * утверждение закрепляет политику, и задачи, утверждённые до правки, иначе
 * не выдаются. Так тест меняет gate или окружение до запуска очереди.
 */
export function reapprove(h: DevContour) {
  const s = h.store.read();
  for (const b of s.boards) {
    const r = b.revisions.at(-1);
    if (
      r?.status === 'active' &&
      s.tasks.some((t) => r.taskIds.includes(t.id) && h.approvalStale(t))
    )
      h.approve(b.id);
  }
}
export function complete(
  h: DevContour,
  id: string,
  tests?: { id: string; status: 'passed' | 'failed' | 'skipped' }[],
) {
  h.pause(false);
  // Выдаёт действующий controller: тест, уже выдававший попытки своим
  // владельцем, продолжает под ним.
  const leader = h.store.read().leader;
  const run = h.claim(leader && leader.leaseUntil > Date.now() ? leader.owner : 'test')!;
  if (run?.taskId !== id) throw new Error('Wrong claim');
  h.phase(run.id, run.token, 'integrating', {
    candidateSha: CANDIDATE,
    integrationSha: MERGED,
  });
  for (const phase of ['candidate', 'integration'] as const) {
    const sha = phase === 'candidate' ? CANDIDATE : MERGED;
    for (const kind of ['test', 'review'] as const)
      h.evidence(run.id, run.token, {
        kind,
        phase,
        sha,
        gate: kind === 'test' ? 'test' : 'independent-review',
        passed: true,
        command: ['fixture'],
        exitCode: 0,
        log: 'fixture',
        digest: FIXTURE_DIGEST,
        summary: 'Unit-test fixture',
        tests: kind === 'test' ? tests : undefined,
      });
  }
  // Настоящий прогон записывает и закрепление источника требований; без него
  // приёмка задачи с требованиями отказывает раньше проверки доказательства.
  if (h.store.read().tasks.find((t) => t.id === id)?.requirements?.length)
    for (const phase of ['candidate', 'integration'] as const)
      h.evidence(run.id, run.token, {
        kind: 'test',
        phase,
        sha: phase === 'candidate' ? CANDIDATE : MERGED,
        gate: 'requirement-source',
        passed: true,
        command: ['fixture'],
        exitCode: 0,
        log: '',
        digest: FIXTURE_DIGEST,
        summary: 'Pinned requirement sections match',
      });
  h.finish(run.id, run.token, MERGED);
  return run;
}

/**
 * Прежние открытые находки из запроса технического ревью (протокол harness:
 * reviewer называет состояние каждой). Fixture, одобряющий исправленный
 * предмет, закрывает их с основанием.
 */
export function closePrevious(prompt: string, basis = 'исправлено в этой редакции') {
  const line = prompt.split('\n\n').find((p) => p.startsWith('Previous open findings.'));
  const ids = [...(line ?? '').matchAll(/"id":"([a-f0-9]{64})"/g)].map((m) => m[1]);
  return ids.map((id) => ({ id, status: 'closed' as const, basis }));
}

/**
 * Состояние прежних открытых находок для fixture, который решает раунд целиком:
 * одобряя — закрывает их с основанием, отклоняя — оставляет открытыми.
 */
export function statePrevious(prompt: string, approved: boolean) {
  return closePrevious(prompt).map((t) =>
    approved ? t : { ...t, status: 'open' as const, basis: 'не исправлено в этой редакции' },
  );
}
