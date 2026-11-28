import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import {
  SourceChildPreparationSchema,
  SymmyCustomerSourceIntakeConsumerModule,
  SymmyCustomerSourceIntakeOperation,
} from '@app/privacy-contracts/source-processing-eligibility';
import { Schema } from 'effect';

import { LegalBasisAssignmentRefSchema } from '../resources/legal-basis-assignment.ts';
import { PrivacyResponsibilityAssignmentRefSchema } from '../resources/privacy-responsibility-assignment.ts';
import type { PrivacySubjectRef } from '../resources/privacy-subject.ts';
import { PrivacySubjectRefSchema } from '../resources/privacy-subject.ts';
import { ProcessingPurposeRefSchema } from '../resources/processing-purpose.ts';
import { PrivacyApplicabilityAuthoritySchema } from './privacy-applicability.ts';
import type { PrivacyApplicabilityScope } from './privacy-applicability.ts';
import { PrivacyLegalBasisKindSchema } from './privacy-legal-basis.ts';
import { IntendedProcessingScopeSchema, SourceRouteProcessingOperation } from './privacy-processing-eligibility.ts';
import type { IntendedProcessingScope } from './privacy-processing-eligibility.ts';
import { ProcessingScopeRefSchema } from './privacy-responsibility-assignment.ts';
import {
  PrivacyIsoTimestampSchema,
  PrivacySourceRecordIdentitySchema,
  privacySourceSubjectIdentityKey,
} from './privacy-subject.ts';
import type { PrivacySourceRecordIdentity } from './privacy-subject.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const Uuid = Schema.String.check(Schema.isUUID(), Schema.isLowercased());
const distinct = (label: string) =>
  Schema.makeFilter((values: readonly string[]) =>
    new Set(values).size === values.length ? undefined : `${label} must be distinct`,
  );

export { SourceRouteProcessingOperation } from './privacy-processing-eligibility.ts';

export const SourceProcessingConsumerModuleSchema = Schema.Literals([
  'party.registry',
  'commerce.customer-context',
  SymmyCustomerSourceIntakeConsumerModule,
]);
export const SourceProcessingTargetKindSchema = Schema.Literals([
  'PARTY',
  'DUPLICATE_CANDIDATE',
  'RETAIL_CUSTOMER_PROFILE',
  'COUNTERPARTY_PURCHASING_PROFILE',
  'PARTY_CONTACT_POINT',
  'COUNTERPARTY',
]);
type SourceProcessingTargetKind = typeof SourceProcessingTargetKindSchema.Type;
const integrationOnlyTargets = new Set<SourceProcessingTargetKind>(['PARTY_CONTACT_POINT', 'COUNTERPARTY']);

/** Each authorization is its own processing scope, so a later authorization of the route starts its own ledger. */
export const sourceProcessingScopeId = (authorizationId: string): string =>
  `source-processing-authorization:${authorizationId}`;

export const SourceProcessingAuthorizationRefSchema = Schema.Struct({
  moduleId: Schema.Literal('privacy.core'),
  resourceId: Schema.toEncoded(Uuid.pipe(Schema.brand('PrivacySourceProcessingAuthorizationId'))),
  resourceType: Schema.Literal('privacy.core.source-processing-authorization'),
  tenantId: Schema.toEncoded(Uuid.pipe(Schema.brand('PrivacyTenantId'))),
});

/**
 * One consumer operation the route may run for personal processing, with the targets it may name. A canonical
 * organization business intent is never granted here: it keeps its exact governed context and current owner proof.
 */
export const SourceProcessingGrantSchema = Schema.Struct({
  allowTargetless: Schema.Boolean,
  consumerModuleId: SourceProcessingConsumerModuleSchema,
  operation: Ref,
  /** The Retail profile creation may name the Party the Party owner admitted for the same source person. */
  targetAdmission: Schema.optionalKey(Schema.Literal('CURRENT_SOURCE_PERSON')),
  targetKinds: Schema.Array(SourceProcessingTargetKindSchema).check(Schema.isMaxLength(6), distinct('Target kinds')),
}).check(
  Schema.makeFilter((grant) => {
    if (grant.consumerModuleId === SymmyCustomerSourceIntakeConsumerModule) {
      return grant.operation === SymmyCustomerSourceIntakeOperation && grant.targetAdmission === undefined
        ? undefined
        : 'Symmy intake grants are limited to the dedicated intake operation';
    }
    if (
      grant.operation === SymmyCustomerSourceIntakeOperation ||
      grant.targetKinds.some((kind) => integrationOnlyTargets.has(kind))
    ) {
      return 'Symmy intake operations and locators are reserved for the integration boundary';
    }
    return grant.targetAdmission === undefined ||
      (grant.consumerModuleId === 'commerce.customer-context' &&
        grant.operation === 'PROFILE_CREATE' &&
        grant.targetKinds.includes('PARTY'))
      ? undefined
      : 'Current source person target admission is limited to Retail profile creation';
  }),
);
export type SourceProcessingGrant = typeof SourceProcessingGrantSchema.Type;

