import { readdir, readFile } from 'node:fs/promises';

import { getTableName, isTable } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { Effect } from 'effect';
// @effect-diagnostics nodeBuiltinImport:off -- Filesystem migration contract verifies actual checked-in SQL files; expires: 2026-12-31.
import { assert, expect, it } from 'effect-rstest';

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

const configOf = (table: (typeof configuredTables)[number]) =>
  getTableConfig(table);

const uniqueColumns = (
  table: (typeof configuredTables)[number],
  name: string
) => {
  const config = configOf(table);
  const constraint = config.uniqueConstraints.find(
    (candidate) => candidate.name === name
  );
  const tableIndex = config.indexes.find(
    (candidate) => candidate.config.name === name
  );
  expect(constraint ?? tableIndex, `Expected unique key ${name}`).toBeTruthy();
  const columns = constraint?.columns ?? tableIndex?.config.columns ?? [];
  return columns.map((column) => ('name' in column ? column.name : false));
};

const foreignKey = (table: (typeof configuredTables)[number], name: string) => {
  const result = configOf(table).foreignKeys.find(
    (candidate) => candidate.getName() === name
  );
  expect(result, `Expected foreign key ${name}`).toBeTruthy();
  if (result === undefined) {
    throw new Error(`Expected foreign key ${name}`);
  }
  return result;
};

it('owns the complete Party Registry operational catalog in the party schema', () => {
  const exportedTables = Object.values(schemaExports).flatMap((value) =>
    isTable(value) ? [value] : []
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
  expect(qualifiedNames).toEqual(
    PARTY_TABLE_INVENTORY.map((name) => `party.${name}`)
  );
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
      column
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
      column
    ).toBeTruthy();
  }
  expect(
    getTableName(
      foreignKey(
        counterpartyAdminReadModels,
        'party_counterparty_admin_model_source_fk'
      ).reference().foreignTable
    )
  ).toBe(getTableName(counterparties));
  expect(
    getTableName(
      foreignKey(
        counterpartyRoleAdminReadModels,
        'party_counterparty_role_admin_model_source_fk'
      ).reference().foreignTable
    )
  ).toBe(getTableName(counterpartyRolePeriods));
  expect(
    roleConfig.indexes.some(
      (candidate) =>
        candidate.config.name ===
        'party_counterparty_role_admin_models_history_idx'
    )
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
      config.columns.some(
        (column) => column.name === 'tenant_id' && column.notNull
      ),
      `${config.name} needs a required tenant_id`
    ).toBeTruthy();
    expect(
      config.policies.map((policy) => policy.for),
      `${config.name} needs complete CRUD policies`
    ).toEqual(['select', 'insert', 'update', 'delete']);
    for (const policy of config.policies) {
      expect(policy.to).toBe('ontos_runtime');
    }
    const tenantIdentity = [
      ...config.uniqueConstraints,
      ...config.indexes,
    ].find((candidate) => {
      const columns =
        'columns' in candidate
          ? candidate.columns
          : (candidate.config.columns ?? []);
      return columns.some(
        (column) => 'name' in column && column.name === 'tenant_id'
      );
    });
    expect(
      tenantIdentity,
      `${config.name} needs a tenant-qualified unique key`
    ).toBeTruthy();
    if (tenantIdentity === undefined) {
      throw new Error(`${config.name} needs a tenant-qualified unique key`);
    }
  }
});

it('models Party identity and assertion history without conflating effective and recorded time', () => {
  const partyConfig = configOf(parties);
  expect(
    partyConfig.columns.some(
      (column) => column.name === 'current_display_name' && !column.notNull
    )
  ).toBeTruthy();
  expect(uniqueColumns(parties, 'party_parties_tenant_id_uk')).toEqual([
    'tenant_id',
    'party_id',
  ]);
  expect(
    partyConfig.checks.map((candidate) => candidate.name).toSorted()
  ).toEqual([
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
      column
    ).toBeTruthy();
  }
  expect(
    getTableName(
      foreignKey(
        partyFactAssertions,
        'party_fact_assertions_tenant_party_fk'
      ).reference().foreignTable
    )
  ).toBe(getTableName(parties));
});

