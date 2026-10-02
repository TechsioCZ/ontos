// @effect-diagnostics nodeBuiltinImport:off -- Migration contract reads checked-in Pricing SQL; expires: 2027-03-31.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import {
  contractualDiscountActionInvocationReceipts,
  currencySupportProofReceipts,
  currencySupportRecoveryCompensationReceipts,
  currencySupportRevisions,
  currencySupportRoots,
  currencySupportScheduleEntries,
  currencySupportScheduleHeads,
  currencySupportScheduleRevisions,
  currencySupportValueRevisions,
  feeSetHeads,
  feeSetRevisions,
  feeSetRoots,
  materialEvidenceProofReceipts,
  priceCandidateSetHeads,
  priceCandidateSetRevisions,
  priceCandidateSetRoots,
  priceCurrentRevisions,
  priceFeeActionInvocationClaims,
  priceFeeActionResultReceipts,
  priceInvocationReceipts,
  priceRevisions,
  priceScheduleAcknowledgements,
  priceScheduleEntries,
  priceScheduleHeads,
  priceScheduleRevisions,
  priceSourceAssertionDeliveries,
  priceSourceAssertions,
  prices,
  PRICING_SCHEMA_NAME,
  PRICING_TABLE_INVENTORY,
  PRICING_TABLES,
  quantityTierRevisions,
  quantityTierSetHeads,
  quantityTierSetRevisions,
  quantityTierSetRoots,
  quantityTierScheduleAcknowledgements,
  quantityTierScheduleEntries,
  quantityTierScheduleHeads,
  quantityTierScheduleRevisions,
  quantityTiers,
  zeroFloorActionInvocationReceipts,
} from '../../src/database/schema.ts';

const migration = readFileSync(
  fileURLToPath(new URL('../../drizzle/20260922093000_pricing-currency-support/migration.sql', import.meta.url)),
  'utf-8',
);
const tenantCurrencySupportStorageMigration = readFileSync(
  fileURLToPath(new URL('../../drizzle/20260927181231_tenant-currency-support-v1/migration.sql', import.meta.url)),
  'utf-8',
);
const tenantCurrencySupportRuntimeMigration = readFileSync(
  fileURLToPath(
    new URL('../../drizzle/20260927181241_tenant-currency-support-runtime-v1/migration.sql', import.meta.url),
  ),
  'utf-8',
);
const legacyAuthorityRetirementMigration = readFileSync(
  fileURLToPath(
    new URL('../../drizzle/20260927181352_retire-legacy-currency-support-authority/migration.sql', import.meta.url),
  ),
  'utf-8',
);
const legacyHistoryFreezeMigration = readFileSync(
  fileURLToPath(
    new URL('../../drizzle/20260927183819_freeze-legacy-currency-support-history/migration.sql', import.meta.url),
  ),
  'utf-8',
);
const currencySupportRecoveryCompensationStorageMigration = readFileSync(
  fileURLToPath(
    new URL(
      '../../drizzle/20261001180536_pricing-currency-support-recovery-compensation-v1/migration.sql',
      import.meta.url,
    ),
  ),
  'utf-8',
);
const currencySupportRecoveryCompensationRuntimeMigration = readFileSync(
  fileURLToPath(
    new URL(
      '../../drizzle/20261001180624_pricing-currency-support-recovery-compensation-runtime-v1/migration.sql',
      import.meta.url,
    ),
  ),
  'utf-8',
);
const priceFoundationMigration = readFileSync(
  fileURLToPath(new URL('../../drizzle/20260927143130_pricing-price-foundation/migration.sql', import.meta.url)),
  'utf-8',
);
const priceRoutinesMigration = readFileSync(
  fileURLToPath(new URL('../../drizzle/20260927143143_pricing-price-routines-v1/migration.sql', import.meta.url)),
  'utf-8',
);
const priceAppendOnlyPolicyMigration = readFileSync(
  fileURLToPath(
    new URL('../../drizzle/20260927144222_pricing-price-append-only-policies/migration.sql', import.meta.url),
  ),
  'utf-8',
);
const priceInvocationReceiptMigration = readFileSync(
  fileURLToPath(
    new URL('../../drizzle/20260927150506_pricing-price-invocation-receipts/migration.sql', import.meta.url),
  ),
  'utf-8',
);
const priceInvocationReceiptForceRlsMigration = readFileSync(
  fileURLToPath(
    new URL('../../drizzle/20260927150522_pricing-price-invocation-receipts-force-rls/migration.sql', import.meta.url),
  ),
  'utf-8',
);
const priceScheduleStorageMigration = readFileSync(
  fileURLToPath(new URL('../../drizzle/20260927162951_pricing-price-schedules-v1/migration.sql', import.meta.url)),
  'utf-8',
);
const priceScheduleRuntimeMigration = readFileSync(
  fileURLToPath(
    new URL('../../drizzle/20260927162957_pricing-price-schedule-runtime-v1/migration.sql', import.meta.url),
  ),
  'utf-8',
);
const priceSourceStorageMigration = readFileSync(
  fileURLToPath(
    new URL('../../drizzle/20260927190758_pricing-price-source-provenance-v1/migration.sql', import.meta.url),
  ),
  'utf-8',
);
const priceSourceRuntimeMigration = readFileSync(
  fileURLToPath(new URL('../../drizzle/20260927190759_pricing-price-source-runtime-v2/migration.sql', import.meta.url)),
  'utf-8',
);
const quantityTierStorageMigration = readFileSync(
  fileURLToPath(new URL('../../drizzle/20260927194639_pricing-quantity-tiers-v1/migration.sql', import.meta.url)),
  'utf-8',
);
const quantityTierRuntimeMigration = readFileSync(
  fileURLToPath(
    new URL('../../drizzle/20260927194717_pricing-quantity-tier-runtime-v1/migration.sql', import.meta.url),
  ),
  'utf-8',
);
const quantityTierSetStorageMigration = readFileSync(
  fileURLToPath(
    new URL('../../drizzle/20260928110000_pricing_quantity_tier_set_authority_v1/migration.sql', import.meta.url),
  ),
  'utf-8',
);
const quantityTierSetRuntimeMigration = readFileSync(
  fileURLToPath(
    new URL('../../drizzle/20260928110001_pricing_quantity_tier_set_runtime_v1/migration.sql', import.meta.url),
  ),
  'utf-8',
);
const quantityTierProofMigration = readFileSync(
  fileURLToPath(
    new URL('../../drizzle/20260928110016_pricing_quantity_tier_proof_receipts_v1/migration.sql', import.meta.url),
  ),
  'utf-8',
);
const priceFeeSetRuntimeMigration = readFileSync(
  fileURLToPath(
    new URL('../../drizzle/20260928110003_pricing_price_fee_set_runtime_v1/migration.sql', import.meta.url),
  ),
  'utf-8',
);
const discountZeroFloorRuntimeMigration = readFileSync(
  fileURLToPath(
    new URL('../../drizzle/20260928110007_pricing_discount_zero_floor_runtime_v1/migration.sql', import.meta.url),
  ),
  'utf-8',
);
const zeroFloorRuntimeMigration = readFileSync(
  fileURLToPath(new URL('../../drizzle/20260928110008_pricing_zero_floor_runtime_v1/migration.sql', import.meta.url)),
  'utf-8',
);
const priceFeeResultRuntimeMigration = readFileSync(
  fileURLToPath(
    new URL('../../drizzle/20260928110009_pricing_price_fee_result_lookup_v1/migration.sql', import.meta.url),
  ),
  'utf-8',
);
const priceTerminalConflictReceiptMigration = readFileSync(
  fileURLToPath(
    new URL('../../drizzle/20261001192407_pricing-price-terminal-conflict-receipts-v1/migration.sql', import.meta.url),
  ),
  'utf-8',
);
const priceTerminalConflictReceiptRuntimeMigration = readFileSync(
  fileURLToPath(
    new URL(
      '../../drizzle/20261001192424_pricing-price-terminal-conflict-receipts-runtime-v1/migration.sql',
      import.meta.url,
    ),
  ),
  'utf-8',
);
const quantityTierManagementRuntimeMigration = readFileSync(
  fileURLToPath(
    new URL('../../drizzle/20260928110010_pricing_tier_management_runtime_v1/migration.sql', import.meta.url),
  ),
  'utf-8',
);
const currencySupportResultRuntimeMigration = readFileSync(
  fileURLToPath(
    new URL('../../drizzle/20260928110011_pricing_currency_result_lookup_v1/migration.sql', import.meta.url),
  ),
  'utf-8',
);
const readPriceScheduleRoutine = priceScheduleRuntimeMigration.slice(
  priceScheduleRuntimeMigration.indexOf('CREATE OR REPLACE FUNCTION pricing.read_price_schedule_v1'),
  priceScheduleRuntimeMigration.indexOf('CREATE OR REPLACE FUNCTION pricing.read_current_price_definition_v1'),
);
const revisePriceRoutine = priceScheduleRuntimeMigration.slice(
  priceScheduleRuntimeMigration.indexOf('CREATE OR REPLACE FUNCTION pricing.revise_price_v1'),
);

