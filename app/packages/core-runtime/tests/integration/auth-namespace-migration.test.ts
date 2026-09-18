import { NodeServices } from '@effect/platform-node';
import { Crypto, DateTime, Effect, Exit, FileSystem } from 'effect';
import { expect, it } from 'effect-rstest';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';

import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { AUTH_NAMESPACE_INVENTORY_TABLE_DDL } from '../../scripts/prepare-auth-namespace-inventory.mts';

const migrationPath = new URL('../../drizzle/20260916130129_auth-namespace-bindings/migration.sql', import.meta.url)
  .pathname;

const ids = {
  bindingCrossTenant: '71000000-0000-4000-8000-000000000010',
  bindingEight: '71000000-0000-4000-8000-000000000009',
  bindingFive: '71000000-0000-4000-8000-000000000005',
  bindingFour: '71000000-0000-4000-8000-000000000004',
  bindingOne: '71000000-0000-4000-8000-000000000001',
  bindingRevoked: '71000000-0000-4000-8000-000000000007',
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
  revokedAuditEvent: '61000000-0000-4000-8000-000000000001',
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

interface InventoryEntry {
  readonly authenticationNamespaceId: string;
  readonly evidenceRef: string;
  readonly principalAuthBindingId: string;
  readonly principalId: string;
  readonly provider: string;
  readonly providerSubjectId: string;
  readonly subjectType: string;
  readonly tenantId: string;
}

const query = <Row extends object>(pool: Pool | PoolClient, text: string, values: readonly unknown[] = []) =>
  Effect.tryPromise({
    catch: String,
    try: () => pool.query<Row>(text, [...values]),
  });

const dropSchema = (pool: Pool, schema: MigrationSchema) =>
  query(pool, `drop schema if exists ${schema.quotedName} cascade`).pipe(Effect.orDie);

const makeMigrationSchema = (pool: Pool, crypto: Crypto.Crypto) =>
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
    yield* query(
      pool,
      `create table ${quotedName}.audit_events (
        audit_event_id uuid primary key,
        tenant_id uuid not null,
        auth_binding_id uuid not null
      )`,
    );
    yield* query(
      pool,
      `alter table ${quotedName}.audit_events
       add constraint core_audit_events_tenant_auth_binding_fk
       foreign key (tenant_id, auth_binding_id)
       references ${quotedName}.principal_auth_bindings (tenant_id, principal_auth_binding_id)
       on delete restrict`,
    );
    return { name, quotedName };
  });

const insertPrincipal = (pool: Pool, schema: MigrationSchema, principalId: string, tenantId: string = ids.tenant) =>
  query(
    pool,
    `insert into ${schema.quotedName}.principals (principal_id, tenant_id)
     values ($1, $2)`,
    [principalId, tenantId],
  );

const insertAuditReference = (pool: Pool, schema: MigrationSchema, bindingId: string, tenantId = ids.tenant) =>
  query(
    pool,
    `insert into ${schema.quotedName}.audit_events (audit_event_id, tenant_id, auth_binding_id)
     values ($1, $2, $3)`,
    [ids.revokedAuditEvent, tenantId, bindingId],
  );

