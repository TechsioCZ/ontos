// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
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
  assert.ok(constraint ?? tableIndex, `Expected unique key ${name}`);
  const columns = constraint?.columns ?? tableIndex?.config.columns ?? [];
  return columns.map((column) => ('name' in column ? column.name : false));
};

const foreignKey = (table: (typeof configuredTables)[number], name: string) => {
  const result = configOf(table).foreignKeys.find((candidate) => candidate.getName() === name);
  assert.ok(result, `Expected foreign key ${name}`);
  return result;
};

test('owns the complete Party Registry operational catalog in the party schema', () => {
  const exportedTables = Object.values(schemaExports).flatMap((value) =>
    isTable(value) ? [value] : [],
  );
  const qualifiedNames = exportedTables
    .map((table) => {
      const config = getTableConfig(table);
      return `${config.schema}.${config.name}`;
    })
    .toSorted();

  assert.equal(PARTY_SCHEMA_NAME, 'party');
  assert.deepEqual(PARTY_TABLE_INVENTORY, [
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
  assert.deepEqual(
    qualifiedNames,
    PARTY_TABLE_INVENTORY.map((name) => `party.${name}`),
  );
});

test('keeps tenant-admin Counterparty reads on an atomic owner-local projection', () => {
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
    assert.ok(
      snapshotConfig.columns.some((candidate) => candidate.name === column),
      column,
    );
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
    assert.ok(
      roleConfig.columns.some((candidate) => candidate.name === column),
      column,
    );
  }
  assert.equal(
    getTableName(
      foreignKey(
        counterpartyAdminReadModels,
        'party_counterparty_admin_model_source_fk',
      ).reference().foreignTable,
    ),
    getTableName(counterparties),
  );
  assert.equal(
    getTableName(
      foreignKey(
        counterpartyRoleAdminReadModels,
        'party_counterparty_role_admin_model_source_fk',
      ).reference().foreignTable,
    ),
    getTableName(counterpartyRolePeriods),
  );
  assert.ok(
    roleConfig.indexes.some(
      (candidate) => candidate.config.name === 'party_counterparty_role_admin_models_history_idx',
    ),
  );
  for (const config of [snapshotConfig, roleConfig]) {
    assert.deepEqual(
      config.policies.map((policy) => policy.name),
      [
        `${config.name}_tenant_select`,
        `${config.name}_tenant_insert`,
        `${config.name}_tenant_update`,
        `${config.name}_tenant_delete`,
      ],
    );
  }
});

test('gives every tenant-owned record a tenant-qualified identity and forced-RLS policy shape', () => {
  for (const table of configuredTables) {
    const config = configOf(table);
    assert.equal(config.enableRLS, true, `${config.name} must enable RLS`);
    assert.ok(
      config.columns.some((column) => column.name === 'tenant_id' && column.notNull),
      `${config.name} needs a required tenant_id`,
    );
    assert.deepEqual(
      config.policies.map((policy) => policy.for),
      ['select', 'insert', 'update', 'delete'],
      `${config.name} needs complete CRUD policies`,
    );
    for (const policy of config.policies) {
      assert.equal(policy.to, 'ontos_runtime');
    }
    const tenantIdentity = [...config.uniqueConstraints, ...config.indexes].find((candidate) => {
      const columns = 'columns' in candidate ? candidate.columns : (candidate.config.columns ?? []);
      return columns.some((column) => 'name' in column && column.name === 'tenant_id');
    });
    assert.ok(tenantIdentity, `${config.name} needs a tenant-qualified unique key`);
  }
});

test('models Party identity and assertion history without conflating effective and recorded time', () => {
  const partyConfig = configOf(parties);
  assert.ok(
    partyConfig.columns.some((column) => column.name === 'current_display_name' && !column.notNull),
  );
  assert.deepEqual(uniqueColumns(parties, 'party_parties_tenant_id_uk'), ['tenant_id', 'party_id']);
  assert.deepEqual(partyConfig.checks.map((candidate) => candidate.name).toSorted(), [
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
    assert.ok(
      assertionConfig.columns.some((candidate) => candidate.name === column),
      column,
    );
  }
  assert.equal(
    getTableName(
      foreignKey(partyFactAssertions, 'party_fact_assertions_tenant_party_fk').reference()
        .foreignTable,
    ),
    getTableName(parties),
  );
});

test('keeps official assertions historical while exclusive claims own exact matching uniqueness', () => {
  assert.deepEqual(uniqueColumns(partyIdentifierClaims, 'party_identifier_claims_exact_claim_uk'), [
    'tenant_id',
    'identifier_type_key',
    'namespace',
    'normalized_value',
  ]);
  assert.deepEqual(
    configOf(partyOfficialIdentifiers)
      .checks.map((candidate) => candidate.name)
      .toSorted(),
    [
      'party_official_identifiers_external_evidence_ck',
      'party_official_identifiers_interval_ck',
      'party_official_identifiers_normalized_value_ck',
      'party_official_identifiers_state_ck',
      'party_official_identifiers_type_ck',
      'party_official_identifiers_verification_ck',
    ],
  );
  const claims = configOf(partyIdentifierClaims);
  assert.ok(
    claims.indexes.some(
      (candidate) => candidate.config.name === 'party_identifier_claims_party_lookup_idx',
    ),
  );
});

test('preserves bounded external observation evidence separately from trusted actor and effective time', () => {
  for (const table of [
    partyFactAssertions,
    partyOfficialIdentifiers,
    partyContactPoints,
    partyContactPointPurposes,
  ]) {
    const config = configOf(table);
    assert.ok(
      config.columns.some((column) => column.name === 'external_evidence' && !column.notNull),
    );
    const evidenceCheck = config.checks.find(
      (candidate) => candidate.name === `${config.name}_external_evidence_ck`,
    );
    assert.ok(evidenceCheck);
    const evidenceSql = dialect.sqlToQuery(evidenceCheck.value).sql;
    assert.match(evidenceSql, /observedAt/u);
    assert.match(evidenceSql, /decidedAt/u);
    assert.match(evidenceSql, /authorityPolicyKey/u);
    assert.match(evidenceSql, /party_registry\.ares_enrichment/u);
    assert.match(evidenceSql, /4096/u);
    assert.doesNotMatch(evidenceSql, /validFrom|principalId|rawPayload/u);
  }
});

// eslint-disable-next-line complexity -- One schema-boundary matrix keeps all related family invariants visible.
test('models typed contact, relationship, and Counterparty lifecycles with owner-local references', () => {
  const contactChecks = Object.fromEntries(
    configOf(partyContactPoints).checks.map((candidate) => [
      candidate.name,
      dialect.sqlToQuery(candidate.value).sql,
    ]),
  );
  assert.match(contactChecks['party_contact_points_shape_ck'] ?? '', /EMAIL/u);
  assert.match(contactChecks['party_contact_points_shape_ck'] ?? '', /PHONE/u);
  assert.match(contactChecks['party_contact_points_shape_ck'] ?? '', /ADDRESS/u);
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
      configOf(partyContactPoints).columns.some((candidate) => candidate.name === column),
      column,
    );
  }
  assert.match(contactChecks['party_contact_points_revision_ck'] ?? '', /> 0/u);
  assert.match(
    contactChecks['party_contact_points_additional_evidence_ck'] ?? '',
    /additional_evidence_refs.*array.*additional_evidence_refs.*32/u,
  );
  assert.match(
    contactChecks['party_contact_points_end_evidence_ck'] ?? '',
    /valid_to.*end_reason.*end_provenance_source.*end_provenance_method.*end_evidence_refs.*ended_by_action_invocation_id.*ended_by_principal_id.*ended_recorded_at/u,
  );
  assert.match(contactChecks['party_contact_points_shape_ck'] ?? '', /num_nonnulls/u);
  assert.match(contactChecks['party_contact_points_shape_ck'] ?? '', /\^\\\+/u);
  const preferredIndex = configOf(partyContactPoints).indexes.find(
    (candidate) => candidate.config.name === 'party_contact_points_current_preferred_uk',
  );
  assert.equal(preferredIndex?.config.unique, true);
  assert.ok(preferredIndex?.config.where);
  const purposeConfig = configOf(partyContactPointPurposes);
  const purposeChecks = Object.fromEntries(
    purposeConfig.checks.map((candidate) => [
      candidate.name,
      dialect.sqlToQuery(candidate.value).sql,
    ]),
  );
  assert.match(purposeChecks['party_contact_point_purposes_key_ck'] ?? '', /REGISTERED/u);
  assert.match(purposeChecks['party_contact_point_purposes_key_ck'] ?? '', /BILLING/u);
  assert.match(purposeChecks['party_contact_point_purposes_key_ck'] ?? '', /DELIVERY/u);
  assert.match(purposeChecks['party_contact_point_purposes_key_ck'] ?? '', /CORRESPONDENCE/u);
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
      column,
    );
  }
  assert.match(
    purposeChecks['party_contact_point_purposes_end_evidence_ck'] ?? '',
    /valid_to.*end_reason.*end_provenance_source.*end_provenance_method.*end_evidence_refs.*ended_by_action_invocation_id.*ended_by_principal_id.*ended_recorded_at/u,
  );
  assert.equal(
    getTableName(
      foreignKey(partyContactPointPurposes, 'party_contact_point_purposes_contact_fk').reference()
        .foreignTable,
    ),
    getTableName(partyContactPoints),
  );
  const preferredPurpose = purposeConfig.indexes.find(
    (candidate) => candidate.config.name === 'party_contact_point_purposes_current_preferred_uk',
  );
  assert.equal(preferredPurpose?.config.unique, true);
  assert.ok(preferredPurpose?.config.where);
  assert.ok(
    purposeConfig.indexes.find(
      (candidate) => candidate.config.name === 'party_contact_point_purposes_current_registered_uk',
    )?.config.where,
  );

  const relationshipChecks = Object.fromEntries(
    configOf(partyRelationships).checks.map((candidate) => [
      candidate.name,
      dialect.sqlToQuery(candidate.value).sql,
    ]),
  );
  assert.match(relationshipChecks['party_relationships_type_ck'] ?? '', /CONTACT_PERSON_OF/u);
  assert.doesNotMatch(
    relationshipChecks['party_relationships_type_ck'] ?? '',
    /EMPLOYEE_OF|BRANCH_OF|OTHER/u,
  );
  assert.ok(
    configOf(partyRelationships).columns.some(
      (column) => column.name === 'revision' && column.notNull && column.hasDefault,
    ),
  );
  assert.ok(
    configOf(partyRelationships).columns.some(
      (column) => column.name === 'valid_from' && !column.notNull,
    ),
  );
  assert.ok(
    configOf(partyRelationships).columns.some(
      (column) => column.name === 'assertion_state' && column.notNull && column.hasDefault,
    ),
  );
  assert.equal(
    configOf(partyRelationships).columns.some((column) => column.name === 'is_current'),
    false,
  );
  assert.equal(
    configOf(partyRelationships).columns.some((column) => column.name === 'state'),
    false,
  );
  assert.match(
    relationshipChecks['party_relationships_interval_ck'] ?? '',
    /valid_to.*is null.*valid_from.*is null.*valid_to.*>.*valid_from/u,
  );
  assert.match(
    relationshipChecks['party_relationships_assertion_state_ck'] ?? '',
    /ACTIVE.*SUPERSEDED.*RETRACTED.*DISPUTED/u,
  );
  assert.doesNotMatch(relationshipChecks['party_relationships_assertion_state_ck'] ?? '', /ENDED/u);
  const relationshipIntervalIndex = configOf(partyRelationships).indexes.find(
    (candidate) => candidate.config.name === 'party_relationships_interval_idx',
  );
  assert.equal(relationshipIntervalIndex?.config.unique, false);
  assert.equal(relationshipIntervalIndex?.config.where, undefined);
  assert.match(relationshipChecks['party_relationships_revision_ck'] ?? '', /> 0/u);
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
      configOf(partyRelationships).columns.some((candidate) => candidate.name === column),
      column,
    );
  }
  assert.equal(
    getTableName(
      foreignKey(partyRelationships, 'party_relationships_tenant_from_party_fk').reference()
        .foreignTable,
    ),
    getTableName(parties),
  );

  assert.deepEqual(uniqueColumns(counterparties, 'party_counterparties_context_uk'), [
    'tenant_id',
    'party_id',
    'legal_entity_id',
  ]);
  for (const column of ['creation_reason', 'evidence_refs', 'source_record_refs', 'recorded_at']) {
    assert.ok(
      configOf(counterparties).columns.some((candidate) => candidate.name === column),
      column,
    );
  }
  const roleChecks = Object.fromEntries(
    configOf(counterpartyRolePeriods).checks.map((candidate) => [
      candidate.name,
      dialect.sqlToQuery(candidate.value).sql,
    ]),
  );
  assert.match(roleChecks['party_counterparty_role_periods_type_ck'] ?? '', /CUSTOMER/u);
  assert.match(roleChecks['party_counterparty_role_periods_type_ck'] ?? '', /SUPPLIER/u);
  assert.doesNotMatch(
    roleChecks['party_counterparty_role_periods_type_ck'] ?? '',
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
    assert.ok(
      configOf(counterpartyRolePeriods).columns.some((candidate) => candidate.name === column),
      column,
    );
  }
  const roleEndEvidence = roleChecks['party_counterparty_role_periods_end_evidence_ck'] ?? '';
  assert.match(
    roleEndEvidence,
    /valid_to[^)]*is null[^)]*end_provenance_source[^)]*is null[^)]*end_provenance_method[^)]*is null/u,
  );
  assert.match(
    roleEndEvidence,
    /valid_to.*is not null.*end_provenance_source.*btrim.*end_provenance_method.*btrim/u,
  );
  assert.equal(
    configOf(counterpartyRolePeriods).indexes.some(
      (candidate) => candidate.config.name === 'party_counterparty_role_periods_current_uk',
    ),
    false,
    'effective intervals, not an is_current unique index, own role-period uniqueness',
  );
  assert.doesNotMatch(
    roleChecks['party_counterparty_role_periods_state_ck'] ?? '',
    /ACTIVE' and [^)]*is_current/u,
  );
});