const DrizzleSnapshotIdSchema = Schema.String.pipe(Schema.brand('DrizzleSnapshotId'));
const DrizzleSnapshotHeaderSchema = Schema.Struct({
  dialect: Schema.String,
  id: DrizzleSnapshotIdSchema,
  prevIds: Schema.Array(DrizzleSnapshotIdSchema),
  version: Schema.String,
});

const pricingMigrationRoot = new URL('../../drizzle/', import.meta.url);
const pricingMigrationFolders = readdirSync(pricingMigrationRoot, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() &&
      /^\d{14}_/u.test(entry.name) &&
      (existsSync(new URL(`${entry.name}/migration.sql`, pricingMigrationRoot)) ||
        existsSync(new URL(`${entry.name}/snapshot.json`, pricingMigrationRoot))),
  )
  .map((entry) => entry.name)
  .toSorted();

describe('Pricing Drizzle migration history contract', () => {
  it('owns one complete linear v1 snapshot chain across every migration folder', () => {
    let previousSnapshotId = '00000000-0000-0000-0000-000000000000';
    const snapshotIds = new Set<string>();

    for (const folder of pricingMigrationFolders) {
      const migrationSql = readFileSync(new URL(`${folder}/migration.sql`, pricingMigrationRoot), 'utf-8');
      const snapshot = Schema.decodeSync(Schema.fromJsonString(DrizzleSnapshotHeaderSchema))(
        readFileSync(new URL(`${folder}/snapshot.json`, pricingMigrationRoot), 'utf-8'),
      );

      expect(migrationSql.length, `${folder} must contain migration SQL`).toBeGreaterThan(0);
      expect(snapshot.version, `${folder} must use the Drizzle v1 snapshot format`).toBe('8');
      expect(snapshot.dialect, `${folder} must target PostgreSQL`).toBe('postgres');
      expect(snapshot.prevIds, `${folder} must follow the immediately preceding Pricing snapshot`).toEqual([
        previousSnapshotId,
      ]);
      expect(snapshotIds.has(snapshot.id), `${folder} must own a unique snapshot ID`).toBe(false);

      snapshotIds.add(snapshot.id);
      previousSnapshotId = snapshot.id;
    }
  });
});

describe('Pricing currency support database contract', () => {
  it('preserves qualified legacy history and owns one canonical Tenant root with immutable schedules', () => {
    expect(PRICING_SCHEMA_NAME).toBe('pricing');
    expect(PRICING_TABLE_INVENTORY).toContain('currency_support_revisions');
    expect(getTableName(currencySupportRevisions)).toBe('currency_support_revisions');
    expect(
      [
        currencySupportRoots,
        currencySupportScheduleEntries,
        currencySupportScheduleHeads,
        currencySupportScheduleRevisions,
        currencySupportValueRevisions,
      ].map(getTableName),
    ).toEqual([
      'currency_support_roots',
      'currency_support_schedule_entries',
      'currency_support_schedule_heads',
      'currency_support_schedule_revisions',
      'currency_support_value_revisions',
    ]);
    expect(getTableConfig(currencySupportRoots).uniqueConstraints.map(({ name }) => name)).toContain(
      'pricing_currency_support_roots_tenant_uk',
    );
    expect(getTableConfig(currencySupportScheduleHeads).uniqueConstraints.map(({ name }) => name)).toContain(
      'pricing_currency_support_heads_tenant_uk',
    );
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(tenantCurrencySupportStorageMigration).not.toContain('legal_entity_id');
    expect(tenantCurrencySupportStorageMigration).not.toContain('context_revision');
    expect(tenantCurrencySupportStorageMigration).not.toContain('storefront_id');
    expect(tenantCurrencySupportStorageMigration).not.toContain('market_id');
    expect(tenantCurrencySupportStorageMigration).not.toContain('channel_id');
    expect(tenantCurrencySupportStorageMigration).not.toContain('cart_id');
    expect(tenantCurrencySupportStorageMigration).not.toContain('subject_fingerprint');
  });

  it('enforces Tenant-only RLS, immutable facts, CAS head, and non-overlapping effective periods', () => {
    for (const table of [
      currencySupportRoots,
      currencySupportScheduleEntries,
      currencySupportScheduleHeads,
      currencySupportScheduleRevisions,
      currencySupportValueRevisions,
    ]) {
      const config = getTableConfig(table);
      expect(config.enableRLS, `${config.name} must enable RLS`).toBe(true);
      expect(config.columns.some(({ name, notNull }) => name === 'tenant_id' && notNull)).toBe(true);
      expect(config.columns.some(({ name }) => name === 'legal_entity_id')).toBe(false);
    }
    expect(tenantCurrencySupportRuntimeMigration).toContain('pricing_currency_support_entries_no_overlap');
    expect(tenantCurrencySupportRuntimeMigration).toContain('EXCLUDE USING gist');
    expect(tenantCurrencySupportRuntimeMigration).toContain('pg_advisory_xact_lock');
    expect(tenantCurrencySupportRuntimeMigration).toContain('schedule_revision = v_expected_schedule_revision');
    expect(tenantCurrencySupportRuntimeMigration).toContain('GET DIAGNOSTICS v_updated_count = ROW_COUNT');
    expect(tenantCurrencySupportRuntimeMigration).toContain('FORCE ROW LEVEL SECURITY');
  });

  it('keeps Currency Support proof receipts private behind owner routines', () => {
    const proof = getTableConfig(currencySupportProofReceipts);

    expect(proof.enableRLS).toBe(true);
    expect(proof.columns.some(({ name, notNull }) => name === 'fact_proofs' && notNull)).toBe(true);
    expect(proof.checks.map(({ name }) => name)).toContain('pricing_currency_support_proof_facts_ck');
    expect(proof.uniqueConstraints.map(({ name }) => name)).toContain('pricing_currency_support_proof_ref_uk');
    expect(proof.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
      expect.arrayContaining(['pricing_currency_support_proof_value_fk', 'pricing_currency_support_proof_schedule_fk']),
    );
    expect(proof.policies.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'pricing_currency_support_proof_tenant_select',
        'pricing_currency_support_proof_tenant_insert',
        'pricing_currency_support_proof_tenant_update',
        'pricing_currency_support_proof_tenant_delete',
      ]),
    );
  });

  it('binds recovery compensation to the committed result and advances only the canonical schedule', () => {
    const receipt = getTableConfig(currencySupportRecoveryCompensationReceipts);

    expect(receipt.enableRLS).toBe(true);
    expect(receipt.uniqueConstraints.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'pricing_currency_support_recovery_compensation_commit_uk',
        'pricing_currency_support_recovery_compensation_invocation_uk',
      ]),
    );
    expect(receipt.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
      expect.arrayContaining([
        'pricing_currency_support_recovery_compensation_commit_fk',
        'pricing_currency_support_recovery_compensation_root_fk',
        'pricing_currency_support_recovery_compensation_value_fk',
        'pricing_currency_support_recovery_compensation_previous_schedule_fk',
        'pricing_currency_support_recovery_compensation_schedule_fk',
      ]),
    );
    expect(currencySupportRecoveryCompensationStorageMigration).toContain(
      'CREATE TABLE "pricing"."currency_support_recovery_compensation_receipts"',
    );
    expect(currencySupportRecoveryCompensationRuntimeMigration).toContain(
      'CREATE FUNCTION pricing.compensate_tenant_currency_support_recovery_v1',
    );
    expect(currencySupportRecoveryCompensationRuntimeMigration).toContain(
      "v_committed_receipt.request_payload #>> '{expectedState,state}' <> 'ABSENT'",
    );
    expect(currencySupportRecoveryCompensationRuntimeMigration).toContain(
      'v_current.created_by_action_invocation_id IS DISTINCT FROM v_committed_invocation_id',
    );
    expect(currencySupportRecoveryCompensationRuntimeMigration).toContain(
      'INSERT INTO pricing.currency_support_schedule_revisions',
    );
    expect(currencySupportRecoveryCompensationRuntimeMigration).not.toContain('DELETE FROM pricing.currency_support');
    expect(currencySupportRecoveryCompensationRuntimeMigration).not.toContain(
      'INSERT INTO pricing.currency_support_revisions',
    );
    expect(currencySupportRecoveryCompensationRuntimeMigration).toContain(
      'REVOKE ALL ON TABLE pricing.currency_support_revisions FROM ontos_runtime',
    );
  });

  it('publishes cardinality/currentness evidence and retires the legacy mutable authority without deriving a baseline', () => {
    expect(tenantCurrencySupportRuntimeMigration).toContain('read_tenant_currency_support_v1');
    expect(tenantCurrencySupportRuntimeMigration).toContain('set_tenant_currency_support_v1');
    expect(tenantCurrencySupportRuntimeMigration).toContain("'CURRENCY_SUPPORT_ABSENT'");
    expect(tenantCurrencySupportRuntimeMigration).toContain("'CURRENCY_SUPPORT_GAP'");
    expect(tenantCurrencySupportRuntimeMigration).toContain("'CURRENCY_SUPPORT_CONFLICT'");
    expect(tenantCurrencySupportRuntimeMigration).toContain("'CURRENCY_SUPPORT_CURRENT'");
    expect(tenantCurrencySupportRuntimeMigration).toContain("'activeRevisionCount'");
    expect(tenantCurrencySupportRuntimeMigration).toContain("'evaluatedAt'");
    expect(tenantCurrencySupportRuntimeMigration).toContain("'observedAt'");
    expect(tenantCurrencySupportRuntimeMigration).toContain("'revalidatedAt'");
    expect(tenantCurrencySupportRuntimeMigration).toContain('statement_timestamp()');
    expect(tenantCurrencySupportRuntimeMigration).toContain('clock_timestamp()');
    expect(tenantCurrencySupportRuntimeMigration).toContain('CREATE FUNCTION pricing.read_tenant_currency_support_v1');
    expect(tenantCurrencySupportRuntimeMigration).toContain(
      'CREATE FUNCTION pricing.revalidate_tenant_currency_support_v1',
    );
    expect(tenantCurrencySupportRuntimeMigration).toContain("v_mode IS DISTINCT FROM 'HISTORICAL_AS_OF'");
    expect(tenantCurrencySupportRuntimeMigration).toContain("'evaluationMode', 'CURRENT_WITH_REVALIDATION'");
    expect(tenantCurrencySupportRuntimeMigration).toContain("v_payload - 'evaluationMode'");
    expect(tenantCurrencySupportRuntimeMigration).not.toContain('v_revalidated_head_id');
    expect(tenantCurrencySupportRuntimeMigration).not.toContain('v_revalidated_count');
    expect(tenantCurrencySupportRuntimeMigration).not.toContain('pg_advisory_xact_lock_shared');
    expect(tenantCurrencySupportRuntimeMigration).toContain(`v_desired <> '["CZK"]'::jsonb`);
    expect(tenantCurrencySupportRuntimeMigration).toContain("'LAUNCH_CURRENCY_REJECTED'");
    expect(tenantCurrencySupportRuntimeMigration).toContain("'SCHEDULE_ACKNOWLEDGEMENT_REQUIRED'");
    expect(tenantCurrencySupportRuntimeMigration).toContain("'SCHEDULE_ACKNOWLEDGEMENT_STALE'");
    expect(tenantCurrencySupportRuntimeMigration).toContain("v_intent = 'SCHEDULE_REVISION'");
    expect(tenantCurrencySupportRuntimeMigration).toContain("'OVERLAPPING_SCHEDULE'");
    expect(tenantCurrencySupportRuntimeMigration).toContain('max(revision.generation)');
    expect(tenantCurrencySupportRuntimeMigration).toContain("'targetEffectivePeriod'");
    expect(tenantCurrencySupportRuntimeMigration).toContain("'presentedFuture'");
    expect(tenantCurrencySupportRuntimeMigration).toContain('public.digest');
    expect(tenantCurrencySupportRuntimeMigration).toContain(
      'REVOKE ALL ON TABLE pricing.currency_support_revisions FROM ontos_runtime',
    );
    expect(tenantCurrencySupportRuntimeMigration).not.toContain('INSERT INTO pricing.currency_support_revisions');
    expect(legacyAuthorityRetirementMigration).toContain('pricing_currency_support_legacy_scope_update');
    expect(legacyAuthorityRetirementMigration).toContain('USING (false) WITH CHECK (false)');
    expect(legacyHistoryFreezeMigration).toContain('pricing_currency_support_legacy_scope_insert');
    expect(legacyHistoryFreezeMigration).toContain('WITH CHECK (false)');
  });
});