const insertBinding = (
  pool: Pool | PoolClient,
  schema: MigrationSchema,
  binding: {
    readonly authenticationNamespaceId?: string;
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
  const legacyValues = [
    binding.principalAuthBindingId,
    binding.tenantId ?? ids.tenant,
    binding.principalId,
    binding.provider ?? baseBinding.provider,
    binding.subjectType ?? baseBinding.subjectType,
    binding.providerSubjectId,
    binding.status ?? baseBinding.status,
    binding.revokedAt ?? null,
  ];
  if (binding.authenticationNamespaceId === undefined) {
    return query(
      pool,
      `insert into ${schema.quotedName}.principal_auth_bindings
         (principal_auth_binding_id, tenant_id, principal_id, provider, subject_type,
          provider_subject_id, status, revoked_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      legacyValues,
    );
  }

  const postMigrationValues = [
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
      postMigrationValues,
    );
  }

  return query(
    pool,
    `insert into ${schema.quotedName}.principal_auth_bindings
       (principal_auth_binding_id, tenant_id, principal_id, authentication_namespace_id, provider, subject_type,
        provider_subject_id, status, revoked_at, created_by_invocation_id, last_transition_ref)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [...postMigrationValues, binding.createdByInvocationId ?? null, binding.lastTransitionRef ?? null],
  );
};

const stageInventory = (
  pool: Pool,
  schema: MigrationSchema,
  entryOrEntries: InventoryEntry | readonly InventoryEntry[],
) =>
  Effect.gen(function* stageInventoryEffect() {
    const entries = Array.isArray(entryOrEntries) ? entryOrEntries : [entryOrEntries];
    yield* query(pool, AUTH_NAMESPACE_INVENTORY_TABLE_DDL.replaceAll('"core"', schema.quotedName));
    for (const entry of entries) {
      yield* query(
        pool,
        `insert into ${schema.quotedName}.principal_auth_binding_namespace_inventory
           (principal_auth_binding_id, tenant_id, principal_id, provider, subject_type,
            provider_subject_id, authentication_namespace_id, evidence_ref)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          entry.principalAuthBindingId,
          entry.tenantId,
          entry.principalId,
          entry.provider,
          entry.subjectType,
          entry.providerSubjectId,
          entry.authenticationNamespaceId,
          entry.evidenceRef,
        ],
      );
    }
  });

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

const runMigration = (pool: Pool, statements: readonly string[]) =>
  Effect.acquireUseRelease(
    Effect.tryPromise(() => pool.connect()),
    (client) =>
      Effect.gen(function* runMigrationEffect() {
        yield* query(client, 'begin');
        for (const statement of statements) {
          yield* query(client, statement);
        }
        yield* query(client, 'commit');
      }).pipe(Effect.tapError(() => query(client, 'rollback').pipe(Effect.orDie))),
    (client) => Effect.sync(() => client.release()),
  );

const migrationProgram = Effect.gen(function* migrationProgramEffect() {
  const configuration = yield* loadDatabaseConnectionPair();
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const pool = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new Pool({
          connectionString: configuration.admin.connectionString,
          max: 4,
        }),
    ),
    (resource) => Effect.promise(() => resource.end()).pipe(Effect.orDie),
  );

  const upgraded = yield* makeMigrationSchema(pool, crypto);
  yield* Effect.gen(function* upgradeFixture() {
    for (const principalId of [
      ids.principalOne,
      ids.principalTwo,
      ids.principalThree,
      ids.principalFour,
      ids.principalSix,
      ids.principalSeven,
      ids.principalEight,
    ]) {
      yield* insertPrincipal(pool, upgraded, principalId);
    }
    yield* insertPrincipal(pool, upgraded, ids.principalFive, ids.otherTenant);
    yield* insertBinding(pool, upgraded, {
      principalAuthBindingId: ids.bindingOne,
      principalId: ids.principalOne,
      providerSubjectId: 'subject-001',
    });
    const revokedAt = yield* DateTime.nowAsDate;
    yield* insertBinding(pool, upgraded, {
      principalAuthBindingId: ids.bindingRevoked,
      principalId: ids.principalTwo,
      providerSubjectId: 'subject-revoked',
      revokedAt,
      status: 'revoked',
    });
    yield* insertAuditReference(pool, upgraded, ids.bindingRevoked);
    yield* stageInventory(pool, upgraded, {
      authenticationNamespaceId: 'test.provider.primary.v1',
      evidenceRef: 'review://issue-337/namespace-binding-001',
      principalAuthBindingId: ids.bindingOne,
      principalId: ids.principalOne,
      provider: baseBinding.provider,
      providerSubjectId: 'subject-001',
      subjectType: baseBinding.subjectType,
      tenantId: ids.tenant,
    });
    yield* stageInventory(pool, upgraded, {
      authenticationNamespaceId: 'test.provider.primary.v1',
      evidenceRef: 'review://issue-337/namespace-binding-revoked',
      principalAuthBindingId: ids.bindingRevoked,
      principalId: ids.principalTwo,
      provider: baseBinding.provider,
      providerSubjectId: 'subject-revoked',
      subjectType: baseBinding.subjectType,
      tenantId: ids.tenant,
    });
    const statements = yield* migrationStatements(fileSystem, upgraded);
    yield* runMigration(pool, statements);

    const migrated = yield* query<{
      authentication_namespace_id: string;
      binding_revision: number;
      created_by_invocation_id: string | null;
      last_transition_ref: string | null;
      principal_auth_binding_id: string;
      principal_id: string;
      provider: string;
      provider_subject_id: string;
      revoked: boolean;
      status: string;
      subject_type: string;
      tenant_id: string;
    }>(
      pool,
      `select principal_auth_binding_id::text, tenant_id::text, principal_id::text,
              provider, subject_type, provider_subject_id, status,
              binding_revision, authentication_namespace_id,
              created_by_invocation_id::text, last_transition_ref::text,
              revoked_at is not null as revoked
       from ${upgraded.quotedName}.principal_auth_bindings
       order by principal_auth_binding_id`,
    );
    expect(migrated.rows).toEqual([
      {
        authentication_namespace_id: 'test.provider.primary.v1',
        binding_revision: 1,
        created_by_invocation_id: null,
        last_transition_ref: null,
        principal_auth_binding_id: ids.bindingOne,
        principal_id: ids.principalOne,
        provider: baseBinding.provider,
        provider_subject_id: 'subject-001',
        revoked: false,
        status: baseBinding.status,
        subject_type: baseBinding.subjectType,
        tenant_id: ids.tenant,
      },
      {
        authentication_namespace_id: 'test.provider.primary.v1',
        binding_revision: 1,
        created_by_invocation_id: null,
        last_transition_ref: null,
        principal_auth_binding_id: ids.bindingRevoked,
        principal_id: ids.principalTwo,
        provider: baseBinding.provider,
        provider_subject_id: 'subject-revoked',
        revoked: true,
        status: 'revoked',
        subject_type: baseBinding.subjectType,
        tenant_id: ids.tenant,
      },
    ]);

    const retainedAudit = yield* query<{ audit_event_id: string; auth_binding_id: string }>(
      pool,
      `select audit_event_id::text, auth_binding_id::text
       from ${upgraded.quotedName}.audit_events
       where auth_binding_id = $1`,
      [ids.bindingRevoked],
    );
    expect(retainedAudit.rows).toEqual([
      { audit_event_id: ids.revokedAuditEvent, auth_binding_id: ids.bindingRevoked },
    ]);

    const indexes = yield* query<{ indexname: string }>(
      pool,
      `select indexname
       from pg_indexes
       where schemaname = $1 and tablename = 'principal_auth_bindings'
       order by indexname`,
      [upgraded.name],
    );
    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual([
      'core_auth_bindings_api_key_subject_global_uk',
      'core_auth_bindings_namespace_subject_uk',
      'core_auth_bindings_principal_idx',
      'core_auth_bindings_tenant_id_uk',
      'principal_auth_bindings_pkey',
    ]);

    yield* insertBinding(pool, upgraded, {
      authenticationNamespaceId: 'test.provider.secondary.v1',
      createdByInvocationId: ids.invocationOne,
      lastTransitionRef: ids.transitionOne,
      principalAuthBindingId: ids.bindingTwo,
      principalId: ids.principalTwo,
      providerSubjectId: 'subject-001',
      status: 'pending',
    });
    const duplicateNamespace = yield* Effect.flip(
      insertBinding(pool, upgraded, {
        authenticationNamespaceId: 'test.provider.primary.v1',
        principalAuthBindingId: ids.bindingThree,
        principalId: ids.principalThree,
        providerSubjectId: 'subject-001',
        revokedAt,
        status: 'revoked',
      }),
    );
    expect(duplicateNamespace).toMatch(/core_auth_bindings_namespace_subject_uk/u);

    yield* insertBinding(pool, upgraded, {
      authenticationNamespaceId: 'test.provider.tertiary.v1',
      principalAuthBindingId: ids.bindingSix,
      principalId: ids.principalSix,
      providerSubjectId: 'subject-001',
      status: 'disabled',
    });

    const sameUserAcrossNamespaces = yield* query<{ authentication_namespace_id: string }>(
      pool,
      `select authentication_namespace_id
       from ${upgraded.quotedName}.principal_auth_bindings
       where subject_type = 'user' and provider_subject_id = $1
       order by authentication_namespace_id`,
      ['subject-001'],
    );
    expect(sameUserAcrossNamespaces.rows).toEqual([
      { authentication_namespace_id: 'test.provider.primary.v1' },
      { authentication_namespace_id: 'test.provider.secondary.v1' },
      { authentication_namespace_id: 'test.provider.tertiary.v1' },
    ]);

    const bindingProvenance = yield* query<{
      created_by_invocation_id: string | null;
      last_transition_ref: string | null;
    }>(
      pool,
      `select created_by_invocation_id::text, last_transition_ref::text
       from ${upgraded.quotedName}.principal_auth_bindings
       where principal_auth_binding_id = $1`,
      [ids.bindingTwo],
    );
    expect(bindingProvenance.rows).toEqual([
      {
        created_by_invocation_id: ids.invocationOne,
        last_transition_ref: ids.transitionOne,
      },
    ]);

    yield* insertBinding(pool, upgraded, {
      authenticationNamespaceId: 'test.provider.primary.v1',
      principalAuthBindingId: ids.bindingFour,
      principalId: ids.principalFour,
      providerSubjectId: 'same-api-key',
      status: 'active',
      subjectType: 'api_key',
    });
    const duplicateApiKey = yield* Effect.flip(
      insertBinding(pool, upgraded, {
        authenticationNamespaceId: 'test.provider.secondary.v1',
        principalAuthBindingId: ids.bindingFive,
        principalId: ids.principalFive,
        providerSubjectId: 'same-api-key',
        status: 'disabled',
        subjectType: 'api_key',
        tenantId: ids.otherTenant,
      }),
    );
    expect(duplicateApiKey).toMatch(/core_auth_bindings_api_key_subject_global_uk/u);

    const crossTenantForeignKey = yield* Effect.flip(
      insertBinding(pool, upgraded, {
        authenticationNamespaceId: 'test.provider.cross-tenant.v1',
        principalAuthBindingId: ids.bindingCrossTenant,
        principalId: ids.principalOne,
        providerSubjectId: 'cross-tenant-subject',
        status: 'active',
        tenantId: ids.otherTenant,
      }),
    );
    expect(crossTenantForeignKey).toMatch(/core_auth_bindings_tenant_principal_fk/u);

    const raceResults = yield* Effect.forEach(
      [ids.bindingSeven, ids.bindingEight],
      (bindingId, index) =>
        Effect.exit(
          insertBinding(pool, upgraded, {
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
  }).pipe(Effect.ensuring(dropSchema(pool, upgraded)));

  const empty = yield* makeMigrationSchema(pool, crypto);
  yield* Effect.gen(function* emptyFixture() {
    const statements = yield* migrationStatements(fileSystem, empty);
    yield* runMigration(pool, statements);
    const namespaceColumn = yield* query<{ column_default: string | null; is_nullable: string }>(
      pool,
      `select is_nullable, column_default
       from information_schema.columns
       where table_schema = $1
         and table_name = 'principal_auth_bindings'
         and column_name = 'authentication_namespace_id'`,
      [empty.name],
    );
    expect(namespaceColumn.rows).toEqual([{ column_default: null, is_nullable: 'NO' }]);
    const stagingTable = yield* query<{ table_name: string }>(
      pool,
      `select table_name
       from information_schema.tables
       where table_schema = $1
         and table_name = 'principal_auth_binding_namespace_inventory'`,
      [empty.name],
    );
    expect(stagingTable.rows).toEqual([]);
  }).pipe(Effect.ensuring(dropSchema(pool, empty)));

  const missingProof = yield* makeMigrationSchema(pool, crypto);
  yield* Effect.gen(function* missingProofFixture() {
    yield* insertPrincipal(pool, missingProof, ids.principalOne);
    yield* insertBinding(pool, missingProof, {
      principalAuthBindingId: ids.bindingOne,
      principalId: ids.principalOne,
      providerSubjectId: 'subject-001',
    });
    const statements = yield* migrationStatements(fileSystem, missingProof);
    const failure = yield* Effect.flip(runMigration(pool, statements));
    expect(String(failure)).toMatch(/inventory is required/u);
    const namespaceColumn = yield* query<{ column_name: string }>(
      pool,
      `select column_name
       from information_schema.columns
       where table_schema = $1
         and table_name = 'principal_auth_bindings'
         and column_name = 'authentication_namespace_id'`,
      [missingProof.name],
    );
    expect(namespaceColumn.rows).toEqual([]);
    const oldIndex = yield* query<{ indexname: string }>(
      pool,
      `select indexname
       from pg_indexes
       where schemaname = $1
         and indexname = 'core_auth_bindings_subject_uk'`,
      [missingProof.name],
    );
    expect(oldIndex.rows).toEqual([{ indexname: 'core_auth_bindings_subject_uk' }]);
  }).pipe(Effect.ensuring(dropSchema(pool, missingProof)));

  const mismatchedProof = yield* makeMigrationSchema(pool, crypto);
  yield* Effect.gen(function* mismatchedProofFixture() {
    yield* insertPrincipal(pool, mismatchedProof, ids.principalOne);
    yield* insertBinding(pool, mismatchedProof, {
      principalAuthBindingId: ids.bindingOne,
      principalId: ids.principalOne,
      providerSubjectId: 'subject-001',
    });
    yield* stageInventory(pool, mismatchedProof, {
      authenticationNamespaceId: 'test.provider.primary.v1',
      evidenceRef: 'review://issue-337/namespace-binding-001',
      principalAuthBindingId: ids.bindingOne,
      principalId: ids.principalOne,
      provider: 'different-provider',
      providerSubjectId: 'subject-001',
      subjectType: baseBinding.subjectType,
      tenantId: ids.tenant,
    });
    const statements = yield* migrationStatements(fileSystem, mismatchedProof);
    const failure = yield* Effect.flip(runMigration(pool, statements));
    expect(String(failure)).toMatch(/exactly match/u);
    const namespaceColumn = yield* query<{ column_name: string }>(
      pool,
      `select column_name
       from information_schema.columns
       where table_schema = $1
         and table_name = 'principal_auth_bindings'
         and column_name = 'authentication_namespace_id'`,
      [mismatchedProof.name],
    );
    expect(namespaceColumn.rows).toEqual([]);
  }).pipe(Effect.ensuring(dropSchema(pool, mismatchedProof)));

  const lateFailure = yield* makeMigrationSchema(pool, crypto);
  yield* Effect.gen(function* lateFailureFixture() {
    const statements = yield* migrationStatements(fileSystem, lateFailure);
    const failure = yield* Effect.flip(runMigration(pool, [...statements, 'select 1 / 0']));
    expect(String(failure)).toMatch(/division by zero/u);

    const namespaceColumn = yield* query<{ column_name: string }>(
      pool,
      `select column_name
       from information_schema.columns
       where table_schema = $1
         and table_name = 'principal_auth_bindings'
         and column_name = 'authentication_namespace_id'`,
      [lateFailure.name],
    );
    expect(namespaceColumn.rows).toEqual([]);
    const oldIndex = yield* query<{ indexname: string }>(
      pool,
      `select indexname
       from pg_indexes
       where schemaname = $1
         and indexname = 'core_auth_bindings_subject_uk'`,
      [lateFailure.name],
    );
    expect(oldIndex.rows).toEqual([{ indexname: 'core_auth_bindings_subject_uk' }]);
    const stagingTable = yield* query<{ table_name: string }>(
      pool,
      `select table_name
       from information_schema.tables
       where table_schema = $1
         and table_name = 'principal_auth_binding_namespace_inventory'`,
      [lateFailure.name],
    );
    expect(stagingTable.rows).toEqual([]);
  }).pipe(Effect.ensuring(dropSchema(pool, lateFailure)));
}).pipe(Effect.scoped);

it.layer(NodeServices.layer, { excludeTestServices: true })('auth-namespace-migration', (suite) => {
  suite.effect(
    'upgrades reviewed bindings, preserves IDs, and proves uniqueness and fail-closed rollback',
    () => migrationProgram,
  );
});
