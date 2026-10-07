// Обезличенный стенд для браузерной проверки карточки договора проверки:
// настоящий Git, runner и корпус; модели — детерминированные адаптеры.
// Задача дважды отказала по свойству и ждёт разбора ведущего; в корпусе 25
// подтверждённых случаев — больше одной страницы карточки.
import { serve } from '../../src/server/http.ts';
import { submitCase } from '../../src/runner/checks.ts';
import { CheckCorpus } from '../../src/core/check-store.ts';
import {
  check,
  checkProject,
  fixture,
  knap,
  rejection,
  removeRoot,
} from '../../tests/check-fixture.ts';

const port = Number(process.argv[2] ?? 4398);
const zero = (v: number) => JSON.stringify({ items: [{ w: 0, v }], cap: 0 });
const p = await checkProject({ 'check.mjs': check(120, { zeroWeights: false }) });
const f = await fixture(p, {
  config: { approvalMode: 'operator' },
  reviewer: (_r, calls) =>
    calls.review === 1
      ? rejection({ property: 'knapsack-optimal', input: zero(5), expected: '5', actual: '0' })
      : undefined,
});
f.write('src/knap.mjs', knap.zeroWeight);
const board = f.h.createBoard('Рюкзак: договор проверки');
const t = f.h.addTask(board.id, {
  title: 'Оптимальный рюкзак',
  description: 'Оптимум рюкзака на малых входах по договору проверки.',
  role: 'backend',
  contracts: [f.contract!.id],
  acceptance: ['AC-optimal'],
  writePaths: ['src/'],
  properties: ['knapsack-optimal'],
});
f.h.approve(board.id);
f.h.pause(false);
await f.scheduler.drain();
for (let v = 1; v <= 25; v++)
  await submitCase(f.h, p.root, {
    taskId: t.id,
    property: 'knapsack-optimal',
    input: zero(v),
    key: `fixture-case-${v}`,
    origin: 'lead',
  });
// operator mode: принятие корпуса подтверждает оператор (как checks-approve).
const corpus = new CheckCorpus(f.h);
for (const suite of corpus.all())
  for (const pending of suite.pending.filter((x) => x.awaitingOperator))
    corpus.approveAdoption(suite.id, pending.id);
f.h.retry(t.id);
await f.scheduler.drain();
f.h.pause(true);
await f.scheduler.stop();
const app = await serve(f.h, f.scheduler, { port });
console.log(`READY ${app.url} ${t.id}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void app
      .close()
      .then(() => f.close())
      .then(() => removeRoot(p.root))
      .finally(() => process.exit(0));
  });
