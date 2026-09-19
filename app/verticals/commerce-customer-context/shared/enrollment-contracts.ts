import { createHash } from 'node:crypto';

import {
  ActionInvocationIdSchema,
  PrincipalIdSchema,
  ProviderSubjectIdSchema,
  TenantIdSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import { Schema } from 'effect';

import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from './portal-auth-contracts.ts';

/**
 * Shared, secret-free vocabulary for the Commerce Portal Enrollment Attempt.  This file is
 * intentionally independent of the provider database and of the private owner schema.
 */

const uuid = Schema.String.check(Schema.isUUID());
export const EnrollmentAttemptIdSchema = uuid.pipe(Schema.brand('EnrollmentAttemptId'));
export type EnrollmentAttemptId = typeof EnrollmentAttemptIdSchema.Type;
export const EnrollmentOwnerOperationIdSchema = uuid.pipe(Schema.brand('EnrollmentOwnerOperationId'));
export const EnrollmentInvitationIdSchema = uuid.pipe(Schema.brand('EnrollmentInvitationId'));
export const EnrollmentLegalEntityIdSchema = uuid.pipe(Schema.brand('EnrollmentLegalEntityId'));
export const EnrollmentActionInvocationIdSchema = ActionInvocationIdSchema;
export const EnrollmentPrincipalIdSchema = PrincipalIdSchema;
export const EnrollmentTenantIdSchema = TenantIdSchema;
export const EnrollmentLeaseTokenSchema = uuid.pipe(Schema.brand('EnrollmentLeaseToken'));
export const EnrollmentDigestSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

/**
 * The single digest primitive every Enrollment identity is derived from: one lowercase SHA-256 of
 * an already canonical encoding.  Callers own the canonicalization; nothing here inspects it, so
 * two encodings that differ only in key order must be made identical before they reach this.
 */
export const enrollmentDigest = (canonical: string): string => createHash('sha256').update(canonical).digest('hex');
export const EnrollmentBoundedTextSchema = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(500),
);
export const EnrollmentKeySchema = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
).pipe(Schema.brand('EnrollmentKey'));
export const EnrollmentModuleKeySchema = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
).pipe(Schema.brand('EnrollmentModuleKey'));
export const EnrollmentTransitionKeySchema = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
).pipe(Schema.brand('EnrollmentTransitionKey'));
export const EnrollmentResourceIdSchema = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
).pipe(Schema.brand('EnrollmentResourceId'));
export const EnrollmentEvidenceReferenceSchema = uuid.pipe(Schema.brand('EnrollmentEvidenceReference'));
/** Timestamps are UTC instants in the decoded contract; persistence adapters decode driver values. */
const EnrollmentTimestampSchema = Schema.DateTimeUtc;

/**
 * Enrollment only accepts the Commerce Portal Authentication Namespace.  The provider subject
 * shape is owned by Commerce's portal-auth contract; keeping this alias here gives the Attempt
 * API one stable vocabulary without importing any Core provider-proof schema.
 */
export const EnrollmentAuthenticationNamespaceIdSchema = Schema.Literal(COMMERCE_AUTHENTICATION_NAMESPACE_ID).pipe(
  Schema.brand('CommerceAuthenticationNamespaceId'),
);
export const EnrollmentProviderSubjectIdSchema = ProviderSubjectIdSchema;

/** The only supported workflow identities. */
export const EnrollmentJourneySchema = Schema.Literals([
  'RETAIL_SELF_ENROLLMENT',
  'COUNTERPARTY_INVITATION',
  'EXISTING_ACCOUNT',
]);

/** Overall state is derived from owner outcomes and cannot be set to COMPLETE by a caller alone. */
export const EnrollmentAttemptStateSchema = Schema.Literals([
  'IN_PROGRESS',
  'VERIFICATION_REQUIRED',
  'COMPLETE',
  'RECONCILIATION_REQUIRED',
  'TERMINATED',
]);
export type EnrollmentAttemptState = typeof EnrollmentAttemptStateSchema.Type;

/**
 * What an owner may say about its own transition, and nothing more.  COMPLETE is absent by
 * construction: completion is a property of the journey's required transitions, so it is derived
 * from the durable owner journal and can never be asserted by the owner recording one outcome.
 * TERMINATED is absent too, because termination is a separate owner Action.
 */
const EnrollmentOwnerOutcomeSignalSchema = Schema.Literals([
  'IN_PROGRESS',
  'VERIFICATION_REQUIRED',
  'RECONCILIATION_REQUIRED',
]);
export type EnrollmentOwnerOutcomeSignal = typeof EnrollmentOwnerOutcomeSignalSchema.Type;

