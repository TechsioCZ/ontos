import { createHash, randomUUID } from 'node:crypto';
import { deadlineInterceptor, v1 } from '@authzed/authzed-node';
import {
  ActiveApplicationCompositionService,
  ActionAlreadyCommitted,
  ActionRuntime,
  ActionPermissionDenied,
  ActionTransactionError,
  ContextAccessLive,
  GatewayAssertionRedemptionService,
  ReadRuntime,
  ReadPermissionDenied,
  toContextPermissionAccessObjectId,
  runAction,
  loadDatabaseConnectionPair,
  findPostgresFailure,
} from '@app/core-runtime';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { bindGatewayPrincipalVerifier } from '@app/gateway-principal-verifier/server';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION, GATEWAY_ASSERTION_TTL_SECONDS } from '@app/shared-contracts';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { eq, and, sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import {
  Config,
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Result,
  Schema,
  Scope,
  Stream,
} from 'effect';
import { Reactivity } from 'effect/reactivity';
import { ChildProcess } from 'effect/process';
import { assert, expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive,
} from '../../api/auth/gateway-assertion-redemption.ts';
import { OutboxPayloadSchema as CustomerGroupArchivedPayloadSchema } from '../../shared/outbox/commerce-customer-context-customer-group-archived-v1.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { CreateCounterpartyPurchasingProfilePayloadSchema } from '../../shared/actions/create-counterparty-purchasing-profile.ts';
import {
  CustomerGroupRevisionConflict,
  CustomerGroupMembershipNotFound,
  CustomerGroupMembershipOverlap,
  CustomerGroupMembershipRemovalConflict,
} from '../../shared/domain/group-errors.ts';
import {
  CustomerGroupActionAuditEvidenceSchema,
  CustomerGroupIsoTimestampSchema,
  CommerceCustomerProfileSubjectSchema,
} from '../../shared/domain/group-contract.ts';
import type { CustomerGroupMembershipRefSchema } from '../../shared/resources/customer-group-membership.ts';
import type { CustomerGroupRefSchema } from '../../shared/resources/customer-group.ts';
import { CounterpartyRefSchema } from '../../shared/domain/access-contract.ts';
import { createCounterpartyPurchasingProfileAction } from '../../src/actions/create-counterparty-purchasing-profile.action.ts';
import { createCustomerGroupAction } from '../../src/actions/create-customer-group.action.ts';
import { assignCustomerGroupAction } from '../../src/actions/assign-customer-group.action.ts';
import { removeCustomerGroupAction } from '../../src/actions/remove-customer-group.action.ts';
import { archiveCustomerGroupAction } from '../../src/actions/archive-customer-group.action.ts';
import { reactivateCustomerGroupAction } from '../../src/actions/reactivate-customer-group.action.ts';
import { effectiveCustomerGroupMembershipsRead } from '../../src/api/effective-customer-group-memberships.read.ts';
import {
  commerceCustomerContextRelations,
  customerGroupMemberships,
  customerGroupLifecyclePeriods,
  customerSettingRevisions,
} from '../../src/database/schema.ts';
import { commerceCustomerContextOwnerAuthorizationOverlayLive } from '../../src/persistence/owner-authorization-overlay.ts';
import { ProfileCounterpartyRoleEligibilityResolverFactory } from '../../src/profile-counterparty-role-eligibility.ts';
import { profileRetailPermissionReaderFactoryLive } from '../../src/integrations/retail-permission-reader.ts';
import {
  profileReactivationEligibilityEvaluatorFactoryLive,
  profileReconfirmationPolicyUnavailableLive,
} from '../../src/integrations/profile-reactivation-eligibility.ts';
import { partyRegistryGuestResolverFactoryLive } from '../../src/integrations/party-registry-guest-resolver.ts';
import { partyRegistryRetailPartyResolverFactoryLive } from '../../src/integrations/party-registry-retail-party-resolver.ts';
import { enrollmentApplicationCompositionSnapshot } from '../support/enrollment-application-composition.ts';

const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

const journalFingerprint = Effect.fn('GroupArchive.journalFingerprint')(function* journalFingerprint(connection: {
  readonly connectionString: string;
  readonly database: string;
  readonly user: string;
}) {
  const child = yield* ChildProcess.make(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      'PGPASSWORD',
      'ontos-db',
      'psql',
      '--host',
      'localhost',
      '--username',
      connection.user,
      '--dbname',
      connection.database,
      '--tuples-only',
      '--no-align',
      '--quiet',
      '--command',
      "set time zone 'UTC'; select md5(coalesce(jsonb_agg(to_jsonb(journal) order by to_jsonb(journal)::text)::text,'[]')) from drizzle.__drizzle_migrations_commerce_customer_context journal",
    ],
    {
      env: {
        PATH: yield* Config.String('PATH'),
        PGPASSWORD: decodeURIComponent(new URL(connection.connectionString).password),
      },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const [status, output] = yield* Effect.all(
    [child.exitCode, child.stdout.pipe(Stream.decodeText(), Stream.runCollect), Stream.runDrain(child.stderr)],
    { concurrency: 3 },
  );
  expect(Number(status)).toBe(0);
  return yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)))(
    output.join('').trim(),
  );
});

