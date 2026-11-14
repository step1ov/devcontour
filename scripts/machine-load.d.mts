export interface LoadMeasurement {
  busy: number;
  swapOutsPerSecond?: number;
  memoryAvailablePercent?: number;
  load1: number;
  cores: number;
}
export function memoryAvailablePercent(): number | undefined;
export function swapOuts(): number | undefined;
export function measureLoad(ms?: number, signal?: AbortSignal): Promise<LoadMeasurement>;
export function describeLoad(m: LoadMeasurement): string;
export const QUIET: {
  maxBusy: number;
  minMemoryAvailablePercent: number;
  maxSwapOutsPerSecond: number;
};
export function busyReason(m: LoadMeasurement, limits?: typeof QUIET): string | undefined;
export function waitForQuiet(options: {
  waitMs: number;
  log?: (line: string) => void;
  measure?: (ms?: number) => Promise<LoadMeasurement>;
  intervalMs?: number;
}): Promise<{ quiet: boolean; measurement: LoadMeasurement }>;
