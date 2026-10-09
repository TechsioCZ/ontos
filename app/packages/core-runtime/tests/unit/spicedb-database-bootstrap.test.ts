import { fileURLToPath } from 'node:url';

import { NodeFileSystem } from '@effect/platform-node';
import { Effect, FileSystem, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';

import { parseSpiceDbDatabaseBootstrapConfig } from '../../src/install/spicedb-database-config.ts';
import { toModuleAccessObjectId } from '../../src/permissions/context-access.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';

const extractSchema = (source: string): string =>
  source
    .slice(
      'schema: |-\n'.length,
      source.includes('\nrelationships: |-') ? source.indexOf('\nrelationships: |-') : source.length,
    )
    .trimEnd()
    .split('\n')
    .map((line) => line.replace(/^ {2}/u, ''))
    .join('\n');

it('bootstraps the fixed SpiceDB role and database with the exact configured password', () => {
  expect(
    parseSpiceDbDatabaseBootstrapConfig({
      DATABASE_ADMIN_URL: 'postgresql://db:admin@db:5432/db',
      SPICEDB_DATABASE_PASSWORD: Redacted.make(' p@ss:w/o%rd#? '),
    }),
  ).toEqual({
    adminUrl: 'postgresql://db:admin@db:5432/db',
    database: 'spicedb',
    password: ' p@ss:w/o%rd#? ',
    user: 'spicedb',
  });
});

it('rejects unsafe SpiceDB database bootstrap configuration', () => {
  for (const environment of [
    {},
    { DATABASE_ADMIN_URL: 'postgresql://db:admin@db:5432/db' },
    { DATABASE_ADMIN_URL: 'postgresql://db:admin@db:5432/db', SPICEDB_DATABASE_PASSWORD: Redacted.make('') },
    { DATABASE_ADMIN_URL: 'mysql://db:admin@db:3306/db', SPICEDB_DATABASE_PASSWORD: Redacted.make('secret') },
    { DATABASE_ADMIN_URL: 'postgresql://spicedb:admin@db:5432/db', SPICEDB_DATABASE_PASSWORD: Redacted.make('secret') },
  ]) {
    expect(() => parseSpiceDbDatabaseBootstrapConfig(environment)).toThrow();
  }
});

it.layer(NodeFileSystem.layer)('SpiceDB bootstrap sources', (suite) => {
  suite.effect('keeps the stage bootstrap schema aligned without development relationships', () =>
    Effect.gen(function* testScenario1() {
      const fs = yield* FileSystem.FileSystem;
      const development = yield* fs.readFileString(
        fileURLToPath(new URL('../../spicedb/bootstrap.yaml', import.meta.url)),
      );
      const stage = yield* fs.readFileString(
        fileURLToPath(new URL('../../spicedb/stage-bootstrap.yaml', import.meta.url)),
      );
      expect(extractSchema(development)).toBe(ONTOS_SPICEDB_SCHEMA);
      expect(extractSchema(stage)).toBe(ONTOS_SPICEDB_SCHEMA);
      expect(stage).not.toMatch(/relationships:|assertions:/u);
      expect(development).toMatch(/#executor@tenant:test-tenant#member/u);
      expect(development).toMatch(/#executor@principal:allowed-principal/u);
      expect(development).toMatch(/relation containing_catalog: business_permission/u);
      expect(development).toMatch(
        /permission use = direct_use \+ \(tenant->access & containing_catalog->direct_use\)/u,
      );
    }),
  );

  suite.effect('grants fresh development module access only to Contacts', () =>
    Effect.gen(function* testScenario2() {
      const fs = yield* FileSystem.FileSystem;
      const development = yield* fs.readFileString(
        fileURLToPath(new URL('../../spicedb/bootstrap.yaml', import.meta.url)),
      );
      const tenantId = '50000000-0000-4000-8000-000000000001';
      const legalEntityId = '55000000-0000-4000-8000-000000000001';
      const contactsObjectId = toModuleAccessObjectId(tenantId, legalEntityId, 'contacts.core');
      expect(contactsObjectId !== undefined && contactsObjectId.length > 0).toBe(true);
      expect(
        development.match(/^ {2}module_access:\S+#accessor@principal:60000000-0000-4000-8000-000000000001$/gmu),
      ).toEqual([`  module_access:${contactsObjectId}#accessor@principal:60000000-0000-4000-8000-000000000001`]);
    }),
  );

  suite.effect('declares the complete Party tenant permission vocabulary', () =>
    Effect.gen(function* testScenario3() {
      const fs = yield* FileSystem.FileSystem;
      const development = yield* fs.readFileString(
        fileURLToPath(new URL('../../spicedb/bootstrap.yaml', import.meta.url)),
      );
      for (const permission of [
        'manage_party_identity',
        'manage_party_relationships',
        'merge_party_identity',
        'read_party_identity',
        'review_party_identity',
      ]) {
        expect(development).toMatch(new RegExp(`permission ${permission} =`, 'u'));
      }
    }),
  );

  suite.effect('declares the Counterparty Legal Entity permission vocabulary', () =>
    Effect.gen(function* testScenario4() {
      const fs = yield* FileSystem.FileSystem;
      const development = yield* fs.readFileString(
        fileURLToPath(new URL('../../spicedb/bootstrap.yaml', import.meta.url)),
      );
      for (const permission of ['manage_counterparty', 'read_counterparty']) {
        expect(development).toMatch(new RegExp(`permission ${permission} =`, 'u'));
      }
    }),
  );
});
