import { Schema } from 'effect';

/**
 * Every refusal the access intent stores and the tenant intent loader prove themselves carries one
 * code and a reason naming the record that broke the rule, so a caller matches a code instead of free
 * text. They all mean the same thing: nothing was written or served, because the intent the caller
 * acted on has already moved or belongs to another tenant.
 */
export const ACCESS_INTENT_CONFLICT_CODES = [
  'access_intent_catalog_missing',
  'access_intent_record_conflict',
  'access_intent_scope_mismatch',
  'access_intent_status_terminated',
  'access_intent_write_refused',
] as const;

export type AccessIntentConflictCode = (typeof ACCESS_INTENT_CONFLICT_CODES)[number];

/**
 * A compare-and-set lost, a command named another tenant or another acting person than the installed
 * scope, or the intent itself is inconsistent. The caller re-reads the tenant's intent; retrying the
 * same command unchanged is not how this is repaired.
 */
export class AccessIntentConflictError extends Schema.TaggedError<AccessIntentConflictError>()(
  'AccessIntentConflictError',
  {
    code: Schema.Literals(ACCESS_INTENT_CONFLICT_CODES),
    reason: Schema.String,
  },
) {}

export const intentConflict = (code: AccessIntentConflictCode, reason: string): AccessIntentConflictError =>
  new AccessIntentConflictError({ code, reason });
