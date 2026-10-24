import { DateTime, Option, Schema } from 'effect';

const ResourceIdSchema = Schema.toEncoded(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)).pipe(Schema.brand('PrivacyResourceId')),
);
const TenantIdSchema = Schema.toEncoded(Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrivacyTenantId')));
export const PrivacySubjectRefSchema = Schema.Struct({
  moduleId: Schema.Literal('privacy.core'),
  resourceId: ResourceIdSchema,
  resourceType: Schema.Literal('privacy.core.privacy-subject'),
  tenantId: TenantIdSchema,
});
export type PrivacySubjectRef = typeof PrivacySubjectRefSchema.Type;

export const ProcessingPurposeRefSchema = Schema.Struct({
  moduleId: Schema.Literal('privacy.core'),
  resourceId: ResourceIdSchema,
  resourceType: Schema.Literal('privacy.core.processing-purpose'),
  tenantId: TenantIdSchema,
});
export type ProcessingPurposeRef = typeof ProcessingPurposeRefSchema.Type;

const PrincipalRefSchema = Schema.Struct({
  principalId: Schema.toEncoded(Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrincipalRefPrincipalId'))),
  tenantId: Schema.toEncoded(Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrincipalRefTenantId'))),
});
export const PrivacyIsoTimestampSchema = Schema.toEncoded(Schema.DateTimeUtcFromString).check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u),
  Schema.makeFilter((value) => (Option.isSome(DateTime.make(value)) ? undefined : 'invalid UTC timestamp')),
);

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const Meaning = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(2000));

/** A dimension is included only when its value changes the business choice. */
export const ConsentMaterialDimensionKindSchema = Schema.Literals([
  'COMMUNICATION_CHANNEL',
  'SITE',
  'TECHNOLOGY_CATEGORY',
  'TECHNOLOGY_PROVIDER_SET',
  'JURISDICTION',
]);

export const ConsentMaterialDimensionSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('COMMUNICATION_CHANNEL'),
    value: Schema.Literals(['EMAIL', 'SMS', 'PHONE', 'PUSH']),
  }),
  Schema.Struct({ kind: Schema.Literal('SITE'), value: Ref }),
  Schema.Struct({ kind: Schema.Literal('TECHNOLOGY_CATEGORY'), value: Ref }),
  Schema.Struct({ kind: Schema.Literal('TECHNOLOGY_PROVIDER_SET'), value: Ref }),
  Schema.Struct({ kind: Schema.Literal('JURISDICTION'), value: Ref }),
]);
export type ConsentMaterialDimension = typeof ConsentMaterialDimensionSchema.Type;
export type ConsentMaterialDimensionKind = typeof ConsentMaterialDimensionKindSchema.Type;

/**
 * The stable business scope of one consent. Capture channel, UI, and transport
 * are provenance, never scope dimensions. An empty materialDimensions list is
 * the explicit representation of a channel-neutral choice.
 */
export const ConsentScopeSchema = Schema.Struct({
  controllerRef: Ref,
  materialDimensions: Schema.Array(ConsentMaterialDimensionSchema).check(Schema.isMaxLength(16)),
  privacySubjectRef: PrivacySubjectRefSchema,
  processingPurposeRef: ProcessingPurposeRefSchema,
  purposeMeaning: Meaning,
  purposeVersionRef: Ref,
  scopeRef: Ref,
});
export type ConsentScope = typeof ConsentScopeSchema.Type;

export const ConsentDecisionKindSchema = Schema.Literals(['GRANTED', 'REFUSED', 'WITHDRAWN']);
export type ConsentDecisionKind = typeof ConsentDecisionKindSchema.Type;

const EvidenceRefs = Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(32));
export const ConsentOperationSchema = Schema.Literals(['CONSENT_READ', 'CONSENT_WRITE', 'CONSENT_WITHDRAW']);
export type ConsentSelfServiceOperation = typeof ConsentOperationSchema.Type;

const subjectMatches = (
  left: typeof PrivacySubjectRefSchema.Type,
  right: typeof PrivacySubjectRefSchema.Type,
): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

export const pathMatchesRequest = (
  path: ConsentSelfServicePath,
  request: Pick<ConsentSelfServiceRequest, 'scope'>,
): boolean =>
  subjectMatches(path.subjectRef, request.scope.privacySubjectRef) && path.scopeRef === request.scope.scopeRef;

