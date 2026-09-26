// Линт с запретом роста долга.
//
// Ошибки ESLint останавливают проверку, как раньше. Предупреждения — это
// согласованный долг (правила, которые ещё не ужесточены): их число по
// каждому правилу не должно расти относительно записанной базы. Новый код
// не может спрятать небезопасный any за общим «это же предупреждение», а
// снижение долга фиксируется флагом --update, чтобы база не поползла обратно.
import { ESLint } from 'eslint';
import { readFileSync, writeFileSync } from 'node:fs';

const baselinePath = new URL('./lint-debt.json', import.meta.url);
const update = process.argv.includes('--update');
const eslint = new ESLint();
const results = await eslint.lintFiles(['.']);

const errors = results.filter((r) => r.errorCount > 0);
if (errors.length) {
  const formatter = await eslint.loadFormatter('stylish');
  console.error(await formatter.format(ESLint.getErrorResults(results)));
  process.exit(1);
}

const debt = {};
for (const result of results)
  for (const message of result.messages)
    if (message.severity === 1)
      debt[message.ruleId ?? 'unknown'] = (debt[message.ruleId ?? 'unknown'] ?? 0) + 1;

if (update) {
  writeFileSync(
    baselinePath,
    JSON.stringify(Object.fromEntries(Object.entries(debt).sort()), null, 2) + '\n',
  );
  console.log('Lint debt baseline updated:', debt);
  process.exit(0);
}
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const grown = Object.entries(debt).filter(([rule, n]) => n > (baseline[rule] ?? 0));
const shrunk = Object.entries(baseline).filter(([rule, n]) => (debt[rule] ?? 0) < n);
if (grown.length) {
  console.error('Lint debt grew (rule: now > baseline):');
  for (const [rule, n] of grown) console.error(`  ${rule}: ${n} > ${baseline[rule] ?? 0}`);
  for (const result of results)
    for (const m of result.messages)
      if (m.severity === 1 && grown.some(([rule]) => rule === m.ruleId))
        console.error(`  ${result.filePath}:${m.line}:${m.column} ${m.ruleId}`);
  console.error('Fix the new warnings; the baseline only moves down (npm run lint:debt-update).');
  process.exit(1);
}
if (shrunk.length)
  console.log(
    'Lint debt went down; record it with `npm run lint:debt-update`:',
    Object.fromEntries(shrunk.map(([rule, n]) => [rule, `${debt[rule] ?? 0} < ${n}`])),
  );
console.log('Lint: no errors; debt within baseline.');