it('keeps official assertions historical while exclusive claims own exact matching uniqueness', () => {
  expect(
    uniqueColumns(
      partyIdentifierClaims,
      'party_identifier_claims_exact_claim_uk'
    )
  ).toEqual([
    'tenant_id',
    'identifier_type_key',
    'namespace',
    'normalized_value',
  ]);
  expect(
    configOf(partyOfficialIdentifiers)
      .checks.map((candidate) => candidate.name)
      .toSorted()
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
      (candidate) =>
        candidate.config.name === 'party_identifier_claims_party_lookup_idx'
    )
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
      config.columns.some(
        (column) => column.name === 'external_evidence' && !column.notNull
      )
    ).toBeTruthy();
    const evidenceCheck = config.checks.find(
      (candidate) => candidate.name === `${config.name}_external_evidence_ck`
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

const checksOf = (table: (typeof configuredTables)[number]) =>
  Object.fromEntries(
    configOf(table).checks.map((candidate) => [
      candidate.name,
      dialect.sqlToQuery(candidate.value).sql,
    ])
  );

const checkSql = (checks: Readonly<Record<string, string>>, name: string) =>
  checks[name] ?? '';

it('models typed contact point lifecycles with owner-local references', () => {
  const contactChecks = checksOf(partyContactPoints);
  assert.match(
    checkSql(contactChecks, 'party_contact_points_shape_ck'),
    /EMAIL/u
  );
  assert.match(
    checkSql(contactChecks, 'party_contact_points_shape_ck'),
    /PHONE/u
  );
  assert.match(
    checkSql(contactChecks, 'party_contact_points_shape_ck'),
    /ADDRESS/u
  );
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
    assert.ok(
      configOf(partyContactPoints).columns.some(
        (candidate) => candidate.name === column
      ),
      column
    );
  }
  assert.match(
    checkSql(contactChecks, 'party_contact_points_revision_ck'),
    /> 0/u
  );
  assert.match(
    checkSql(contactChecks, 'party_contact_points_additional_evidence_ck'),
    /additional_evidence_refs.*array.*additional_evidence_refs.*32/u
  );
  assert.match(
    checkSql(contactChecks, 'party_contact_points_end_evidence_ck'),
    /valid_to.*end_reason.*end_provenance_source.*end_provenance_method.*end_evidence_refs.*ended_by_action_invocation_id.*ended_by_principal_id.*ended_recorded_at/u
  );
  assert.match(
    checkSql(contactChecks, 'party_contact_points_shape_ck'),
    /num_nonnulls/u
  );
  assert.match(
    checkSql(contactChecks, 'party_contact_points_shape_ck'),
    /\^\\\+/u
  );
  const preferredIndex = configOf(partyContactPoints).indexes.find(
    (candidate) =>
      candidate.config.name === 'party_contact_points_current_preferred_uk'
  );
  assert.equal(preferredIndex?.config.unique, true);
  assert.ok(preferredIndex?.config.where);
});

it('models contact point purpose lifecycles with owner-local references', () => {
  const purposeConfig = configOf(partyContactPointPurposes);
  const purposeChecks = Object.fromEntries(
    purposeConfig.checks.map((candidate) => [
      candidate.name,
      dialect.sqlToQuery(candidate.value).sql,
    ])
  );
  assert.match(
    checkSql(purposeChecks, 'party_contact_point_purposes_key_ck'),
    /REGISTERED/u
  );
  assert.match(
    checkSql(purposeChecks, 'party_contact_point_purposes_key_ck'),
    /BILLING/u
  );
  assert.match(
    checkSql(purposeChecks, 'party_contact_point_purposes_key_ck'),
    /DELIVERY/u
  );
  assert.match(
    checkSql(purposeChecks, 'party_contact_point_purposes_key_ck'),
    /CORRESPONDENCE/u
  );
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
    assert.ok(
      purposeConfig.columns.some((candidate) => candidate.name === column),
      column
    );
  }
  assert.match(
    checkSql(purposeChecks, 'party_contact_point_purposes_end_evidence_ck'),
    /valid_to.*end_reason.*end_provenance_source.*end_provenance_method.*end_evidence_refs.*ended_by_action_invocation_id.*ended_by_principal_id.*ended_recorded_at/u
  );
  assert.equal(
    getTableName(
      foreignKey(
        partyContactPointPurposes,
        'party_contact_point_purposes_contact_fk'
      ).reference().foreignTable
    ),
    getTableName(partyContactPoints)
  );
  const preferredPurpose = purposeConfig.indexes.find(
    (candidate) =>
      candidate.config.name ===
      'party_contact_point_purposes_current_preferred_uk'
  );
  assert.equal(preferredPurpose?.config.unique, true);
  assert.ok(preferredPurpose?.config.where);
  assert.ok(
    purposeConfig.indexes.find(
      (candidate) =>
        candidate.config.name ===
        'party_contact_point_purposes_current_registered_uk'
    )?.config.where
  );
});

