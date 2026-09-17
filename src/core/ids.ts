import { randomUUID } from 'node:crypto';
import type { HarnessState } from './model.ts';

// The sequence remains for old databases; identity must survive independent clones.
export function entityId(state: HarnessState, prefix: string) {
  state.sequence++;
  return `${prefix}-${randomUUID()}`;
}
