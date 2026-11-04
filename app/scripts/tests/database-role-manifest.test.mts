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
      expect(entry?.kind, `${role} executes ${routine.signature}`).toBe('explicit');
      if (entry?.kind === 'explicit') {
        expect(entry.grants.routines).toContain(routine.signature);
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
  for (const routine of TRUST_ROUTINES) {
    const executors = EffectArray.sort(routine.executableBy, Order.String);
    if (routine.signature.startsWith('trust.register_gateway_scope_grant(')) {
      expect(executors).toEqual(registrars);
      expect(routine.securityDefiner).toBe(true);
    } else if (routine.securityDefiner) {
      expect(executors, routine.signature).toEqual(gatewayGrantRoles);
    } else {
      expect(executors, routine.signature).toEqual([]);
    }
  }
  expect(TRUST_ROUTINES).toHaveLength(7);
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
