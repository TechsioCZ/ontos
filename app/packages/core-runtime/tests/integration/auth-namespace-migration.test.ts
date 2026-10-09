import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Crypto, Effect, Exit, FileSystem, Option } from 'effect';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { expect, it } from 'effect-rstest';

import { findPostgresFailure } from '../../src/database/postgres-failure.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { makeTestPgClient } from '../support/database.ts';

const migrationPath = new URL('../../drizzle/20260916130129_auth-namespace-bindings/migration.sql', import.meta.url)
  .pathname;

const ids = {
  bindingCrossTenant: '71000000-0000-4000-8000-000000000010',
  bindingEight: '71000000-0000-4000-8000-000000000009',
  bindingFive: '71000000-0000-4000-8000-000000000005',
  bindingFour: '71000000-0000-4000-8000-000000000004',
  bindingOne: '71000000-0000-4000-8000-000000000001',
  bindingSeven: '71000000-0000-4000-8000-000000000008',
  bindingSix: '71000000-0000-4000-8000-000000000006',
  bindingThree: '71000000-0000-4000-8000-000000000003',
  bindingTwo: '71000000-0000-4000-8000-000000000002',
  invocationOne: '51000000-0000-4000-8000-000000000001',
  otherTenant: '31000000-0000-4000-8000-000000000002',
  principalEight: '41000000-0000-4000-8000-000000000008',
  principalFive: '41000000-0000-4000-8000-000000000005',
  principalFour: '41000000-0000-4000-8000-000000000004',
  principalOne: '41000000-0000-4000-8000-000000000001',
  principalSeven: '41000000-0000-4000-8000-000000000007',
  principalSix: '41000000-0000-4000-8000-000000000006',
  principalThree: '41000000-0000-4000-8000-000000000003',
  principalTwo: '41000000-0000-4000-8000-000000000002',
  tenant: '31000000-0000-4000-8000-000000000001',
  transitionOne: '52000000-0000-4000-8000-000000000001',
} as const;

const baseBinding = {
  provider: 'test-provider',
  status: 'active',
  subjectType: 'user',
} as const;

interface MigrationSchema {
  readonly name: string;
  readonly quotedName: string;
}

const query = <Row extends object>(client: PgClient.PgClient, text: string, values: readonly unknown[] = []) =>
  client.unsafe<Row>(text, values);

const failedConstraint = (failure: SqlError) => Option.getOrUndefined(findPostgresFailure(failure))?.constraint;

const dropSchema = (pool: PgClient.PgClient, schema: MigrationSchema) =>
  query(pool, `drop schema if exists ${schema.quotedName} cascade`).pipe(Effect.orDie);

