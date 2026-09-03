import type {
  PartySubjectEvidence,
  PartyEvidenceEvaluation,
} from '../../shared/domain/identity-contracts.ts';
/* eslint-disable sort-keys -- Typed columns follow the authoritative physical schema order. */
import {
  enableGovernedRls,
  tenantLegalEntityRlsPolicies,
  tenantRlsPolicies,
} from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { AresAppliedEvidence } from '../../shared/domain/ares-application.ts';
import type {
  MergeSelectionEvidenceStep,
  MergeSurvivorSelectionReason,
} from '../../shared/domain/merge-selection.ts';
import type { PartyRef } from '../../shared/resources/party.ts';

export const PARTY_SCHEMA_NAME = 'party';

export const PARTY_TABLE_INVENTORY = [
  'counterparties',
  'counterparty_admin_read_models',
  'counterparty_role_admin_read_models',
  'counterparty_role_periods',
  'duplicate_candidate_case_parties',
  'duplicate_candidate_cases',
  'parties',
  'party_aliases',
  'party_contact_point_purposes',
  'party_contact_points',
  'party_corrections',
  'party_fact_assertions',
  'party_identifier_claims',
  'party_match_decisions',
  'party_merges',
  'party_official_identifiers',
  'party_relationships',
] as const;

export const partySchema = pgSchema(PARTY_SCHEMA_NAME);

const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).defaultNow().notNull();
const recordedAt = () => timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull();
const validFrom = () => timestamp('valid_from', { withTimezone: true }).notNull();
const validTo = () => timestamp('valid_to', { withTimezone: true });

const externalEvidenceConstraint = (name: string, column: AnyPgColumn) =>
  check(
    name,
    sql`${column} is null or coalesce((jsonb_typeof(${column}) = 'object' and octet_length(${column}::text) <= 4096 and ${column} ?& array['authorityPolicyKey', 'authorityPolicyVersion', 'cacheAgeSeconds', 'decidedAt', 'evidenceRef', 'fact', 'observedAt', 'outcome', 'provider', 'providerChangedOn', 'providerRecordRef', 'queryIco', 'reasonCode', 'servedAt'] and ${column} - array['authorityPolicyKey', 'authorityPolicyVersion', 'cacheAgeSeconds', 'decidedAt', 'evidenceRef', 'fact', 'observedAt', 'outcome', 'provider', 'providerChangedOn', 'providerRecordRef', 'queryIco', 'reasonCode', 'servedAt'] = '{}'::jsonb and ${column}->>'provider' = 'ares' and ${column}->>'authorityPolicyKey' = 'party_registry.ares_enrichment' and ${column}->>'authorityPolicyVersion' = '1' and coalesce(${column}->>'queryIco', '') ~ '^[0-9]{8}$' and coalesce(length(${column}->>'evidenceRef'), 0) between 1 and 200 and ${column}->>'fact' in ('BUSINESS_NAME', 'ICO', 'REGISTERED_ADDRESS', 'PARTY_CANDIDATE') and ${column}->>'outcome' in ('PREFILL_ONLY', 'APPLY_ENRICHMENT', 'NO_CHANGE', 'NEEDS_CONFIRMATION', 'CORRECTION_CANDIDATE', 'IDENTITY_AMBIGUITY') and coalesce(${column}->>'reasonCode', '') ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$' and length(${column}->>'reasonCode') <= 100 and jsonb_typeof(${column}->'cacheAgeSeconds') = 'number' and coalesce(${column}->>'cacheAgeSeconds', '') ~ '^[0-9]+$' and coalesce(${column}->>'observedAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{3})?Z$' and coalesce(${column}->>'servedAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{3})?Z$' and coalesce(${column}->>'decidedAt', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{3})?Z$' and (${column}->'providerChangedOn' = 'null'::jsonb or coalesce(${column}->>'providerChangedOn', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') and (${column}->'providerRecordRef' = 'null'::jsonb or (jsonb_typeof(${column}->'providerRecordRef') = 'string' and length(${column}->>'providerRecordRef') between 1 and 200))), false)`,
  );

export interface PartyCandidateIdentifierSnapshot {
  readonly identifierTypeKey: 'CZ_DIC' | 'ICO';
  readonly namespace: string;
  readonly normalizedValue: string;
  readonly verificationState: 'REJECTED' | 'UNVERIFIED' | 'VERIFIED';
}

export interface PartyCandidateSnapshot {
  readonly subjectEvidence?: readonly PartySubjectEvidence[];
  readonly contactSignals?: readonly string[];
  readonly evidenceArtifactRefs?: readonly string[];
  readonly intent?: string;
  readonly names: readonly string[];
  readonly officialIdentifiers?: readonly PartyCandidateIdentifierSnapshot[];
  readonly partyType?: 'ORGANIZATION' | 'PERSON' | 'UNRESOLVED';
  readonly policyVersion?: string;
  readonly provenance: {
    readonly externalEvidence?: AresAppliedEvidence;
    readonly method: string;
    readonly source: string;
  };
  readonly sourceRecordRefs?: readonly string[];
  readonly validFrom: string;
}

export interface PartyEvidenceExplanation {
  readonly evidenceRefs?: readonly string[];
  readonly identifierType?: 'CZ_DIC' | 'ICO';
  readonly namespace?: string;
  readonly normalizedValue?: string;
  readonly officialIdentifierRef?: {
    readonly moduleId: 'party.registry';
    readonly resourceId: string;
    readonly resourceType: 'party.registry.party-official-identifier';
    readonly tenantId: string;
  };
  readonly outcome?: 'AMBIGUOUS' | 'MATCHED' | 'NO_MATCH';
  readonly reason: string;
  readonly ruleKey: string;
  readonly verification?: 'REJECTED' | 'UNVERIFIED' | 'VERIFIED';
}

export interface PartyMergeConsumerReadiness {
  readonly collisionCount?: number;
  readonly consumerKey: string;
  readonly status: 'BLOCKED' | 'READY' | 'UNAVAILABLE';
}

export interface PartyMergeReadinessEvidence {
  readonly version: 1;
  readonly confirmedDuplicateDecisionId: string;
  readonly decisionActorPrincipalId: string;
  readonly absorbedPartyRefs: readonly PartyRef[];
  readonly selectionPolicyVersion: string;
  readonly selectionReason: MergeSurvivorSelectionReason;
  readonly selectionEvidenceChain: readonly MergeSelectionEvidenceStep[];
  readonly blockingReasons: readonly string[];
  readonly consumerStatuses: readonly PartyMergeConsumerReadiness[];
}

export const parties = enableGovernedRls(
  partySchema.table(
    'parties',
    {
      partyId: uuid('party_id').defaultRandom().primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      currentType: text('current_type').notNull(),
      currentDisplayName: text('current_display_name'),
      revision: integer('revision').default(1).notNull(),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
      archivedAt: timestamp('archived_at', { withTimezone: true }),
    },
    (table) => [
      unique('party_parties_tenant_id_uk').on(table.tenantId, table.partyId),
      index('party_parties_current_name_idx')
        .on(table.tenantId, table.currentDisplayName)
        .where(sql`${table.archivedAt} is null`),
      check(
        'party_parties_type_ck',
        sql`${table.currentType} in ('PERSON', 'ORGANIZATION', 'UNRESOLVED')`,
      ),
      check(
        'party_parties_display_name_ck',
        sql`${table.currentDisplayName} is null or (${table.currentDisplayName} = btrim(${table.currentDisplayName}) and length(${table.currentDisplayName}) > 0)`,
      ),
      check('party_parties_revision_ck', sql`${table.revision} > 0`),
      ...tenantRlsPolicies('party_parties_tenant', table.tenantId),
    ],
  ),
);

