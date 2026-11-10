import assert from 'node:assert/strict';
import { constants, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupDemo } from '../src/demo.ts';
import { testCheckoutRoot } from './helpers.ts';

/**
 * Учебный workspace для тестов: рабочие деревья — в своём временном каталоге
 * теста (`testCheckoutRoot`), а не в кэше пользователя. Продуктовый `demo`
 * держит выбор по умолчанию.
 */
export const testDemo = (root: string, checkoutRoot = testCheckoutRoot()) =>
  setupDemo(root, { checkoutRoot });

/**
 * Process-local snapshots of a stopped demo. Restore each slot at its original
 * absolute path: Git worktree pointers and evidence/configuration digests must
 * not be rewritten. Simultaneous borrowers have separate roots and snapshots.
 * The slot's worktree root is the pool's own `checkouts` beside the data and
 * is restored with it, so a borrower never sees the worktrees of the previous
 * one. Call release only after all schedulers and database connections are
 * closed.
 */
export function demoPool(prepare: (root: string, checkoutRoot: string) => Promise<unknown>) {
  const slots: {
    base: string;
    root: string;
    snapshot: string;
    checkouts: string;
    checkoutsSnapshot: string;
    used: boolean;
  }[] = [];
  const copy = (from: string, to: string) =>
    cpSync(from, to, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
  return {
    async acquire() {
      let slot = slots.find((s) => !s.used);
      if (slot) {
        slot.used = true;
        // Both paths are inside the pool's own temporary base.
        for (const [path, snapshot] of [
          [slot.root, slot.snapshot],
          [slot.checkouts, slot.checkoutsSnapshot],
        ]) {
          rmSync(path, { recursive: true, force: true });
          copy(snapshot, path);
        }
      } else {
        const base = realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-demo-seed-')));
        slot = {
          base,
          root: join(base, 'data'),
          snapshot: join(base, 'snapshot'),
          checkouts: join(base, 'checkouts'),
          checkoutsSnapshot: join(base, 'checkouts-snapshot'),
          used: true,
        };
        try {
          mkdirSync(slot.checkouts);
          await prepare(slot.root, slot.checkouts);
          copy(slot.root, slot.snapshot);
          copy(slot.checkouts, slot.checkoutsSnapshot);
          slots.push(slot);
        } catch (error) {
          rmSync(base, { recursive: true, force: true });
          throw error;
        }
      }
      const borrowed = slot;
      let released = false;
      return {
        root: borrowed.root,
        release() {
          assert.equal(released, false, 'demo fixture released twice');
          released = true;
          // Remove the modified copy immediately; only the private seed survives.
          rmSync(borrowed.root, { recursive: true, force: true });
          rmSync(borrowed.checkouts, { recursive: true, force: true });
          borrowed.used = false;
        },
      };
    },
    close() {
      try {
        assert.ok(
          slots.every((s) => !s.used),
          'demo fixture was not released',
        );
      } finally {
        for (const slot of slots) rmSync(slot.base, { recursive: true, force: true });
      }
    },
  };
}