const makeMigrationSchema = (pool: PgClient.PgClient, crypto: Crypto.Crypto) =>
  Effect.gen(function* makeMigrationSchemaEffect() {
    const name = `core_auth_namespace_${(yield* crypto.randomUUIDv4).replaceAll('-', '')}`;
    const quotedName = `"${name}"`;
    yield* query(pool, `create schema ${quotedName}`);
    yield* query(
      pool,
      `create table ${quotedName}.principals (
        principal_id uuid primary key,
        tenant_id uuid not null
      )`,
    );
    yield* query(
      pool,
      `create unique index core_principals_tenant_id_uk
       on ${quotedName}.principals (tenant_id, principal_id)`,
    );
    yield* query(
      pool,
      `create table ${quotedName}.principal_auth_bindings (
        principal_auth_binding_id uuid primary key,
        tenant_id uuid not null,
        principal_id uuid not null,
        provider text not null,
        subject_type text not null,
        provider_subject_id text not null,
        status text not null,
        revoked_at timestamptz,
        constraint core_auth_bindings_provider_ck check (provider in ('test-provider')),
        constraint core_auth_bindings_subject_type_ck check (subject_type in ('user', 'api_key')),
        constraint core_auth_bindings_status_ck check (status in ('active', 'revoked', 'disabled')),
        constraint core_auth_bindings_lifecycle_ck check (
          (status = 'revoked' and revoked_at is not null)
          or (status in ('active', 'disabled') and revoked_at is null)
        )
      )`,
    );
    yield* query(
      pool,
      `create unique index core_auth_bindings_tenant_id_uk
       on ${quotedName}.principal_auth_bindings (tenant_id, principal_auth_binding_id)`,
    );
    yield* query(
      pool,
      `create unique index core_auth_bindings_subject_uk
       on ${quotedName}.principal_auth_bindings (tenant_id, provider, subject_type, provider_subject_id)`,
    );
    yield* query(
      pool,
      `create unique index core_auth_bindings_api_key_subject_global_uk
       on ${quotedName}.principal_auth_bindings (provider, subject_type, provider_subject_id)
       where subject_type = 'api_key'`,
    );
    yield* query(
      pool,
      `create index core_auth_bindings_principal_idx
       on ${quotedName}.principal_auth_bindings (principal_id)`,
    );
    yield* query(
      pool,
      `alter table ${quotedName}.principal_auth_bindings
       add constraint core_auth_bindings_tenant_principal_fk
       foreign key (tenant_id, principal_id)
       references ${quotedName}.principals (tenant_id, principal_id)
       on delete restrict`,
    );
    return { name, quotedName };
  });

const insertPrincipal = (
  pool: PgClient.PgClient,
  schema: MigrationSchema,
  principalId: string,
  tenantId: string = ids.tenant,
) =>
  query(
    pool,
    `insert into ${schema.quotedName}.principals (principal_id, tenant_id)
     values ($1, $2)`,
    [principalId, tenantId],
  );

const insertBinding = (
  pool: PgClient.PgClient,
  schema: MigrationSchema,
  binding: {
    readonly authenticationNamespaceId: string;
    readonly createdByInvocationId?: string | null;
    readonly lastTransitionRef?: string | null;
    readonly principalAuthBindingId: string;
    readonly principalId: string;
    readonly provider?: string;
    readonly providerSubjectId: string;
    readonly revokedAt?: Date | string | null;
    readonly status?: string;
    readonly subjectType?: string;
    readonly tenantId?: string;
  },
) => {
  const values = [
    binding.principalAuthBindingId,
    binding.tenantId ?? ids.tenant,
    binding.principalId,
    binding.authenticationNamespaceId,
    binding.provider ?? baseBinding.provider,
    binding.subjectType ?? baseBinding.subjectType,
    binding.providerSubjectId,
    binding.status ?? baseBinding.status,
    binding.revokedAt ?? null,
  ];
  if (binding.createdByInvocationId === undefined && binding.lastTransitionRef === undefined) {
    return query(
      pool,
      `insert into ${schema.quotedName}.principal_auth_bindings
         (principal_auth_binding_id, tenant_id, principal_id, authentication_namespace_id, provider, subject_type,
          provider_subject_id, status, revoked_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      values,
    );
  }

  return query(
    pool,
    `insert into ${schema.quotedName}.principal_auth_bindings
       (principal_auth_binding_id, tenant_id, principal_id, authentication_namespace_id, provider, subject_type,
        provider_subject_id, status, revoked_at, created_by_invocation_id, last_transition_ref)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [...values, binding.createdByInvocationId ?? null, binding.lastTransitionRef ?? null],
  );
};

const migrationStatements = (fileSystem: FileSystem.FileSystem, schema: MigrationSchema) =>
  fileSystem.readFileString(migrationPath).pipe(
    Effect.map((source) =>
      source
        .replaceAll('"core"', schema.quotedName)
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0),
    ),
  );

const runMigration = (pool: PgClient.PgClient, statements: readonly string[]) =>
  pool.withTransaction(
    Effect.forEach(statements, (statement) => query(pool, statement), { concurrency: 1, discard: true }),
  );

