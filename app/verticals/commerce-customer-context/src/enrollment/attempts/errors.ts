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

/**
 * The original failure is kept as a non-enumerable `cause`, so it reaches a log without widening
 * the closed error vocabulary or leaking into an encoded boundary payload.
 */
export const withCause = <Value extends object>(value: Value, cause: unknown): Value =>
  Object.defineProperty(value, 'cause', { configurable: false, enumerable: false, value: cause });

type EnrollmentAttemptId = typeof EnrollmentAttemptIdSchema.Type;

/** A definitive Attempt refusal: the request can never succeed as written. */
export const attemptRejected = (
  reason: string,
  attemptId?: EnrollmentAttemptId,
  cause?: unknown,
): CommerceEnrollmentAttemptError => {
  const fields = { code: 'attempt_invalid', reason: reason.slice(0, 500), retryable: false } as const;
  const error =
    attemptId === undefined
      ? new CommerceEnrollmentAttemptRejected(fields)
      : new CommerceEnrollmentAttemptRejected({ ...fields, attemptId });
  return cause === undefined ? error : withCause(error, cause);
};

/** A retryable Attempt refusal: the durable routines remain the only authority on what happened. */
export const attemptUnavailable = (
  reason: string,
  attemptId?: EnrollmentAttemptId,
  cause?: unknown,
): CommerceEnrollmentAttemptError => {
  const fields = { code: 'attempt_unavailable', reason: reason.slice(0, 500), retryable: true } as const;
  const error =
    attemptId === undefined
      ? new CommerceEnrollmentAttemptUnavailable(fields)
      : new CommerceEnrollmentAttemptUnavailable({ ...fields, attemptId });
  return cause === undefined ? error : withCause(error, cause);
};