/** A principal that may act for the route. The worker of the integration acts as a system principal. */
export const SourceProcessingPrincipalSchema = Schema.Struct({
  authMethod: Schema.Literals(['api_key', 'system']),
  principalId: Schema.toEncoded(Uuid.pipe(Schema.brand('PrivacySourcePrincipalId'))),
});

/** The source the route stands for: issuer, namespace and route, with the record kinds it carries. */
export const SourceProcessingRouteSchema = Schema.Struct({
  issuer: PrivacySourceRecordIdentitySchema.fields.issuer,
  namespace: PrivacySourceRecordIdentitySchema.fields.namespace,
  recordTypes: Schema.Array(PrivacySourceRecordIdentitySchema.fields.recordType).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
    distinct('Record types'),
  ),
  routeRef: PrivacySourceRecordIdentitySchema.fields.routeRef,
});
export type SourceProcessingRoute = typeof SourceProcessingRouteSchema.Type;

const { subjectRef: _subjectRef, ...templateFields } = IntendedProcessingScopeSchema.fields;
/** The intended processing scope without a subject. Each request supplies its own resolved subject. */
export const SourceProcessingScopeTemplateSchema = Schema.Struct({
  ...templateFields,
  dataCategoryRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(26), distinct('Data categories')),
  operation: Schema.Literal(SourceRouteProcessingOperation),
});
export type SourceProcessingScopeTemplate = typeof SourceProcessingScopeTemplateSchema.Type;

export const SourceProcessingAuthorizationLifecycleSchema = Schema.Literals(['ACTIVE', 'ENDED']);

/**
 * A durable, revocable standing authorization of one source route. It never carries a subject, an occurrence or a
 * record: those stay audit and replay identities of each request. The governed applicability decision and the
 * Legal Basis Assignment it references are recorded by the same Action that creates it.
 */
export const SourceProcessingAuthorizationSchema = Schema.Struct({
  applicability: Schema.Struct({
    authority: PrivacyApplicabilityAuthoritySchema,
    decisionRef: Ref,
    evaluatedAt: PrivacyIsoTimestampSchema,
    evidenceRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
    receiptRef: Ref,
  }),
  authorizationRef: SourceProcessingAuthorizationRefSchema,
  createdAt: PrivacyIsoTimestampSchema,
  createdBy: PrincipalRefSchema,
  endedAt: Schema.toEncoded(Schema.OptionFromNullOr(PrivacyIsoTimestampSchema)),
  endedBy: Schema.toEncoded(Schema.OptionFromNullOr(PrincipalRefSchema)),
  endReason: Schema.toEncoded(Schema.OptionFromNullOr(Ref)),
  grants: Schema.Array(SourceProcessingGrantSchema).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  legalBasisAssignmentRef: LegalBasisAssignmentRefSchema,
  legalEntityId: Schema.toEncoded(Uuid.pipe(Schema.brand('PrivacyLegalEntityId'))),
  lifecycle: SourceProcessingAuthorizationLifecycleSchema,
  principals: Schema.Array(SourceProcessingPrincipalSchema).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  responsibilityAssignmentRefs: Schema.Array(PrivacyResponsibilityAssignmentRefSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
  ),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  scopeTemplate: SourceProcessingScopeTemplateSchema,
  source: SourceProcessingRouteSchema,
}).check(
  Schema.makeFilter((authorization) => {
    const { tenantId } = authorization.authorizationRef;
    const ended = authorization.lifecycle === 'ENDED';
    if (ended !== (authorization.endedAt !== null) || ended !== (authorization.endedBy !== null)) {
      return 'An ended authorization carries its end instant and actor, an active one carries neither';
    }
    if (ended !== (authorization.endReason !== null)) {
      return 'An ended authorization records why it ended';
    }
    if (
      authorization.legalBasisAssignmentRef.tenantId !== tenantId ||
      authorization.createdBy.tenantId !== tenantId ||
      (authorization.endedBy !== null && authorization.endedBy.tenantId !== tenantId) ||
      authorization.responsibilityAssignmentRefs.some((ref) => ref.tenantId !== tenantId)
    ) {
      return 'Authorization references must share its tenant';
    }
    const grants = authorization.grants.map((grant) => `${grant.consumerModuleId}\u0000${grant.operation}`);
    if (new Set(grants).size !== grants.length) {
      return 'Each consumer operation is granted once';
    }
    const principals = authorization.principals.map((principal) => `${principal.authMethod}:${principal.principalId}`);
    if (new Set(principals).size !== principals.length) {
      return 'Each principal is listed once';
    }
    return authorization.scopeTemplate.processingScopeRef.scopeId ===
      sourceProcessingScopeId(authorization.authorizationRef.resourceId)
      ? undefined
      : 'The processing scope is the scope of this authorization';
  }),
);
export type SourceProcessingAuthorization = typeof SourceProcessingAuthorizationSchema.Type;