/**
 * Public input intentionally contains references only. Binding state, granted
 * permissions, and verification outcomes are never accepted from a browser.
 * The server resolves those facts through the owner ports below.
 */
export const ConsentSelfServicePathSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('CURRENT_PROFILE_BINDING'),
    operation: ConsentOperationSchema,
    operationRef: Ref,
    profileRef: Ref,
    requestRef: Ref,
    scopeRef: Ref,
    subjectRef: PrivacySubjectRefSchema,
  }),
  Schema.Struct({
    credentialRef: Ref,
    kind: Schema.Literal('OPERATION_SCOPED'),
    operation: ConsentOperationSchema,
    operationRef: Ref,
    requestRef: Ref,
    scopeRef: Ref,
    subjectRef: PrivacySubjectRefSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('SUPPORT_ASSISTED'),
    operation: ConsentOperationSchema,
    operationRef: Ref,
    representationRef: Ref,
    requestRef: Ref,
    scopeRef: Ref,
    subjectRef: PrivacySubjectRefSchema,
    verificationRef: Ref,
  }),
]);
export type ConsentSelfServicePath = typeof ConsentSelfServicePathSchema.Type;

export const ConsentSelfServiceRequestSchema = Schema.Struct({
  acknowledgedAt: Schema.optional(Schema.Never),
  decision: ConsentDecisionKindSchema,
  decisionEffectiveAt: Schema.optional(Schema.Never),
  decisionReceipt: Schema.optional(Schema.Never),
  effectiveAt: Schema.optional(Schema.Never),
  /** These refs are business input; Privacy resolves their authoritative records before commit. */
  noticeEvidenceRefs: EvidenceRefs,
  path: ConsentSelfServicePathSchema,
  scope: ConsentScopeSchema,
}).check(
  Schema.makeFilter(({ path, scope }) =>
    pathMatchesRequest(path, { scope }) ? undefined : 'Self-service path must pin the exact Consent Scope and Subject',
  ),
);
export type ConsentSelfServiceRequest = typeof ConsentSelfServiceRequestSchema.Type;

const AuthorityStatusSchema = Schema.Literals(['CURRENT', 'STALE', 'REVOKED', 'CONFLICT', 'UNAVAILABLE']);

const CommonAuthorityFields = {
  actorPrincipalRef: Schema.optionalKey(PrincipalRefSchema),
  authorizedScope: ConsentScopeSchema,
  evidenceRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  operation: ConsentOperationSchema,
  operationRef: Ref,
  scopeRef: Ref,
  subjectRef: PrivacySubjectRefSchema,
} as const;

export const TrustedOperationConsentAuthorityFactSchema = Schema.Struct({
  ...CommonAuthorityFields,
  /** Resolved from the owner's immutable server-authored receipt, never from request timestamps. */
  decisionReceipt: Schema.Struct({
    acknowledgedAt: PrivacyIsoTimestampSchema,
    decision: ConsentDecisionKindSchema,
    requestRef: Ref,
  }),
  expiresAt: PrivacyIsoTimestampSchema,
  kind: Schema.Literal('OPERATION_SCOPED'),
  proofRef: Ref,
  status: AuthorityStatusSchema,
  verifiedAt: PrivacyIsoTimestampSchema,
});
export type TrustedOperationConsentAuthorityFact = typeof TrustedOperationConsentAuthorityFactSchema.Type;

const Timestamp = PrivacyIsoTimestampSchema;
const Outcome = Schema.Literals([
  'PROVEN_PROVISION',
  'REPEATED_PROVISION',
  'DISPLAYED_WITHOUT_ACKNOWLEDGEMENT',
  'PROVISION_FAILED',
  'PROVISION_INDETERMINATE',
]);

