import { z } from 'zod';
const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().max(6000);
const items = z.array(z.string().trim().min(3).max(1500)).max(30);
export const productBrief = z.strictObject({
  problem: text,
  audience: items,
  outcome: text,
  scenarios: items,
  scope: items,
  exclusions: items,
  acceptance: items,
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
};
export const preparationDecision = z.strictObject({
  changeId: id,
  stage: z.enum(['product', 'architecture']),
  expectedDigest: hash,
  decision: z.enum(['approve', 'request-changes']),
  comment: z.string().trim().max(3000),
});
export type ProductBrief = z.infer<typeof productBrief>;
export type ArchitectureBrief = z.infer<typeof architectureBrief>;
export type C4Diagram = z.infer<typeof c4Diagram>;
export type ProductChange = z.infer<typeof productChange>;
export type PreparationState = z.infer<typeof preparationState>;
export type PreparationBinding = z.infer<typeof preparationBinding>;
export type PreparationOperation = keyof typeof preparationInputs;
