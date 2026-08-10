// @effect-diagnostics asyncFunction:off
/* eslint-disable unicorn/no-await-expression-member, unicorn/prefer-set-has -- Integration assertions intentionally keep each live query beside its expected row count. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig, pgSchema, text, uuid } from 'drizzle-orm/pg-core';
import { Effect, Schema } from 'effect';
import { Pool } from 'pg';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import {
  actionInvocations,
  auditEvents,
  coreDatabaseSchema,
  dataAccessEvents,
  domainEvents,
  evidenceReferences,
  legalEntities,
  mediaAssets,
  mediaLinks,
  outboxMessages,
  principalAuthBindings,
  principals,
  searchIndexEntries,
  tenantModuleStateChanges,
} from '../../src/db/schema.ts';
import { defineSystemModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import {
  makeOperationalScopeRepository,
  makeOperationalScopeResolver,
} from '../../src/operations/context.ts';
import { defineRead } from '../../src/reads/definition.ts';
import type { ReadHandlerContext } from '../../src/reads/context.ts';
import { makeReadRuntime } from '../../src/reads/runtime.ts';

test('declares the composite same-tenant parent keys used by isolation foreign keys', () => {
  const names = [legalEntities, principals, principalAuthBindings, actionInvocations].flatMap(
    (table) =>
      getTableConfig(table)
        .indexes.filter((index) => index.config.unique)
        .map((index) => index.config.name),
  );
  assert.ok(names.includes('core_legal_entities_tenant_id_uk'));
  assert.ok(names.includes('core_principals_tenant_id_uk'));
  assert.ok(names.includes('core_auth_bindings_tenant_id_uk'));
  assert.ok(names.includes('core_action_invocations_tenant_id_uk'));

  const tenantQualifiedChildren = [
    principalAuthBindings,
    actionInvocations,
    tenantModuleStateChanges,
    auditEvents,
    dataAccessEvents,
    domainEvents,
    outboxMessages,
    mediaAssets,
    mediaLinks,
    evidenceReferences,
    searchIndexEntries,
  ];
  for (const table of tenantQualifiedChildren) {
    const businessReferences = getTableConfig(table)
      .foreignKeys.map((foreignKey) => foreignKey.reference().columns.map((column) => column.name))
      .filter((columns) => columns.some((column) => column !== 'tenant_id'));
    assert.ok(businessReferences.length > 0);
    assert.equal(
      businessReferences.every((columns) => columns.length === 2 && columns[0] === 'tenant_id'),
      true,
    );
  }
});

test('runtime RLS isolates tenant and legal-entity rows and never leaks transaction scope', async () => {
  const connections = await Effect.runPromise(loadDatabaseConnectionPair());
  const admin = new Pool({ connectionString: connections.admin.connectionString });
  const runtime = new Pool({ connectionString: connections.runtime.connectionString, max: 1 });
  const schema = `isolation_${randomUUID().replaceAll('-', '')}`;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const entityA = randomUUID();
  const entityB = randomUUID();
  const entityC = randomUUID();
  const resourceId = randomUUID();
  const predicate = `tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid and legal_entity_id = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid`;

  try {
    await admin.query(`create schema ${schema}`);
    await admin.query(`
      create table ${schema}.records (
        tenant_id uuid not null,
        legal_entity_id uuid not null,
        resource_id uuid not null,
        value text not null,
        primary key (tenant_id, legal_entity_id, resource_id)
      )
    `);
    await admin.query(`alter table ${schema}.records enable row level security`);
    await admin.query(`alter table ${schema}.records force row level security`);
    await admin.query(
      `create policy records_select on ${schema}.records for select to ontos_runtime using (${predicate})`,
    );
    await admin.query(
      `create policy records_insert on ${schema}.records for insert to ontos_runtime with check (${predicate})`,
    );
    await admin.query(
      `create policy records_update on ${schema}.records for update to ontos_runtime using (${predicate}) with check (${predicate})`,
    );
    await admin.query(
      `create policy records_delete on ${schema}.records for delete to ontos_runtime using (${predicate})`,
    );
    await admin.query(`grant usage on schema ${schema} to ontos_runtime`);
    await admin.query(`grant select, insert, update, delete on ${schema}.records to ontos_runtime`);
    await admin.query(
      `insert into ${schema}.records (tenant_id, legal_entity_id, resource_id, value) values ($1, $2, $4, 'entity-a'), ($1, $3, $4, 'entity-b'), ($5, $6, $4, 'tenant-b')`,
      [tenantA, entityA, entityB, resourceId, tenantB, entityC],
    );

    const catalog = await admin.query<{
      policy_count: number;
      relforcerowsecurity: boolean;
      relrowsecurity: boolean;
    }>(
      `
      select relation.relrowsecurity, relation.relforcerowsecurity,
        (select count(*)::int from pg_catalog.pg_policy where polrelid = relation.oid) as policy_count
      from pg_catalog.pg_class as relation
      inner join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = $1 and relation.relname = 'records'
    `,
      [schema],
    );
    assert.deepEqual(catalog.rows[0], {
      policy_count: 4,
      relforcerowsecurity: true,
      relrowsecurity: true,
    });

    assert.equal((await runtime.query(`select * from ${schema}.records`)).rowCount, 0);
    const client = await runtime.connect();
    try {
      await client.query('begin');
      await client.query(
        "select set_config('ontos.tenant_id', $1, true), set_config('ontos.legal_entity_id', $2, true)",
        [tenantA, entityA],
      );
      assert.deepEqual(
        (await client.query<{ value: string }>(`select value from ${schema}.records`)).rows,
        [{ value: 'entity-a' }],
      );
      assert.equal(
        (
          await client.query(
            `update ${schema}.records set value = 'hacked' where value = 'tenant-b'`,
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (await client.query(`delete from ${schema}.records where value = 'entity-b'`)).rowCount,
        0,
      );
      await assert.rejects(
        client.query(
          `insert into ${schema}.records (tenant_id, legal_entity_id, resource_id, value) values ($1, $2, $3, 'forbidden')`,
          [tenantB, entityC, randomUUID()],
        ),
        (error: { code?: string }) => error.code === '42501',
      );
      await client.query('rollback');

      await client.query('begin');
      await client.query(
        "select set_config('ontos.tenant_id', $1, true), set_config('ontos.legal_entity_id', $2, true)",
        [tenantA, entityB],
      );
      assert.deepEqual(
        (await client.query<{ value: string }>(`select value from ${schema}.records`)).rows,
        [{ value: 'entity-b' }],
      );
      await client.query('commit');
    } finally {
      client.release();
    }

    assert.equal((await runtime.query(`select * from ${schema}.records`)).rowCount, 0);
    const protectedRows = await admin.query<{ value: string }>(
      `select value from ${schema}.records order by value`,
    );
    assert.deepEqual(protectedRows.rows, [
      { value: 'entity-a' },
      { value: 'entity-b' },
      { value: 'tenant-b' },
    ]);
  } finally {
    await runtime.end();
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.end();
  }
});

test('an unscoped owner repository remains isolated inside a governed read transaction', async () => {
  const connections = await Effect.runPromise(loadDatabaseConnectionPair());
  const admin = new Pool({ connectionString: connections.admin.connectionString });
  const runtimePool = new Pool({ connectionString: connections.runtime.connectionString });
  const runtimeDatabase = drizzle({ client: runtimePool, schema: coreDatabaseSchema });
  const schemaName = `governed_isolation_${randomUUID().replaceAll('-', '')}`;
  const ownerSchema = pgSchema(schemaName);
  const records = ownerSchema.table('records', {
    legalEntityId: uuid('legal_entity_id').notNull(),
    resourceId: uuid('resource_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    value: text('value').notNull(),
  });
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const entityA = randomUUID();
  const entityB = randomUUID();
  const entityC = randomUUID();
  const principalA = randomUUID();
  const principalB = randomUUID();
  const bindingA = randomUUID();
  const bindingB = randomUUID();
  const resourceId = randomUUID();
  const predicate = `tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid and legal_entity_id = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid`;
  const entrypoint = defineSystemModuleEntrypoint({
    access: 'read',
    entrypointKey: 'core.shell.governed-isolation-fixture',
    moduleKey: 'core.shell',
    role: 'api',
  });

  const runForScope = (scope: {
    readonly authBindingId: string;
    readonly authMethod: 'session';
    readonly correlationId: string;
    readonly legalEntityId: string;
    readonly principalId: string;
    readonly tenantId: string;
  }) => {
    const registration = defineRead(
      {
        accessKind: 'list',
        entrypoint,
        evidencePolicy: {
          captureMode: 'metadata_only',
          policyKey: 'core.shell.governed-isolation-fixture.v1',
        },
        inputSchema: Schema.Struct({}),
        legalEntityScope: 'required',
        owningModuleKey: 'core.shell',
        permissionTarget: 'legal_entity',
        policies: [],
        readKey: 'core.shell.governed-isolation-fixture',
        resultSchema: Schema.Array(Schema.String),
        schemaVersion: '1',
      },
      (
        _input,
        context: ReadHandlerContext<{
          readonly listWithoutPredicates: () => Effect.Effect<
            readonly { readonly value: string }[]
          >;
        }>,
      ) =>
        context.services.listWithoutPredicates().pipe(
          Effect.map((rows) => ({
            evidence: { resultCount: rows.length },
            result: rows.map((row) => row.value),
          })),
        ),
      (transaction) =>
        Effect.succeed({
          // Deliberately buggy: RLS, not a repository predicate, must enforce the scope.
          listWithoutPredicates: () => Effect.promise(() => transaction.select().from(records)),
        }),
      () => ({ kind: 'legal_entity' }),
    );
    const contextAccess = {
      legalEntities: ({ legalEntityIds }: { readonly legalEntityIds: readonly string[] }) =>
        Effect.succeed(legalEntityIds.map((key) => ({ decision: 'allowed' as const, key }))),
      modules: () => Effect.succeed([]),
      resources: () => Effect.succeed([]),
      tenants: () => Effect.succeed([]),
    };
    const runtime = makeReadRuntime(
      { executor: runtimeDatabase },
      { check: () => Effect.void, prepareSnapshot: () => Effect.succeed({}) } as never,
      makeOperationalScopeResolver(
        makeOperationalScopeRepository({ executor: runtimeDatabase }),
        contextAccess,
      ),
      contextAccess,
    );
    return Effect.runPromise(
      runtime.runRead({
        input: {},
        principal: {
          authBindingId: scope.authBindingId,
          authContextRef: `better-auth-session:${scope.correlationId}`,
          authMethod: scope.authMethod,
          legalEntityId: scope.legalEntityId,
          principalId: scope.principalId,
          tenantId: scope.tenantId,
        },
        registration,
        transport: { correlationId: scope.correlationId },
      }),
    );
  };

  try {
    await admin.query(`create schema ${schemaName}`);
    await admin.query(`
      create table ${schemaName}.records (
        tenant_id uuid not null,
        legal_entity_id uuid not null,
        resource_id uuid not null,
        value text not null,
        primary key (tenant_id, legal_entity_id, resource_id)
      )
    `);
    await admin.query(`alter table ${schemaName}.records enable row level security`);
    await admin.query(`alter table ${schemaName}.records force row level security`);
    await admin.query(
      `create policy records_select on ${schemaName}.records for select to ontos_runtime using (${predicate})`,
    );
    await admin.query(`grant usage on schema ${schemaName} to ontos_runtime`);
    await admin.query(`grant select on ${schemaName}.records to ontos_runtime`);
    await admin.query(
      `insert into core.tenants (tenant_id, slug, name, status, default_locale) values ($1, $3, 'Governed A', 'active', 'en'), ($2, $4, 'Governed B', 'active', 'en')`,
      [tenantA, tenantB, `governed-a-${tenantA}`, `governed-b-${tenantB}`],
    );
    await admin.query(
      `insert into core.legal_entities (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status) values ($1, $4, 'Entity A', 'CZ', $6, 'active'), ($2, $4, 'Entity B', 'CZ', $7, 'active'), ($3, $5, 'Entity C', 'CZ', $8, 'active')`,
      [entityA, entityB, entityC, tenantA, tenantB, `A-${entityA}`, `B-${entityB}`, `C-${entityC}`],
    );
    await admin.query(
      `insert into core.principals (principal_id, tenant_id, kind, display_name, status) values ($1, $3, 'human', 'Principal A', 'active'), ($2, $4, 'human', 'Principal B', 'active')`,
      [principalA, principalB, tenantA, tenantB],
    );
    await admin.query(
      `insert into core.principal_auth_bindings (principal_auth_binding_id, tenant_id, principal_id, provider, subject_type, provider_subject_id, status) values ($1, $3, $5, 'better_auth', 'user', $7, 'active'), ($2, $4, $6, 'better_auth', 'user', $8, 'active')`,
      [
        bindingA,
        bindingB,
        tenantA,
        tenantB,
        principalA,
        principalB,
        `user-${principalA}`,
        `user-${principalB}`,
      ],
    );
    await admin.query(
      `insert into ${schemaName}.records (tenant_id, legal_entity_id, resource_id, value) values ($1, $2, $6, 'tenant-a-entity-a'), ($1, $3, $6, 'tenant-a-entity-b'), ($4, $5, $6, 'tenant-b-entity-c')`,
      [tenantA, entityA, entityB, tenantB, entityC, resourceId],
    );

    assert.deepEqual(
      await runForScope({
        authBindingId: bindingA,
        authMethod: 'session',
        correlationId: randomUUID(),
        legalEntityId: entityA,
        principalId: principalA,
        tenantId: tenantA,
      }),
      ['tenant-a-entity-a'],
    );
    assert.deepEqual(
      await runForScope({
        authBindingId: bindingA,
        authMethod: 'session',
        correlationId: randomUUID(),
        legalEntityId: entityB,
        principalId: principalA,
        tenantId: tenantA,
      }),
      ['tenant-a-entity-b'],
    );
    assert.deepEqual(
      await runForScope({
        authBindingId: bindingB,
        authMethod: 'session',
        correlationId: randomUUID(),
        legalEntityId: entityC,
        principalId: principalB,
        tenantId: tenantB,
      }),
      ['tenant-b-entity-c'],
    );
  } finally {
    await admin.query('delete from core.data_access_events where tenant_id in ($1, $2)', [
      tenantA,
      tenantB,
    ]);
    await admin.query('delete from core.principal_auth_bindings where tenant_id in ($1, $2)', [
      tenantA,
      tenantB,
    ]);
    await admin.query('delete from core.principals where tenant_id in ($1, $2)', [
      tenantA,
      tenantB,
    ]);
    await admin.query('delete from core.legal_entities where tenant_id in ($1, $2)', [
      tenantA,
      tenantB,
    ]);
    await admin.query('delete from core.tenants where tenant_id in ($1, $2)', [tenantA, tenantB]);
    await admin.query(`drop schema if exists ${schemaName} cascade`);
    await runtimePool.end();
    await admin.end();
  }
});

test('PostgreSQL rejects cross-tenant entity, principal, and Action references', async () => {
  const connections = await Effect.runPromise(loadDatabaseConnectionPair());
  const admin = new Pool({ connectionString: connections.admin.connectionString });
  const client = await admin.connect();
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const entityA = randomUUID();
  const entityB = randomUUID();
  const principalA = randomUUID();
  const principalB = randomUUID();
  const invocationA = randomUUID();

  const expectForeignKeyFailure = async (statement: string, parameters: readonly string[]) => {
    await client.query('savepoint isolation_failure');
    await assert.rejects(
      client.query(statement, [...parameters]),
      (error: { code?: string }) => error.code === '23503',
    );
    await client.query('rollback to savepoint isolation_failure');
  };

  try {
    await client.query('begin');
    await client.query(
      `insert into core.tenants (tenant_id, slug, name, status, default_locale) values ($1, $3, 'Tenant A', 'active', 'en'), ($2, $4, 'Tenant B', 'active', 'en')`,
      [tenantA, tenantB, `isolation-a-${tenantA}`, `isolation-b-${tenantB}`],
    );
    await client.query(
      `insert into core.legal_entities (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status) values ($1, $3, 'Entity A', 'CZ', $5, 'active'), ($2, $4, 'Entity B', 'CZ', $6, 'active')`,
      [entityA, entityB, tenantA, tenantB, `A-${entityA}`, `B-${entityB}`],
    );
    await client.query(
      `insert into core.principals (principal_id, tenant_id, kind, display_name, status) values ($1, $3, 'human', 'Principal A', 'active'), ($2, $4, 'human', 'Principal B', 'active')`,
      [principalA, principalB, tenantA, tenantB],
    );

    const invocationInsert = `insert into core.action_invocations (action_invocation_id, tenant_id, legal_entity_id, principal_id, action_key, status, request_hash) values ($1, $2, $3, $4, 'isolation.test', 'received', 'bounded-hash')`;
    await expectForeignKeyFailure(invocationInsert, [randomUUID(), tenantA, entityB, principalA]);
    await expectForeignKeyFailure(invocationInsert, [randomUUID(), tenantA, entityA, principalB]);
    await client.query(invocationInsert, [invocationA, tenantA, entityA, principalA]);
    await expectForeignKeyFailure(
      `insert into core.tenant_module_state_changes (tenant_id, module_key, new_state, changed_by_principal_id, action_invocation_id, change_source) values ($1, 'core.shell', 'active', $2, $3, 'user')`,
      [tenantB, principalB, invocationA],
    );
  } finally {
    await client.query('rollback');
    client.release();
    await admin.end();
  }
});
