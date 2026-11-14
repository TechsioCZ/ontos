import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Context, Crypto, Effect, Function as Fn, Layer, Redacted, Schema } from 'effect';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { AccessEnforcementPortsLive } from '../../src/actions/runtime-wiring.ts';
import { TenantAccessBootstrapLive } from '../../src/access/bootstrap/index.ts';
import { AccessChangesStoreLive, AccessReleaseStoreLive } from '../../src/access/changes/persistence/drizzle-store.ts';
import type { AccessProjectionCompiler as AccessProjectionCompilerEngine } from '../../src/access/compiler/spice-db-compiler.ts';
import { CoreAuthorizationProjectionCompilerLive } from '../../src/access/compiler/spice-db-compiler.ts';
import { AccessDecisionLive } from '../../src/access/enforcement/service.ts';
import { LegalEntityIdSchema, PrincipalIdSchema, TenantIdSchema } from '../../src/access/ids.ts';
import type { LegalEntityId, TenantId } from '../../src/access/ids.ts';
import { AccessCatalogSnapshotWriterLive } from '../../src/access/intent/catalog-snapshot-writer.ts';
import { AccessMembershipStoreLive } from '../../src/access/intent/memberships.ts';
import { AccessProjectionCompiler } from '../../src/access/intent/projection-compiler.ts';
import { AccessProjectionWriterLive } from '../../src/access/intent/projection-writer.ts';
import { TenantIntentLoader, TenantIntentLoaderLive } from '../../src/access/intent/tenant-intent-loader.ts';
import type { TenantIntentLoaderService } from '../../src/access/intent/tenant-intent-loader.ts';
import { AccessWriteJournalStoreLive } from '../../src/access/lifecycle/persistence/journal-store.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { DatabaseIdentityEnrollmentContext } from '../../src/db/database-identities.ts';
import { coreRelations } from '../../src/db/schema.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { loadSpiceDbConfig, SpiceDbConfig } from '../../src/permissions/config.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';
import { newSpiceDbGrpcClient } from '../../src/permissions/spicedb-grpc-rpc.ts';
import { createTemplateDatabase, insertTenantStatement, replacedDatabase } from './access-scenarios/database.ts';
import { acquireOutlivingCleanup, layerTestDatabaseFromClient } from './database.ts';
import type { TestDatabaseFromClient } from './database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from './database-identities.ts';

/*
 * One Tenant on a private database (created from Core's migrations, dropped afterwards) and the shared SpiceDB with
 * the v2 schema, composed with the real projection writer, journal store, bootstrap and gate. A suite may wrap the
 * engine compiler, e.g. to hold a projection inside its engine write.
 */
class ScenarioCoreDatabase extends Context.Service<
  ScenarioCoreDatabase,
  TestDatabaseFromClient<typeof coreRelations>
>()('@app/core-runtime/tests/support/projection-tenant-scenario/ScenarioCoreDatabase') {}

/** A native client that stays usable for every cleanup finalizer the scenario registers after it. */
const acquireScenarioPgClient = (connectionString: string, maxConnections: number) =>
  acquireOutlivingCleanup(Layer.build(PgClient.layer({ maxConnections, url: Redacted.make(connectionString) }))).pipe(
    Effect.map(Context.get(PgClient.PgClient)),
  );

export const scenarioUid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
export const SCENARIO_OWNER = PrincipalIdSchema.make(scenarioUid(2));
export const SCENARIO_COMPANY = LegalEntityIdSchema.make(scenarioUid(4));

export interface ProjectionTenantOptions {
  /** Module states the Tenant has before the suite runs, all `active`. */
  readonly activeModules?: readonly string[];
  readonly wrapCompiler?: (compiler: AccessProjectionCompilerEngine) => AccessProjectionCompilerEngine;
  /** Wraps the intent loader, e.g. to commit an intent write right after the writer read the tenant. */
  readonly wrapIntentLoader?: (loader: TenantIntentLoaderService) => TenantIntentLoaderService;
}

const seedTenant = (admin: PgClient.PgClient, tenantId: TenantId, activeModules: readonly string[]) =>
  Effect.forEach(
    [
      insertTenantStatement(tenantId),
      `insert into core.legal_entities
         (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status) values
         ('${SCENARIO_COMPANY}', '${tenantId}', 'Firma A s.r.o.', 'CZ', '11111111', 'active')`,
      `insert into core.principals (tenant_id, principal_id, kind, display_name, status) values
         ('${tenantId}', '${SCENARIO_OWNER}', 'human', 'Vlastník', 'active')`,
      ...activeModules.map(
        (moduleKey, index) =>
          `insert into core.tenant_module_states (tenant_module_state_id, tenant_id, module_key, state) values
             ('${scenarioUid(600 + index)}', '${tenantId}', '${moduleKey}', 'active')`,
      ),
    ],
    (statement) => admin.unsafe(statement).pipe(Effect.orDie),
    { discard: true },
  );

