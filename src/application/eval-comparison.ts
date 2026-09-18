import { z } from 'zod';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const report = z.object({
  version: z.literal(1),
  mode: z.string(),
  caseIds: z
    .array(z.string().regex(/^[A-Za-z0-9_-]+$/))
    .min(1)
    .max(100),
  priceTableDigest: hash,
  corpusDigest: hash,
  catalogDigest: hash,
  budget: z.object({
    repetitions: z.number().int().min(1).max(10),
    maxCalls: z.number().int().positive(),
    timeoutMs: z.number().positive(),
  }),
  results: z
    .array(
      z.object({
        caseId: z.string().regex(/^[A-Za-z0-9_-]+$/),
        repetition: z.number().int().positive(),
        status: z.enum(['passed', 'failed', 'unverified']),
        durationMs: z.number().nonnegative().optional(),
        costUsd: z.number().nonnegative().nullable().optional(),
      }),
    )
    .min(1),
});
export function compareEvaluations(baseline: unknown, candidate: unknown) {
  const a = report.parse(baseline),
    b = report.parse(candidate);
  if (
    a.priceTableDigest !== b.priceTableDigest ||
    a.corpusDigest !== b.corpusDigest ||
    a.catalogDigest !== b.catalogDigest ||
    a.mode !== b.mode ||
    JSON.stringify(a.budget) !== JSON.stringify(b.budget)
  )
    throw new Error(
      'Comparison requires identical prices, corpus, catalog, mode, repetitions and invocation/time limits',
    );
  for (const value of [a, b]) {
    const expected = new Set(
      value.caseIds.flatMap((id) =>
        Array.from({ length: value.budget.repetitions }, (_, i) => id + '/' + (i + 1)),
      ),
    );
    if (
      new Set(value.caseIds).size !== value.caseIds.length ||
      value.results.length !== expected.size ||
      value.results.some((r) => !expected.has(r.caseId + '/' + r.repetition))
    )
      throw new Error('Repeated, missing or unmatched cases');
  }
  if (JSON.stringify([...a.caseIds].sort()) !== JSON.stringify([...b.caseIds].sort()))
    throw new Error('Different case manifests');
  const key = (r: (typeof a.results)[number]) => r.caseId + '/' + r.repetition;
  const left = new Map(a.results.map((r) => [key(r), r])),
    right = new Map(b.results.map((r) => [key(r), r]));
  if (
    left.size !== a.results.length ||
    right.size !== b.results.length ||
    left.size !== right.size ||
    [...left.keys()].some((k) => !right.has(k))
  )
    throw new Error('Repeated, missing or unmatched cases');
  const complete = [...left.values(), ...right.values()].every((r) => r.status !== 'unverified');
  const pairs = [...left].map(([id, l]) => ({
    id,
    baseline: l.status,
    candidate: right.get(id)!.status,
    delta: Number(right.get(id)!.status === 'passed') - Number(l.status === 'passed'),
  }));
  const cases = [...new Set(a.results.map((r) => r.caseId))];
  const deltas = cases.map((id) => {
    const rows = pairs.filter((p) => p.id.startsWith(id + '/'));
    return rows.reduce((s, r) => s + r.delta, 0) / rows.length;
  });
  // Deterministic paired bootstrap over cases, not pseudo-independent repeated runs.
  let seed = 42;
  const samples: number[] = [];
  for (let i = 0; i < 2000; i++) {
    let sum = 0;
    for (let j = 0; j < deltas.length; j++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      sum += deltas[seed % deltas.length];
    }
    samples.push(sum / deltas.length);
  }
  samples.sort((x, y) => x - y);
  const totals = (r: typeof a) => ({
    passRate: r.results.filter((x) => x.status === 'passed').length / r.results.length,
    totalCostUsd: r.results.every((x) => x.costUsd != null)
      ? r.results.reduce((s, x) => s + x.costUsd!, 0)
      : null,
    totalDurationMs: r.results.every((x) => x.durationMs !== undefined)
      ? r.results.reduce((s, x) => s + x.durationMs!, 0)
      : null,
  });
  return {
    complete,
    mode: a.mode,
    baseline: totals(a),
    candidate: totals(b),
    pairs,
    passRateDelta: complete ? deltas.reduce((s, d) => s + d, 0) / deltas.length : null,
    pairedCaseBootstrap95: complete ? [samples[50], samples[1949]] : null,
    recommendation:
      'No automatic promotion. Confirm on held-out repository scenarios; fixture results test the mechanism, not model quality.',
  };
}
