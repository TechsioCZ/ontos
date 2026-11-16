import { DateTime, Option, Schema } from 'effect';
import {
  OrganizationBusinessSourceFieldSchema,
  OrganizationBusinessSourceProjectionVersion,
  OrganizationBusinessRecordProjectionVersion,
  OrganizationBusinessOnboardTemplateProjectionVersion,
  OrganizationBusinessUpdateFields,
  OrganizationBusinessCorrectionFields,
  OrganizationBusinessOnboardFields,
  OrganizationBusinessEvidenceReadFields,
} from '@app/party-registry/apis/organization-record-facts';
import {
  OrganizationBusinessNameExportFields,
  OrganizationBusinessNameExportProjectionVersion,
} from '@app/party-registry/apis/organization-business-name-export';
import {
  ORGANIZATION_MEMBERSHIP_PROJECTION_VERSION,
  ORGANIZATION_MEMBERSHIP_RECOVER_FIELDS,
  ORGANIZATION_MEMBERSHIP_WRITE_FIELDS,
} from '@app/commerce-customer-context/domain/organization-membership-source';
import {
  ORGANIZATION_PROFILE_SOURCE_CREATE_VERSION,
  ORGANIZATION_PROFILE_SOURCE_CREATE_TEMPLATE_VERSION,
  ORGANIZATION_PROFILE_SOURCE_CREATE_FIELDS,
  ORGANIZATION_PROFILE_SOURCE_CURRENT_VERSION,
  ORGANIZATION_PROFILE_SOURCE_CURRENT_FIELDS,
  ORGANIZATION_PROFILE_SOURCE_RECEIPT_VERSION,
  ORGANIZATION_PROFILE_SOURCE_RECEIPT_FIELDS,
} from '@app/commerce-customer-context/domain/organization-profile-source';
import {
  ORGANIZATION_PRICE_ASSIGNMENT_PROJECTION_VERSION,
  ORGANIZATION_PRICE_ASSIGNMENT_WRITE_FIELDS,
  ORGANIZATION_PRICE_ASSIGNMENT_RECEIPT_READ_FIELDS,
} from '@app/commerce-customer-context/domain/organization-price-assignment-fields';

import { PrivacyResponsibilityAssignmentRefSchema } from '../resources/privacy-responsibility-assignment.ts';
import { ProcessingPurposeRefSchema } from '../resources/processing-purpose.ts';
import { PrivacyOwnerResourceRefSchema } from './privacy-owner-resource-ref.ts';
import type { ProcessingScopeRef } from './privacy-responsibility-assignment.ts';
import type { PrivacyResponsibilityAssignmentRef } from '../resources/privacy-responsibility-assignment.ts';
import { PrivacySubjectRefSchema } from '../resources/privacy-subject.ts';
import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';
import { ProcessingScopeRefSchema } from './privacy-responsibility-assignment.ts';

const Text = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const Version = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100));
const PolicyKeySchema = Text.pipe(Schema.brand('PrivacyApplicabilityPolicyKey'));
const ScopeKeySchema = Text.pipe(Schema.brand('PrivacyApplicabilityScopeKey'));

const PrivacyApplicabilityDimensionSchema = Schema.Literals([
  'CATEGORY',
  'CHANNEL',
  'CONTROLLER_SCOPE',
  'INTENDED_USE',
  'JURISDICTION',
  'OWNER_RESOURCE',
  'OWNER_RESOURCE_REVISION',
  'OWNER_PARTY_KIND',
  'PROCESSING_PURPOSE',
  'PROCESSING_PURPOSE_VERSION',
  'PRIVACY_SUBJECT',
  'RECIPIENT',
  'SITE',
  'SOURCE_CLASSIFICATION',
  'SOURCE_OCCURRENCE',
  'SOURCE_PROJECTION_DIGEST',
  'TENANT',
]);
type PrivacyApplicabilityDimension = typeof PrivacyApplicabilityDimensionSchema.Type;

/** A governed profile is configuration data, not a type-level universal. */
export const PrivacyApplicabilityProfileRefSchema = Schema.Struct({
  profileKey: PolicyKeySchema,
  profileVersion: Version,
});
export type PrivacyApplicabilityProfileRef = typeof PrivacyApplicabilityProfileRefSchema.Type;

export const PrivacyApplicabilityFactPredicateSchema = Schema.Struct({
  dimension: PrivacyApplicabilityDimensionSchema,
  operator: Schema.Literals(['EQUALS', 'ONE_OF']),
  values: Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
});
export type PrivacyApplicabilityFactPredicate = typeof PrivacyApplicabilityFactPredicateSchema.Type;

const PrivacyApplicabilityFactSchema = Schema.Struct({
  dimension: PrivacyApplicabilityDimensionSchema,
  value: Text,
});

