import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  contractRedactionsOf,
  currentText,
  latestRedaction,
  supersededBy,
} from '../src/core/service.ts';
import { canonical } from '../src/core/sync-model.ts';
import { syncGit } from '../src/runner/git-sync.ts';
import { fixture, type Peer } from './git-sync-fixture.ts';

const SOURCE = 'docs/contracts/api.md';

/** Файлы записей контрактов в Git компонента. */
function contractFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return contractFiles(path);
    if (!name.endsWith('.json')) return [];
    const value = JSON.parse(readFileSync(path, 'utf8')) as { kind?: string };
    return value.kind === 'contract' ? [path] : [];
  });
}

/**
 * Время утверждения в записях Git — в обратном порядке (часы клонов
 * расходятся): ни ключи (UUID), ни время не дают порядок утверждения.
 */
function skewClocks(p: Peer) {
  const files = contractFiles(join(p.repo, '.devcontour'));
  assert.ok(files.length >= 2, 'записи контрактов в Git');
  for (const path of files) {
    const value = JSON.parse(readFileSync(path, 'utf8')) as {
      data: { content: string; approvedAt: string };
    };
    // Длиннее текст — позже утверждён в этом тесте: время даёт обратный порядок.
    value.data.approvedAt = new Date(
      Date.UTC(2026, 0, 1) - value.data.content.length * 1000,
    ).toISOString();
    writeFileSync(path, canonical(value));
  }
}

test('H2: the order of redactions survives Git sync for an amendment chain and a consolidation (two clones, sorted record keys, skewed clocks)', () => {
  const f = fixture();
  try {
    const a = f.create('alice');
    const register = (content: string, consolidates?: { from: string; review: string }) =>
      a.h.contract('API', content, undefined, 'main', SOURCE, [], undefined, [], consolidates);
    // Шесть редакций: порядок ключей UUID почти наверняка не совпадает с ним.
    const r1 = register('REQ-1.');
    const r2 = register('REQ-1. REQ-2 added in stage 2.');
    const r3 = register('REQ-1. REQ-2 added in stage 2. REQ-3 added in stage 3.');
    const r4 = register('REQ-1. REQ-2 added in stage 2. REQ-3 added in stage 3, REQ-4 in 4.');
    const f5 = register('REQ-1, REQ-2, REQ-3, REQ-4.', { from: r4.id, review: 'R-1' });
    const r6 = register('REQ-1, REQ-2, REQ-3, REQ-4 and REQ-5 added in stage 5 here.');
    const expected = [r1, r2, r3, r4, f5, r6].map((c) => c.id);
    assert.deepEqual(r2.previous, r1.id);
    assert.deepEqual(f5.previous, r4.id);
    syncGit(a.h, { member: 'alice' });
    skewClocks(a);
    a.commit();
    const b = f.create('bob', a);
    syncGit(b.h, { member: 'bob' });
    const contracts = b.store.read().contracts;
    assert.deepEqual(
      contractRedactionsOf(contracts, SOURCE, 'main').map((c) => c.id),
      expected,
    );
    assert.equal(latestRedaction(contracts, SOURCE, 'main')?.id, r6.id);
    // Консолидация равносильна r4; r6 заменяет обе.
    assert.equal(supersededBy(contracts, r4.id)?.id, r6.id);
    assert.equal(supersededBy(contracts, f5.id)?.id, r6.id);
    assert.equal(supersededBy(contracts, r6.id), undefined);
    assert.equal(currentText(contracts, r6.id)?.id, r6.id);
    assert.equal(supersededBy(contracts, r1.id)?.id, r6.id);
  } finally {
    f.cleanup();
  }
});

test('H2: a consolidation keeps its predecessor current after Git sync', () => {
  const f = fixture();
  try {
    const a = f.create('alice');
    const c1 = a.h.contract('API', 'REQ-1. Amendment: REQ-1 changed.', undefined, 'main', SOURCE);
    const c2 = a.h.contract('API', 'REQ-1 changed.', undefined, 'main', SOURCE, [], undefined, [], {
      from: c1.id,
      review: 'R-1',
    });
    syncGit(a.h, { member: 'alice' });
    skewClocks(a);
    a.commit();
    const b = f.create('bob', a);
    syncGit(b.h, { member: 'bob' });
    const contracts = b.store.read().contracts;
    assert.equal(latestRedaction(contracts, SOURCE, 'main')?.id, c2.id);
    assert.equal(supersededBy(contracts, c1.id), undefined);
    assert.equal(currentText(contracts, c1.id)?.id, c2.id);
  } finally {
    f.cleanup();
  }
});
