import { Schema } from 'effect';

import {
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentBoundedTextSchema,
} from '../../../shared/enrollment-contracts.ts';

const EnrollmentAttemptErrorCodeSchema = Schema.Literals([
  'attempt_invalid',
  'attempt_not_found',
  'attempt_conflict',
  'attempt_revision_conflict',
  'attempt_lease_conflict',
  'attempt_terminal',
  'attempt_indeterminate',
  'attempt_unavailable',
]);

/** Closed, safe error vocabulary at the Commerce Attempt boundary. */
const rejectedFields = {
  attemptId: Schema.optionalKey(EnrollmentAttemptIdSchema),
  code: EnrollmentAttemptErrorCodeSchema,
  reason: EnrollmentBoundedTextSchema,
  retryable: Schema.Boolean,
} as const;
const CommerceEnrollmentAttemptRejectedSchema = Schema.TaggedStruct(
  'CommerceEnrollmentAttemptRejected',
  rejectedFields,
);
export const CommerceEnrollmentAttemptRejected = Schema.TaggedError<
  typeof CommerceEnrollmentAttemptRejectedSchema.Type
>()('CommerceEnrollmentAttemptRejected', rejectedFields);

const unavailableFields = {
  attemptId: Schema.optionalKey(EnrollmentAttemptIdSchema),
  code: Schema.Literal('attempt_unavailable'),
  reason: EnrollmentBoundedTextSchema,
  retryable: Schema.Literal(true),
} as const;
const CommerceEnrollmentAttemptUnavailableSchema = Schema.TaggedStruct(
  'CommerceEnrollmentAttemptUnavailable',
  unavailableFields,
);
export const CommerceEnrollmentAttemptUnavailable = Schema.TaggedError<
  typeof CommerceEnrollmentAttemptUnavailableSchema.Type
>()('CommerceEnrollmentAttemptUnavailable', unavailableFields);

const notFoundFields = {
  attemptId: EnrollmentAttemptIdSchema,
  code: Schema.Literal('attempt_not_found'),
  reason: EnrollmentBoundedTextSchema,
  retryable: Schema.Literal(false),
} as const;
const CommerceEnrollmentAttemptNotFoundSchema = Schema.TaggedStruct(
  'CommerceEnrollmentAttemptNotFound',
  notFoundFields,
);
export const CommerceEnrollmentAttemptNotFound = Schema.TaggedError<
  typeof CommerceEnrollmentAttemptNotFoundSchema.Type
>()('CommerceEnrollmentAttemptNotFound', notFoundFields);

const conflictFields = {
  attemptId: Schema.optionalKey(EnrollmentAttemptIdSchema),
  code: Schema.Literals(['attempt_conflict', 'attempt_revision_conflict', 'attempt_lease_conflict']),
  reason: EnrollmentBoundedTextSchema,
  retryable: Schema.Boolean,
} as const;
const CommerceEnrollmentAttemptConflictSchema = Schema.TaggedStruct(
  'CommerceEnrollmentAttemptConflict',
  conflictFields,
);
export const CommerceEnrollmentAttemptConflict = Schema.TaggedError<
  typeof CommerceEnrollmentAttemptConflictSchema.Type
>()('CommerceEnrollmentAttemptConflict', conflictFields);

const indeterminateFields = {
  attemptId: EnrollmentAttemptIdSchema,
  code: Schema.Literal('attempt_indeterminate'),
  ownerInvocationId: Schema.optionalKey(EnrollmentActionInvocationIdSchema),
  reason: EnrollmentBoundedTextSchema,
  retryable: Schema.Literal(true),
} as const;
const CommerceEnrollmentAttemptIndeterminateSchema = Schema.TaggedStruct(
  'CommerceEnrollmentAttemptIndeterminate',
  indeterminateFields,
);
export const CommerceEnrollmentAttemptIndeterminate = Schema.TaggedError<
  typeof CommerceEnrollmentAttemptIndeterminateSchema.Type
>()('CommerceEnrollmentAttemptIndeterminate', indeterminateFields);

/**
 * One authority for narrowing an arbitrary transaction failure to the closed Attempt vocabulary.
 * A failure that is not in this union came from the database or transaction machinery, never from
 * an Attempt routine, and must never be reported as a definitive Attempt outcome.
 */
export const CommerceEnrollmentAttemptErrorSchema = Schema.Union([
  CommerceEnrollmentAttemptRejected,
  CommerceEnrollmentAttemptUnavailable,
  CommerceEnrollmentAttemptNotFound,
  CommerceEnrollmentAttemptConflict,
  CommerceEnrollmentAttemptIndeterminate,
]);

export type CommerceEnrollmentAttemptError =
  | InstanceType<typeof CommerceEnrollmentAttemptRejected>
  | InstanceType<typeof CommerceEnrollmentAttemptUnavailable>
  | InstanceType<typeof CommerceEnrollmentAttemptNotFound>
  | InstanceType<typeof CommerceEnrollmentAttemptConflict>
  | InstanceType<typeof CommerceEnrollmentAttemptIndeterminate>;