const PrivacyPurposeVersionRefSchema = Schema.Struct({
  moduleId: Schema.Literal('privacy.core'),
  resourceId: Schema.toEncoded(Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrivacyResourceId'))),
  resourceType: Schema.Literal('privacy.core.processing-purpose-version'),
  tenantId: Schema.toEncoded(Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrivacyTenantId'))),
});

export const PrivacyApplicabilityAuthoritySchema = Schema.Struct({
  controllerRef: PrivacyOwnerResourceRefSchema,
  legalEntityId: Schema.toEncoded(Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrivacyLegalEntityId'))),
  purposeRef: ProcessingPurposeRefSchema,
  purposeVersionRef: PrivacyPurposeVersionRefSchema,
  tenantId: Schema.toEncoded(Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrivacyTenantId'))),
});
export type PrivacyApplicabilityAuthority = typeof PrivacyApplicabilityAuthoritySchema.Type;

const PrivacyApplicabilityDecisionOutcomeSchema = Schema.Literals(['APPLICABLE', 'UNRESOLVED', 'CONFLICT']);

export const privacyApplicabilityAuthorityMatchesExactUse = (
  authority: PrivacyApplicabilityAuthority,
  expected: Readonly<{
    controllerRef: string;
    legalEntityId: string;
    purposeRef: string;
    purposeVersionId: string;
    tenantId: string;
  }>,
): boolean =>
  authority.tenantId === expected.tenantId &&
  authority.legalEntityId === expected.legalEntityId &&
  authority.controllerRef.tenantId === expected.tenantId &&
  authority.controllerRef.resourceId === expected.controllerRef &&
  authority.purposeRef.tenantId === expected.tenantId &&
  authority.purposeRef.resourceId === expected.purposeRef &&
  authority.purposeVersionRef.tenantId === expected.tenantId &&
  authority.purposeVersionRef.resourceId === expected.purposeVersionId;

/** The scope is deliberately a caller-declared, stable business scope, not an inferred request context. */
export const PrivacyApplicabilityScopeSchema = Schema.Struct({
  facts: Schema.Array(PrivacyApplicabilityFactSchema).check(Schema.isMaxLength(32)),
  operation: Text,
  processingScopeRef: ProcessingScopeRefSchema,
});
export type PrivacyApplicabilityScope = typeof PrivacyApplicabilityScopeSchema.Type;

/** Public Action input: identity of the processing scope, never its business facts. */
export const PrivacyApplicabilityScopeIntentSchema = Schema.Struct({
  operation: Text,
  processingScopeRef: ProcessingScopeRefSchema,
});
export type PrivacyApplicabilityScopeIntent = typeof PrivacyApplicabilityScopeIntentSchema.Type;

/** Exact company-identifier projection approved for native nonpersonal applicability.
 * It excludes contacts, names, free-text provenance and identifiable actor provenance. */
export const OrganizationIcoBusinessFieldSchema = Schema.Literals([
  'assertionRef',
  'partyRef',
  'revision',
  'normalizedValue',
  'originalInput.kind',
  'originalInput.digits',
  'state',
  'isCurrent',
  'validFrom',
  'validTo',
  'recordedAt',
  'provenance.ownerReceiptRef',
]);
export const OrganizationProfileIcoFieldContractVersion =
  'commerce.customer-context.organization-ico-business-fields.v1';
export const OrganizationProfileIcoOperationSchema = Schema.Literals([
  'customer-profile-ico.read',
  'customer-profile-ico.write',
  'customer-profile-ico.migrate',
]);
export const OrganizationProfileIcoBusinessFieldSchema = Schema.Literals([
  'profileRef',
  'partyRef',
  'revision',
  'normalizedValue',
  'normalizerVersion',
  'originalInput.kind',
  'originalInput.digits',
  'operation',
  'effectiveAt',
  'effectiveTo',
  'isCurrent',
  'recordedAt',
  'provenance.ownerReceiptRef',
]);
const PartyOrganizationIcoNonPersonalApplicabilitySchema = Schema.Struct({
  allowedFields: Schema.Array(OrganizationIcoBusinessFieldSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(12),
    Schema.makeFilter((fields) =>
      new Set(fields).size === fields.length ? undefined : 'Native ICO policy fields must be unique',
    ),
  ),
  fieldContractVersion: Schema.Literal('party.registry.organization-ico-business-fields.v1'),
  holdBehavior: Schema.Literal('NO_ACTIVE_SCOPE_HOLD'),
  kind: Schema.Literal('ORGANIZATION_ICO_ONLY'),
});
const ProfileOrganizationIcoNonPersonalApplicabilitySchema = Schema.Struct({
  allowedFields: Schema.Array(OrganizationProfileIcoBusinessFieldSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(13),
    Schema.makeFilter((fields) =>
      new Set(fields).size === fields.length ? undefined : 'Native profile ICO fields must be unique',
    ),
  ),
  fieldContractVersion: Schema.Literal(OrganizationProfileIcoFieldContractVersion),
  holdBehavior: Schema.Literal('NO_ACTIVE_SCOPE_HOLD'),
  kind: Schema.Literal('ORGANIZATION_ICO_ONLY'),
});
export const OrganizationIcoNonPersonalApplicabilitySchema = Schema.Union([
  PartyOrganizationIcoNonPersonalApplicabilitySchema,
  ProfileOrganizationIcoNonPersonalApplicabilitySchema,
]);

export {
  OrganizationBusinessSourceFieldSchema,
  OrganizationBusinessSourceProjectionVersion,
} from '@app/party-registry/apis/organization-record-facts';
const uniqueOrganizationBusinessFields = Schema.makeFilter((fields: readonly string[]) =>
  new Set(fields).size === fields.length ? undefined : 'Organization business policy fields must be unique',
);
const organizationBusinessFields = <const Fields extends readonly string[]>(fields: Fields) =>
  Schema.Array(Schema.Literals(fields)).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(fields.length),
    uniqueOrganizationBusinessFields,
  );
const organizationBusinessMarker = {
  holdBehavior: Schema.Literal('NO_ACTIVE_SCOPE_HOLD'),
  kind: Schema.Literal('ORGANIZATION_BUSINESS_ONLY'),
};
const sourceBusinessMarker = {
  ...organizationBusinessMarker,
  classification: Schema.Literal('SOURCE_ASSERTED_ORGANIZATION'),
};
const partyBusinessConsumerSchema = Schema.Literal('party.registry');
const commerceBusinessConsumerSchema = Schema.Literal('commerce.customer-context');
const SourceOrganizationBusinessNonPersonalApplicabilitySchema = Schema.Struct({
  ...sourceBusinessMarker,
  allowedFields: Schema.Array(OrganizationBusinessSourceFieldSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(OrganizationBusinessSourceFieldSchema.literals.length),
    uniqueOrganizationBusinessFields,
  ),
  consumerModuleId: partyBusinessConsumerSchema,
  operation: Schema.Literals(['CREATE', 'MATCH']),
  projectionVersion: Schema.Literal(OrganizationBusinessSourceProjectionVersion),
});
const membershipBusinessMarker = {
  ...organizationBusinessMarker,
  classification: Schema.Literal('CANONICAL_ORGANIZATION'),
  consumerModuleId: commerceBusinessConsumerSchema,
  projectionVersion: Schema.Literal(ORGANIZATION_MEMBERSHIP_PROJECTION_VERSION),
};
const partyRecordBusinessMarker = {
  ...organizationBusinessMarker,
  classification: Schema.Literal('CANONICAL_ORGANIZATION'),
  consumerModuleId: partyBusinessConsumerSchema,
  projectionVersion: Schema.Literal(OrganizationBusinessRecordProjectionVersion),
};
const commerceRecordBusinessMarker = {
  ...organizationBusinessMarker,
  classification: Schema.Literal('CANONICAL_ORGANIZATION'),
  consumerModuleId: commerceBusinessConsumerSchema,
};
export const OrganizationBusinessNonPersonalApplicabilitySchema = Schema.Union([
  SourceOrganizationBusinessNonPersonalApplicabilitySchema,
  Schema.Struct({
    ...partyRecordBusinessMarker,
    allowedFields: organizationBusinessFields(OrganizationBusinessUpdateFields),
    operation: Schema.Literal('UPDATE'),
  }),
  Schema.Struct({
    ...partyRecordBusinessMarker,
    allowedFields: organizationBusinessFields(OrganizationBusinessCorrectionFields),
    operation: Schema.Literal('CORRECTION'),
  }),
  Schema.Struct({
    ...partyRecordBusinessMarker,
    allowedFields: organizationBusinessFields(OrganizationBusinessOnboardFields),
    operation: Schema.Literal('ONBOARD_COUNTERPARTY_CUSTOMER'),
  }),
  Schema.Struct({
    ...partyRecordBusinessMarker,
    allowedFields: organizationBusinessFields(OrganizationBusinessEvidenceReadFields),
    operation: Schema.Literal('EVIDENCE_READ'),
  }),
  Schema.Struct({
    ...commerceRecordBusinessMarker,
    allowedFields: organizationBusinessFields(ORGANIZATION_PROFILE_SOURCE_CREATE_FIELDS),
    operation: Schema.Literal('COUNTERPARTY_PROFILE_CREATE'),
    projectionVersion: Schema.Literal(ORGANIZATION_PROFILE_SOURCE_CREATE_VERSION),
  }),
  Schema.Struct({
    ...commerceRecordBusinessMarker,
    allowedFields: organizationBusinessFields(ORGANIZATION_PROFILE_SOURCE_CURRENT_FIELDS),
    operation: Schema.Literals(['customer-profile-source.write', 'customer-profile-source.read']),
    projectionVersion: Schema.Literal(ORGANIZATION_PROFILE_SOURCE_CURRENT_VERSION),
  }),
  Schema.Struct({
    ...commerceRecordBusinessMarker,
    allowedFields: organizationBusinessFields(ORGANIZATION_PROFILE_SOURCE_RECEIPT_FIELDS),
    operation: Schema.Literal('customer-profile-source.recover'),
    projectionVersion: Schema.Literal(ORGANIZATION_PROFILE_SOURCE_RECEIPT_VERSION),
  }),
  Schema.Struct({
    ...membershipBusinessMarker,
    allowedFields: Schema.Array(Schema.Literals(ORGANIZATION_MEMBERSHIP_WRITE_FIELDS)).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(ORGANIZATION_MEMBERSHIP_WRITE_FIELDS.length),
      uniqueOrganizationBusinessFields,
    ),
    operation: Schema.Literal('customer-group-membership.write'),
  }),
  Schema.Struct({
    ...membershipBusinessMarker,
    allowedFields: Schema.Array(Schema.Literals(ORGANIZATION_MEMBERSHIP_RECOVER_FIELDS)).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(ORGANIZATION_MEMBERSHIP_RECOVER_FIELDS.length),
      uniqueOrganizationBusinessFields,
    ),
    operation: Schema.Literal('customer-group-membership.recover'),
  }),
  Schema.Struct({
    ...commerceRecordBusinessMarker,
    allowedFields: organizationBusinessFields(ORGANIZATION_PRICE_ASSIGNMENT_WRITE_FIELDS),
    operation: Schema.Literal('PRICE_GROUP_ASSIGN'),
    projectionVersion: Schema.Literal(ORGANIZATION_PRICE_ASSIGNMENT_PROJECTION_VERSION),
  }),
  Schema.Struct({
    ...commerceRecordBusinessMarker,
    allowedFields: organizationBusinessFields(ORGANIZATION_PRICE_ASSIGNMENT_RECEIPT_READ_FIELDS),
    operation: Schema.Literal('PRICE_GROUP_ASSIGNMENT_RECEIPT_READ'),
    projectionVersion: Schema.Literal(ORGANIZATION_PRICE_ASSIGNMENT_PROJECTION_VERSION),
  }),
  Schema.Struct({
    ...sourceBusinessMarker,
    allowedFields: organizationBusinessFields(OrganizationBusinessOnboardFields),
    consumerModuleId: partyBusinessConsumerSchema,
    operation: Schema.Literal('ONBOARD_COUNTERPARTY_CUSTOMER'),
    projectionVersion: Schema.Literal(OrganizationBusinessOnboardTemplateProjectionVersion),
  }),
  Schema.Struct({
    ...sourceBusinessMarker,
    allowedFields: organizationBusinessFields(ORGANIZATION_PROFILE_SOURCE_CREATE_FIELDS),
    consumerModuleId: commerceBusinessConsumerSchema,
    operation: Schema.Literal('COUNTERPARTY_PROFILE_CREATE'),
    projectionVersion: Schema.Literal(ORGANIZATION_PROFILE_SOURCE_CREATE_TEMPLATE_VERSION),
  }),
  Schema.Struct({
    ...partyRecordBusinessMarker,
    allowedFields: organizationBusinessFields(OrganizationBusinessNameExportFields),
    operation: Schema.Literal('ORGANIZATION_BUSINESS_NAME_EXPORT'),
    projectionVersion: Schema.Literal(OrganizationBusinessNameExportProjectionVersion),
  }),
]);
export const PrivacyNonPersonalApplicabilitySchema = Schema.Union([
  OrganizationIcoNonPersonalApplicabilitySchema,
  OrganizationBusinessNonPersonalApplicabilitySchema,
]);

export const PrivacyApplicabilityPolicySchema = Schema.Struct({
  composition: Schema.Struct({
    precedence: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    strategy: Schema.Literal('EXPLICIT_PRECEDENCE'),
  }),
  effectiveFrom: PrivacyIsoTimestampSchema,
  effectiveTo: Schema.toEncoded(Schema.OptionFromNullOr(PrivacyIsoTimestampSchema)),
  factPredicates: Schema.Array(PrivacyApplicabilityFactPredicateSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
  ),
  jurisdictionProfile: PrivacyApplicabilityProfileRefSchema,
  mandatoryDimensions: Schema.Array(PrivacyApplicabilityDimensionSchema).check(Schema.isMaxLength(16)),
  nonPersonalApplicability: Schema.optionalKey(PrivacyNonPersonalApplicabilitySchema),
  policyKey: PolicyKeySchema,
  policyVersion: Version,
  scopeKey: ScopeKeySchema,
  sourceEvidenceRefs: Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
}).check(
  Schema.makeFilter((policy) => {
    if (policy.effectiveTo !== null && policy.effectiveTo <= policy.effectiveFrom) {
      return 'Applicability policy effective period is invalid';
    }
    const mandatoryDimensions = new Set(policy.mandatoryDimensions);
    if (mandatoryDimensions.size !== policy.mandatoryDimensions.length) {
      return 'Applicability policy mandatory dimensions must be unique';
    }
    if (policy.nonPersonalApplicability !== undefined) {
      const exact = (dimension: PrivacyApplicabilityDimension, value: string) =>
        policy.factPredicates.some(
          (predicate) =>
            predicate.dimension === dimension &&
            predicate.operator === 'EQUALS' &&
            predicate.values.length === 1 &&
            predicate.values[0] === value,
        );
      const marker = policy.nonPersonalApplicability;
      if (marker.kind === 'ORGANIZATION_BUSINESS_ONLY') {
        const source = marker.classification === 'SOURCE_ASSERTED_ORGANIZATION';
        const required: readonly PrivacyApplicabilityDimension[] = source
          ? [
              'OWNER_RESOURCE',
              'OWNER_RESOURCE_REVISION',
              'SOURCE_CLASSIFICATION',
              'SOURCE_OCCURRENCE',
              'SOURCE_PROJECTION_DIGEST',
              'CATEGORY',
              'INTENDED_USE',
            ]
          : ['OWNER_RESOURCE', 'OWNER_RESOURCE_REVISION', 'OWNER_PARTY_KIND', 'CATEGORY', 'INTENDED_USE'];
        if (
          !exact('CATEGORY', marker.projectionVersion) ||
          !exact('INTENDED_USE', marker.operation) ||
          !(source
            ? exact('SOURCE_CLASSIFICATION', 'SOURCE_ASSERTED_ORGANIZATION')
            : exact('OWNER_PARTY_KIND', 'ORGANIZATION')) ||
          !required.every((dimension) => mandatoryDimensions.has(dimension))
        ) {
          return 'Organization business policy requires exact classification, projection, operation and current owner facts';
        }
        const predicateDimensions = new Set(policy.factPredicates.map(({ dimension }) => dimension));
        return policy.mandatoryDimensions.every((dimension) => predicateDimensions.has(dimension))
          ? undefined
          : 'Applicability policy must define a predicate for every mandatory dimension';
      }
      const exactOperation =
        marker.fieldContractVersion === 'party.registry.organization-ico-business-fields.v1'
          ? exact('INTENDED_USE', 'party-ico-legacy-inventory.read')
          : OrganizationProfileIcoOperationSchema.literals.some((operation) => exact('INTENDED_USE', operation));
      const fixedFacts =
        exact('OWNER_PARTY_KIND', 'ORGANIZATION') && exact('CATEGORY', marker.fieldContractVersion) && exactOperation;
      const dimensions: readonly PrivacyApplicabilityDimension[] = [
        'OWNER_RESOURCE',
        'OWNER_RESOURCE_REVISION',
        'OWNER_PARTY_KIND',
        'CATEGORY',
        'INTENDED_USE',
      ];
      if (!fixedFacts || !dimensions.every((dimension) => mandatoryDimensions.has(dimension))) {
        return 'Nonpersonal ICO policy requires explicit exact organization, ICO-only projection, operation, owner resource and revision predicates';
      }
    }
    const predicateDimensions = new Set(policy.factPredicates.map(({ dimension }) => dimension));
    return policy.mandatoryDimensions.every((dimension) => predicateDimensions.has(dimension))
      ? undefined
      : 'Applicability policy must define a predicate for every mandatory dimension';
  }),
);
export type PrivacyApplicabilityPolicy = typeof PrivacyApplicabilityPolicySchema.Type;

export const PrivacyApplicabilityDecisionSchema = Schema.Struct({
  /** Missing only on retained legacy decisions, which may not authorize new writes. */
  authority: Schema.optionalKey(PrivacyApplicabilityAuthoritySchema),
  /** Missing on legacy decisions; new eligibility reuse requires the exact authority receipt. */
  authorityEvidenceRefs: Schema.optionalKey(Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(32))),
  /** Missing on legacy decisions; new eligibility reuse requires the exact authority receipt. */
  authorityReceiptRef: Schema.optionalKey(Text),
  evaluatedAt: PrivacyIsoTimestampSchema,
  evaluatedScope: PrivacyApplicabilityScopeSchema,
  evidenceRefs: Schema.Array(Text).check(Schema.isMaxLength(32)),
  nonPersonalApplicability: Schema.optionalKey(PrivacyNonPersonalApplicabilitySchema),
  outcome: PrivacyApplicabilityDecisionOutcomeSchema,
  policyIdentities: Schema.Array(
    Schema.Struct({
      jurisdictionProfile: Schema.optional(PrivacyApplicabilityProfileRefSchema),
      policyKey: PolicyKeySchema,
      policyVersion: Version,
    }),
  ).check(Schema.isMaxLength(16)),
  proposedActivity: Schema.Boolean,
  reasonCodes: Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  responsibilityAssignmentRefs: Schema.Array(PrivacyResponsibilityAssignmentRefSchema).check(Schema.isMaxLength(32)),
});
export type PrivacyApplicabilityDecision = typeof PrivacyApplicabilityDecisionSchema.Type;