/** The owner's trusted session scope, in the Tenant or in its company. */
export const ownerScope = (tenantId: TenantId, legalEntityId?: LegalEntityId) => {
  const session = {
    authBindingId: scenarioUid(300),
    authContextRef: 'session:projection-tenant-scenario:1',
    authMethod: 'session' as const,
    principalId: SCENARIO_OWNER,
    tenantId,
  };
  return Schema.decodeEffect(TrustedPrincipalContextSchema)(
    legalEntityId === undefined ? session : { ...session, legalEntityId },
  ).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'projection-tenant-scenario' }) satisfies OperationalScope),
    Effect.orDie,
  );
};

export const withProjectionTenant = <Value, Failure, Requirements>(
  options: ProjectionTenantOptions,
  run: (tenantId: TenantId, admin: PgClient.PgClient) => Effect.Effect<Value, Failure, Requirements>,
) =>
  Effect.gen(function* projectionTenantScenario() {
    const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    const crypto = yield* Crypto.Crypto;
    const configuration = yield* loadSpiceDbConfig({ envPath: '/dev/null' });
    const bootstrapConnection = yield* acquireScenarioPgClient(connections.admin.connectionString, 1);
    const database = `projection_tenant_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
    yield* bootstrapConnection.unsafe(`create database "${database}"`).pipe(Effect.orDie);
    yield* Effect.addFinalizer(() =>
      bootstrapConnection.unsafe(`drop database if exists "${database}" with (force)`).pipe(Effect.orDie),
    );
    const admin = yield* acquireScenarioPgClient(replacedDatabase(connections.admin.connectionString, database), 2);
    yield* createTemplateDatabase(admin);
    const tenantId = TenantIdSchema.make(yield* crypto.randomUUIDv4());
    yield* seedTenant(admin, tenantId, options.activeModules ?? []);
    const runtime = yield* acquireScenarioPgClient(replacedDatabase(connections.runtime.connectionString, database), 4);
    const executor = Context.get(
      yield* Layer.build(layerTestDatabaseFromClient(ScenarioCoreDatabase, runtime, coreRelations)),
      ScenarioCoreDatabase,
    );
    yield* Effect.acquireUseRelease(
      Effect.sync(() => newSpiceDbGrpcClient(configuration)),
      (client) =>
        Effect.suspend(() =>
          Effect.tryPromise(
            Fn.constant(client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA }))),
          ),
        ).pipe(Effect.orDie),
      (client) => Effect.sync(() => client.close()),
    );
    const engine = Context.get(
      yield* Layer.build(
        CoreAuthorizationProjectionCompilerLive.pipe(Layer.provide(Layer.succeed(SpiceDbConfig, configuration))),
      ),
      AccessProjectionCompiler,
    );
    const compiler = options.wrapCompiler === undefined ? engine : options.wrapCompiler(engine);
    const platforms = Layer.mergeAll(
      Layer.succeed(CoreDatabase, { executor }),
      Layer.succeed(DatabaseIdentityEnrollmentContext, FIXTURE_DATABASE_IDENTITY_ENROLLMENT),
      Layer.succeed(AccessProjectionCompiler, compiler),
      NodeServices.layer,
    );
    const { wrapIntentLoader } = options;
    const liveLoader = TenantIntentLoaderLive.pipe(Layer.provide(platforms));
    const loader =
      wrapIntentLoader === undefined
        ? liveLoader
        : Layer.effect(
            TenantIntentLoader,
            Effect.gen(function* wrappedIntentLoader() {
              return wrapIntentLoader(yield* TenantIntentLoader);
            }),
          ).pipe(Layer.provide(liveLoader));
    const stores = Layer.mergeAll(
      platforms,
      loader,
      AccessWriteJournalStoreLive.pipe(Layer.provide(platforms)),
      AccessChangesStoreLive.pipe(Layer.provide(platforms)),
      AccessReleaseStoreLive.pipe(Layer.provide(platforms)),
    );
    const base = Layer.mergeAll(
      stores,
      AccessMembershipStoreLive.pipe(Layer.provide(platforms)),
      AccessCatalogSnapshotWriterLive.pipe(Layer.provide(stores)),
      AccessProjectionWriterLive.pipe(Layer.provide(stores)),
    );
    const context = yield* Layer.build(
      Layer.mergeAll(
        base,
        TenantAccessBootstrapLive.pipe(Layer.provide(base)),
        AccessDecisionLive.pipe(Layer.provide(AccessEnforcementPortsLive), Layer.provide(base)),
      ),
    );
    return yield* run(tenantId, admin).pipe(Effect.provideContext(context));
  }).pipe(Effect.scoped);