const migrationProgram = Effect.gen(function* migrationProgramEffect() {
  const configuration = yield* loadDatabaseConnectionPair();
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const pool = yield* makeTestPgClient(configuration.admin.connectionString, { maxConnections: 4 });

  const schema = yield* makeMigrationSchema(pool, crypto);
  yield* Effect.gen(function* freshDatabaseFixture() {
    const statements = yield* migrationStatements(fileSystem, schema);
    yield* runMigration(pool, statements);

    const namespaceColumn = yield* query<{ column_default: string | null; is_nullable: string }>(
      pool,
      `select is_nullable, column_default
       from information_schema.columns
       where table_schema = $1
         and table_name = 'principal_auth_bindings'
         and column_name = 'authentication_namespace_id'`,
      [schema.name],
    );
    expect(namespaceColumn).toEqual([{ column_default: null, is_nullable: 'NO' }]);

    const indexes = yield* query<{ indexname: string }>(
      pool,
      `select indexname
       from pg_indexes
       where schemaname = $1 and tablename = 'principal_auth_bindings'
       order by indexname`,
      [schema.name],
    );
    expect(indexes.map(({ indexname }) => indexname)).toEqual([
      'core_auth_bindings_api_key_subject_global_uk',
      'core_auth_bindings_namespace_subject_uk',
      'core_auth_bindings_principal_idx',
      'core_auth_bindings_tenant_id_uk',
      'principal_auth_bindings_pkey',
    ]);

    for (const principalId of [
      ids.principalOne,
      ids.principalTwo,
      ids.principalThree,
      ids.principalFour,
      ids.principalSix,
      ids.principalSeven,
      ids.principalEight,
    ]) {
      yield* insertPrincipal(pool, schema, principalId);
    }
    yield* insertPrincipal(pool, schema, ids.principalFive, ids.otherTenant);

    yield* insertBinding(pool, schema, {
      authenticationNamespaceId: 'test.provider.primary.v1',
      principalAuthBindingId: ids.bindingOne,
      principalId: ids.principalOne,
      providerSubjectId: 'subject-001',
    });
    yield* insertBinding(pool, schema, {
      authenticationNamespaceId: 'test.provider.secondary.v1',
      createdByInvocationId: ids.invocationOne,
      lastTransitionRef: ids.transitionOne,
      principalAuthBindingId: ids.bindingTwo,
      principalId: ids.principalTwo,
      providerSubjectId: 'subject-001',
      status: 'pending',
    });
    yield* insertBinding(pool, schema, {
      authenticationNamespaceId: 'test.provider.tertiary.v1',
      principalAuthBindingId: ids.bindingSix,
      principalId: ids.principalSix,
      providerSubjectId: 'subject-001',
      status: 'disabled',
    });

    const sameUserAcrossNamespaces = yield* query<{ authentication_namespace_id: string }>(
      pool,
      `select authentication_namespace_id
       from ${schema.quotedName}.principal_auth_bindings
       where subject_type = 'user' and provider_subject_id = $1
       order by authentication_namespace_id`,
      ['subject-001'],
    );
    expect(sameUserAcrossNamespaces).toEqual([
      { authentication_namespace_id: 'test.provider.primary.v1' },
      { authentication_namespace_id: 'test.provider.secondary.v1' },
      { authentication_namespace_id: 'test.provider.tertiary.v1' },
    ]);

    const bindingProvenance = yield* query<{
      binding_revision: number;
      created_by_invocation_id: string | null;
      last_transition_ref: string | null;
    }>(
      pool,
      `select binding_revision, created_by_invocation_id::text, last_transition_ref::text
       from ${schema.quotedName}.principal_auth_bindings
       where principal_auth_binding_id = $1`,
      [ids.bindingTwo],
    );
    expect(bindingProvenance).toEqual([
      {
        binding_revision: 1,
        created_by_invocation_id: ids.invocationOne,
        last_transition_ref: ids.transitionOne,
      },
    ]);

    const duplicateNamespace = yield* Effect.flip(
      insertBinding(pool, schema, {
        authenticationNamespaceId: 'test.provider.primary.v1',
        principalAuthBindingId: ids.bindingThree,
        principalId: ids.principalThree,
        providerSubjectId: 'subject-001',
        revokedAt: '2026-09-16T10:00:00.000Z',
        status: 'revoked',
      }),
    );
    expect(failedConstraint(duplicateNamespace)).toBe('core_auth_bindings_namespace_subject_uk');

    yield* insertBinding(pool, schema, {
      authenticationNamespaceId: 'test.provider.primary.v1',
      principalAuthBindingId: ids.bindingFour,
      principalId: ids.principalFour,
      providerSubjectId: 'same-api-key',
      status: 'active',
      subjectType: 'api_key',
    });
    const duplicateApiKey = yield* Effect.flip(
      insertBinding(pool, schema, {
        authenticationNamespaceId: 'test.provider.secondary.v1',
        principalAuthBindingId: ids.bindingFive,
        principalId: ids.principalFive,
        providerSubjectId: 'same-api-key',
        status: 'disabled',
        subjectType: 'api_key',
        tenantId: ids.otherTenant,
      }),
    );
    expect(failedConstraint(duplicateApiKey)).toBe('core_auth_bindings_api_key_subject_global_uk');

    const crossTenantForeignKey = yield* Effect.flip(
      insertBinding(pool, schema, {
        authenticationNamespaceId: 'test.provider.cross-tenant.v1',
        principalAuthBindingId: ids.bindingCrossTenant,
        principalId: ids.principalOne,
        providerSubjectId: 'cross-tenant-subject',
        status: 'active',
        tenantId: ids.otherTenant,
      }),
    );
    expect(failedConstraint(crossTenantForeignKey)).toBe('core_auth_bindings_tenant_principal_fk');

    const raceResults = yield* Effect.forEach(
      [ids.bindingSeven, ids.bindingEight],
      (bindingId, index) =>
        Effect.exit(
          insertBinding(pool, schema, {
            authenticationNamespaceId: 'test.provider.primary.v1',
            principalAuthBindingId: bindingId,
            principalId: index === 0 ? ids.principalSeven : ids.principalEight,
            providerSubjectId: 'race-subject',
            status: 'active',
            subjectType: 'user',
          }),
        ),
      { concurrency: 2 },
    );
    expect(raceResults.filter(Exit.isSuccess)).toHaveLength(1);
    expect(raceResults.filter(Exit.isFailure)).toHaveLength(1);
  }).pipe(Effect.ensuring(dropSchema(pool, schema)));

  const lateFailure = yield* makeMigrationSchema(pool, crypto);
  yield* Effect.gen(function* lateFailureFixture() {
    const statements = yield* migrationStatements(fileSystem, lateFailure);
    const failure = yield* Effect.flip(runMigration(pool, [...statements, 'select 1 / 0']));
    expect(Option.getOrUndefined(findPostgresFailure(failure))?.code).toBe('22012');

    const namespaceColumn = yield* query<{ column_name: string }>(
      pool,
      `select column_name
       from information_schema.columns
       where table_schema = $1
         and table_name = 'principal_auth_bindings'
         and column_name = 'authentication_namespace_id'`,
      [lateFailure.name],
    );
    expect(namespaceColumn).toEqual([]);
    const oldIndex = yield* query<{ indexname: string }>(
      pool,
      `select indexname
       from pg_indexes
       where schemaname = $1
         and indexname = 'core_auth_bindings_subject_uk'`,
      [lateFailure.name],
    );
    expect(oldIndex).toEqual([{ indexname: 'core_auth_bindings_subject_uk' }]);
  }).pipe(Effect.ensuring(dropSchema(pool, lateFailure)));
}).pipe(Effect.scoped);

it.layer(NodeServices.layer, { excludeTestServices: true })('auth-namespace-migration', (suite) => {
  suite.effect('initializes the empty schema and preserves binding constraints', () => migrationProgram);
});
