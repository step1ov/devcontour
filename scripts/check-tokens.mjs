import { readFile, readdir } from 'node:fs/promises';
const errors = [];
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = directory + '/' + entry.name;
    if (entry.isDirectory()) {
      await scan(path);
      continue;
    }
    if (path === 'src/web/tokens.css') continue;
    const text = await readFile(path, 'utf8');
    if (/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/i.test(text))
      errors.push(path + ': цветовые литералы допустимы только в tokens.css');
  }
}
await scan('src/web');
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else console.log('Semantic color tokens: OK');
