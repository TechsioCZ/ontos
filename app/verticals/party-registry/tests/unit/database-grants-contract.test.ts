import { getTableConfig } from 'drizzle-orm/pg-core';
import { expect, it } from 'effect-rstest';

import {
  PARTY_REGISTRY_REQUEST_DATABASE_GRANTS,
  PARTY_REGISTRY_WORKER_DATABASE_GRANTS,
} from '../../src/db/database-grants.ts';
import { CONTACTS_SCHEMA_NAME, CONTACTS_TABLES } from '../../src/db/engagement-schema.ts';
import { PARTY_SCHEMA_NAME, PARTY_TABLES } from '../../src/db/schema.ts';
import { partyRegistryManifest } from '../../vertical.manifest.ts';

const qualifiedName = (table: (typeof PARTY_TABLES)[number] | (typeof CONTACTS_TABLES)[number]): string => {
  const config = getTableConfig(table);
  return `${config.schema}.${config.name}`;
};

const workerPolicyTables = [...PARTY_TABLES, ...CONTACTS_TABLES]
  .filter((table) => getTableConfig(table).policies.some((policy) => policy.to === 'party_registry_worker'))
  .map(qualifiedName)
  .toSorted();

it('prefixes every Party Action key with party.registry. so Core action RLS admits it', () => {
  const actionKeys = partyRegistryManifest.publicSurface.actions.map((action) => action.descriptor.actionKey);
  expect(actionKeys.length).toBeGreaterThan(0);
  for (const actionKey of actionKeys) {
    expect(actionKey.startsWith('party.registry.'), actionKey).toBe(true);
  }
});

it('declares worker read policies on exactly the Party tables the worker may select', () => {
  const workerPartySelects = PARTY_REGISTRY_WORKER_DATABASE_GRANTS.tables
    .filter((grant) => grant.table.startsWith(`${PARTY_SCHEMA_NAME}.`) && grant.privileges.includes('select'))
    .map((grant) => grant.table)
    .toSorted();
  expect(workerPolicyTables).toEqual(workerPartySelects);
  for (const table of workerPolicyTables) {
    const grant = PARTY_REGISTRY_WORKER_DATABASE_GRANTS.tables.find((candidate) => candidate.table === table);
    expect(grant?.privileges).toEqual(['select']);
  }
});

it('never grants table-wide reads of Core identity tables', () => {
  for (const grants of [PARTY_REGISTRY_REQUEST_DATABASE_GRANTS, PARTY_REGISTRY_WORKER_DATABASE_GRANTS]) {
    for (const grant of grants.tables) {
      if (['core.principals', 'core.legal_entities', 'core.principal_auth_bindings'].includes(grant.table)) {
        expect(grant.privileges.includes('select'), grant.table).toBe(true);
        expect(grant.columns?.select, `${grant.table} must use a column grant`).toBeDefined();
      }
    }
  }
});

it('grants the request role full DML on every RLS-protected Party and Contacts table and nothing more', () => {
  const rlsTables = [...PARTY_TABLES, ...CONTACTS_TABLES]
    .filter((table) => getTableConfig(table).enableRLS)
    .map(qualifiedName)
    .toSorted();
  const ownedGrants = PARTY_REGISTRY_REQUEST_DATABASE_GRANTS.tables.filter(
    (grant) =>
      grant.table.startsWith(`${PARTY_SCHEMA_NAME}.`) ||
      (grant.table.startsWith(`${CONTACTS_SCHEMA_NAME}.`) && grant.table !== 'contacts.gateway_assertion_redemptions'),
  );
  expect(ownedGrants.map((grant) => grant.table).toSorted()).toEqual(rlsTables);
  for (const grant of ownedGrants) {
    expect(grant.privileges).toEqual(['select', 'insert', 'update', 'delete']);
    expect(grant.columns).toBeUndefined();
  }
});

it('keeps every grant explained, qualified, unique and inside its declared schemas', () => {
  for (const grants of [PARTY_REGISTRY_REQUEST_DATABASE_GRANTS, PARTY_REGISTRY_WORKER_DATABASE_GRANTS]) {
    const tables = grants.tables.map((grant) => grant.table);
    expect(new Set(tables).size).toBe(tables.length);
    for (const grant of [...grants.tables, ...grants.sequences]) {
      expect(grant.reason.trim().length).toBeGreaterThan(0);
    }
    for (const name of [...tables, ...grants.sequences.map((grant) => grant.sequence)]) {
      const [schema, relation] = name.split('.');
      expect(relation, name).toBeDefined();
      expect(grants.schemas, name).toContain(schema);
    }
    for (const grant of grants.tables) {
      for (const privilege of Object.keys(grant.columns ?? {})) {
        expect(grant.privileges, `${grant.table} column privilege ${privilege}`).toContain(privilege);
      }
    }
    for (const finding of grants.acceptedFindings) {
      expect(finding.objects).not.toBe('all');
    }
  }
  expect(PARTY_REGISTRY_WORKER_DATABASE_GRANTS.schemas).not.toContain('contacts');
  expect(PARTY_REGISTRY_WORKER_DATABASE_GRANTS.schemas).not.toContain('trust');
  expect(PARTY_REGISTRY_WORKER_DATABASE_GRANTS.routines).toEqual([]);
});
