export interface ProcessRow {
  pid: number;
  ppid: number;
  start: string;
  command: string;
  mark?: string;
}
export function parseRows(argvStdout: string, envStdout: string): ProcessRow[];
export function findOrphans(
  rows: ProcessRow[],
  self?: number,
): Map<number, { start: string; why: string }>;
export function sweepOrphans(options?: {
  log?: (line: string) => void;
  graceMs?: number;
  list?: () => Promise<ProcessRow[]>;
}): Promise<number>;
