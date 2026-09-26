import { Schema } from 'effect';

import {
  AuthBindingIdSchema,
  BindingRevisionSchema,
  PrincipalIdSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import type { ExternalIdentityClientOptions } from '@app/shared-contracts/server/external-identity-client';

import { EnrollmentActionInvocationIdSchema } from '../../../shared/enrollment-contracts.ts';
import type { CommercePortalAccountSubject, EnrollmentTenantIdSchema } from '../../../shared/enrollment-contracts.ts';

/**
 * The retained Core Principal + Auth Binding pair backing a namespace-qualified subject.  Core's
 * own storage invariant guarantees at most one of these exists per exact subject, so this shape
 * is the single "converged" answer every attempt against that subject must agree on.
 */
export const EnrollmentRetainedCorePairSchema = Schema.Struct({
  authBindingId: AuthBindingIdSchema,
  bindingRevision: BindingRevisionSchema,
  principalId: PrincipalIdSchema,
});
export type EnrollmentRetainedCorePair = typeof EnrollmentRetainedCorePairSchema.Type;

/**
 * The Action write has not settled yet; nothing has been dispatched to converge against.  Not
 * independently exported: no caller decodes a bare "Open" payload on its own, only the union
 * below.
 */
const EnrollmentCommitResolutionOpenSchema = Schema.TaggedStruct('EnrollmentCommitResolutionOpen', {
  invocationId: EnrollmentActionInvocationIdSchema,
});

/**
 * The original invocation is confirmed committed.  `retainedBinding` is populated only when the
 * caller asked for an identity convergence check and the governed Core read confirmed the
 * binding it found was produced by this exact invocation.
 */
export const EnrollmentCommitResolutionCommittedSchema = Schema.TaggedStruct('EnrollmentCommitResolutionCommitted', {
  invocationId: EnrollmentActionInvocationIdSchema,
  retainedBinding: Schema.optionalKey(EnrollmentRetainedCorePairSchema),
});

/**
 * Two different attempts targeted the same exact namespace-qualified subject.  Core's own
 * invariant already deduplicated them onto one retained pair, produced by `convergedInvocationId`
 * rather than by the caller's own `invocationId`.  The caller must absorb this pair as the
 * canonical result and must never treat its own attempt as a distinct, still-pending effect.
 */
export const EnrollmentCommitResolutionConvergedSchema = Schema.TaggedStruct('EnrollmentCommitResolutionConverged', {
  convergedInvocationId: EnrollmentActionInvocationIdSchema,
  invocationId: EnrollmentActionInvocationIdSchema,
  retainedBinding: EnrollmentRetainedCorePairSchema,
});

/**
 * The Action itself did not commit, but `retainedBinding`, when present, records that the owner
 * effect landed in Core anyway (e.g. the HTTP reservation succeeded before the local transaction
 * that would have acknowledged it failed).  This is the "actual partial state" a failure after an
 * owner commit must record rather than silently discard.
 */
export const EnrollmentCommitResolutionPartialFailureSchema = Schema.TaggedStruct(
  'EnrollmentCommitResolutionPartialFailure',
  {
    invocationId: EnrollmentActionInvocationIdSchema,
    retainedBinding: Schema.optionalKey(EnrollmentRetainedCorePairSchema),
  },
);

export const EnrollmentCommitResolutionOutcomeSchema = Schema.Union([
  EnrollmentCommitResolutionOpenSchema,
  EnrollmentCommitResolutionCommittedSchema,
  EnrollmentCommitResolutionConvergedSchema,
  EnrollmentCommitResolutionPartialFailureSchema,
]);
export type EnrollmentCommitResolutionOutcome = typeof EnrollmentCommitResolutionOutcomeSchema.Type;

/**
 * Supplied only when the enrollment Action correlates to a Core identity owner transition.
 * Omitting it keeps resolution to the Action's own commit state, with no Core read attempted.
 */
export interface EnrollmentCommitResolutionIdentityRead {
  readonly accountSubject: CommercePortalAccountSubject;
  readonly clientOptions: ExternalIdentityClientOptions;
}

/**
 * `principal` is forwarded opaquely to `ActionRuntime.resolveActionCommit`, matching that
 * service's own `ResolveActionCommitInput` contract; it is never schema-decoded here.
 */
export interface EnrollmentCommitResolutionInput {
  readonly identityRead?: EnrollmentCommitResolutionIdentityRead;
  readonly originalInvocationId: typeof EnrollmentActionInvocationIdSchema.Type;
  readonly principal: unknown;
  readonly tenantId: typeof EnrollmentTenantIdSchema.Type;
}
