import {
  ProviderSubjectIdSchema,
  TenantIdSchema,
  BindingRevisionSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import { Schema } from 'effect';

export { COMMERCE_CUSTOMER_CONTEXT_API_PREFIX } from './deployment-paths.ts';

export const COMMERCE_AUTHENTICATION_NAMESPACE_ID = 'ontos.commerce.portal.better-auth.v1';
export const COMMERCE_ADMISSION_DEADLINE_MS = 5000;
const boundedReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const uuid = Schema.String.check(Schema.isUUID());
const EnrollmentAttemptIdSchema = uuid.pipe(Schema.brand('EnrollmentAttemptId'));
export const CommerceSessionReferenceSchema = Schema.String.check(
  Schema.isPattern(/^better-auth-session:ontos\.commerce\.portal\.better-auth\.v1:[A-Za-z0-9_-]{1,200}$/u),
);
export const ExternalUserSubjectSchema = Schema.Struct({
  authenticationNamespaceId: Schema.Literal(COMMERCE_AUTHENTICATION_NAMESPACE_ID),
  providerSubjectId: ProviderSubjectIdSchema,
  subjectType: Schema.Literal('user'),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type ExternalUserSubject = typeof ExternalUserSubjectSchema.Type;
/** Private service-to-service proof input; never included in a gateway assertion. */
export const VerifyExternalAuthenticationRequestSchema = Schema.Struct({
  ...ExternalUserSubjectSchema.fields,
  enrollmentAttemptId: Schema.optionalKey(EnrollmentAttemptIdSchema),
  nonce: uuid,
  sessionRef: CommerceSessionReferenceSchema,
  tenantId: TenantIdSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export const VerifyExternalAuthenticationResultSchema = Schema.Union([
  Schema.Struct({
    ...VerifyExternalAuthenticationRequestSchema.fields,
    authenticatedAt: Schema.DateTimeUtc,
    emailVerified: Schema.Boolean,
    enrollmentProof: Schema.optionalKey(
      Schema.Struct({
        enrollmentAttemptId: EnrollmentAttemptIdSchema,
        evidenceRef: uuid,
        observedAt: Schema.DateTimeUtc,
        policyVersion: boundedReference,
        revision: BindingRevisionSchema,
      }),
    ),
    observedAt: Schema.DateTimeUtc,
    outcome: Schema.Literal('ALLOWED'),
    stepUpAt: Schema.optionalKey(Schema.DateTimeUtc),
  }),
  Schema.Struct({ nonce: uuid, observedAt: Schema.DateTimeUtc, outcome: Schema.Literal('REJECTED') }),
  Schema.Struct({ nonce: uuid, observedAt: Schema.DateTimeUtc, outcome: Schema.Literal('UNAVAILABLE') }),
]).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type VerifyExternalAuthenticationRequest = typeof VerifyExternalAuthenticationRequestSchema.Type;
export type VerifyExternalAuthenticationResult = typeof VerifyExternalAuthenticationResultSchema.Type;