export const partyFactAssertions = enableGovernedRls(
  partySchema.table(
    'party_fact_assertions',
    {
      assertionId: uuid('assertion_id').defaultRandom().primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      partyId: uuid('party_id').notNull(),
      factKind: text('fact_kind').notNull(),
      evidenceEvaluation: jsonb('evidence_evaluation').$type<PartyEvidenceEvaluation>(),
      normalizedValue: text('normalized_value').notNull(),
      validFrom: validFrom(),
      validTo: validTo(),
      recordedAt: recordedAt(),
      state: text('state').default('ACTIVE').notNull(),
      isCurrent: boolean('is_current').default(true).notNull(),
      provenanceSource: text('provenance_source').notNull(),
      provenanceMethod: text('provenance_method').notNull(),
      externalEvidence: jsonb('external_evidence').$type<AresAppliedEvidence>(),
      provenanceAuthoritative: boolean('provenance_authoritative').default(false).notNull(),
      evidenceReference: text('evidence_reference'),
      verificationState: text('verification_state').default('UNVERIFIED').notNull(),
      verificationMethod: text('verification_method'),
      verifierReference: text('verifier_reference'),
      verifiedByPrincipalId: uuid('verified_by_principal_id'),
      verifiedAt: timestamp('verified_at', { withTimezone: true }),
      acceptedByActionInvocationId: uuid('accepted_by_action_invocation_id').notNull(),
      acceptedByPrincipalId: uuid('accepted_by_principal_id').notNull(),
      policyVersion: text('policy_version').notNull(),
      supersedesAssertionId: uuid('supersedes_assertion_id'),
      retractsAssertionId: uuid('retracts_assertion_id'),
    },
    (table) => [
      unique('party_fact_assertions_tenant_id_uk').on(table.tenantId, table.assertionId),
      foreignKey({
        columns: [table.tenantId, table.partyId],
        foreignColumns: [parties.tenantId, parties.partyId],
        name: 'party_fact_assertions_tenant_party_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.tenantId, table.supersedesAssertionId],
        foreignColumns: [table.tenantId, table.assertionId],
        name: 'party_fact_assertions_tenant_supersedes_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.tenantId, table.retractsAssertionId],
        foreignColumns: [table.tenantId, table.assertionId],
        name: 'party_fact_assertions_tenant_retracts_fk',
      }).onDelete('restrict'),
      index('party_fact_assertions_current_idx')
        .on(table.tenantId, table.partyId, table.factKind)
        .where(sql`${table.state} = 'ACTIVE' and ${table.isCurrent}`),
      check(
        'party_fact_assertions_kind_ck',
        sql`${table.factKind} in ('PARTY_TYPE', 'DISPLAY_NAME')`,
      ),
      check(
        'party_fact_assertions_value_ck',
        sql`${table.normalizedValue} = btrim(${table.normalizedValue}) and length(${table.normalizedValue}) > 0`,
      ),
      check(
        'party_fact_assertions_interval_ck',
        sql`${table.validTo} is null or ${table.validTo} >= ${table.validFrom}`,
      ),
      check(
        'party_fact_assertions_state_ck',
        sql`${table.state} in ('ACTIVE', 'ENDED', 'SUPERSEDED', 'RETRACTED', 'DISPUTED') and ((${table.state} = 'ACTIVE' and ${table.isCurrent}) or (${table.state} <> 'ACTIVE' and not ${table.isCurrent}))`,
      ),
      check(
        'party_fact_assertions_verification_ck',
        sql`${table.verificationState} in ('UNVERIFIED', 'VERIFIED', 'REJECTED') and (${table.verificationState} <> 'VERIFIED' or ${table.verifiedAt} is not null)`,
      ),
      externalEvidenceConstraint(
        'party_fact_assertions_external_evidence_ck',
        table.externalEvidence,
      ),
      ...tenantRlsPolicies('party_fact_assertions_tenant', table.tenantId),
    ],
  ),
);

export const partyOfficialIdentifiers = enableGovernedRls(
  partySchema.table(
    'party_official_identifiers',
    {
      officialIdentifierId: uuid('official_identifier_id').defaultRandom().primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      partyId: uuid('party_id').notNull(),
      identifierTypeKey: text('identifier_type_key').notNull(),
      namespace: text('namespace').notNull(),
      jurisdiction: text('jurisdiction').default('CZ').notNull(),
      normalizedValue: text('normalized_value').notNull(),
      validFrom: validFrom(),
      validTo: validTo(),
      recordedAt: recordedAt(),
      state: text('state').default('ACTIVE').notNull(),
      isCurrent: boolean('is_current').default(true).notNull(),
      provenanceSource: text('provenance_source').notNull(),
      provenanceMethod: text('provenance_method').notNull(),
      externalEvidence: jsonb('external_evidence').$type<AresAppliedEvidence>(),
      verificationState: text('verification_state').default('UNVERIFIED').notNull(),
      verifiedByPrincipalId: uuid('verified_by_principal_id'),
      verifiedAt: timestamp('verified_at', { withTimezone: true }),
      acceptedByActionInvocationId: uuid('accepted_by_action_invocation_id').notNull(),
      acceptedByPrincipalId: uuid('accepted_by_principal_id').notNull(),
      policyVersion: text('policy_version').notNull(),
      supersedesOfficialIdentifierId: uuid('supersedes_official_identifier_id'),
      retractsOfficialIdentifierId: uuid('retracts_official_identifier_id'),
    },
    (table) => [
      unique('party_official_identifiers_tenant_id_uk').on(
        table.tenantId,
        table.officialIdentifierId,
      ),
      foreignKey({
        columns: [table.tenantId, table.partyId],
        foreignColumns: [parties.tenantId, parties.partyId],
        name: 'party_official_identifiers_tenant_party_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.tenantId, table.supersedesOfficialIdentifierId],
        foreignColumns: [table.tenantId, table.officialIdentifierId],
        name: 'party_official_identifiers_tenant_supersedes_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.tenantId, table.retractsOfficialIdentifierId],
        foreignColumns: [table.tenantId, table.officialIdentifierId],
        name: 'party_official_identifiers_tenant_retracts_fk',
      }).onDelete('restrict'),
      index('party_official_identifiers_party_idx').on(
        table.tenantId,
        table.partyId,
        table.identifierTypeKey,
      ),
      check(
        'party_official_identifiers_type_ck',
        sql`${table.identifierTypeKey} in ('ICO', 'CZ_DIC')`,
      ),
      check(
        'party_official_identifiers_normalized_value_ck',
        sql`(${table.identifierTypeKey} = 'ICO' and ${table.normalizedValue} ~ '^[0-9]{8}$') or (${table.identifierTypeKey} = 'CZ_DIC' and ${table.normalizedValue} ~ '^CZ[0-9]{8,10}$')`,
      ),
      check(
        'party_official_identifiers_interval_ck',
        sql`${table.validTo} is null or ${table.validTo} >= ${table.validFrom}`,
      ),
      check(
        'party_official_identifiers_state_ck',
        sql`${table.state} in ('ACTIVE', 'ENDED', 'SUPERSEDED', 'RETRACTED', 'DISPUTED') and ((${table.state} = 'ACTIVE' and ${table.isCurrent}) or (${table.state} <> 'ACTIVE' and not ${table.isCurrent}))`,
      ),
      check(
        'party_official_identifiers_verification_ck',
        sql`${table.verificationState} in ('UNVERIFIED', 'VERIFIED', 'REJECTED') and (${table.verificationState} <> 'VERIFIED' or ${table.verifiedAt} is not null)`,
      ),
      externalEvidenceConstraint(
        'party_official_identifiers_external_evidence_ck',
        table.externalEvidence,
      ),
      ...tenantRlsPolicies('party_official_identifiers_tenant', table.tenantId),
    ],
  ),
);

