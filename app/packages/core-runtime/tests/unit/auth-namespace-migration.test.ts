import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { NodeFileSystem } from '@effect/platform-node';
import { Effect, FileSystem } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  AUTH_NAMESPACE_INVENTORY_TABLE_DDL,
  decodeAuthNamespaceInventory,
  validateAuthNamespaceInventory,
} from '../../scripts/prepare-auth-namespace-inventory.mts';
import type { AuthNamespaceInventoryDocument } from '../../scripts/prepare-auth-namespace-inventory.mts';
import {
  AuthBindingIdSchema,
  AuthenticationNamespaceIdSchema,
  PrincipalIdSchema,
  ProviderSubjectIdSchema,
  TenantIdSchema,
} from '../../src/auth/external-identity-contracts.ts';
import { principalAuthBindings } from '../../src/db/schema.ts';

const ids = {
  bindingOne: AuthBindingIdSchema.make('70000000-0000-4000-8000-000000000001'),
  bindingThree: AuthBindingIdSchema.make('70000000-0000-4000-8000-000000000003'),
  bindingTwo: AuthBindingIdSchema.make('70000000-0000-4000-8000-000000000002'),
  principalOne: PrincipalIdSchema.make('40000000-0000-4000-8000-000000000001'),
  principalTwo: PrincipalIdSchema.make('40000000-0000-4000-8000-000000000002'),
  tenantOne: TenantIdSchema.make('30000000-0000-4000-8000-000000000001'),
} as const;

const reviewedEntry = {
  authenticationNamespaceId: AuthenticationNamespaceIdSchema.make('test.provider.primary.v1'),
  evidenceRef: 'review://issue-337/namespace-binding-001',
  principalAuthBindingId: ids.bindingOne,
  principalId: ids.principalOne,
  provider: 'test-provider',
  providerSubjectId: ProviderSubjectIdSchema.make('subject-001'),
  subjectType: 'user' as const,
  tenantId: ids.tenantOne,
} as const;

const reviewedInventory: AuthNamespaceInventoryDocument = {
  entries: [reviewedEntry],
  version: 1,
};

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
  suite.effect('keeps the migration fail-closed for populated databases and expands before tightening', () =>
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

      expect(source).toContain('principal_auth_binding_namespace_inventory');
      expect(source).toContain('Reviewed namespace inventory is required for every existing Core auth binding');
      expect(source).toContain('Reviewed namespace inventory does not exactly match');
      expect(source).toContain('unsupported value or malformed evidence reference');
      expect(source).toContain(
        'Existing Core auth bindings contain a provider subject outside the supported 1..500 character range',
      );
      expect(source).toContain('LOCK TABLE "core"."principal_auth_bindings" IN ACCESS EXCLUSIVE MODE');
      expect(source).toContain('created_by_invocation_id');
      expect(source).toContain('last_transition_ref');
      expect(source).not.toMatch(/commerce|staff|better_auth/iu);
      expect(source).not.toContain('ADD COLUMN "authentication_namespace_id" text NOT NULL');

      expect(position('CREATE TABLE IF NOT EXISTS')).toBeLessThan(
        position('ADD COLUMN "authentication_namespace_id" text'),
      );
      expect(position('ADD COLUMN "authentication_namespace_id" text')).toBeLessThan(
        position('ALTER COLUMN "authentication_namespace_id" SET NOT NULL'),
      );
      expect(position('UPDATE "core"."principal_auth_bindings"')).toBeLessThan(
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

it('accepts arbitrary reviewed namespace data while rejecting duplicate canonical keys', () => {
  expect(validateAuthNamespaceInventory(reviewedInventory)).toEqual([]);
  expect(AUTH_NAMESPACE_INVENTORY_TABLE_DDL).toContain('evidence_ref');
  expect(AUTH_NAMESPACE_INVENTORY_TABLE_DDL).toContain('authentication_namespace_id');

  const thirdNamespace = decodeAuthNamespaceInventory({
    ...reviewedInventory,
    entries: [{ ...reviewedEntry, authenticationNamespaceId: 'another.trusted.realm.v2' }],
  });
  expect(thirdNamespace.entries[0]?.authenticationNamespaceId).toBe('another.trusted.realm.v2');

  expect(() =>
    decodeAuthNamespaceInventory({
      ...reviewedInventory,
      entries: [{ ...reviewedEntry, authenticationNamespaceId: ' ' }],
    }),
  ).toThrow();
  expect(() =>
    decodeAuthNamespaceInventory({
      ...reviewedInventory,
      entries: [{ ...reviewedEntry, providerSubjectId: 'x'.repeat(501) }],
    }),
  ).toThrow();

  expect(
    validateAuthNamespaceInventory({
      ...reviewedInventory,
      entries: [
        reviewedEntry,
        {
          ...reviewedEntry,
          principalAuthBindingId: ids.bindingTwo,
          providerSubjectId: reviewedEntry.providerSubjectId,
        },
      ],
    })[0],
  ).toMatch(/duplicate namespace subject/u);
});

it('preserves provider-wide API-key cardinality independently of namespace', () => {
  const firstApiKey = {
    ...reviewedEntry,
    principalAuthBindingId: ids.bindingTwo,
    principalId: ids.principalTwo,
    providerSubjectId: ProviderSubjectIdSchema.make('same-api-key'),
    subjectType: 'api_key' as const,
  };
  const secondApiKey = {
    ...firstApiKey,
    authenticationNamespaceId: AuthenticationNamespaceIdSchema.make('another.trusted.realm.v2'),
    principalAuthBindingId: ids.bindingThree,
  };
  expect(
    validateAuthNamespaceInventory({
      ...reviewedInventory,
      entries: [firstApiKey, secondApiKey],
    })[0],
  ).toMatch(/duplicate global API-key subject/u);
});