// Real source bookkeeping only, matching the schema clone. No fabricated applied rows or business data.
const copyOwnerBookkeeping = Effect.fn('GroupArchive.copyOwnerBookkeeping')(
  function* copyOwnerBookkeeping(connections: {
    readonly admin: { readonly connectionString: string; readonly database: string; readonly user: string };
  }) {
    const source = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    const before = yield* journalFingerprint(source.admin);
    const dump = yield* ChildProcess.make(
      'docker',
      [
        'exec',
        '-i',
        '-e',
        'PGPASSWORD',
        'ontos-db',
        'pg_dump',
        '--host',
        'localhost',
        '--username',
        source.admin.user,
        '--dbname',
        source.admin.database,
        '--data-only',
        '--column-inserts',
        '--table',
        'drizzle.__drizzle_migrations_commerce_customer_context',
      ],
      {
        env: {
          PATH: yield* Config.String('PATH'),
          PGPASSWORD: decodeURIComponent(new URL(source.admin.connectionString).password),
        },
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );
    const restore = yield* ChildProcess.make(
      'docker',
      [
        'exec',
        '-i',
        '-e',
        'PGPASSWORD',
        'ontos-db',
        'psql',
        '--host',
        'localhost',
        '--username',
        connections.admin.user,
        '--dbname',
        connections.admin.database,
        '--set',
        'ON_ERROR_STOP=1',
        '--quiet',
      ],
      {
        env: {
          PATH: yield* Config.String('PATH'),
          PGPASSWORD: decodeURIComponent(new URL(connections.admin.connectionString).password),
        },
        stderr: 'pipe',
        stdin: dump.stdout,
        stdout: 'pipe',
      },
    );
    const [dumpExit, restoreExit] = yield* Effect.all(
      [
        dump.exitCode,
        restore.exitCode,
        Stream.runDrain(dump.stderr),
        Stream.runDrain(restore.stderr),
        Stream.runDrain(restore.stdout),
      ],
      { concurrency: 5 },
    );
    expect(Number(dumpExit)).toBe(0);
    expect(Number(restoreExit)).toBe(0);
    expect(yield* journalFingerprint(connections.admin)).toBe(before);
    expect(yield* journalFingerprint(source.admin)).toBe(before);
  },
);

// Actual CLI/full immutable journal. Child-only configuration never changes the source database.
const migrateOwner = Effect.fn('GroupArchive.migrateOwner')(function* migrateOwner(
  connections: {
    readonly admin: { readonly connectionString: string };
    readonly runtime: { readonly connectionString: string };
  },
  command: 'migrate' | 'verify' = 'migrate',
  horizon: 'BEFORE_ARCHIVE' | 'CURRENT' = 'CURRENT',
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-group-archive-' });
  const configuration = path.join(directory, 'drizzle.config.mjs');
  const ownerDirectory = new URL('../../drizzle/', import.meta.url).pathname;
  const migrations = horizon === 'CURRENT' ? ownerDirectory : path.join(directory, 'migrations');
  if (horizon === 'BEFORE_ARCHIVE') {
    yield* fs.makeDirectory(migrations);
    for (const folder of yield* fs.readDirectory(ownerDirectory)) {
      if (folder < '20261019212748_group_archive_scheduled_memberships') {
        yield* fs.copy(path.join(ownerDirectory, folder), path.join(migrations, folder));
      }
    }
  }
  yield* fs.writeFileString(
    configuration,
    `export default { dialect:'postgresql', out:process.env.ONTOS_CCC_GROUP_MIGRATIONS, schema:process.env.ONTOS_CCC_GROUP_SCHEMA, dbCredentials:{url:process.env.DATABASE_ADMIN_URL}, migrations:{schema:'drizzle',table:'__drizzle_migrations_commerce_customer_context'} };`,
  );
  const child = yield* ChildProcess.make(
    'mise',
    [
      'exec',
      '--',
      'pnpm',
      '--filter',
      '@app/commerce-customer-context',
      'exec',
      ...(command === 'migrate'
        ? ['drizzle-kit', 'migrate', '--config', configuration]
        : ['node', 'scripts/verify-db-schema.mts']),
    ],
    {
      cwd: new URL('../../../../', import.meta.url).pathname,
      env: {
        DATABASE_ADMIN_URL: connections.admin.connectionString,
        DATABASE_URL: connections.runtime.connectionString,
        ONTOS_CCC_GROUP_MIGRATIONS: migrations,
        ONTOS_CCC_GROUP_SCHEMA: new URL('../../src/database/schema.ts', import.meta.url).pathname,
      },
      extendEnv: true,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    },
  );
  const [status, diagnostics] = yield* Effect.all(
    [child.exitCode, child.stderr.pipe(Stream.decodeText(), Stream.runCollect), Stream.runDrain(child.stdout)],
    { concurrency: 3 },
  );
  if (Number(status) !== 0) {
    const text = diagnostics.join('');
    const sqlState = /(?:code|sqlState|sqlstate):\s*['"](?<sqlState>[A-Z0-9]{5})['"]/u.exec(text)?.groups?.sqlState;
    const position = /position:\s*['"]?(?<position>\d+)/u.exec(text)?.groups?.position;
    yield* Effect.logError({
      failureClass: 'MIGRATION_CHILD_FAILURE',
      knownLeasedBoundary: '20261019212748_group_archive_scheduled_memberships',
      position: position ?? 'UNAVAILABLE',
      sqlState: sqlState ?? 'UNAVAILABLE',
    });
  }
  expect(Number(status)).toBe(0);
});

const normalizeBody = (value: string) => value.replaceAll('\r\n', '\n').trim();
const archiveMigration = '20261019212748_group_archive_scheduled_memberships';
const archiveMigrationInstant = Date.UTC(2026, 9, 19, 21, 27, 48);
const ownerModuleKey = 'commerce.customer-context';
const audience = 'commerce-customer-context';
class GroupArchiveFixturePermissionFailure extends Schema.TaggedError<GroupArchiveFixturePermissionFailure>()(
  'GroupArchiveFixturePermissionFailure',
  { reason: Schema.String },
) {}

// One fixture-owned context permission for the real registered historical Read.
// This is TEST setup through the published SDK, never a product permission bypass.
const installGroupHistoryPermission = Effect.fn('GroupArchive.installHistoryPermission')(
  function* installGroupHistoryPermission(fixture: Effect.Success<ReturnType<typeof makeLiveOperationFixture>>) {
    const endpoint = yield* Config.schema(
      Schema.String.check(Schema.isPattern(/^(?:localhost|127\.0\.0\.1):[0-9]{1,5}$/u)),
      'SPICEDB_ENDPOINT',
    );
    // The public environment contract contains the PEM certificate itself, not a file path.
    const certificate = yield* Config.schema(Schema.NonEmptyString, 'SPICEDB_CA_CERT');
    const key = yield* Config.Redacted('SPICEDB_PRESHARED_KEY');
    const client = yield* Effect.acquireRelease(
      Effect.try({
        catch: () => new GroupArchiveFixturePermissionFailure({ reason: 'Fixture permission client unavailable' }),
        try: () =>
          v1.NewClientWithCustomCert(Redacted.value(key), endpoint, Buffer.from(certificate), undefined, {
            interceptors: [deadlineInterceptor(5000)],
          }),
      }),
      (resource) => Effect.sync(() => resource.close()),
    );
    const objectId = toContextPermissionAccessObjectId(fixture.tenantId, fixture.legalEntityId, {
      moduleId: ownerModuleKey,
      permission: 'customer.group.history.read',
    });
    assert(objectId !== undefined);
    const relationships = [
      v1.Relationship.create({
        relation: 'tenant',
        resource: { objectId, objectType: 'context_permission' },
        subject: { object: { objectId: fixture.tenantId, objectType: 'tenant' } },
      }),
      v1.Relationship.create({
        relation: 'grantee',
        resource: { objectId, objectType: 'context_permission' },
        subject: { object: { objectId: fixture.manager.principalId, objectType: 'principal' } },
      }),
    ];
    const write = Effect.fn('GroupArchive.writeExactHistoryPermission')(function* write(
      operation: v1.RelationshipUpdate_Operation,
    ) {
      yield* Effect.tryPromise({
        catch: () => new GroupArchiveFixturePermissionFailure({ reason: 'Fixture permission mutation unavailable' }),
        try: async () =>
          await client.promises.writeRelationships(
            v1.WriteRelationshipsRequest.create({
              updates: relationships.map((relationship) => v1.RelationshipUpdate.create({ operation, relationship })),
            }),
          ),
      });
    });
    // The complete exact two-tuple deletion ledger is registered before an uncertain TOUCH.
    // Fixture.close retains grants, so this finalizer owns these new tuples explicitly.
    yield* Effect.addFinalizer(() => write(v1.RelationshipUpdate_Operation.DELETE).pipe(Effect.orDie));
    yield* write(v1.RelationshipUpdate_Operation.TOUCH);
    const permission = yield* Effect.tryPromise({
      catch: () => new GroupArchiveFixturePermissionFailure({ reason: 'Fixture permission verification unavailable' }),
      try: async () =>
        await client.promises.checkPermission(
          v1.CheckPermissionRequest.create({
            consistency: v1.Consistency.create({
              requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' },
            }),
            permission: 'access',
            resource: { objectId, objectType: 'context_permission' },
            subject: { object: { objectId: fixture.manager.principalId, objectType: 'principal' } },
          }),
        ),
    });
    expect(permission.permissionship).toBe(v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION);
  },
);

const nativeFixture = Effect.fn('GroupArchive.nativeFixture')(function* nativeFixture() {
  const snapshot = yield* enrollmentApplicationCompositionSnapshot;
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot: snapshot,
    mode: 'schema-only',
    purpose: 'stabilization-1273-group-archive-scheduled-end',
  });
  yield* isolated.assertClonedSchema();
  const source = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
  const sourceJournal = yield* journalFingerprint(source.admin);
  yield* Effect.addFinalizer(() =>
    Effect.scoped(
      journalFingerprint(source.admin).pipe(
        Effect.tap((current) => Effect.sync(() => expect(current).toBe(sourceJournal))),
        Effect.orDie,
      ),
    ),
  );
  yield* copyOwnerBookkeeping(isolated.connections);
  const adminContext = yield* Layer.build(
    PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
      Layer.provideMerge(Reactivity.layer),
    ),
  );
  const coreEvidenceExecutor = yield* testCoreDatabase.pipe(Effect.provide(adminContext));
  const admin = yield* makeWithDefaults({ relations: commerceCustomerContextRelations }).pipe(
    Effect.provide(adminContext),
  );
  const oldSql = yield* Config.Boolean('ONTOS_GROUP_ARCHIVE_PRE_MIGRATION').pipe(Config.withDefault(false));
  const horizon = oldSql ? 'BEFORE_ARCHIVE' : 'CURRENT';
  yield* migrateOwner(isolated.connections, 'migrate', horizon);
  yield* migrateOwner(isolated.connections, 'verify', horizon);
  const fs = yield* FileSystem.FileSystem;
  const sourceMigration = yield* fs.readFileString(
    new URL(
      oldSql
        ? '../../drizzle/20260909135000_refresh_customer_group_routines/migration.sql'
        : '../../drizzle/20261019212748_group_archive_scheduled_memberships/migration.sql',
      import.meta.url,
    ).pathname,
  );
  const [, definition] = sourceMigration.split(
    'CREATE OR REPLACE FUNCTION "commerce_customer_context"."archive_customer_group"(',
  );
  const [, bodyAndSuffix] = definition?.split('AS $$') ?? [];
  const [body] = bodyAndSuffix?.split('$$;') ?? [];
  expect(body).toBeDefined();
  const [receipt] = yield* admin.execute<{
    body: string;
    canonicalPath: boolean;
    currentReceipt: boolean;
    futureReceipts: number;
    ownerIsAdmin: boolean;
    publicExecute: boolean;
    rowSecurity: boolean;
    runtimeExecute: boolean;
    securityDefiner: boolean;
  }>(
    sql`
    select routine.prosrc as body,
      'search_path=pg_catalog, commerce_customer_context, pg_temp' = any(routine.proconfig) as "canonicalPath",
      'row_security=on' = any(routine.proconfig) as "rowSecurity",
      routine.prosecdef as "securityDefiner",
      pg_get_userbyid(routine.proowner) = current_user as "ownerIsAdmin",
      has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE') as "runtimeExecute",
      exists(select 1 from aclexplode(coalesce(routine.proacl, acldefault('f', routine.proowner))) acl
        where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as "publicExecute",
      (select count(*)::integer from drizzle.__drizzle_migrations_commerce_customer_context
        where created_at >= ${archiveMigrationInstant} or name >= ${archiveMigration}) as "futureReceipts",
      exists(select 1 from drizzle.__drizzle_migrations_commerce_customer_context
        where created_at = ${archiveMigrationInstant} and name = ${archiveMigration}
        and hash = ${createHash('sha256').update(sourceMigration).digest('hex')}) as "currentReceipt"
    from pg_catalog.pg_proc routine
    where routine.oid = 'commerce_customer_context.archive_customer_group(uuid,uuid,uuid,integer,timestamptz,text,timestamptz,uuid,uuid)'::regprocedure
  `,
    'objects',
  );
  const verifiedReceipt = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      body: Schema.String,
      canonicalPath: Schema.Boolean,
      currentReceipt: Schema.Boolean,
      futureReceipts: Schema.Int,
      ownerIsAdmin: Schema.Boolean,
      publicExecute: Schema.Boolean,
      rowSecurity: Schema.Boolean,
      runtimeExecute: Schema.Boolean,
      securityDefiner: Schema.Boolean,
    }),
  )(receipt);
  // Fail before business operations if the genuine clone/journal cannot represent OLD.
  // No routine downgrade, journal rewrite, verifier skip or expected-failure laundering.
  const actualBodyDigest = createHash('sha256').update(normalizeBody(verifiedReceipt.body)).digest('hex');
  const expectedBodyDigest = createHash('sha256')
    .update(normalizeBody(body ?? 'MISSING_BODY'))
    .digest('hex');
  const validMetadata =
    verifiedReceipt.canonicalPath &&
    verifiedReceipt.rowSecurity &&
    verifiedReceipt.ownerIsAdmin &&
    verifiedReceipt.runtimeExecute &&
    verifiedReceipt.securityDefiner &&
    !verifiedReceipt.publicExecute;
  const validJournalBoundary = oldSql ? verifiedReceipt.futureReceipts === 0 : verifiedReceipt.currentReceipt;
  expect(
    validMetadata && validJournalBoundary && actualBodyDigest === expectedBodyDigest,
    oldSql ? 'OLD_PREFIX_SETUP_BLOCKED' : 'CURRENT_SETUP_BLOCKED',
  ).toBe(true);
  yield* Effect.logInfo({
    bodyDigest: actualBodyDigest,
    bodyReceipt: oldSql ? 'OLD_BODY' : 'CURRENT_BODY',
    journalBoundary: 'VERIFIED',
    ownerVerifier: 'PASSED',
  });
  const migratedJournal = yield* journalFingerprint(isolated.connections.admin);
  yield* migrateOwner(isolated.connections, 'migrate', horizon);
  expect(yield* journalFingerprint(isolated.connections.admin)).toBe(migratedJournal);
  const fixture = yield* Effect.acquireRelease(
    makeLiveOperationFixture({
      actionExecutor: 'manager-only',
      actionKeys: [
        createCounterpartyPurchasingProfileAction,
        createCustomerGroupAction,
        assignCustomerGroupAction,
        removeCustomerGroupAction,
        archiveCustomerGroupAction,
        reactivateCustomerGroupAction,
      ].map((action) => action.descriptor.actionKey),
      adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
      allowedAudiences: [audience],
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      compositionRevision: snapshot.composition.revision,
      moduleKeys: [ownerModuleKey],
      runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
    }),
    (resource) => resource.close().pipe(Effect.orDie),
  );
  const { legalEntityId, tenantId } = fixture;
  yield* installGroupHistoryPermission(fixture);
  const grantReadAccess = Effect.fn('GroupArchive.grantReadAccess')(function* grantReadAccess(
    resource: Parameters<typeof fixture.grantResourceAccess>[0],
  ) {
    // Each resource is freshly created by this fixture; its writer tuple already owns the
    // shared module/resource structure. Revoke only the new reader relation, before close.
    yield* Effect.addFinalizer(() =>
      fixture.revokeResourceAccess(resource, fixture.manager.principalId, 'reader').pipe(Effect.orDie),
    );
    yield* fixture.grantResourceAccess(resource, fixture.manager.principalId, 'reader');
  });
  const now = Effect.fn('GroupArchive.nativeClock')(function* nativeClock() {
    const [row] = yield* admin.execute<{ at: string; epoch: number }>(
      sql`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at, floor(extract(epoch from clock_timestamp()))::integer as epoch`,
      'objects',
    );
    return yield* Schema.decodeUnknownEffect(Schema.Struct({ at: Schema.String, epoch: Schema.Int }))(row);
  });
  const roles = new Map<string, { readonly roleResourceId: string; readonly roleResourceRevision: string }>();
  // Explicit TEST external facts, exact known Party identities/scope only.
  // Every CCC profile and Group mutation still uses registered Actions/native factories.
  const role = Layer.succeed(ProfileCounterpartyRoleEligibilityResolverFactory, {
    make: (scope) => (target) => {
      const known = roles.get(target.counterpartyResourceId);
      return Effect.succeed(
        scope.tenantId === tenantId &&
          scope.legalEntityId === legalEntityId &&
          target.tenantId === tenantId &&
          known !== undefined
          ? { managedLegalEntityId: legalEntityId, outcome: 'ELIGIBLE' as const, ...known }
          : { outcome: 'INDETERMINATE' as const },
      );
    },
  });
  const ordinary = Layer.mergeAll(
    role,
    profileRetailPermissionReaderFactoryLive,
    profileReactivationEligibilityEvaluatorFactoryLive,
    partyRegistryGuestResolverFactoryLive,
    partyRegistryRetailPartyResolverFactoryLive,
  ).pipe(Layer.provideMerge(ContextAccessLive), Layer.provide(profileReconfirmationPolicyUnavailableLive));
  const overlay = commerceCustomerContextOwnerAuthorizationOverlayLive.pipe(
    Layer.provide(profileRetailPermissionReaderFactoryLive),
    Layer.provide(ContextAccessLive),
  );
  const runtimeLayer = ordinary.pipe(Layer.provideMerge(fixture.layer.pipe(Layer.provide(overlay))));
  let runtimeScope = yield* Scope.make();
  yield* Effect.addFinalizer((exit) => Scope.close(runtimeScope, exit));
  let closedRuntimeScopes = 0;
  const buildRuntime = Effect.fn('GroupArchive.buildRuntime')(function* buildRuntime() {
    yield* Scope.addFinalizer(
      runtimeScope,
      Effect.sync(() => {
        closedRuntimeScopes += 1;
      }),
    );
    return yield* Layer.buildWithScope(runtimeLayer, runtimeScope);
  });
  let runtimeContext = yield* buildRuntime();
  const restart = Effect.fn('GroupArchive.restartServices')(function* restartServices() {
    const oldActionRuntime = Context.get(runtimeContext, ActionRuntime);
    const oldReadRuntime = Context.get(runtimeContext, ReadRuntime);
    const closedBefore = closedRuntimeScopes;
    yield* Scope.close(runtimeScope, Exit.void);
    expect(closedRuntimeScopes).toBe(closedBefore + 1);
    runtimeScope = yield* Scope.make();
    runtimeContext = yield* buildRuntime();
    expect(Context.get(runtimeContext, ActionRuntime)).not.toBe(oldActionRuntime);
    expect(Context.get(runtimeContext, ReadRuntime)).not.toBe(oldReadRuntime);
  });
  const redemption = Context.get(
    yield* Layer.build(
      GatewayAssertionRedemptionLive.pipe(
        Layer.provide(GatewayAssertionRedemptionDatabaseLive),
        Layer.provide(
          PgClient.layer({ url: Redacted.make(isolated.connections.runtime.connectionString) }).pipe(
            Layer.provideMerge(Reactivity.layer),
          ),
        ),
      ),
    ),
    GatewayAssertionRedemptionService,
  );
  const pair = yield* Effect.promise(async () => await generateKeyPair('EdDSA'));
  const jwk = yield* Effect.promise(async () => await exportJWK(pair.publicKey));
  const issuer = 'https://group-archive-native-test.invalid';
  const verifier = bindGatewayPrincipalVerifier(audience, ultramodernApiMarker);
  const authenticate = Effect.fn('GroupArchive.authenticateTESTIssuer')(function* authenticate(
    actor = fixture.manager,
  ) {
    const clock = yield* now();
    const token = yield* Effect.promise(
      async () =>
        await new SignJWT({
          compositionRevision: snapshot.composition.revision,
          principal: { ...actor, legalEntityId },
          targetBuildMarker: ultramodernApiMarker.buildMarker,
          ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
        })
          .setProtectedHeader({ alg: 'EdDSA', kid: 'group-archive-native-test', typ: 'JWT' })
          .setIssuer(issuer)
          .setAudience(audience)
          .setSubject(actor.principalId)
          .setIssuedAt(clock.epoch)
          .setExpirationTime(clock.epoch + GATEWAY_ASSERTION_TTL_SECONDS)
          .setJti(randomUUID())
          .sign(pair.privateKey),
    );
    return yield* verifier
      .verifyAndRedeem(Redacted.make(`Bearer ${token}`), {
        environment: {
          ONTOS_GATEWAY_ISSUER: issuer,
          ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
            keys: [{ ...jwk, alg: 'EdDSA', kid: 'group-archive-native-test', use: 'sig' }],
          }),
        },
        redemption,
      })
      .pipe(Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }));
  });
  const transport = (idempotencyKey = randomUUID()) => ({
    correlationId: randomUUID(),
    idempotencyKey,
    targetModuleKey: ownerModuleKey,
  });
  const createProfile = Effect.fn('GroupArchive.createProfile')(function* createProfile() {
    const counterpartyRef = yield* Schema.decodeUnknownEffect(CounterpartyRefSchema)({
      moduleId: 'party.registry',
      resourceId: randomUUID(),
      resourceType: 'party.registry.counterparty',
      tenantId,
    });
    const roleAt = (yield* now()).at;
    roles.set(counterpartyRef.resourceId, { roleResourceId: randomUUID(), roleResourceRevision: roleAt });
    const profile = yield* runAction({
      payload: yield* Schema.decodeUnknownEffect(CreateCounterpartyPurchasingProfilePayloadSchema)({
        effectiveAt: roleAt,
        subject: { counterpartyRef, kind: 'COUNTERPARTY' },
        trigger: 'AUTHORIZED_ONBOARDING',
      }).pipe(Effect.flatMap(Schema.encodeEffect(CreateCounterpartyPurchasingProfilePayloadSchema))),
      principal: yield* authenticate(),
      registration: createCounterpartyPurchasingProfileAction,
      transport: transport(),
    }).pipe(Effect.provideContext(runtimeContext));
    yield* fixture.grantResourceAccess(profile.profileRef, fixture.manager.principalId, 'writer');
    yield* grantReadAccess(profile.profileRef);
    return { profileKind: 'COUNTERPARTY' as const, profileRef: profile.profileRef };
  });
  const subject = yield* createProfile();
  const create = Effect.fn('GroupArchive.create')(function* create(suffix: string, purpose = 'Native archive proof') {
    const created = yield* runAction({
      payload: {
        businessCode: `TEST_${suffix}`,
        description: 'Native archive proof',
        initialState: 'ACTIVE',
        meaningKey: `fixture.group-${suffix.toLowerCase().replaceAll('_', '-')}`,
        membershipCriteria: 'Explicit test membership',
        name: `Group ${suffix}`,
        purpose,
        reason: 'TEST create',
      },
      principal: yield* authenticate(),
      registration: createCustomerGroupAction,
      transport: transport(),
    }).pipe(Effect.provideContext(runtimeContext));
    expect(created.group.currentDefinition.purpose).toBe(purpose);
    yield* fixture.grantResourceAccess(created.group.groupRef, fixture.manager.principalId, 'writer');
    yield* grantReadAccess(created.group.groupRef);
    return created.group;
  });
  const assign = Effect.fn('GroupArchive.assign')(function* assign(
    groupRef: typeof CustomerGroupRefSchema.Type,
    from: string,
    to?: string,
    profile: typeof CommerceCustomerProfileSubjectSchema.Type = subject,
  ) {
    const base = { effectiveFrom: from, groupRef, profile, reason: 'TEST explicit assignment' };
    const payload = to === undefined ? base : { ...base, effectiveTo: to };
    const result = yield* runAction({
      payload,
      principal: yield* authenticate(),
      registration: assignCustomerGroupAction,
      transport: transport(),
    }).pipe(Effect.provideContext(runtimeContext));
    yield* fixture.grantResourceAccess(result.membership.membershipRef, fixture.manager.principalId, 'writer');
    return result.membership;
  });
  const remove = Effect.fn('GroupArchive.remove')(function* remove(
    membership: {
      readonly groupRef: typeof CustomerGroupRefSchema.Type;
      readonly membershipRef: typeof CustomerGroupMembershipRefSchema.Type;
    },
    at: string,
    key = randomUUID(),
    profile: typeof CommerceCustomerProfileSubjectSchema.Type = subject,
  ) {
    return yield* runAction({
      payload: {
        effectiveAt: at,
        groupRef: membership.groupRef,
        membershipRef: membership.membershipRef,
        profile,
        reason: 'TEST scheduled explicit removal',
      },
      principal: yield* authenticate(),
      registration: removeCustomerGroupAction,
      transport: transport(key),
    }).pipe(Effect.provideContext(runtimeContext));
  });
  const archive = Effect.fn('GroupArchive.archive')(function* archive(
    group: { readonly groupRef: typeof CustomerGroupRefSchema.Type; readonly revision: number },
    at: string,
    key = randomUUID(),
    actor = fixture.manager,
  ) {
    return yield* runAction({
      payload: {
        effectiveAt: at,
        expectedRevision: group.revision,
        groupRef: group.groupRef,
        reason: 'TEST Archive boundary',
      },
      principal: yield* authenticate(actor),
      registration: archiveCustomerGroupAction,
      transport: transport(key),
    }).pipe(Effect.provideContext(runtimeContext));
  });
  const reactivate = Effect.fn('GroupArchive.reactivate')(function* reactivate(
    group: { readonly groupRef: typeof CustomerGroupRefSchema.Type; readonly revision: number },
    at: string,
  ) {
    return yield* runAction({
      payload: {
        effectiveAt: at,
        expectedRevision: group.revision,
        groupRef: group.groupRef,
        reason: 'TEST Reactivate identity only',
      },
      principal: yield* authenticate(),
      registration: reactivateCustomerGroupAction,
      transport: transport(),
    }).pipe(Effect.provideContext(runtimeContext));
  });
  const read = Effect.fn('GroupArchive.read')(function* read(
    asOf: string,
    profile: typeof CommerceCustomerProfileSubjectSchema.Type = subject,
  ) {
    const runtime = Context.get(runtimeContext, ReadRuntime);
    return yield* runtime
      .runRead({
        input: { asOf, profile },
        principal: yield* authenticate(),
        registration: effectiveCustomerGroupMembershipsRead,
        transport: { correlationId: randomUUID(), targetModuleKey: ownerModuleKey },
      })
      .pipe(Effect.provideContext(runtimeContext));
  });
  const membershipRows = () =>
    admin.select().from(customerGroupMemberships).where(eq(customerGroupMemberships.tenantId, tenantId));
  const permissions = Effect.fn('GroupArchive.businessPermissionSnapshot')(function* businessPermissionSnapshot() {
    const [row] = yield* admin.execute<{
      activeCount: number;
      grantCount: number;
      grants: string;
      journal: string;
      journalCount: number;
    }>(
      sql`
      select
        (select count(*)::integer from commerce_customer_context.counterparty_commerce_access_grants
          where tenant_id = ${tenantId} and legal_entity_id = ${legalEntityId} and lifecycle = 'ACTIVE') as "activeCount",
        (select count(*)::integer from commerce_customer_context.counterparty_commerce_access_grants
          where tenant_id = ${tenantId} and legal_entity_id = ${legalEntityId}) as "grantCount",
        (select count(*)::integer from commerce_customer_context.access_mutation_journal
          where tenant_id = ${tenantId} and legal_entity_id = ${legalEntityId}) as "journalCount",
        (select coalesce(jsonb_agg(to_jsonb(grants) order by counterparty_commerce_access_grant_id), '[]')::text
          from commerce_customer_context.counterparty_commerce_access_grants grants
          where tenant_id = ${tenantId} and legal_entity_id = ${legalEntityId}) as grants,
        (select coalesce(jsonb_agg(to_jsonb(journal) order by access_mutation_id), '[]')::text
          from commerce_customer_context.access_mutation_journal journal
          where tenant_id = ${tenantId} and legal_entity_id = ${legalEntityId}) as journal
    `,
      'objects',
    );
    const permissionSnapshot = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        activeCount: Schema.Int,
        grantCount: Schema.Int,
        grants: Schema.String,
        journal: Schema.String,
        journalCount: Schema.Int,
      }),
    )(row);
    expect(permissionSnapshot).toEqual({ activeCount: 0, grantCount: 0, grants: '[]', journal: '[]', journalCount: 0 });
    return permissionSnapshot;
  });
  return {
    admin,
    archive,
    assign,
    authenticate,
    coreEvidenceExecutor,
    create,
    createProfile,
    fixture,
    isolated,
    legalEntityId,
    membershipRows,
    now,
    permissions,
    reactivate,
    read,
    remove,
    restart,
    subject,
    tenantId,
  };
});