/** Proof emitted by the trusted owner of the concrete delivery channel. */
export const PrivacyNoticeChannelProofSchema = Schema.Struct({
  anonymousContextRef: Schema.toEncoded(Schema.OptionFromNullOr(Ref)),
  authorityRef: Ref,
  businessInteractionRef: Schema.toEncoded(Schema.OptionFromNullOr(Ref)),
  channel: Ref,
  controllerRef: Ref,
  evidenceRef: Ref,
  noticeVersionRef: Ref,
  observedAt: Timestamp,
  privacySubjectRef: Schema.toEncoded(Schema.OptionFromNullOr(Ref)),
  processingPurposeRef: Ref,
  processingScopeRef: Ref,
  proofKind: Schema.Literals(['DELIVERY_CONFIRMED', 'INTERACTIVE_ACKNOWLEDGEMENT', 'IN_PERSON_ACKNOWLEDGEMENT']),
  providedLanguage: Ref,
});
export type PrivacyNoticeChannelProof = typeof PrivacyNoticeChannelProofSchema.Type;

/** A minimal, immutable fact about one notice information step. Raw page or transport payloads are deliberately absent. */
const privacyNoticeProvisionFields = {
  actionRef: Schema.toEncoded(Schema.OptionFromNullOr(Ref)),
  anonymousContextRef: Schema.toEncoded(Schema.OptionFromNullOr(Ref)),
  businessInteractionRef: Schema.toEncoded(Schema.OptionFromNullOr(Ref)),
  channel: Schema.toEncoded(Schema.OptionFromNullOr(Ref)),
  channelProof: Schema.optional(Schema.toEncoded(Schema.OptionFromNullOr(PrivacyNoticeChannelProofSchema))),
  controllerRef: Ref,
  evidenceRef: Schema.toEncoded(Schema.OptionFromNullOr(Ref)),
  failureReason: Schema.toEncoded(Schema.OptionFromNullOr(Ref)),
  noticeVersionRef: Ref,
  outcome: Outcome,
  privacySubjectRef: Schema.toEncoded(Schema.OptionFromNullOr(Ref)),
  processingPurposeRef: Ref,
  processingScopeRef: Ref,
  providedLanguage: Ref,
  provisionedAt: Timestamp,
  provisionId: Schema.toEncoded(Ref.pipe(Schema.brand('PrivacyProvisionId'))),
  recordedAt: Timestamp,
  supersedesProvisionRef: Schema.toEncoded(Schema.OptionFromNullOr(Ref)),
} as const;

export const PrivacyNoticeProvisionSchema = Schema.Struct(privacyNoticeProvisionFields);
export type PrivacyNoticeProvision = typeof PrivacyNoticeProvisionSchema.Type;

const RecordPrivacyNoticeProvisionInputSchema = Schema.Struct(privacyNoticeProvisionFields);
export type RecordPrivacyNoticeProvisionInput = typeof RecordPrivacyNoticeProvisionInputSchema.Type;

const { recordedAt: _recordedAt, ...privacyNoticeProvisionDraftFields } = privacyNoticeProvisionFields;
const PrivacyNoticeProvisionDraftSchema = Schema.Struct(privacyNoticeProvisionDraftFields);
export type PrivacyNoticeProvisionDraft = typeof PrivacyNoticeProvisionDraftSchema.Type;

export const PrivacyNoticeAuthorityFactSchema = Schema.Struct({
  claimRef: Ref,
  provision: PrivacyNoticeProvisionDraftSchema,
});
export type PrivacyNoticeAuthorityFact = typeof PrivacyNoticeAuthorityFactSchema.Type;

export const RecordNoticeProvisionPayloadSchema = Schema.Struct({
  actionRef: Schema.toEncoded(Schema.OptionFromNullOr(Ref)),
  anonymousContextRef: Schema.toEncoded(Schema.OptionFromNullOr(Ref)),
  businessInteractionRef: Schema.toEncoded(Schema.OptionFromNullOr(Ref)),
  channel: Ref,
  channelProof: Schema.optional(Schema.Never),
  claimRef: Ref,
  controllerRef: Ref,
  evidenceRef: Schema.optional(Schema.Never),
  failureReason: Schema.optional(Schema.Never),
  noticeVersionRef: Ref,
  outcome: Schema.optional(Schema.Never),
  privacySubjectRef: Schema.toEncoded(Schema.OptionFromNullOr(Ref)),
  processingPurposeRef: Ref,
  processingScopeRef: Ref,
  providedLanguage: Ref,
  provisionedAt: Schema.optional(Schema.Never),
  recordedAt: Schema.optional(Schema.Never),
  supersedesProvisionRef: Schema.optional(Schema.Never),
});
export type RecordNoticeProvisionPayload = typeof RecordNoticeProvisionPayloadSchema.Type;
