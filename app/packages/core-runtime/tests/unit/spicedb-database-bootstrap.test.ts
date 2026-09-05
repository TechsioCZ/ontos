// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseSpiceDbDatabaseBootstrapConfig } from '../../src/install/spicedb-database-config.ts';
import { toModuleAccessObjectId } from '../../src/permissions/context-access.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';

const extractSchema = (source: string): string =>
  source
    .slice(
      'schema: |-\n'.length,
      source.includes('\nrelationships: |-')
        ? source.indexOf('\nrelationships: |-')
        : source.length,
    )
    .trimEnd()
    .split('\n')
    .map((line) => line.replace(/^ {2}/u, ''))
    .join('\n');

test('accepts a distinct SpiceDB role and database on the administrative server', () => {
  assert.deepEqual(
    parseSpiceDbDatabaseBootstrapConfig({
      DATABASE_ADMIN_URL: 'postgresql://db:admin@db:5432/db',
      SPICEDB_DATABASE_URL: 'postgresql://spicedb:p%40ssword@db:5432/spicedb',
    }),
    {
      adminUrl: 'postgresql://db:admin@db:5432/db',
      database: 'spicedb',
      password: 'p@ssword',
      user: 'spicedb',
    },
  );
});

test('rejects unsafe SpiceDB database bootstrap targets', () => {
  for (const environment of [
    {},
    {
      DATABASE_ADMIN_URL: 'postgresql://db:admin@db:5432/db',
      SPICEDB_DATABASE_URL: 'postgresql://postgres:secret@db:5432/spicedb',
    },
    {
      DATABASE_ADMIN_URL: 'postgresql://db:admin@db:5432/db',
      SPICEDB_DATABASE_URL: 'postgresql://spicedb:secret@other-db:5432/spicedb',
    },
    {
      DATABASE_ADMIN_URL: 'postgresql://db:admin@db:5432/db',
      SPICEDB_DATABASE_URL: 'postgresql://spicedb:secret@db:5432/ontos',
    },
  ]) {
    assert.throws(() => parseSpiceDbDatabaseBootstrapConfig(environment));
  }
});

test('keeps the stage bootstrap schema aligned without development relationships', async () => {
  const development = await readFile(
    new URL('../../spicedb/bootstrap.yaml', import.meta.url),
    'utf-8',
  );
  const stage = await readFile(
    new URL('../../spicedb/stage-bootstrap.yaml', import.meta.url),
    'utf-8',
  );
  assert.equal(extractSchema(development), ONTOS_SPICEDB_SCHEMA);
  assert.equal(extractSchema(stage), ONTOS_SPICEDB_SCHEMA);
  assert.doesNotMatch(stage, /relationships:|assertions:/u);
  assert.match(development, /#executor@tenant:test-tenant#member/u);
  assert.match(development, /#executor@principal:allowed-principal/u);
});

test('grants fresh development module access only to Contacts', async () => {
  const development = await readFile(
    new URL('../../spicedb/bootstrap.yaml', import.meta.url),
    'utf-8',
  );
  const tenantId = '50000000-0000-4000-8000-000000000001';
  const legalEntityId = '55000000-0000-4000-8000-000000000001';
  const contactsObjectId = toModuleAccessObjectId(tenantId, legalEntityId, 'contacts.core');
  assert.ok(contactsObjectId !== undefined && contactsObjectId.length > 0);
  assert.deepEqual(
    development.match(
      /^ {2}module_access:\S+#accessor@principal:60000000-0000-4000-8000-000000000001$/gmu,
    ),
    [`  module_access:${contactsObjectId}#accessor@principal:60000000-0000-4000-8000-000000000001`],
  );
});

test('declares the complete Party tenant permission vocabulary', async () => {
  const development = await readFile(
    new URL('../../spicedb/bootstrap.yaml', import.meta.url),
    'utf-8',
  );
  for (const permission of [
    'manage_party_identity',
    'manage_party_relationships',
    'merge_party_identity',
    'read_party_identity',
    'review_party_identity',
  ]) {
    assert.match(development, new RegExp(`permission ${permission} =`, 'u'));
  }
});

test('declares the Counterparty Legal Entity permission vocabulary', async () => {
  const development = await readFile(
    new URL('../../spicedb/bootstrap.yaml', import.meta.url),
    'utf-8',
  );
  for (const permission of ['manage_counterparty', 'read_counterparty']) {
    assert.match(development, new RegExp(`permission ${permission} =`, 'u'));
  }
});
