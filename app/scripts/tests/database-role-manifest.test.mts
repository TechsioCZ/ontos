import { Array as EffectArray, Order } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  BEARER_ASSERTION_ROLE_SETTINGS,
  DATABASE_IDENTITIES,
} from '../../packages/core-runtime/src/db/database-identities.ts';
import {
  DATABASE_ROLE_GRANT_MANIFEST,
  TRUST_ROUTINES,
  manifestEntryForRole,
} from '../postgres/database-role-manifest.mts';

const explicitEntries = DATABASE_ROLE_GRANT_MANIFEST.flatMap((entry) => (entry.kind === 'explicit' ? [entry] : []));
const schemaOf = (qualifiedName: string): string => qualifiedName.slice(0, qualifiedName.indexOf('.'));
const openSourceExecutionFenceSignature = 'trust.open_source_execution_fence(uuid,uuid)';
const openGatedSourceExecutionFenceSignature = 'trust.open_source_execution_fence(uuid,uuid,uuid,text,text)';
const sourceExecutionGateAdminSignatures = [
  'trust.register_source_execution_gated_action(text,text)',
  'trust.publish_source_execution_gate(uuid,uuid,text,uuid,uuid,text,text,boolean,boolean)',
];
const cancelSourceExecutionFenceSignature = 'trust.cancel_source_execution_fence(uuid,uuid)';
const lockSourceExecutionFenceSignature = 'trust.lock_source_execution_fence(uuid,uuid)';
const readSourceExecutionFenceSignature = 'trust.read_source_execution_fence(uuid,uuid)';
const registeredWorkloadDeliverySignature = 'trust.registered_workload_delivery_is_active(uuid,text,text,text,uuid)';
const lockAccessScopeFenceSignature = 'trust.lock_access_scope_fence(uuid,uuid)';
const sharedRuntimeTrustRoutines = [
  openSourceExecutionFenceSignature,
  openGatedSourceExecutionFenceSignature,
  cancelSourceExecutionFenceSignature,
  lockSourceExecutionFenceSignature,
  readSourceExecutionFenceSignature,
  registeredWorkloadDeliverySignature,
  lockAccessScopeFenceSignature,
];

it('keeps every shared runtime exception within its exact owner privileges', () => {
  const entry = manifestEntryForRole('ontos_runtime');
  expect(entry?.kind).toBe('legacy_shared');
  if (entry?.kind !== 'legacy_shared') {
    return;
  }
  expect(entry.tableGrantExceptions?.map(({ privileges, table }) => ({ privileges, table }))).toEqual([
    { privileges: [], table: 'core.source_execution_fences' },
    { privileges: [], table: 'core.source_execution_gate_actions' },
    { privileges: [], table: 'core.source_execution_gates' },
    {
      privileges: ['select', 'insert', 'delete'],
      table: 'assortment.gateway_assertion_redemptions',
    },
    {
      privileges: ['select', 'insert', 'delete'],
      table: 'inventory.gateway_assertion_redemptions',
    },
    {
      privileges: ['select', 'insert', 'delete'],
      table: 'privacy.gateway_assertion_redemptions',
    },
    {
      privileges: ['select', 'insert', 'delete'],
      table: 'tax.gateway_assertion_redemptions',
    },
    {
      privileges: ['select', 'insert'],
      table: 'symmy_integration.job_effects',
    },
    { privileges: ['select', 'insert'], table: 'promotion.policy_changes' },
    { privileges: ['select', 'insert', 'update'], table: 'promotion.tenant_generations' },
    { privileges: ['select', 'insert', 'update'], table: 'promotion.promotion_drafts' },
    { privileges: ['select', 'insert', 'update'], table: 'promotion.selection_policies' },
    { privileges: ['select', 'insert', 'update'], table: 'promotion.basis_policies' },
    { privileges: ['select', 'insert'], table: 'promotion.published_promotions' },
    { privileges: ['select', 'insert'], table: 'promotion.lifecycle_facts' },
    { privileges: ['select', 'insert'], table: 'promotion.vouchers' },
    { privileges: ['select', 'insert'], table: 'promotion.voucher_disable_facts' },
    { privileges: ['select', 'insert'], table: 'promotion.issued_proofs' },
    { privileges: ['select', 'insert', 'delete'], table: 'promotion.gateway_assertion_redemptions' },
    {
      privileges: ['select', 'insert', 'update'],
      table: 'commerce_market_catalog.market_retirement_admissions',
    },
    {
      privileges: ['select', 'insert'],
      table: 'symmy_integration.gateway_assertion_redemptions',
    },
    {
      privileges: ['select', 'insert'],
      table: 'symmy_integration.import_jobs',
    },
    {
      privileges: ['select'],
      table: 'symmy_integration.job_routes',
    },
  ]);
  for (const exception of entry.tableGrantExceptions ?? []) {
    expect(exception.reason.trim()).not.toBe('');
  }
  for (const explicit of explicitEntries) {
    expect('tableGrantExceptions' in explicit).toBe(false);
  }
});

