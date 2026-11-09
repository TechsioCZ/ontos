import { LegacyIcoInventoryAssertionSchema } from '@app/party-registry/apis/legacy-ico-inventory';
import { CounterpartyMigrationCorrelationResponseSchema } from '@app/party-registry/apis/counterparty-migration-correlation';
import { SourceProcessingEligibilityRequestSchema } from '@app/privacy/api';
import { Schema } from 'effect';
import { OrganizationProfileIcoApplicabilityResponseSchema } from '@app/privacy/api/organization-profile-ico-applicability';
import { CounterpartyOrganizationIcoFactsResponseSchema } from '@app/party-registry/apis/counterparty-organization-ico-facts';
import { PartyOfficialIdentifierRefSchema } from '@app/party-registry/resources/party-official-identifier';
import { ProfileBoundedKeySchema, ProfileInstantSchema } from './profile-contracts.ts';
import { CommerceCustomerProfileRefSchema } from './profile-decisions.ts';

const organizationAuthorityFields = OrganizationProfileIcoApplicabilityResponseSchema.members[0].fields;
/** Stable current authority coordinates; evaluation time is intentionally not a plan fingerprint. */
export const ProfileIcoMigrationOrganizationAuthoritySchema = Schema.Struct({
  allowedFields: organizationAuthorityFields.allowedFields,
  applicabilityDecisionRef: organizationAuthorityFields.applicabilityDecisionRef,
  authorityIncarnation: organizationAuthorityFields.authorityIncarnation,
  authorityRevision: organizationAuthorityFields.authorityRevision,
  evidenceRefs: organizationAuthorityFields.evidenceRefs,
  fieldContractVersion: organizationAuthorityFields.fieldContractVersion,
  outcome: organizationAuthorityFields.outcome,
  partyRef: organizationAuthorityFields.partyRef,
  partyRevision: organizationAuthorityFields.partyRevision,
  policyRevisions: organizationAuthorityFields.policyRevisions,
  profileRef: organizationAuthorityFields.profileRef,
  profileRevision: organizationAuthorityFields.profileRevision,
});