/** The processing scope as a typed reference, for the governed records written under it. */
export const sourceProcessingScopeRef = (authorizationId: string) =>
  Schema.decodeUnknownEffect(ProcessingScopeRefSchema)({
    scopeId: sourceProcessingScopeId(authorizationId),
    scopeType: 'privacy.processing-scope',
  });

/** The applicability facts of the route template. It deliberately names no Privacy subject. */
export const sourceProcessingApplicabilityScope = (
  template: SourceProcessingScopeTemplate,
): PrivacyApplicabilityScope => ({
  facts: [
    ...template.dataCategoryRefs.map((value) => ({ dimension: 'CATEGORY' as const, value })),
    { dimension: 'CONTROLLER_SCOPE' as const, value: template.controllerRef },
    { dimension: 'PROCESSING_PURPOSE' as const, value: template.purposeRef },
    { dimension: 'PROCESSING_PURPOSE_VERSION' as const, value: template.purposeVersionId },
    ...template.recipientRefs.map((value) => ({ dimension: 'RECIPIENT' as const, value })),
  ],
  operation: template.operation,
  processingScopeRef: template.processingScopeRef,
});

export const sourceProcessingIntendedScope = (
  template: SourceProcessingScopeTemplate,
  subjectRef: PrivacySubjectRef,
): IntendedProcessingScope => ({ ...template, subjectRef });

/** The source locator a request names, without its occurrence. */
export const sourceProcessingIdentityKey = (source: PrivacySourceRecordIdentity): string =>
  privacySourceSubjectIdentityKey({
    issuer: source.issuer,
    namespace: source.namespace,
    recordId: source.recordId,
    recordType: source.recordType,
    routeRef: source.routeRef,
  });

export const sourceIsOnRoute = (route: SourceProcessingRoute, source: Omit<PrivacySourceRecordIdentity, 'recordId'>) =>
  source.issuer === route.issuer &&
  source.namespace === route.namespace &&
  source.routeRef === route.routeRef &&
  route.recordTypes.includes(source.recordType);

interface GrantRequest {
  readonly consumerModuleId: string;
  readonly operation: string;
  readonly partySourceReference?: { readonly source: Omit<PrivacySourceRecordIdentity, 'recordId'> };
  readonly source: Omit<PrivacySourceRecordIdentity, 'recordId'> | null;
  readonly target: { readonly kind: SourceProcessingTargetKind } | null;
}

/** The grant that admits this request under an active authorization, for a principal the route lists. */
export const sourceProcessingGrantFor = (
  authorization: SourceProcessingAuthorization,
  request: GrantRequest,
  principal: { readonly authMethod: string; readonly principalId: string },
): SourceProcessingGrant | undefined => {
  if (
    authorization.lifecycle !== 'ACTIVE' ||
    request.source === null ||
    !sourceIsOnRoute(authorization.source, request.source) ||
    (request.partySourceReference !== undefined &&
      !sourceIsOnRoute(authorization.source, request.partySourceReference.source)) ||
    !authorization.principals.some(
      (listed) => listed.principalId === principal.principalId && listed.authMethod === principal.authMethod,
    )
  ) {
    return undefined;
  }
  const { target } = request;
  return authorization.grants.find(
    (grant) =>
      grant.consumerModuleId === request.consumerModuleId &&
      grant.operation === request.operation &&
      (target === null ? grant.allowTargetless : grant.targetKinds.includes(target.kind)),
  );
};

