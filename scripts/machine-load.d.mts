export interface LoadMeasurement {
  busy: number;
  pageoutsPerSecond?: number;
  swapFreeMb?: number;
  load1: number;
  cores: number;
}
export function swapFreeMb(): number | undefined;
export function measureLoad(ms?: number): Promise<LoadMeasurement>;
export function describeLoad(m: LoadMeasurement): string;
export const QUIET: { maxBusy: number; minSwapFreeMb: number; maxPageoutsPerSecond: number };
export function busyReason(m: LoadMeasurement, limits?: typeof QUIET): string | undefined;
export function waitForQuiet(options: {
  waitMs: number;
  log?: (line: string) => void;
  measure?: (ms?: number) => Promise<LoadMeasurement>;
  intervalMs?: number;
}): Promise<{ quiet: boolean; measurement: LoadMeasurement }>;