/**
 * The Attempt states a recorded owner outcome may derive.  TERMINATED is reached only by the
 * termination Action, so it is never a derivation result.
 */
const DerivedEnrollmentAttemptStateSchema = Schema.Literals([
  'IN_PROGRESS',
  'VERIFICATION_REQUIRED',
  'COMPLETE',
  'RECONCILIATION_REQUIRED',
]);
export type DerivedEnrollmentAttemptState = typeof DerivedEnrollmentAttemptStateSchema.Type;

export const EnrollmentOwnerOperationStatusSchema = Schema.Literals([
  'IN_PROGRESS',
  'SUCCEEDED',
  'FAILED',
  'INDETERMINATE',
  'RECONCILIATION_REQUIRED',
]);
const EnrollmentFinalOwnerOutcomeSchema = Schema.Literals(['SUCCEEDED', 'FAILED']);

/** Exact account identity supplied only after authoritative provider evidence exists. */
export const CommercePortalAccountSubjectSchema = Schema.Struct({
  authenticationNamespaceId: EnrollmentAuthenticationNamespaceIdSchema,
  providerSubjectId: EnrollmentProviderSubjectIdSchema,
  subjectType: Schema.Literal('user'),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type CommercePortalAccountSubject = typeof CommercePortalAccountSubjectSchema.Type;

export const EnrollmentAttemptIntentSchema = Schema.Struct({
  intentDigest: EnrollmentDigestSchema,
  intentKey: EnrollmentKeySchema,
  invitationId: Schema.optionalKey(EnrollmentInvitationIdSchema),
  journey: EnrollmentJourneySchema,
  targetLegalEntityId: Schema.optionalKey(EnrollmentLegalEntityIdSchema),
  targetResourceId: Schema.optionalKey(EnrollmentResourceIdSchema),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

const EnrollmentAttemptLeaseSchema = Schema.Struct({
  leaseExpiresAt: EnrollmentTimestampSchema,
  leaseToken: EnrollmentLeaseTokenSchema,
  workerId: EnrollmentKeySchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type EnrollmentAttemptLease = typeof EnrollmentAttemptLeaseSchema.Type;

export const EnrollmentAttemptSnapshotSchema = Schema.Struct({
  accountSubject: Schema.optionalKey(CommercePortalAccountSubjectSchema),
  createdAt: EnrollmentTimestampSchema,
  createdByPrincipalId: EnrollmentPrincipalIdSchema,
  intentDigest: EnrollmentDigestSchema,
  intentKey: EnrollmentKeySchema,
  invitationId: Schema.optionalKey(EnrollmentInvitationIdSchema),
  journey: EnrollmentJourneySchema,
  lastFailureCode: Schema.optionalKey(EnrollmentKeySchema),
  lastFailureReason: Schema.optionalKey(EnrollmentBoundedTextSchema),
  lastOwnerInvocationId: Schema.optionalKey(EnrollmentActionInvocationIdSchema),
  lease: Schema.optionalKey(EnrollmentAttemptLeaseSchema),
  portalEnrollmentAttemptId: EnrollmentAttemptIdSchema,
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  state: EnrollmentAttemptStateSchema,
  targetLegalEntityId: Schema.optionalKey(EnrollmentLegalEntityIdSchema),
  targetResourceId: Schema.optionalKey(EnrollmentResourceIdSchema),
  tenantId: EnrollmentTenantIdSchema,
  terminatedAt: Schema.optionalKey(EnrollmentTimestampSchema),
  updatedAt: EnrollmentTimestampSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type EnrollmentAttemptSnapshot = typeof EnrollmentAttemptSnapshotSchema.Type;

export const EnrollmentOwnerOperationSnapshotSchema = Schema.Struct({
  actorPrincipalId: EnrollmentPrincipalIdSchema,
  completedAt: Schema.optionalKey(EnrollmentTimestampSchema),
  createdAt: EnrollmentTimestampSchema,
  failureCode: Schema.optionalKey(EnrollmentKeySchema),
  failureReason: Schema.optionalKey(EnrollmentBoundedTextSchema),
  lease: Schema.optionalKey(EnrollmentAttemptLeaseSchema),
  outcomeCode: Schema.optionalKey(EnrollmentKeySchema),
  ownerInvocationId: EnrollmentActionInvocationIdSchema,
  ownerModuleKey: EnrollmentModuleKeySchema,
  portalEnrollmentAttemptId: EnrollmentAttemptIdSchema,
  portalEnrollmentOwnerOperationId: EnrollmentOwnerOperationIdSchema,
  reconciliationRef: Schema.optionalKey(EnrollmentEvidenceReferenceSchema),
  requestDigest: EnrollmentDigestSchema,
  required: Schema.Boolean,
  resultDigest: Schema.optionalKey(EnrollmentDigestSchema),
  resultReference: Schema.optionalKey(EnrollmentResourceIdSchema),
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  status: EnrollmentOwnerOperationStatusSchema,
  tenantId: EnrollmentTenantIdSchema,
  transitionKey: EnrollmentTransitionKeySchema,
  updatedAt: EnrollmentTimestampSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type EnrollmentOwnerOperationSnapshot = typeof EnrollmentOwnerOperationSnapshotSchema.Type;

export const StartEnrollmentAttemptInputSchema = Schema.Struct({
  actionInvocationId: EnrollmentActionInvocationIdSchema,
  actorPrincipalId: EnrollmentPrincipalIdSchema,
  tenantId: EnrollmentTenantIdSchema,
  ...EnrollmentAttemptIntentSchema.fields,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type StartEnrollmentAttemptInput = typeof StartEnrollmentAttemptInputSchema.Type;

export const ClaimEnrollmentTransitionInputSchema = Schema.Struct({
  accountSubject: Schema.optionalKey(CommercePortalAccountSubjectSchema),
  actorPrincipalId: EnrollmentPrincipalIdSchema,
  expectedRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  leaseDurationMs: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1000),
    Schema.isLessThanOrEqualTo(900_000),
  ),
  ownerInvocationId: EnrollmentActionInvocationIdSchema,
  ownerModuleKey: EnrollmentModuleKeySchema,
  portalEnrollmentAttemptId: EnrollmentAttemptIdSchema,
  requestDigest: EnrollmentDigestSchema,
  required: Schema.Boolean,
  tenantId: EnrollmentTenantIdSchema,
  transitionKey: EnrollmentTransitionKeySchema,
  workerId: EnrollmentKeySchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type ClaimEnrollmentTransitionInput = typeof ClaimEnrollmentTransitionInputSchema.Type;

export const RecordEnrollmentOutcomeInputSchema = Schema.Struct({
  accountSubject: Schema.optionalKey(CommercePortalAccountSubjectSchema),
  actorPrincipalId: EnrollmentPrincipalIdSchema,
  expectedRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  failureCode: Schema.optionalKey(EnrollmentKeySchema),
  failureReason: Schema.optionalKey(EnrollmentBoundedTextSchema),
  leaseToken: EnrollmentLeaseTokenSchema,
  /** The owner's own signal about this transition; it never names the Attempt's next state. */
  nextState: Schema.optionalKey(EnrollmentOwnerOutcomeSignalSchema),
  outcomeCode: Schema.optionalKey(EnrollmentKeySchema),
  ownerInvocationId: EnrollmentActionInvocationIdSchema,
  ownerModuleKey: EnrollmentModuleKeySchema,
  portalEnrollmentAttemptId: EnrollmentAttemptIdSchema,
  resultDigest: Schema.optionalKey(EnrollmentDigestSchema),
  resultReference: Schema.optionalKey(EnrollmentResourceIdSchema),
  status: EnrollmentFinalOwnerOutcomeSchema,
  tenantId: EnrollmentTenantIdSchema,
  transitionKey: EnrollmentTransitionKeySchema,
  workerId: EnrollmentKeySchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type RecordEnrollmentOutcomeInput = typeof RecordEnrollmentOutcomeInputSchema.Type;

/**
 * A reconciliation is a separately governed owner operation.  It names the immutable original
 * invocation and carries the opaque evidence reference returned by that owner's authoritative
 * lookup.  It deliberately has no worker or lease token: a stale worker cannot resolve an
 * indeterminate provider effect by guessing the latest Attempt revision.
 */
export const ReconcileEnrollmentOutcomeInputSchema = Schema.Struct({
  accountSubject: Schema.optionalKey(CommercePortalAccountSubjectSchema),
  actorPrincipalId: EnrollmentPrincipalIdSchema,
  expectedRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  failureCode: Schema.optionalKey(EnrollmentKeySchema),
  failureReason: Schema.optionalKey(EnrollmentBoundedTextSchema),
  /** The owner's own signal about this transition; it never names the Attempt's next state. */
  nextState: Schema.optionalKey(EnrollmentOwnerOutcomeSignalSchema),
  outcomeCode: Schema.optionalKey(EnrollmentKeySchema),
  ownerInvocationId: EnrollmentActionInvocationIdSchema,
  ownerModuleKey: EnrollmentModuleKeySchema,
  portalEnrollmentAttemptId: EnrollmentAttemptIdSchema,
  reconciliationRef: EnrollmentEvidenceReferenceSchema,
  resultDigest: Schema.optionalKey(EnrollmentDigestSchema),
  resultReference: Schema.optionalKey(EnrollmentResourceIdSchema),
  status: EnrollmentFinalOwnerOutcomeSchema,
  tenantId: EnrollmentTenantIdSchema,
  transitionKey: EnrollmentTransitionKeySchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type ReconcileEnrollmentOutcomeInput = typeof ReconcileEnrollmentOutcomeInputSchema.Type;

/** Untrusted recovery request.  Final outcome metadata is supplied by the injected owner authority. */
export const ReconcileEnrollmentRequestSchema = Schema.Struct({
  expectedRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  ownerInvocationId: EnrollmentActionInvocationIdSchema,
  ownerModuleKey: EnrollmentModuleKeySchema,
  portalEnrollmentAttemptId: EnrollmentAttemptIdSchema,
  tenantId: EnrollmentTenantIdSchema,
  transitionKey: EnrollmentTransitionKeySchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type ReconcileEnrollmentRequest = typeof ReconcileEnrollmentRequestSchema.Type;

/** Verified owner resolution.  The reconciliation reference is emitted by the owner lookup. */
export const ReconcileEnrollmentResolutionSchema = Schema.Struct({
  /** Provider identity may be established only by the trusted owner lookup. */
  accountSubject: Schema.optionalKey(CommercePortalAccountSubjectSchema),
  actorPrincipalId: EnrollmentPrincipalIdSchema,
  failureCode: Schema.optionalKey(EnrollmentKeySchema),
  failureReason: Schema.optionalKey(EnrollmentBoundedTextSchema),
  /** The owner's own signal about this transition; it never names the Attempt's next state. */
  nextState: Schema.optionalKey(EnrollmentOwnerOutcomeSignalSchema),
  outcomeCode: Schema.optionalKey(EnrollmentKeySchema),
  reconciliationRef: EnrollmentEvidenceReferenceSchema,
  resultDigest: Schema.optionalKey(EnrollmentDigestSchema),
  resultReference: Schema.optionalKey(EnrollmentResourceIdSchema),
  status: EnrollmentFinalOwnerOutcomeSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type ReconcileEnrollmentResolution = typeof ReconcileEnrollmentResolutionSchema.Type;

export const TerminateEnrollmentAttemptInputSchema = Schema.Struct({
  actionInvocationId: EnrollmentActionInvocationIdSchema,
  actorPrincipalId: EnrollmentPrincipalIdSchema,
  expectedRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  portalEnrollmentAttemptId: EnrollmentAttemptIdSchema,
  reason: EnrollmentBoundedTextSchema,
  tenantId: EnrollmentTenantIdSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type TerminateEnrollmentAttemptInput = typeof TerminateEnrollmentAttemptInputSchema.Type;

export const ReadEnrollmentAttemptInputSchema = Schema.Struct({
  portalEnrollmentAttemptId: EnrollmentAttemptIdSchema,
  tenantId: EnrollmentTenantIdSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type ReadEnrollmentAttemptInput = typeof ReadEnrollmentAttemptInputSchema.Type;

export const ReadEnrollmentOwnerOperationInputSchema = Schema.Struct({
  ownerModuleKey: EnrollmentModuleKeySchema,
  portalEnrollmentAttemptId: EnrollmentAttemptIdSchema,
  tenantId: EnrollmentTenantIdSchema,
  transitionKey: EnrollmentTransitionKeySchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type ReadEnrollmentOwnerOperationInput = typeof ReadEnrollmentOwnerOperationInputSchema.Type;

export const VerifyEnrollmentProofInputSchema = Schema.Struct({
  portalEnrollmentAttemptId: EnrollmentAttemptIdSchema,
  tenantId: EnrollmentTenantIdSchema,
  ...CommercePortalAccountSubjectSchema.fields,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

export const EnrollmentProofSchema = Schema.Struct({
  enrollmentAttemptId: EnrollmentAttemptIdSchema,
  evidenceRef: EnrollmentEvidenceReferenceSchema,
  observedAt: Schema.DateTimeUtc,
  policyVersion: EnrollmentKeySchema,
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

export const isEnrollmentAttemptTerminal = (state: EnrollmentAttemptState): boolean =>
  state === 'COMPLETE' || state === 'TERMINATED';