export const CustomerProfileIcoMigrationTargetSchema = Schema.Struct({
  legalEntityId: Schema.toEncoded(Schema.String.check(Schema.isUUID()).pipe(Schema.brand('ProfileIcoLegalEntityId'))),
  lifecycle: Schema.Literals(['ACTIVE', 'SUSPENDED', 'ARCHIVED']),
  organizationCorrelation: Schema.optionalKey(CounterpartyOrganizationIcoFactsResponseSchema.members[1]),
  organizationIcoAuthority: Schema.optionalKey(ProfileIcoMigrationOrganizationAuthoritySchema),
  partyCorrelation: Schema.optionalKey(CounterpartyMigrationCorrelationResponseSchema),
  profileRef: CommerceCustomerProfileRefSchema,
  reconciliationRequired: Schema.optionalKey(Schema.Boolean),
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  subjectResourceId: ProfileBoundedKeySchema,
});
export const CustomerProfileIcoMigrationInputSchema = Schema.Struct({
  asOf: ProfileInstantSchema,
  planId: ProfileBoundedKeySchema,
  reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  sourceContext: SourceProcessingEligibilityRequestSchema.fields.source,
});
export const CustomerProfileIcoMigrationRecordSchema = Schema.Struct({
  classification: Schema.Literals([
    'MATCHED',
    'NO_TARGET',
    'MULTIPLE_TARGETS',
    'CONFLICTING_LEGACY_VALUES',
    'PROVENANCE_MISSING',
    'HISTORICAL_ONLY',
    'TARGET_INELIGIBLE',
    'COUNTERPARTY_CORRELATION_UNAVAILABLE',
    'TARGET_SCOPE_UNAUTHORIZED',
    'CURRENT_OUTSIDE_PLAN_TIME',
  ]),
  legacy: LegacyIcoInventoryAssertionSchema,
  targets: Schema.Array(CustomerProfileIcoMigrationTargetSchema),
});
export const CustomerProfileIcoMigrationPlanSchema = Schema.Struct({
  ...CustomerProfileIcoMigrationInputSchema.fields,
  authorityRevision: Schema.optionalKey(
    Schema.toEncoded(Schema.OptionFromNullOr(Schema.Int.check(Schema.isGreaterThan(0)))),
  ),
  nativeTargetInventoryVersion: Schema.optionalKey(Schema.String),
  partySnapshotVersion: Schema.String,
  records: Schema.Array(CustomerProfileIcoMigrationRecordSchema),
  targetInventoryVersion: Schema.String,
  tenantId: Schema.toEncoded(Schema.String.check(Schema.isUUID()).pipe(Schema.brand('ProfileIcoTenantId'))),
  version: Schema.Literal(1),
});
export type CustomerProfileIcoMigrationPlan = typeof CustomerProfileIcoMigrationPlanSchema.Type;
export const MigrateCustomerProfileIcoPayloadSchema = Schema.Struct({
  ...CustomerProfileIcoMigrationInputSchema.fields,
  expectedAuthorityRevision: Schema.optionalKey(
    Schema.toEncoded(Schema.OptionFromNullOr(Schema.Int.check(Schema.isGreaterThan(0)))),
  ),
  expectedPartySnapshotVersion: Schema.String.check(Schema.isMinLength(1)),
  expectedTargetInventoryVersion: Schema.String.check(Schema.isMinLength(1)),
  operation: Schema.Literals(['STAGE', 'CUTOVER', 'RESTAGE', 'RECONCILE']),
}).check(
  Schema.makeFilter((input) =>
    input.operation === 'STAGE' ||
    input.operation === 'CUTOVER' ||
    (input.expectedAuthorityRevision !== undefined && input.expectedAuthorityRevision !== null)
      ? undefined
      : 'Restage and reconcile require the exact current authority revision',
  ),
);
export type MigrateCustomerProfileIcoPayload = typeof MigrateCustomerProfileIcoPayloadSchema.Type;
export const MigrateCustomerProfileIcoResultSchema = Schema.Struct({
  partyFenceId: Schema.toEncoded(Schema.OptionFromNullOr(Schema.String)),
  phase: Schema.Literals(['STAGING', 'COMMERCE']),
  plan: CustomerProfileIcoMigrationPlanSchema,
  replayed: Schema.Boolean,
});
export class CustomerProfileIcoMigrationRejected extends Schema.TaggedError<CustomerProfileIcoMigrationRejected>()(
  'CustomerProfileIcoMigrationRejected',
  {
    code: Schema.Literals([
      'INVENTORY_UNAVAILABLE',
      'STALE_PLAN',
      'PLAN_CONFLICT',
      'AUTHORITY_NOT_FENCED',
      'PRIVACY_DENIED',
      'PERSISTENCE_UNAVAILABLE',
    ]),
    reason: Schema.String,
  },
) {}

const TrustedMigrationObservationSchema = Schema.Struct({
  authorityRevision: Schema.optionalKey(
    Schema.toEncoded(Schema.OptionFromNullOr(Schema.Int.check(Schema.isGreaterThan(0)))),
  ),
  legalEntityId: CustomerProfileIcoMigrationTargetSchema.fields.legalEntityId,
  observedAt: ProfileInstantSchema,
});
type MigrationObservation = typeof TrustedMigrationObservationSchema.Type;
type LegacyAssertion = typeof LegacyIcoInventoryAssertionSchema.Type;
type MigrationTarget = typeof CustomerProfileIcoMigrationTargetSchema.Type;
type Classification = typeof CustomerProfileIcoMigrationRecordSchema.Type.classification;
const isCurrentAt = (assertion: LegacyAssertion, observedAt: MigrationObservation['observedAt']) =>
  assertion.isCurrent &&
  assertion.state === 'ACTIVE' &&
  assertion.validFrom <= observedAt &&
  (assertion.validTo === null || assertion.validTo > observedAt);
