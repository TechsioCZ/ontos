// @effect-diagnostics nodeBuiltinImport:off -- Migration security contract reads checked-in SQL evidence; expires: 2027-03-01.
import { readFileSync } from 'node:fs';

import { expect, it } from 'effect-rstest';

const profileRoutineMigration = readFileSync(
  new URL('../../drizzle/20260909112229_profile-routines/migration.sql', import.meta.url),
  'utf-8',
);
const profileCompletionMigration = readFileSync(
  new URL(
    '../../drizzle/20260909115300_complete-profile-reconciliation-and-guest-attribution/migration.sql',
    import.meta.url,
  ),
  'utf-8',
);
const profileEvidenceMigration = readFileSync(
  new URL(
    '../../drizzle/20260909134514_add-profile-observation-owner-outcome-and-invitation-proof-evidence/migration.sql',
    import.meta.url,
  ),
  'utf-8',
);
const inactiveGuestAttributionMigration = readFileSync(
  new URL('../../drizzle/20260909140125_record-inactive-guest-attribution/migration.sql', import.meta.url),
  'utf-8',
);
const profileCanonicalizationMigration = readFileSync(
  new URL('../../drizzle/20260909142031_add-profile-canonicalization-evidence/migration.sql', import.meta.url),
  'utf-8',
);
const globalCounterpartyIdentityMigration = readFileSync(
  new URL('../../drizzle/20260909193000_counterparty-profile-global-identity/migration.sql', import.meta.url),
  'utf-8',
);

const publicProfileRoutines = [
  'ensure_retail_profile',
  'ensure_counterparty_profile',
  'transition_profile',
  'mutate_retail_portal_binding',
  'read_customer_profile',
  'read_profile_trading_gate',
  'read_retail_portal_binding',
  'resolve_retail_principal',
  'open_profile_reconciliation',
  'resolve_profile_reconciliation',
  'record_profile_reconciliation_owner_outcome',
  'read_profile_reconciliation',
  'record_guest_attribution',
  'read_guest_attribution',
  'observe_party_merge_reconciliation',
  'reconcile_profile_reconciliation_owner',
] as const;

const functionNames = (sql: string): readonly string[] =>
  [...sql.matchAll(/CREATE OR REPLACE FUNCTION "commerce_customer_context"\."(?<name>[^"]+)"\(/gu)].flatMap(
    ({ groups }) => (groups?.name === undefined ? [] : [groups.name]),
  );

const functionBlock = (name: string): string => {
  const marker = `CREATE OR REPLACE FUNCTION "commerce_customer_context"."${name}"(`;
  const start = profileRoutineMigration.indexOf(marker);
  expect(start, `${name} must be declared`).toBeGreaterThanOrEqual(0);
  const next = profileRoutineMigration.indexOf('\nCREATE OR REPLACE FUNCTION', start + marker.length);
  return profileRoutineMigration.slice(start, next === -1 ? undefined : next);
};

const globalIdentityFunctionBlock = (name: string): string => {
  const marker = `CREATE OR REPLACE FUNCTION commerce_customer_context.${name}(`;
  const start = globalCounterpartyIdentityMigration.indexOf(marker);
  expect(start, `${name} must be declared in the global identity migration`).toBeGreaterThanOrEqual(0);
  const next = globalCounterpartyIdentityMigration.indexOf('\nCREATE OR REPLACE FUNCTION', start + marker.length);
  return globalCounterpartyIdentityMigration.slice(start, next === -1 ? undefined : next);
};