export const partyIdentifierClaims = enableGovernedRls(
  partySchema.table(
    'party_identifier_claims',
    {
      identifierClaimId: uuid('identifier_claim_id').defaultRandom().primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      identifierTypeKey: text('identifier_type_key').notNull(),
      namespace: text('namespace').notNull(),
      normalizedValue: text('normalized_value').notNull(),
      partyId: uuid('party_id').notNull(),
      officialIdentifierId: uuid('official_identifier_id').notNull(),
      claimedAt: timestamp('claimed_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
      unique('party_identifier_claims_tenant_id_uk').on(table.tenantId, table.identifierClaimId),
      unique('party_identifier_claims_exact_claim_uk').on(
        table.tenantId,
        table.identifierTypeKey,
        table.namespace,
        table.normalizedValue,
      ),
      foreignKey({
        columns: [table.tenantId, table.partyId],
        foreignColumns: [parties.tenantId, parties.partyId],
        name: 'party_identifier_claims_tenant_party_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.tenantId, table.officialIdentifierId],
        foreignColumns: [
          partyOfficialIdentifiers.tenantId,
          partyOfficialIdentifiers.officialIdentifierId,
        ],
        name: 'party_identifier_claims_tenant_identifier_fk',
      }).onDelete('restrict'),
      index('party_identifier_claims_party_lookup_idx').on(table.tenantId, table.partyId),
      check(
        'party_identifier_claims_type_ck',
        sql`${table.identifierTypeKey} in ('ICO', 'CZ_DIC')`,
      ),
      ...tenantRlsPolicies('party_identifier_claims_tenant', table.tenantId),
    ],
  ),
);

export const partyContactPoints = enableGovernedRls(
  partySchema.table(
    'party_contact_points',
    {
      contactPointId: uuid('contact_point_id').defaultRandom().primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      partyId: uuid('party_id').notNull(),
      contactPointType: text('contact_point_type').notNull(),
      displayValue: text('display_value'),
      normalizedValue: text('normalized_value'),
      normalizationVersion: text('normalization_version'),
      phoneCountryCode: text('phone_country_code'),
      phoneExtension: text('phone_extension'),
      addressLine1: text('address_line_1'),
      addressLine2: text('address_line_2'),
      city: text('city'),
      postalCode: text('postal_code'),
      region: text('region'),
      countryCode: text('country_code'),
      privacyClassification: text('privacy_classification').notNull(),
      preferred: boolean('preferred').default(false).notNull(),
      revision: integer('revision').default(1).notNull(),
      validFrom: validFrom(),
      validTo: validTo(),
      recordedAt: recordedAt(),
      state: text('state').default('ACTIVE').notNull(),
      isCurrent: boolean('is_current').default(true).notNull(),
      endReason: text('end_reason'),
      endProvenanceSource: text('end_provenance_source'),
      endProvenanceMethod: text('end_provenance_method'),
      endEvidenceRefs: jsonb('end_evidence_refs').$type<readonly string[]>(),
      endedByActionInvocationId: uuid('ended_by_action_invocation_id'),
      endedByPrincipalId: uuid('ended_by_principal_id'),
      endedRecordedAt: timestamp('ended_recorded_at', { withTimezone: true }),
      provenanceSource: text('provenance_source').notNull(),
      provenanceMethod: text('provenance_method').notNull(),
      externalEvidence: jsonb('external_evidence').$type<AresAppliedEvidence>(),
      provenanceAuthoritative: boolean('provenance_authoritative').default(false).notNull(),
      evidenceReference: text('evidence_reference'),
      additionalEvidenceRefs: jsonb('additional_evidence_refs')
        .$type<readonly string[]>()
        .default([])
        .notNull(),
      verificationState: text('verification_state').default('UNVERIFIED').notNull(),
      verificationMethod: text('verification_method'),
      verifierReference: text('verifier_reference'),
      verifiedByPrincipalId: uuid('verified_by_principal_id'),
      verifiedAt: timestamp('verified_at', { withTimezone: true }),
      acceptedByActionInvocationId: uuid('accepted_by_action_invocation_id').notNull(),
      acceptedByPrincipalId: uuid('accepted_by_principal_id').notNull(),
      policyVersion: text('policy_version').notNull(),
      supersedesContactPointId: uuid('supersedes_contact_point_id'),
      retractsContactPointId: uuid('retracts_contact_point_id'),
    },
    (table) => [
      unique('party_contact_points_tenant_id_uk').on(table.tenantId, table.contactPointId),
      unique('party_contact_points_tenant_party_id_uk').on(
        table.tenantId,
        table.partyId,
        table.contactPointId,
      ),
      foreignKey({
        columns: [table.tenantId, table.partyId],
        foreignColumns: [parties.tenantId, parties.partyId],
        name: 'party_contact_points_tenant_party_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.tenantId, table.supersedesContactPointId],
        foreignColumns: [table.tenantId, table.contactPointId],
        name: 'party_contact_points_tenant_supersedes_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.tenantId, table.retractsContactPointId],
        foreignColumns: [table.tenantId, table.contactPointId],
        name: 'party_contact_points_tenant_retracts_fk',
      }).onDelete('restrict'),
      index('party_contact_points_current_idx')
        .on(table.tenantId, table.partyId, table.contactPointType)
        .where(sql`${table.state} = 'ACTIVE' and ${table.isCurrent}`),
      uniqueIndex('party_contact_points_current_preferred_uk')
        .on(table.tenantId, table.partyId, table.contactPointType)
        .where(
          sql`${table.preferred} and ${table.contactPointType} in ('EMAIL', 'PHONE') and ${table.state} = 'ACTIVE' and ${table.isCurrent}`,
        ),
      check(
        'party_contact_points_type_ck',
        sql`${table.contactPointType} in ('EMAIL', 'PHONE', 'ADDRESS')`,
      ),
      check(
        'party_contact_points_shape_ck',
        sql`(${table.contactPointType} = 'EMAIL' and length(btrim(${table.displayValue})) > 0 and length(btrim(${table.normalizedValue})) > 0 and length(btrim(${table.normalizationVersion})) > 0 and ${table.phoneCountryCode} is null and ${table.phoneExtension} is null and ${table.addressLine1} is null and ${table.city} is null and ${table.postalCode} is null and ${table.countryCode} is null) or (${table.contactPointType} = 'PHONE' and length(btrim(${table.displayValue})) > 0 and ${table.normalizedValue} ~ '^\\+[1-9][0-9]{6,14}$' and length(btrim(${table.normalizationVersion})) > 0 and (${table.phoneCountryCode} is null or ${table.phoneCountryCode} ~ '^[A-Z]{2}$') and (${table.phoneExtension} is null or ${table.phoneExtension} ~ '^[0-9]{1,12}$') and ${table.addressLine1} is null and ${table.city} is null and ${table.postalCode} is null and ${table.countryCode} is null) or (${table.contactPointType} = 'ADDRESS' and ${table.normalizedValue} is null and ${table.normalizationVersion} is null and ${table.phoneCountryCode} is null and ${table.phoneExtension} is null and ${table.countryCode} ~ '^[A-Z]{2}$' and num_nonnulls(nullif(btrim(${table.addressLine1}), ''), nullif(btrim(${table.addressLine2}), ''), nullif(btrim(${table.city}), ''), nullif(btrim(${table.postalCode}), ''), nullif(btrim(${table.region}), '')) >= 2 and not ${table.preferred})`,
      ),
      check(
        'party_contact_points_privacy_ck',
        sql`${table.privacyClassification} in ('PUBLIC', 'BUSINESS_SENSITIVE', 'PERSONAL')`,
      ),
      check(
        'party_contact_points_additional_evidence_ck',
        sql`jsonb_typeof(${table.additionalEvidenceRefs}) = 'array' and jsonb_array_length(${table.additionalEvidenceRefs}) <= 32`,
      ),
      check(
        'party_contact_points_interval_ck',
        sql`${table.validTo} is null or ${table.validTo} >= ${table.validFrom}`,
      ),
      check(
        'party_contact_points_state_ck',
        sql`${table.state} in ('ACTIVE', 'ENDED', 'SUPERSEDED', 'RETRACTED', 'DISPUTED') and ((${table.state} = 'ACTIVE' and ${table.isCurrent}) or (${table.state} <> 'ACTIVE' and not ${table.isCurrent}))`,
      ),
      check(
        'party_contact_points_end_evidence_ck',
        sql`(${table.validTo} is null and ${table.endReason} is null and ${table.endProvenanceSource} is null and ${table.endProvenanceMethod} is null and ${table.endEvidenceRefs} is null and ${table.endedByActionInvocationId} is null and ${table.endedByPrincipalId} is null and ${table.endedRecordedAt} is null) or (${table.validTo} is not null and ${table.endReason} = btrim(${table.endReason}) and length(${table.endReason}) > 0 and ${table.endProvenanceSource} = btrim(${table.endProvenanceSource}) and length(${table.endProvenanceSource}) > 0 and ${table.endProvenanceMethod} = btrim(${table.endProvenanceMethod}) and length(${table.endProvenanceMethod}) > 0 and jsonb_typeof(${table.endEvidenceRefs}) = 'array' and jsonb_array_length(${table.endEvidenceRefs}) <= 32 and ${table.endedByActionInvocationId} is not null and ${table.endedByPrincipalId} is not null and ${table.endedRecordedAt} is not null and ${table.endedRecordedAt} >= ${table.recordedAt})`,
      ),
      check(
        'party_contact_points_verification_ck',
        sql`${table.verificationState} in ('UNVERIFIED', 'VERIFIED', 'REJECTED') and (${table.verificationState} <> 'VERIFIED' or (${table.verifiedAt} is not null and length(btrim(${table.verificationMethod})) > 0 and length(btrim(${table.verifierReference})) > 0))`,
      ),
      check('party_contact_points_revision_ck', sql`${table.revision} > 0`),
      externalEvidenceConstraint(
        'party_contact_points_external_evidence_ck',
        table.externalEvidence,
      ),
      ...tenantRlsPolicies('party_contact_points_tenant', table.tenantId),
    ],
  ),
);

export const partyContactPointPurposes = enableGovernedRls(
  partySchema.table(
    'party_contact_point_purposes',
    {
      contactPointPurposeId: uuid('contact_point_purpose_id').defaultRandom().primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      partyId: uuid('party_id').notNull(),
      contactPointId: uuid('contact_point_id').notNull(),
      purposeKey: text('purpose_key').notNull(),
      registryContext: text('registry_context').default('GENERAL').notNull(),
      jurisdiction: text('jurisdiction').default('ZZ').notNull(),
      preferred: boolean('preferred').default(false).notNull(),
      validFrom: validFrom(),
      validTo: validTo(),
      recordedAt: recordedAt(),
      state: text('state').default('ACTIVE').notNull(),
      isCurrent: boolean('is_current').default(true).notNull(),
      endReason: text('end_reason'),
      endProvenanceSource: text('end_provenance_source'),
      endProvenanceMethod: text('end_provenance_method'),
      endEvidenceRefs: jsonb('end_evidence_refs').$type<readonly string[]>(),
      endedByActionInvocationId: uuid('ended_by_action_invocation_id'),
      endedByPrincipalId: uuid('ended_by_principal_id'),
      endedRecordedAt: timestamp('ended_recorded_at', { withTimezone: true }),
      provenanceSource: text('provenance_source').notNull(),
      provenanceMethod: text('provenance_method').notNull(),
      externalEvidence: jsonb('external_evidence').$type<AresAppliedEvidence>(),
      provenanceAuthoritative: boolean('provenance_authoritative').default(false).notNull(),
      evidenceReference: text('evidence_reference'),
      verificationState: text('verification_state').default('UNVERIFIED').notNull(),
      verificationMethod: text('verification_method'),
      verifierReference: text('verifier_reference'),
      verifiedByPrincipalId: uuid('verified_by_principal_id'),
      verifiedAt: timestamp('verified_at', { withTimezone: true }),
      acceptedByActionInvocationId: uuid('accepted_by_action_invocation_id').notNull(),
      acceptedByPrincipalId: uuid('accepted_by_principal_id').notNull(),
      policyVersion: text('policy_version').notNull(),
      revision: integer('revision').default(1).notNull(),
    },
    (table) => [
      unique('party_contact_point_purposes_tenant_id_uk').on(
        table.tenantId,
        table.contactPointPurposeId,
      ),
      foreignKey({
        columns: [table.tenantId, table.partyId, table.contactPointId],
        foreignColumns: [
          partyContactPoints.tenantId,
          partyContactPoints.partyId,
          partyContactPoints.contactPointId,
        ],
        name: 'party_contact_point_purposes_contact_fk',
      }).onDelete('restrict'),
      index('party_contact_point_purposes_current_idx')
        .on(table.tenantId, table.partyId, table.purposeKey)
        .where(sql`${table.state} = 'ACTIVE' and ${table.isCurrent}`),
      uniqueIndex('party_contact_point_purposes_current_preferred_uk')
        .on(
          table.tenantId,
          table.partyId,
          table.purposeKey,
          table.registryContext,
          table.jurisdiction,
        )
        .where(sql`${table.preferred} and ${table.state} = 'ACTIVE' and ${table.isCurrent}`),
      uniqueIndex('party_contact_point_purposes_current_registered_uk')
        .on(table.tenantId, table.partyId, table.registryContext, table.jurisdiction)
        .where(
          sql`${table.purposeKey} = 'REGISTERED' and ${table.state} = 'ACTIVE' and ${table.isCurrent}`,
        ),
      check(
        'party_contact_point_purposes_key_ck',
        sql`${table.purposeKey} in ('REGISTERED', 'BILLING', 'DELIVERY', 'CORRESPONDENCE')`,
      ),
      check(
        'party_contact_point_purposes_registry_ck',
        sql`(${table.purposeKey} <> 'REGISTERED') or (${table.registryContext} <> 'GENERAL' and ${table.jurisdiction} ~ '^[A-Z]{2}$' and ${table.jurisdiction} <> 'ZZ')`,
      ),
      check(
        'party_contact_point_purposes_interval_ck',
        sql`${table.validTo} is null or ${table.validTo} >= ${table.validFrom}`,
      ),
      check(
        'party_contact_point_purposes_state_ck',
        sql`${table.state} in ('ACTIVE', 'ENDED', 'SUPERSEDED', 'RETRACTED', 'DISPUTED') and ((${table.state} = 'ACTIVE' and ${table.isCurrent}) or (${table.state} <> 'ACTIVE' and not ${table.isCurrent}))`,
      ),
      check(
        'party_contact_point_purposes_end_evidence_ck',
        sql`(${table.validTo} is null and ${table.endReason} is null and ${table.endProvenanceSource} is null and ${table.endProvenanceMethod} is null and ${table.endEvidenceRefs} is null and ${table.endedByActionInvocationId} is null and ${table.endedByPrincipalId} is null and ${table.endedRecordedAt} is null) or (${table.validTo} is not null and ${table.endReason} = btrim(${table.endReason}) and length(${table.endReason}) > 0 and ${table.endProvenanceSource} = btrim(${table.endProvenanceSource}) and length(${table.endProvenanceSource}) > 0 and ${table.endProvenanceMethod} = btrim(${table.endProvenanceMethod}) and length(${table.endProvenanceMethod}) > 0 and jsonb_typeof(${table.endEvidenceRefs}) = 'array' and jsonb_array_length(${table.endEvidenceRefs}) <= 32 and ${table.endedByActionInvocationId} is not null and ${table.endedByPrincipalId} is not null and ${table.endedRecordedAt} is not null and ${table.endedRecordedAt} >= ${table.recordedAt})`,
      ),
      check(
        'party_contact_point_purposes_verification_ck',
        sql`${table.verificationState} in ('UNVERIFIED', 'VERIFIED', 'REJECTED') and (${table.verificationState} <> 'VERIFIED' or (${table.verifiedAt} is not null and length(btrim(${table.verificationMethod})) > 0 and length(btrim(${table.verifierReference})) > 0))`,
      ),
      check('party_contact_point_purposes_revision_ck', sql`${table.revision} > 0`),
      externalEvidenceConstraint(
        'party_contact_point_purposes_external_evidence_ck',
        table.externalEvidence,
      ),
      ...tenantRlsPolicies('party_contact_point_purposes_tenant', table.tenantId),
    ],
  ),
);

export const partyRelationships = enableGovernedRls(
  partySchema.table(
    'party_relationships',
    {
      relationshipId: uuid('relationship_id').defaultRandom().primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      fromPartyId: uuid('from_party_id').notNull(),
      toPartyId: uuid('to_party_id').notNull(),
      relationshipType: text('relationship_type').notNull(),
      revision: integer('revision').default(1).notNull(),
      validFrom: timestamp('valid_from', { withTimezone: true }),
      validTo: validTo(),
      recordedAt: recordedAt(),
      assertionState: text('assertion_state').default('ACTIVE').notNull(),
      provenanceSource: text('provenance_source').notNull(),
      provenanceMethod: text('provenance_method').notNull(),
      acceptedByActionInvocationId: uuid('accepted_by_action_invocation_id').notNull(),
      acceptedByPrincipalId: uuid('accepted_by_principal_id').notNull(),
      policyVersion: text('policy_version').notNull(),
      endReason: text('end_reason'),
      endProvenanceSource: text('end_provenance_source'),
      endProvenanceMethod: text('end_provenance_method'),
      endEvidenceReference: text('end_evidence_reference'),
      endedByActionInvocationId: uuid('ended_by_action_invocation_id'),
      endedByPrincipalId: uuid('ended_by_principal_id'),
      endedRecordedAt: timestamp('ended_recorded_at', { withTimezone: true }),
      supersedesRelationshipId: uuid('supersedes_relationship_id'),
      retractsRelationshipId: uuid('retracts_relationship_id'),
    },
    (table) => [
      unique('party_relationships_tenant_id_uk').on(table.tenantId, table.relationshipId),
      foreignKey({
        columns: [table.tenantId, table.fromPartyId],
        foreignColumns: [parties.tenantId, parties.partyId],
        name: 'party_relationships_tenant_from_party_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.tenantId, table.toPartyId],
        foreignColumns: [parties.tenantId, parties.partyId],
        name: 'party_relationships_tenant_to_party_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.tenantId, table.supersedesRelationshipId],
        foreignColumns: [table.tenantId, table.relationshipId],
        name: 'party_relationships_tenant_supersedes_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.tenantId, table.retractsRelationshipId],
        foreignColumns: [table.tenantId, table.relationshipId],
        name: 'party_relationships_tenant_retracts_fk',
      }).onDelete('restrict'),
      index('party_relationships_interval_idx').on(
        table.tenantId,
        table.fromPartyId,
        table.toPartyId,
        table.relationshipType,
        table.validFrom,
        table.validTo,
      ),
      check('party_relationships_type_ck', sql`${table.relationshipType} = 'CONTACT_PERSON_OF'`),
      check('party_relationships_endpoints_ck', sql`${table.fromPartyId} <> ${table.toPartyId}`),
      check(
        'party_relationships_interval_ck',
        sql`${table.validTo} is null or ${table.validFrom} is null or ${table.validTo} > ${table.validFrom}`,
      ),
      check(
        'party_relationships_assertion_state_ck',
        sql`${table.assertionState} in ('ACTIVE', 'SUPERSEDED', 'RETRACTED', 'DISPUTED')`,
      ),
      check('party_relationships_revision_ck', sql`${table.revision} > 0`),
      check(
        'party_relationships_end_reason_ck',
        sql`${table.endReason} is null or (${table.endReason} = btrim(${table.endReason}) and length(${table.endReason}) > 0)`,
      ),
      check(
        'party_relationships_end_provenance_ck',
        sql`(${table.endProvenanceSource} is null and ${table.endProvenanceMethod} is null and ${table.endEvidenceReference} is null and ${table.endedByActionInvocationId} is null and ${table.endedByPrincipalId} is null and ${table.endedRecordedAt} is null and ${table.endReason} is null) or (${table.validTo} is not null and length(btrim(${table.endProvenanceSource})) > 0 and length(btrim(${table.endProvenanceMethod})) > 0 and ${table.endedByActionInvocationId} is not null and ${table.endedByPrincipalId} is not null and ${table.endedRecordedAt} is not null)`,
      ),
      ...tenantRlsPolicies('party_relationships_tenant', table.tenantId),
    ],
  ),
);

export const counterparties = enableGovernedRls(
  partySchema.table(
    'counterparties',
    {
      counterpartyId: uuid('counterparty_id').defaultRandom().primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      partyId: uuid('party_id').notNull(),
      legalEntityId: uuid('legal_entity_id').notNull(),
      creationReason: text('creation_reason').notNull(),
      evidenceRefs: jsonb('evidence_refs').$type<readonly string[]>().notNull(),
      sourceRecordRefs: jsonb('source_record_refs').$type<readonly string[]>().notNull(),
      provenanceSource: text('provenance_source').notNull(),
      provenanceMethod: text('provenance_method').notNull(),
      acceptedByActionInvocationId: uuid('accepted_by_action_invocation_id').notNull(),
      acceptedByPrincipalId: uuid('accepted_by_principal_id').notNull(),
      policyVersion: text('policy_version').notNull(),
      recordedAt: recordedAt(),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
      archivedAt: timestamp('archived_at', { withTimezone: true }),
    },
    (table) => [
      unique('party_counterparties_tenant_id_uk').on(table.tenantId, table.counterpartyId),
      unique('party_counterparties_scope_id_uk').on(
        table.tenantId,
        table.legalEntityId,
        table.counterpartyId,
      ),
      unique('party_counterparties_projection_source_uk').on(
        table.tenantId,
        table.counterpartyId,
        table.legalEntityId,
        table.partyId,
      ),
      unique('party_counterparties_context_uk').on(
        table.tenantId,
        table.partyId,
        table.legalEntityId,
      ),
      foreignKey({
        columns: [table.tenantId, table.partyId],
        foreignColumns: [parties.tenantId, parties.partyId],
        name: 'party_counterparties_tenant_party_fk',
      }).onDelete('restrict'),
      index('party_counterparties_current_idx')
        .on(table.tenantId, table.legalEntityId, table.partyId)
        .where(sql`${table.archivedAt} is null`),
      check(
        'party_counterparties_creation_reason_ck',
        sql`${table.creationReason} = btrim(${table.creationReason}) and length(${table.creationReason}) > 0`,
      ),
      check(
        'party_counterparties_evidence_ck',
        sql`jsonb_typeof(${table.evidenceRefs}) = 'array' and jsonb_array_length(${table.evidenceRefs}) between 1 and 32 and jsonb_typeof(${table.sourceRecordRefs}) = 'array' and jsonb_array_length(${table.sourceRecordRefs}) <= 32`,
      ),
      ...tenantLegalEntityRlsPolicies(
        'party_counterparties_scope',
        table.tenantId,
        table.legalEntityId,
      ),
    ],
  ),
);

export const counterpartyRolePeriods = enableGovernedRls(
  partySchema.table(
    'counterparty_role_periods',
    {
      rolePeriodId: uuid('role_period_id').defaultRandom().primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      legalEntityId: uuid('legal_entity_id').notNull(),
      counterpartyId: uuid('counterparty_id').notNull(),
      roleType: text('role_type').notNull(),
      addReason: text('add_reason').notNull(),
      addEvidenceRefs: jsonb('add_evidence_refs').$type<readonly string[]>().notNull(),
      validFrom: validFrom(),
      validTo: validTo(),
      recordedAt: recordedAt(),
      state: text('state').default('ACTIVE').notNull(),
      isCurrent: boolean('is_current').default(false).notNull(),
      endReason: text('end_reason'),
      endProvenanceSource: text('end_provenance_source'),
      endProvenanceMethod: text('end_provenance_method'),
      endEvidenceRefs: jsonb('end_evidence_refs').$type<readonly string[]>(),
      endedByActionInvocationId: uuid('ended_by_action_invocation_id'),
      endedByPrincipalId: uuid('ended_by_principal_id'),
      endedRecordedAt: timestamp('ended_recorded_at', { withTimezone: true }),
      provenanceSource: text('provenance_source').notNull(),
      provenanceMethod: text('provenance_method').notNull(),
      acceptedByActionInvocationId: uuid('accepted_by_action_invocation_id').notNull(),
      acceptedByPrincipalId: uuid('accepted_by_principal_id').notNull(),
      policyVersion: text('policy_version').notNull(),
    },
    (table) => [
      unique('party_counterparty_role_periods_tenant_id_uk').on(table.tenantId, table.rolePeriodId),
      unique('party_counterparty_role_periods_projection_source_uk').on(
        table.tenantId,
        table.counterpartyId,
        table.rolePeriodId,
      ),
      foreignKey({
        columns: [table.tenantId, table.legalEntityId, table.counterpartyId],
        foreignColumns: [
          counterparties.tenantId,
          counterparties.legalEntityId,
          counterparties.counterpartyId,
        ],
        name: 'party_role_periods_scope_counterparty_fk',
      }).onDelete('restrict'),
      check(
        'party_counterparty_role_periods_type_ck',
        sql`${table.roleType} in ('CUSTOMER', 'SUPPLIER')`,
      ),
      check(
        'party_counterparty_role_periods_interval_ck',
        sql`${table.validTo} is null or ${table.validTo} >= ${table.validFrom}`,
      ),
      check(
        'party_counterparty_role_periods_state_ck',
        sql`${table.state} in ('ACTIVE', 'ENDED', 'SUPERSEDED', 'RETRACTED', 'DISPUTED') and (${table.state} = 'ACTIVE' or not ${table.isCurrent})`,
      ),
      check(
        'party_counterparty_role_periods_add_evidence_ck',
        sql`${table.addReason} = btrim(${table.addReason}) and length(${table.addReason}) > 0 and jsonb_typeof(${table.addEvidenceRefs}) = 'array' and jsonb_array_length(${table.addEvidenceRefs}) between 1 and 32`,
      ),
      check(
        'party_counterparty_role_periods_end_evidence_ck',
        sql`((${table.state} = 'ACTIVE' and ((${table.validTo} is null and ${table.endReason} is null and ${table.endEvidenceRefs} is null and ${table.endedByActionInvocationId} is null and ${table.endedByPrincipalId} is null and ${table.endedRecordedAt} is null) or (${table.validTo} is not null and length(btrim(${table.endReason})) > 0 and jsonb_typeof(${table.endEvidenceRefs}) = 'array' and jsonb_array_length(${table.endEvidenceRefs}) between 1 and 32 and ${table.endedByActionInvocationId} is not null and ${table.endedByPrincipalId} is not null and ${table.endedRecordedAt} is not null))) or (${table.state} = 'ENDED' and ${table.validTo} is not null and length(btrim(${table.endReason})) > 0 and jsonb_typeof(${table.endEvidenceRefs}) = 'array' and jsonb_array_length(${table.endEvidenceRefs}) between 1 and 32 and ${table.endedByActionInvocationId} is not null and ${table.endedByPrincipalId} is not null and ${table.endedRecordedAt} is not null) or (${table.state} in ('SUPERSEDED', 'RETRACTED', 'DISPUTED'))) and ((${table.validTo} is null and ${table.endProvenanceSource} is null and ${table.endProvenanceMethod} is null) or (${table.validTo} is not null and ${table.endProvenanceSource} = btrim(${table.endProvenanceSource}) and length(${table.endProvenanceSource}) > 0 and ${table.endProvenanceMethod} = btrim(${table.endProvenanceMethod}) and length(${table.endProvenanceMethod}) > 0))`,
      ),
      ...tenantLegalEntityRlsPolicies(
        'party_role_periods_scope',
        table.tenantId,
        table.legalEntityId,
      ),
    ],
  ),
);

export const counterpartyAdminReadModels = enableGovernedRls(
  partySchema.table(
    'counterparty_admin_read_models',
    {
      counterpartyId: uuid('counterparty_id').primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      legalEntityId: uuid('legal_entity_id').notNull(),
      storedPartyId: uuid('stored_party_id').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
      archivedAt: timestamp('archived_at', { withTimezone: true }),
    },
    (table) => [
      unique('party_counterparty_admin_models_tenant_id_uk').on(
        table.tenantId,
        table.counterpartyId,
      ),
      foreignKey({
        columns: [table.tenantId, table.counterpartyId, table.legalEntityId, table.storedPartyId],
        foreignColumns: [
          counterparties.tenantId,
          counterparties.counterpartyId,
          counterparties.legalEntityId,
          counterparties.partyId,
        ],
        name: 'party_counterparty_admin_model_source_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.tenantId, table.storedPartyId],
        foreignColumns: [parties.tenantId, parties.partyId],
        name: 'party_counterparty_admin_model_party_fk',
      }).onDelete('restrict'),
      ...tenantRlsPolicies('counterparty_admin_read_models_tenant', table.tenantId),
    ],
  ),
);

export const counterpartyRoleAdminReadModels = enableGovernedRls(
  partySchema.table(
    'counterparty_role_admin_read_models',
    {
      rolePeriodId: uuid('role_period_id').primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      counterpartyId: uuid('counterparty_id').notNull(),
      roleType: text('role_type').notNull(),
      addReason: text('add_reason').notNull(),
      addEvidenceRefs: jsonb('add_evidence_refs').$type<readonly string[]>().notNull(),
      validFrom: validFrom(),
      validTo: validTo(),
      recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
      state: text('state').notNull(),
      endReason: text('end_reason'),
      endProvenanceSource: text('end_provenance_source'),
      endProvenanceMethod: text('end_provenance_method'),
      endEvidenceRefs: jsonb('end_evidence_refs').$type<readonly string[]>(),
      provenanceSource: text('provenance_source').notNull(),
      provenanceMethod: text('provenance_method').notNull(),
    },
    (table) => [
      unique('party_counterparty_role_admin_models_tenant_id_uk').on(
        table.tenantId,
        table.rolePeriodId,
      ),
      foreignKey({
        columns: [table.tenantId, table.counterpartyId, table.rolePeriodId],
        foreignColumns: [
          counterpartyRolePeriods.tenantId,
          counterpartyRolePeriods.counterpartyId,
          counterpartyRolePeriods.rolePeriodId,
        ],
        name: 'party_counterparty_role_admin_model_source_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.tenantId, table.counterpartyId],
        foreignColumns: [
          counterpartyAdminReadModels.tenantId,
          counterpartyAdminReadModels.counterpartyId,
        ],
        name: 'party_counterparty_role_admin_model_counterparty_fk',
      }).onDelete('restrict'),
      index('party_counterparty_role_admin_models_history_idx').on(
        table.tenantId,
        table.counterpartyId,
        table.validFrom,
        table.roleType,
      ),
      check(
        'party_counterparty_role_admin_models_type_ck',
        sql`${table.roleType} in ('CUSTOMER', 'SUPPLIER')`,
      ),
      check(
        'party_counterparty_role_admin_models_state_ck',
        sql`${table.state} in ('ACTIVE', 'ENDED', 'SUPERSEDED', 'RETRACTED', 'DISPUTED')`,
      ),
      check(
        'party_counterparty_role_admin_models_interval_ck',
        sql`${table.validTo} is null or ${table.validTo} >= ${table.validFrom}`,
      ),
      check(
        'party_counterparty_role_admin_models_add_evidence_ck',
        sql`${table.addReason} = btrim(${table.addReason}) and length(${table.addReason}) > 0 and jsonb_typeof(${table.addEvidenceRefs}) = 'array' and jsonb_array_length(${table.addEvidenceRefs}) between 1 and 32`,
      ),
      check(
        'party_counterparty_role_admin_models_end_evidence_ck',
        sql`(${table.validTo} is null and ${table.endReason} is null and ${table.endProvenanceSource} is null and ${table.endProvenanceMethod} is null and ${table.endEvidenceRefs} is null) or (${table.validTo} is not null and length(btrim(${table.endReason})) > 0 and length(btrim(${table.endProvenanceSource})) > 0 and length(btrim(${table.endProvenanceMethod})) > 0 and jsonb_typeof(${table.endEvidenceRefs}) = 'array' and jsonb_array_length(${table.endEvidenceRefs}) between 1 and 32)`,
      ),
      ...tenantRlsPolicies('counterparty_role_admin_read_models_tenant', table.tenantId),
    ],
  ),
);

export const duplicateCandidateCases = enableGovernedRls(
  partySchema.table(
    'duplicate_candidate_cases',
    {
      candidateCaseId: uuid('candidate_case_id').defaultRandom().primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      candidateFingerprint: text('candidate_fingerprint').notNull(),
      evaluationFingerprint: text('evaluation_fingerprint').notNull(),
      priorCandidateCaseId: uuid('prior_candidate_case_id'),
      candidateSnapshot: jsonb('candidate_snapshot').$type<PartyCandidateSnapshot>().notNull(),
      evaluatedEvidence: jsonb('evaluated_evidence')
        .$type<readonly PartyEvidenceExplanation[]>()
        .notNull(),
      matchRuleVersion: text('match_rule_version').notNull(),
      lifecycleState: text('lifecycle_state').default('OPEN').notNull(),
      revision: integer('revision').default(1).notNull(),
      assignedPrincipalId: uuid('assigned_principal_id'),
      resolutionOutcome: text('resolution_outcome'),
      selectedPartyId: uuid('selected_party_id'),
      resolutionActionInvocationId: uuid('resolution_action_invocation_id'),
      resolutionReason: text('resolution_reason'),
      resolvedAt: timestamp('resolved_at', { withTimezone: true }),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
    },
    (table) => [
      unique('party_duplicate_cases_tenant_id_uk').on(table.tenantId, table.candidateCaseId),
      uniqueIndex('party_duplicate_cases_fingerprint_uk')
        .on(table.tenantId, table.evaluationFingerprint, table.matchRuleVersion)
        .where(sql`${table.lifecycleState} in ('OPEN', 'NEEDS_EVIDENCE')`),
      index('party_duplicate_cases_input_history_idx').on(
        table.tenantId,
        table.candidateFingerprint,
        table.createdAt,
      ),
      foreignKey({
        columns: [table.tenantId, table.priorCandidateCaseId],
        foreignColumns: [table.tenantId, table.candidateCaseId],
        name: 'party_duplicate_cases_prior_case_fk',
      }).onDelete('restrict'),
      check(
        'party_duplicate_cases_prior_case_ck',
        sql`${table.priorCandidateCaseId} is null or ${table.priorCandidateCaseId} <> ${table.candidateCaseId}`,
      ),
      check(
        'party_duplicate_cases_evaluation_fingerprint_ck',
        sql`${table.evaluationFingerprint} ~ '^[0-9a-f]{64}$'`,
      ),
      foreignKey({
        columns: [table.tenantId, table.selectedPartyId],
        foreignColumns: [parties.tenantId, parties.partyId],
        name: 'party_duplicate_cases_selected_party_fk',
      }).onDelete('restrict'),
      check(
        'party_duplicate_cases_fingerprint_ck',
        sql`${table.candidateFingerprint} ~ '^[0-9a-f]{64}$'`,
      ),
      check(
        'party_duplicate_cases_snapshot_ck',
        sql`coalesce(jsonb_typeof(${table.candidateSnapshot}), '') = 'object' and coalesce(jsonb_typeof(${table.candidateSnapshot}->'names'), '') = 'array' and jsonb_array_length(${table.candidateSnapshot}->'names') <= 32 and coalesce(jsonb_typeof(${table.candidateSnapshot}->'provenance'), '') = 'object' and coalesce(length(btrim(${table.candidateSnapshot}->'provenance'->>'source')), 0) between 1 and 500 and coalesce(length(btrim(${table.candidateSnapshot}->'provenance'->>'method')), 0) between 1 and 500 and coalesce(${table.candidateSnapshot}->>'validFrom', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{3})?Z$'`,
      ),
      check('party_duplicate_cases_revision_ck', sql`${table.revision} > 0`),
      check(
        'party_duplicate_cases_lifecycle_ck',
        sql`${table.lifecycleState} in ('OPEN', 'NEEDS_EVIDENCE', 'RESOLVED', 'DISMISSED')`,
      ),
      check(
        'party_duplicate_cases_resolution_ck',
        sql`${table.resolutionOutcome} is null or ${table.resolutionOutcome} in ('MATCH_EXISTING', 'CREATE_NEW', 'CORRECT_CLAIM_AND_MATCH', 'NEEDS_EVIDENCE', 'DISMISSED_AS_NON_SUBJECT', 'CONFIRMED_DUPLICATE_PARTIES')`,
      ),
      ...tenantRlsPolicies('party_duplicate_cases_tenant', table.tenantId),
    ],
  ),
);

export const duplicateCandidateCaseParties = enableGovernedRls(
  partySchema.table(
    'duplicate_candidate_case_parties',
    {
      candidateCasePartyId: uuid('candidate_case_party_id').defaultRandom().primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      candidateCaseId: uuid('candidate_case_id').notNull(),
      partyId: uuid('party_id').notNull(),
      rank: integer('rank').notNull(),
      evidenceExplanation: jsonb('evidence_explanation')
        .$type<PartyEvidenceExplanation>()
        .notNull(),
    },
    (table) => [
      unique('party_case_parties_tenant_id_uk').on(table.tenantId, table.candidateCasePartyId),
      unique('party_case_parties_candidate_party_uk').on(
        table.tenantId,
        table.candidateCaseId,
        table.partyId,
      ),
      foreignKey({
        columns: [table.tenantId, table.candidateCaseId],
        foreignColumns: [duplicateCandidateCases.tenantId, duplicateCandidateCases.candidateCaseId],
        name: 'party_case_parties_tenant_case_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.tenantId, table.partyId],
        foreignColumns: [parties.tenantId, parties.partyId],
        name: 'party_duplicate_candidate_case_parties_tenant_party_fk',
      }).onDelete('restrict'),
      check('party_case_parties_rank_ck', sql`${table.rank} > 0`),
      ...tenantRlsPolicies('party_case_parties_tenant', table.tenantId),
    ],
  ),
);

export const partyMatchDecisions = enableGovernedRls(
  partySchema.table(
    'party_match_decisions',
    {
      matchDecisionId: uuid('match_decision_id').defaultRandom().primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      actionInvocationId: uuid('action_invocation_id').notNull(),
      candidateFingerprint: text('candidate_fingerprint').notNull(),
      matchRuleVersion: text('match_rule_version').notNull(),
      operation: text('operation').notNull().default('LEGACY'),
      committedCreateOutcome: text('committed_create_outcome'),
      evidenceEvaluation: jsonb('evidence_evaluation').$type<PartyEvidenceEvaluation>(),
      outcome: text('outcome').notNull(),
      partyId: uuid('party_id'),
      candidateCaseId: uuid('candidate_case_id'),
      evidenceExplanation: jsonb('evidence_explanation')
        .$type<readonly PartyEvidenceExplanation[]>()
        .notNull(),
      decidedAt: timestamp('decided_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
      unique('party_match_decisions_tenant_id_uk').on(table.tenantId, table.matchDecisionId),
      unique('party_match_decisions_action_invocation_uk').on(
        table.tenantId,
        table.actionInvocationId,
      ),
      foreignKey({
        columns: [table.tenantId, table.partyId],
        foreignColumns: [parties.tenantId, parties.partyId],
        name: 'party_match_decisions_tenant_party_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.tenantId, table.candidateCaseId],
        foreignColumns: [duplicateCandidateCases.tenantId, duplicateCandidateCases.candidateCaseId],
        name: 'party_match_decisions_tenant_case_fk',
      }).onDelete('restrict'),
      check(
        'party_match_decisions_fingerprint_ck',
        sql`${table.candidateFingerprint} ~ '^[0-9a-f]{64}$'`,
      ),
      check(
        'party_match_decisions_outcome_ck',
        sql`${table.outcome} in ('CREATED', 'MATCHED', 'NO_MATCH', 'AMBIGUOUS')`,
      ),
      check(
        'party_match_decisions_result_ck',
        sql`(${table.outcome} in ('CREATED', 'MATCHED') and ${table.partyId} is not null and ${table.candidateCaseId} is null) or (${table.outcome} = 'AMBIGUOUS' and ${table.partyId} is null and ${table.candidateCaseId} is not null) or (${table.outcome} = 'NO_MATCH' and ${table.partyId} is null and ${table.candidateCaseId} is null)`,
      ),
      check(
        'party_match_decisions_operation_ck',
        sql`${table.operation} in ('CREATE', 'MATCH', 'REVIEW_MATCH', 'REVIEW_CREATE', 'LIFECYCLE', 'LEGACY')`,
      ),
      check(
        'party_match_decisions_create_result_ck',
        sql`case when ${table.operation} in ('CREATE', 'REVIEW_CREATE') then ${table.committedCreateOutcome} is not null and ${table.outcome} <> 'NO_MATCH' and ${table.committedCreateOutcome} = case when ${table.outcome} = 'MATCHED' then 'MATCHED_EXISTING' else ${table.outcome} end else ${table.committedCreateOutcome} is null end`,
      ),
      ...tenantRlsPolicies('party_match_decisions_tenant', table.tenantId),
    ],
  ),
);

export const partyMerges = enableGovernedRls(
  partySchema.table(
    'party_merges',
    {
      mergeId: uuid('merge_id').defaultRandom().primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      survivorPartyId: uuid('survivor_party_id').notNull(),
      status: text('status').notNull(),
      policyVersion: text('policy_version').notNull(),
      readinessEvidence: jsonb('readiness_evidence').$type<PartyMergeReadinessEvidence>().notNull(),
      createdAt: createdAt(),
    },
    (table) => [
      unique('party_merges_tenant_id_uk').on(table.tenantId, table.mergeId),
      foreignKey({
        columns: [table.tenantId, table.survivorPartyId],
        foreignColumns: [parties.tenantId, parties.partyId],
        name: 'party_merges_tenant_survivor_fk',
      }).onDelete('restrict'),
      check('party_merges_status_ck', sql`${table.status} in ('PREPARED', 'BLOCKED')`),
      check(
        'party_merges_prepared_evidence_ck',
        sql`
        coalesce((jsonb_typeof(${table.readinessEvidence}) = 'object'
        and octet_length(${table.readinessEvidence}::text) <= 65536
        and ${table.readinessEvidence}->'version' = '1'::jsonb
        and coalesce(length(btrim(${table.readinessEvidence}->>'confirmedDuplicateDecisionId')), 0) between 1 and 300
        and coalesce(length(btrim(${table.readinessEvidence}->>'decisionActorPrincipalId')), 0) between 1 and 300
        and coalesce(length(btrim(${table.readinessEvidence}->>'selectionPolicyVersion')), 0) between 1 and 300
        and coalesce(${table.readinessEvidence}->>'selectionReason', '') in ('AUTHORITATIVE_EVIDENCE', 'REFERENCE_STABILITY', 'LIFECYCLE', 'DATA_COMPLETENESS', 'CREATION_AGE', 'STABLE_RESOURCE_IDENTITY')
        and coalesce(jsonb_typeof(${table.readinessEvidence}->'absorbedPartyRefs'), '') = 'array'
        and jsonb_array_length(${table.readinessEvidence}->'absorbedPartyRefs') between 1 and 100
        and coalesce(jsonb_typeof(${table.readinessEvidence}->'selectionEvidenceChain'), '') = 'array'
        and jsonb_array_length(${table.readinessEvidence}->'selectionEvidenceChain') between 3 and 8
        and not jsonb_path_exists(${table.readinessEvidence}->'selectionEvidenceChain', '$[*] ? (!exists(@.candidateSnapshots) || @.candidateSnapshots.type() != "array" || @.candidateSnapshots.size() < 2)')
        and not jsonb_path_exists(${table.readinessEvidence}->'absorbedPartyRefs', '$[*] ? (!exists(@.tenantId) || !exists(@.resourceId) || @.tenantId != $tenant || @.resourceId == $survivor || @.moduleId != "party.registry" || @.resourceType != "party.registry.party")', jsonb_build_object('tenant', ${table.tenantId}::text, 'survivor', ${table.survivorPartyId}::text))
        and ${table.readinessEvidence}->'selectionEvidenceChain'->0->>'criterion' = 'CONFIRMED_DUPLICATE_SET'
        and ${table.readinessEvidence}->'selectionEvidenceChain'->1->>'criterion' = 'IDENTITY_SAFETY'
        and ${table.readinessEvidence}->'selectionEvidenceChain'->-1->>'criterion' = ${table.readinessEvidence}->>'selectionReason'
        and ${table.readinessEvidence}->'selectionEvidenceChain'->-1->'winnerPartyRef'->>'resourceId' = ${table.survivorPartyId}::text
        and ${table.readinessEvidence}->'selectionEvidenceChain'->-1->'winnerPartyRef'->>'tenantId' = ${table.tenantId}::text
        ), false)
      `,
      ),
      ...tenantRlsPolicies('party_merges_tenant', table.tenantId),
    ],
  ),
);

export const partyAliases = enableGovernedRls(
  partySchema.table(
    'party_aliases',
    {
      partyAliasId: uuid('party_alias_id').defaultRandom().primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      aliasPartyId: uuid('alias_party_id').notNull(),
      canonicalPartyId: uuid('canonical_party_id').notNull(),
      mergeId: uuid('merge_id').notNull(),
      createdAt: createdAt(),
    },
    (table) => [
      unique('party_aliases_tenant_id_uk').on(table.tenantId, table.partyAliasId),
      unique('party_aliases_alias_uk').on(table.tenantId, table.aliasPartyId),
      foreignKey({
        columns: [table.tenantId, table.aliasPartyId],
        foreignColumns: [parties.tenantId, parties.partyId],
        name: 'party_aliases_tenant_alias_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.tenantId, table.canonicalPartyId],
        foreignColumns: [parties.tenantId, parties.partyId],
        name: 'party_aliases_tenant_canonical_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.tenantId, table.mergeId],
        foreignColumns: [partyMerges.tenantId, partyMerges.mergeId],
        name: 'party_aliases_tenant_merge_fk',
      }).onDelete('restrict'),
      check('party_aliases_not_self_ck', sql`${table.aliasPartyId} <> ${table.canonicalPartyId}`),
      ...tenantRlsPolicies('party_aliases_tenant', table.tenantId),
    ],
  ),
);

export const partyCorrections = enableGovernedRls(
  partySchema.table(
    'party_corrections',
    {
      correctionId: uuid('correction_id').defaultRandom().primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      partyId: uuid('party_id').notNull(),
      partyFactAssertionId: uuid('party_fact_assertion_id'),
      officialIdentifierId: uuid('official_identifier_id'),
      contactPointId: uuid('contact_point_id'),
      relationshipId: uuid('relationship_id'),
      replacementPartyFactAssertionId: uuid('replacement_party_fact_assertion_id'),
      replacementOfficialIdentifierId: uuid('replacement_official_identifier_id'),
      replacementContactPointId: uuid('replacement_contact_point_id'),
      replacementRelationshipId: uuid('replacement_relationship_id'),
      reason: text('reason').notNull(),
      evidenceRefs: jsonb('evidence_refs').$type<readonly string[]>().notNull(),
      actingPrincipalId: uuid('acting_principal_id').notNull(),
      approvingPrincipalId: uuid('approving_principal_id'),
      actionInvocationId: uuid('action_invocation_id').notNull(),
      policyVersion: text('policy_version').notNull(),
      recordedAt: recordedAt(),
    },
    (table) => [
      unique('party_corrections_tenant_id_uk').on(table.tenantId, table.correctionId),
      unique('party_corrections_action_invocation_uk').on(table.tenantId, table.actionInvocationId),
      foreignKey({
        columns: [table.tenantId, table.partyId],
        foreignColumns: [parties.tenantId, parties.partyId],
        name: 'party_corrections_tenant_party_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.tenantId, table.partyFactAssertionId],
        foreignColumns: [partyFactAssertions.tenantId, partyFactAssertions.assertionId],
        name: 'party_corrections_tenant_fact_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.tenantId, table.officialIdentifierId],
        foreignColumns: [
          partyOfficialIdentifiers.tenantId,
          partyOfficialIdentifiers.officialIdentifierId,
        ],
        name: 'party_corrections_tenant_identifier_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.tenantId, table.contactPointId],
        foreignColumns: [partyContactPoints.tenantId, partyContactPoints.contactPointId],
        name: 'party_corrections_tenant_contact_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.tenantId, table.relationshipId],
        foreignColumns: [partyRelationships.tenantId, partyRelationships.relationshipId],
        name: 'party_corrections_tenant_relationship_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.tenantId, table.replacementPartyFactAssertionId],
        foreignColumns: [partyFactAssertions.tenantId, partyFactAssertions.assertionId],
        name: 'party_corrections_tenant_replacement_fact_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.tenantId, table.replacementOfficialIdentifierId],
        foreignColumns: [
          partyOfficialIdentifiers.tenantId,
          partyOfficialIdentifiers.officialIdentifierId,
        ],
        name: 'party_corrections_tenant_replacement_id_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.tenantId, table.replacementContactPointId],
        foreignColumns: [partyContactPoints.tenantId, partyContactPoints.contactPointId],
        name: 'party_corrections_tenant_replacement_contact_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.tenantId, table.replacementRelationshipId],
        foreignColumns: [partyRelationships.tenantId, partyRelationships.relationshipId],
        name: 'party_corrections_tenant_replacement_rel_fk',
      }).onDelete('restrict'),
      check(
        'party_corrections_target_ck',
        sql`num_nonnulls(${table.partyFactAssertionId}, ${table.officialIdentifierId}, ${table.contactPointId}, ${table.relationshipId}) = 1`,
      ),
      check(
        'party_corrections_replacement_ck',
        sql`num_nonnulls(${table.replacementPartyFactAssertionId}, ${table.replacementOfficialIdentifierId}, ${table.replacementContactPointId}, ${table.replacementRelationshipId}) <= 1`,
      ),
      check(
        'party_corrections_reason_ck',
        sql`${table.reason} = btrim(${table.reason}) and length(${table.reason}) > 0`,
      ),
      ...tenantRlsPolicies('party_corrections_tenant', table.tenantId),
    ],
  ),
);

export const partyDatabaseSchema = {
  counterparties,
  counterpartyAdminReadModels,
  counterpartyRoleAdminReadModels,
  counterpartyRolePeriods,
  duplicateCandidateCaseParties,
  duplicateCandidateCases,
  parties,
  partyAliases,
  partyContactPointPurposes,
  partyContactPoints,
  partyCorrections,
  partyFactAssertions,
  partyIdentifierClaims,
  partyMatchDecisions,
  partyMerges,
  partyOfficialIdentifiers,
  partyRelationships,
} as const;

export const PARTY_TABLES = [
  counterparties,
  counterpartyAdminReadModels,
  counterpartyRoleAdminReadModels,
  counterpartyRolePeriods,
  duplicateCandidateCaseParties,
  duplicateCandidateCases,
  parties,
  partyAliases,
  partyContactPointPurposes,
  partyContactPoints,
  partyCorrections,
  partyFactAssertions,
  partyIdentifierClaims,
  partyMatchDecisions,
  partyMerges,
  partyOfficialIdentifiers,
  partyRelationships,
] as const;

export type PartyRecord = typeof parties.$inferSelect;
export type NewPartyRecord = typeof parties.$inferInsert;
export type PartyFactAssertionRecord = typeof partyFactAssertions.$inferSelect;
export type NewPartyFactAssertionRecord = typeof partyFactAssertions.$inferInsert;
export type PartyOfficialIdentifierRecord = typeof partyOfficialIdentifiers.$inferSelect;
export type NewPartyOfficialIdentifierRecord = typeof partyOfficialIdentifiers.$inferInsert;
export type PartyContactPointRecord = typeof partyContactPoints.$inferSelect;
export type NewPartyContactPointRecord = typeof partyContactPoints.$inferInsert;
export type PartyRelationshipRecord = typeof partyRelationships.$inferSelect;
export type NewPartyRelationshipRecord = typeof partyRelationships.$inferInsert;
export type CounterpartyRecord = typeof counterparties.$inferSelect;
export type NewCounterpartyRecord = typeof counterparties.$inferInsert;
