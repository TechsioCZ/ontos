import { readFileSync, readdirSync } from 'node:fs';

import { expect, it } from 'effect-rstest';

import { PRICING_RUNTIME_ROUTINE_SIGNATURES, PRICING_RUNTIME_TABLE_GRANTS } from '../postgres/runtime-role-grants.mts';

const pricingMigrationRoot = new URL('../../verticals/pricing/drizzle/', import.meta.url);
const newPricingMigrationEntries = readdirSync(pricingMigrationRoot).filter((entry) =>
  /^(?:20260928103000_|202609281100\d{2}_|20261001164414_|20261001180435_|20261001180624_)/u.test(entry),
);
const orderedPricingMigrationEntries: string[] = [];
for (const entry of newPricingMigrationEntries) {
  const insertionIndex = orderedPricingMigrationEntries.findIndex((candidate) => candidate.localeCompare(entry) > 0);
  if (insertionIndex === -1) {
    orderedPricingMigrationEntries.push(entry);
  } else {
    orderedPricingMigrationEntries.splice(insertionIndex, 0, entry);
  }
}
const newPricingMigrations = orderedPricingMigrationEntries.map((entry) =>
  readFileSync(new URL(`${entry}/migration.sql`, pricingMigrationRoot), 'utf-8'),
);

const normalizedRoutine = (signature: string): string =>
  signature.replaceAll('timestamp with time zone', 'timestamptz').replaceAll(/\s+/gu, '').toLowerCase();

const governedReadOnlyTables = [
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
] as const;
const governedReadOnlyTableSet: ReadonlySet<string> = new Set(governedReadOnlyTables);

const requiredCapture = (match: RegExpExecArray, name: string): string => {
  const capture = match.groups?.[name];
  if (capture === undefined) {
    throw new Error(`Expected SQL grant capture ${name}`);
  }
  return capture;
};

const migrationTableGrants = new Map<string, ReadonlySet<string>>();
const migrationRoutineGrants = new Set<string>();
const migrationRoutineRevokes = new Set<string>();
for (const migration of newPricingMigrations) {
  const tableGrantPattern =
    /GRANT\s+(?<privileges>[A-Z, ]+)\s+ON\s+TABLE\s+(?<tables>[\s\S]*?)\s+TO\s+"?ontos_runtime"?\s*;/giu;
  let tableGrant = tableGrantPattern.exec(migration);
  while (tableGrant !== null) {
    const privileges = new Set(
      requiredCapture(tableGrant, 'privileges')
        .split(',')
        .map((value) => value.trim().toLowerCase()),
    );
    for (const qualifiedName of requiredCapture(tableGrant, 'tables').split(',')) {
      const table = qualifiedName
        .trim()
        .replaceAll('"', '')
        .replace(/^pricing\./u, '');
      migrationTableGrants.set(table, privileges);
    }
    tableGrant = tableGrantPattern.exec(migration);
  }
  const routineGrantPattern =
    /(?<operation>GRANT|REVOKE)\s+(?:ALL|EXECUTE)\s+ON\s+FUNCTION\s+(?<signature>[\s\S]*?)\s+(?:TO|FROM)\s+(?<roles>[^;]+)\s*;/giu;
  let routineGrant = routineGrantPattern.exec(migration);
  while (routineGrant !== null) {
    if (requiredCapture(routineGrant, 'roles').toLowerCase().includes('ontos_runtime')) {
      const signature = normalizedRoutine(requiredCapture(routineGrant, 'signature'));
      if (requiredCapture(routineGrant, 'operation').toUpperCase() === 'GRANT') {
        migrationRoutineGrants.add(signature);
        migrationRoutineRevokes.delete(signature);
      } else {
        migrationRoutineGrants.delete(signature);
        migrationRoutineRevokes.add(signature);
      }
    }
    routineGrant = routineGrantPattern.exec(migration);
  }
}