it('models relationship lifecycles with owner-local references', () => {
  const relationshipChecks = checksOf(partyRelationships);
  assert.match(
    checkSql(relationshipChecks, 'party_relationships_type_ck'),
    /CONTACT_PERSON_OF/u
  );
  assert.notMatch(
    checkSql(relationshipChecks, 'party_relationships_type_ck'),
    /EMPLOYEE_OF|BRANCH_OF|OTHER/u
  );
  assert.ok(
    configOf(partyRelationships).columns.some(
      (column) =>
        column.name === 'revision' && column.notNull && column.hasDefault
    )
  );
  assert.ok(
    configOf(partyRelationships).columns.some(
      (column) => column.name === 'valid_from' && !column.notNull
    )
  );
  assert.ok(
    configOf(partyRelationships).columns.some(
      (column) =>
        column.name === 'assertion_state' && column.notNull && column.hasDefault
    )
  );
  assert.equal(
    configOf(partyRelationships).columns.some(
      (column) => column.name === 'is_current'
    ),
    false
  );
  assert.equal(
    configOf(partyRelationships).columns.some(
      (column) => column.name === 'state'
    ),
    false
  );
  assert.match(
    checkSql(relationshipChecks, 'party_relationships_interval_ck'),
    /valid_to.*is null.*valid_from.*is null.*valid_to.*>.*valid_from/u
  );
  assert.match(
    checkSql(relationshipChecks, 'party_relationships_assertion_state_ck'),
    /ACTIVE.*SUPERSEDED.*RETRACTED.*DISPUTED/u
  );
  assert.notMatch(
    checkSql(relationshipChecks, 'party_relationships_assertion_state_ck'),
    /ENDED/u
  );
  const relationshipIntervalIndex = configOf(partyRelationships).indexes.find(
    (candidate) => candidate.config.name === 'party_relationships_interval_idx'
  );
  assert.equal(relationshipIntervalIndex?.config.unique, false);
  assert.equal(relationshipIntervalIndex?.config.where, undefined);
  assert.match(
    checkSql(relationshipChecks, 'party_relationships_revision_ck'),
    /> 0/u
  );
  for (const column of [
    'end_reason',
    'end_provenance_source',
    'end_provenance_method',
    'end_evidence_reference',
    'ended_by_action_invocation_id',
    'ended_by_principal_id',
    'ended_recorded_at',
  ]) {
    assert.ok(
      configOf(partyRelationships).columns.some(
        (candidate) => candidate.name === column
      ),
      column
    );
  }
  assert.equal(
    getTableName(
      foreignKey(
        partyRelationships,
        'party_relationships_tenant_from_party_fk'
      ).reference().foreignTable
    ),
    getTableName(parties)
  );
});

it('models Counterparty lifecycles with owner-local references', () => {
  assert.deepEqual(
    uniqueColumns(counterparties, 'party_counterparties_context_uk'),
    ['tenant_id', 'party_id', 'legal_entity_id']
  );
  for (const column of [
    'creation_reason',
    'evidence_refs',
    'source_record_refs',
    'recorded_at',
  ]) {
    assert.ok(
      configOf(counterparties).columns.some(
        (candidate) => candidate.name === column
      ),
      column
    );
  }
  const roleChecks = checksOf(counterpartyRolePeriods);
  assert.match(
    checkSql(roleChecks, 'party_counterparty_role_periods_type_ck'),
    /CUSTOMER/u
  );
  assert.match(
    checkSql(roleChecks, 'party_counterparty_role_periods_type_ck'),
    /SUPPLIER/u
  );
  assert.notMatch(
    checkSql(roleChecks, 'party_counterparty_role_periods_type_ck'),
    /BUSINESS_PARTNER/u
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
    assert.ok(
      configOf(counterpartyRolePeriods).columns.some(
        (candidate) => candidate.name === column
      ),
      column
    );
  }
  const roleEndEvidence = checkSql(
    roleChecks,
    'party_counterparty_role_periods_end_evidence_ck'
  );
  assert.match(
    roleEndEvidence,
    /valid_to[^)]*is null[^)]*end_provenance_source[^)]*is null[^)]*end_provenance_method[^)]*is null/u
  );
  assert.match(
    roleEndEvidence,
    /valid_to.*is not null.*end_provenance_source.*btrim.*end_provenance_method.*btrim/u
  );
  assert.equal(
    configOf(counterpartyRolePeriods).indexes.some(
      (candidate) =>
        candidate.config.name === 'party_counterparty_role_periods_current_uk'
    ),
    false,
    'effective intervals, not an is_current unique index, own role-period uniqueness'
  );
  assert.notMatch(
    checkSql(roleChecks, 'party_counterparty_role_periods_state_ck'),
    /ACTIVE' and [^)]*is_current/u
  );
});

