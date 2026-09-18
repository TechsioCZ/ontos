import { Schema } from 'effect';

import {
  CommerceEnrollmentAttemptConflict,
  CommerceEnrollmentAttemptIndeterminate,
  CommerceEnrollmentAttemptNotFound,
  CommerceEnrollmentAttemptRejected,
  CommerceEnrollmentAttemptUnavailable,
} from '../attempts/errors.ts';

/**
 * The four public Attempt Actions expose the same closed owner error vocabulary.  Keeping this
 * union in the owner orchestration boundary lets Codesmith project the errors without importing
 * private persistence or provider implementations into a generated HTTP contract.
 */
export const CommerceEnrollmentAttemptActionErrorSchema = Schema.Union([
  CommerceEnrollmentAttemptConflict,
  CommerceEnrollmentAttemptIndeterminate,
  CommerceEnrollmentAttemptNotFound,
  CommerceEnrollmentAttemptRejected,
  CommerceEnrollmentAttemptUnavailable,
]);
