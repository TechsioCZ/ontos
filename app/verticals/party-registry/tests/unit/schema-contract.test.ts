// @effect-diagnostics nodeBuiltinImport:off -- Filesystem migration contract verifies actual checked-in SQL files; expires: 2026-12-31.
import { expect, it } from '@app/effect-rstest';
import { Effect } from 'effect';

import { readdir, readFile } from 'node:fs/promises';

import { getTableName, isTable } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import * as schemaExports from '../../src/db/schema.ts';
import {
  PARTY_SCHEMA_NAME,
  PARTY_TABLE_INVENTORY,
  counterpartyAdminReadModels,
  counterpartyRoleAdminReadModels,
  counterparties,
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
} from '../../src/db/schema.ts';

const dialect = new PgDialect();
const configuredTables = [
  counterpartyAdminReadModels,
  counterpartyRoleAdminReadModels,
  counterparties,
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

const configOf = (table: (typeof configuredTables)[number]) => getTableConfig(table);

const uniqueColumns = (table: (typeof configuredTables)[number], name: string) => {
  const config = configOf(table);
  const constraint = config.uniqueConstraints.find((candidate) => candidate.name === name);
  const tableIndex = config.indexes.find((candidate) => candidate.config.name === name);
  expect(constraint ?? tableIndex, `Expected unique key ${name}`).toBeTruthy();
  const columns = constraint?.columns ?? tableIndex?.config.columns ?? [];
  return columns.map((column) => ('name' in column ? column.name : false));
};

const foreignKey = (table: (typeof configuredTables)[number], name: string) => {
  const result = configOf(table).foreignKeys.find((candidate) => candidate.getName() === name);
  expect(result, `Expected foreign key ${name}`).toBeTruthy();
  if (result === undefined) {
    throw new Error(`Expected foreign key ${name}`);
  }
  return result;
};

it('owns the complete Party Registry operational catalog in the party schema', () => {
  const exportedTables = Object.values(schemaExports).flatMap((value) =>
    isTable(value) ? [value] : [],
  );
  const qualifiedNames = exportedTables
    .map((table) => {
      const config = getTableConfig(table);
      return `${config.schema}.${config.name}`;
    })
    .toSorted();

  expect(PARTY_SCHEMA_NAME).toBe('party');
  expect(PARTY_TABLE_INVENTORY).toEqual([
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
  ]);
  expect(qualifiedNames).toEqual(PARTY_TABLE_INVENTORY.map((name) => `party.${name}`));
});

it('keeps tenant-admin Counterparty reads on an atomic owner-local projection', () => {
  const snapshotConfig = configOf(counterpartyAdminReadModels);
  const roleConfig = configOf(counterpartyRoleAdminReadModels);
  for (const column of [
    'tenant_id',
    'counterparty_id',
    'legal_entity_id',
    'stored_party_id',
    'created_at',
    'archived_at',
  ]) {
    expect(
      snapshotConfig.columns.some((candidate) => candidate.name === column),
      column,
    ).toBeTruthy();
  }
  for (const column of [
    'tenant_id',
    'counterparty_id',
    'role_period_id',
    'role_type',
    'add_reason',
    'add_evidence_refs',
    'valid_from',
    'valid_to',
    'recorded_at',
    'state',
    'end_reason',
    'end_provenance_source',
    'end_provenance_method',
    'end_evidence_refs',
    'provenance_source',
    'provenance_method',
  ]) {
    expect(
      roleConfig.columns.some((candidate) => candidate.name === column),
      column,
    ).toBeTruthy();
  }
  expect(
    getTableName(
      foreignKey(
        counterpartyAdminReadModels,
        'party_counterparty_admin_model_source_fk',
      ).reference().foreignTable,
    ),
  ).toBe(getTableName(counterparties));
  expect(
    getTableName(
      foreignKey(
        counterpartyRoleAdminReadModels,
        'party_counterparty_role_admin_model_source_fk',
      ).reference().foreignTable,
    ),
  ).toBe(getTableName(counterpartyRolePeriods));
  expect(
    roleConfig.indexes.some(
      (candidate) => candidate.config.name === 'party_counterparty_role_admin_models_history_idx',
    ),
  ).toBeTruthy();
  for (const config of [snapshotConfig, roleConfig]) {
    expect(config.policies.map((policy) => policy.name)).toEqual([
      `${config.name}_tenant_select`,
      `${config.name}_tenant_insert`,
      `${config.name}_tenant_update`,
      `${config.name}_tenant_delete`,
    ]);
  }
});

it('gives every tenant-owned record a tenant-qualified identity and forced-RLS policy shape', () => {
  for (const table of configuredTables) {
    const config = configOf(table);
    expect(config.enableRLS, `${config.name} must enable RLS`).toBe(true);
    expect(
      config.columns.some((column) => column.name === 'tenant_id' && column.notNull),
      `${config.name} needs a required tenant_id`,
    ).toBeTruthy();
    expect(
      config.policies.map((policy) => policy.for),
      `${config.name} needs complete CRUD policies`,
    ).toEqual(['select', 'insert', 'update', 'delete']);
    for (const policy of config.policies) {
      expect(policy.to).toBe('ontos_runtime');
    }
    const tenantIdentity = [...config.uniqueConstraints, ...config.indexes].find((candidate) => {
      const columns = 'columns' in candidate ? candidate.columns : (candidate.config.columns ?? []);
      return columns.some((column) => 'name' in column && column.name === 'tenant_id');
    });
    expect(tenantIdentity, `${config.name} needs a tenant-qualified unique key`).toBeTruthy();
    if (tenantIdentity === undefined) {
      throw new Error(`${config.name} needs a tenant-qualified unique key`);
    }
  }
});

it('models Party identity and assertion history without conflating effective and recorded time', () => {
  const partyConfig = configOf(parties);
  expect(
    partyConfig.columns.some((column) => column.name === 'current_display_name' && !column.notNull),
  ).toBeTruthy();
  expect(uniqueColumns(parties, 'party_parties_tenant_id_uk')).toEqual(['tenant_id', 'party_id']);
  expect(partyConfig.checks.map((candidate) => candidate.name).toSorted()).toEqual([
    'party_parties_display_name_ck',
    'party_parties_revision_ck',
    'party_parties_type_ck',
  ]);
  const assertionConfig = configOf(partyFactAssertions);
  for (const column of [
    'valid_from',
    'valid_to',
    'recorded_at',
    'state',
    'provenance_source',
    'provenance_method',
    'verification_state',
    'accepted_by_action_invocation_id',
    'accepted_by_principal_id',
    'policy_version',
    'supersedes_assertion_id',
    'retracts_assertion_id',
  ]) {
    expect(
      assertionConfig.columns.some((candidate) => candidate.name === column),
      column,
    ).toBeTruthy();
  }
  expect(
    getTableName(
      foreignKey(partyFactAssertions, 'party_fact_assertions_tenant_party_fk').reference()
        .foreignTable,
    ),
  ).toBe(getTableName(parties));
});

it('keeps official assertions historical while exclusive claims own exact matching uniqueness', () => {
  expect(uniqueColumns(partyIdentifierClaims, 'party_identifier_claims_exact_claim_uk')).toEqual([
    'tenant_id',
    'identifier_type_key',
    'namespace',
    'normalized_value',
  ]);
  expect(
    configOf(partyOfficialIdentifiers)
      .checks.map((candidate) => candidate.name)
      .toSorted(),
  ).toEqual([
    'party_official_identifiers_external_evidence_ck',
    'party_official_identifiers_interval_ck',
    'party_official_identifiers_normalized_value_ck',
    'party_official_identifiers_state_ck',
    'party_official_identifiers_type_ck',
    'party_official_identifiers_verification_ck',
  ]);
  const claims = configOf(partyIdentifierClaims);
  expect(
    claims.indexes.some(
      (candidate) => candidate.config.name === 'party_identifier_claims_party_lookup_idx',
    ),
  ).toBeTruthy();
});

it('preserves bounded external observation evidence separately from trusted actor and effective time', () => {
  for (const table of [
    partyFactAssertions,
    partyOfficialIdentifiers,
    partyContactPoints,
    partyContactPointPurposes,
  ]) {
    const config = configOf(table);
    expect(
      config.columns.some((column) => column.name === 'external_evidence' && !column.notNull),
    ).toBeTruthy();
    const evidenceCheck = config.checks.find(
      (candidate) => candidate.name === `${config.name}_external_evidence_ck`,
    );
    expect(evidenceCheck).toBeTruthy();
    if (evidenceCheck === undefined) {
      throw new Error('Expected value to be present');
    }
    const evidenceSql = dialect.sqlToQuery(evidenceCheck.value).sql;
    expect(evidenceSql).toMatch(/observedAt/u);
    expect(evidenceSql).toMatch(/decidedAt/u);
    expect(evidenceSql).toMatch(/authorityPolicyKey/u);
    expect(evidenceSql).toMatch(/party_registry\.ares_enrichment/u);
    expect(evidenceSql).toMatch(/4096/u);
    expect(evidenceSql).not.toMatch(/validFrom|principalId|rawPayload/u);
  }
});

// eslint-disable-next-line complexity -- One schema-boundary matrix keeps all related family invariants visible.
it('models typed contact, relationship, and Counterparty lifecycles with owner-local references', () => {
  const contactChecks = Object.fromEntries(
    configOf(partyContactPoints).checks.map((candidate) => [
      candidate.name,
      dialect.sqlToQuery(candidate.value).sql,
    ]),
  );
  expect(contactChecks['party_contact_points_shape_ck'] ?? '').toMatch(/EMAIL/u);
  expect(contactChecks['party_contact_points_shape_ck'] ?? '').toMatch(/PHONE/u);
  expect(contactChecks['party_contact_points_shape_ck'] ?? '').toMatch(/ADDRESS/u);
  for (const column of [
    'display_value',
    'normalization_version',
    'phone_country_code',
    'phone_extension',
    'provenance_authoritative',
    'evidence_reference',
    'additional_evidence_refs',
    'verification_method',
    'verifier_reference',
    'end_reason',
    'end_provenance_source',
    'end_provenance_method',
    'end_evidence_refs',
    'ended_by_action_invocation_id',
    'ended_by_principal_id',
    'ended_recorded_at',
    'revision',
  ]) {
    expect(
      configOf(partyContactPoints).columns.some((candidate) => candidate.name === column),
      column,
    ).toBeTruthy();
  }
  expect(contactChecks['party_contact_points_revision_ck'] ?? '').toMatch(/> 0/u);
  expect(contactChecks['party_contact_points_additional_evidence_ck'] ?? '').toMatch(
    /additional_evidence_refs.*array.*additional_evidence_refs.*32/u,
  );
  expect(contactChecks['party_contact_points_end_evidence_ck'] ?? '').toMatch(
    /valid_to.*end_reason.*end_provenance_source.*end_provenance_method.*end_evidence_refs.*ended_by_action_invocation_id.*ended_by_principal_id.*ended_recorded_at/u,
  );
  expect(contactChecks['party_contact_points_shape_ck'] ?? '').toMatch(/num_nonnulls/u);
  expect(contactChecks['party_contact_points_shape_ck'] ?? '').toMatch(/\^\\\+/u);
  const preferredIndex = configOf(partyContactPoints).indexes.find(
    (candidate) => candidate.config.name === 'party_contact_points_current_preferred_uk',
  );
  expect(preferredIndex?.config.unique).toBe(true);
  expect(preferredIndex?.config.where).toBeTruthy();
  const purposeConfig = configOf(partyContactPointPurposes);
  const purposeChecks = Object.fromEntries(
    purposeConfig.checks.map((candidate) => [
      candidate.name,
      dialect.sqlToQuery(candidate.value).sql,
    ]),
  );
  expect(purposeChecks['party_contact_point_purposes_key_ck'] ?? '').toMatch(/REGISTERED/u);
  expect(purposeChecks['party_contact_point_purposes_key_ck'] ?? '').toMatch(/BILLING/u);
  expect(purposeChecks['party_contact_point_purposes_key_ck'] ?? '').toMatch(/DELIVERY/u);
  expect(purposeChecks['party_contact_point_purposes_key_ck'] ?? '').toMatch(/CORRESPONDENCE/u);
  for (const column of [
    'registry_context',
    'jurisdiction',
    'provenance_authoritative',
    'evidence_reference',
    'verification_state',
    'verification_method',
    'verifier_reference',
    'end_reason',
    'end_provenance_source',
    'end_provenance_method',
    'end_evidence_refs',
    'ended_by_action_invocation_id',
    'ended_by_principal_id',
    'ended_recorded_at',
    'revision',
  ]) {
    expect(
      purposeConfig.columns.some((candidate) => candidate.name === column),
      column,
    ).toBeTruthy();
  }
  expect(purposeChecks['party_contact_point_purposes_end_evidence_ck'] ?? '').toMatch(
    /valid_to.*end_reason.*end_provenance_source.*end_provenance_method.*end_evidence_refs.*ended_by_action_invocation_id.*ended_by_principal_id.*ended_recorded_at/u,
  );
  expect(
    getTableName(
      foreignKey(partyContactPointPurposes, 'party_contact_point_purposes_contact_fk').reference()
        .foreignTable,
    ),
  ).toBe(getTableName(partyContactPoints));
  const preferredPurpose = purposeConfig.indexes.find(
    (candidate) => candidate.config.name === 'party_contact_point_purposes_current_preferred_uk',
  );
  expect(preferredPurpose?.config.unique).toBe(true);
  expect(preferredPurpose?.config.where).toBeTruthy();
  expect(
    purposeConfig.indexes.find(
      (candidate) => candidate.config.name === 'party_contact_point_purposes_current_registered_uk',
    )?.config.where,
  ).toBeTruthy();

  const relationshipChecks = Object.fromEntries(
    configOf(partyRelationships).checks.map((candidate) => [
      candidate.name,
      dialect.sqlToQuery(candidate.value).sql,
    ]),
  );
  expect(relationshipChecks['party_relationships_type_ck'] ?? '').toMatch(/CONTACT_PERSON_OF/u);
  expect(relationshipChecks['party_relationships_type_ck'] ?? '').not.toMatch(
    /EMPLOYEE_OF|BRANCH_OF|OTHER/u,
  );
  expect(
    configOf(partyRelationships).columns.some(
      (column) => column.name === 'revision' && column.notNull && column.hasDefault,
    ),
  ).toBeTruthy();
  expect(
    configOf(partyRelationships).columns.some(
      (column) => column.name === 'valid_from' && !column.notNull,
    ),
  ).toBeTruthy();
  expect(
    configOf(partyRelationships).columns.some(
      (column) => column.name === 'assertion_state' && column.notNull && column.hasDefault,
    ),
  ).toBeTruthy();
  expect(configOf(partyRelationships).columns.some((column) => column.name === 'is_current')).toBe(
    false,
  );
  expect(configOf(partyRelationships).columns.some((column) => column.name === 'state')).toBe(
    false,
  );
  expect(relationshipChecks['party_relationships_interval_ck'] ?? '').toMatch(
    /valid_to.*is null.*valid_from.*is null.*valid_to.*>.*valid_from/u,
  );
  expect(relationshipChecks['party_relationships_assertion_state_ck'] ?? '').toMatch(
    /ACTIVE.*SUPERSEDED.*RETRACTED.*DISPUTED/u,
  );
  expect(relationshipChecks['party_relationships_assertion_state_ck'] ?? '').not.toMatch(/ENDED/u);
  const relationshipIntervalIndex = configOf(partyRelationships).indexes.find(
    (candidate) => candidate.config.name === 'party_relationships_interval_idx',
  );
  expect(relationshipIntervalIndex?.config.unique).toBe(false);
  expect(relationshipIntervalIndex?.config.where).toBe(undefined);
  expect(relationshipChecks['party_relationships_revision_ck'] ?? '').toMatch(/> 0/u);
  for (const column of [
    'end_reason',
    'end_provenance_source',
    'end_provenance_method',
    'end_evidence_reference',
    'ended_by_action_invocation_id',
    'ended_by_principal_id',
    'ended_recorded_at',
  ]) {
    expect(
      configOf(partyRelationships).columns.some((candidate) => candidate.name === column),
      column,
    ).toBeTruthy();
  }
  expect(
    getTableName(
      foreignKey(partyRelationships, 'party_relationships_tenant_from_party_fk').reference()
        .foreignTable,
    ),
  ).toBe(getTableName(parties));

  expect(uniqueColumns(counterparties, 'party_counterparties_context_uk')).toEqual([
    'tenant_id',
    'party_id',
    'legal_entity_id',
  ]);
  for (const column of ['creation_reason', 'evidence_refs', 'source_record_refs', 'recorded_at']) {
    expect(
      configOf(counterparties).columns.some((candidate) => candidate.name === column),
      column,
    ).toBeTruthy();
  }
  const roleChecks = Object.fromEntries(
    configOf(counterpartyRolePeriods).checks.map((candidate) => [
      candidate.name,
      dialect.sqlToQuery(candidate.value).sql,
    ]),
  );
  expect(roleChecks['party_counterparty_role_periods_type_ck'] ?? '').toMatch(/CUSTOMER/u);
  expect(roleChecks['party_counterparty_role_periods_type_ck'] ?? '').toMatch(/SUPPLIER/u);
  expect(roleChecks['party_counterparty_role_periods_type_ck'] ?? '').not.toMatch(
    /BUSINESS_PARTNER/u,
  );
  for (const column of [
    'add_reason',
    'add_evidence_refs',
    'end_reason',
    'end_provenance_source',
    'end_provenance_method',
    'end_evidence_refs',
    'ended_by_action_invocation_id',
    'ended_by_principal_id',
    'ended_recorded_at',
  ]) {
    expect(
      configOf(counterpartyRolePeriods).columns.some((candidate) => candidate.name === column),
      column,
    ).toBeTruthy();
  }
  const roleEndEvidence = roleChecks['party_counterparty_role_periods_end_evidence_ck'] ?? '';
  expect(roleEndEvidence).toMatch(
    /valid_to[^)]*is null[^)]*end_provenance_source[^)]*is null[^)]*end_provenance_method[^)]*is null/u,
  );
  expect(roleEndEvidence).toMatch(
    /valid_to.*is not null.*end_provenance_source.*btrim.*end_provenance_method.*btrim/u,
  );
  expect(
    configOf(counterpartyRolePeriods).indexes.some(
      (candidate) => candidate.config.name === 'party_counterparty_role_periods_current_uk',
    ),
    'effective intervals, not an is_current unique index, own role-period uniqueness',
  ).toBe(false);
  expect(roleChecks['party_counterparty_role_periods_state_ck'] ?? '').not.toMatch(
    /ACTIVE' and [^)]*is_current/u,
  );
});

