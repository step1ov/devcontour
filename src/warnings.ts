/**
 * Команды CLI открывают SQLite, и node печатал в stderr предупреждение о его
 * экспериментальном статусе: у `doctor --scope data` и `contract-*` stderr
 * переставал быть пригодным для скриптов. Отсекается только это
 * предупреждение; остальные, в том числе другие ExperimentalWarning, node
 * выводит как прежде.
 */
export function suppressSqliteWarning() {
  const emit = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  process.emitWarning = (warning: string | Error, ...rest: unknown[]) => {
    const option = rest[0];
    const type =
      typeof option === 'string'
        ? option
        : ((option as { type?: string } | undefined)?.type ??
          (warning instanceof Error ? warning.name : undefined));
    const message = typeof warning === 'string' ? warning : warning?.message;
    if (type === 'ExperimentalWarning' && /^SQLite is an experimental feature/.test(message ?? ''))
      return;
    emit(warning, ...rest);
  };
}