it('provisions the exact least-privilege Pricing runtime table surface', () => {
  expect(PRICING_RUNTIME_TABLE_GRANTS).toEqual(
    expect.arrayContaining([
      { privileges: ['select', 'insert'], table: 'currency_support_roots' },
      { privileges: ['select', 'insert'], table: 'currency_support_schedule_entries' },
      { privileges: ['select', 'insert', 'update'], table: 'currency_support_schedule_heads' },
      { privileges: ['select', 'insert'], table: 'currency_support_schedule_revisions' },
      { privileges: ['select', 'insert'], table: 'currency_support_value_revisions' },
      { privileges: ['select', 'insert'], table: 'fee_action_invocation_receipts' },
      { privileges: ['select', 'insert'], table: 'fee_revisions' },
      { privileges: ['select', 'insert'], table: 'external_price_source_authority_grants' },
      { privileges: ['select', 'insert'], table: 'fee_schedule_acknowledgements' },
      { privileges: ['select', 'insert'], table: 'fee_schedule_entries' },
      { privileges: ['select', 'insert', 'update'], table: 'fee_schedule_heads' },
      { privileges: ['select', 'insert'], table: 'fee_schedule_revisions' },
      { privileges: ['select', 'insert'], table: 'fees' },
      { privileges: ['delete', 'insert', 'select'], table: 'gateway_assertion_redemptions' },
      { privileges: ['select', 'insert'], table: 'price_invocation_receipts' },
      { privileges: ['select', 'insert'], table: 'price_revisions' },
      { privileges: ['select', 'insert'], table: 'price_schedule_acknowledgements' },
      { privileges: ['select', 'insert'], table: 'price_schedule_entries' },
      { privileges: ['select', 'insert', 'update'], table: 'price_schedule_heads' },
      { privileges: ['select', 'insert'], table: 'price_schedule_revisions' },
      { privileges: ['select', 'insert'], table: 'price_source_assertion_deliveries' },
      { privileges: ['select', 'insert'], table: 'price_source_assertions' },
      { privileges: ['select', 'insert'], table: 'prices' },
      { privileges: ['select', 'insert'], table: 'quantity_tier_revisions' },
      { privileges: ['select', 'insert'], table: 'quantity_tier_schedule_acknowledgements' },
      { privileges: ['select', 'insert'], table: 'quantity_tier_schedule_entries' },
      { privileges: ['select', 'insert', 'update'], table: 'quantity_tier_schedule_heads' },
      { privileges: ['select', 'insert'], table: 'quantity_tier_schedule_revisions' },
      { privileges: ['select', 'insert'], table: 'quantity_tiers' },
    ]),
  );
  expect(PRICING_RUNTIME_TABLE_GRANTS).toHaveLength(61);
  expect(new Set(PRICING_RUNTIME_TABLE_GRANTS.map(({ table }) => table)).size).toBe(
    PRICING_RUNTIME_TABLE_GRANTS.length,
  );
  for (const table of governedReadOnlyTables) {
    expect(PRICING_RUNTIME_TABLE_GRANTS.find((candidate) => candidate.table === table)).toEqual({
      privileges: ['select'],
      table,
    });
  }
  for (const [table, privileges] of migrationTableGrants) {
    if (!governedReadOnlyTableSet.has(table)) {
      const plan = PRICING_RUNTIME_TABLE_GRANTS.find((candidate) => candidate.table === table);
      if (plan !== undefined) {
        expect(plan.privileges).toHaveLength(privileges.size);
        for (const privilege of privileges) {
          expect(plan.privileges).toContain(privilege);
        }
      }
    }
  }
  expect(PRICING_RUNTIME_TABLE_GRANTS.map(({ table }) => table)).not.toContain('currency_support_revisions');
  expect(PRICING_RUNTIME_TABLE_GRANTS.map(({ table }) => table)).not.toContain('price_current_revisions');
  expect(PRICING_RUNTIME_TABLE_GRANTS.map(({ table }) => table)).not.toContain('material_evidence_proof_receipts');
  expect(PRICING_RUNTIME_TABLE_GRANTS.map(({ table }) => table)).not.toContain('currency_support_proof_receipts');
  expect(PRICING_RUNTIME_TABLE_GRANTS.filter(({ privileges }) => privileges.join(',').includes('delete'))).toEqual([
    { privileges: ['delete', 'insert', 'select'], table: 'gateway_assertion_redemptions' },
  ]);
});