/** Exact-use identity sent to the trusted applicability authority; it contains no business facts. */
export const PrivacyApplicabilityEligibilityUseSchema = Schema.Struct({
  controllerRef: Text,
  dataCategoryRefs: Schema.Array(Text).check(Schema.isMaxLength(64)),
  operation: Text,
  processingScopeRef: ProcessingScopeRefSchema,
  purposeRef: Text,
  purposeVersionId: Schema.toEncoded(Text.pipe(Schema.brand('PrivacyPurposeVersionId'))),
  recipientRefs: Schema.Array(Text).check(Schema.isMaxLength(64)),
  subjectRef: PrivacySubjectRefSchema,
});
export type PrivacyApplicabilityEligibilityUse = typeof PrivacyApplicabilityEligibilityUseSchema.Type;

/** Trusted confirmation of the current facts and the exact stored decision used by eligibility. */
export const PrivacyApplicabilityEligibilityAuthorityResultSchema = Schema.Struct({
  asOf: PrivacyIsoTimestampSchema,
  authority: PrivacyApplicabilityAuthoritySchema,
  decisionEvaluatedAt: PrivacyIsoTimestampSchema,
  decisionOutcome: PrivacyApplicabilityDecisionOutcomeSchema,
  decisionRef: Text,
  evidenceRefs: Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  receiptRef: Text,
  scope: PrivacyApplicabilityScopeSchema,
  status: Schema.Literals(['CURRENT', 'STALE', 'CONFLICT']),
  validUntil: Schema.optionalKey(PrivacyIsoTimestampSchema),
});
export type PrivacyApplicabilityEligibilityAuthorityResult =
  typeof PrivacyApplicabilityEligibilityAuthorityResultSchema.Type;