it('persists one recoverable match decision per Action and bounded duplicate review state', () => {
  expect(uniqueColumns(partyMatchDecisions, 'party_match_decisions_action_invocation_uk')).toEqual([
    'tenant_id',
    'action_invocation_id',
  ]);
  const decisionChecks = Object.fromEntries(
    configOf(partyMatchDecisions).checks.map((candidate) => [
      candidate.name,
      dialect.sqlToQuery(candidate.value).sql,
    ]),
  );
  expect(decisionChecks['party_match_decisions_outcome_ck'] ?? '').toMatch(/CREATED/u);
  expect(decisionChecks['party_match_decisions_outcome_ck'] ?? '').toMatch(/MATCHED/u);
  expect(decisionChecks['party_match_decisions_outcome_ck'] ?? '').toMatch(/AMBIGUOUS/u);
  expect(decisionChecks['party_match_decisions_outcome_ck'] ?? '').toMatch(/NO_MATCH/u);
  expect(
    configOf(duplicateCandidateCases).columns.some((column) => column.name === 'revision'),
  ).toBeTruthy();
  const activeCaseIndex = configOf(duplicateCandidateCases).indexes.find(
    (candidate) => candidate.config.name === 'party_duplicate_cases_fingerprint_uk',
  );
  expect(activeCaseIndex?.config.unique).toBe(true);
  expect(uniqueColumns(duplicateCandidateCases, 'party_duplicate_cases_fingerprint_uk')).toEqual([
    'tenant_id',
    'evaluation_fingerprint',
    'match_rule_version',
  ]);
  expect(
    getTableName(
      foreignKey(duplicateCandidateCases, 'party_duplicate_cases_prior_case_fk').reference()
        .foreignTable,
    ),
  ).toBe('duplicate_candidate_cases');
  expect(activeCaseIndex?.config.where).toBeTruthy();
  if (activeCaseIndex?.config.where === undefined) {
    throw new Error('Expected active case predicate');
  }
  expect(dialect.sqlToQuery(activeCaseIndex.config.where).sql).toMatch(/OPEN.*NEEDS_EVIDENCE/u);
  const snapshotCheck = configOf(duplicateCandidateCases).checks.find(
    (candidate) => candidate.name === 'party_duplicate_cases_snapshot_ck',
  );
  expect(snapshotCheck).toBeTruthy();
  if (snapshotCheck === undefined) {
    throw new Error('Expected value to be present');
  }
  expect(dialect.sqlToQuery(snapshotCheck.value).sql).toMatch(
    /provenance.*source.*method.*validFrom/u,
  );
  expect(
    getTableName(
      foreignKey(
        duplicateCandidateCaseParties,
        'party_duplicate_candidate_case_parties_tenant_party_fk',
      ).reference().foreignTable,
    ),
  ).toBe(getTableName(parties));
});

