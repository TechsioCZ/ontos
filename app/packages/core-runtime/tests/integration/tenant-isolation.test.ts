import {
  makeEffectTestCallback as nativeTestCallback,
  makeEffectTestCallback,
} from '@app/core-runtime/testing/effect-runtime';

import { getTableConfig, pgSchema, text, uuid } from 'drizzle-orm/pg-core';
import {
  Effect,
  Function as Fn,
  Exit as NativeExit,
  Scope as NativeScope,
  Option,
  Schema,
} from 'effect';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after as afterNativeDatabase } from 'node:test';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { Pool } from 'pg';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import {
  actionInvocations,
  auditEvents,
  coreRelations,
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
import type { ReadHandlerContext } from '../../src/reads/context.ts';
import { defineRead } from '../../src/reads/definition.ts';
import { makeReadRuntime } from '../../src/reads/runtime.ts';
import { makeTestDatabaseFromPool } from '../support/database.ts';
import { runEffectTestSync as runNativeSync } from '../support/effect-runtime.ts';
import { openModuleEntrypointGateway } from '../support/open-module-entrypoint-gateway.ts';

const nativeDatabaseScope = runNativeSync(NativeScope.make());
afterNativeDatabase(
  NativeScope.close(nativeDatabaseScope, NativeExit.void).pipe(nativeTestCallback),
);

type DatabaseQueryFailureSelf = typeof DatabaseQueryFailureContract.Type;
const DatabaseQueryFailureContract = Schema.TaggedStruct('DatabaseQueryFailure', {
  code: Schema.String,
});
const DatabaseQueryFailure = Schema.TaggedError<DatabaseQueryFailureSelf>()(
  'DatabaseQueryFailure',
  { code: Schema.String },
);
const DatabaseErrorCode = Schema.Struct({ code: Schema.String });
const queryEffect = <Row extends QueryResultRow = QueryResultRow>(
  client: Pool | PoolClient,
  statement: string,
  parameters?: readonly unknown[],
): Effect.Effect<QueryResult<Row>> =>
  Effect.suspend(() =>
    Effect.promise(Fn.constant(client.query<Row>(statement, [...(parameters ?? [])]))),
  );
const queryTryEffect = <Row extends QueryResultRow = QueryResultRow>(
  client: Pool | PoolClient,
  statement: string,
  parameters?: readonly unknown[],
): Effect.Effect<QueryResult<Row>, DatabaseQueryFailureSelf> =>
  Effect.suspend(() => {
    const query = client.query<Row>(statement, [...(parameters ?? [])]);
    return Effect.tryPromise({
      catch: (error) => {
        const decoded = Schema.decodeUnknownOption(DatabaseErrorCode)(error);
        return new DatabaseQueryFailure({
          code: Option.isSome(decoded) ? decoded.value.code : 'unknown',
        });
      },
      try: Fn.constant(query),
    });
  });
const connectPool = (pool: Pool): Effect.Effect<PoolClient> =>
  Effect.suspend(() => Effect.promise(Fn.constant(pool.connect())));
const endPool = (pool: Pool): Effect.Effect<void> =>
  Effect.suspend(() => Effect.promise(Fn.constant(pool.end())));

const effectAccessor =
  <Value>(effect: Effect.Effect<Value>) =>
  (): Effect.Effect<Value> =>
    effect;
const toReadResult = (rows: readonly { readonly value: string }[]) => ({
  evidence: { resultCount: rows.length },
  result: rows.map((row) => row.value),
});
const effectTest = <Value, Failure>(name: string, effect: Effect.Effect<Value, Failure>): void => {
  test(name, makeEffectTestCallback(effect));
};

void test('declares the composite same-tenant parent keys used by isolation foreign keys', () => {
  const names = new Set(
    [legalEntities, principals, principalAuthBindings, actionInvocations].flatMap((table) =>
      getTableConfig(table)
        .indexes.filter((index) => index.config.unique)
        .map((index) => index.config.name),
    ),
  );
  assert.ok(names.has('core_legal_entities_tenant_id_uk'));
  assert.ok(names.has('core_principals_tenant_id_uk'));
  assert.ok(names.has('core_auth_bindings_tenant_id_uk'));
  assert.ok(names.has('core_action_invocations_tenant_id_uk'));

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

effectTest(
  'runtime RLS isolates tenant and legal-entity rows and never leaks transaction scope',
  Effect.gen(function* runtimeRlsIsolation() {
    const connections = yield* loadDatabaseConnectionPair();
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

    const exercise = Effect.gen(function* exerciseRuntimeRls() {
      yield* queryEffect(admin, `create schema ${schema}`);
      yield* queryEffect(
        admin,
        `
      create table ${schema}.records (
        tenant_id uuid not null,
        legal_entity_id uuid not null,
        resource_id uuid not null,
        value text not null,
        primary key (tenant_id, legal_entity_id, resource_id)
      )
    `,
      );
      yield* queryEffect(admin, `alter table ${schema}.records enable row level security`);
      yield* queryEffect(admin, `alter table ${schema}.records force row level security`);
      yield* queryEffect(
        admin,
        `create policy records_select on ${schema}.records for select to ontos_runtime using (${predicate})`,
      );
      yield* queryEffect(
        admin,
        `create policy records_insert on ${schema}.records for insert to ontos_runtime with check (${predicate})`,
      );
      yield* queryEffect(
        admin,
        `create policy records_update on ${schema}.records for update to ontos_runtime using (${predicate}) with check (${predicate})`,
      );
      yield* queryEffect(
        admin,
        `create policy records_delete on ${schema}.records for delete to ontos_runtime using (${predicate})`,
      );
      yield* queryEffect(admin, `grant usage on schema ${schema} to ontos_runtime`);
      yield* queryEffect(
        admin,
        `grant select, insert, update, delete on ${schema}.records to ontos_runtime`,
      );
      yield* queryEffect(
        admin,
        `insert into ${schema}.records (tenant_id, legal_entity_id, resource_id, value) values ($1, $2, $4, 'entity-a'), ($1, $3, $4, 'entity-b'), ($5, $6, $4, 'tenant-b')`,
        [tenantA, entityA, entityB, resourceId, tenantB, entityC],
      );

      const catalog = yield* queryEffect<{
        policy_count: number;
        relforcerowsecurity: boolean;
        relrowsecurity: boolean;
      }>(
        admin,
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

      const unscopedRows = yield* queryEffect(runtime, `select * from ${schema}.records`);
      assert.equal(unscopedRows.rowCount, 0);
      const client = yield* connectPool(runtime);
      yield* Effect.gen(function* scopedRuntimeQueries() {
        yield* queryEffect(client, 'begin');
        yield* queryEffect(
          client,
          "select set_config('ontos.tenant_id', $1, true), set_config('ontos.legal_entity_id', $2, true)",
          [tenantA, entityA],
        );
        const entityARows = yield* queryEffect<{ value: string }>(
          client,
          `select value from ${schema}.records`,
        );
        assert.deepEqual(entityARows.rows, [{ value: 'entity-a' }]);
        const foreignUpdate = yield* queryEffect(
          client,
          `update ${schema}.records set value = 'hacked' where value = 'tenant-b'`,
        );
        assert.equal(foreignUpdate.rowCount, 0);
        const foreignDelete = yield* queryEffect(
          client,
          `delete from ${schema}.records where value = 'entity-b'`,
        );
        assert.equal(foreignDelete.rowCount, 0);
        const forbiddenInsert = yield* Effect.flip(
          queryTryEffect(
            client,
            `insert into ${schema}.records (tenant_id, legal_entity_id, resource_id, value) values ($1, $2, $3, 'forbidden')`,
            [tenantB, entityC, randomUUID()],
          ),
        );
        assert.equal(forbiddenInsert.code, '42501');
        yield* queryEffect(client, 'rollback');

        yield* queryEffect(client, 'begin');
        yield* queryEffect(
          client,
          "select set_config('ontos.tenant_id', $1, true), set_config('ontos.legal_entity_id', $2, true)",
          [tenantA, entityB],
        );
        const entityBRows = yield* queryEffect<{ value: string }>(
          client,
          `select value from ${schema}.records`,
        );
        assert.deepEqual(entityBRows.rows, [{ value: 'entity-b' }]);
        yield* queryEffect(client, 'commit');
      }).pipe(Effect.ensuring(Effect.sync(() => client.release())));

      const resetRows = yield* queryEffect(runtime, `select * from ${schema}.records`);
      assert.equal(resetRows.rowCount, 0);
      const protectedRows = yield* queryEffect<{ value: string }>(
        admin,
        `select value from ${schema}.records order by value`,
      );
      assert.deepEqual(protectedRows.rows, [
        { value: 'entity-a' },
        { value: 'entity-b' },
        { value: 'tenant-b' },
      ]);
    });
    const release = endPool(runtime).pipe(
      Effect.ensuring(
        queryEffect(admin, `drop schema if exists ${schema} cascade`).pipe(Effect.orDie),
      ),
      Effect.ensuring(endPool(admin).pipe(Effect.orDie)),
    );
    yield* exercise.pipe(Effect.ensuring(release));
  }),
);

effectTest(
  'an unscoped owner repository remains isolated inside a governed read transaction',
  Effect.gen(function* governedReadIsolation() {
    const connections = yield* loadDatabaseConnectionPair();
    const admin = new Pool({ connectionString: connections.admin.connectionString });
    const runtimePool = new Pool({ connectionString: connections.runtime.connectionString });
    const runtimeDatabase = yield* makeTestDatabaseFromPool(runtimePool, coreRelations).pipe(
      NativeScope.provide(nativeDatabaseScope),
    );
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
      authorization: { kind: 'context_permission', permission: 'module.access' },
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
        ) => context.services.listWithoutPredicates().pipe(Effect.map(toReadResult)),
        (transaction) => {
          const rows = transaction.select().from(records);
          return Effect.succeed({
            // Deliberately buggy: RLS, not a repository predicate, must enforce the scope.
            listWithoutPredicates: effectAccessor(rows.pipe(Effect.orDie)),
          });
        },
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
        openModuleEntrypointGateway,
        makeOperationalScopeResolver(
          makeOperationalScopeRepository({ executor: runtimeDatabase }),
          contextAccess,
        ),
        contextAccess,
      );
      return runtime.runRead({
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
      });
    };

    const exercise = Effect.gen(function* exerciseGovernedReadIsolation() {
      yield* queryEffect(admin, `create schema ${schemaName}`);
      yield* queryEffect(
        admin,
        `
      create table ${schemaName}.records (
        tenant_id uuid not null,
        legal_entity_id uuid not null,
        resource_id uuid not null,
        value text not null,
        primary key (tenant_id, legal_entity_id, resource_id)
      )
    `,
      );
      yield* queryEffect(admin, `alter table ${schemaName}.records enable row level security`);
      yield* queryEffect(admin, `alter table ${schemaName}.records force row level security`);
      yield* queryEffect(
        admin,
        `create policy records_select on ${schemaName}.records for select to ontos_runtime using (${predicate})`,
      );
      yield* queryEffect(admin, `grant usage on schema ${schemaName} to ontos_runtime`);
      yield* queryEffect(admin, `grant select on ${schemaName}.records to ontos_runtime`);
      yield* queryEffect(
        admin,
        `insert into core.tenants (tenant_id, slug, name, status, default_locale) values ($1, $3, 'Governed A', 'active', 'en'), ($2, $4, 'Governed B', 'active', 'en')`,
        [tenantA, tenantB, `governed-a-${tenantA}`, `governed-b-${tenantB}`],
      );
      yield* queryEffect(
        admin,
        `insert into core.legal_entities (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status) values ($1, $4, 'Entity A', 'CZ', $6, 'active'), ($2, $4, 'Entity B', 'CZ', $7, 'active'), ($3, $5, 'Entity C', 'CZ', $8, 'active')`,
        [
          entityA,
          entityB,
          entityC,
          tenantA,
          tenantB,
          `A-${entityA}`,
          `B-${entityB}`,
          `C-${entityC}`,
        ],
      );
      yield* queryEffect(
        admin,
        `insert into core.principals (principal_id, tenant_id, kind, display_name, status) values ($1, $3, 'human', 'Principal A', 'active'), ($2, $4, 'human', 'Principal B', 'active')`,
        [principalA, principalB, tenantA, tenantB],
      );
      yield* queryEffect(
        admin,
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
      yield* queryEffect(
        admin,
        `insert into ${schemaName}.records (tenant_id, legal_entity_id, resource_id, value) values ($1, $2, $6, 'tenant-a-entity-a'), ($1, $3, $6, 'tenant-a-entity-b'), ($4, $5, $6, 'tenant-b-entity-c')`,
        [tenantA, entityA, entityB, tenantB, entityC, resourceId],
      );

      assert.deepEqual(
        yield* runForScope({
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
        yield* runForScope({
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
        yield* runForScope({
          authBindingId: bindingB,
          authMethod: 'session',
          correlationId: randomUUID(),
          legalEntityId: entityC,
          principalId: principalB,
          tenantId: tenantB,
        }),
        ['tenant-b-entity-c'],
      );
    });
    const release = Effect.gen(function* cleanGovernedReadIsolation() {
      yield* queryEffect(admin, 'delete from core.data_access_events where tenant_id in ($1, $2)', [
        tenantA,
        tenantB,
      ]);
      yield* queryEffect(
        admin,
        'delete from core.principal_auth_bindings where tenant_id in ($1, $2)',
        [tenantA, tenantB],
      );
      yield* queryEffect(admin, 'delete from core.principals where tenant_id in ($1, $2)', [
        tenantA,
        tenantB,
      ]);
      yield* queryEffect(admin, 'delete from core.legal_entities where tenant_id in ($1, $2)', [
        tenantA,
        tenantB,
      ]);
      yield* queryEffect(admin, 'delete from core.tenants where tenant_id in ($1, $2)', [
        tenantA,
        tenantB,
      ]);
      yield* queryEffect(admin, `drop schema if exists ${schemaName} cascade`);
      yield* Effect.all([endPool(runtimePool), endPool(admin)], { concurrency: 'unbounded' });
    }).pipe(Effect.orDie);
    yield* exercise.pipe(Effect.ensuring(release));
  }),
);

effectTest(
  'PostgreSQL rejects cross-tenant entity, principal, and Action references',
  Effect.gen(function* crossTenantForeignKeys() {
    const connections = yield* loadDatabaseConnectionPair();
    const admin = new Pool({ connectionString: connections.admin.connectionString });
    const client = yield* connectPool(admin);
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const entityA = randomUUID();
    const entityB = randomUUID();
    const principalA = randomUUID();
    const principalB = randomUUID();
    const invocationA = randomUUID();

    const expectForeignKeyFailure = (statement: string, parameters: readonly string[]) =>
      Effect.gen(function* rejectCrossTenantReference() {
        yield* queryEffect(client, 'savepoint isolation_failure');
        const failure = yield* Effect.flip(queryTryEffect(client, statement, parameters));
        assert.equal(failure.code, '23503');
        yield* queryEffect(client, 'rollback to savepoint isolation_failure');
      });

    const exercise = Effect.gen(function* exerciseCrossTenantForeignKeys() {
      yield* queryEffect(client, 'begin');
      yield* queryEffect(
        client,
        `insert into core.tenants (tenant_id, slug, name, status, default_locale) values ($1, $3, 'Tenant A', 'active', 'en'), ($2, $4, 'Tenant B', 'active', 'en')`,
        [tenantA, tenantB, `isolation-a-${tenantA}`, `isolation-b-${tenantB}`],
      );
      yield* queryEffect(
        client,
        `insert into core.legal_entities (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status) values ($1, $3, 'Entity A', 'CZ', $5, 'active'), ($2, $4, 'Entity B', 'CZ', $6, 'active')`,
        [entityA, entityB, tenantA, tenantB, `A-${entityA}`, `B-${entityB}`],
      );
      yield* queryEffect(
        client,
        `insert into core.principals (principal_id, tenant_id, kind, display_name, status) values ($1, $3, 'human', 'Principal A', 'active'), ($2, $4, 'human', 'Principal B', 'active')`,
        [principalA, principalB, tenantA, tenantB],
      );

      const invocationInsert = `insert into core.action_invocations (action_invocation_id, tenant_id, legal_entity_id, principal_id, action_key, status, request_hash) values ($1, $2, $3, $4, 'isolation.test', 'received', 'bounded-hash')`;
      yield* expectForeignKeyFailure(invocationInsert, [
        randomUUID(),
        tenantA,
        entityB,
        principalA,
      ]);
      yield* expectForeignKeyFailure(invocationInsert, [
        randomUUID(),
        tenantA,
        entityA,
        principalB,
      ]);
      yield* queryEffect(client, invocationInsert, [invocationA, tenantA, entityA, principalA]);
      yield* expectForeignKeyFailure(
        `insert into core.tenant_module_state_changes (tenant_id, module_key, new_state, changed_by_principal_id, action_invocation_id, change_source) values ($1, 'core.shell', 'active', $2, $3, 'user')`,
        [tenantB, principalB, invocationA],
      );
    });
    const release = queryEffect(client, 'rollback').pipe(
      Effect.ensuring(Effect.sync(() => client.release())),
      Effect.ensuring(endPool(admin).pipe(Effect.orDie)),
    );
    yield* exercise.pipe(Effect.ensuring(release));
  }),
);