const hasOriginalProvenance = (legacy: LegacyAssertion) => {
  if ('ownerReceiptRef' in legacy.provenance) {
    const ref = legacy.provenance.ownerReceiptRef;
    return (
      Schema.is(PartyOfficialIdentifierRefSchema)(ref) &&
      ref.resourceId === legacy.assertionRef.resourceId &&
      ref.tenantId === legacy.assertionRef.tenantId
    );
  }
  return legacy.provenance.source.trim().length > 0 && legacy.provenance.acceptedByActionInvocationId.trim().length > 0;
};
const classifyTarget = (
  candidates: readonly MigrationTarget[],
  targets: readonly MigrationTarget[],
  trusted: MigrationObservation,
): Classification => {
  if (targets.some((target) => target.profileRef.kind === 'COUNTERPARTY' && target.partyCorrelation === undefined)) {
    return 'COUNTERPARTY_CORRELATION_UNAVAILABLE';
  }
  if (candidates.length > 1) {
    return 'MULTIPLE_TARGETS';
  }
  const [target] = candidates;
  if (target === undefined) {
    return 'NO_TARGET';
  }
  if (target.profileRef.kind === 'RETAIL' && target.legalEntityId !== trusted.legalEntityId) {
    return 'TARGET_SCOPE_UNAUTHORIZED';
  }
  if (
    target.reconciliationRequired === true ||
    target.lifecycle !== 'ACTIVE' ||
    target.partyCorrelation?.archived === true
  ) {
    return 'TARGET_INELIGIBLE';
  }
  return 'MATCHED';
};
const classifyAssertion = (
  legacy: LegacyAssertion,
  assertions: readonly LegacyAssertion[],
  candidates: readonly MigrationTarget[],
  targets: readonly MigrationTarget[],
  input: Pick<typeof CustomerProfileIcoMigrationInputSchema.Type, 'asOf'>,
  trusted: MigrationObservation,
): Classification => {
  if (
    legacy.isCurrent &&
    legacy.state === 'ACTIVE' &&
    (legacy.validFrom > trusted.observedAt || legacy.validFrom > input.asOf)
  ) {
    return 'CURRENT_OUTSIDE_PLAN_TIME';
  }
  if (!isCurrentAt(legacy, trusted.observedAt)) {
    return 'HISTORICAL_ONLY';
  }
  if (
    assertions.filter(
      (other) => other.partyRef.resourceId === legacy.partyRef.resourceId && isCurrentAt(other, trusted.observedAt),
    ).length !== 1
  ) {
    return 'CONFLICTING_LEGACY_VALUES';
  }
  if (!hasOriginalProvenance(legacy)) {
    return 'PROVENANCE_MISSING';
  }
  return classifyTarget(candidates, targets, trusted);
};

export const classifyCustomerProfileIcoMigrationRecords = (
  input: Pick<typeof CustomerProfileIcoMigrationInputSchema.Type, 'asOf'>,
  inventory: Readonly<{ assertions: readonly LegacyAssertion[] }>,
  targets: readonly MigrationTarget[],
  trusted: MigrationObservation,
) =>
  inventory.assertions.map((legacy) => {
    const candidates = targets.filter((target) =>
      target.profileRef.kind === 'RETAIL'
        ? target.subjectResourceId === legacy.partyRef.resourceId
        : target.partyCorrelation?.partyRef.resourceId === legacy.partyRef.resourceId,
    );
    return {
      classification: classifyAssertion(legacy, inventory.assertions, candidates, targets, input, trusted),
      legacy,
      targets: candidates,
    };
  });

/** Only exact durable Party correlation counts. Equal IČO strings never nominate a profile. */
export const classifyCustomerProfileIcoMigration = (
  input: typeof CustomerProfileIcoMigrationInputSchema.Type,
  inventory: Readonly<{ assertions: readonly LegacyAssertion[]; snapshotVersion: string; tenantId: string }>,
  targets: readonly MigrationTarget[],
  targetInventoryVersion: string,
  trusted: MigrationObservation,
): CustomerProfileIcoMigrationPlan => ({
  ...input,
  authorityRevision: trusted.authorityRevision ?? null,
  partySnapshotVersion: inventory.snapshotVersion,
  records: classifyCustomerProfileIcoMigrationRecords(input, inventory, targets, trusted),
  targetInventoryVersion,
  tenantId: inventory.tenantId,
  version: 1,
});