it('gives every database identity exactly one grant manifest entry', () => {
  expect(DATABASE_ROLE_GRANT_MANIFEST).toHaveLength(DATABASE_IDENTITIES.length);
  for (const identity of DATABASE_IDENTITIES) {
    expect(DATABASE_ROLE_GRANT_MANIFEST.filter((entry) => entry.identity.role === identity.role)).toHaveLength(1);
    expect(manifestEntryForRole(identity.role)?.identity).toBe(identity);
  }
  expect(manifestEntryForRole('ontos_admin')).toBeUndefined();
});

it('names explicit tables once each as schema.table inside the granted schemas', () => {
  expect(explicitEntries.length).toBeGreaterThan(0);
  for (const { grants, identity } of explicitEntries) {
    const tables = grants.tables.map(({ table }) => table);
    for (const table of tables) {
      expect(table, `${identity.role} table ${table}`).toMatch(/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/u);
      expect(grants.schemas, `${identity.role} schema for ${table}`).toContain(schemaOf(table));
    }
    expect(new Set(tables).size, `${identity.role} duplicate tables`).toBe(tables.length);
    for (const { sequence } of grants.sequences) {
      expect(sequence, `${identity.role} sequence ${sequence}`).toMatch(/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/u);
      expect(grants.schemas, `${identity.role} schema for ${sequence}`).toContain(schemaOf(sequence));
    }
  }
});

it('restricts column grants to privileges the table grant already names', () => {
  for (const { grants, identity } of explicitEntries) {
    for (const { columns, privileges, table } of grants.tables) {
      for (const [privilege, names] of Object.entries(columns ?? {})) {
        expect(privileges, `${identity.role} ${table} column privilege ${privilege}`).toContain(privilege);
        expect(names?.length ?? 0, `${identity.role} ${table} ${privilege} columns`).toBeGreaterThan(0);
      }
    }
  }
});

it('grants trust routines only to their executors and owner routines only inside granted schemas', () => {
  for (const { grants, identity } of explicitEntries) {
    for (const signature of grants.routines) {
      expect(signature, `${identity.role} routine ${signature}`).toMatch(/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\(.*\)$/u);
      const routine = TRUST_ROUTINES.find((candidate) => candidate.signature === signature);
      if (schemaOf(signature) === 'trust') {
        expect(routine, `${identity.role} trust routine ${signature}`).toBeDefined();
        expect(routine?.executableBy, `${identity.role} executes ${signature}`).toContain(identity.role);
      } else {
        expect(grants.schemas, `${identity.role} schema for ${signature}`).toContain(schemaOf(signature));
      }
    }
    expect(new Set(grants.routines).size, `${identity.role} duplicate routines`).toBe(grants.routines.length);
  }
  for (const routine of TRUST_ROUTINES) {
    for (const role of routine.executableBy) {
      const entry = manifestEntryForRole(role);
      expect(entry, `${role} executes ${routine.signature}`).toBeDefined();
      if (entry?.kind === 'explicit') {
        expect(entry.grants.routines).toContain(routine.signature);
      } else {
        // The legacy shared role holds no routine list, so pin its trust surface here.
        expect(role).toBe('ontos_runtime');
        expect(sharedRuntimeTrustRoutines, `${role} executes ${routine.signature}`).toContain(routine.signature);
      }
    }
  }
});

