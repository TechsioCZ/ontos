import { Schema } from 'effect';

/**
 * Every refusal the store proves itself carries one code and a reason naming the record that broke
 * the rule, so a caller matches a code instead of free text. They all mean the same thing: nothing
 * was written, and retrying the same plan is not how it is repaired.
 */
export const ACCESS_CHANGES_STORE_CONFLICT_CODES = [
  'access_changes_catalog_conflict',
  'access_changes_item_not_pending',
  'access_changes_record_conflict',
  'access_changes_revision_stale',
  'access_changes_role_revision_missing',
  'access_changes_scope_mismatch',
  'access_changes_undo_not_an_adoption',
  /** PostgreSQL itself refused the row: an integrity constraint or an access trigger proved it cannot be stored. */
  'access_changes_write_refused',
] as const;

export type AccessChangesStoreConflictCode = (typeof ACCESS_CHANGES_STORE_CONFLICT_CODES)[number];

/**
 * A compare-and-set lost, a plan was built from a stale read, or PostgreSQL refused the write. The
 * caller re-reads the tenant's intent; retrying the same plan is not how this is repaired.
 */
export class AccessChangesStoreConflictError extends Schema.TaggedError<AccessChangesStoreConflictError>()(
  'AccessChangesStoreConflictError',
  {
    code: Schema.Literals(ACCESS_CHANGES_STORE_CONFLICT_CODES),
    reason: Schema.String,
  },
) {}

export const storeConflict = (code: AccessChangesStoreConflictCode, reason: string): AccessChangesStoreConflictError =>
  new AccessChangesStoreConflictError({ code, reason });
