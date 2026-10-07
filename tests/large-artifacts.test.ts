import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reviewContract } from '../src/runner/agent-control.ts';
import type { AgentAdapter, AgentRequest } from '../src/runner/adapters.ts';
import {
  assertArtifactsInBase,
  blobBytes,
  pinArtifacts,
  verifyArtifacts,
} from '../src/runner/contract-artifacts.ts';
import { configSchema } from '../src/core/model.ts';
import { git } from '../src/runner/process.ts';
import { checkProject, commit, fixture, removeRoot } from './check-fixture.ts';

// Эталонный набор больше прежнего предела текста: 600 КБ строк JSON, в конце
// — маркер, которого нет в выборке.
const corpus = (tail: string) =>
  Array.from(
    { length: 6000 },
    (_, i) =>
      JSON.stringify({ id: i, items: [{ w: i % 7, v: i % 11 }], cap: i % 13 }) + ' '.repeat(40),
  ).join('\n') +
  '\n' +
  tail +
  '\n';

function reviewers(during?: (r: AgentRequest) => Promise<void>) {
  const prompts: string[] = [];
  const make = (name: 'codex' | 'claude'): AgentAdapter => ({
    name,
    async execute(r) {
      prompts.push(r.prompt);
      await during?.(r);
      return {
        data: { approved: true, summary: 'Fixture reviewer', findings: [] },
        log: 'Fixture only',
        command: ['fixture'],
      };
    },
  });
  return { prompts, adapters: { codex: make('codex'), claude: make('claude') } };
}
const declared = [
  { path: 'oracle.mjs', purpose: 'Эталон' },
  { path: 'data/corpus.jsonl', purpose: 'Эталонный набор входов' },
];

test('AC08: a corpus larger than 400000 bytes is pinned by its full digest while the reviewer gets a bounded sample', async () => {
  const p = await checkProject({ 'data/corpus.jsonl': corpus('TAIL-MARKER-8812') });
  const f = await fixture(p, { declaration: false });
  try {
    f.h.config.mode = 'local';
    const bytes = await readFile(join(p.repo, 'data/corpus.jsonl'));
    assert.ok(bytes.length > 400000, `${bytes.length} больше прежнего предела`);
    const r = reviewers();
    const result = await reviewContract(
      f.h,
      p.root,
      { title: 'Knapsack data', content: 'Эталонный набор рюкзака.', artifacts: declared },
      'codex',
      r.adapters,
    );
    assert.equal(result.status, 'approved');
    const contract = f.store.read().contracts[0];
    const pinned = contract.artifacts!.find((a) => a.path === 'data/corpus.jsonl')!;
    assert.equal(pinned.digest, createHash('sha256').update(bytes).digest('hex'));
    // Ревьюер получил манифест и выборку, а не весь файл.
    const prompt = r.prompts[0];
    assert.ok(prompt.length < 420000, `prompt ${prompt.length} в пределах бюджета`);
    assert.equal(prompt.includes('TAIL-MARKER-8812'), false);
    assert.match(prompt, /Выборка, не полное содержимое/);
    assert.ok(prompt.includes(pinned.blob) && prompt.includes(`"bytes": ${bytes.length}`));
    // Полный файл доступен из закреплённого snapshot.
    assert.ok(blobBytes(p.repo, pinned.blob).equals(bytes));
    verifyArtifacts(() => p.repo, [contract]);
    assert.deepEqual(
      await assertArtifactsInBase(p.repo, await git(p.repo, 'rev-parse', 'HEAD'), [pinned]),
      [],
    );
  } finally {
    await f.close();
    await removeRoot(p.root);
  }
});