it('exposes exactly the sixteen hardened profile routines through the private scope helper', () => {
  const declared = functionNames(profileRoutineMigration);
  expect(declared).toEqual([
    'assert_profile_operation_scope',
    'ensure_retail_profile',
    'record_guest_attribution',
    'read_guest_attribution',
    'observe_party_merge_reconciliation',
    'open_profile_reconciliation',
    'record_profile_reconciliation_owner_outcome',
    'resolve_profile_reconciliation',
    'read_profile_reconciliation',
    'read_customer_profile',
    'read_profile_trading_gate',
    'read_retail_portal_binding',
    'resolve_retail_principal',
    'transition_profile',
    'mutate_retail_portal_binding',
    'ensure_counterparty_profile',
  ]);

  for (const name of declared) {
    const block = functionBlock(name);
    expect(block, `${name} must use SECURITY DEFINER`).toContain('SECURITY DEFINER');
    expect(block, `${name} must pin its search path`).toContain(
      'SET search_path = pg_catalog, commerce_customer_context',
    );
  }

  const granted = [
    ...`${profileRoutineMigration}\n${profileCompletionMigration}\n${profileEvidenceMigration}\n${inactiveGuestAttributionMigration}\n${profileCanonicalizationMigration}`.matchAll(
      /GRANT EXECUTE ON FUNCTION "commerce_customer_context"\."(?<name>[^"]+)"\(/gu,
    ),
  ]
    .flatMap(({ groups }) => (groups?.name === undefined ? [] : [groups.name]))
    .filter((name) => publicProfileRoutines.some((expected) => expected === name));
  expect(new Set(granted)).toEqual(new Set(publicProfileRoutines));
  expect(granted).toHaveLength(publicProfileRoutines.length);
  expect(granted).not.toContain('assert_profile_operation_scope');
  expect(profileRoutineMigration).toContain(
    'REVOKE ALL ON FUNCTION "commerce_customer_context"."assert_profile_operation_scope"(uuid,uuid) FROM PUBLIC, "ontos_runtime";',
  );
});

it('keeps the profile persistence role EXECUTE-only after the completed native migration', () => {
  const grants =
    `${profileCompletionMigration}\n${profileEvidenceMigration}\n${inactiveGuestAttributionMigration}\n${profileCanonicalizationMigration}`
      .match(/^GRANT .+$/gmu)
      ?.filter((grant) => publicProfileRoutines.some((name) => grant.includes(`"${name}"`))) ?? [];
  expect(grants).toHaveLength(publicProfileRoutines.length);
  for (const grant of grants) {
    expect(grant).toMatch(
      /^GRANT EXECUTE ON FUNCTION "commerce_customer_context"\."[^"]+"\(.+\) TO "ontos_runtime";$/u,
    );
  }
  expect(profileRoutineMigration).not.toMatch(
    /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|USAGE|ALL)\b/iu,
  );
  expect(profileCompletionMigration).toContain(
    'REVOKE ALL ON ALL TABLES IN SCHEMA "commerce_customer_context" FROM PUBLIC, "ontos_runtime";',
  );
  expect(profileCompletionMigration).toContain(
    'REVOKE ALL ON ALL SEQUENCES IN SCHEMA "commerce_customer_context" FROM PUBLIC, "ontos_runtime";',
  );
  expect(profileCompletionMigration).toContain('Direct runtime/public privilege leaked on');
});

it('forces RLS and append-only enforcement for every new durable evidence table', () => {
  const hardening = [
    ['customer_profile_aliases', 'ccc_profile_aliases_append_only'],
    ['guest_retail_attributions', 'ccc_guest_attributions_append_only'],
    ['profile_reconciliation_case_members', 'ccc_reconciliation_members_append_only'],
    ['retail_portal_profile_binding_history', 'ccc_portal_binding_history_append_only'],
  ] as const;

  for (const [table, trigger] of hardening) {
    expect(profileCompletionMigration).toContain(
      `ALTER TABLE "commerce_customer_context"."${table}" FORCE ROW LEVEL SECURITY;`,
    );
    expect(profileCompletionMigration).toContain(
      `CREATE TRIGGER "${trigger}"\nBEFORE UPDATE OR DELETE ON "commerce_customer_context"."${table}"\nFOR EACH ROW EXECUTE FUNCTION "commerce_customer_context"."reject_append_only_mutation"();`,
    );
  }
});

