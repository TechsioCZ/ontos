import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Cause, Context, Crypto, Deferred, Effect, Exit, Fiber, Layer, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TenantAccessBootstrap, TenantAccessBootstrapLive } from '../../src/access/bootstrap/index.ts';
import { tenantContextScopeId } from '../../src/access/bootstrap/persistence.ts';
import { AccessChangesStoreLive } from '../../src/access/changes/persistence/drizzle-store.ts';
import { tenantObjectId } from '../../src/access/compiler/object-id.ts';
import type { AccessRelationship } from '../../src/access/compiler/relationship.ts';
import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '../../src/access/compiler/spice-db-compiler.ts';
import { LegalEntityIdSchema, PrincipalIdSchema, TenantIdSchema } from '../../src/access/ids.ts';
import type { LegalEntityId, PrincipalId, TenantId } from '../../src/access/ids.ts';
import { AccessCatalogSnapshotWriterLive } from '../../src/access/intent/catalog-snapshot-writer.ts';
import {
  AccessMembershipIdSchema,
  AccessMembershipStore,
  AccessMembershipStoreLive,
} from '../../src/access/intent/memberships.ts';
import { AccessProjectionCompiler } from '../../src/access/intent/projection-compiler.ts';
import { AccessProjectionWriter, AccessProjectionWriterLive } from '../../src/access/intent/projection-writer.ts';
import { TenantIntentLoader, TenantIntentLoaderLive } from '../../src/access/intent/tenant-intent-loader.ts';
import type { TenantIntentLoaderService } from '../../src/access/intent/tenant-intent-loader.ts';
import { AccessWriteJournalStoreLive } from '../../src/access/lifecycle/persistence/journal-store.ts';
import type { AccessDeclarationInput, AccessCatalogModule } from '../../src/authorization/access-declaration.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../src/db/database-identities.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreRelations } from '../../src/db/schema.ts';
import type { CoreDatabaseExecutor } from '../../src/db/types.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';
import { newSpiceDbGrpcClient } from '../../src/permissions/spicedb-grpc-rpc.ts';
import { createTemplateDatabase, replacedDatabase } from '../support/access-scenarios/database.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

/*
 * The tenant's fence covers the intent read, not only the graph write (R5a-1).
 *
 * The single projection writer used to load and plan a tenant *before* taking that tenant's fence, so a
 * reconciliation that read a tenant while a person was still a member could project that snapshot after
 * a revocation had replaced it — restoring a member tuple nobody holds, whose still-active role then
 * grants the revoked person access. The fence now comes first: nothing is read until this operation holds
 * it, and the fence's revision proves the snapshot was not overtaken when the graph is written.
 *
 * Each case is that interleaving, paused where the old order read intent: before the fence (case 1) and
 * after the read with the fence already held (case 2). Revoking a membership and reconciling in the
 * middle is what a second Core request does, and the assertions are what the old order got wrong.
 *
 * Each case gets its own database beside the integration environment's, and its own random tenant in the
 * environment's SpiceDB.
 */

const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

const MODULE = 'billing.invoices';
const CAPABILITY = 'billing.invoices.invoice.read';

const entrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'billing.invoices.api.list',
  moduleKey: MODULE,
  role: 'api',
});
const declaration: AccessDeclarationInput = {
  key: CAPABILITY,
  kind: 'read',
  modes: ['run'],
  placement: { group: 'invoices', level: 'basic' },
  risk: 'routine',
  selectors: [],
};
const modules: readonly AccessCatalogModule[] = [
  { descriptors: [{ accessDeclaration: declaration, entrypoint }], moduleId: MODULE },
];

const owner = PrincipalIdSchema.make(uid(2));
const member = PrincipalIdSchema.make(uid(3));
const company = LegalEntityIdSchema.make(uid(4));
const memberMembership = uid(20);