test('AC09: a byte changed outside the sample, dirty, untracked, symlinked, forged or oversized artifacts are refused; an old review never covers the new file', async () => {
  const p = await checkProject({ 'data/corpus.jsonl': corpus('TAIL-A') });
  const f = await fixture(p, { declaration: false });
  try {
    f.h.config.mode = 'local';
    const repo = { id: 'main', path: p.repo };
    const first = await pinArtifacts(repo, declared, undefined, f.h.config.contractArtifacts);
    // Байт вне выборки: другой digest, повторное ревью обязательно.
    await writeFile(join(p.repo, 'data/corpus.jsonl'), corpus('TAIL-B'));
    await commit(p.repo, 'tail changed');
    const second = await pinArtifacts(repo, declared, undefined, f.h.config.contractArtifacts);
    assert.notEqual(second.artifacts[1].digest, first.artifacts[1].digest);
    assert.deepEqual(
      (second.contents[1] as { sample?: string }).sample,
      (first.contents[1] as { sample?: string }).sample,
      'выборка та же — изменение вне неё',
    );
    const r = reviewers();
    const proposal = { title: 'Knapsack data', content: 'Эталонный набор.', artifacts: declared };
    await reviewContract(f.h, p.root, proposal, 'codex', r.adapters);
    await writeFile(join(p.repo, 'data/corpus.jsonl'), corpus('TAIL-C'));
    await commit(p.repo, 'tail changed again');
    const again = await reviewContract(f.h, p.root, proposal, 'codex', r.adapters);
    assert.equal(again.status, 'approved', 'не «уже утверждено»');
    assert.equal(r.prompts.length, 2);
    assert.equal(f.store.read().contracts.length, 2);

    // Файл изменён во время ревью: одобрение к нему не относится.
    await writeFile(join(p.repo, 'data/corpus.jsonl'), corpus('TAIL-R'));
    await commit(p.repo, 'new revision under review');
    const racing = reviewers(async () => {
      await writeFile(join(p.repo, 'data/corpus.jsonl'), corpus('TAIL-D'));
      await commit(p.repo, 'changed during review');
    });
    await assert.rejects(
      reviewContract(f.h, p.root, proposal, 'codex', racing.adapters),
      /изменились во время ревью/,
    );
    assert.equal(f.store.read().contracts.length, 2);
    assert.equal(racing.prompts.length, 1, 'ревью действительно шло');

    // Незакоммиченная правка, неотслеживаемый файл и symlink.
    await writeFile(join(p.repo, 'data/corpus.jsonl'), corpus('TAIL-DIRTY'));
    await assert.rejects(pinArtifacts(repo, declared), /изменён после коммита/);
    await git(p.repo, 'checkout', '--', 'data/corpus.jsonl');
    await writeFile(join(p.repo, 'data/new.jsonl'), '{}\n');
    await assert.rejects(
      pinArtifacts(repo, [{ path: 'data/new.jsonl', purpose: 'x' }]),
      /не в Git/,
    );
    await symlink('corpus.jsonl', join(p.repo, 'data/link.jsonl'));
    await assert.rejects(
      pinArtifacts(repo, [{ path: 'data/link.jsonl', purpose: 'x' }]),
      /symlink/,
    );

    // Подменённый blob в записи закрепления не проходит сверку с Git.
    const contract = f.store.read().contracts[1];
    const forged = {
      ...contract,
      artifacts: contract.artifacts!.map((a, i) =>
        i === 1 ? { ...a, blob: first.artifacts[1].blob } : a,
      ),
    };
    assert.throws(() => verifyArtifacts(() => p.repo, [forged]), /не совпадает с Git|не найден/);

    // Пределы размера дают понятную ошибку.
    await assert.rejects(
      pinArtifacts(repo, declared, undefined, {
        maxFileBytes: 100000,
        maxTotalBytes: 64 * 1024 * 1024,
        reviewTextBytes: 400000,
      }),
      /больше предела файла 100000 \(contractArtifacts\.maxFileBytes\)/,
    );
    const size = (await readFile(join(p.repo, 'data/corpus.jsonl'))).length;
    await assert.rejects(
      pinArtifacts(repo, declared, undefined, {
        maxFileBytes: size,
        maxTotalBytes: size,
        reviewTextBytes: 400000,
      }),
      new RegExp(`вместе больше предела ${size}`),
    );
    assert.throws(
      () =>
        configSchema.parse({
          ...f.h.config,
          contractArtifacts: { maxFileBytes: 2_000_000, maxTotalBytes: 1_000_000 },
        }),
      /maxFileBytes не может превышать maxTotalBytes/,
    );
  } finally {
    await f.close();
    await removeRoot(p.root);
  }
});
