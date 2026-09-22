import {
  architectureBrief,
  conceptBrief,
  designBrief,
  productBrief,
  referencesBrief,
} from '../src/core/preparation-model.ts';
import { readFileSync } from 'node:fs';
import { Preparation } from '../src/core/preparation.ts';
const example = JSON.parse(
  readFileSync(new URL('../packs/example-preparation.json', import.meta.url), 'utf8'),
) as {
  product: unknown;
  architecture: unknown;
  references: unknown;
  concept: unknown;
  design: unknown;
};
export const product = productBrief.parse(example.product);
export const architecture = architectureBrief.parse(example.architecture);
export const references = referencesBrief.parse(example.references);
export const concept = conceptBrief.parse(example.concept);
export const design = designBrief.parse(example.design);
export function approvePreparation(p: Preparation) {
  p.execute('preparation_create', { title: 'Модерация чата' });
  const status = p.status();
  if (!status.enabled) throw new Error('Missing preparation');
  const changeId = status.activeChangeId!;
  p.execute('preparation_product', {
    changeId,
    expectedDigest: null,
    reason: 'Первичная постановка',
    content: product,
  });
  approveStage(p, changeId, 'product');
  p.execute('preparation_architecture', {
    changeId,
    expectedDigest: null,
    reason: 'Первая архитектура',
    content: architecture,
  });
  approveStage(p, changeId, 'architecture');
  approveDesign(p, changeId);
  return changeId;
}
// The design track is three approvals: references, concept, then the system.
export function approveDesign(p: Preparation, changeId: string) {
  p.execute('preparation_references', {
    changeId,
    expectedDigest: null,
    reason: 'Референсы собраны',
    content: references,
  });
  approveStage(p, changeId, 'references');
  p.execute('preparation_concept', {
    changeId,
    expectedDigest: null,
    reason: 'Концепт и эскизы',
    content: concept,
  });
  approveStage(p, changeId, 'concept');
  p.execute('preparation_design', {
    changeId,
    expectedDigest: null,
    reason: 'Палитра, токены и guidelines',
    content: design,
  });
  approveStage(p, changeId, 'design');
}
// Some tests need the architecture stage open without approving architecture.
export function approveProductOnly(p: Preparation) {
  p.execute('preparation_create', { title: 'Модерация чата' });
  const status = p.status();
  if (!status.enabled) throw new Error('Missing preparation');
  const changeId = status.activeChangeId!;
  p.execute('preparation_product', {
    changeId,
    expectedDigest: null,
    reason: 'Первичная постановка',
    content: product,
  });
  approveStage(p, changeId, 'product');
  return changeId;
}
// Architecture approved, design still open: for tests about the design stage.
export function approveArchitectureOnly(p: Preparation) {
  const changeId = approveProductOnly(p);
  p.execute('preparation_architecture', {
    changeId,
    expectedDigest: null,
    reason: 'Первая архитектура',
    content: architecture,
  });
  approveStage(p, changeId, 'architecture');
  return changeId;
}
export function approveStage(
  p: Preparation,
  changeId: string,
  stage: 'product' | 'architecture' | 'references' | 'concept' | 'design',
) {
  const view = p.status(changeId);
  if (!view.enabled) throw new Error('Missing preparation');
  const expectedDigest = view.current![stage]!.digest;
  p.execute('preparation_submit', { changeId, stage, expectedDigest });
  p.decide({
    changeId,
    stage,
    expectedDigest,
    decision: 'approve',
    comment: 'Проверено пользователем',
  });
}