const LegalBasisDecisionSchema = Schema.Struct({
  assignmentId: Schema.toEncoded(Uuid.pipe(Schema.brand('PrivacyLegalBasisAssignmentId'))),
  basis: PrivacyLegalBasisKindSchema.check(
    Schema.makeFilter((basis) =>
      basis === 'CONSENT' ? 'A source route never infers consent; consent is recorded per subject' : undefined,
    ),
  ),
  basisVersion: Ref,
  evidenceRefs: Schema.Array(Ref).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  policyRef: Ref,
  policyVersion: Ref,
  reason: Ref,
});

export const CreateSourceProcessingAuthorizationPayloadSchema = Schema.Struct({
  applicabilityDecisionId: Schema.toEncoded(Ref.pipe(Schema.brand('PrivacyDecisionId'))),
  authorizationId: SourceProcessingAuthorizationRefSchema.fields.resourceId,
  dataCategoryRefs: SourceProcessingScopeTemplateSchema.fields.dataCategoryRefs,
  grants: SourceProcessingAuthorizationSchema.fields.grants,
  legalBasis: LegalBasisDecisionSchema,
  principals: SourceProcessingAuthorizationSchema.fields.principals,
  proposedActivity: Schema.Boolean,
  purposeRef: ProcessingPurposeRefSchema,
  purposeVersionId: IntendedProcessingScopeSchema.fields.purposeVersionId,
  responsibilityAssignmentRefs: SourceProcessingAuthorizationSchema.fields.responsibilityAssignmentRefs,
  source: SourceProcessingRouteSchema,
});

export const EndSourceProcessingAuthorizationPayloadSchema = Schema.Struct({
  authorizationId: SourceProcessingAuthorizationRefSchema.fields.resourceId,
  expectedRevision: SourceProcessingAuthorizationSchema.fields.revision,
  reason: Ref,
});

/**
 * The source record of one person or organization and the child records that describe the same subject (its
 * contacts, addresses and memberships). Children share the subject; a different source record never does.
 */
export const AdmitSourceProcessingSubjectPayloadSchema = Schema.Struct({
  childSources: Schema.Array(PrivacySourceRecordIdentitySchema).check(Schema.isMaxLength(256)),
  membershipProfile: Schema.optionalKey(
    Schema.Struct({
      kind: Schema.Literals(['RETAIL_CUSTOMER_PROFILE', 'COUNTERPARTY_PURCHASING_PROFILE']),
      resourceId: Schema.toEncoded(Uuid.pipe(Schema.brand('PrivacySourceTargetId'))),
    }),
  ),
  preparation: Schema.optionalKey(SourceChildPreparationSchema),
  source: PrivacySourceRecordIdentitySchema,
}).check(
  Schema.makeFilter(({ childSources, membershipProfile, source }) => {
    if (
      (source.recordType === 'CUSTOMER_GROUP_MEMBERSHIP') !== (membershipProfile !== undefined) ||
      (membershipProfile !== undefined && childSources.length !== 0) ||
      [source, ...childSources].some((entry) => entry.recordType === 'CUSTOMER_GROUP') ||
      childSources.some((entry) => entry.recordType === 'CUSTOMER_GROUP_MEMBERSHIP')
    ) {
      return 'A group is not a person; a membership requires a single owner-bound Profile';
    }
    const keys = [source, ...childSources].map(sourceProcessingIdentityKey);
    if (new Set(keys).size !== keys.length) {
      return 'Child sources are distinct from each other and from the subject source';
    }
    return childSources.every(
      (child) =>
        child.issuer === source.issuer && child.namespace === source.namespace && child.routeRef === source.routeRef,
    )
      ? undefined
      : 'Child sources come from the same source route as their subject';
  }),
);

/** Which subject a source record of an authorization resolves to, and when the route last used it. */
export const SourceProcessingAdmissionSchema = Schema.Struct({
  authorizationRef: SourceProcessingAuthorizationRefSchema,
  bindingCommitments: Schema.Array(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))),
  childSources: AdmitSourceProcessingSubjectPayloadSchema.fields.childSources,
  firstAdmittedAt: PrivacyIsoTimestampSchema,
  lastAdmittedAt: PrivacyIsoTimestampSchema,
  source: PrivacySourceRecordIdentitySchema,
  subjectRef: PrivacySubjectRefSchema,
});