test('persists one recoverable match decision per Action and bounded duplicate review state', () => {
  assert.deepEqual(
    uniqueColumns(partyMatchDecisions, 'party_match_decisions_action_invocation_uk'),
    ['tenant_id', 'action_invocation_id'],
  );
  const decisionChecks = Object.fromEntries(
    configOf(partyMatchDecisions).checks.map((candidate) => [
      candidate.name,
      dialect.sqlToQuery(candidate.value).sql,
    ]),
  );
  assert.match(decisionChecks['party_match_decisions_outcome_ck'] ?? '', /CREATED/u);
  assert.match(decisionChecks['party_match_decisions_outcome_ck'] ?? '', /MATCHED/u);
  assert.match(decisionChecks['party_match_decisions_outcome_ck'] ?? '', /AMBIGUOUS/u);
  assert.match(decisionChecks['party_match_decisions_outcome_ck'] ?? '', /NO_MATCH/u);
  assert.ok(configOf(duplicateCandidateCases).columns.some((column) => column.name === 'revision'));
  const activeCaseIndex = configOf(duplicateCandidateCases).indexes.find(
    (candidate) => candidate.config.name === 'party_duplicate_cases_fingerprint_uk',
  );
  assert.equal(activeCaseIndex?.config.unique, true);
  assert.deepEqual(uniqueColumns(duplicateCandidateCases, 'party_duplicate_cases_fingerprint_uk'), [
    'tenant_id',
    'evaluation_fingerprint',
    'match_rule_version',
  ]);
  assert.equal(
    getTableName(
      foreignKey(duplicateCandidateCases, 'party_duplicate_cases_prior_case_fk').reference()
        .foreignTable,
    ),
    'duplicate_candidate_cases',
  );
  assert.ok(activeCaseIndex?.config.where);
  assert.match(dialect.sqlToQuery(activeCaseIndex.config.where).sql, /OPEN.*NEEDS_EVIDENCE/u);
  const snapshotCheck = configOf(duplicateCandidateCases).checks.find(
    (candidate) => candidate.name === 'party_duplicate_cases_snapshot_ck',
  );
  assert.ok(snapshotCheck);
  assert.match(
    dialect.sqlToQuery(snapshotCheck.value).sql,
    /provenance.*source.*method.*validFrom/u,
  );
  assert.equal(
    getTableName(
      foreignKey(
        duplicateCandidateCaseParties,
        'party_duplicate_candidate_case_parties_tenant_party_fk',
      ).reference().foreignTable,
    ),
    getTableName(parties),
  );
});