it('exposes only the governed Pricing routine signatures to the runtime role', () => {
  expect(PRICING_RUNTIME_ROUTINE_SIGNATURES).toEqual(
    expect.arrayContaining([
      'pricing.assess_external_price_source_authority_v1(uuid,uuid,jsonb)',
      'pricing.bind_price_source_provenance_v1(uuid,uuid,uuid,uuid,jsonb)',
      'pricing.compensate_tenant_currency_support_recovery_v1(uuid,jsonb)',
      'pricing.define_commercial_fee_v1(uuid,uuid,jsonb)',
      'pricing.define_price_v2(uuid,uuid,jsonb)',
      'pricing.lookup_exact_current_price_v1(uuid,uuid,jsonb)',
      'pricing.lookup_exact_current_price_v2(uuid,uuid,jsonb)',
      'pricing.fee_id_for_identity_v1(uuid,uuid,jsonb)',
      'pricing.fee_identity_json_v1(uuid,uuid,uuid)',
      'pricing.price_source_provenance_json_v1(uuid,uuid,uuid,uuid)',
      'pricing.quantity_tier_id_for_identity_v1(uuid,uuid,jsonb)',
      'pricing.quantity_tier_identity_json_v1(uuid,uuid,uuid)',
      'pricing.read_commercial_fee_schedule_v1(uuid,uuid,jsonb)',
      'pricing.read_current_commercial_fee_v1(uuid,uuid,jsonb)',
      'pricing.read_current_quantity_tier_v1(uuid,uuid,jsonb)',
      'pricing.read_current_supported_currencies(uuid,uuid,jsonb)',
      'pricing.read_current_price_definition_v1(uuid,uuid,uuid)',
      'pricing.read_price_schedule_v1(uuid,uuid,jsonb)',
      'pricing.read_quantity_tier_schedule_v1(uuid,uuid,jsonb)',
      'pricing.read_tenant_currency_support_v1(uuid,jsonb)',
      'pricing.read_tenant_supported_currencies_v2(uuid,uuid,jsonb)',
      'pricing.revalidate_tenant_currency_support_v1(uuid)',
      'pricing.revise_price_v2(uuid,uuid,jsonb)',
      'pricing.revise_commercial_fee_v1(uuid,uuid,jsonb)',
      'pricing.scheduled_fee_revision_json_v1(uuid,uuid,uuid,uuid,timestamp with time zone,timestamp with time zone)',
      'pricing.scheduled_quantity_tier_revision_json_v1(uuid,uuid,uuid,uuid,timestamp with time zone,timestamp with time zone)',
      'pricing.set_supported_currencies(uuid,uuid,jsonb)',
      'pricing.set_tenant_currency_support_v1(uuid,jsonb)',
      'pricing.store_external_price_source_authority_grant_v1(uuid,uuid,jsonb)',
    ]),
  );
  expect(PRICING_RUNTIME_ROUTINE_SIGNATURES).toHaveLength(90);
  const signatures = PRICING_RUNTIME_ROUTINE_SIGNATURES.map(normalizedRoutine);
  expect(new Set(signatures).size).toBe(signatures.length);
  for (const signature of migrationRoutineGrants) {
    expect(signatures).toContain(signature);
  }
  for (const signature of migrationRoutineRevokes) {
    expect(signatures).not.toContain(signature);
  }
  for (const helper of [
    'pricing.advance_contractual_discount_set_v1(uuid,uuid,uuid,text)',
    'pricing.advance_fee_set_generation_v1(uuid,uuid,uuid,uuid,text)',
    'pricing.advance_price_candidate_set_generation_v1(uuid,uuid,uuid,uuid,text)',
    'pricing.advance_zero_floor_set_v1(uuid,uuid,text,text)',
    'pricing.ensure_zero_floor_set_v1(uuid,uuid,text)',
    'pricing.execute_price_fee_action_with_result_v1(uuid,uuid,jsonb,text)',
  ]) {
    expect(signatures).not.toContain(helper);
  }
});

it('revokes broad Pricing access before applying the exact table and routine plans', () => {
  const bootstrap = readFileSync(new URL('../postgres/bootstrap-runtime-role.mts', import.meta.url), 'utf-8');

  expect(bootstrap).toContain('revoke all on schema pricing from public, ontos_runtime');
  expect(bootstrap).toContain(`revoke all on table \${qualifiedTable} from public, ontos_runtime`);
  expect(bootstrap).toContain(`revoke all on function \${signature} from public, ontos_runtime`);
  expect(bootstrap).toContain(`grant \${privileges.join(', ')} on table \${qualifiedTable} to ontos_runtime`);
  expect(bootstrap).toContain(`grant execute on function \${signature} to ontos_runtime`);
  expect(bootstrap).not.toMatch(/all tables in schema pricing/u);
  expect(bootstrap).not.toMatch(/default privileges in schema pricing/u);
});

it('restores read-only Application Composition authority privileges after blanket Core grants', () => {
  const bootstrap = readFileSync(new URL('../postgres/bootstrap-runtime-role.mts', import.meta.url), 'utf-8');
  const broadGrant = bootstrap.indexOf('grant select, insert, update, delete on all tables in schema');
  const authorityRevoke = bootstrap.indexOf(
    'revoke all on table core.application_composition_authority from public, ontos_runtime',
  );
  const authorityGrant = bootstrap.indexOf(
    'grant select on table core.application_composition_authority to ontos_runtime',
  );
  expect(broadGrant).toBeGreaterThan(-1);
  expect(authorityRevoke).toBeGreaterThan(broadGrant);
  expect(authorityGrant).toBeGreaterThan(authorityRevoke);
  const durableRevoke = bootstrap.indexOf(
    'revoke all on table core.application_composition_durable_work from public, ontos_runtime',
  );
  const durableGrant = bootstrap.indexOf(
    'grant select on table core.application_composition_durable_work to ontos_runtime',
  );
  expect(durableRevoke).toBeGreaterThan(broadGrant);
  expect(durableGrant).toBeGreaterThan(durableRevoke);
  expect(bootstrap).toContain(
    'revoke all on function core.track_application_composition_durable_work(text,text,text,boolean) from public, ontos_runtime',
  );
});
