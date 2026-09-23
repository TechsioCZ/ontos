// @effect-diagnostics nodeBuiltinImport:off -- Migration contract reads checked-in Pricing SQL; expires: 2027-03-31.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'effect-rstest';
import { currencySupportRevisions, PRICING_SCHEMA_NAME, PRICING_TABLE_INVENTORY } from '../../src/database/schema.ts';

const migration = readFileSync(
  fileURLToPath(new URL('../../drizzle/20260922093000_pricing-currency-support/migration.sql', import.meta.url)),
  'utf-8',
);

describe('Pricing currency support database contract', () => {
  it('owns one append-only support revision table with scoped RLS', () => {
    expect(PRICING_SCHEMA_NAME).toBe('pricing');
    expect(PRICING_TABLE_INVENTORY).toEqual(['currency_support_revisions']);
    expect(getTableName(currencySupportRevisions)).toBe(PRICING_TABLE_INVENTORY[0]);
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain("current_setting('ontos.tenant_id', true)");
    expect(migration).toContain("current_setting('ontos.legal_entity_id', true)");
    expect(migration).toContain('FOR DELETE USING (false)');
  });

  it('reads only the exact context predicate and publishes currentness fields', () => {
    for (const predicate of [
      'context_revision',
      'storefront_id',
      'market_id',
      'channel_id',
      'cart_id',
      'subject_fingerprint',
    ]) {
      expect(migration).toContain(predicate);
    }
    expect(migration).toContain('read_current_supported_currencies');
    expect(migration).toContain("'observedAt'");
    expect(migration).toContain("'nextApplicabilityBoundary'");
    expect(migration).toContain("'pricingRevision'");
  });
});
