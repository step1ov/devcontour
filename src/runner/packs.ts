import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  gateList,
  relativePath,
  roleId,
  roleBindingSchema,
  contextPackSchema,
  type Config,
} from '../core/model.ts';
import { environmentSchema, lifecycleSchema, stepSchema } from '../core/integrations.ts';
import { orderedGates } from '../core/workflow.ts';

const builtinRoot = fileURLToPath(new URL('../../packs/profiles/', import.meta.url));
const name = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const profileSchema = z.strictObject({
  id: name,
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/),
  extends: z.array(z.string().min(1)).max(16).default([]),
  capabilities: z.array(z.string().min(1).max(100)).max(100).default([]),
  gates: z.array(gateList.element).max(100).default([]),
  prepare: z.array(stepSchema).max(100).default([]),
  environment: environmentSchema.optional(),
  lifecycle: lifecycleSchema.optional(),
  protectedPaths: z.array(relativePath).max(100).default([]),
  generatedPaths: z.array(relativePath).max(100).default([]),
  concurrency: z.number().int().min(1).max(4).optional(),
  // Роли, которых требует поверхность профиля. Мобильное приложение — это своя
  // область записи и свой инструментарий прогона; профиль знает это о себе, а
  // контур заранее не знает, какие роли бывают у продукта.
  roles: z.record(roleId, roleBindingSchema).default({}),
  // Инструкции, которых требует стек профиля. Роли профиль объявлять умел, а
  // знание — нет: файлы копировались в продукт при setup, и библиотека не
  // росла, потому что её некуда было положить так, чтобы она сама приезжала
  // в проект. Реестр workspace остаётся сильнее: пакет с тем же id он
  // переопределяет.
  contextPacks: z.array(contextPackSchema).max(50).default([]),
});
type Manifest = z.infer<typeof profileSchema>;
type Source = { repositoryId: string; path: string };
export const packKey = (pack: { id: string; source?: Source }) =>
  JSON.stringify([pack.id, pack.source?.repositoryId ?? null, pack.source?.path ?? null]);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function safeFile(root: string, file: string) {
  const path = relative(root, file);
  if (!path || isAbsolute(path) || path === '..' || path.startsWith('..' + sep))
    throw new Error('Профиль должен находиться внутри репозитория');
  let cursor = root;
  for (const part of path.split(sep)) {
    cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('Профиль не допускает symlink');
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > 131072) throw new Error('Профиль требует файл до 128 KiB');
  return readFileSync(file, 'utf8');
}