/** The tenant as the product creates it: identity rows and one installed module, never any access. */
const seedTenant = (admin: PgClient.PgClient, tenantId: TenantId) =>
  Effect.gen(function* seedTenantEffect() {
    for (const statement of [
      `insert into core.tenants (tenant_id, slug, name, status, default_locale)
         values ('${tenantId}', 'c26-${tenantId}', 'C26 tenant', 'active', 'cs')`,
      `insert into core.legal_entities
         (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status)
         values ('${company}', '${tenantId}', 'C26 s.r.o.', 'CZ', '12345678', 'active')`,
      `insert into core.principals (principal_id, tenant_id, kind, display_name, status) values
         ('${owner}', '${tenantId}', 'human', 'Vlastník', 'active'),
         ('${member}', '${tenantId}', 'human', 'Člen', 'active')`,
      `insert into core.tenant_module_states (tenant_module_state_id, tenant_id, module_key, state) values
         ('${uid(5)}', '${tenantId}', '${MODULE}', 'active')`,
    ]) {
      yield* admin.unsafe(statement).pipe(Effect.orDie);
    }
  });

/** One trusted request scope: the acting person, the tenant and the selected company when given (O66). */
const scopeFor = (tenantId: TenantId, principalId: PrincipalId, legalEntityId?: LegalEntityId) => {
  const session = {
    authBindingId: uid(300),
    authContextRef: 'session:access-projection-fence:1',
    authMethod: 'session' as const,
    principalId,
    tenantId,
  };
  return Schema.decodeEffect(TrustedPrincipalContextSchema)(
    legalEntityId === undefined ? session : { ...session, legalEntityId },
  ).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'access-projection-fence' }) satisfies OperationalScope),
    Effect.orDie,
  );
};

/**
 * Where one reconciliation stops: before it pins the tenant fence (`fence_scope`), right after it read the
 * snapshot the pin covers (`projection`), or after it took the fence and is about to write the graph
 * (`fenced`).
 */
const PAUSE_POINTS = ['fence_scope', 'projection', 'fenced'] as const;

interface LoadPause {
  readonly at: (typeof PAUSE_POINTS)[number];
  readonly reached: Deferred.Deferred<null>;
  readonly resume: Deferred.Deferred<null>;
}

const holdUntilResumed = <Value, Failure>(effect: Effect.Effect<Value, Failure>, pause: LoadPause) =>
  effect.pipe(
    Effect.tap(() =>
      Deferred.succeed(pause.reached, null).pipe(Effect.andThen(Deferred.await(pause.resume)), Effect.asVoid),
    ),
  );

/** Holds an effect before it runs, so a reconciliation can be stopped between its fence and its write. */
const pauseBefore = <Value, Failure>(effect: Effect.Effect<Value, Failure>, pause: LoadPause) =>
  Effect.gen(function* pauseBeforeEffect() {
    yield* Deferred.succeed(pause.reached, null);
    yield* Deferred.await(pause.resume);
    return yield* effect;
  });

/** The loader one paused reconciliation reads through: it holds the call its pause point names. */
const pausingLoader = (base: TenantIntentLoaderService, pause: LoadPause): TenantIntentLoaderService => ({
  ...base,
  loadProjection: (scope) =>
    pause.at === 'projection' ? holdUntilResumed(base.loadProjection(scope), pause) : base.loadProjection(scope),
  loadTenantContextScopeId: (scope) =>
    pause.at === 'fence_scope'
      ? holdUntilResumed(base.loadTenantContextScopeId(scope), pause)
      : base.loadTenantContextScopeId(scope),
});

interface Tenant {
  readonly admin: PgClient.PgClient;
  readonly bootstrap: (typeof TenantAccessBootstrap)['Service'];
  readonly compiler: ReturnType<typeof makeAccessProjectionCompiler>;
  readonly memberships: (typeof AccessMembershipStore)['Service'];
  readonly pause: LoadPause;
  /** The writer of the paused reconciliation this case forks (A). */
  readonly pausedWriter: (typeof AccessProjectionWriter)['Service'];
  readonly tenantId: TenantId;
  /** The writer of every reconciliation that is not paused (B, and the repair after A). */
  readonly writer: (typeof AccessProjectionWriter)['Service'];
}

/**
 * One tenant of this suite's own. The writer is built twice: over the real intent loader, and over a
 * loader that holds one call, which is the only way to observe the order of "fence, then read".
 */
