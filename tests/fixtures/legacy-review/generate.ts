/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any --
 * Генератор вызывает код прежней версии из другого checkout: его типов здесь
 * нет, модули загружаются по пути во время запуска.
 */
/**
 * Отклонённые ревью контракта и плана прежней версии DevContour (T35, история
 * ревью). Состояние пишет её собственный код (`reviewContract`, `reviewPlan`)
 * с управляемым reviewer, который отклоняет предложение блокирующей находкой.
 *
 *   cd <checkout прежней версии>
 *   node --import tsx <этот файл> <checkout прежней версии> <пустой каталог вывода>
 *
 * В вывод попадают `state.sqlite` и `meta.json` (ID доски и текст находки).
 * Данные вымышленные.
 */
import { copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

type Any = any;
const [baseline, out] = process.argv.slice(2) as [string, string];
const { fixture, input } = await import(join(baseline, 'tests/helpers.ts'));
const { reviewContract, reviewPlan } = await import(join(baseline, 'src/runner/agent-control.ts'));

export const FINDING = 'Legacy finding must survive';
const rejecting = Object.fromEntries(
  ['codex', 'claude'].map((name) => [
    name,
    {
      name,
      execute: () =>
        Promise.resolve({
          data: {
            approved: false,
            summary: 'Needs changes',
            findings: [{ severity: 'blocking', message: FINDING, rule: 'legacy-rule' }],
            previous: [],
            execution: { commands: [], noCommandsReason: 'Read-only analysis' },
          },
          log: 'Controlled adapter',
          command: ['fixture'],
        }),
    },
  ]),
);
const f: Any = fixture();
f.h.config.mode = 'local';
f.h.config.roles = { qa: { runtime: 'codex' } };
f.h.config.reviewer = { runtime: 'claude' };
await reviewContract(
  f.h,
  f.root,
  { title: 'Legacy contract', content: 'Documented API returns the value.' },
  'codex',
  rejecting,
).catch(() => undefined);
const board = f.h.createBoard('Legacy plan');
f.h.addTask(board.id, input('Legacy task'));
await reviewPlan(f.h, f.root, board.id, 'codex', rejecting).catch(() => undefined);
const attempts = f.store.read().contractAttempts;
if (attempts.length !== 2 || attempts.some((a: Any) => a.approved))
  throw new Error('Ожидались два отклонённых ревью');
f.store.close();
copyFileSync(join(f.root, 'state.sqlite'), join(out, 'state.sqlite'));
writeFileSync(
  join(out, 'meta.json'),
  JSON.stringify({ boardId: board.id, finding: FINDING }, null, 2) + '\n',
);
// Хранилище уже закрыто: удаляется только временный каталог fixture прежней версии.
if (basename(f.root).startsWith('devcontour-test-'))
  rmSync(f.root, { recursive: true, force: true });
console.log('legacy review state written to', out);
