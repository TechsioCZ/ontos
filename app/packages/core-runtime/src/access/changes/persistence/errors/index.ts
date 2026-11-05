import type { AccessChangesStoreConflictError } from './conflict-error.ts';
import type { AccessChangesStoreUnavailableError } from './unavailable-error.ts';

/**
 * What the Access changes store can refuse with: a conflict the caller repairs by re-reading, or
 * retryable unavailability. Nothing else escapes the adapter.
 */
export type AccessChangesStoreError = AccessChangesStoreConflictError | AccessChangesStoreUnavailableError;

export { storeConflict } from './conflict-error.ts';
export { storeUnavailable } from './unavailable-error.ts';
