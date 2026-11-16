import { Schema } from 'effect';
import {
  IcoCorrelationWitnessesSchema,
  LegacyIcoInventoryAssertionSchema,
} from '@app/party-registry/apis/legacy-ico-inventory';
import { PartyOfficialIdentifierRefSchema } from '@app/party-registry/resources/party-official-identifier';
import { CounterpartyPurchasingProfileRefSchema } from '../resources/counterparty-purchasing-profile.ts';
import { CounterpartyOrganizationIcoFactsResponseSchema } from '@app/party-registry/apis/counterparty-organization-ico-facts';
import { ProfileInstantSchema } from './profile-contracts.ts';
import {
  CustomerProfileIcoMigrationRecordSchema,
  CustomerProfileIcoMigrationPlanSchema,
  CustomerProfileIcoMigrationTargetSchema,
} from './customer-profile-ico-migration.ts';

export const ORGANIZATION_ICO_MIGRATION_PROJECTION = 'ORGANIZATION_ICO_FIELDS_V1';
const OpaqueIdSchema = Schema.toEncoded(
  Schema.String.check(Schema.isUUID()).pipe(Schema.brand('OrganizationIcoMigrationId')),
);
const VersionSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const AuthorityRevisionSchema = Schema.toEncoded(Schema.OptionFromNullOr(Schema.Int.check(Schema.isGreaterThan(0))));
const OrganizationProfileIcoMigrationPlanInputSchema = Schema.Struct({
  asOf: ProfileInstantSchema,
  planId: OpaqueIdSchema,
  sourceContext: Schema.Null,
});
export const OrganizationProfileIcoMigrationInputSchema = Schema.Struct({
  ...OrganizationProfileIcoMigrationPlanInputSchema.fields,
  correlationWitnesses: Schema.optionalKey(IcoCorrelationWitnessesSchema),
});
export type OrganizationProfileIcoMigrationInput = typeof OrganizationProfileIcoMigrationInputSchema.Type;
export const OrganizationProfileIcoMigrationLegacySchema = Schema.Struct({
  ...LegacyIcoInventoryAssertionSchema.fields,
  provenance: Schema.Struct({ ownerReceiptRef: PartyOfficialIdentifierRefSchema }),
});
export const OrganizationProfileIcoMigrationPreparedPlanSchema = Schema.Struct({
  ...OrganizationProfileIcoMigrationPlanInputSchema.fields,
  authorityRevision: AuthorityRevisionSchema,
  correlationCoverageVersion: Schema.optionalKey(VersionSchema),
  nativeTargetInventoryVersion: VersionSchema,
  partySnapshotVersion: VersionSchema,
  projection: Schema.Literal(ORGANIZATION_ICO_MIGRATION_PROJECTION),
  records: Schema.Array(
    Schema.Struct({
      classification: CustomerProfileIcoMigrationRecordSchema.fields.classification,
      legacy: OrganizationProfileIcoMigrationLegacySchema,
      targets: Schema.Array(CustomerProfileIcoMigrationTargetSchema),
    }),
  ),
  targetInventoryVersion: VersionSchema,
  tenantId: CustomerProfileIcoMigrationPlanSchema.fields.tenantId,
  version: Schema.Literal(1),
}).check(
  Schema.makeFilter((plan) =>
    plan.records.every((record) =>
      record.targets.every(
        (target) =>
          target.profileRef.kind === 'COUNTERPARTY' &&
          target.organizationIcoAuthority !== undefined &&
          target.organizationCorrelation !== undefined,
      ),
    )
      ? undefined
      : 'Every company migration target requires exact current organization owner authority',
  ),
);
export type OrganizationProfileIcoMigrationPreparedPlan = typeof OrganizationProfileIcoMigrationPreparedPlanSchema.Type;
export const OrganizationProfileIcoMigrationTargetSchema = Schema.Struct({
  ...CounterpartyOrganizationIcoFactsResponseSchema.members[1].fields,
  profileRef: CounterpartyPurchasingProfileRefSchema,
  profileRevision: Schema.Int.check(Schema.isGreaterThan(0)),
});
export const OrganizationProfileIcoMigrationReportSchema = Schema.Struct({
  ...OrganizationProfileIcoMigrationPlanInputSchema.fields,
  authorityRevision: AuthorityRevisionSchema,
  correlationCoverageVersion: Schema.optionalKey(VersionSchema),
  homeCorrelationWitnesses: Schema.optionalKey(IcoCorrelationWitnessesSchema),
  nativeTargetInventoryVersion: VersionSchema,
  partySnapshotVersion: VersionSchema,
  projection: Schema.Literal(ORGANIZATION_ICO_MIGRATION_PROJECTION),
  records: Schema.Array(
    Schema.Struct({
      classification: CustomerProfileIcoMigrationRecordSchema.fields.classification,
      legacy: OrganizationProfileIcoMigrationLegacySchema,
      targets: Schema.Array(OrganizationProfileIcoMigrationTargetSchema),
    }),
  ),
  targetInventoryVersion: VersionSchema,
  tenantId: CustomerProfileIcoMigrationPlanSchema.fields.tenantId,
  version: Schema.Literal(1),
});
export type OrganizationProfileIcoMigrationReport = typeof OrganizationProfileIcoMigrationReportSchema.Type;
export const MigrateOrganizationCustomerProfileIcoPayloadSchema = Schema.Struct({
  ...OrganizationProfileIcoMigrationInputSchema.fields,
  expectedAuthorityRevision: Schema.optionalKey(AuthorityRevisionSchema),
  expectedPartySnapshotVersion: VersionSchema,
  expectedTargetInventoryVersion: VersionSchema,
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
export type MigrateOrganizationCustomerProfileIcoPayload =
  typeof MigrateOrganizationCustomerProfileIcoPayloadSchema.Type;
export const MigrateOrganizationCustomerProfileIcoResultSchema = Schema.Struct({
  partyFenceId: Schema.toEncoded(Schema.OptionFromNullOr(Schema.String)),
  phase: Schema.Literals(['STAGING', 'COMMERCE']),
  plan: OrganizationProfileIcoMigrationReportSchema,
  replayed: Schema.Boolean,
});

/** Drops internal lifecycle/correlation-policy details; no actor, raw source or reason is projected. */
export const projectOrganizationProfileIcoMigration = (plan: OrganizationProfileIcoMigrationPreparedPlan) =>
  Schema.decodeUnknownEffect(OrganizationProfileIcoMigrationReportSchema)({
    ...plan,
    records: plan.records.map((record) => ({
      classification: record.classification,
      legacy: record.legacy,
      targets: record.targets.map((target) => ({
        ...target.organizationCorrelation,
        profileRef: {
          moduleId: target.profileRef.moduleId,
          resourceId: target.profileRef.resourceId,
          resourceType: target.profileRef.resourceType,
          tenantId: target.profileRef.tenantId,
        },
        profileRevision: target.organizationIcoAuthority?.profileRevision,
      })),
    })),
  });
