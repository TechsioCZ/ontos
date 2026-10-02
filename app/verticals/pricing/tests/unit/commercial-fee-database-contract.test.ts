// @effect-diagnostics nodeBuiltinImport:off -- Migration contract reads checked-in Pricing SQL; expires: 2027-03-31.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'effect-rstest';

import {
  feeActionInvocationReceipts,
  feeRevisions,
  fees,
  feeScheduleAcknowledgements,
  feeScheduleEntries,
  feeScheduleHeads,
  feeScheduleRevisions,
  PRICING_TABLE_INVENTORY,
} from '../../src/database/schema.ts';

const storageMigration = readFileSync(
  fileURLToPath(new URL('../../drizzle/20260927210436_pricing_commercial_fees_v1/migration.sql', import.meta.url)),
  'utf-8',
);
const runtimeMigration = readFileSync(
  fileURLToPath(
    new URL('../../drizzle/20260927210440_pricing_commercial_fee_runtime_v1/migration.sql', import.meta.url),
  ),
  'utf-8',
);
const identityV2Migration = readFileSync(
  fileURLToPath(
    new URL('../../drizzle/20260927212143_pricing_commercial_fee_identity_v2/migration.sql', import.meta.url),
  ),
  'utf-8',
);
const replayV2Migration = readFileSync(
  fileURLToPath(
    new URL('../../drizzle/20260927212707_pricing_commercial_fee_replay_v2/migration.sql', import.meta.url),
  ),
  'utf-8',
);
const noOpReplayV2Migration = readFileSync(
  fileURLToPath(
    new URL('../../drizzle/20260927215722_pricing_commercial_fee_noop_replay_v2/migration.sql', import.meta.url),
  ),
  'utf-8',
);
const managementV3Migration = readFileSync(
  fileURLToPath(
    new URL('../../drizzle/20260927221600_pricing_commercial_fee_management_v3/migration.sql', import.meta.url),
  ),
  'utf-8',
);

const feeTables = [
  fees,
  feeActionInvocationReceipts,
  feeRevisions,
  feeScheduleRevisions,
  feeScheduleEntries,
  feeScheduleAcknowledgements,
  feeScheduleHeads,
] as const;