export type PrivacyApplicabilityResolution =
  | { readonly decision: PrivacyApplicabilityDecision; readonly outcome: 'CURRENT' }
  | { readonly outcome: 'ABSENT' }
  | { readonly decisions: readonly PrivacyApplicabilityDecision[]; readonly outcome: 'CONFLICT' };

export interface ResolvePrivacyApplicabilityInput {
  readonly authority?: PrivacyApplicabilityAuthority;
  readonly authorityEvidenceRefs?: readonly string[];
  readonly authorityReceiptRef?: string;
  readonly evaluatedAt: PrivacyApplicabilityDecision['evaluatedAt'];
  readonly policies: readonly PrivacyApplicabilityPolicy[];
  readonly proposedActivity: boolean;
  readonly responsibilityAssignmentRefs?: readonly PrivacyResponsibilityAssignmentRef[];
  readonly scope: PrivacyApplicabilityScope;
}

interface MaterializedApplicabilityAuthorityFields {
  authority: PrivacyApplicabilityAuthority;
  authorityEvidenceRefs?: string[];
  authorityReceiptRef?: string;
}

const scopeKey = (scope: PrivacyApplicabilityScope): string =>
  `${scope.processingScopeRef.scopeType}:${scope.processingScopeRef.scopeId}:${scope.operation}`;