it.live('ends a genuinely scheduled membership at Archive and never restores it through Reactivate', () =>
  Effect.scoped(
    Effect.gen(function* scheduledArchive() {
      const test = yield* nativeFixture();
      const group = yield* test.create('MAIN');
      const member = yield* test.assign(group.groupRef, (yield* test.now()).at);
      const end = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe((yield* test.now()).at), { days: 1 }));
      const key = randomUUID();
      const removed = yield* test.remove(member, end, key);
      expect(removed.membership.removal).toMatchObject({ effectiveAt: end, kind: 'EXPLICIT_END' });
      expect((removed.membership.removal?.recordedAt ?? end) < end).toBe(true);
      const before = yield* test.fixture.evidence(test.coreEvidenceExecutor);
      const removalEvent = before.events.find(
        (event) =>
          event.subjectResourceId === member.membershipRef.resourceId &&
          event.eventType === 'commerce.customer-context.customer-group-membership-ended.v1',
      );
      expect(removalEvent).toBeDefined();
      expect(removalEvent?.payloadJson).toEqual({ membership: removed.membership });
      const removeInvocations = before.invocations.filter(
        (invocation) => invocation.actionInvocationId === removalEvent?.actionInvocationId,
      );
      expect(removeInvocations).toEqual([
        expect.objectContaining({
          actionKey: removeCustomerGroupAction.descriptor.actionKey,
          idempotencyKey: key,
          legalEntityId: test.legalEntityId,
          principalId: test.fixture.manager.principalId,
          status: 'succeeded',
          tenantId: test.tenantId,
        }),
      ]);
      expect(removeInvocations[0]?.completedAt).toEqual(expect.any(Date));

      const oldAudit = before.audits.filter((audit) => audit.actionInvocationId === removalEvent?.actionInvocationId);
      const oldOutbox = before.outbox
        .filter((message) => message.domainEventId === removalEvent?.domainEventId)
        .map(({ matchedAt: _matchedAt, ...immutable }) => immutable);
      const { at } = yield* test.now();
      // The real writer remains denied without the separate profile reader grant.
      // Keep the exact context and returned-Group grants, so this isolates the required target.
      yield* test.fixture.revokeResourceAccess(test.subject.profileRef, test.fixture.manager.principalId, 'reader');
      const unreadable = yield* Effect.flip(test.read(at));
      expect(Schema.is(ReadPermissionDenied)(unreadable)).toBe(true);
      yield* test.fixture.grantResourceAccess(test.subject.profileRef, test.fixture.manager.principalId, 'reader');
      expect((yield* test.read(at)).items.map((item) => item.membershipRef)).toContainEqual(member.membershipRef);
      const permissionsBefore = yield* test.permissions();
      const archiveKey = randomUUID();
      const archived = yield* test.archive(group, at, archiveKey);
      expect(archived).toMatchObject({ cancelledCount: 0, changed: true, endedCount: 1 });
      const archiveEvidence = yield* test.fixture.evidence(test.coreEvidenceExecutor);
      const archiveInvocations = archiveEvidence.invocations.filter(
        (invocation) =>
          invocation.actionKey === archiveCustomerGroupAction.descriptor.actionKey &&
          invocation.idempotencyKey === archiveKey,
      );
      expect(archiveInvocations).toEqual([
        expect.objectContaining({
          legalEntityId: test.legalEntityId,
          principalId: test.fixture.manager.principalId,
          status: 'succeeded',
          tenantId: test.tenantId,
        }),
      ]);
      const [archiveInvocation] = archiveInvocations;
      assert(archiveInvocation !== undefined);
      expect(archiveInvocation.completedAt).toEqual(expect.any(Date));
      const archiveAudits = archiveEvidence.audits.filter(
        (audit) => audit.actionInvocationId === archiveInvocation.actionInvocationId,
      );
      expect(archiveAudits).toEqual([
        expect.objectContaining({
          eventType: 'action.executed',
          legalEntityId: test.legalEntityId,
          outcome: 'succeeded',
          outcomeCode: 'action_executed',
          outcomeStage: 'execution',
          principalId: test.fixture.manager.principalId,
          tenantId: test.tenantId,
        }),
      ]);
      const archiveAudit = yield* Schema.decodeUnknownEffect(CustomerGroupActionAuditEvidenceSchema)(
        archiveAudits[0]?.evidenceJson,
      );
      expect(archiveAudit).toMatchObject({
        affectedMembershipCount: 1,
        changed: true,
        effectiveAt: at,
        groupRef: group.groupRef,
        operation: 'ARCHIVE',
        reason: 'TEST Archive boundary',
        revision: archived.group.revision,
      });
      const archiveEvents = archiveEvidence.events.filter(
        (event) => event.actionInvocationId === archiveInvocation.actionInvocationId,
      );
      expect(archiveEvents).toEqual([
        expect.objectContaining({
          eventType: 'commerce.customer-context.customer-group-archived.v1',
          legalEntityId: test.legalEntityId,
          producerModuleKey: ownerModuleKey,
          subjectModuleKey: ownerModuleKey,
          subjectResourceId: group.groupRef.resourceId,
          subjectResourceType: group.groupRef.resourceType,
          tenantId: test.tenantId,
        }),
      ]);
      const [archiveEvent] = archiveEvents;
      assert(archiveEvent !== undefined);
      const archivePayload = yield* Schema.decodeUnknownEffect(CustomerGroupArchivedPayloadSchema)(
        archiveEvent.payloadJson,
      );
      expect(archivePayload).toMatchObject({
        cancelledMembershipCount: 0,
        effectiveAt: at,
        endedMembershipCount: 1,
        groupRef: group.groupRef,
        revision: archived.group.revision,
      });
      expect(
        archiveEvidence.outbox.filter((message) => message.domainEventId === archiveEvent.domainEventId),
      ).toHaveLength(1);

      const native = (yield* test.membershipRows()).find(
        (row) => row.customerGroupMembershipId === member.membershipRef.resourceId,
      );
      expect(native?.lifecycle).toBe('ENDED');
      expect(native?.effectiveTo?.toISOString()).toBe(at);
      expect(native?.revision).toBe(removed.membership.revision + 1);
      const metadata = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            assignedAt: CustomerGroupIsoTimestampSchema,
            assignmentReason: Schema.String,
            removal: Schema.Struct({
              effectiveAt: CustomerGroupIsoTimestampSchema,
              kind: Schema.Literal('GROUP_ARCHIVED'),
              reason: Schema.String,
              recordedAt: CustomerGroupIsoTimestampSchema,
            }),
          }),
        ),
      )(native?.reason);
      expect(metadata.assignedAt).toBe(member.assignedAt);
      expect(metadata.assignmentReason).toBe(member.assignmentReason);
      expect(metadata.removal.effectiveAt).toBe(at);
      expect(metadata.removal.reason).toBe('TEST Archive boundary');
      expect(archivePayload.recordedAt).toBe(metadata.removal.recordedAt);
      const revivedAt = (yield* test.now()).at;
      expect(revivedAt > at).toBe(true);
      const periodsBefore = yield* test.admin
        .select()
        .from(customerGroupLifecyclePeriods)
        .where(
          and(
            eq(customerGroupLifecyclePeriods.tenantId, test.tenantId),
            eq(customerGroupLifecyclePeriods.customerGroupId, group.groupRef.resourceId),
          ),
        );
      const settingsBefore = yield* test.admin
        .select()
        .from(customerSettingRevisions)
        .where(eq(customerSettingRevisions.tenantId, test.tenantId));
      expect(yield* test.permissions()).toEqual(permissionsBefore);
      const revived = yield* test.reactivate(archived.group, revivedAt);
      expect(yield* test.permissions()).toEqual(permissionsBefore);
      const periodsAfter = yield* test.admin
        .select()
        .from(customerGroupLifecyclePeriods)
        .where(
          and(
            eq(customerGroupLifecyclePeriods.tenantId, test.tenantId),
            eq(customerGroupLifecyclePeriods.customerGroupId, group.groupRef.resourceId),
          ),
        );
      expect(periodsAfter).toHaveLength(periodsBefore.length + 1);
      expect(
        yield* test.admin
          .select()
          .from(customerSettingRevisions)
          .where(eq(customerSettingRevisions.tenantId, test.tenantId)),
      ).toEqual(settingsBefore);
      expect((yield* test.read(revivedAt)).items).toEqual([]);
      expect((yield* test.read(member.effectiveFrom)).items.map((item) => item.membershipRef)).toContainEqual(
        member.membershipRef,
      );
      expect(yield* test.membershipRows()).toHaveLength(1);
      const evidence = yield* test.fixture.evidence(test.coreEvidenceExecutor);
      expect(evidence.events.find((event) => event.domainEventId === removalEvent?.domainEventId)).toEqual(
        removalEvent,
      );
      expect(evidence.audits.filter((audit) => audit.actionInvocationId === removalEvent?.actionInvocationId)).toEqual(
        oldAudit,
      );
      expect(
        evidence.outbox
          .filter((message) => message.domainEventId === removalEvent?.domainEventId)
          .map(({ matchedAt: _matchedAt, ...immutable }) => immutable),
      ).toEqual(oldOutbox);
      const auditEvidence = yield* Schema.decodeUnknownEffect(CustomerGroupActionAuditEvidenceSchema)(
        oldAudit.find((audit) => audit.eventType === 'action.executed')?.evidenceJson,
      );
      expect(auditEvidence.membership?.effectiveTo).toBe(end);
      expect(auditEvidence.membership?.removal?.kind).toBe('EXPLICIT_END');
      // Actual service restart: old runtime scope closes before fresh Action/Read services build.
      // The infrastructure fixture retains the same database/pool; this is not an OS process restart.
      const durableBeforeRestart = yield* test.membershipRows();
      yield* test.restart();
      expect(yield* test.membershipRows()).toEqual(durableBeforeRestart);
      expect(yield* test.permissions()).toEqual(permissionsBefore);
      expect((yield* test.read(revivedAt)).items).toEqual([]);
      expect((yield* test.read(member.effectiveFrom)).items.map((item) => item.membershipRef)).toContainEqual(
        member.membershipRef,
      );
      const recoveredEvidence = yield* test.fixture.evidence(test.coreEvidenceExecutor);
      expect(
        recoveredEvidence.invocations.filter(
          (invocation) => invocation.actionInvocationId === removalEvent?.actionInvocationId,
        ),
      ).toEqual(removeInvocations);
      expect(recoveredEvidence.events.find((event) => event.domainEventId === removalEvent?.domainEventId)).toEqual(
        removalEvent,
      );
      expect(
        recoveredEvidence.audits.filter((audit) => audit.actionInvocationId === removalEvent?.actionInvocationId),
      ).toEqual(oldAudit);
      expect(
        recoveredEvidence.outbox
          .filter((message) => message.domainEventId === removalEvent?.domainEventId)
          .map(({ matchedAt: _matchedAt, ...immutable }) => immutable),
      ).toEqual(oldOutbox);
      expect(
        recoveredEvidence.events.filter((event) =>
          /access-(?:grant|revoke)|authorization-mutation/u.test(event.eventType),
        ),
      ).toEqual([]);
      const replayBefore = yield* test.fixture.evidence(test.coreEvidenceExecutor);
      const replay = yield* Effect.flip(test.remove(member, end, key));
      expect(Schema.is(ActionAlreadyCommitted)(replay)).toBe(true);
      expect(yield* test.fixture.evidence(test.coreEvidenceExecutor)).toEqual(replayBefore);
      const next = yield* test.assign(revived.group.groupRef, (yield* test.now()).at);
      expect(next.membershipRef).not.toEqual(member.membershipRef);
      expect((yield* test.read((yield* test.now()).at)).items.map((item) => item.membershipRef)).toEqual([
        next.membershipRef,
      ]);
      expect(yield* test.membershipRows()).toHaveLength(2);
    }).pipe(Effect.provide(services)),
  ),
);