it('prepares append-only correction and non-executable merge records with safe aliases', () => {
  const correctionConfig = configOf(partyCorrections);
  expect(correctionConfig.columns.some((column) => column.name === 'reason')).toBeTruthy();
  expect(correctionConfig.columns.some((column) => column.name === 'evidence_refs')).toBeTruthy();
  expect(
    correctionConfig.columns.some((column) => column.name === 'acting_principal_id'),
  ).toBeTruthy();
  expect(
    correctionConfig.columns.some((column) => column.name === 'approving_principal_id'),
  ).toBeTruthy();
  expect(correctionConfig.columns.some((column) => column.name === 'policy_version')).toBeTruthy();
  expect(
    correctionConfig.checks.some((candidate) => candidate.name === 'party_corrections_target_ck'),
  ).toBeTruthy();

  const mergeStatus = configOf(partyMerges).checks.find(
    (candidate) => candidate.name === 'party_merges_status_ck',
  );
  expect(mergeStatus).toBeTruthy();
  if (mergeStatus === undefined) {
    throw new Error('Expected value to be present');
  }
  const mergeStatusSql = dialect.sqlToQuery(mergeStatus.value).sql;
  expect(mergeStatusSql).toMatch(/PREPARED/u);
  expect(mergeStatusSql).toMatch(/BLOCKED/u);
  expect(mergeStatusSql).not.toMatch(/APPLIED|COMPLETED|EXECUTED/u);
  const preparedEvidence = configOf(partyMerges).checks.find(
    (candidate) => candidate.name === 'party_merges_prepared_evidence_ck',
  );
  expect(preparedEvidence).toBeTruthy();
  if (preparedEvidence === undefined) {
    throw new Error('Expected value to be present');
  }
  for (const field of [
    'version',
    'confirmedDuplicateDecisionId',
    'decisionActorPrincipalId',
    'absorbedPartyRefs',
    'selectionPolicyVersion',
    'selectionReason',
    'selectionEvidenceChain',
  ]) {
    expect(dialect.sqlToQuery(preparedEvidence.value).sql.includes(field), field).toBeTruthy();
  }
  expect(uniqueColumns(partyAliases, 'party_aliases_alias_uk')).toEqual([
    'tenant_id',
    'alias_party_id',
  ]);
  expect(
    configOf(partyAliases).checks.some(
      (candidate) => candidate.name === 'party_aliases_not_self_ck',
    ),
  ).toBeTruthy();
});

