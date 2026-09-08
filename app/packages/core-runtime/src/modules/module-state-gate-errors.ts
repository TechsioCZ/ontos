import type { ModuleStateCheckUnavailableError } from './module-state-check-unavailable-error.ts';
import type { ModuleStateDeniedError } from './module-state-denied-error.ts';

export { ModuleStateCheckUnavailableError } from './module-state-check-unavailable-error.ts';
export { ModuleStateDeniedError } from './module-state-denied-error.ts';

export type ModuleStateGateError =
  | ModuleStateCheckUnavailableError
  | ModuleStateDeniedError;