it.live('keeps exact real profile identity, kind and overlap boundaries through registered Actions', () =>
  Effect.scoped(
    Effect.gen(function* exactProfileBoundaries() {
      const test = yield* nativeFixture();
      const other = yield* test.createProfile();
      expect(other.profileRef.resourceId).not.toBe(test.subject.profileRef.resourceId);
      const group = yield* test.create('PROFILES');
      const [activePeriod] = group.lifecycleHistory;
      assert.isOk(activePeriod !== undefined);
      expect(group.currentState).toBe('ACTIVE');
      expect(activePeriod.archivedAt).toBeNull();
      // Use the committed owner's inclusive start, not an independently sampled database clock.
      const start = activePeriod.activeFrom;
      const member = yield* test.assign(group.groupRef, start);
      expect(member.effectiveFrom).toBe(start);
      const beforeRows = yield* test.membershipRows();
      const before = yield* test.fixture.evidence(test.coreEvidenceExecutor);
      const wrongKind = yield* Schema.decodeUnknownEffect(CommerceCustomerProfileSubjectSchema)({
        profileKind: 'RETAIL',
        profileRef: { ...test.subject.profileRef, resourceType: 'commerce.customer-context.retail-customer-profile' },
      });
      for (const wrongProfile of [other, wrongKind]) {
        const failure = yield* Effect.flip(test.remove(member, (yield* test.now()).at, randomUUID(), wrongProfile));
        expect(Schema.is(CustomerGroupMembershipNotFound)(failure)).toBe(true);
        expect(yield* test.membershipRows()).toEqual(beforeRows);
      }
      const overlapEnd = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(start), { days: 1 }));
      const overlap = yield* Effect.flip(test.assign(group.groupRef, start, overlapEnd));
      expect(Schema.is(CustomerGroupMembershipOverlap)(overlap)).toBe(true);
      expect(yield* test.membershipRows()).toEqual(beforeRows);
      const rejected = yield* test.fixture.evidence(test.coreEvidenceExecutor);
      expect(rejected.events).toEqual(before.events);
      expect(rejected.outbox.map(({ matchedAt: _matchedAt, ...immutable }) => immutable)).toEqual(
        before.outbox.map(({ matchedAt: _matchedAt, ...immutable }) => immutable),
      );
      expect(rejected.audits.filter((audit) => audit.eventType === 'action.executed')).toEqual(
        before.audits.filter((audit) => audit.eventType === 'action.executed'),
      );
      const otherMember = yield* test.assign(group.groupRef, start, undefined, other);
      expect(otherMember.membershipRef).not.toEqual(member.membershipRef);
      expect((yield* test.read((yield* test.now()).at, other)).items.map((item) => item.membershipRef)).toEqual([
        otherMember.membershipRef,
      ]);
      expect((yield* test.read((yield* test.now()).at)).items.map((item) => item.membershipRef)).toEqual([
        member.membershipRef,
      ]);
      expect(yield* test.membershipRows()).toHaveLength(2);
      yield* test.permissions();
    }).pipe(Effect.provide(services)),
  ),
);

