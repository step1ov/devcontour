export interface ProcessRow {
  pid: number;
  ppid: number;
  start: string;
  command: string;
  mark?: string;
}
export function parseRows(stdout: string): ProcessRow[];
export function findOrphans(
  rows: ProcessRow[],
  self?: number,
): Map<number, { start: string; why: string }>;
export function sweepOrphans(options?: {
  log?: (line: string) => void;
  graceMs?: number;
}): Promise<number>;
