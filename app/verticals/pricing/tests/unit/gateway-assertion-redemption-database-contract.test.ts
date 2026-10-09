// @effect-diagnostics nodeBuiltinImport:off -- Migration contract reads checked-in Pricing SQL; expires: 2027-03-31.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'effect-rstest';

import { gatewayAssertionRedemptions, PRICING_TABLE_INVENTORY } from '../../src/database/schema.ts';

const migration = readFileSync(
  fileURLToPath(new URL('../../drizzle/20260927200708_gateway/migration.sql', import.meta.url)),
  'utf-8',
);

describe('Pricing gateway assertion redemption database contract', () => {
  it('owns one global non-RLS replay table without business scope columns', () => {
    const config = getTableConfig(gatewayAssertionRedemptions);

    expect(PRICING_TABLE_INVENTORY).toContain('gateway_assertion_redemptions');
    expect(getTableName(gatewayAssertionRedemptions)).toBe('gateway_assertion_redemptions');
    expect(config.enableRLS).toBe(false);
    expect(config.columns.map(({ name }) => name)).toEqual(['audience', 'expires_at', 'issuer', 'jti', 'redeemed_at']);
    expect(config.columns.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(['tenant_id', 'legal_entity_id']),
    );
  });

  it('keys replay by issuer, audience, and jti and indexes expiry cleanup', () => {
    const config = getTableConfig(gatewayAssertionRedemptions);

    expect(config.uniqueConstraints.map(({ name }) => name)).toEqual([
      'pricing_gateway_assertion_redemptions_identity_uk',
    ]);
    expect(config.indexes.map(({ config: index }) => index.name)).toEqual([
      'pricing_gateway_assertion_redemptions_expiry_idx',
    ]);
    expect(migration).toContain('UNIQUE("issuer","audience","jti")');
    expect(migration).toContain('("expires_at")');
  });

  it('grants only the exact cleanup-and-redeem surface', () => {
    expect(migration).toContain(
      'REVOKE ALL ON TABLE "pricing"."gateway_assertion_redemptions" FROM PUBLIC, "ontos_runtime"',
    );
    expect(migration).toContain(
      'GRANT DELETE, INSERT, SELECT ON TABLE "pricing"."gateway_assertion_redemptions" TO "ontos_runtime"',
    );
    expect(migration).not.toMatch(/GRANT[^;]*UPDATE/iu);
    expect(migration).not.toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).not.toContain('FORCE ROW LEVEL SECURITY');
  });
});
