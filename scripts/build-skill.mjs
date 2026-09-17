import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { capabilities } from '../lib/application/agent.js';

const path = new URL('../skills/devcontour/references/agent-api.json', import.meta.url);
const expected = JSON.stringify(capabilities(), null, 2) + '\n';
if (process.argv.includes('--check')) {
  if ((await readFile(path, 'utf8')) !== expected)
    throw new Error('Skill API reference is stale; run npm run build');
  console.log('Skill API reference matches the installed command schemas');
} else {
  await mkdir(new URL('.', path), { recursive: true });
  await writeFile(path, expected);
}
