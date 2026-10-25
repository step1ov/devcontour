import { fileURLToPath } from 'node:url';
import { resolveProfile as resolveHarnessProfile } from 'devcontour-harness';
import { gateList, contextPackSchema, type Config } from '../core/model.ts';

// Встроенные профили DevContour — свой набор: harness лишь читает их из этого
// каталога. Алгоритм (лимиты, extends, сложение слоёв, проверки gates, digest)
// один — harness `resolveProfile`; тексты его отказов принимаются как есть.
const builtinRoot = fileURLToPath(new URL('../../packs/profiles/', import.meta.url));
type Source = { repositoryId: string; path: string };
export const packKey = (pack: { id: string; source?: Source }) =>
  JSON.stringify([pack.id, pack.source?.repositoryId ?? null, pack.source?.path ?? null]);

// Resolution only reads manifests. No project command runs while inspecting or pinning a profile.
export function resolveProfile(ref: string, repositoryRoot?: string, repositoryId = 'main') {
  const p = resolveHarnessProfile(ref, {
    repository: repositoryRoot,
    repositoryId,
    builtinRoot,
    includeLeafContent: true,
  });
  // Host-правило: toolchain-требований DevContour не исполняет (проверка версий
  // инструментов есть только у harness), поэтому профиль с ними отклоняется, а
  // не применяется наполовину. Слой с toolchain всегда оставляет его в итоговом
  // профиле, так что проверки результата достаточно.
  if (p.toolchain)
    throw new Error(
      'Профиль: toolchain не поддерживается DevContour (Unrecognized key: toolchain)',
    );
  // Проекция в host-формы: набор и порядок ключей прежнего резолвера, чтобы
  // config.json, который пишет setup, не менял байтов. Нормализуются только
  // поля, где формы расходятся: порядок ключей gate (у harness — union по
  // kind) и умолчание repositoryId: 'main' у contextPacks.
  return {
    id: p.id,
    version: p.version,
    capabilities: p.capabilities,
    gates: p.gates.map((g) => gateList.element.parse(g)),
    prepare: p.prepare,
    environment: p.environment,
    lifecycle: p.lifecycle,
    protectedPaths: p.protectedPaths,
    generatedPaths: p.generatedPaths,
    concurrency: p.concurrency,
    runTimeoutMs: p.runTimeoutMs,
    roles: p.roles,
    contextPacks: p.contextPacks.map((pack) => contextPackSchema.parse(pack)),
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