test('prepares append-only correction and non-executable merge records with safe aliases', () => {
  const correctionConfig = configOf(partyCorrections);
  assert.ok(correctionConfig.columns.some((column) => column.name === 'reason'));
  assert.ok(correctionConfig.columns.some((column) => column.name === 'evidence_refs'));
  assert.ok(correctionConfig.columns.some((column) => column.name === 'acting_principal_id'));
  assert.ok(correctionConfig.columns.some((column) => column.name === 'approving_principal_id'));
  assert.ok(correctionConfig.columns.some((column) => column.name === 'policy_version'));
  assert.ok(
    correctionConfig.checks.some((candidate) => candidate.name === 'party_corrections_target_ck'),
  );

  const mergeStatus = configOf(partyMerges).checks.find(
    (candidate) => candidate.name === 'party_merges_status_ck',
  );
  assert.ok(mergeStatus);
  const mergeStatusSql = dialect.sqlToQuery(mergeStatus.value).sql;
  assert.match(mergeStatusSql, /PREPARED/u);
  assert.match(mergeStatusSql, /BLOCKED/u);
  assert.doesNotMatch(mergeStatusSql, /APPLIED|COMPLETED|EXECUTED/u);
  const preparedEvidence = configOf(partyMerges).checks.find(
    (candidate) => candidate.name === 'party_merges_prepared_evidence_ck',
  );
  assert.ok(preparedEvidence);
  for (const field of [
    'version',
    'confirmedDuplicateDecisionId',
    'decisionActorPrincipalId',
    'absorbedPartyRefs',
    'selectionPolicyVersion',
    'selectionReason',
    'selectionEvidenceChain',
  ]) {
    assert.ok(dialect.sqlToQuery(preparedEvidence.value).sql.includes(field), field);
  }
  assert.deepEqual(uniqueColumns(partyAliases, 'party_aliases_alias_uk'), [
    'tenant_id',
    'alias_party_id',
  ]);
  assert.ok(
    configOf(partyAliases).checks.some(
      (candidate) => candidate.name === 'party_aliases_not_self_ck',
    ),
  );
});