describe('Pricing Commercial Fee database contract', () => {
  it('owns append-only Fee history, exact no-op receipts, and one mutable CAS head', () => {
    expect(feeTables.map((table) => getTableName(table))).toEqual([
      'fees',
      'fee_action_invocation_receipts',
      'fee_revisions',
      'fee_schedule_revisions',
      'fee_schedule_entries',
      'fee_schedule_acknowledgements',
      'fee_schedule_heads',
    ]);
    expect(PRICING_TABLE_INVENTORY).toEqual(expect.arrayContaining(feeTables.map((table) => getTableName(table))));
    for (const table of feeTables) {
      const config = getTableConfig(table);
      expect(config.enableRLS, `${config.name} must enable RLS`).toBe(true);
      expect(config.columns.some(({ name, notNull }) => name === 'tenant_id' && notNull)).toBe(true);
      expect(config.columns.some(({ name, notNull }) => name === 'legal_entity_id' && notNull)).toBe(true);
      expect(config.policies).toHaveLength(4);
    }
  });

  it('keys one exact Variant Fee by family, SLE, Channel, Market, basis, Unit, and currency', () => {
    const config = getTableConfig(fees);
    const identity = config.uniqueConstraints.find(({ name }) => name === 'pricing_fees_identity_uk');

    expect(identity?.columns.map(({ name }) => name)).toEqual([
      'tenant_id',
      'legal_entity_id',
      'family',
      'variant_ref',
      'channel_id',
      'market_id',
      'calculation_basis',
      'basis_quantity',
      'unit_ref',
      'currency_code',
      'monetary_boundary',
    ]);
    expect(identity?.nullsNotDistinct).toBe(true);
    expect(config.columns.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(['storefront_id', 'shipping_method_id', 'payment_method_id', 'tax_id']),
    );
    expect(config.checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'pricing_fees_basis_ck',
        'pricing_fees_boundary_ck',
        'pricing_fees_currency_ck',
        'pricing_fees_family_ck',
        'pricing_fees_variant_ck',
      ]),
    );
    expect(storageMigration).toContain('pricing_fees_identity_uk" UNIQUE NULLS NOT DISTINCT');
    expect(identityV2Migration).toContain(
      'UNIQUE NULLS NOT DISTINCT("tenant_id","legal_entity_id","family","variant_ref"',
    );
    expect(identityV2Migration).toContain("channel_id\" in ('B2C', 'B2B')");
    expect(identityV2Migration).toContain("market_id\" <> '*'");
    expect(identityV2Migration).toContain("->>'resourceId')::uuid");
    expect(replayV2Migration).not.toMatch(/fee\.product_ref\s*=|v_product_ref::text\s*\|\|/u);
    expect(storageMigration).not.toMatch(/storefront|shipping[_ ]?method|payment[_ ]?method|tax[_ ]?id/iu);
  });

  it('keeps configured amounts non-negative, currency-bound, and immutable with lineage', () => {
    const config = getTableConfig(feeRevisions);

    expect(config.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
      expect.arrayContaining([
        'pricing_fee_revisions_corrected_fk',
        'pricing_fee_revisions_currency_fk',
        'pricing_fee_revisions_fee_fk',
        'pricing_fee_revisions_previous_fk',
      ]),
    );
    expect(config.checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'pricing_fee_revisions_amount_ck',
        'pricing_fee_revisions_currency_ck',
        'pricing_fee_revisions_lineage_ck',
        'pricing_fee_revisions_number_ck',
      ]),
    );
    expect(
      config.policies.find(({ name }) => name === 'pricing_fee_revisions_scope_update')?.using?.queryChunks,
    ).toBeDefined();
    expect(config.columns.map(({ name }) => name)).toContain('catalog_target_evidence');
    expect(config.checks.map(({ name }) => name)).toContain('pricing_fee_revisions_catalog_evidence_ck');
    expect(storageMigration).toContain('CHECK ("amount" >= 0)');
  });

  it('models versioned half-open schedules, acknowledgement evidence, and one CAS head', () => {
    expect(getTableConfig(feeScheduleEntries).checks.map(({ name }) => name)).toContain(
      'pricing_fee_schedule_entries_period_ck',
    );
    expect(getTableConfig(feeScheduleEntries).foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
      expect.arrayContaining(['pricing_fee_schedule_entries_revision_fk', 'pricing_fee_schedule_entries_schedule_fk']),
    );
    expect(getTableConfig(feeScheduleAcknowledgements).checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'pricing_fee_schedule_acknowledgements_fingerprint_ck',
        'pricing_fee_schedule_acknowledgements_payload_ck',
      ]),
    );
    expect(getTableConfig(feeScheduleHeads).uniqueConstraints.map(({ name }) => name)).toContain(
      'pricing_fee_schedule_heads_fee_uk',
    );
    expect(getTableConfig(feeScheduleRevisions).columns.map(({ name }) => name)).toContain('command_fingerprint');
    expect(getTableConfig(feeScheduleRevisions).checks.map(({ name }) => name)).toContain(
      'pricing_fee_schedule_revisions_command_fingerprint_ck',
    );
    expect(getTableConfig(feeActionInvocationReceipts).uniqueConstraints.map(({ name }) => name)).toContain(
      'pricing_fee_action_invocation_receipts_invocation_uk',
    );
    expect(runtimeMigration).toContain('pricing_fee_schedule_entries_no_overlap');
    expect(runtimeMigration).toContain("tstzrange(effective_from, effective_to, '[)')");
    expect(runtimeMigration).toContain('FOR UPDATE');
    expect(runtimeMigration).toContain('GET DIAGNOSTICS v_updated_count = ROW_COUNT');
    expect(runtimeMigration).toContain("CASE WHEN v_intent = 'VALUE_ONLY_CURRENT'");
    expect(runtimeMigration).toContain("'presentedFuture', v_future");
    expect(runtimeMigration).toContain("'ACKNOWLEDGEMENT_STALE'");
    expect(replayV2Migration).toContain('command_fingerprint');
    expect(replayV2Migration).toContain("'COMMERCIAL_FEE_UNCHANGED'");
    expect(noOpReplayV2Migration).toContain('fee_action_invocation_receipts');
    expect(noOpReplayV2Migration).toContain('v_command_fingerprint');
  });

  it('publishes only the owner-local Fee routines without Storefront, FX, or currency activation', () => {
    for (const routine of [
      'define_commercial_fee_v1',
      'read_commercial_fee_schedule_v1',
      'read_current_commercial_fee_v1',
      'revise_commercial_fee_v1',
    ]) {
      expect(runtimeMigration).toContain(`CREATE OR REPLACE FUNCTION pricing.${routine}`);
      expect(runtimeMigration).toContain(
        `GRANT EXECUTE ON FUNCTION pricing.${routine}(uuid, uuid, jsonb) TO ontos_runtime`,
      );
    }
    expect(runtimeMigration).not.toMatch(/storefront|exchange[_ ]?rate|currency[_ ]?conversion|fx[_ ]?rate/iu);
    expect(runtimeMigration).not.toContain("'EUR'");
  });

  it('adds exact correction and retirement management without rewriting #773 history', () => {
    expect(managementV3Migration).toContain('CREATE OR REPLACE FUNCTION pricing.manage_commercial_fee_revision_v1');
    expect(managementV3Migration).toContain("v_intent NOT IN ('CORRECT_REVISION', 'RETIRE_CURRENT')");
    expect(managementV3Migration).toContain("v_target_revision_id, v_target_revision_id, 'CORRECTION'");
    expect(managementV3Migration).toContain("v_current_revision_id, NULL, 'RETIREMENT'");
    expect(managementV3Migration).toContain('v_normalized_catalog_evidence IS DISTINCT FROM v_target_catalog_evidence');
    expect(managementV3Migration).toContain("'TARGET_REVISION_NOT_FOUND'");
    expect(managementV3Migration).toContain("'targetEffectivePeriod'");
    expect(managementV3Migration).toContain('v_target_expected_from IS DISTINCT FROM v_target_from');
    expect(managementV3Migration).toContain("'BOUNDARY_CROSSED'");
    expect(managementV3Migration).toContain("'presentedFuture', v_future");
    expect(managementV3Migration).toContain("'intent', 'RETIRE_CURRENT'");
    expect(managementV3Migration).toContain('receipt.command_fingerprint');
    expect(managementV3Migration).toContain('revision.command_fingerprint');
    expect(managementV3Migration).toContain('FOR UPDATE');
    expect(managementV3Migration).toContain('GET DIAGNOSTICS v_updated_count = ROW_COUNT');
    expect(managementV3Migration).toContain(
      'GRANT EXECUTE ON FUNCTION pricing.manage_commercial_fee_revision_v1(uuid, uuid, jsonb) TO ontos_runtime',
    );
    expect(managementV3Migration).not.toMatch(/storefront|exchange[_ ]?rate|currency[_ ]?conversion|fx[_ ]?rate/iu);
    expect(managementV3Migration).not.toContain("'EUR'");
  });
});