const epochMillis = (value: string): number | undefined =>
  DateTime.make(value).pipe(Option.map(DateTime.toEpochMillis), Option.getOrUndefined);

const inEffectivePeriod = (policy: PrivacyApplicabilityPolicy, evaluatedAt: string): boolean => {
  const evaluatedAtMillis = epochMillis(evaluatedAt);
  const effectiveFromMillis = epochMillis(policy.effectiveFrom);
  const effectiveToMillis = policy.effectiveTo === null ? undefined : epochMillis(policy.effectiveTo);
  return (
    evaluatedAtMillis !== undefined &&
    effectiveFromMillis !== undefined &&
    evaluatedAtMillis >= effectiveFromMillis &&
    (policy.effectiveTo === null || (effectiveToMillis !== undefined && evaluatedAtMillis < effectiveToMillis))
  );
};

const factValuesByDimension = (scope: PrivacyApplicabilityScope): Map<PrivacyApplicabilityDimension, string[]> => {
  const values = new Map<PrivacyApplicabilityDimension, string[]>();
  for (const fact of scope.facts) {
    values.set(fact.dimension, [...(values.get(fact.dimension) ?? []), fact.value]);
  }
  return values;
};

const authoritativeFactValues = (
  authority: PrivacyApplicabilityAuthority | undefined,
): ReadonlyMap<PrivacyApplicabilityDimension, string> =>
  authority === undefined
    ? new Map()
    : new Map([
        ['CONTROLLER_SCOPE', authority.controllerRef.resourceId],
        ['PROCESSING_PURPOSE', authority.purposeRef.resourceId],
        ['PROCESSING_PURPOSE_VERSION', authority.purposeVersionRef.resourceId],
        ['TENANT', authority.tenantId],
      ]);

