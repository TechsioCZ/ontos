import type { AccessIntentConflictError } from './errors/conflict-error.ts';
import type { AccessIntentUnavailableError } from './errors/unavailable-error.ts';

/*
 * The failures the access intent stores and the tenant intent loader can end with. A conflict is
 * repaired by re-reading the tenant's intent; an unavailability is retried unchanged.
 */

export { intentConflict } from './errors/conflict-error.ts';
export { intentUnavailable } from './errors/unavailable-error.ts';

/** What the access intent stores and the loader can refuse with: a repairable conflict or a retry. */
export type AccessIntentError = AccessIntentConflictError | AccessIntentUnavailableError;
