import { readFileSync } from 'node:fs';

import { expect, it } from 'effect-rstest';

it('migrates a serialized owner assessment and reservation barrier instead of a stub routine', () => {
  const snapshot = readFileSync(
    new URL('../../drizzle/20260922160020_market-retirement-authority-snapshot/snapshot.json', import.meta.url),
    'utf-8',
  );
  const migration = readFileSync(
    new URL('../../drizzle/20260922170000_market-retirement-authority/migration.sql', import.meta.url),
    'utf-8',
  );

  expect(migration).toContain(
    'CREATE OR REPLACE FUNCTION "commerce_customer_context"."assess_market_retirement_affected_use"',
  );
  expect(migration).toContain('FROM market_bootstrap_policy_revisions');
  expect(migration).toContain('FROM purchase_proposal_revisions');
  expect(migration).toContain("'BOOTSTRAP_DEFAULT'");
  expect(migration).toContain("'CURRENT_PROPOSAL'");
  expect(migration).toContain("'RETAINED_HISTORY'");
  expect(migration).toContain('pg_advisory_xact_lock');
  expect(migration).toContain('canonical_market_retirement_json');
  expect(migration).toContain('jsonb_array_length(v_source_evidence) <> 4');
  expect(migration).toContain("'application-composition:commerce.cart:UNIMPLEMENTED'");
  expect(migration).toContain("'application-composition:commerce.order:UNIMPLEMENTED'");
  expect(migration).toContain("'nextApplicabilityBoundary')::timestamptz <= statement_timestamp()");
  expect(migration).toContain('v_assessment_digest IS DISTINCT FROM v_expected_assessment_digest');
  expect(migration).toContain("CONSTRAINT = 'market_retirement_reservation_conflict'");
  expect(migration).toContain('market_bootstrap_policy_retirement_guard');
  expect(migration).toContain('purchase_proposal_market_retirement_guard');
  expect(migration).toContain("SET lifecycle = 'COMMITTED', reservation_version = reservation_version + 1");
  expect(migration).toContain("SET lifecycle = 'RELEASED', reservation_version = reservation_version + 1");
  expect(snapshot).toContain('market_retirement_reservations');
});