// Resolution only reads manifests. No project command runs while inspecting or pinning a profile.
export function resolveProfile(ref: string, repositoryRoot?: string, repositoryId = 'main') {
  const root = repositoryRoot ? realpathSync(repositoryRoot) : undefined;
  const active = new Set<string>(),
    seen = new Set<string>();
  const closure: { ref: string; digest: string }[] = [];
  const layers: Manifest[] = [];
  const files: string[] = [];
  let source: Source | undefined,
    raw = '';
  const visit = (reference: string, parent?: string, depth = 0): Manifest => {
    if (depth > 16) throw new Error('Слишком глубокое наследование профилей');
    const builtin = /^[A-Za-z0-9_-]{1,80}$/.test(reference);
    if (!builtin && !reference.startsWith('./') && !reference.startsWith('../'))
      throw new Error('Профиль: укажите встроенный ID либо относительный ./file.json');
    if (!builtin && (!root || parent === 'builtin'))
      throw new Error('Локальный профиль требует корень репозитория');
    const file = builtin
      ? join(builtinRoot, reference + '.json')
      : resolve(parent ?? root!, reference);
    const owner = builtin ? builtinRoot : root!;
    const key = builtin ? 'builtin:' + reference : 'local:' + relative(root!, file);
    if (active.has(key)) throw new Error('Цикл наследования профилей: ' + key);
    const content = safeFile(owner, file);
    const manifest = profileSchema.parse(JSON.parse(content));
    if (builtin && manifest.id !== reference)
      throw new Error('ID встроенного профиля не совпадает');
    if (depth === 0) {
      raw = content;
      if (!builtin) source = { repositoryId, path: relative(root!, file) };
    }
    if (seen.has(key)) return manifest;
    if (seen.size + active.size >= 32) throw new Error('Не более 32 файлов профиля');
    active.add(key);
    for (const base of manifest.extends)
      visit(base, builtin ? 'builtin' : dirname(file), depth + 1);
    active.delete(key);
    seen.add(key);
    closure.push({ ref: key, digest: hash(content) });
    if (!builtin) files.push(relative(root!, file));
    layers.push(manifest);
    return manifest;
  };
  const leaf = visit(ref);
  const gates = layers.flatMap((p) => p.gates);
  orderedGates(gates);
  if (!gates.some((g) => g.kind === 'test' && g.report))
    throw new Error('Итоговый профиль требует test gate с JUnit');
  for (const gate of gates) {
    if (gate.id === 'requirement-source') throw new Error('Зарезервированный gate');
    if (gate.kind === 'test' && !gate.report) throw new Error('Test gate требует JUnit');
    if (gate.report) relativePath.parse(gate.report.path);
  }
  const prepare = layers.flatMap((p) => p.prepare);
  if (new Set(prepare.map((s) => s.id)).size !== prepare.length)
    throw new Error('Повтор prepare step ID');
  const single = <K extends 'environment' | 'lifecycle'>(key: K): Manifest[K] => {
    const values = layers.map((p) => p[key]).filter((v) => v !== undefined);
    if (values.length > 1) throw new Error('Конфликт частей профиля: ' + key);
    return values[0];
  };
  const limits = layers.flatMap((p) => (p.concurrency ? [p.concurrency] : []));
  const lifecycle = single('lifecycle');
  for (const steps of lifecycle ? [lifecycle.setup, lifecycle.ready, lifecycle.teardown] : [])
    if (new Set(steps.map((s) => s.id)).size !== steps.length)
      throw new Error('Повтор lifecycle step ID');
  return {
    id: leaf.id,
    version: leaf.version,
    capabilities: [...new Set(layers.flatMap((p) => p.capabilities))],
    gates,
    prepare,
    environment: single('environment'),
    lifecycle,
    protectedPaths: [...new Set([...layers.flatMap((p) => p.protectedPaths), ...files])],
    generatedPaths: [...new Set(layers.flatMap((p) => p.generatedPaths))],
    concurrency: limits.length ? Math.min(...limits) : undefined,
    // Слои складываются: базовый профиль даёт роль, надстройка уточняет её
    // привязку, не переписывая остальные.
    roles: Object.assign({}, ...layers.map((p) => p.roles)) as Manifest['roles'],
    // Пакеты слоёв складываются по id: надстройка уточняет инструкцию базового
    // профиля, не отменяя остальные.
    contextPacks: [
      ...new Map(
        layers.flatMap((p) => p.contextPacks).map((pack) => [pack.id, pack]),
      ).values(),
    ],
    ...(source ? { source } : {}),
    // Preserve existing leaf builtin locks without a migration.
    digest: closure.length === 1 && !source ? hash(raw) : hash(JSON.stringify(closure)),
    closure,
    raw,
  };
}
export async function profile(ref: string, root?: string, repositoryId?: string) {
  return resolveProfile(ref, root, repositoryId);
}
export function profileMetadata(p: ReturnType<typeof resolveProfile>): Config['packs'][number] {
  return {
    id: p.id,
    version: p.version,
    capabilities: p.capabilities,
    ...(p.source ? { source: p.source } : {}),
  };
}
export const profilePin = (p: ReturnType<typeof resolveProfile>) => ({
  id: p.id,
  version: p.version,
  digest: p.digest,
  ...(p.source ? { source: p.source } : {}),
});