const predicateMatches = (predicate: PrivacyApplicabilityFactPredicate, value: string): boolean =>
  predicate.operator === 'EQUALS'
    ? predicate.values.length === 1 && predicate.values[0] === value
    : predicate.values.includes(value);

const decision = (
  input: ResolvePrivacyApplicabilityInput,
  outcome: PrivacyApplicabilityDecision['outcome'],
  reasonCodes: readonly string[],
  policies: readonly PrivacyApplicabilityPolicy[],
): PrivacyApplicabilityDecision => {
  const resolved: PrivacyApplicabilityDecision = {
    evaluatedAt: input.evaluatedAt,
    evaluatedScope: input.scope,
    evidenceRefs: policies.flatMap(({ sourceEvidenceRefs }) => sourceEvidenceRefs),
    outcome,
    policyIdentities: policies.map(({ jurisdictionProfile, policyKey, policyVersion }) => ({
      jurisdictionProfile,
      policyKey,
      policyVersion,
    })),
    proposedActivity: input.proposedActivity,
    reasonCodes,
    responsibilityAssignmentRefs: [...(input.responsibilityAssignmentRefs ?? [])],
  };
  const nativePolicy = policies.length === 1 ? policies.at(0)?.nonPersonalApplicability : undefined;
  const classified =
    outcome === 'APPLICABLE' && nativePolicy !== undefined
      ? { ...resolved, nonPersonalApplicability: nativePolicy }
      : resolved;
  if (input.authority === undefined) {
    return classified;
  }
  const authoritativeFields: MaterializedApplicabilityAuthorityFields = { authority: input.authority };
  if (input.authorityEvidenceRefs !== undefined) {
    authoritativeFields.authorityEvidenceRefs = [...input.authorityEvidenceRefs];
  }
  if (input.authorityReceiptRef !== undefined) {
    authoritativeFields.authorityReceiptRef = input.authorityReceiptRef;
  }
  return { ...classified, ...authoritativeFields };
};

