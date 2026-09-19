import {
  ProviderSubjectIdSchema,
  TenantIdSchema,
  BindingRevisionSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import { Schema } from 'effect';

export { COMMERCE_CUSTOMER_CONTEXT_API_PREFIX } from './deployment-paths.ts';

export const COMMERCE_AUTHENTICATION_NAMESPACE_ID = 'ontos.commerce.portal.better-auth.v1';
export const COMMERCE_ADMISSION_DEADLINE_MS = 5000;
/**
 * Commerce-facing named outcome for a denied operation whose Core-side cause is
 * `OperationAuthenticationRequired` (`@app/core-runtime`,
 * `packages/core-runtime/src/operations/operation-authentication-required.ts`) — the acting
 * Principal's Auth Binding is not Current for the Tenant/operation being attempted. Core expresses
 * this generically as `OperationAuthenticationRequired`; Commerce names the same outcome
 * `PRINCIPAL_AUTH_BINDING_NOT_CURRENT` so its own callers, docs and audit trail do not have to carry
 * Core's internal error tag. The mapping site is `api/portal-auth/admission/adapter.ts`'s
 * `mapCoreFailure`, which turns every `ExternalIdentityFailure` other than `identity_unavailable`
 * into an `OperationAuthenticationRequired` — that is the Core failure this constant names for
 * Commerce.
 */
export const PRINCIPAL_AUTH_BINDING_NOT_CURRENT = 'PRINCIPAL_AUTH_BINDING_NOT_CURRENT' as const;
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
