import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createScratch, removeScratch } from '../scripts/test-scratch.mjs';
import { testEnvironment } from '../scripts/test-environment.mjs';

const prefix = 'dr-';
const quiet = () => undefined;

test('Run directories are unique, sit directly under the system one and are removed', () => {
  const [a, b] = [createScratch(prefix), createScratch(prefix)];
  assert.notEqual(a, b);
  assert.equal(dirname(a), tmpdir().replace(/\/$/, ''), 'keeps the system spelling of the path');
  writeFileSync(join(a, 'left-behind'), 'x');
  assert.equal(removeScratch(a, prefix), true);
  assert.equal(existsSync(a), false);
  assert.equal(existsSync(b), true, 'another run is untouched');
  assert.equal(removeScratch(b, prefix), true);
});

test('Run cleanup cannot touch the parent or anything but a run directory', () => {
  const marker = mkdtempSync(join(tmpdir(), 'not-a-run-'));
  try {
    assert.equal(removeScratch(tmpdir(), prefix, quiet), false, 'the parent');
    assert.equal(removeScratch(marker, prefix, quiet), false, 'a sibling without the prefix');
    const run = createScratch(prefix);
    assert.equal(removeScratch(join(run, '..'), prefix, quiet), false, 'a path into the parent');
    assert.equal(removeScratch(run, prefix), true);
    assert.equal(existsSync(marker), true);
    assert.equal(existsSync(tmpdir()), true);
  } finally {
    rmSync(marker, { recursive: true, force: true });
  }
});

test('A leftover that cannot be removed warns instead of failing the run', () => {
  const run = createScratch(prefix);
  const closed = join(run, 'closed');
  mkdirSync(closed);
  writeFileSync(join(closed, 'file'), 'x');
  chmodSync(closed, 0);
  const warnings: string[] = [];
  try {
    assert.equal(
      removeScratch(run, prefix, (text: string) => warnings.push(text)),
      false,
    );
    assert.match(warnings[0], /not removed/);
  } finally {
    chmodSync(closed, 0o755);
    assert.equal(removeScratch(run, prefix), true);
  }
});

test('The test environment gives a run its own TMPDIR and survives a leftover it cannot remove', () => {
  const environment = testEnvironment();
  const scratch = environment.env.TMPDIR!;
  assert.equal(dirname(scratch), tmpdir().replace(/\/$/, ''));
  const closed = join(scratch, 'closed');
  mkdirSync(closed);
  writeFileSync(join(closed, 'file'), 'x');
  chmodSync(closed, 0);
  const warn = console.error;
  console.error = quiet;
  try {
    environment.cleanup();
  } finally {
    console.error = warn;
    chmodSync(closed, 0o755);
    assert.equal(removeScratch(scratch, prefix), true);
  }
});
