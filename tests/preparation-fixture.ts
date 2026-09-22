import { architectureBrief, designBrief, productBrief } from '../src/core/preparation-model.ts';
import { readFileSync } from 'node:fs';
import { Preparation } from '../src/core/preparation.ts';
const example = JSON.parse(
  readFileSync(new URL('../packs/example-preparation.json', import.meta.url), 'utf8'),
) as { product: unknown; architecture: unknown; design: unknown };
export const product = productBrief.parse(example.product);
export const architecture = architectureBrief.parse(example.architecture);
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
  p.execute('preparation_design', {
    changeId,
    expectedDigest: null,
    reason: 'Первое направление дизайна',
    content: design,
  });
  approveStage(p, changeId, 'design');
  return changeId;
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
  stage: 'product' | 'architecture' | 'design',
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