it('persists one recoverable match decision per Action and bounded duplicate review state', () => {
  expect(
    uniqueColumns(
      partyMatchDecisions,
      'party_match_decisions_action_invocation_uk'
    )
  ).toEqual(['tenant_id', 'action_invocation_id']);
  const decisionChecks = checksOf(partyMatchDecisions);
  expect(decisionChecks['party_match_decisions_outcome_ck'] ?? '').toMatch(
    /CREATED/u
  );
  expect(decisionChecks['party_match_decisions_outcome_ck'] ?? '').toMatch(
    /MATCHED/u
  );
  expect(decisionChecks['party_match_decisions_outcome_ck'] ?? '').toMatch(
    /AMBIGUOUS/u
  );
  expect(decisionChecks['party_match_decisions_outcome_ck'] ?? '').toMatch(
    /NO_MATCH/u
  );
  expect(
    configOf(duplicateCandidateCases).columns.some(
      (column) => column.name === 'revision'
    )
  ).toBeTruthy();
  const activeCaseIndex = configOf(duplicateCandidateCases).indexes.find(
    (candidate) =>
      candidate.config.name === 'party_duplicate_cases_fingerprint_uk'
  );
  expect(activeCaseIndex?.config.unique).toBe(true);
  expect(
    uniqueColumns(
      duplicateCandidateCases,
      'party_duplicate_cases_fingerprint_uk'
    )
  ).toEqual(['tenant_id', 'evaluation_fingerprint', 'match_rule_version']);
  expect(
    getTableName(
      foreignKey(
        duplicateCandidateCases,
        'party_duplicate_cases_prior_case_fk'
      ).reference().foreignTable
    )
  ).toBe('duplicate_candidate_cases');
  expect(activeCaseIndex?.config.where).toBeTruthy();
  if (activeCaseIndex?.config.where === undefined) {
    throw new Error('Expected active case predicate');
  }
  expect(dialect.sqlToQuery(activeCaseIndex.config.where).sql).toMatch(
    /OPEN.*NEEDS_EVIDENCE/u
  );
  const snapshotCheck = configOf(duplicateCandidateCases).checks.find(
    (candidate) => candidate.name === 'party_duplicate_cases_snapshot_ck'
  );
  expect(snapshotCheck).toBeTruthy();
  if (snapshotCheck === undefined) {
    throw new Error('Expected value to be present');
  }
  expect(dialect.sqlToQuery(snapshotCheck.value).sql).toMatch(
    /provenance.*source.*method.*validFrom/u
  );
  expect(
    getTableName(
      foreignKey(
        duplicateCandidateCaseParties,
        'party_duplicate_candidate_case_parties_tenant_party_fk'
      ).reference().foreignTable
    )
  ).toBe(getTableName(parties));
});

it('prepares append-only correction and non-executable merge records with safe aliases', () => {
  const correctionConfig = configOf(partyCorrections);
  expect(
    correctionConfig.columns.some((column) => column.name === 'reason')
  ).toBeTruthy();
  expect(
    correctionConfig.columns.some((column) => column.name === 'evidence_refs')
  ).toBeTruthy();
  expect(
    correctionConfig.columns.some(
      (column) => column.name === 'acting_principal_id'
    )
  ).toBeTruthy();
  expect(
    correctionConfig.columns.some(
      (column) => column.name === 'approving_principal_id'
    )
  ).toBeTruthy();
  expect(
    correctionConfig.columns.some((column) => column.name === 'policy_version')
  ).toBeTruthy();
  expect(
    correctionConfig.checks.some(
      (candidate) => candidate.name === 'party_corrections_target_ck'
    )
  ).toBeTruthy();

  const mergeStatus = configOf(partyMerges).checks.find(
    (candidate) => candidate.name === 'party_merges_status_ck'
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
    (candidate) => candidate.name === 'party_merges_prepared_evidence_ck'
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
    expect(
      dialect.sqlToQuery(preparedEvidence.value).sql.includes(field),
      field
    ).toBeTruthy();
  }
  expect(uniqueColumns(partyAliases, 'party_aliases_alias_uk')).toEqual([
    'tenant_id',
    'alias_party_id',
  ]);
  expect(
    configOf(partyAliases).checks.some(
      (candidate) => candidate.name === 'party_aliases_not_self_ck'
    )
  ).toBeTruthy();
});