it.live('preserves exact end boundaries, cancelled future periods and denied Archive rollback', () =>
  Effect.scoped(
    Effect.gen(function* archiveBoundaries() {
      const test = yield* nativeFixture();
      const group = yield* test.create('BOUNDARIES');
      const from = (yield* test.now()).at;
      const end = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(from), { seconds: 2 }));
      const member = yield* test.assign(group.groupRef, from);
      yield* test.remove(member, end);
      const afterGroup = yield* test.create(
        'AFTER_END',
        'Observe members whose scheduled removal already ended before their group Archive',
      );
      expect(afterGroup.groupRef.resourceId).not.toBe(group.groupRef.resourceId);
      const afterMember = yield* test.assign(afterGroup.groupRef, (yield* test.now()).at);
      yield* test.remove(afterMember, end);
      // Wait for the actual server clock; Archive at E is never future-dated.
      yield* test.admin.execute(
        sql`select pg_sleep(greatest(0, extract(epoch from ${end}::timestamptz - clock_timestamp())))`,
        'objects',
      );
      const before = yield* test.membershipRows();
      const archived = yield* test.archive(group, end);
      expect(archived).toMatchObject({ cancelledCount: 0, endedCount: 0 });
      expect(yield* test.membershipRows()).toEqual(before);
      const afterArchive = yield* test.archive(afterGroup, (yield* test.now()).at);
      expect(afterArchive).toMatchObject({ cancelledCount: 0, endedCount: 0 });
      expect(yield* test.membershipRows()).toEqual(before);
      const other = yield* test.create(
        'CANCELLED',
        'Observe members whose future assignment was cancelled before their group Archive',
      );
      expect(other.groupRef.resourceId).not.toBe(group.groupRef.resourceId);
      expect(other.groupRef.resourceId).not.toBe(afterGroup.groupRef.resourceId);
      const future = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe((yield* test.now()).at), { days: 1 }));
      const never = yield* test.assign(other.groupRef, future);
      yield* test.remove(never, future);
      const deniedBefore = yield* test.membershipRows();
      const denied = yield* Effect.flip(
        test.archive(other, (yield* test.now()).at, randomUUID(), test.fixture.legalEntityOnly),
      );
      expect(Schema.is(ActionPermissionDenied)(denied)).toBe(true);
      expect(yield* test.membershipRows()).toEqual(deniedBefore);
      const result = yield* test.archive(other, (yield* test.now()).at);
      expect(result).toMatchObject({ cancelledCount: 0, endedCount: 0 });
      expect(yield* test.membershipRows()).toEqual(deniedBefore);
      const effectiveFuture = yield* test.read(future);
      expect(effectiveFuture.items).toEqual([]);
    }).pipe(Effect.provide(services)),
  ),
);

