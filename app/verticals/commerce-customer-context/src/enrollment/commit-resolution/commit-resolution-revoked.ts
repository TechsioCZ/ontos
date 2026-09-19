import { Schema } from 'effect';

import { AuthBindingStatusSchema } from '@app/core-runtime/auth/external-identity-contracts';

import { commitResolutionErrorFields } from './commit-resolution-fields.ts';

const revokedFields = {
  ...commitResolutionErrorFields,
  bindingStatus: AuthBindingStatusSchema,
  retryable: Schema.Literal(false),
} as const;

/**
 * T20: the exact original invocation IS on record as historically committed (the governed Core
 * read matches this invocation's own provenance), but the retained binding is no longer current
 * (`disabled` or `revoked`).  Treating this as a success would resurrect authority a later
 * administrative transition already withdrew, so resolution fails closed instead.  Not retryable
 * by re-resolving the same invocation; the caller must route to reconciliation.
 */
export class CommerceEnrollmentCommitResolutionRevoked extends Schema.TaggedError<CommerceEnrollmentCommitResolutionRevoked>()(
  'CommerceEnrollmentCommitResolutionRevoked',
  revokedFields,
) {}