it('derives trust routine executors from the identity flags', () => {
  const registrars = EffectArray.sort(
    DATABASE_IDENTITIES.filter(({ registersGatewayScopeGrants }) => registersGatewayScopeGrants).map(
      ({ role }) => role,
    ),
    Order.String,
  );
  const gatewayGrantRoles = EffectArray.sort(
    DATABASE_IDENTITIES.filter(({ scopeAuthority }) => scopeAuthority === 'gateway_grant').map(({ role }) => role),
    Order.String,
  );
  const actionRunners = EffectArray.sort(
    DATABASE_IDENTITIES.filter(({ runsActions }) => runsActions).map(({ role }) => role),
    Order.String,
  );
  for (const routine of TRUST_ROUTINES) {
    const executors = EffectArray.sort(routine.executableBy, Order.String);
    if (routine.signature.startsWith('trust.register_gateway_scope_grant(')) {
      expect(executors).toEqual(registrars);
      expect(routine.securityDefiner).toBe(true);
    } else if (
      routine.signature === lockAccessScopeFenceSignature ||
      routine.signature === lockSourceExecutionFenceSignature ||
      routine.signature === readSourceExecutionFenceSignature
    ) {
      expect(executors).toEqual(actionRunners);
      expect(executors).toEqual(['ontos_runtime', 'party_registry_runtime']);
      expect(routine.securityDefiner).toBe(true);
    } else if (
      routine.signature === openSourceExecutionFenceSignature ||
      routine.signature === openGatedSourceExecutionFenceSignature ||
      routine.signature === cancelSourceExecutionFenceSignature
    ) {
      expect(executors, routine.signature).toEqual(['ontos_runtime']);
      expect(routine.securityDefiner).toBe(true);
    } else if (sourceExecutionGateAdminSignatures.includes(routine.signature)) {
      expect(executors, routine.signature).toEqual([]);
      expect(routine.securityDefiner).toBe(true);
    } else if (routine.signature === registeredWorkloadDeliverySignature) {
      expect(executors).toEqual(EffectArray.sort(['ontos_runtime', ...gatewayGrantRoles], Order.String));
      expect(executors).toEqual(['ontos_runtime', 'party_registry_runtime']);
      expect(routine.securityDefiner).toBe(true);
    } else if (routine.securityDefiner) {
      expect(executors, routine.signature).toEqual(gatewayGrantRoles);
    } else {
      expect(executors, routine.signature).toEqual([]);
    }
  }
  expect(TRUST_ROUTINES.map(({ signature }) => signature)).toEqual([
    openSourceExecutionFenceSignature,
    openGatedSourceExecutionFenceSignature,
    ...sourceExecutionGateAdminSignatures,
    cancelSourceExecutionFenceSignature,
    lockSourceExecutionFenceSignature,
    readSourceExecutionFenceSignature,
    registeredWorkloadDeliverySignature,
    'trust.register_gateway_scope_grant(text,text,uuid,uuid,uuid,uuid,timestamptz)',
    'trust.establish_gateway_scope(text)',
    'trust.current_tenant_id()',
    'trust.current_legal_entity_id()',
    lockAccessScopeFenceSignature,
    'trust.verified_scope()',
    'trust.scope_payload(xid8,timestamptz,uuid,uuid)',
    'trust.scope_mac(text)',
  ]);
  expect(new Set(TRUST_ROUTINES.map(({ signature }) => signature)).size).toBe(TRUST_ROUTINES.length);
});

it('never accepts findings for all objects on an explicit identity', () => {
  for (const { grants, identity } of explicitEntries) {
    for (const finding of grants.acceptedFindings) {
      expect(finding.objects, `${identity.role} ${finding.code}`).not.toBe('all');
      expect(Array.isArray(finding.objects) && finding.objects.length > 0).toBe(true);
      expect(finding.reason.trim()).not.toBe('');
    }
  }
});

it('pins the bearer-assertion logging settings exactly on the roles that handle bearer assertions', () => {
  for (const entry of DATABASE_ROLE_GRANT_MANIFEST) {
    expect(entry.roleSettings, entry.identity.role).toEqual(
      entry.identity.handlesBearerAssertions ? [...BEARER_ASSERTION_ROLE_SETTINGS] : [],
    );
    expect(entry.databaseTemporary, entry.identity.role).toBe(entry.kind === 'legacy_shared');
  }
});