describe('Pricing historical Action receipt attribution contract', () => {
  it('preserves nullable historical principals while rejecting new unattributed receipts', () => {
    for (const [table, constraintName] of [
      [contractualDiscountActionInvocationReceipts, 'pricing_contractual_discount_receipts_principal_ck'],
      [zeroFloorActionInvocationReceipts, 'pricing_zero_floor_action_receipts_principal_ck'],
    ] as const) {
      const config = getTableConfig(table);

      expect(config.columns.find(({ name }) => name === 'acting_principal_id')?.notNull).toBe(false);
      expect(config.checks.map(({ name }) => name)).toContain(constraintName);
    }
  });
});

describe('Pricing Price database contract', () => {
  it('owns stable Price roots and immutable versioned schedules', () => {
    expect(PRICING_TABLE_INVENTORY).toHaveLength(66);
    expect(new Set(PRICING_TABLE_INVENTORY).size).toBe(PRICING_TABLE_INVENTORY.length);
    expect(PRICING_TABLE_INVENTORY.toSorted()).toEqual(PRICING_TABLES.map(getTableName).toSorted());
    expect(
      [
        prices,
        priceCurrentRevisions,
        priceRevisions,
        priceScheduleAcknowledgements,
        priceScheduleEntries,
        priceScheduleHeads,
        priceScheduleRevisions,
        priceSourceAssertionDeliveries,
        priceSourceAssertions,
        priceInvocationReceipts,
      ].map(getTableName),
    ).toEqual([
      'prices',
      'price_current_revisions',
      'price_revisions',
      'price_schedule_acknowledgements',
      'price_schedule_entries',
      'price_schedule_heads',
      'price_schedule_revisions',
      'price_source_assertion_deliveries',
      'price_source_assertions',
      'price_invocation_receipts',
    ]);
    for (const table of [
      prices,
      priceCurrentRevisions,
      priceRevisions,
      priceScheduleAcknowledgements,
      priceScheduleEntries,
      priceScheduleHeads,
      priceScheduleRevisions,
      priceInvocationReceipts,
    ]) {
      const config = getTableConfig(table);
      expect(config.enableRLS, `${config.name} must enable RLS`).toBe(true);
      expect(config.columns.some(({ name, notNull }) => name === 'tenant_id' && notNull)).toBe(true);
      expect(config.columns.some(({ name, notNull }) => name === 'legal_entity_id' && notNull)).toBe(true);
    }
  });

  it('owns exact Price-candidate and Commercial Fee complete-set authority roots', () => {
    expect(
      [
        priceCandidateSetRoots,
        priceCandidateSetRevisions,
        priceCandidateSetHeads,
        feeSetRoots,
        feeSetRevisions,
        feeSetHeads,
      ].map(getTableName),
    ).toEqual([
      'price_candidate_set_roots',
      'price_candidate_set_revisions',
      'price_candidate_set_heads',
      'fee_set_roots',
      'fee_set_revisions',
      'fee_set_heads',
    ]);
    for (const table of [
      priceCandidateSetRoots,
      priceCandidateSetRevisions,
      priceCandidateSetHeads,
      feeSetRoots,
      feeSetRevisions,
      feeSetHeads,
    ]) {
      const config = getTableConfig(table);
      expect(config.enableRLS, `${config.name} must enable RLS`).toBe(true);
      expect(config.columns.some(({ name, notNull }) => name === 'tenant_id' && notNull)).toBe(true);
      expect(config.columns.some(({ name, notNull }) => name === 'legal_entity_id' && notNull)).toBe(true);
    }
    expect(priceFeeSetRuntimeMigration).toContain("'kind','VIRTUAL_EMPTY'");
    expect(priceFeeSetRuntimeMigration).toContain('v_root_count=0 AND v_price_count=0');
    expect(priceFeeSetRuntimeMigration).toContain('v_next_boundary IS NOT DISTINCT FROM v_actual_next_boundary');
    expect(priceFeeSetRuntimeMigration).toContain("v_authority->>'predicateRef'");
    expect(priceFeeSetRuntimeMigration).toContain("v_authority->>'verificationRef'");
    expect(priceFeeSetRuntimeMigration).toContain('PRICE_SOURCE_CHANGED');
    expect(priceFeeSetRuntimeMigration).not.toMatch(/order by[^;]*limit\s+1/iu);
    expect(priceFeeSetRuntimeMigration).not.toContain("'EUR'");
  });

  it('claims each Price/Fee Action invocation tenant-wide before recording its exact result', () => {
    const claim = getTableConfig(priceFeeActionInvocationClaims);
    const result = getTableConfig(priceFeeActionResultReceipts);

    expect(claim.name).toBe('price_fee_action_invocation_claims');
    expect(claim.primaryKeys.map(({ name }) => name)).toContain('pricing_price_fee_action_claims_pk');
    expect(claim.uniqueConstraints.map(({ name }) => name)).toContain('pricing_price_fee_action_claims_scope_uk');
    expect(claim.policies.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'pricing_price_fee_action_claims_scope_select',
        'pricing_price_fee_action_claims_scope_insert',
        'pricing_price_fee_action_claims_scope_update',
        'pricing_price_fee_action_claims_scope_delete',
      ]),
    );
    expect(result.foreignKeys.map((foreignKey) => foreignKey.getName())).toContain(
      'pricing_price_fee_action_results_claim_fk',
    );
    expect(priceTerminalConflictReceiptMigration).toContain("('CREATED', 'REUSED', 'CONFLICT')");
    expect(priceTerminalConflictReceiptMigration).toContain("('REVISED', 'UNCHANGED', 'CONFLICT')");
    expect(priceTerminalConflictReceiptRuntimeMigration).toContain(
      'CREATE FUNCTION pricing.execute_price_action_with_terminal_result_v1',
    );
    expect(priceTerminalConflictReceiptRuntimeMigration).toContain(
      "v_result ->> 'reason' IS DISTINCT FROM 'IDEMPOTENCY_CONFLICT'",
    );
    expect(priceTerminalConflictReceiptRuntimeMigration).toContain(
      'INSERT INTO pricing.price_fee_action_result_receipts',
    );
  });

  it('keeps #797 governed writes behind a FORCE-RLS-safe routine owner', () => {
    const runtimeGrantManifest = readFileSync(
      fileURLToPath(new URL('../../../../scripts/postgres/runtime-role-grants.mts', import.meta.url)),
      'utf-8',
    );
    const tableGrantBlock = runtimeGrantManifest.slice(
      runtimeGrantManifest.indexOf('export const PRICING_RUNTIME_TABLE_GRANTS'),
      runtimeGrantManifest.indexOf('export const PRICING_RUNTIME_ROUTINE_SIGNATURES'),
    );
    const tableGrants = [
      ...tableGrantBlock.matchAll(
        /\{\s*privileges:\s*\[(?<privileges>[^\]]+)\],\s*table:\s*'(?<table>[^']+)',?\s*\}/gu,
      ),
    ].map((match) => ({
      privileges: [...(match.groups?.['privileges'] ?? '').matchAll(/'(?<privilege>[^']+)'/gu)].map(
        (privilege) => privilege.groups?.['privilege'] ?? '',
      ),
      table: match.groups?.['table'] ?? '',
    }));
    const routineGrantBlock = runtimeGrantManifest.slice(
      runtimeGrantManifest.indexOf('export const PRICING_RUNTIME_ROUTINE_SIGNATURES'),
    );
    const governedTables = tableGrants
      .filter(({ privileges }) => privileges.every((privilege) => privilege === 'select'))
      .map(({ table }) => table);

    expect([...routineGrantBlock.matchAll(/^\s*'pricing\.[^']+',?$/gmu)]).toHaveLength(90);
    expect(tableGrants).toHaveLength(61);
    expect({
      delete: tableGrants.filter(({ privileges }) => privileges.some((privilege) => privilege === 'delete')).length,
      insert: tableGrants.filter(({ privileges }) => privileges.some((privilege) => privilege === 'insert')).length,
      select: tableGrants.filter(({ privileges }) => privileges.some((privilege) => privilege === 'select')).length,
      update: tableGrants.filter(({ privileges }) => privileges.some((privilege) => privilege === 'update')).length,
    }).toEqual({ delete: 1, insert: 34, select: 61, update: 5 });
    expect(governedTables).toEqual([
      'contractual_discount_action_invocation_receipts',
      'contractual_discount_revisions',
      'contractual_discount_schedule_acknowledgements',
      'contractual_discount_schedule_heads',
      'contractual_discount_set_heads',
      'contractual_discount_set_revisions',
      'contractual_discount_set_roots',
      'contractual_discounts',
      'currency_support_action_result_receipts',
      'fee_set_heads',
      'fee_set_revisions',
      'fee_set_roots',
      'price_candidate_set_heads',
      'price_candidate_set_revisions',
      'price_candidate_set_roots',
      'price_fee_action_invocation_claims',
      'price_fee_action_result_receipts',
      'quantity_tier_action_result_receipts',
      'zero_floor_action_invocation_receipts',
      'zero_floor_authorization_revisions',
      'zero_floor_authorization_schedule_heads',
      'zero_floor_authorizations',
      'zero_floor_governance_approvals',
      'zero_floor_schedule_acknowledgements',
      'zero_floor_set_heads',
      'zero_floor_set_revisions',
      'zero_floor_set_roots',
    ]);
    expect(priceFeeSetRuntimeMigration).toContain(
      'CREATE ROLE pricing_management_routine_writer\n      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
    );
    for (const migrationSql of [
      discountZeroFloorRuntimeMigration,
      priceFeeResultRuntimeMigration,
      quantityTierManagementRuntimeMigration,
      currencySupportResultRuntimeMigration,
    ]) {
      expect(migrationSql).toContain('FROM ontos_runtime;');
      expect(migrationSql).toContain('TO pricing_management_routine_writer;');
    }
    for (const migrationSql of [
      discountZeroFloorRuntimeMigration,
      priceFeeResultRuntimeMigration,
      quantityTierManagementRuntimeMigration,
      currencySupportResultRuntimeMigration,
    ]) {
      expect(migrationSql).toContain('OWNER TO pricing_management_routine_writer;');
    }
    expect(priceFeeSetRuntimeMigration).toContain('FROM ontos_runtime;');
    expect(priceFeeSetRuntimeMigration).toContain('TO pricing_management_routine_writer;');
    expect(priceFeeSetRuntimeMigration).not.toContain(
      'ALTER FUNCTION pricing.initialize_price_and_fee_set_authority_v1() OWNER TO pricing_management_routine_writer',
    );
    expect(zeroFloorRuntimeMigration).toContain(
      'ALTER FUNCTION pricing.manage_zero_floor_authorization_v1(uuid,uuid,jsonb) SECURITY DEFINER',
    );
    expect(discountZeroFloorRuntimeMigration).not.toContain(
      'GRANT EXECUTE ON FUNCTION pricing.advance_contractual_discount_set_v1(uuid,uuid,uuid,text) TO ontos_runtime',
    );
    expect(priceFeeResultRuntimeMigration).not.toContain(
      'GRANT EXECUTE ON FUNCTION pricing.execute_price_fee_action_with_result_v1(uuid,uuid,jsonb,text) TO ontos_runtime',
    );
  });

  it('stores immutable material proof receipts behind owner routines', () => {
    const receipt = getTableConfig(materialEvidenceProofReceipts);

    expect(receipt.enableRLS).toBe(true);
    expect(receipt.uniqueConstraints.map(({ name }) => name)).toContain('pricing_material_proof_receipt_identity_uk');
    expect(receipt.policies.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'pricing_material_proof_receipts_scope_select',
        'pricing_material_proof_receipts_scope_insert',
        'pricing_material_proof_receipts_scope_update',
        'pricing_material_proof_receipts_scope_delete',
      ]),
    );
  });

  it('stores every exact key dimension without Storefront, Cart, occurrence, principal, or requested Quantity identity', () => {
    const root = getTableConfig(prices);
    const columnNames = root.columns.map(({ name }) => name);
    expect(columnNames).toEqual(
      expect.arrayContaining([
        'catalog_selection',
        'legal_entity_id',
        'channel_id',
        'market_id',
        'currency_code',
        'unit_ref',
        'basis_quantity',
        'price_group_selector',
      ]),
    );
    for (const forbidden of [
      'storefront_id',
      'cart_id',
      'occurrence_id',
      'principal_id',
      'purchase_quantity',
      'operation_time',
      'source_record_id',
    ]) {
      expect(columnNames).not.toContain(forbidden);
    }
    const exactIdentity = root.uniqueConstraints.find(({ name }) => name === 'pricing_prices_exact_identity_uk');
    expect(exactIdentity?.columns.map(({ name }) => name)).toEqual([
      'tenant_id',
      'catalog_selection',
      'legal_entity_id',
      'channel_id',
      'market_id',
      'currency_code',
      'unit_ref',
      'basis_quantity',
      'price_group_selector',
    ]);
    expect(root.checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'pricing_prices_catalog_selection_ck',
        'pricing_prices_currency_ck',
        'pricing_prices_group_selector_ck',
        'pricing_prices_unit_basis_ck',
      ]),
    );
  });

  it('constrains non-negative pre-Tax immutable revisions and one schedule head per Price', () => {
    const revisions = getTableConfig(priceRevisions);
    expect(revisions.uniqueConstraints.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'pricing_price_revisions_scope_id_uk',
        'pricing_price_revisions_number_uk',
        'pricing_price_revisions_invocation_uk',
      ]),
    );
    expect(revisions.checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'pricing_price_revisions_amount_ck',
        'pricing_price_revisions_boundary_ck',
        'pricing_price_revisions_currency_ck',
      ]),
    );
    expect(getTableConfig(priceScheduleHeads).uniqueConstraints.map(({ name }) => name)).toContain(
      'pricing_price_schedule_heads_scope_price_uk',
    );
  });

  it('derives Current at an explicit instant from immutable half-open schedule snapshots', () => {
    expect(priceScheduleRuntimeMigration).toContain('EXCLUDE USING gist');
    expect(priceScheduleRuntimeMigration).toContain("tstzrange(effective_from, effective_to, '[)')");
    expect(priceScheduleRuntimeMigration).toContain('effective_from <= v_observed_at');
    expect(priceScheduleRuntimeMigration).toContain('v_observed_at < entry.effective_to');
    expect(priceScheduleRuntimeMigration).toContain('v_current_count > 1');
    expect(readPriceScheduleRoutine).not.toContain('ORDER BY entry.effective_from DESC LIMIT 1');
    expect(priceScheduleRuntimeMigration).toContain("'PRICE_SCHEDULE_GAP'");
    expect(priceScheduleRuntimeMigration).toContain("'PRICE_SCHEDULE_CONFLICT'");
  });

  it('preserves gaps and futures while binding schedule acknowledgement to the intended edit', () => {
    expect(priceScheduleRuntimeMigration).toContain("'sha256'");
    expect(priceScheduleRuntimeMigration).toContain("'intendedEffectivePeriod'");
    expect(priceScheduleRuntimeMigration).toContain("'intendedMonetaryAmount'");
    expect(priceScheduleRuntimeMigration).toContain("'presentedFuture'");
    expect(revisePriceRoutine).toContain("'SCHEDULE_ACKNOWLEDGEMENT_STALE'");
    expect(revisePriceRoutine).toContain('entry.effective_to');
    expect(revisePriceRoutine).toContain('v_target_to');
    expect(revisePriceRoutine).toContain('INSERT INTO pricing.price_schedule_acknowledgements');
    expect(revisePriceRoutine).toContain('ledger.acknowledgement = v_ack');
    expect(revisePriceRoutine).toContain('ledger.issued_by_principal_id = v_acting_principal_id');
    expect(revisePriceRoutine).toContain(
      "v_new_from := (v_ack #>> '{intendedEffectivePeriod,effectiveFrom}')::timestamptz",
    );
    expect(revisePriceRoutine).toContain("v_intent = 'VALUE_ONLY_CURRENT' AND v_new_from < v_target_from");
    expect(revisePriceRoutine).toContain("v_intent = 'RETIRE_CURRENT' AND v_new_from <= v_target_from");
    expect(revisePriceRoutine).not.toContain('IF v_new_from <= v_target_from');
    expect(revisePriceRoutine).toContain("v_intent IN ('VALUE_ONLY_CURRENT', 'SCHEDULE_REVISION')");
    expect(revisePriceRoutine).toContain('v_target_from < v_new_from');
    expect(revisePriceRoutine).toContain('v_target_from, v_new_from');
    expect(revisePriceRoutine).toContain("CASE WHEN v_intent = 'RETIRE_CURRENT' THEN v_new_from ELSE v_new_to END");
    expect(revisePriceRoutine.indexOf('IF v_has_ack THEN')).toBeLessThan(
      revisePriceRoutine.indexOf("IF v_intent = 'SCHEDULE_REVISION' THEN"),
    );
    expect(priceScheduleStorageMigration).toContain('"issued_by_principal_id" uuid NOT NULL');
    expect(priceScheduleRuntimeMigration).toContain(
      'ALTER TABLE pricing.price_schedule_acknowledgements FORCE ROW LEVEL SECURITY',
    );
  });

  it('retains the #755 Current table as an internal synchronized compatibility projection', () => {
    expect(PRICING_TABLE_INVENTORY).toContain('price_current_revisions');
    expect(getTableName(priceCurrentRevisions)).toBe('price_current_revisions');
    expect(priceScheduleRuntimeMigration).not.toContain('DROP TABLE pricing.price_current_revisions');
    expect(priceScheduleRuntimeMigration).toContain('CREATE POLICY pricing_price_current_projection_writer');
    expect(priceScheduleRuntimeMigration).toContain('CREATE FUNCTION pricing.refresh_price_current_projection_v1()');
    expect(priceScheduleRuntimeMigration).toContain(
      'ALTER FUNCTION pricing.refresh_price_current_projection_v1() OWNER TO pricing_schedule_projection_writer',
    );
    expect(priceScheduleRuntimeMigration).toContain(
      'REVOKE ALL ON FUNCTION pricing.refresh_price_current_projection_v1() FROM PUBLIC, ontos_runtime',
    );
    expect(priceScheduleRuntimeMigration).toContain('CREATE TRIGGER pricing_price_schedule_head_refresh_current');
    expect(priceScheduleRuntimeMigration).not.toContain(
      'GRANT SELECT ON pricing.price_current_revisions TO ontos_runtime',
    );
    expect(priceScheduleRuntimeMigration).toContain(
      'REVOKE ALL ON FUNCTION pricing.scheduled_price_revision_json_v1(uuid, uuid, uuid, uuid, timestamptz, timestamptz)',
    );
    expect(priceScheduleRuntimeMigration).toContain(
      'REVOKE ALL ON FUNCTION pricing.price_schedule_acknowledgement_v1(',
    );
  });

  it('publishes four forced-RLS schedule tables with exact append-only and overlap guards', () => {
    for (const table of [
      'price_schedule_acknowledgements',
      'price_schedule_entries',
      'price_schedule_heads',
      'price_schedule_revisions',
    ]) {
      expect(priceScheduleStorageMigration).toContain(`CREATE TABLE "pricing"."${table}"`);
      expect(priceScheduleRuntimeMigration).toContain(`ALTER TABLE pricing.${table} FORCE ROW LEVEL SECURITY`);
    }
    for (const prefix of [
      'pricing_price_schedule_acknowledgements_scope',
      'pricing_price_schedule_entries_scope',
      'pricing_price_schedule_revisions_scope',
    ]) {
      expect(priceScheduleStorageMigration).toContain(`CREATE POLICY "${prefix}_update"`);
      expect(priceScheduleStorageMigration).toContain(`CREATE POLICY "${prefix}_delete"`);
    }
    expect(priceScheduleRuntimeMigration).toContain('pricing_price_schedule_entries_no_overlap');
    expect(priceScheduleRuntimeMigration).toContain("tstzrange(effective_from, effective_to, '[)')");
  });

  it('temporarily relaxes backfill RLS and restores enabled forced RLS before publishing routines', () => {
    const backfillStart = priceScheduleRuntimeMigration.indexOf('DO $backfill$');
    const backfillEnd = priceScheduleRuntimeMigration.indexOf('$backfill$;', backfillStart);
    const firstRoutine = priceScheduleRuntimeMigration.indexOf(
      'CREATE FUNCTION pricing.refresh_price_current_projection_v1',
    );
    expect(backfillStart).toBeGreaterThan(-1);
    expect(backfillEnd).toBeGreaterThan(backfillStart);
    for (const table of [
      'price_current_revisions',
      'price_revisions',
      'price_schedule_acknowledgements',
      'price_schedule_entries',
      'price_schedule_heads',
      'price_schedule_revisions',
    ]) {
      const noForce = priceScheduleRuntimeMigration.indexOf(`ALTER TABLE pricing.${table} NO FORCE ROW LEVEL SECURITY`);
      const disable = priceScheduleRuntimeMigration.indexOf(`ALTER TABLE pricing.${table} DISABLE ROW LEVEL SECURITY`);
      const enable = priceScheduleRuntimeMigration.indexOf(`ALTER TABLE pricing.${table} ENABLE ROW LEVEL SECURITY`);
      const force = priceScheduleRuntimeMigration.indexOf(
        `ALTER TABLE pricing.${table} FORCE ROW LEVEL SECURITY`,
        enable,
      );
      expect(noForce).toBeGreaterThan(-1);
      expect(noForce).toBeLessThan(backfillStart);
      expect(disable).toBeGreaterThan(noForce);
      expect(disable).toBeLessThan(backfillStart);
      expect(enable).toBeGreaterThan(backfillEnd);
      expect(force).toBeGreaterThan(enable);
      expect(force).toBeLessThan(firstRoutine);
    }
  });

  it('binds expected Current to every branded PriceRef field before mutation', () => {
    for (const field of ['moduleId', 'resourceId', 'resourceType', 'tenantId']) {
      expect(revisePriceRoutine).toContain(`{expectedCurrent,priceRef,${field}}`);
    }
    expect(revisePriceRoutine.indexOf('{expectedCurrent,priceRef,moduleId}')).toBeLessThan(
      revisePriceRoutine.indexOf('INSERT INTO pricing.price_revisions'),
    );
  });

  it('provisions the runtime role with the exact Pricing table and routine grant matrix', () => {
    for (const grant of [
      'GRANT SELECT, INSERT, UPDATE ON pricing.currency_support_revisions TO ontos_runtime',
      'GRANT SELECT, INSERT ON pricing.price_invocation_receipts TO ontos_runtime',
      'GRANT SELECT, INSERT ON pricing.price_revisions TO ontos_runtime',
      'GRANT SELECT, INSERT ON pricing.price_schedule_acknowledgements TO ontos_runtime',
      'GRANT SELECT, INSERT ON pricing.price_schedule_entries TO ontos_runtime',
      'GRANT SELECT, INSERT, UPDATE ON pricing.price_schedule_heads TO ontos_runtime',
      'GRANT SELECT, INSERT ON pricing.price_schedule_revisions TO ontos_runtime',
      'GRANT SELECT, INSERT ON pricing.prices TO ontos_runtime',
    ]) {
      expect(priceScheduleRuntimeMigration).toContain(grant);
    }
    for (const signature of [
      'pricing.define_price_v1(uuid, uuid, jsonb)',
      'pricing.read_current_price_definition_v1(uuid, uuid, uuid)',
      'pricing.read_price_schedule_v1(uuid, uuid, jsonb)',
      'pricing.revise_price_v1(uuid, uuid, jsonb)',
    ]) {
      expect(priceScheduleRuntimeMigration).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
      expect(priceScheduleRuntimeMigration).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO ontos_runtime`);
    }
    expect(priceScheduleRuntimeMigration).not.toContain(
      'GRANT SELECT ON pricing.price_current_revisions TO ontos_runtime',
    );
    expect(priceScheduleRuntimeMigration).not.toContain(
      'GRANT SELECT, INSERT ON pricing.price_current_revisions TO ontos_runtime',
    );
    expect(priceScheduleRuntimeMigration).not.toContain('GRANT DELETE ON pricing.');
  });

  it('publishes generated storage plus governed atomic define/current-read routines', () => {
    for (const table of ['prices', 'price_revisions', 'price_current_revisions']) {
      expect(priceFoundationMigration).toContain(`CREATE TABLE "pricing"."${table}"`);
      expect(priceRoutinesMigration).toContain(`ALTER TABLE "pricing"."${table}" FORCE ROW LEVEL SECURITY`);
    }
    expect(priceFoundationMigration).toContain('pricing_prices_exact_identity_uk');
    expect(priceFoundationMigration).not.toContain('storefront_id');
    expect(priceRoutinesMigration).toContain('define_price_v1');
    expect(priceRoutinesMigration).toContain('read_current_price_definition_v1');
    expect(priceRoutinesMigration).toContain('pg_advisory_xact_lock');
    expect(priceRoutinesMigration).toContain('PRICE_DEFINITION_NOT_FOUND');
    expect(priceRoutinesMigration).toContain('MULTIPLE_CURRENT_REVISIONS');
    expect(priceRoutinesMigration).toContain('PRICE_DEFINITION_CURRENT');
    expect(
      getTableConfig(prices).policies.find(({ name }) => name === 'pricing_prices_scope_update')?.using,
    ).toBeDefined();
    expect(
      getTableConfig(priceRevisions).policies.find(({ name }) => name === 'pricing_price_revisions_scope_delete')
        ?.using,
    ).toBeDefined();
    expect(priceRoutinesMigration).toContain('REVOKE ALL ON FUNCTION');
    expect(priceRoutinesMigration).toContain('GRANT EXECUTE ON FUNCTION');
    expect(priceAppendOnlyPolicyMigration).toContain('pricing_prices_scope_update');
    expect(priceAppendOnlyPolicyMigration).toContain('pricing_price_revisions_scope_delete');
    expect(priceAppendOnlyPolicyMigration).toContain('USING (false)');
  });

  it('rejects non-representable decimals before casting, locking, or exact-key lookup', () => {
    expect(priceRoutinesMigration).toContain(String.raw`v_amount_text !~ '^(0|[1-9][0-9]{0,28})(\.[0-9]{1,9})?$'`);
    expect(priceRoutinesMigration).toContain(
      String.raw`v_basis_quantity_text !~ '^(0|[1-9][0-9]{0,28})(\.[0-9]{1,9})?$'`,
    );
    const validation = priceRoutinesMigration.indexOf('v_amount_text !~');
    const cast = priceRoutinesMigration.indexOf('v_amount := v_amount_text::numeric(38,9)');
    const receiptLookup = priceRoutinesMigration.indexOf('FROM pricing.price_invocation_receipts AS receipt');
    const lock = priceRoutinesMigration.indexOf('pg_advisory_xact_lock');
    const exactKeyLookup = priceRoutinesMigration.indexOf('SELECT price.price_id INTO v_existing_price_id');
    expect(validation).toBeGreaterThan(-1);
    expect(validation).toBeLessThan(cast);
    expect(cast).toBeLessThan(receiptLookup);
    expect(receiptLookup).toBeLessThan(lock);
    expect(lock).toBeLessThan(exactKeyLookup);
  });

  it('binds an action invocation replay to every immutable command field', () => {
    for (const comparison of [
      'v_existing_price_id IS DISTINCT FROM v_requested_price_id',
      'v_current_amount IS DISTINCT FROM v_amount',
      'v_current_currency_code IS DISTINCT FROM v_currency_code',
      'v_current_effective_from IS DISTINCT FROM v_effective_from',
      'v_current_acting_principal_id IS DISTINCT FROM v_acting_principal_id',
      'v_current_reason IS DISTINCT FROM v_reason',
      "v_current_monetary_boundary IS DISTINCT FROM 'PRE_TAX'",
      'v_current_legal_entity_id IS DISTINCT FROM p_legal_entity_id',
      'v_current_catalog_selection IS DISTINCT FROM v_catalog_selection',
      'v_current_channel_id IS DISTINCT FROM v_channel_id',
      'v_current_market_id IS DISTINCT FROM v_market_id',
      'v_current_identity_currency_code IS DISTINCT FROM v_currency_code',
      'v_current_unit_ref IS DISTINCT FROM v_unit_ref',
      'v_current_basis_quantity IS DISTINCT FROM v_basis_quantity',
      'v_current_group_selector IS DISTINCT FROM v_group_selector',
    ]) {
      expect(priceRoutinesMigration).toContain(comparison);
    }
    expect(priceRoutinesMigration).toContain("'IDEMPOTENCY_CONFLICT'");
    expect(priceRoutinesMigration.indexOf('FROM pricing.price_invocation_receipts AS receipt')).toBeLessThan(
      priceRoutinesMigration.indexOf('PERFORM pg_advisory_xact_lock(v_lock_c)'),
    );
    expect(priceRoutinesMigration).toContain('INSERT INTO pricing.price_invocation_receipts');
    expect(priceRoutinesMigration).toContain('requested_price_id, resolved_price_id, resolved_price_revision_id');
  });

  it('stores accepted invocation receipts as scoped immutable evidence', () => {
    const receipt = getTableConfig(priceInvocationReceipts);
    expect(receipt.uniqueConstraints.map(({ name }) => name)).toContain('pricing_price_invocation_receipts_action_uk');
    expect(receipt.foreignKeys).toHaveLength(1);
    expect(receipt.policies.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'pricing_price_invocation_receipts_scope_select',
        'pricing_price_invocation_receipts_scope_insert',
        'pricing_price_invocation_receipts_scope_update',
        'pricing_price_invocation_receipts_scope_delete',
      ]),
    );
    expect(priceInvocationReceiptMigration).toContain('CREATE TABLE "pricing"."price_invocation_receipts"');
    expect(priceInvocationReceiptMigration).toContain('pricing_price_invocation_receipts_revision_fk');
    expect(priceInvocationReceiptMigration).toContain('USING (false)');
    expect(priceInvocationReceiptForceRlsMigration).toContain(
      'ALTER TABLE "pricing"."price_invocation_receipts" FORCE ROW LEVEL SECURITY',
    );
  });

  it('stores one immutable scoped source fact separately from every delivery', () => {
    const assertion = getTableConfig(priceSourceAssertions);
    const delivery = getTableConfig(priceSourceAssertionDeliveries);

    expect(assertion.enableRLS).toBe(true);
    expect(delivery.enableRLS).toBe(true);
    expect(assertion.uniqueConstraints.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'pricing_price_source_assertions_fingerprint_uk',
        'pricing_price_source_assertions_invocation_uk',
        'pricing_price_source_assertions_lineage_id_uk',
        'pricing_price_source_assertions_owner_fact_uk',
        'pricing_price_source_assertions_scope_id_uk',
      ]),
    );
    expect(
      assertion.uniqueConstraints
        .find(({ name }) => name === 'pricing_price_source_assertions_scope_id_uk')
        ?.columns.map((column) => column.name),
    ).toEqual(['tenant_id', 'legal_entity_id', 'price_id', 'source_assertion_id']);
    expect(
      assertion.uniqueConstraints
        .find(({ name }) => name === 'pricing_price_source_assertions_lineage_id_uk')
        ?.columns.map((column) => column.name),
    ).toEqual(['tenant_id', 'legal_entity_id', 'source_assertion_id']);
    expect(assertion.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
      expect.arrayContaining([
        'pricing_price_source_assertions_corrected_fk',
        'pricing_price_source_assertions_revision_fk',
        'pricing_price_source_assertions_superseded_fk',
      ]),
    );
    expect(assertion.checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'pricing_price_source_assertions_authority_mapping_ck',
        'pricing_price_source_assertions_fingerprint_ck',
        'pricing_price_source_assertions_lineage_ck',
        'pricing_price_source_assertions_no_self_lineage_ck',
        'pricing_price_source_assertions_normalization_ck',
        'pricing_price_source_assertions_original_ck',
        'pricing_price_source_assertions_source_identity_ck',
      ]),
    );
    expect(delivery.uniqueConstraints.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'pricing_price_source_deliveries_invocation_uk',
        'pricing_price_source_deliveries_scope_id_uk',
      ]),
    );
    expect(delivery.foreignKeys.map((foreignKey) => foreignKey.getName())).toContain(
      'pricing_price_source_deliveries_assertion_fk',
    );
    const deliveryAssertionForeignKey = delivery.foreignKeys.find(
      (foreignKey) => foreignKey.getName() === 'pricing_price_source_deliveries_assertion_fk',
    );
    expect(deliveryAssertionForeignKey?.reference().columns.map((column) => column.name)).toEqual([
      'tenant_id',
      'legal_entity_id',
      'price_id',
      'source_assertion_id',
    ]);
    expect(deliveryAssertionForeignKey?.reference().foreignColumns.map((column) => column.name)).toEqual([
      'tenant_id',
      'legal_entity_id',
      'price_id',
      'source_assertion_id',
    ]);

    for (const prefix of ['pricing_price_source_assertions_scope', 'pricing_price_source_deliveries_scope']) {
      const table = prefix.includes('deliveries') ? delivery : assertion;
      expect(table.policies.map(({ name }) => name)).toEqual(
        expect.arrayContaining([`${prefix}_select`, `${prefix}_insert`, `${prefix}_update`, `${prefix}_delete`]),
      );
      expect(priceSourceStorageMigration).toContain(`CREATE POLICY "${prefix}_update"`);
      expect(priceSourceStorageMigration).toContain(`CREATE POLICY "${prefix}_delete"`);
    }
    expect(priceSourceStorageMigration).toContain('USING (false) WITH CHECK (false)');
    expect(priceSourceStorageMigration).toContain('USING (false)');
    expect(priceSourceStorageMigration).toContain('GRANT SELECT, INSERT ON TABLE pricing.price_source_assertions,');
    expect(priceSourceStorageMigration).not.toContain('GRANT UPDATE');
    expect(priceSourceStorageMigration).not.toContain('GRANT DELETE');
  });

  it('backfills every historical Price Revision with qualified legacy evidence before restoring forced RLS', () => {
    const backfillStart = priceSourceRuntimeMigration.indexOf('DO $backfill$');
    const backfillEnd = priceSourceRuntimeMigration.indexOf('$backfill$;', backfillStart);
    const firstRoutine = priceSourceRuntimeMigration.indexOf('CREATE FUNCTION pricing.price_source_provenance_json_v1');

    expect(backfillStart).toBeGreaterThan(-1);
    expect(backfillEnd).toBeGreaterThan(backfillStart);
    expect(priceSourceRuntimeMigration).toContain('SELECT count(*) INTO v_source_count FROM pricing.price_revisions');
    expect(priceSourceRuntimeMigration).toContain('v_revision_count <> v_source_count');
    expect(priceSourceRuntimeMigration).toContain('v_delivery_count <> v_source_count');
    expect(priceSourceRuntimeMigration).toContain("'legacy:pricing-action-runtime-v1'");
    expect(priceSourceRuntimeMigration).toContain("'legacy:price-revision:' || mapping.price_revision_id::text");
    expect(priceSourceRuntimeMigration).toContain("'legacy:unverified:not-asserted'");
    expect(priceSourceRuntimeMigration).toContain("'legacy:pricing-direct-write'");
    expect(priceSourceRuntimeMigration).toContain("'legacyQualified', true");
    for (const table of ['prices', 'price_revisions', 'price_source_assertions', 'price_source_assertion_deliveries']) {
      const disable = priceSourceRuntimeMigration.indexOf(`ALTER TABLE pricing.${table} DISABLE ROW LEVEL SECURITY`);
      const enable = priceSourceRuntimeMigration.indexOf(`ALTER TABLE pricing.${table} ENABLE ROW LEVEL SECURITY`);
      const force = priceSourceRuntimeMigration.indexOf(
        `ALTER TABLE pricing.${table} FORCE ROW LEVEL SECURITY`,
        enable,
      );
      expect(disable).toBeGreaterThan(-1);
      expect(disable).toBeLessThan(backfillStart);
      expect(enable).toBeGreaterThan(backfillEnd);
      expect(force).toBeGreaterThan(enable);
      expect(force).toBeLessThan(firstRoutine);
    }
  });

  it('publishes exact revision provenance routines without Storefront identity, FX, or currency activation', () => {
    for (const signature of [
      'pricing.define_price_v2(uuid, uuid, jsonb)',
      'pricing.revise_price_v2(uuid, uuid, jsonb)',
      'pricing.price_source_provenance_json_v1(uuid, uuid, uuid, uuid)',
    ]) {
      expect(priceSourceRuntimeMigration).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
      expect(priceSourceRuntimeMigration).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO ontos_runtime`);
    }
    for (const helper of [
      'pricing.bind_price_source_provenance_v1(uuid, uuid, uuid, uuid, jsonb)',
      'pricing.bind_price_retirement_provenance_v1(uuid, uuid, uuid, uuid, jsonb)',
    ]) {
      expect(priceSourceRuntimeMigration).toContain(`REVOKE ALL ON FUNCTION ${helper}`);
    }
    expect(priceSourceRuntimeMigration).toContain("p_input #> '{sourceEvidence,sourceAssertion}'");
    expect(priceSourceRuntimeMigration).toContain("p_input ->> 'requestCorrelationId'");
    expect(priceSourceRuntimeMigration).toContain('v_owner_business_at IS DISTINCT FROM v_canonical.effective_from');
    expect(priceSourceRuntimeMigration).toContain('provenance.price_revision_id = p_price_revision_id');
    expect(priceSourceRuntimeMigration).toContain("'SOURCE_FACT_CONFLICT'");
    expect(priceSourceRuntimeMigration).toContain("'SOURCE_LINEAGE_INVALID'");
    expect(priceSourceRuntimeMigration).toContain("'SOURCE_PROVENANCE_INVALID'");
    expect(priceSourceRuntimeMigration).toContain("v_assertion ? 'storefrontId'");
    expect(priceSourceStorageMigration).not.toContain('storefront_id');
    expect(priceSourceRuntimeMigration).not.toMatch(/exchange[_ ]?rate|currency[_ ]?conversion|fx[_ ]?rate/iu);
    expect(priceSourceRuntimeMigration).not.toContain("'EUR'");
    expect(priceSourceRuntimeMigration).not.toContain('currency_support_value_revisions');
  });
});

