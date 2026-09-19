import { Schema } from 'effect';

import { commitResolutionErrorFields } from './commit-resolution-fields.ts';

const unavailableFields = {
  ...commitResolutionErrorFields,
  retryable: Schema.Literal(true),
} as const;

/**
 * The Action commit state or the governed Core read could not be determined right now
 * (indeterminate commit, transport failure, malformed evidence).  The caller should retry the
 * resolution itself — never mint a new Action invocation to work around it.
 */
export class CommerceEnrollmentCommitResolutionUnavailable extends Schema.TaggedError<CommerceEnrollmentCommitResolutionUnavailable>()(
  'CommerceEnrollmentCommitResolutionUnavailable',
  unavailableFields,
) {}
