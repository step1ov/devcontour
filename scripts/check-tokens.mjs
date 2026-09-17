import { readFile, readdir } from 'node:fs/promises';
const files = await readdir('src/web');
const errors = [];
for (const file of files) {
  if (file === 'tokens.css') continue;
  const text = await readFile('src/web/' + file, 'utf8');
  if (/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/i.test(text))
    errors.push(file + ': цветовые литералы допустимы только в tokens.css');
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else console.log('Semantic color tokens: OK');