it.live('cancels a future-ended never-effective period and atomically rolls back failed Archive', () =>
  Effect.scoped(
    Effect.gen(function* futureAndRollback() {
      const test = yield* nativeFixture();
      const group = yield* test.create('FUTURE_END');
      const future = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe((yield* test.now()).at), { days: 1 }));
      const end = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(future), { days: 1 }));
      const member = yield* test.assign(group.groupRef, future);
      const ended = yield* test.remove(member, end);
      expect(ended.membership.state).toBe('VALID');
      expect(
        (yield* test.membershipRows()).find((row) => row.customerGroupMembershipId === member.membershipRef.resourceId)
          ?.lifecycle,
      ).toBe('ENDED');
      const beforeRows = yield* test.membershipRows();
      const beforePeriods = yield* test.admin
        .select()
        .from(customerGroupLifecyclePeriods)
        .where(eq(customerGroupLifecyclePeriods.tenantId, test.tenantId));
      const beforeSettings = yield* test.admin
        .select()
        .from(customerSettingRevisions)
        .where(eq(customerSettingRevisions.tenantId, test.tenantId));
      const beforeEvidence = yield* test.fixture.evidence(test.coreEvidenceExecutor);
      const { at } = yield* test.now();
      const key = randomUUID();
      test.fixture.faultNextTransaction('rollback');
      const failed = yield* Effect.flip(test.archive(group, at, key));
      expect(Schema.is(ActionTransactionError)(failed)).toBe(true);
      expect(yield* test.membershipRows()).toEqual(beforeRows);
      expect(
        yield* test.admin
          .select()
          .from(customerGroupLifecyclePeriods)
          .where(eq(customerGroupLifecyclePeriods.tenantId, test.tenantId)),
      ).toEqual(beforePeriods);
      expect(
        yield* test.admin
          .select()
          .from(customerSettingRevisions)
          .where(eq(customerSettingRevisions.tenantId, test.tenantId)),
      ).toEqual(beforeSettings);
      const afterFailure = yield* test.fixture.evidence(test.coreEvidenceExecutor);
      expect(afterFailure.events).toEqual(beforeEvidence.events);
      expect(afterFailure.outbox).toEqual(beforeEvidence.outbox);
      expect(afterFailure.audits).toEqual(beforeEvidence.audits);
      expect(afterFailure.accesses).toEqual(beforeEvidence.accesses);
      const committed = yield* test.archive(group, at, key);
      expect(committed).toMatchObject({ cancelledCount: 1, endedCount: 0 });
      const native = (yield* test.membershipRows()).find(
        (row) => row.customerGroupMembershipId === member.membershipRef.resourceId,
      );
      expect(native?.lifecycle).toBe('CANCELLED');
      expect(native?.effectiveFrom.toISOString()).toBe(future);
      expect(native?.effectiveTo?.toISOString()).toBe(end);
      const stale = yield* Effect.flip(test.archive(group, (yield* test.now()).at));
      expect(Schema.is(CustomerGroupRevisionConflict)(stale)).toBe(true);
      expect(
        (yield* test.membershipRows()).find((row) => row.customerGroupMembershipId === member.membershipRef.resourceId),
      ).toEqual(native);
    }).pipe(Effect.provide(services)),
  ),
);

