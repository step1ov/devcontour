import { z } from 'zod';
import { DomainError, relativePath } from './model.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,50}$/);
const title = z
  .string()
  .trim()
  .min(3)
  .max(180)
  .regex(/^[^\r\n]+$/);
const text = z.string().trim().min(3).max(2000);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const source = relativePath.refine((p) => p !== 'INTENT.md', 'INTENT не может ссылаться на себя');
const reference = z.strictObject({ source, id: z.string().regex(/^REQ-[A-Za-z0-9_-]{1,64}$/) });
const pinned = reference.extend({ digest: hash });
const criterion = z.strictObject({
  id,
  text,
  requirements: z.array(reference).min(1).max(20),
});
const story = z.strictObject({
  id,
  title,
  releaseId: id,
  criteria: z.array(criterion).min(1).max(20),
});
const common = { title, purpose: text };
const component = z.strictObject({
  kind: z.literal('component'),
  ...common,
  audience: z.array(text).min(1).max(20),
  constraints: z.array(text).max(20).default([]),
  nonGoals: z.array(text).max(20).default([]),
  assumptions: z.array(text).max(20).default([]),
  sources: z.array(source).min(1).max(30),
  releases: z.array(z.strictObject({ id, title })).min(1).max(20),
  stories: z.array(story).min(1).max(100),
  exclusions: z
    .array(reference.extend({ reason: text }))
    .max(200)
    .default([]),
});
const target = z.strictObject({
  repositoryId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  releaseId: id,
});
const workspace = z.strictObject({
  kind: z.literal('workspace'),
  ...common,
  releases: z
    .array(z.strictObject({ id, title, components: z.array(target).min(1).max(10) }))
    .min(1)
    .max(20),
});
export const intentDefinition = z.discriminatedUnion('kind', [component, workspace]);
export const intentDocument = z.discriminatedUnion('kind', [
  component.extend({
    version: z.literal(1),
    sourceSha: z.string().regex(/^[a-f0-9]{40,64}$/),
    stories: z
      .array(
        story.extend({
          criteria: z
            .array(criterion.extend({ requirements: z.array(pinned).min(1).max(20) }))
            .min(1)
            .max(20),
        }),
      )
      .min(1)
      .max(100),
    exclusions: z.array(pinned.extend({ reason: text })).max(200),
  }),
  workspace.extend({
    version: z.literal(1),
    releases: z
      .array(
        z.strictObject({
          id,
          title,
          components: z
            .array(target.extend({ intentDigest: hash }))
            .min(1)
            .max(10),
        }),
      )
      .min(1)
      .max(20),
  }),
]);
export type IntentDocument = z.infer<typeof intentDocument>;
export type ComponentIntent = Extract<IntentDocument, { kind: 'component' }>;
export const intentRequirementId = (storyId: string) => 'REQ-intent-' + storyId;
export const referenceKey = (ref: { source: string; id: string }) =>
  JSON.stringify([ref.source, ref.id]);

export function validateIntent(value: z.infer<typeof intentDefinition>) {
  const unique = (values: string[], label: string) => {
    if (new Set(values).size !== values.length) throw new DomainError('Повтор ' + label);
  };
  unique(
    value.releases.map((r) => r.id),
    'release ID',
  );
  if (value.kind === 'workspace') {
    for (const release of value.releases)
      unique(
        release.components.map((c) => c.repositoryId),
        'component owner',
      );
    return;
  }
  unique(value.sources, 'source');
  unique(
    value.stories.map((s) => s.id),
    'story ID',
  );
  unique(
    value.stories.flatMap((s) => s.criteria.map((c) => c.id)),
    'criterion ID',
  );
  unique(value.exclusions.map(referenceKey), 'exclusion');
  const included = new Set<string>();
  for (const s of value.stories) {
    if (!value.releases.some((r) => r.id === s.releaseId))
      throw new DomainError('Неизвестный release ID');
    for (const c of s.criteria) {
      unique(c.requirements.map(referenceKey), 'criterion requirement');
      for (const ref of c.requirements) {
        if (!value.sources.includes(ref.source))
          throw new DomainError('Источник не объявлен в sources');
        included.add(referenceKey(ref));
      }
    }
  }
  for (const ref of value.exclusions)
    if (!value.sources.includes(ref.source) || included.has(referenceKey(ref)))
      throw new DomainError('Исключение конфликтует с источниками или историями');
}

// Quoted prose cannot inject another REQ heading or a fenced metadata block.
const prose = (value: string) =>
  value
    .split('\n')
    .map((line) => '> ' + line)
    .join('\n');
export function renderIntent(raw: unknown): string {
  const value = intentDocument.parse(raw);
  validateIntent(value);
  const lines = [
    '# INTENT.md — ' + value.title,
    '',
    '## Product',
    '',
    prose(value.purpose),
    '',
    '## Definition',
    '',
    '```devcontour-intent',
    JSON.stringify(value, null, 2),
    '```',
    '',
  ];
  if (value.kind === 'component') {
    for (const story of value.stories) {
      const grounding = {
        purpose: value.purpose,
        audience: value.audience,
        constraints: value.constraints,
        nonGoals: value.nonGoals,
        assumptions: value.assumptions,
      };
      lines.push(
        '## ' + intentRequirementId(story.id) + ': ' + story.title,
        '',
        'Release: ' + story.releaseId,
        '',
        'Product context:',
        prose(JSON.stringify(grounding, null, 2)),
        '',
      );
      for (const c of story.criteria) {
        lines.push(
          '### ' + c.id,
          '',
          prose(c.text),
          '',
          'Requirement sources:',
          ...c.requirements.map((r) => prose(JSON.stringify(r))),
          '',
        );
      }
    }
  } else {
    lines.push('## Component releases', '');
    for (const release of value.releases)
      lines.push(
        '### ' + release.id + ': ' + release.title,
        '',
        ...release.components.map((c) => prose(JSON.stringify(c))),
        '',
      );
  }
  return lines.join('\n');
}

export function parseIntent(markdown: string): IntentDocument {
  if (Buffer.byteLength(markdown) > 1_000_000) throw new DomainError('INTENT превышает 1 MB');
  const blocks = [...markdown.matchAll(/^```devcontour-intent\r?\n([\s\S]*?)^```\s*$/gm)];
  if (blocks.length !== 1)
    throw new DomainError(
      'Нужен один блок devcontour-intent; подготовьте файл через intent_render',
    );
  const value = intentDocument.parse(JSON.parse(blocks[0][1]));
  if (renderIntent(value).trim() !== markdown.replaceAll('\r\n', '\n').trim())
    throw new DomainError('INTENT prose и definition расходятся; повторите intent_render');
  return value;
}