type ApplicabilityPolicySelection =
  | {
      readonly outcome: 'READY';
      readonly policies: readonly PrivacyApplicabilityPolicy[];
      readonly policy: PrivacyApplicabilityPolicy;
    }
  | {
      readonly outcome: 'UNRESOLVED' | 'CONFLICT';
      readonly policies: readonly PrivacyApplicabilityPolicy[];
      readonly reasonCodes: readonly string[];
    };

const selectApplicabilityPolicy = (input: ResolvePrivacyApplicabilityInput): ApplicabilityPolicySelection => {
  const matching = input.policies.filter((policy) => policy.scopeKey === scopeKey(input.scope));
  if (matching.length === 0) {
    return { outcome: 'UNRESOLVED', policies: [], reasonCodes: ['policy_missing'] };
  }
  const effective = matching.filter((policy) => inEffectivePeriod(policy, input.evaluatedAt));
  if (effective.length === 0) {
    return { outcome: 'UNRESOLVED', policies: [], reasonCodes: ['policy_not_effective'] };
  }
  const highestPrecedence = Math.max(...effective.map(({ composition }) => composition.precedence));
  const selected = effective.filter(({ composition }) => composition.precedence === highestPrecedence);
  const [policy] = selected;
  return selected.length === 1 && policy !== undefined
    ? { outcome: 'READY', policies: selected, policy }
    : { outcome: 'CONFLICT', policies: selected, reasonCodes: ['policy_composition_conflict'] };
};

/** Resolves only explicit policy/fact matches. It never supplies Controller or jurisdiction from ambient context. */
export const resolvePrivacyApplicability = (input: ResolvePrivacyApplicabilityInput): PrivacyApplicabilityDecision => {
  if (input.authority === undefined) {
    return decision(input, 'UNRESOLVED', ['authority_missing'], []);
  }

  // Explicit precedence is not an implicit fallback: a lower layer cannot
  // approve the operation when the selected layer does not match its facts.
  const selection = selectApplicabilityPolicy(input);
  if (selection.outcome !== 'READY') {
    return decision(input, selection.outcome, selection.reasonCodes, selection.policies);
  }
  const { policies, policy } = selection;
  const dimensions = factValuesByDimension(input.scope);
  for (const [dimension, value] of authoritativeFactValues(input.authority)) {
    dimensions.set(dimension, [...(dimensions.get(dimension) ?? []), value]);
  }
  const conflictingDimensions = [...dimensions.entries()].filter(([, values]) => new Set(values).size > 1);
  if (conflictingDimensions.length > 0) {
    return decision(input, 'CONFLICT', ['declared_fact_conflict'], policies);
  }
  const missing = policy.mandatoryDimensions.filter((dimension) => !dimensions.has(dimension));
  if (missing.length > 0) {
    return decision(input, 'UNRESOLVED', ['mandatory_input_missing'], policies);
  }

  const predicateDimensions = new Set(policy.factPredicates.map(({ dimension }) => dimension));
  const missingPredicates = policy.mandatoryDimensions.filter((dimension) => !predicateDimensions.has(dimension));
  if (missingPredicates.length > 0) {
    return decision(input, 'UNRESOLVED', ['policy_predicate_missing'], policies);
  }

  const unmatched = policy.factPredicates.some((predicate) => {
    const values = dimensions.get(predicate.dimension);
    return values === undefined || values.some((value) => !predicateMatches(predicate, value));
  });
  if (unmatched) {
    return decision(input, 'UNRESOLVED', ['policy_predicate_mismatch'], policies);
  }

  return decision(input, 'APPLICABLE', ['explicit_policy_match'], policies);
};

const applicabilityDecisionEquivalent = Schema.toEquivalence(PrivacyApplicabilityDecisionSchema);
const applicabilityScopeEquivalent = Schema.toEquivalence(PrivacyApplicabilityScopeSchema);

/**
 * Resolves the one stored applicability decision that may authorize a later
 * operation. Callers may identify the scope and as-of time, but may not submit
 * an APPLICABLE decision as authority. A same-time or non-applicable latest
 * decision fails closed.
 */
