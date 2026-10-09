import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { NodeFileSystem } from '@effect/platform-node';
import { Effect, FileSystem } from 'effect';
import { expect, it } from 'effect-rstest';

import { principalAuthBindings } from '../../src/db/schema.ts';

it('stores an opaque namespace key, generic lifecycle state, and invocation provenance', () => {
  const config = getTableConfig(principalAuthBindings);
  const columns = new Map(config.columns.map((column) => [column.name, column]));
  const namespaceColumn = columns.get('authentication_namespace_id');
  const revisionColumn = columns.get('binding_revision');
  const createdByInvocationColumn = columns.get('created_by_invocation_id');
  const lastTransitionRefColumn = columns.get('last_transition_ref');
  if (
    namespaceColumn === undefined ||
    revisionColumn === undefined ||
    createdByInvocationColumn === undefined ||
    lastTransitionRefColumn === undefined
  ) {
    expect.unreachable('Expected namespace, revision, and provenance columns');
  }
  expect(namespaceColumn.notNull).toBe(true);
  expect(namespaceColumn.getSQLType()).toBe('text');
  expect(revisionColumn.notNull).toBe(true);
  expect(revisionColumn.hasDefault).toBe(true);
  expect(revisionColumn.getSQLType()).toBe('integer');
  expect(createdByInvocationColumn.notNull).toBe(false);
  expect(createdByInvocationColumn.getSQLType()).toBe('uuid');
  expect(lastTransitionRefColumn.notNull).toBe(false);
  expect(lastTransitionRefColumn.getSQLType()).toBe('uuid');

  const indexByName = new Map(config.indexes.map((index) => [index.config.name, index.config]));
  expect(
    indexByName
      .get('core_auth_bindings_namespace_subject_uk')
      ?.columns.map((column) => ('name' in column ? column.name : '')),
  ).toEqual(['tenant_id', 'authentication_namespace_id', 'subject_type', 'provider_subject_id']);
  expect(
    indexByName
      .get('core_auth_bindings_api_key_subject_global_uk')
      ?.columns.map((column) => ('name' in column ? column.name : '')),
  ).toEqual(['provider', 'subject_type', 'provider_subject_id']);
  expect(indexByName.get('core_auth_bindings_api_key_subject_global_uk')?.where).toBeDefined();
  expect(indexByName.has('core_auth_bindings_subject_uk')).toBe(false);
  expect([...indexByName.keys()].some((name) => name?.toLowerCase().includes('commerce') === true)).toBe(false);

  const dialect = new PgDialect();
  const checks = new Map(config.checks.map((check) => [check.name, dialect.sqlToQuery(check.value).sql]));
  expect(checks.get('core_auth_bindings_provider_ck')).toMatch(/length.*between 1 and 500/u);
  expect(checks.get('core_auth_bindings_namespace_ck')).toMatch(/authentication_namespace_id/u);
  expect(checks.get('core_auth_bindings_subject_id_ck')).toMatch(/between 1 and 500/u);
  expect(checks.get('core_auth_bindings_status_ck')).toMatch(/pending/u);
  expect(checks.get('core_auth_bindings_revision_ck')).toMatch(/binding_revision/u);
  expect(checks.has('core_auth_bindings_pending_ck')).toBe(false);
});

it.layer(NodeFileSystem.layer)('Core namespace migration source', (suite) => {
  suite.effect('requires the namespace while initializing the empty database schema', () =>
    Effect.gen(function* migrationSourceTest() {
      const fileSystem = yield* FileSystem.FileSystem;
      const source = yield* fileSystem.readFileString(
        new URL('../../drizzle/20260916130129_auth-namespace-bindings/migration.sql', import.meta.url).pathname,
      );
      const verifier = yield* fileSystem.readFileString(
        new URL('../../scripts/verify-db-schema.mts', import.meta.url).pathname,
      );
      const position = (needle: string): number => {
        const offset = source.indexOf(needle);
        if (offset === -1) {
          expect.unreachable(`Expected migration statement: ${needle}`);
        }
        return offset;
      };

      expect(source).toContain('ADD COLUMN "authentication_namespace_id" text NOT NULL');
      expect(source).toContain('created_by_invocation_id');
      expect(source).toContain('last_transition_ref');
      expect(source).not.toMatch(/commerce|staff|better_auth/iu);
      expect(source).not.toMatch(
        /inventory|backfill|evidence_ref|lock table|update "core"\."principal_auth_bindings"/iu,
      );
      expect(position('ADD COLUMN "authentication_namespace_id" text NOT NULL')).toBeLessThan(
        position('CREATE UNIQUE INDEX "core_auth_bindings_namespace_subject_uk"'),
      );
      expect(position('CREATE UNIQUE INDEX "core_auth_bindings_namespace_subject_uk"')).toBeLessThan(
        position('DROP INDEX IF EXISTS "core"."core_auth_bindings_subject_uk"'),
      );

      expect(verifier).toContain('Core authentication binding constraints are missing or unexpected');
      expect(verifier).toContain('Core authentication binding indexes are missing or unexpected');
      expect(verifier).not.toContain('core_auth_bindings_subject_uk');
      expect(verifier).not.toContain('core_auth_bindings_commerce');
    }),
  );
});
