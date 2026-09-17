import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { configSchema } from '../core/model.ts';
const packSchema = z.object({
  id: z.string(),
  version: z.literal('0.1.0'),
  capabilities: z.array(z.string()),
  gates: configSchema.shape.gates,
  concurrency: z.number().int().optional(),
});
export async function profile(id: string) {
  if (!['react-vite-admin', 'next-product', 'go-api', 'mobile-maestro'].includes(id))
    throw new Error('Профиль не найден: ' + id);
  const raw = await readFile(new URL(`../../packs/profiles/${id}.json`, import.meta.url), 'utf8');
  const pack = packSchema.parse(JSON.parse(raw));
  return { ...pack, digest: createHash('sha256').update(raw).digest('hex') };
}
