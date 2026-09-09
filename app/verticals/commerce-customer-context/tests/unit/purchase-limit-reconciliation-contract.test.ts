// @effect-diagnostics nodeBuiltinImport:off -- This test checks the checked-in owner routine contract; expires: 2027-03-31.
import { readFileSync } from 'node:fs';

import { expect, it } from 'effect-rstest';

const migration = readFileSync(
  new URL(
    '../../drizzle/20260909151000_bind-ccc-reconciliation-owner-composite/migration.sql',
    import.meta.url,
  ),
  'utf-8',
);

it('keeps PURCHASE_LIMITS reconciliation fail-closed for the owner receipt', () => {
  const purchaseLimitsOffset = migration.indexOf("ELSIF p_owner='PURCHASE_LIMITS'");
  expect(purchaseLimitsOffset).toBeGreaterThanOrEqual(0);
  const purchaseLimits = migration.slice(purchaseLimitsOffset);

  expect(purchaseLimits).toContain("v_case.profile_kind<>'COUNTERPARTY'");
  expect(purchaseLimits).toContain("defaults.policy_kind<>'CLEARED'");
  expect(purchaseLimits).toContain("overrides.policy_kind<>'CLEARED'");
  expect(purchaseLimits).toContain('FOR UPDATE OF purchasing_profile');
  expect(purchaseLimits).toContain('FOR UPDATE OF defaults');
  expect(purchaseLimits).toContain('FOR UPDATE OF overrides');
  expect(purchaseLimits).toContain('IF v_loser_count<>0 THEN');
  expect(purchaseLimits).toContain("RETURN QUERY SELECT 'OWNER_CONFLICT',NULL::jsonb");
  expect(purchaseLimits).toContain(
    "v_status:=CASE WHEN v_total_count=0 THEN 'NOT_APPLICABLE' ELSE 'RESOLVED' END",
  );
  expect(purchaseLimits).toContain("RETURN QUERY SELECT 'VERIFIED',jsonb_build_object(");

  const purchaseLimitLogicEnd = purchaseLimits.indexOf('  END IF;\n  END IF;\n\n  IF v_status');
  expect(purchaseLimitLogicEnd).toBeGreaterThanOrEqual(0);
  expect(
    purchaseLimits.slice(0, purchaseLimitLogicEnd).replaceAll(/FOR UPDATE(?: OF [a-z_]+)?/gu, ''),
  ).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/u);
});
