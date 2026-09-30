// Генеративная проверка для гейта DevContour: эталон, генератор и уменьшение
// входа задаёт проект; harness только прогоняет их и пишет отчёт.
//
// Использование (скопируйте файл в проект, он без зависимостей):
//
//   import { properties } from './harness.mjs';
//   await properties([{
//     testId: 'knapsack-optimal',          // стабильный id: testcase JUnit и критерий
//     cases: 300,
//     generate: (rng) => input,            // rng() → [0, 1)
//     oracle: (input) => expected,         // заведомо верный ответ на малом входе
//     subject: (input) => actual,          // проверяемая реализация
//     shrink: (input) => [smaller, ...],   // кандидаты меньше, по убыванию пользы
//     equal: (a, b) => boolean,            // по умолчанию — сравнение JSON
//     reduceMs: 2000,                      // предел уменьшения
//   }]);
//
// Seed задаёт контур (DEVCONTOUR_SEED): повтор с тем же seed даёт тот же вход.
// Отчёт пишется в DEVCONTOUR_PROPERTY_REPORT до каждого случая: если проверка
// зависнет и гейт её остановит, в отчёте останется вход, на котором она шла.
// Найденный контрпример записывается сразу, до уменьшения; уменьшение
// ограничено по времени и при таймауте сохраняет исходный вход.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const write = (path, value) => {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
};
const xml = (text) =>
  String(text).replace(
    /[<>&"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c],
  );

export async function properties(list) {
  const seed = Number(process.env.DEVCONTOUR_SEED ?? Math.floor(Math.random() * 2 ** 32));
  const reportPath = process.env.DEVCONTOUR_PROPERTY_REPORT;
  const junitPath = process.env.DEVCONTOUR_REPORT_PATH;
  const report = { version: 1, properties: [] };
  const save = () => write(reportPath, report);
  for (const p of list) {
    const entry = { testId: p.testId, status: 'running', cases: 0 };
    report.properties.push(entry);
    const rng = mulberry32(seed ^ hash(p.testId));
    const equal = p.equal ?? ((a, b) => JSON.stringify(a) === JSON.stringify(b));
    const fails = (input) => {
      let actual;
      try {
        actual = p.subject(structuredClone(input));
      } catch (error) {
        actual = { error: String(error?.message ?? error) };
      }
      const expected = p.oracle(structuredClone(input));
      return equal(actual, expected) ? undefined : { expected, actual };
    };
    for (let i = 0; i < p.cases; i++) {
      const input = p.generate(rng);
      entry.current = input;
      save();
      const failure = fails(input);
      entry.cases = i + 1;
      if (!failure) continue;
      delete entry.current;
      entry.status = 'failed';
      entry.counterexample = { original: input, ...failure };
      save();
      // Уменьшение: жадно берём первого меньшего кандидата, который всё ещё
      // нарушает свойство. Предел времени сохраняет исходный контрпример.
      const deadline = Date.now() + (p.reduceMs ?? 2000);
      let current = input;
      let currentFailure = failure;
      let progress = true;
      while (progress && p.shrink) {
        progress = false;
        for (const candidate of p.shrink(current)) {
          if (Date.now() > deadline) {
            entry.counterexample.reductionTimedOut = true;
            progress = false;
            break;
          }
          const f = fails(candidate);
          if (f) {
            current = candidate;
            currentFailure = f;
            progress = true;
            entry.counterexample = {
              original: input,
              reduced: current,
              ...currentFailure,
            };
            save();
            break;
          }
        }
      }
      break;
    }
    if (entry.status === 'running') {
      entry.status = 'passed';
      delete entry.current;
    }
    save();
  }
  const failed = report.properties.filter((p) => p.status !== 'passed');
  write(
    junitPath,
    `<testsuite name="properties" tests="${report.properties.length}" failures="${failed.length}">` +
      report.properties
        .map(
          (p) =>
            `<testcase name="${xml(p.testId)}">` +
            (p.status === 'passed'
              ? ''
              : `<failure message="${xml(JSON.stringify(p.counterexample?.reduced ?? p.counterexample?.original))}"/>`) +
            '</testcase>',
        )
        .join('') +
      '</testsuite>',
  );
  console.log(
    `seed ${seed}: ${report.properties.length - failed.length}/${report.properties.length} properties hold`,
  );
  for (const p of failed) console.log(`${p.testId}: ${JSON.stringify(p.counterexample)}`);
  if (failed.length) process.exitCode = 1;
  return report;
}

function hash(text) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
