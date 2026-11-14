import { ACCESS_DECISION_REQUEST_GRANTS } from '@app/core-runtime';
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

/**
 * Party tables the request role reaches through a narrower declared grant instead of blanket DML: the
 * assertion identity registry is append-only beside the current store, and the historical-name archive
 * is owner-written history the runtime may only read.
 */
const LEAST_PRIVILEGE_PARTY_TABLES: readonly string[] = [
  'party.party_fact_assertion_identities',
  'party.party_historical_name_assertions',
];

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

it('covers RLS-protected Party and Contacts tables while keeping source receipts append-only', () => {
  const rlsTables = [...PARTY_TABLES, ...CONTACTS_TABLES]
    .filter((table) => getTableConfig(table).enableRLS)
    .map(qualifiedName)
    .filter((table) => table !== 'party.party_ico_correlation_epochs')
    .toSorted();
  const ownedGrants = PARTY_REGISTRY_REQUEST_DATABASE_GRANTS.tables.filter(
    (grant) =>
      grant.table.startsWith(`${PARTY_SCHEMA_NAME}.`) ||
      (grant.table.startsWith(`${CONTACTS_SCHEMA_NAME}.`) && grant.table !== 'contacts.gateway_assertion_redemptions'),
  );
  expect(ownedGrants.map((grant) => grant.table).toSorted()).toEqual(rlsTables);
  for (const grant of ownedGrants) {
    if (LEAST_PRIVILEGE_PARTY_TABLES.includes(grant.table)) {
      continue;
    }
    expect(grant.privileges).toEqual(
      [
        'party.party_create_source_receipts',
        'party.party_source_effect_receipts',
        'party.party_legacy_ico_authority_fences',
      ].includes(grant.table)
        ? ['select', 'insert']
        : ['select', 'insert', 'update', 'delete'],
    );
    expect(grant.columns).toBeUndefined();
  }
});

it('reaches the assertion identity registry and its archive with the narrowest declared privileges', () => {
  const byTable = new Map(PARTY_REGISTRY_REQUEST_DATABASE_GRANTS.tables.map((grant) => [grant.table, grant]));
  // The registry is appended by the assertion trigger as the request role; the archive is owner-written.
  expect(byTable.get('party.party_fact_assertion_identities')?.privileges).toEqual(['select', 'insert']);
  expect(byTable.get('party.party_historical_name_assertions')?.privileges).toEqual(['select']);
  for (const table of LEAST_PRIVILEGE_PARTY_TABLES) {
    expect(byTable.get(table)?.columns, table).toBeUndefined();
    expect(
      PARTY_REGISTRY_WORKER_DATABASE_GRANTS.tables.some((grant) => grant.table === table),
      table,
    ).toBe(false);
  }
});

it('composes the Core access-decision request grants into the Party request identity', () => {
  const byTable = new Map(PARTY_REGISTRY_REQUEST_DATABASE_GRANTS.tables.map((grant) => [grant.table, grant]));
  for (const grant of ACCESS_DECISION_REQUEST_GRANTS) {
    const composed = byTable.get(grant.table);
    expect(composed, grant.table).toBeDefined();
    for (const privilege of grant.privileges) {
      expect(composed?.privileges, grant.table).toContain(privilege);
    }
    for (const privilege of ['insert', 'select', 'update'] as const) {
      const extra = grant.columns?.[privilege];
      if (extra === undefined) {
        continue;
      }
      const composedColumns = composed?.columns?.[privilege];
      expect(composedColumns, `${grant.table} ${privilege} columns`).toBeDefined();
      for (const column of extra) {
        expect(composedColumns, `${grant.table} ${privilege} ${column}`).toContain(column);
      }
    }
  }
  // The merge adds the gate's `kind` beside the identity columns Party already read, and never widens
  // a Party grant: the composed column set is exactly the union of both declarations.
  expect(byTable.get('core.principals')?.columns?.select).toEqual(['kind', 'principal_id', 'status', 'tenant_id']);
  expect(byTable.get('core.principals')?.privileges).toEqual(['select']);
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
