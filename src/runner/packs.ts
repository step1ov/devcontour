import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { resolveProfile as resolveHarnessProfile } from 'devcontour-harness';
import {
  gateList,
  relativePath,
  roleBindingsSchema,
  contextPackSchema,
  type Config,
} from '../core/model.ts';
import { environmentSchema, lifecycleSchema, stepSchema } from '../core/integrations.ts';

// Встроенные профили DevContour — свой набор: harness лишь читает их из этого
// каталога. Форма файла профиля — схема продукта (`profileSchema`, её же
// получает resolver как `layerSchema`); алгоритм (лимиты, extends, сложение
// слоёв, проверки gates, digest) один — harness `resolveProfile`. Тексты его
// отказов принимаются как есть. Схема строгая на верхнем уровне: профиль с
// `toolchain` (DevContour toolchain-требований не исполняет) отклоняется.
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
  // Сколько времени профиль отводит одной попытке. Пятнадцати минут хватает на
  // правку, но не на реализацию с нуля: агент упирается в предел посреди
  // работы, и попытка расходуется впустую. Знает об этом стек, а не контур.
  runTimeoutMs: z.number().int().min(60_000).max(7_200_000).optional(),
  // Роли, которых требует поверхность профиля. Мобильное приложение — это своя
  // область записи и свой инструментарий прогона; профиль знает это о себе, а
  // контур заранее не знает, какие роли бывают у продукта.
  roles: roleBindingsSchema.default({}),
  // Инструкции, которых требует стек профиля. Роли профиль объявлять умел, а
  // знание — нет: файлы копировались в продукт при setup, и библиотека не
  // росла, потому что её некуда было положить так, чтобы она сама приезжала
  // в проект. Реестр workspace остаётся сильнее: пакет с тем же id он
  // переопределяет.
  contextPacks: z.array(contextPackSchema).max(50).default([]),
});
type Source = { repositoryId: string; path: string };
export const packKey = (pack: { id: string; source?: Source }) =>
  JSON.stringify([pack.id, pack.source?.repositoryId ?? null, pack.source?.path ?? null]);

// Resolution only reads manifests. No project command runs while inspecting or pinning a profile.
export function resolveProfile(ref: string, repositoryRoot?: string, repositoryId = 'main') {
  const p = resolveHarnessProfile(ref, {
    repository: repositoryRoot,
    repositoryId,
    builtinRoot,
    layerSchema: profileSchema,
    includeLeafContent: true,
  });
  // Набор и порядок ключей прежнего результата: config.json, который пишет
  // setup, и pins не меняют байтов. Поля слоёв уже в форме схемы продукта.
  return {
    id: p.id,
    version: p.version,
    capabilities: p.capabilities,
    gates: p.gates,
    prepare: p.prepare,
    environment: p.environment,
    lifecycle: p.lifecycle,
    protectedPaths: p.protectedPaths,
    generatedPaths: p.generatedPaths,
    concurrency: p.concurrency,
    runTimeoutMs: p.runTimeoutMs,
    roles: p.roles,
    contextPacks: p.contextPacks,
    ...(p.source ? { source: p.source } : {}),
    // Формула harness та же, что закрепила прежние locks: один встроенный файл —
    // sha256 его байтов, иначе — sha256 замыкания слоёв.
    digest: p.digest,
    closure: p.closure,
    raw: p.leafContent,
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
