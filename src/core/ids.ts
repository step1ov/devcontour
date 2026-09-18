import { randomUUID } from 'node:crypto';
import type { DevContourState } from './model.ts';

// The sequence remains for old databases; identity must survive independent clones.
export function entityId(state: DevContourState, prefix: string) {
  state.sequence++;
  return `${prefix}-${randomUUID()}`;
}