it.effect(
  'ships an independent Party migration with forced RLS and append-only correction evidence',
  () =>
    Effect.gen(function* testScenario() {
      const drizzleConfig = yield* Effect.promise(() =>
        readFile(new URL('../../drizzle.config.ts', import.meta.url), 'utf-8')
      );
      expect(drizzleConfig).toMatch(/__drizzle_migrations_party/u);
      expect(drizzleConfig).toMatch(/\.\/src\/db\/schema\.ts/u);

      const migrationDirectory = new URL('../../drizzle/', import.meta.url);
      const migrationDirectoryEntries = yield* Effect.promise(() =>
        readdir(migrationDirectory, { withFileTypes: true })
      );
      const migrationFolders = migrationDirectoryEntries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .toSorted();
      expect(migrationFolders.length >= 2).toBeTruthy();
      const remediationFolder = migrationFolders.find((name) =>
        name.endsWith('_nebulous_cardiac')
      );
      expect(remediationFolder).toBeTruthy();
      if (remediationFolder === undefined) {
        throw new Error('Expected value to be present');
      }
      const remediation = yield* Effect.promise(() =>
        readFile(
          new URL(`${remediationFolder}/migration.sql`, migrationDirectory),
          'utf-8'
        )
      );
      expect(remediation).toMatch(/party_match_decisions_create_result_ck/u);
      expect(remediation).toMatch(/committed_create_outcome/u);
      const migration = yield* Effect.promise(() =>
        readFile(
          new URL(
            `${migrationFolders[0] ?? ''}/migration.sql`,
            migrationDirectory
          ),
          'utf-8'
        )
      );
      expect(
        migration.match(
          /ALTER TABLE "party"\."[^"]+" ENABLE ROW LEVEL SECURITY;/gu
        )?.length
      ).toBe(PARTY_TABLE_INVENTORY.length);
      expect(
        migration.match(
          /ALTER TABLE "party"\."[^"]+" FORCE ROW LEVEL SECURITY;/gu
        )?.length
      ).toBe(PARTY_TABLE_INVENTORY.length);
      expect(migration).not.toMatch(/REFERENCES "(?:core|auth|contacts)"\./u);
      expect(migration).toMatch(/party_reject_correction_mutation/u);
      expect(migration).toMatch(
        /before update or delete on "party"\."party_corrections"/iu
      );
      expect(migration).toMatch(/CREATE EXTENSION IF NOT EXISTS btree_gist/iu);
      expect(migration).toMatch(
        /party_relationships_no_overlap_excl[\s\S]*EXCLUDE USING gist[\s\S]*tstzrange[\s\S]*-infinity[\s\S]*assertion_state[\s\S]*ACTIVE/iu
      );
      expect(migration).toMatch(
        /party_counterparty_role_periods_no_overlap_excl[\s\S]*EXCLUDE USING gist[\s\S]*tstzrange/iu
      );
    })
);

it.effect(
  'registers Party ownership in application database grants and exact verification',
  () =>
    Effect.gen(function* testScenario() {
      const bootstrap = yield* Effect.promise(() =>
        readFile(
          new URL(
            '../../../../scripts/postgres/bootstrap-runtime-role.mts',
            import.meta.url
          ),
          'utf-8'
        )
      );
      const verifier = yield* Effect.promise(() =>
        readFile(
          new URL(
            '../../../../scripts/verify-application-db-schema.mts',
            import.meta.url
          ),
          'utf-8'
        )
      );
      expect(bootstrap).toMatch(/\['core', 'auth', 'contacts', 'party'\]/u);
      expect(verifier).toMatch(/\['auth', 'contacts', 'core', 'party'\]/u);
      expect(verifier).toMatch(/__drizzle_migrations_party/u);
      expect(verifier).toMatch(
        /verticals\/party-registry\/scripts\/verify-db-schema\.mts/u
      );
    })
);