export const resolveCurrentPrivacyApplicability = (
  decisions: readonly PrivacyApplicabilityDecision[],
  scope: PrivacyApplicabilityScope,
  asOf: string,
): PrivacyApplicabilityResolution => {
  const matching = decisions.filter(
    (candidate) => candidate.evaluatedAt <= asOf && applicabilityScopeEquivalent(candidate.evaluatedScope, scope),
  );
  const latestEvaluatedAt = matching
    .toSorted((left, right) => left.evaluatedAt.localeCompare(right.evaluatedAt))
    .at(-1)?.evaluatedAt;
  if (latestEvaluatedAt === undefined) {
    return { outcome: 'ABSENT' };
  }
  const latest = matching.filter(({ evaluatedAt }) => evaluatedAt === latestEvaluatedAt);
  if (latest.length !== 1) {
    return { decisions: latest, outcome: 'CONFLICT' };
  }
  const [selected] = latest;
  if (selected === undefined || selected.outcome !== 'APPLICABLE') {
    return { outcome: 'ABSENT' };
  }
  return { decision: selected, outcome: 'CURRENT' };
};

/** Same resolver for consumers whose payload identifies the operation/scope but not the fact list. */
export const resolveCurrentPrivacyApplicabilityForProcessingScope = (
  decisions: readonly PrivacyApplicabilityDecision[],
  operation: string,
  processingScopeRef: ProcessingScopeRef,
  asOf: string,
): PrivacyApplicabilityResolution => {
  const scopeCandidates = decisions.filter(
    (candidate) =>
      candidate.evaluatedAt <= asOf &&
      candidate.evaluatedScope.operation === operation &&
      candidate.evaluatedScope.processingScopeRef.scopeId === processingScopeRef.scopeId &&
      candidate.evaluatedScope.processingScopeRef.scopeType === processingScopeRef.scopeType,
  );
  const latestEvaluatedAt = scopeCandidates
    .toSorted((left, right) => left.evaluatedAt.localeCompare(right.evaluatedAt))
    .at(-1)?.evaluatedAt;
  if (latestEvaluatedAt === undefined) {
    return { outcome: 'ABSENT' };
  }
  const latest = scopeCandidates.filter(({ evaluatedAt }) => evaluatedAt === latestEvaluatedAt);
  if (latest.length !== 1) {
    return { decisions: latest, outcome: 'CONFLICT' };
  }
  const [selected] = latest;
  return selected?.outcome === 'APPLICABLE' ? { decision: selected, outcome: 'CURRENT' } : { outcome: 'ABSENT' };
};

const privacyApplicabilityAuthorityIdentityKey = (candidate: PrivacyApplicabilityDecision): string => {
  const { authority } = candidate;
  if (authority === undefined) {
    return '';
  }
  const { controllerRef, legalEntityId, purposeRef, purposeVersionRef, tenantId } = authority;
  const facts = candidate.evaluatedScope.facts
    .map(({ dimension, value }) => `${dimension}:${value}`)
    .toSorted()
    .join('\u0001');
  return [
    tenantId,
    legalEntityId,
    controllerRef.tenantId,
    controllerRef.moduleId,
    controllerRef.resourceType,
    controllerRef.resourceId,
    purposeRef.tenantId,
    purposeRef.moduleId,
    purposeRef.resourceType,
    purposeRef.resourceId,
    purposeVersionRef.tenantId,
    purposeVersionRef.moduleId,
    purposeVersionRef.resourceType,
    purposeVersionRef.resourceId,
    candidate.evaluatedScope.operation,
    candidate.evaluatedScope.processingScopeRef.scopeType,
    candidate.evaluatedScope.processingScopeRef.scopeId,
    facts,
  ].join('\u0000');
};

/**
 * Returns the latest decision for every exact authority identity in a
 * processing scope.  Outcome filtering deliberately happens after this
 * selection: a later UNRESOLVED or CONFLICT decision supersedes an older
 * APPLICABLE decision and therefore cannot authorize a new effect.
 */
export const latestPrivacyApplicabilityDecisionsForExactAuthorities = (
  decisions: readonly PrivacyApplicabilityDecision[],
  scope: PrivacyApplicabilityScope,
  asOf: string,
): readonly PrivacyApplicabilityDecision[] => {
  const candidates = decisions.filter(
    (candidate) =>
      candidate.authority !== undefined &&
      candidate.evaluatedAt <= asOf &&
      applicabilityScopeEquivalent(candidate.evaluatedScope, scope),
  );
  const latestByIdentity = new Map<string, string>();
  for (const candidate of candidates) {
    const key = privacyApplicabilityAuthorityIdentityKey(candidate);
    const latest = latestByIdentity.get(key);
    if (latest === undefined || candidate.evaluatedAt > latest) {
      latestByIdentity.set(key, candidate.evaluatedAt);
    }
  }
  return candidates.filter(
    (candidate) => candidate.evaluatedAt === latestByIdentity.get(privacyApplicabilityAuthorityIdentityKey(candidate)),
  );
};

export const privacyApplicabilityDecisionsAreEquivalent = applicabilityDecisionEquivalent;
