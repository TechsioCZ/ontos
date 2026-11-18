import { eq } from 'drizzle-orm';
import { pgSchema, uuid } from 'drizzle-orm/pg-core';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { Cause, Crypto, Effect, Exit, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { trustVerifiedGatewayPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import { coreRelations } from '../../src/db/schema.ts';
import { defineScopedRoutine, ScopedRoutineInvocationError } from '../../src/db/scoped-routine.ts';
import type { ScopedTransactionExecutor } from '../../src/db/scoped-transaction.ts';
import { defineSystemModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import type { ReadFinishContext } from '../../src/reads/context.ts';
import type {
  ReadHandlerUnavailable,
  ReadPermissionDenied,
  ReadPermissionUnavailable,
} from '../../src/reads/errors.ts';
import { ReadHandlerExecutionError } from '../../src/reads/errors.ts';
import { defineRead } from '../../src/reads/definition.ts';
import { makeReadRuntime } from '../../src/reads/runtime.ts';
import { makeIsolatedNativeDatabaseFixture } from '../../src/testing/isolated-native-database.ts';
import { testOperationalScopeResolver } from '../fixtures/operational-scope.ts';
import { fixtureReadAccess } from '../support/access-declaration-fixtures.ts';
import { makeTestOperationOwner } from '../support/action-runtime-options.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { openModuleEntrypointGateway } from '../support/open-module-entrypoint-gateway.ts';

const nextUuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());

/** The owner's own state: a grant row its rule locks, and the rows its write-capable routine would add. */
const ownerSchema = pgSchema('read_finish_owner');
const ownerGrants = ownerSchema.table('grants', { tenantId: uuid('tenant_id').primaryKey() });
const ownerMarkers = ownerSchema.table('markers', { tenantId: uuid('tenant_id').notNull() });

/** A SECURITY DEFINER owner routine that writes: exactly what a write-capable read service would call. */
const recordMarkerRoutine = defineScopedRoutine({
  name: 'record_marker',
  ownerModuleKey: 'core.shell',
  parameters: [{ source: 'tenantId', type: 'uuid' }],
  resultSchema: Schema.Struct({ payload: Schema.Unknown }),
  routineKey: 'finish.record-marker',
  schema: 'read_finish_owner',
});

const ownerReadServices = (transaction: ScopedTransactionExecutor) =>
  Effect.succeed({
    markers: () =>
      transaction
        .select()
        .from(ownerMarkers)
        .where(eq(ownerMarkers.tenantId, transaction.scope.tenantId))
        .pipe(Effect.orDie),
    recordMarker: () => transaction.invoke(recordMarkerRoutine, []),
  });
type OwnerReadServices = Effect.Success<ReturnType<typeof ownerReadServices>>;

/** Core's owner rule for this read: it locks the owner's grant row, which PostgreSQL refuses once read-only. */
const lockingOwnerRule = (decisions: string[]) => ({
  authorize: (transaction: ScopedTransactionExecutor) =>
    transaction
      .select({ tenantId: ownerGrants.tenantId })
      .from(ownerGrants)
      .where(eq(ownerGrants.tenantId, transaction.scope.tenantId))
      .for('update')
      .pipe(
        Effect.match({
          onFailure: () => 'unavailable' as const,
          onSuccess: (rows) => (rows.length === 1 ? ('allowed' as const) : ('denied' as const)),
        }),
        Effect.tap((decision) => Effect.sync(() => decisions.push(decision))),
      ),
});

type OwnerWriteFailure =
  | ScopedRoutineInvocationError
  | ReadHandlerUnavailable
  | ReadPermissionDenied
  | ReadPermissionUnavailable;

/** What the owner's finish saw: its successful read, and the failure of its write. */
interface FinishObservations {
  readonly markersSeen: number[];
  writeFailure?: OwnerWriteFailure;
}

/** In one finish owner transaction: a successful owner read, then a write through the owner's routine. */
const readThenWrite = (observed: FinishObservations) => (services: OwnerReadServices) =>
  Effect.gen(function* readThenWriteMarker() {
    observed.markersSeen.push((yield* services.markers()).length);
    yield* services.recordMarker();
  });

const recordWriteFailure = (observed: FinishObservations) => (failure: OwnerWriteFailure) =>
  Effect.sync(() => {
    observed.writeFailure = failure;
  });

const finishWithOwnerWrite =
  (observed: FinishObservations) =>
  (
    _input: Readonly<Record<string, never>>,
    context: ReadFinishContext<undefined, readonly string[], OwnerReadServices>,
  ) =>
    Effect.gen(function* finishWithOwnerWriteStep() {
      yield* context.transaction(readThenWrite(observed)).pipe(Effect.tapError(recordWriteFailure(observed)));
      return { evidence: { resultCount: context.loaded.length }, result: [...context.loaded] };
    });

// CI only: needs the native PostgreSQL test database. It has not run on a developer laptop.
it.layer(NodeCrypto.layer.pipe(Layer.provideMerge(NodeServices.layer)), { excludeTestServices: true })(
  'staged read finish owner transaction',
  (suite) => {
    suite.effect('PostgreSQL refuses a routine write in a finish owner transaction and nothing survives', () =>
      Effect.gen(function* finishWriteRefused() {
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          mode: 'empty',
          purpose: 'stabilization-1287-core-operation-fence',
        });
        yield* isolated.migrateCoreSchema();
        const admin = yield* makeTestPgClient(isolated.connections.admin.connectionString);
        const runtimeClient = yield* makeTestPgClient(isolated.connections.runtime.connectionString);
        const database = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
        const tenantId = yield* nextUuid;
        const principalId = yield* nextUuid;
        const authBindingId = yield* nextUuid;
        const readKey = `core.shell.finish-read-only.${yield* nextUuid}`;
        const [runtimeRole] = yield* runtimeClient.unsafe<{ readonly role: string }>('select current_user as role');
        const { role } = Option.getOrThrow(Option.fromNullishOr(runtimeRole));
        yield* admin.unsafe('create schema read_finish_owner');
        yield* admin.unsafe('create table read_finish_owner.grants (tenant_id uuid primary key)');
        yield* admin.unsafe('create table read_finish_owner.markers (tenant_id uuid not null)');
        yield* admin.unsafe(
          `create function read_finish_owner.record_marker(p_tenant_id uuid) returns table (payload jsonb)
           language sql security definer set search_path = pg_catalog as $$
             insert into read_finish_owner.markers (tenant_id) values (p_tenant_id) returning to_jsonb(tenant_id)
           $$`,
        );
        yield* admin.unsafe(`grant usage on schema read_finish_owner to "${role}"`);
        // The owner rule may lock its grant row, so the runtime role holds UPDATE on it; the markers are
        // readable only, and only the definer routine can add one.
        yield* admin.unsafe(`grant select, update on read_finish_owner.grants to "${role}"`);
        yield* admin.unsafe(`grant select on read_finish_owner.markers to "${role}"`);
        yield* admin.unsafe(`grant execute on function read_finish_owner.record_marker(uuid) to "${role}"`);
        yield* admin.unsafe(
          `insert into core.tenants (tenant_id, slug, name, status, default_locale) values ($1, $2, 'Finish read-only tenant', 'active', 'en')`,
          [tenantId, `finish-read-only-${tenantId}`],
        );
        yield* admin.unsafe(
          `insert into core.principals (principal_id, tenant_id, kind, display_name, status) values ($1, $2, 'human', 'Finish read-only principal', 'active')`,
          [principalId, tenantId],
        );
        yield* admin.unsafe(
          `insert into core.principal_auth_bindings (principal_auth_binding_id, tenant_id, principal_id, authentication_namespace_id, provider, provider_subject_id, subject_type, status) values ($1, $2, $3, 'finish-read-only.fixture', 'better_auth', $4, 'user', 'active')`,
          [authBindingId, tenantId, principalId, authBindingId],
        );
        yield* admin.unsafe('insert into read_finish_owner.grants (tenant_id) values ($1)', [tenantId]);
        const principal = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
          authBindingId,
          authContextRef: `better-auth-session:${authBindingId}`,
          authMethod: 'session',
          principalId,
          tenantId,
        });

        const decisions: string[] = [];
        const observed: FinishObservations = { markersSeen: [] };
        const registration = defineRead(
          {
            accessDeclaration: fixtureReadAccess('core.shell'),
            accessKind: 'list',
            entrypoint: defineSystemModuleEntrypoint({
              access: 'read',
              authorization: { kind: 'context_permission', permission: 'module.access' },
              entrypointKey: readKey,
              moduleKey: 'core.shell',
              role: 'api',
            }),
            evidencePolicy: { captureMode: 'metadata_only', policyKey: `${readKey}.v1` },
            inputSchema: Schema.Struct({}),
            legalEntityScope: 'forbidden',
            owningModuleKey: 'core.shell',
            permissionTarget: 'module',
            policies: [],
            readKey,
            resultSchema: Schema.Array(Schema.String),
            schemaVersion: '1',
          },
          {
            finish: finishWithOwnerWrite(observed),
            load: () => Effect.succeed(['visible']),
          },
          ownerReadServices,
          () => ({ kind: 'module', moduleId: 'core.shell' }),
        );
        const owner = makeTestOperationOwner({ moduleId: 'core.shell', reads: [registration] });
        const snapshot = yield* owner.snapshot;
        yield* isolated.publishInitialComposition(snapshot);
        const runtime = makeReadRuntime(
          { executor: database },
          openModuleEntrypointGateway,
          testOperationalScopeResolver,
          {
            legalEntities: () => Effect.succeed([]),
            modules: () => Effect.succeed([]),
            resources: () => Effect.succeed([]),
            tenants: () => Effect.succeed([]),
          },
          {
            applicationComposition: { load: Effect.succeed(snapshot) },
            expectedDeployment: owner.expectedDeployment,
            ownerAuthorizationOverlay: lockingOwnerRule(decisions),
            ownerRegistration: owner.ownerRegistration,
          },
        );
        const exit = yield* Effect.exit(
          runtime.runRead({
            input: {},
            principal: trustVerifiedGatewayPrincipalContext(principal, snapshot.composition.revision),
            registration,
            transport: { correlationId: yield* nextUuid },
          }),
        );

        // The locking owner rule ran before the switch to read-only and allowed load, finish and release.
        expect(decisions).toEqual(['allowed', 'allowed', 'allowed']);
        // The read callback succeeded inside the read-only owner transaction.
        expect(observed.markersSeen).toEqual([0]);
        // PostgreSQL itself refused the routine write: SQLSTATE 25006, read_only_sql_transaction.
        const { writeFailure } = observed;
        expect(Schema.is(ScopedRoutineInvocationError)(writeFailure)).toBe(true);
        expect(
          Schema.is(ScopedRoutineInvocationError)(writeFailure) ? writeFailure.postgresCode : Option.none(),
        ).toEqual(Option.some('25006'));
        // finish propagated the refused write; Core released it, as the owner's undeclared failure, only after
        // the third (release) decision above allowed the Read under the final fence.
        const callerFailure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
        expect(Option.exists(callerFailure, Schema.is(ReadHandlerExecutionError))).toBe(true);
        // No mutation survives, and the refused Read wrote no allowed evidence.
        const markers = yield* admin.unsafe<{ readonly count: string }>(
          'select count(*)::text as count from read_finish_owner.markers',
        );
        expect(markers).toEqual([{ count: '0' }]);
        const evidence = yield* admin.unsafe<{ readonly outcome_code: string }>(
          'select outcome_code from core.data_access_events where tenant_id = $1',
          [tenantId],
        );
        expect(evidence.map((row) => row.outcome_code)).not.toContain('read_allowed');
      }),
    );
  },
);