test('ships an independent Party migration with forced RLS and append-only correction evidence', async () => {
  const drizzleConfig = await readFile(
    new URL('../../drizzle.config.ts', import.meta.url),
    'utf-8',
  );
  assert.match(drizzleConfig, /__drizzle_migrations_party/u);
  assert.match(drizzleConfig, /\.\/src\/db\/schema\.ts/u);

  const migrationDirectory = new URL('../../drizzle/', import.meta.url);
  const migrationDirectoryEntries = await readdir(migrationDirectory, { withFileTypes: true });
  const migrationFolders = migrationDirectoryEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
  assert.ok(migrationFolders.length >= 2);
  const remediationFolder = migrationFolders.find((name) => name.endsWith('_nebulous_cardiac'));
  assert.ok(remediationFolder);
  const remediation = await readFile(
    new URL(`${remediationFolder}/migration.sql`, migrationDirectory),
    'utf-8',
  );
  assert.match(remediation, /party_match_decisions_create_result_ck/u);
  assert.match(remediation, /committed_create_outcome/u);
  const migration = await readFile(
    new URL(`${migrationFolders[0] ?? ''}/migration.sql`, migrationDirectory),
    'utf-8',
  );
  assert.equal(
    migration.match(/ALTER TABLE "party"\."[^"]+" ENABLE ROW LEVEL SECURITY;/gu)?.length,
    PARTY_TABLE_INVENTORY.length,
  );
  assert.equal(
    migration.match(/ALTER TABLE "party"\."[^"]+" FORCE ROW LEVEL SECURITY;/gu)?.length,
    PARTY_TABLE_INVENTORY.length,
  );
  assert.doesNotMatch(migration, /REFERENCES "(?:core|auth|contacts)"\./u);
  assert.match(migration, /party_reject_correction_mutation/u);
  assert.match(migration, /before update or delete on "party"\."party_corrections"/iu);
  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS btree_gist/iu);
  assert.match(
    migration,
    /party_relationships_no_overlap_excl[\s\S]*EXCLUDE USING gist[\s\S]*tstzrange[\s\S]*-infinity[\s\S]*assertion_state[\s\S]*ACTIVE/iu,
  );
  assert.match(
    migration,
    /party_counterparty_role_periods_no_overlap_excl[\s\S]*EXCLUDE USING gist[\s\S]*tstzrange/iu,
  );
});

test('registers Party ownership in application database grants and exact verification', async () => {
  const bootstrap = await readFile(
    new URL('../../../../scripts/postgres/bootstrap-runtime-role.mts', import.meta.url),
    'utf-8',
  );
  const verifier = await readFile(
    new URL('../../../../scripts/verify-application-db-schema.mts', import.meta.url),
    'utf-8',
  );
  assert.match(bootstrap, /\['core', 'auth', 'contacts', 'party'\]/u);
  assert.match(verifier, /\['auth', 'contacts', 'core', 'party'\]/u);
  assert.match(verifier, /__drizzle_migrations_party/u);
  assert.match(verifier, /verticals\/party-registry\/scripts\/verify-db-schema\.mts/u);
});