const withTenant = <Value, Failure>(
  pauseAt: (typeof PAUSE_POINTS)[number],
  run: (tenant: Tenant) => Effect.Effect<Value, Failure>,
) =>
  Effect.gen(function* tenantScenario() {
    const crypto = yield* Crypto.Crypto;
    const [connections, configuration] = yield* Effect.all([loadDatabaseConnectionPair(), loadSpiceDbConfig()], {
      concurrency: 2,
    }).pipe(Effect.orDie);
    const bootstrapConnection = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
    const database = `access_projection_fence_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
    yield* bootstrapConnection.unsafe(`create database "${database}"`).pipe(Effect.orDie);
    yield* Effect.addFinalizer(() =>
      bootstrapConnection.unsafe(`drop database if exists "${database}" with (force)`).pipe(Effect.orDie),
    );
    const admin = yield* makeTestPgClient(replacedDatabase(connections.admin.connectionString, database), {
      maxConnections: 2,
    });
    // The whole committed migration set, its login roles and their grants: the same schema every suite uses.
    yield* createTemplateDatabase(admin);
    const tenantId = TenantIdSchema.make(yield* crypto.randomUUIDv4());
    yield* seedTenant(admin, tenantId);
    const runtime = yield* makeTestPgClient(replacedDatabase(connections.runtime.connectionString, database), {
      maxConnections: 4,
    });
    const executor: CoreDatabaseExecutor = yield* makeTestDatabaseFromClient(runtime, coreRelations);
    // The suite owns the engine's schema, so it starts from exactly the v2 definitions Core serves.
    yield* Effect.acquireUseRelease(
      Effect.sync(() => newSpiceDbGrpcClient(configuration)),
      (client) =>
        Effect.tryPromise(() =>
          client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })),
        ).pipe(Effect.orDie),
      (client) => Effect.sync(() => client.close()),
    );
    const compiler = makeAccessProjectionCompiler(makeAccessProjectionTransport(configuration));
    const core = Layer.mergeAll(
      Layer.succeed(CoreDatabase, { executor }),
      Layer.succeed(DatabaseIdentityEnrollmentContext, FIXTURE_DATABASE_IDENTITY_ENROLLMENT),
    );
    const engine = Layer.succeed(AccessProjectionCompiler, compiler);
    const pause: LoadPause = {
      at: pauseAt,
      reached: yield* Deferred.make<null>(),
      resume: yield* Deferred.make<null>(),
    };
    // The paused writer's engine holds the write itself, which is the only way to stand between the fence
    // a reconciliation took and the tuples it writes under it.
    const pausedEngine = Layer.succeed(AccessProjectionCompiler, {
      ...compiler,
      reconcile: (intent, options) =>
        pause.at === 'fenced'
          ? pauseBefore(compiler.reconcile(intent, options), pause)
          : compiler.reconcile(intent, options),
    });
    const platforms = Layer.mergeAll(core, engine, NodeServices.layer);
    const intent = TenantIntentLoaderLive.pipe(Layer.provide(platforms));
    const journal = AccessWriteJournalStoreLive.pipe(Layer.provide(platforms));
    const changes = AccessChangesStoreLive.pipe(Layer.provide(platforms));
    const stores = Layer.mergeAll(platforms, intent, journal, changes);
    const base = Layer.mergeAll(
      stores,
      AccessMembershipStoreLive.pipe(Layer.provide(platforms)),
      AccessCatalogSnapshotWriterLive.pipe(Layer.provide(stores)),
      AccessProjectionWriterLive.pipe(Layer.provide(stores)),
    );
    const context = yield* Layer.build(Layer.mergeAll(base, TenantAccessBootstrapLive.pipe(Layer.provide(base))));
    const pausedIntent = Layer.effect(
      TenantIntentLoader,
      Effect.gen(function* pausingLoaderLayerEffect() {
        return pausingLoader(yield* TenantIntentLoader, pause);
      }),
    ).pipe(Layer.provide(intent));
    const pausedPlatforms = Layer.mergeAll(core, pausedEngine, NodeServices.layer);
    const pausedContext = yield* Layer.build(
      AccessProjectionWriterLive.pipe(Layer.provide(Layer.mergeAll(pausedPlatforms, pausedIntent, journal, changes))),
    );
    return yield* run({
      admin,
      bootstrap: Context.get(context, TenantAccessBootstrap),
      compiler,
      memberships: Context.get(context, AccessMembershipStore),
      pause,
      pausedWriter: Context.get(pausedContext, AccessProjectionWriter),
      tenantId,
      writer: Context.get(context, AccessProjectionWriter),
    });
  }).pipe(Effect.scoped);

/** The tenant's `member` tuples as the graph holds them: one subject object id per member. */
const tenantMembers = (relationships: readonly AccessRelationship[], tenantId: TenantId): readonly string[] =>
  relationships
    .filter(
      ({ relation, resourceId, resourceType }) =>
        relation === 'member' && resourceType === 'access_tenant' && resourceId === tenantObjectId(tenantId),
    )
    .map(({ subject }) => subject.objectId)
    .toSorted();

const asFailure = (cause: { readonly code: string; readonly reason: string }) =>
  new Error(`${cause.code}: ${cause.reason}`);

/** The tenant as a product creates it, with one member who is not the owner, projected into the graph. */
const preparedTenant = (tenant: Tenant) =>
  Effect.gen(function* preparedTenantEffect() {
    const scope = yield* scopeFor(tenant.tenantId, owner);
    yield* tenant.bootstrap
      .bootstrapTenantAccess({ legalEntityIds: [company], modules, scope })
      .pipe(Effect.mapError(asFailure), Effect.orDie);
    yield* tenant.admin
      .unsafe(`insert into core.access_memberships
        (membership_id, tenant_id, scope_id, principal_id, kind, status, valid_from, recorded_by)
        values ('${memberMembership}', '${tenant.tenantId}', '${tenantContextScopeId(tenant.tenantId)}', '${member}',
                'member', 'active', '1970-01-01T00:00:00Z'::timestamptz, '${owner}')`)
      .pipe(Effect.orDie);
    yield* tenant.writer.reconcileTenant({ scope }).pipe(Effect.mapError(asFailure), Effect.orDie);
    expect(tenantMembers(yield* tenant.compiler.readProjection([tenant.tenantId]), tenant.tenantId)).toEqual(
      [member, owner].toSorted(),
    );
    return scope;
  });

/** The revocation a second Core request commits while the first one is still reconciling. */
const revokeMember = (tenant: Tenant, scope: OperationalScope) =>
  tenant.memberships
    .setMembershipStatus(scope, {
      membershipId: AccessMembershipIdSchema.make(memberMembership),
      status: 'revoked',
    })
    .pipe(Effect.mapError(asFailure), Effect.orDie);

/** One reconciliation that stops at this case's pause point, and the fiber it is running on. */
const forkPausedReconciliation = (tenant: Tenant, scope: OperationalScope) =>
  Effect.gen(function* forkPausedReconciliationEffect() {
    const fiber = yield* Effect.forkChild(
      tenant.pausedWriter.reconcileTenant({ scope }).pipe(Effect.mapError((cause) => asFailure(cause))),
    );
    yield* Deferred.await(tenant.pause.reached);
    return fiber;
  });

it.layer(NodeServices.layer)('access projection fence', (suite) => {
  suite.effect('does not restore a revoked member when a reconcile was still waiting for the fence', () =>
    withTenant('fence_scope', (tenant) =>
      Effect.gen(function* revokedWhileWaitingForTheFence() {
        const scope = yield* preparedTenant(tenant);
        // A waits before its fence, so it has not read a single intent row yet.
        const a = yield* forkPausedReconciliation(tenant, scope);
        // The revocation commits and B projects it while A waits: the graph loses the member tuple.
        yield* revokeMember(tenant, scope);
        const b = yield* tenant.writer.reconcileTenant({ scope }).pipe(Effect.mapError(asFailure), Effect.orDie);
        expect(b.deletions).toBeGreaterThan(0);
        expect(b.verified).toBe(true);
        expect(tenantMembers(yield* tenant.compiler.readProjection([tenant.tenantId]), tenant.tenantId)).toEqual([
          owner,
        ]);

        // A resumes and takes the fence: it reads the intent as it is now, so its plan already lacks the
        // member and there is nothing to write back — under the old order this is where a tuple returned.
        yield* Deferred.succeed(tenant.pause.resume, null);
        const resumed = yield* Fiber.join(a).pipe(Effect.orDie);
        expect(resumed.verified).toBe(true);
        expect(resumed.touches).toBe(0);
        expect(resumed.deletions).toBe(0);
        expect(tenantMembers(yield* tenant.compiler.readProjection([tenant.tenantId]), tenant.tenantId)).toEqual([
          owner,
        ]);
      }),
    ),
  );

  suite.effect('refuses a snapshot the fence moved past instead of projecting a revoked member back', () =>
    withTenant('projection', (tenant) =>
      Effect.gen(function* snapshotOvertakenWhileReading() {
        const scope = yield* preparedTenant(tenant);
        // A pinned the tenant's fence revision and read a snapshot that still carries the member.
        const a = yield* forkPausedReconciliation(tenant, scope);
        // The revocation commits and B projects it: the fence moves two revisions while A holds its snapshot.
        yield* revokeMember(tenant, scope);
        const b = yield* tenant.writer.reconcileTenant({ scope }).pipe(Effect.mapError(asFailure), Effect.orDie);
        expect(b.deletions).toBeGreaterThan(0);
        expect(b.verified).toBe(true);
        expect(tenantMembers(yield* tenant.compiler.readProjection([tenant.tenantId]), tenant.tenantId)).toEqual([
          owner,
        ]);

        // A resumes: its compare-and-set finds the fence at another revision, so the snapshot it planned is
        // refused instead of written — the stale projection never reaches the graph (R5a-1).
        yield* Deferred.succeed(tenant.pause.resume, null);
        const exit = yield* Effect.exit(Fiber.join(a));
        expect(Exit.isFailure(exit)).toBe(true);
        expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : 'projected').toContain(
          'access_projection_write_fence_refused',
        );
        expect(tenantMembers(yield* tenant.compiler.readProjection([tenant.tenantId]), tenant.tenantId)).toEqual([
          owner,
        ]);
      }),
    ),
  );

  suite.effect('keeps a revocation from being overwritten: a snapshot read under the fence cannot be pre-empted', () =>
    withTenant('fenced', (tenant) =>
      Effect.gen(function* noSnapshotOutsideTheFence() {
        const scope = yield* preparedTenant(tenant);
        // A holds the fence and has read the tenant's intent; it is paused before writing it.
        const a = yield* forkPausedReconciliation(tenant, scope);
        // The revocation commits, but B cannot project it: this tenant's fence belongs to A.
        yield* revokeMember(tenant, scope);
        const b = yield* Effect.result(tenant.writer.reconcileTenant({ scope }));
        expect(Result.isFailure(b)).toBe(true);
        expect(Result.isFailure(b) ? b.failure.code : 'allowed').toBe('access_projection_write_fence_refused');
        expect(Result.isFailure(b) ? b.failure.reason : '').toContain('held by operation');

        // A's snapshot still carries the member and nothing projected in between, so A writes nothing and
        // releases the fence; the graph is exactly the snapshot A read under its own fence.
        yield* Deferred.succeed(tenant.pause.resume, null);
        const resumed = yield* Fiber.join(a).pipe(Effect.orDie);
        expect(resumed.verified).toBe(true);
        expect(resumed.touches).toBe(0);
        expect(tenantMembers(yield* tenant.compiler.readProjection([tenant.tenantId]), tenant.tenantId)).toEqual(
          [member, owner].toSorted(),
        );

        // The next reconciliation is the revocation's own and removes the tuple A could not overwrite.
        const repair = yield* tenant.writer.reconcileTenant({ scope }).pipe(Effect.mapError(asFailure), Effect.orDie);
        expect(repair.deletions).toBeGreaterThan(0);
        expect(repair.verified).toBe(true);
        expect(tenantMembers(yield* tenant.compiler.readProjection([tenant.tenantId]), tenant.tenantId)).toEqual([
          owner,
        ]);
      }),
    ),
  );
});
