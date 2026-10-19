import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Process-local snapshots of a stopped demo. Restore each slot at its original
 * absolute path: Git worktree pointers and evidence/configuration digests must
 * not be rewritten. Simultaneous borrowers have separate roots and snapshots.
 * Call release only after all schedulers and database connections are closed.
 */
export function demoPool(prepare: (root: string) => Promise<unknown>) {
  const slots: { base: string; root: string; snapshot: string; used: boolean }[] = [];
  return {
    async acquire() {
      let slot = slots.find((s) => !s.used);
      if (slot) {
        slot.used = true;
        rmSync(slot.root, { recursive: true, force: true });
        cpSync(slot.snapshot, slot.root, {
          recursive: true,
          preserveTimestamps: true,
          verbatimSymlinks: true,
        });
      } else {
        const base = realpathSync(mkdtempSync(join(tmpdir(), 'devcontour-demo-seed-')));
        slot = { base, root: join(base, 'data'), snapshot: join(base, 'snapshot'), used: true };
        try {
          await prepare(slot.root);
          cpSync(slot.root, slot.snapshot, {
            recursive: true,
            preserveTimestamps: true,
            verbatimSymlinks: true,
          });
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