it.effect(
  'ships an independent Party migration with forced RLS and append-only correction evidence',
  () =>
    Effect.gen(function* testScenario() {
      const drizzleConfig = yield* Effect.promise(() =>
        readFile(new URL('../../drizzle.config.ts', import.meta.url), 'utf-8'),
      );
      expect(drizzleConfig).toMatch(/__drizzle_migrations_party/u);
      expect(drizzleConfig).toMatch(/\.\/src\/db\/schema\.ts/u);

      const migrationDirectory = new URL('../../drizzle/', import.meta.url);
      const migrationDirectoryEntries = yield* Effect.promise(() =>
        readdir(migrationDirectory, { withFileTypes: true }),
      );
      const migrationFolders = migrationDirectoryEntries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .toSorted();
      expect(migrationFolders.length >= 2).toBeTruthy();
      const remediationFolder = migrationFolders.find((name) => name.endsWith('_nebulous_cardiac'));
      expect(remediationFolder).toBeTruthy();
      if (remediationFolder === undefined) {
        throw new Error('Expected value to be present');
      }
      const remediation = yield* Effect.promise(() =>
        readFile(new URL(`${remediationFolder}/migration.sql`, migrationDirectory), 'utf-8'),
      );
      expect(remediation).toMatch(/party_match_decisions_create_result_ck/u);
      expect(remediation).toMatch(/committed_create_outcome/u);
      const migration = yield* Effect.promise(() =>
        readFile(
          new URL(`${migrationFolders[0] ?? ''}/migration.sql`, migrationDirectory),
          'utf-8',
        ),
      );
      expect(
        migration.match(/ALTER TABLE "party"\."[^"]+" ENABLE ROW LEVEL SECURITY;/gu)?.length,
      ).toBe(PARTY_TABLE_INVENTORY.length);
      expect(
        migration.match(/ALTER TABLE "party"\."[^"]+" FORCE ROW LEVEL SECURITY;/gu)?.length,
      ).toBe(PARTY_TABLE_INVENTORY.length);
      expect(migration).not.toMatch(/REFERENCES "(?:core|auth|contacts)"\./u);
      expect(migration).toMatch(/party_reject_correction_mutation/u);
      expect(migration).toMatch(/before update or delete on "party"\."party_corrections"/iu);
      expect(migration).toMatch(/CREATE EXTENSION IF NOT EXISTS btree_gist/iu);
      expect(migration).toMatch(
        /party_relationships_no_overlap_excl[\s\S]*EXCLUDE USING gist[\s\S]*tstzrange[\s\S]*-infinity[\s\S]*assertion_state[\s\S]*ACTIVE/iu,
      );
      expect(migration).toMatch(
        /party_counterparty_role_periods_no_overlap_excl[\s\S]*EXCLUDE USING gist[\s\S]*tstzrange/iu,
      );
    }),
);

it.effect('registers Party ownership in application database grants and exact verification', () =>
  Effect.gen(function* testScenario() {
    const bootstrap = yield* Effect.promise(() =>
      readFile(
        new URL('../../../../scripts/postgres/bootstrap-runtime-role.mts', import.meta.url),
        'utf-8',
      ),
    );
    const verifier = yield* Effect.promise(() =>
      readFile(
        new URL('../../../../scripts/verify-application-db-schema.mts', import.meta.url),
        'utf-8',
      ),
    );
    expect(bootstrap).toMatch(/\['core', 'auth', 'contacts', 'party'\]/u);
    expect(verifier).toMatch(/\['auth', 'contacts', 'core', 'party'\]/u);
    expect(verifier).toMatch(/__drizzle_migrations_party/u);
    expect(verifier).toMatch(/verticals\/party-registry\/scripts\/verify-db-schema\.mts/u);
  }),
);