const serialization = Effect.fn('GroupArchive.serialization')(function* serialization(first: 'ARCHIVE' | 'REMOVE') {
  const test = yield* nativeFixture();
  const group = yield* test.create(`RACE_${first}`);
  const member = yield* test.assign(group.groupRef, (yield* test.now()).at);
  const end = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe((yield* test.now()).at), { days: 1 }));
  const { at } = yield* test.now();
  const locked = yield* Deferred.make<number>();
  const release = yield* Deferred.make<boolean>();
  const holder = yield* test.admin
    .transaction((transaction) =>
      Effect.gen(function* holdExactOwnerRow() {
        const [backend] = yield* transaction.execute<{ pid: number }>(
          sql`select pg_backend_pid()::integer as pid`,
          'objects',
        );
        const holderBackend = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ pid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }),
        )(backend);
        const lockStatement =
          first === 'REMOVE'
            ? sql`select customer_group_membership_id from commerce_customer_context.customer_group_memberships where tenant_id=${test.tenantId}::uuid and customer_group_membership_id=${member.membershipRef.resourceId}::uuid for update`
            : sql`select customer_group_id from commerce_customer_context.customer_groups where tenant_id=${test.tenantId}::uuid and customer_group_id=${group.groupRef.resourceId}::uuid for update`;
        yield* transaction.execute(lockStatement, 'objects');
        yield* Deferred.succeed(locked, holderBackend.pid);
        yield* Deferred.await(release);
      }),
    )
    .pipe(Effect.forkScoped);
  const pid = yield* Effect.raceFirst(Deferred.await(locked), Fiber.join(holder).pipe(Effect.andThen(Effect.never)));
  const waitForDescendants = Effect.fn('GroupArchive.waitForDescendants')(function* waitForDescendants(count: number) {
    let observed = 0;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const [row] = yield* test.admin.execute<{ count: number }>(
        sql`
        with recursive blocked(pid) as (
          select activity.pid from pg_stat_activity activity where activity.datname=current_database() and ${pid}=any(pg_blocking_pids(activity.pid))
          union select activity.pid from pg_stat_activity activity join blocked on blocked.pid=any(pg_blocking_pids(activity.pid)) where activity.datname=current_database()
        ) select count(distinct pid)::integer as count from blocked`,
        'objects',
      );
      const measured = yield* Schema.decodeUnknownEffect(Schema.Struct({ count: Schema.Int }))(row);
      observed = measured.count;
      if (observed >= count) {
        return;
      }
      yield* test.admin.execute(sql`select pg_sleep(0.02)`, 'objects');
    }
    expect(observed).toBeGreaterThanOrEqual(count);
  });
  const removeKey = randomUUID();
  const remove = test.remove(member, end, removeKey).pipe(
    Effect.result,
    Effect.map((result) =>
      Result.match(result, {
        onFailure: (error) => {
          expect(first).toBe('ARCHIVE');
          expect(Schema.is(CustomerGroupMembershipRemovalConflict)(error)).toBe(true);
          expect(error).toMatchObject({ code: 'customer_group_membership_removal_conflict' });
          return false;
        },
        onSuccess: () => true,
      }),
    ),
  );
  const archive = test.archive(group, at).pipe(Effect.result, Effect.map(Result.isSuccess));
  const firstFiber = yield* (first === 'REMOVE' ? remove : archive).pipe(Effect.forkScoped);
  yield* waitForDescendants(1);
  const secondFiber = yield* (first === 'REMOVE' ? archive : remove).pipe(Effect.forkScoped);
  yield* waitForDescendants(2);
  yield* Deferred.succeed(release, true);
  yield* Fiber.join(holder);
  const firstResult = yield* Fiber.join(firstFiber);
  const secondResult = yield* Fiber.join(secondFiber);
  expect(firstResult).toBe(true);
  expect(secondResult).toBe(first === 'REMOVE');
  if (first === 'ARCHIVE') {
    const failureEvidence = yield* test.fixture.evidence(test.coreEvidenceExecutor);
    const failedInvocations = failureEvidence.invocations.filter(
      (invocation) =>
        invocation.actionKey === removeCustomerGroupAction.descriptor.actionKey &&
        invocation.idempotencyKey === removeKey,
    );
    expect(failedInvocations).toEqual([
      expect.objectContaining({
        completedAt: null,
        legalEntityId: test.legalEntityId,
        principalId: test.fixture.manager.principalId,
        status: 'received',
        tenantId: test.tenantId,
      }),
    ]);
    const [failedInvocation] = failedInvocations;
    assert(failedInvocation !== undefined);
    expect(
      failureEvidence.audits.filter((audit) => audit.actionInvocationId === failedInvocation.actionInvocationId),
    ).toEqual([]);
    expect(
      failureEvidence.events.filter((event) => event.actionInvocationId === failedInvocation.actionInvocationId),
    ).toEqual([]);
    expect(
      failureEvidence.accesses.filter((access) => access.actionInvocationId === failedInvocation.actionInvocationId),
    ).toEqual([]);
  }

  const native = (yield* test.membershipRows()).find(
    (row) => row.customerGroupMembershipId === member.membershipRef.resourceId,
  );
  expect(native?.lifecycle).toBe('ENDED');
  expect(native?.effectiveTo?.toISOString()).toBe(at);
  expect((yield* test.read((yield* test.now()).at)).items).toEqual([]);
});

