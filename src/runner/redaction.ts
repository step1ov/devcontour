/**
 * Маскирование известных значений — правило harness: секреты окружения в
 * исходной, JSON-, URL- и XML-форме, вывод процессов и вложенные структуры.
 * Wrapper без правил: продукт маскирует свои записи тем же redactor.
 */
export {
  composeRedactors,
  outputRedactor,
  redactDeep,
  redactor,
  type Redactor,
} from 'devcontour-harness';