it('replaces broad current-binding uniqueness with the exact profile-principal pair', () => {
  expect(profileCompletionMigration).toContain(
    'DROP INDEX "commerce_customer_context"."ccc_portal_bindings_current_profile_uk";',
  );
  expect(profileCompletionMigration).toContain(
    'DROP INDEX "commerce_customer_context"."ccc_portal_bindings_current_auth_uk";',
  );
  expect(profileCompletionMigration).toContain(
    'CREATE UNIQUE INDEX "ccc_portal_bindings_current_profile_principal_uk" ON "commerce_customer_context"."retail_portal_profile_bindings" ("tenant_id","legal_entity_id","retail_customer_profile_id","principal_id") WHERE "lifecycle" = \'ACTIVE\';',
  );
  expect(profileCompletionMigration).not.toMatch(
    /CREATE UNIQUE INDEX "ccc_portal_bindings_current_(?:profile|auth)_uk"/u,
  );
});

it('persists reconciliation ordering with a bigint watermark and immutable history revisions', () => {
  expect(profileCompletionMigration).toContain('ADD COLUMN "last_processed_event_version" bigint DEFAULT 0 NOT NULL;');
  expect(profileCompletionMigration).toContain(
    'CONSTRAINT "ccc_portal_binding_history_revision_uk" UNIQUE("tenant_id","legal_entity_id","retail_portal_profile_binding_id","revision")',
  );
  expect(profileRoutineMigration).toContain('p_event_version bigint');
  expect(profileRoutineMigration).toContain('last_processed_event_version=p_event_version');
});

it('serializes tenant-global Counterparty ensures and never translates uniqueness races to role denial', () => {
  const ensure = globalIdentityFunctionBlock('ensure_counterparty_profile');

  expect(globalCounterpartyIdentityMigration).toContain('HAVING count(*) > 1');
  expect(ensure).toContain(
    "pg_advisory_xact_lock(hashtextextended(\n    p_tenant_id::text || ':counterparty:' || btrim(p_counterparty_resource_id), 0\n  ));",
  );
  expect(ensure).not.toContain("p_legal_entity_id::text || ':counterparty:'");
  expect(ensure).toContain("RETURN QUERY SELECT 'PERSISTENCE_CONFLICT', NULL::jsonb;");
  expect(ensure).not.toMatch(/EXCEPTION WHEN unique_violation THEN[\s\S]*?COUNTERPARTY_ROLE_NOT_ELIGIBLE/u);
  expect(ensure).toContain('AND pp.counterparty_resource_id = btrim(p_counterparty_resource_id)');
});

it('keeps Counterparty read reuse tenant-global while retaining seller-scoped reconciliation evidence', () => {
  const read = globalIdentityFunctionBlock('read_customer_profile');

  expect(read).toContain('AND customer_profile_id = p_profile_id\n     AND profile_kind = p_profile_kind');
  expect(read).toContain("IF p_profile_kind = 'RETAIL' THEN");
  expect(read).toContain("'kind', 'COUNTERPARTY'");
  expect(read).toContain('AND m.legal_entity_id = p_legal_entity_id');
  expect(read).toContain("'scopeLegalEntityId', p_legal_entity_id");
  expect(globalCounterpartyIdentityMigration).toContain(
    'FOREIGN KEY\n  (tenant_id, counterparty_purchasing_profile_id)',
  );
  expect(globalCounterpartyIdentityMigration).toContain(
    'ccc_counterparty_profiles_global_owner_routine\n  ON commerce_customer_context.counterparty_purchasing_profiles\n  AS PERMISSIVE FOR ALL TO public',
  );
  expect(globalCounterpartyIdentityMigration).toContain(
    'ccc_profiles_global_owner_routine\n  ON commerce_customer_context.customer_profiles\n  AS PERMISSIVE FOR ALL TO public',
  );
  expect(globalCounterpartyIdentityMigration).toContain(
    'CREATE OR REPLACE FUNCTION commerce_customer_context.lock_access_grant_authority',
  );
  expect(globalCounterpartyIdentityMigration).toContain(
    'CREATE OR REPLACE FUNCTION commerce_customer_context.verify_invitation_claim_authority',
  );
  expect(globalCounterpartyIdentityMigration).not.toMatch(/profile\.legal_entity_id = grant_row\.legal_entity_id/gu);
  expect(globalCounterpartyIdentityMigration).not.toMatch(/profile\.legal_entity_id = v_invitation\.legal_entity_id/gu);
});
