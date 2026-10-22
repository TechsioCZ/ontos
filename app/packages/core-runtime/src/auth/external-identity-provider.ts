/**
 * External identity providers a module offers through its contract.
 *
 * A module whose own sign-in issues subjects in an Authentication Namespace declares the namespace, how long one of
 * its observations may back an admission, and the private verification endpoint on its BFF. The Shell installs the
 * provider from deployment data keyed by that namespace and calls the declared endpoint with the generic
 * verification request below; Core and the Shell never name the module.
 */
import { Schema } from 'effect';

import {
  AuthenticationNamespaceIdSchema,
  BindingRevisionSchema,
  ProviderSubjectIdSchema,
  TenantIdSchema,
} from './external-identity-contracts.ts';

const boundedReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const uuid = Schema.String.check(Schema.isUUID());
const EnrollmentAttemptIdSchema = uuid.pipe(Schema.brand('EnrollmentAttemptId'));

export const OntosExternalIdentityProviderSchema = Schema.Struct({
  /** Longest time one provider observation may back an admission, in milliseconds. */
  admissionDeadlineMs: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ maximum: 60_000, minimum: 1 })),
  authenticationNamespaceId: AuthenticationNamespaceIdSchema,
  /** Provider name recorded on the Auth Bindings of this namespace. */
  provider: boundedReference,
  verification: Schema.Struct({
    /** Operation name every verification request carries. */
    operation: boundedReference,
    /** POST path of the private verification endpoint on the module BFF, relative to `/<appId>-api`. */
    path: Schema.String.check(Schema.isPattern(/^\/[a-z0-9/-]+$/u)),
  }),
});
export type OntosExternalIdentityProvider = typeof OntosExternalIdentityProviderSchema.Type;
/** What a module authors in its manifest; the manifest decodes it into {@link OntosExternalIdentityProvider}. */
export type OntosExternalIdentityProviderInput = typeof OntosExternalIdentityProviderSchema.Encoded;

/** What the Shell sends to a provider's verification endpoint. */
export const ExternalIdentityVerificationRequestSchema = Schema.Struct({
  /** The audience the provider endpoint receives the request on. */
  audience: boundedReference,
  authenticationNamespaceId: AuthenticationNamespaceIdSchema,
  enrollmentAttemptId: Schema.optionalKey(EnrollmentAttemptIdSchema),
  nonce: uuid,
  operation: boundedReference,
  operationRef: boundedReference,
  providerSubjectId: ProviderSubjectIdSchema,
  sessionRef: boundedReference,
  subjectType: Schema.Literal('user'),
  tenantId: TenantIdSchema,
});
export type ExternalIdentityVerificationRequest = typeof ExternalIdentityVerificationRequestSchema.Type;

/** What a provider answers: an exact echo of the verified subject, or a rejection or unavailability. */
export const ExternalIdentityVerificationResultSchema = Schema.Union([
  Schema.Struct({
    authenticatedAt: Schema.DateTimeUtc,
    authenticationNamespaceId: AuthenticationNamespaceIdSchema,
    emailVerified: Schema.Boolean,
    enrollmentAttemptId: Schema.optionalKey(EnrollmentAttemptIdSchema),
    enrollmentProof: Schema.optionalKey(
      Schema.Struct({
        enrollmentAttemptId: EnrollmentAttemptIdSchema,
        evidenceRef: uuid,
        observedAt: Schema.DateTimeUtc,
        policyVersion: boundedReference,
        revision: BindingRevisionSchema,
      }),
    ),
    nonce: uuid,
    observedAt: Schema.DateTimeUtc,
    outcome: Schema.Literal('ALLOWED'),
    providerSubjectId: ProviderSubjectIdSchema,
    sessionRef: boundedReference,
    stepUpAt: Schema.optionalKey(Schema.DateTimeUtc),
    subjectType: Schema.Literal('user'),
    tenantId: TenantIdSchema,
  }),
  Schema.Struct({ nonce: uuid, observedAt: Schema.DateTimeUtc, outcome: Schema.Literal('REJECTED') }),
  Schema.Struct({ nonce: uuid, observedAt: Schema.DateTimeUtc, outcome: Schema.Literal('UNAVAILABLE') }),
]);
export type ExternalIdentityVerificationResult = typeof ExternalIdentityVerificationResultSchema.Type;