describe('Pricing Quantity Tier database contract', () => {
  it('owns stable Price-qualified Tier identities and immutable versioned schedules', () => {
    expect(
      [
        quantityTierRevisions,
        quantityTierSetHeads,
        quantityTierSetRevisions,
        quantityTierSetRoots,
        quantityTierScheduleAcknowledgements,
        quantityTierScheduleEntries,
        quantityTierScheduleHeads,
        quantityTierScheduleRevisions,
        quantityTiers,
      ].map(getTableName),
    ).toEqual([
      'quantity_tier_revisions',
      'quantity_tier_set_heads',
      'quantity_tier_set_revisions',
      'quantity_tier_set_roots',
      'quantity_tier_schedule_acknowledgements',
      'quantity_tier_schedule_entries',
      'quantity_tier_schedule_heads',
      'quantity_tier_schedule_revisions',
      'quantity_tiers',
    ]);
    for (const table of [
      quantityTierRevisions,
      quantityTierSetHeads,
      quantityTierSetRevisions,
      quantityTierSetRoots,
      quantityTierScheduleAcknowledgements,
      quantityTierScheduleEntries,
      quantityTierScheduleHeads,
      quantityTierScheduleRevisions,
      quantityTiers,
    ]) {
      const config = getTableConfig(table);
      expect(config.enableRLS, `${config.name} must enable RLS`).toBe(true);
      expect(config.columns.some(({ name, notNull }) => name === 'tenant_id' && notNull)).toBe(true);
      expect(config.columns.some(({ name, notNull }) => name === 'legal_entity_id' && notNull)).toBe(true);
    }
  });

  it('enforces exact Price basis/currency ownership, positive thresholds, and zero-valid immutable values', () => {
    const tier = getTableConfig(quantityTiers);
    const revision = getTableConfig(quantityTierRevisions);
    expect(tier.uniqueConstraints.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['pricing_quantity_tiers_identity_uk', 'pricing_quantity_tiers_scope_currency_uk']),
    );
    expect(tier.foreignKeys.map((foreignKey) => foreignKey.getName())).toContain(
      'pricing_quantity_tiers_price_basis_fk',
    );
    expect(tier.checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'pricing_quantity_tiers_catalog_basis_ck',
        'pricing_quantity_tiers_price_basis_quantity_ck',
        'pricing_quantity_tiers_threshold_ck',
      ]),
    );
    expect(revision.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
      expect.arrayContaining([
        'pricing_quantity_tier_revisions_corrected_fk',
        'pricing_quantity_tier_revisions_currency_fk',
        'pricing_quantity_tier_revisions_previous_fk',
        'pricing_quantity_tier_revisions_tier_fk',
      ]),
    );
    expect(quantityTierStorageMigration).toContain('pricing_quantity_tier_revisions_amount_ck');
    expect(quantityTierStorageMigration).toContain('CHECK ("resulting_amount" >= 0)');
  });

  it('uses one CAS head, half-open non-overlap, and exact future acknowledgement', () => {
    expect(quantityTierRuntimeMigration).toContain('pricing_quantity_tier_schedule_entries_no_overlap');
    expect(quantityTierRuntimeMigration).toContain("tstzrange(effective_from, effective_to, '[)')");
    expect(quantityTierRuntimeMigration).toContain('FOR UPDATE');
    expect(quantityTierRuntimeMigration).toContain('GET DIAGNOSTICS v_updated_count = ROW_COUNT');
    expect(quantityTierRuntimeMigration).toContain("'presentedFuture', v_future");
    expect(quantityTierRuntimeMigration).toContain("'targetEffectivePeriod'");
    expect(quantityTierRuntimeMigration).toContain("'intendedEffectivePeriod'");
    expect(quantityTierRuntimeMigration).toContain("'ACKNOWLEDGEMENT_STALE'");
    expect(quantityTierRuntimeMigration).toContain('entry.effective_from, entry.effective_to');
    expect(quantityTierRuntimeMigration).toContain("CASE WHEN v_intent = 'VALUE_ONLY_CURRENT'");
    expect(quantityTierRuntimeMigration).toContain('schedule_revision = v_schedule_revision');
    expect(quantityTierRuntimeMigration).toContain("price.catalog_selection #> '{packageOption,optionRef}'");
    expect(quantityTierRuntimeMigration).toContain("price.catalog_selection -> 'variantRef'");
    expect(quantityTierRuntimeMigration).toContain(
      "v_price.catalog_target_ref IS DISTINCT FROM (v_catalog_basis -> 'targetRef')",
    );
  });

  it('owns one monotonic complete-set authority per exact Price', () => {
    expect(quantityTierSetStorageMigration).toContain('pricing_quantity_tier_set_roots_price_uk');
    expect(quantityTierSetStorageMigration).toContain('pricing_quantity_tier_set_revisions_generation_uk');
    expect(quantityTierSetStorageMigration).toContain('pricing_quantity_tier_set_revisions_previous_fk');
    expect(quantityTierSetRuntimeMigration).toContain('pricing_prices_quantity_tier_set_authority_v1');
    expect(quantityTierSetRuntimeMigration).toContain('pricing_quantity_tiers_set_generation_v1');
    expect(quantityTierSetRuntimeMigration).toContain('pricing_quantity_tier_schedule_heads_set_generation_v1');
    expect(quantityTierSetRuntimeMigration).toContain('pricing_quantity_tier_set_heads_monotonic_v1');
    expect(quantityTierSetRuntimeMigration).toContain('read_current_quantity_tier_set_v1');
    expect(quantityTierSetRuntimeMigration).toContain('verify_quantity_tier_set_generation_v1');
    expect(quantityTierSetRuntimeMigration).toContain("'currentTiers', v_current_tiers");
    expect(quantityTierSetRuntimeMigration).toContain("'QUANTITY_TIER_SET_AUTHORITY_UNAVAILABLE'");
    expect(quantityTierSetRuntimeMigration).toContain("'QUANTITY_TIER_SET_PRICE_ABSENT'");
    expect(quantityTierSetRuntimeMigration).toContain('v_verified_at timestamptz := statement_timestamp()');
    expect(quantityTierSetRuntimeMigration).toContain("'THROUGH_NOT_YET_OBSERVABLE'");
    expect(quantityTierSetRuntimeMigration).toContain("'VERIFICATION_REFERENCE_MISMATCH'");
    expect(quantityTierProofMigration).toContain('receipt.verification_ref = v_verification_ref');
    expect(quantityTierProofMigration).toContain('material_evidence_proof_receipts');
    expect(quantityTierProofMigration).not.toContain('string_to_array(v_verification_ref');
    expect(quantityTierProofMigration).not.toMatch(
      /storefront|exchange[_ ]?rate|currency[_ ]?conversion|fx[_ ]?rate/iu,
    );
    expect(quantityTierSetRuntimeMigration).not.toContain("'EUR'");
  });

  it('publishes owner-local routines without Storefront, FX, or another-currency activation', () => {
    for (const routine of [
      'define_quantity_tier_v1',
      'read_current_quantity_tier_v1',
      'read_quantity_tier_schedule_v1',
      'revise_quantity_tier_v1',
    ]) {
      expect(quantityTierRuntimeMigration).toContain(`CREATE OR REPLACE FUNCTION pricing.${routine}`);
      expect(quantityTierRuntimeMigration).toContain(
        `GRANT EXECUTE ON FUNCTION pricing.${routine}(uuid, uuid, jsonb) TO ontos_runtime`,
      );
    }
    expect(quantityTierRuntimeMigration).not.toMatch(
      /storefront|exchange[_ ]?rate|currency[_ ]?conversion|fx[_ ]?rate/iu,
    );
    expect(quantityTierRuntimeMigration).not.toContain("'EUR'");
  });
});
