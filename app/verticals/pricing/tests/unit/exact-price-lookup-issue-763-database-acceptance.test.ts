// @effect-diagnostics nodeBuiltinImport:off -- Migration contract reads checked-in Pricing SQL; expires: 2027-03-31.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'effect-rstest';

const migration = readFileSync(
  new URL('../../drizzle/20260927203135_pricing_exact_price_lookup_v1/migration.sql', import.meta.url),
  'utf-8',
);
const conflictMigration = readFileSync(
  new URL('../../drizzle/20260927205633_pricing_exact_price_conflicts_v2/migration.sql', import.meta.url),
  'utf-8',
);
const executableSql = migration.replaceAll(/^--.*$/gmu, '');
const runtimeGrants = readFileSync(
  new URL('../../../../scripts/postgres/runtime-role-grants.mts', import.meta.url),
  'utf-8',
);
const verifier = readFileSync(new URL('../../scripts/verify-db-schema.mts', import.meta.url), 'utf-8');

describe('Issue #763 exact Price lookup database acceptance', () => {
  it('aggregates the complete Current set and never selects an arbitrary winner', () => {
    expect(executableSql).toContain('CREATE FUNCTION pricing.lookup_exact_current_price_v1(');
    expect(executableSql).toContain('count(*)::integer');
    expect(executableSql).toContain('count(DISTINCT truth.price_id)::integer');
    expect(executableSql).toContain('v_current_truth_count <> v_current_price_count');
    expect(executableSql).toContain('v_current_price_count > 1');
    expect(executableSql).toContain("'_tag', 'CONFLICT'");
    expect(executableSql).toContain("'currentPriceRefs', v_current_price_refs");
    expect(executableSql).not.toMatch(/\blimit\s+1\b/iu);
  });

  it('binds every exact identity axis, owner source usability, and half-open schedule Currentness', () => {
    for (const requiredSql of [
      "price.catalog_selection = v_key -> 'catalogSelection'",
      "price.channel_id = v_key #>> '{commercialScope,channelId}'",
      "price.market_id = v_key #>> '{commercialScope,marketId}'",
      'price.legal_entity_id = p_legal_entity_id',
      'price.currency_code = v_currency_code',
      "price.unit_ref = v_key #> '{unitBasis,unitRef}'",
      'price.basis_quantity = v_basis_quantity',
      "price.price_group_selector = v_key -> 'priceGroupSelector'",
      'entry.effective_from <= v_effective_at',
      'v_effective_at < entry.effective_to',
      'truth.source_count <> 1',
    ]) {
      expect(executableSql).toContain(requiredSql);
    }
    expect(executableSql).not.toContain('storefront');
  });

  it('includes Tenant Current Currency Support and future boundary evidence without activating FX', () => {
    expect(executableSql).toContain('pricing.currency_support_roots');
    expect(executableSql).toContain('pricing.currency_support_schedule_heads');
    expect(executableSql).toContain('pricing.currency_support_schedule_entries');
    expect(executableSql).toContain('v_supported_currencies ? v_currency_code');
    expect(executableSql).toContain("'_tag', 'INVALID', 'reason', 'UNSUPPORTED_CURRENCY'");
    expect(executableSql).toContain('statement_timestamp()');
    expect(executableSql).toContain("'nextApplicabilityBoundary'");
    expect(executableSql).not.toMatch(/exchange|fx_rate|conversion_rate/iu);
  });

  it('registers and grants only the governed scoped routine signature', () => {
    const signature = 'pricing.lookup_exact_current_price_v1(uuid,uuid,jsonb)';
    expect(migration).toContain('REVOKE ALL ON FUNCTION pricing.lookup_exact_current_price_v1(uuid, uuid, jsonb)');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION pricing.lookup_exact_current_price_v1(uuid, uuid, jsonb)');
    expect(runtimeGrants).toContain(signature);
    expect(verifier).toContain("'lookup_exact_current_price_v1'");
  });

  it('upgrades known competing Current truths to an owner diagnostic without selecting a winner', () => {
    const signature = 'pricing.lookup_exact_current_price_v2(uuid,uuid,jsonb)';
    expect(conflictMigration).toContain('CREATE FUNCTION pricing.lookup_exact_current_price_v2(');
    expect(conflictMigration).toContain("'_tag', 'EXACT_PRICE_CONFLICT_DIAGNOSTIC'");
    expect(conflictMigration).toContain("'verification', 'OWNER_VERIFIED_COMPLETE_CURRENT_SET'");
    expect(conflictMigration).toContain('v_database_raw_count <> v_database_valid_count');
    expect(conflictMigration).not.toMatch(/\blimit\s+1\b/iu);
    expect(conflictMigration).not.toMatch(/drop\s+constraint/iu);
    expect(conflictMigration).not.toContain('pricing_exact_price_conflict_fixture');
    expect(conflictMigration).not.toMatch(/to_regclass\s*\(\s*'pg_temp/iu);
    expect(conflictMigration).not.toMatch(/current_user\s*<>/iu);
    expect(runtimeGrants).toContain(signature);
    expect(verifier).toContain("'lookup_exact_current_price_v2'");
  });
});
