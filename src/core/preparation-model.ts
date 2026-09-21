import { z } from 'zod';
const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().max(6000);
const items = z.array(z.string().trim().min(3).max(1500)).max(30);
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}$/);
export const featureId = slug;
export const releaseId = slug;
export const personaId = slug;
export const semver = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    'Версия релиза должна следовать SemVer, например 0.1.0',
  );
// A release is the scope boundary: what has to exist first and what may wait.
export const productRelease = z.strictObject({
  id: releaseId,
  version: semver,
  title: z.string().trim().min(3).max(160),
  goal: z.string().trim().min(10).max(1500),
});
// Acceptance is stated per release, so one feature can start in an early
// release and be completed in a later one without splitting it in two.
export const acceptanceCriterion = z.strictObject({
  releaseId,
  text: z.string().trim().min(3).max(1500),
});
// Personas are optional context. When one is named, it carries the goals and
// pains behind a decision, so ambiguity is resolved the way that person would.
export const productPersona = z.strictObject({
  id: personaId,
  name: z.string().trim().min(2).max(80),
  role: z.string().trim().min(3).max(200),
  goals: z.array(z.string().trim().min(3).max(600)).min(1).max(10),
  pains: z.array(z.string().trim().min(3).max(600)).min(1).max(10),
});
export const productScenario = z.strictObject({
  personaId: personaId.optional(),
  text: z.string().trim().min(3).max(1500),
});
// A feature is the unit the operator reads, approves and later tracks.
export const productFeature = z.strictObject({
  id: featureId,
  title: z.string().trim().min(3).max(160),
  outcome: z.string().trim().min(10).max(1500),
  scenarios: z.array(productScenario).min(1).max(20),
  acceptance: z.array(acceptanceCriterion).min(1).max(30),
});
export const productBrief = z.strictObject({
  problem: text,
  outcome: text,
  personas: z.array(productPersona).max(20).default([]),
  releases: z.array(productRelease).min(1).max(10),
  features: z.array(productFeature).min(1).max(40),
  exclusions: items,
  references: items,
  questions: items,
});
export const c4Diagram = z.strictObject({
  systemId: id,
  nodes: z
    .array(
      z.strictObject({
        id,
        name: z.string().trim().min(1).max(100),
        kind: z.enum(['person', 'system', 'external-system', 'container']),
        description: z.string().trim().min(3).max(600),
        technology: z.string().trim().max(150).default(''),
      }),
    )
    .min(1)
    .max(30),
  relationships: z
    .array(
      z.strictObject({
        from: id,
        to: id,
        description: z.string().trim().min(3).max(200),
        technology: z.string().trim().max(100).default(''),
      }),
    )
    .min(1)
    .max(60),
});
export const architectureBrief = z.strictObject({
  summary: text,
  stack: z
    .array(
      z.strictObject({
        area: z.string().trim().min(2).max(100),
        choice: z.string().trim().min(2).max(200),
        rationale: z.string().trim().min(10).max(1500),
        alternatives: z.string().trim().min(3).max(1500),
      }),
    )
    .max(30),
  decisions: items,
  risks: items,
  testStrategy: text,
  questions: items,
  c1: c4Diagram.optional(),
  c2: c4Diagram.optional(),
});
const stage = z.enum(['product', 'architecture']);
const note = z.string().trim().min(3).max(300);
// The lead agent spends long stretches reading a brief without saving a revision.
// An append-only journal makes that work visible in the panel from the first launch.
export const preparationActivity = z.strictObject({
  at: z.iso.datetime(),
  stage: z.enum(['product', 'architecture', 'development']),
  note,
});
export const preparationQuestion = z.strictObject({
  id,
  stage,
  createdAt: z.iso.datetime(),
  text: z.string().trim().min(3).max(1500),
  why: z.string().trim().max(600).default(''),
  options: z.array(z.string().trim().min(1).max(300)).max(6).default([]),
  status: z.enum(['open', 'answered', 'withdrawn']),
  answer: z
    .strictObject({ at: z.iso.datetime(), text: z.string().trim().min(1).max(3000) })
    .optional(),
});
export const preparationRecord = z.strictObject({
  id,
  stage,
  createdAt: z.iso.datetime(),
  statement: z.string().trim().min(3).max(600),
  rationale: z.string().trim().min(3).max(1500),
  questionId: id.optional(),
});
const revision = {
  number: z.number().int().positive(),
  digest: hash,
  createdAt: z.iso.datetime(),
  status: z.enum(['draft', 'in-review', 'approved', 'changes-requested']),
  reason: z.string().trim().min(3).max(2000),
  decision: z
    .strictObject({
      actor: z.literal('operator'),
      at: z.iso.datetime(),
      comment: z.string().max(3000),
    })
    .optional(),
};
export const productChange = z.strictObject({
  id,
  title: z.string().trim().min(3).max(180),
  createdAt: z.iso.datetime(),
  product: z.array(z.strictObject({ ...revision, content: productBrief })).max(100),
  architecture: z
    .array(z.strictObject({ ...revision, productDigest: hash, content: architectureBrief }))
    .max(100),
  activity: z.array(preparationActivity).max(200).default([]),
  questions: z.array(preparationQuestion).max(60).default([]),
  decisions: z.array(preparationRecord).max(100).default([]),
});
export const preparationState = z.strictObject({
  id: z.literal('workspace-preparation'),
  activeChangeId: id.optional(),
  changes: z.array(productChange).max(100),
});
export const preparationBinding = z.strictObject({
  changeId: id,
  productDigest: hash,
  architectureDigest: hash,
});
export const preparationInputs = {
  preparation_status: z.strictObject({ changeId: id.optional() }),
  preparation_create: z.strictObject({ title: z.string().trim().min(3).max(180) }),
  preparation_activate: z.strictObject({ changeId: id }),
  preparation_product: z.strictObject({
    changeId: id,
    expectedDigest: hash.nullable(),
    reason: z.string().min(3).max(2000),
    content: productBrief,
  }),
  preparation_architecture: z.strictObject({
    changeId: id,
    expectedDigest: hash.nullable(),
    reason: z.string().min(3).max(2000),
    content: architectureBrief,
  }),
  preparation_submit: z.strictObject({
    changeId: id,
    stage: z.enum(['product', 'architecture']),
    expectedDigest: hash,
  }),
  preparation_progress: z.strictObject({
    changeId: id.optional(),
    stage: z.enum(['product', 'architecture', 'development']).default('product'),
    note,
  }),
  preparation_question: z.strictObject({
    changeId: id.optional(),
    stage: stage.default('product'),
    add: z
      .array(
        z.strictObject({
          text: z.string().trim().min(3).max(1500),
          why: z.string().trim().max(600).default(''),
          options: z.array(z.string().trim().min(1).max(300)).max(6).default([]),
        }),
      )
      .max(10)
      .default([]),
    withdraw: z.array(id).max(10).default([]),
  }),
  preparation_resolve: z.strictObject({
    changeId: id.optional(),
    stage: stage.default('product'),
    statement: z.string().trim().min(3).max(600),
    rationale: z.string().trim().min(3).max(1500),
    questionId: id.optional(),
  }),
};
export const preparationAnswer = z.strictObject({
  changeId: id,
  questionId: id,
  text: z.string().trim().min(1).max(3000),
});
export const preparationDecision = z.strictObject({
  changeId: id,
  stage: z.enum(['product', 'architecture']),
  expectedDigest: hash,
  decision: z.enum(['approve', 'request-changes']),
  comment: z.string().trim().max(3000),
});
export type PreparationQuestion = z.infer<typeof preparationQuestion>;
export type PreparationRecord = z.infer<typeof preparationRecord>;
export type PreparationActivity = z.infer<typeof preparationActivity>;
export type ProductPersona = z.infer<typeof productPersona>;
export type ProductScenario = z.infer<typeof productScenario>;
export type ProductRelease = z.infer<typeof productRelease>;
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterion>;
export type ProductFeature = z.infer<typeof productFeature>;
export type ProductBrief = z.infer<typeof productBrief>;
export type ArchitectureBrief = z.infer<typeof architectureBrief>;
export type C4Diagram = z.infer<typeof c4Diagram>;
export type ProductChange = z.infer<typeof productChange>;
export type PreparationState = z.infer<typeof preparationState>;
export type PreparationBinding = z.infer<typeof preparationBinding>;
export type PreparationOperation = keyof typeof preparationInputs;
