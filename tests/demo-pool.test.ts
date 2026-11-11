import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { demoPool } from './demo-pool.ts';

test('A pooled demo slot is reset between borrowers, the data and the worktree root alike', async () => {
  let prepared = 0;
  const pool = demoPool((root, checkoutRoot) => {
    prepared++;
    mkdirSync(root);
    writeFileSync(join(root, 'seed'), 'seed data');
    writeFileSync(join(checkoutRoot, 'seed-worktree'), 'seed checkout');
    return Promise.resolve();
  });
  const first = await pool.acquire();
  // The worktree root is the slot's `checkouts` beside the data.
  const checkouts = join(dirname(first.root), 'checkouts');
  writeFileSync(join(first.root, 'seed'), 'changed by the first borrower');
  writeFileSync(join(first.root, 'borrower'), '1');
  writeFileSync(join(checkouts, 'seed-worktree'), 'changed by the first borrower');
  mkdirSync(join(checkouts, 'borrower-worktree'));
  first.release();
  assert.equal(existsSync(first.root), false, 'release removes the modified data');
  assert.equal(existsSync(checkouts), false, 'release removes the modified worktree root');

  const second = await pool.acquire();
  assert.equal(second.root, first.root, 'the free slot is reused at the same path');
  assert.equal(prepared, 1, 'the seed is prepared once');
  assert.equal(readFileSync(join(second.root, 'seed'), 'utf8'), 'seed data');
  assert.equal(existsSync(join(second.root, 'borrower')), false);
  assert.equal(readFileSync(join(checkouts, 'seed-worktree'), 'utf8'), 'seed checkout');
  assert.equal(existsSync(join(checkouts, 'borrower-worktree')), false);

  // A simultaneous borrower gets a slot of its own.
  const third = await pool.acquire();
  assert.notEqual(dirname(third.root), dirname(second.root));
  assert.equal(prepared, 2);
  second.release();
  third.release();
  pool.close();
  assert.equal(existsSync(dirname(second.root)), false, 'close removes every slot');
  assert.equal(existsSync(dirname(third.root)), false, 'close removes every slot');
});
