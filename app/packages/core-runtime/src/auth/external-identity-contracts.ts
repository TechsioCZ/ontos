import { Schema } from 'effect';

const uuid = Schema.String.check(Schema.isUUID());
export const PrincipalIdSchema = uuid.pipe(Schema.brand('PrincipalId'));
export const AuthBindingIdSchema = uuid.pipe(Schema.brand('AuthBindingId'));
export const TenantIdSchema = uuid.pipe(Schema.brand('TenantId'));
export const ActionInvocationIdSchema = uuid.pipe(Schema.brand('ActionInvocationId'));
const boundedReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
export const ProviderSubjectIdSchema = boundedReference.pipe(Schema.brand('ProviderSubjectId'));
export const BindingSubjectTypeSchema = Schema.Literals(['user', 'api_key']);
export const AuthenticationNamespaceIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isTrimmed(),
).pipe(Schema.brand('AuthenticationNamespaceId'));
export const BindingRevisionSchema = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const AuthBindingStatusSchema = Schema.Literals(['pending', 'active', 'disabled', 'revoked']);
export const ExternalAuthenticationSubjectSchema = Schema.Struct({
  authenticationNamespaceId: AuthenticationNamespaceIdSchema,
  providerSubjectId: ProviderSubjectIdSchema,
  subjectType: BindingSubjectTypeSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type ExternalAuthenticationSubject = typeof ExternalAuthenticationSubjectSchema.Type;

/** Trusted deployment data. This schema alone never grants authentication authority. */
export const AuthenticationNamespaceRegistrationSchema = Schema.Struct({
  allowedAudiences: Schema.Array(boundedReference).check(Schema.isMinLength(1)),
  authenticationNamespaceId: AuthenticationNamespaceIdSchema,
  provider: boundedReference,
  requiresOperationAdmission: Schema.Boolean,
  reservationPrincipalKind: Schema.Literals(['human', 'service', 'integration']),
  subjectTypes: Schema.Array(BindingSubjectTypeSchema).check(Schema.isMinLength(1)),
  trustedAttesterPrincipalIds: Schema.Array(PrincipalIdSchema),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type AuthenticationNamespaceRegistration = typeof AuthenticationNamespaceRegistrationSchema.Type;

export const ReservePrincipalBindingPayloadSchema = Schema.Struct({
  ...ExternalAuthenticationSubjectSchema.fields,
  displayName: Schema.optionalKey(
    Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(200)),
  ),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const identityFields = {
  authBindingId: AuthBindingIdSchema,
  bindingRevision: BindingRevisionSchema,
  bindingStatus: AuthBindingStatusSchema,
  principalId: PrincipalIdSchema,
};
export const ReservePrincipalBindingResultSchema = Schema.Union([
  Schema.Struct({
    ...identityFields,
    bindingRevision: Schema.Literal(1),
    bindingStatus: Schema.Literal('pending'),
    outcome: Schema.Literal('RESERVED'),
  }),
  Schema.Struct({ ...identityFields, outcome: Schema.Literal('EXISTING') }),
]).annotate({ parseOptions: { onExcessProperty: 'error' } });
export const ActivatePrincipalBindingPayloadSchema = Schema.Struct({
  authBindingId: AuthBindingIdSchema,
  expectedRevision: BindingRevisionSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export const ActivatePrincipalBindingResultSchema = Schema.Struct({
  ...identityFields,
  bindingStatus: Schema.Literal('active'),
  outcome: Schema.Literal('ACTIVATED'),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export const ChangePrincipalBindingStatusPayloadSchema = Schema.Struct({
  authBindingId: AuthBindingIdSchema,
  expectedRevision: BindingRevisionSchema,
  reason: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(500)),
  reconciliationRef: Schema.optionalKey(boundedReference),
  requestedStatus: Schema.Literals(['active', 'disabled', 'revoked']),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export const ChangePrincipalBindingStatusResultSchema = Schema.Struct({
  ...identityFields,
  previousStatus: AuthBindingStatusSchema,
  transitionRef: uuid,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export const ReadPrincipalBindingPayloadSchema = Schema.Union([
  Schema.Struct({ authBindingId: AuthBindingIdSchema, lookup: Schema.Literal('binding') }),
  Schema.Struct({ ...ExternalAuthenticationSubjectSchema.fields, lookup: Schema.Literal('subject') }),
]).annotate({ parseOptions: { onExcessProperty: 'error' } });
export const ReadPrincipalBindingResultSchema = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal('NOT_FOUND') }),
  Schema.Struct({
    ...identityFields,
    authenticationNamespaceId: AuthenticationNamespaceIdSchema,
    originalInvocationId: Schema.OptionFromNullOr(ActionInvocationIdSchema),
    outcome: Schema.Literal('FOUND'),
    principalStatus: Schema.Literals(['active', 'disabled', 'archived']),
    tenantStatus: Schema.Literals(['active', 'suspended', 'archived']),
  }),
]).annotate({ parseOptions: { onExcessProperty: 'error' } });
export const ResolveExternalSubjectResultSchema = Schema.Struct({
  ...identityFields,
  authenticationNamespaceId: AuthenticationNamespaceIdSchema,
  bindingStatus: Schema.Literal('active'),
  outcome: Schema.Literal('RESOLVED'),
  tenantId: TenantIdSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

/** Pre-binding proof: no fictitious Principal or binding IDs are required for reservation. */
export const ExternalSubjectAdmissionObservationSchema = Schema.Struct({
  ...ExternalAuthenticationSubjectSchema.fields,
  audience: boundedReference,
  authContextRef: boundedReference,
  expiresAt: Schema.DateTimeUtc,
  nonce: uuid,
  observedAt: Schema.DateTimeUtc,
  operationRef: boundedReference,
  tenantId: TenantIdSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type ExternalSubjectAdmissionObservation = typeof ExternalSubjectAdmissionObservationSchema.Type;

/** Wire shape only. Decode success does not mint trusted admission; receiver-owned validation does. */
export const AuthenticationAdmissionObservationSchema = Schema.Struct({
  audience: boundedReference,
  authBindingId: AuthBindingIdSchema,
  authContextRef: boundedReference,
  authenticationNamespaceId: AuthenticationNamespaceIdSchema,
  bindingRevision: BindingRevisionSchema,
  expiresAt: Schema.DateTimeUtc,
  nonce: uuid,
  observedAt: Schema.DateTimeUtc,
  operationRef: boundedReference,
  principalId: PrincipalIdSchema,
  tenantId: TenantIdSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type AuthenticationAdmissionObservation = typeof AuthenticationAdmissionObservationSchema.Type;

export class ExternalIdentityError extends Schema.TaggedError<ExternalIdentityError>()('ExternalIdentityError', {
  code: Schema.Literals([
    'identity_invalid',
    'identity_unusable',
    'identity_forbidden',
    'identity_not_found',
    'identity_conflict',
    'identity_ineligible',
    'identity_unavailable',
  ]),
}) {}