it.live('serializes committed future Remove before waiting Archive without skipping ENDED', () =>
  Effect.scoped(serialization('REMOVE').pipe(Effect.provide(services))),
);
it.live('serializes Archive before conflicting Remove without overwriting archive end', () =>
  Effect.scoped(serialization('ARCHIVE').pipe(Effect.provide(services))),
);

it.live('cancels a never-effective membership beginning exactly at Archive without invalid interval mutation', () =>
  Effect.scoped(
    Effect.gen(function* startsAtArchive() {
      const test = yield* nativeFixture();
      const group = yield* test.create('EXACT_START');
      const at = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe((yield* test.now()).at), { seconds: 2 }));
      const member = yield* test.assign(group.groupRef, at);
      yield* test.admin.execute(
        sql`select pg_sleep(greatest(0, extract(epoch from ${at}::timestamptz - clock_timestamp())))`,
        'objects',
      );
      const result = yield* test.archive(group, at);
      expect(result).toMatchObject({ cancelledCount: 1, endedCount: 0 });
      const native = (yield* test.membershipRows()).find(
        (row) => row.customerGroupMembershipId === member.membershipRef.resourceId,
      );
      expect(native?.lifecycle).toBe('CANCELLED');
      expect(native?.effectiveFrom.toISOString()).toBe(at);
      expect(native?.effectiveTo).toBeNull();
      const { at: revivedAt } = yield* test.now();
      yield* test.reactivate(result.group, revivedAt);
      expect((yield* test.read(revivedAt)).items).toEqual([]);
    }).pipe(Effect.provide(services)),
  ),
);

it.live('denies wrong native Tenant or SLE settings before disclosing membership rows', () =>
  Effect.scoped(
    Effect.gen(function* nativeScopeDenials() {
      const test = yield* nativeFixture();
      const group = yield* test.create('SCOPE');
      yield* test.assign(group.groupRef, (yield* test.now()).at);
      const runtimeContext = yield* Layer.build(
        PgClient.layer({ url: Redacted.make(test.isolated.connections.runtime.connectionString) }).pipe(
          Layer.provideMerge(Reactivity.layer),
        ),
      );
      const runtime = yield* makeWithDefaults({ relations: commerceCustomerContextRelations }).pipe(
        Effect.provide(runtimeContext),
      );
      const before = yield* test.membershipRows();
      for (const scope of [
        { legalEntityId: test.legalEntityId, tenantId: randomUUID() },
        { legalEntityId: randomUUID(), tenantId: test.tenantId },
      ]) {
        const failure = yield* Effect.flip(
          runtime.transaction((transaction) =>
            Effect.gen(function* mismatchedNativeScope() {
              yield* transaction.execute(
                sql`select set_config('ontos.tenant_id',${scope.tenantId},true),set_config('ontos.legal_entity_id',${scope.legalEntityId},true)`,
                'objects',
              );
              return yield* transaction.execute(
                sql`select * from commerce_customer_context.read_effective_customer_group_memberships(${test.tenantId}::uuid,${test.legalEntityId}::uuid,${test.subject.profileRef.resourceId}::uuid,'COUNTERPARTY'::text,clock_timestamp())`,
                'objects',
              );
            }),
          ),
        );
        expect(Option.getOrThrow(findPostgresFailure(failure)).code).toBe('42501');
      }
      expect(yield* test.membershipRows()).toEqual(before);
    }).pipe(Effect.provide(services)),
  ),
);
