import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';
import { createHash, randomUUID } from 'node:crypto';
import {
  ActiveApplicationCompositionService,
  ActionAlreadyCommitted,
  ActionRuntime,
  ActionPermissionDenied,
  ActionTransactionError,
  ContextAccessLive,
  GatewayAssertionRedemptionService,
  OwnerAuthorizationOverlay,
  ReadHandlerNotFound,
  ReadRuntime,
  runAction,
  loadDatabaseConnectionPair,
  findPostgresFailure,
} from '@app/core-runtime';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import { OrganizationBusinessApplicabilityCurrentSchema } from '@app/privacy/api/organization-business-applicability';
import { CommerceOrganizationBusinessEligibility } from '../../src/integrations/organization-business-eligibility.ts';
import type { CommerceOrganizationBusinessRequest } from '../../src/integrations/organization-business-eligibility.ts';
import { validateOrganizationBusinessDecision } from '../../src/integrations/organization-business-decision.ts';
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
import {
  ApplyCustomerGroupMembershipSourcePayloadSchema,
  ApplyCustomerGroupMembershipSourceResultSchema,
  CustomerGroupMembershipSourceRejected,
} from '../../shared/actions/apply-customer-group-membership-source.ts';
import {
  OrganizationMembershipSourcePayloadSchema,
  OrganizationMembershipSourceResultSchema,
  OrganizationMembershipChangeEventSchema,
} from '../../shared/domain/organization-membership-source.ts';
import type { ApplyCustomerGroupMembershipSourcePayload } from '../../shared/actions/apply-customer-group-membership-source.ts';
import type { CustomerGroupMembershipSourceReceiptRequest } from '../../shared/apis/customer-group-membership-source-receipt.ts';
import { CustomerGroupMembershipSourceReceiptRequestSchema } from '../../shared/apis/customer-group-membership-source-receipt.ts';
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
import { applyCustomerGroupMembershipSourceAction } from '../../src/actions/apply-customer-group-membership-source.action.ts';
import { admitCustomerGroupMembershipSnapshotAction } from '../../src/actions/admit-customer-group-membership-snapshot.action.ts';
import { archiveCustomerProfileAction } from '../../src/actions/archive-customer-profile.action.ts';
import { AdmitCustomerGroupMembershipSnapshotPayloadSchema } from '../../shared/domain/customer-group-membership-snapshot.ts';
import type { AdmitCustomerGroupMembershipSnapshotPayload } from '../../shared/domain/customer-group-membership-snapshot.ts';
import { ArchiveCustomerProfilePayloadSchema } from '../../shared/actions/archive-customer-profile.ts';
import { assignCustomerGroupAction } from '../../src/actions/assign-customer-group.action.ts';
import { removeCustomerGroupAction } from '../../src/actions/remove-customer-group.action.ts';
import { archiveCustomerGroupAction } from '../../src/actions/archive-customer-group.action.ts';
import { reactivateCustomerGroupAction } from '../../src/actions/reactivate-customer-group.action.ts';
import { customerGroupMembershipSourceReceiptRead } from '../../src/api/customer-group-membership-source-receipt.read.ts';
import { effectiveCustomerGroupMembershipsRead } from '../../src/api/effective-customer-group-memberships.read.ts';
import {
  commerceCustomerContextRelations,
  customerGroupMemberships,
  customerGroupMembershipSourceRoutes,
  customerGroupMembershipSourceReceipts,
  customerGroupMembershipSnapshotProofs,
  customerGroupLifecyclePeriods,
  customerSettingRevisions,
} from '../../src/database/schema.ts';
import { commerceCustomerContextOwnerAuthorizationOverlayLive } from '../../src/persistence/owner-authorization-overlay.ts';
import { ProfileCounterpartyRoleEligibilityResolverFactory } from '../../src/profile-counterparty-role-eligibility.ts';
import {
  profileReactivationEligibilityEvaluatorFactoryLive,
  profileReconfirmationPolicyUnavailableLive,
} from '../../src/integrations/profile-reactivation-eligibility.ts';
import { partyRegistryGuestResolverFactoryLive } from '../../src/integrations/party-registry-guest-resolver.ts';
import { partyRegistryRetailPartyResolverFactoryLive } from '../../src/integrations/party-registry-retail-party-resolver.ts';
import {
  CommerceSourceProcessingEligibility,
  CommerceSourceProcessingRejected,
} from '../../src/integrations/source-processing-eligibility.ts';
import type { CommerceSourceProcessingRequest } from '../../src/integrations/source-processing-eligibility.ts';
import {
  enrollmentApplicationCompositionSnapshot,
  makeEnrollmentApplicationCompositionSnapshot,
} from '../support/enrollment-application-composition.ts';
import { nativeTestDatabaseContainer } from '../support/native-test-database.ts';

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
      yield* nativeTestDatabaseContainer,
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
        yield* nativeTestDatabaseContainer,
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
        yield* nativeTestDatabaseContainer,
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
const migrationRoutineBody = (source: string, statement: 'CREATE' | 'CREATE OR REPLACE') => {
  const [, definition] = source.split(`${statement} FUNCTION "commerce_customer_context"."archive_customer_group"(`);
  const [, bodyAndSuffix] = definition?.split('AS $$') ?? [];
  const [body] = bodyAndSuffix?.split('$$;') ?? [];
  return body;
};
const ownerModuleKey = 'commerce.customer-context';
/** One denied owner-access pair, keyed by the acting principal and the capability it asks about. */
const ownerAccessKey = (principalId: string, capabilityKey: string) => `${principalId}\u0000${capabilityKey}`;
const audience = 'commerce-customer-context';
const nativeFixture = Effect.fn('GroupArchive.nativeFixture')(function* nativeFixture(
  access: 'allowed' | Readonly<Record<string, 'allowed' | 'denied'>> = 'allowed',
  compositionMode: 'ordinary' | 'source' = 'ordinary',
) {
  const snapshot = yield* compositionMode === 'source'
    ? makeEnrollmentApplicationCompositionSnapshot(ultramodernApiMarker.buildMarker, ['privacy'])
    : enrollmentApplicationCompositionSnapshot;
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot: snapshot,
    mode: 'schema-only',
    purpose: 'stabilization-1273-group-archive-scheduled-end',
  });
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
  const verifyArchiveRoutines = Effect.fn('GroupArchive.verifyArchiveRoutines')(function* verifyArchiveRoutines() {
    const fs = yield* FileSystem.FileSystem;
    const sourceMigration = yield* fs.readFileString(
      new URL(
        oldSql
          ? '../../drizzle/20260909135000_refresh_customer_group_routines/migration.sql'
          : '../../drizzle/20261019212748_group_archive_scheduled_memberships/migration.sql',
        import.meta.url,
      ).pathname,
    );
    const body = migrationRoutineBody(sourceMigration, 'CREATE OR REPLACE');
    expect(body).toBeDefined();
    const sourceMembershipMigration = '20261106130022_customer-group-membership-source-routines';
    const membershipMigration = yield* fs.readFileString(
      new URL(`../../drizzle/${sourceMembershipMigration}/migration.sql`, import.meta.url).pathname,
    );
    const wrapperBody = migrationRoutineBody(membershipMigration, 'CREATE');
    expect(wrapperBody).toBeDefined();
    const [receipt] = yield* admin.execute<{
      body: string;
      canonicalPath: boolean;
      currentReceipt: boolean;
      futureReceipts: number;
      lockedBody: string | null;
      lockedRuntimeExecute: boolean | null;
      membershipReceipt: boolean;
      ownerIsAdmin: boolean;
      publicExecute: boolean;
      rowSecurity: boolean;
      runtimeExecute: boolean;
      securityDefiner: boolean;
    }>(
      sql`
      select routine.prosrc as body, locked.prosrc as "lockedBody",
        has_function_privilege('ontos_runtime', locked.oid, 'EXECUTE') as "lockedRuntimeExecute",
        exists(select 1 from drizzle.__drizzle_migrations_commerce_customer_context
          where name = ${sourceMembershipMigration}
          and hash = ${createHash('sha256').update(membershipMigration).digest('hex')}) as "membershipReceipt",
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
      left join pg_catalog.pg_proc locked
        on locked.oid = to_regprocedure('commerce_customer_context.archive_group_locked(uuid,uuid,uuid,integer,timestamptz,text,timestamptz,uuid,uuid)')
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
        lockedBody: Schema.toEncoded(Schema.OptionFromNullOr(Schema.String)),
        lockedRuntimeExecute: Schema.toEncoded(Schema.OptionFromNullOr(Schema.Boolean)),
        membershipReceipt: Schema.Boolean,
        ownerIsAdmin: Schema.Boolean,
        publicExecute: Schema.Boolean,
        rowSecurity: Schema.Boolean,
        runtimeExecute: Schema.Boolean,
        securityDefiner: Schema.Boolean,
      }),
    )(receipt);
    // Fail before business operations if the genuine clone/journal cannot represent OLD.
    // No routine downgrade, journal rewrite, verifier skip or expected-failure laundering.
    const archivedBody = oldSql ? verifiedReceipt.body : verifiedReceipt.lockedBody;
    const actualBodyDigest = createHash('sha256')
      .update(normalizeBody(archivedBody ?? 'MISSING_BODY'))
      .digest('hex');
    const expectedBodyDigest = createHash('sha256')
      .update(normalizeBody(body ?? 'MISSING_BODY'))
      .digest('hex');
    expect(verifiedReceipt).toMatchObject({
      canonicalPath: true,
      ownerIsAdmin: true,
      publicExecute: false,
      rowSecurity: true,
      runtimeExecute: true,
      securityDefiner: true,
    });
    if (oldSql) {
      expect(verifiedReceipt).toMatchObject({ futureReceipts: 0, lockedBody: null });
    } else {
      expect(verifiedReceipt).toMatchObject({
        currentReceipt: true,
        lockedRuntimeExecute: false,
        membershipReceipt: true,
      });
      expect(normalizeBody(verifiedReceipt.body)).toBe(normalizeBody(wrapperBody ?? 'MISSING_BODY'));
    }
    expect(actualBodyDigest, oldSql ? 'OLD_PREFIX_SETUP_BLOCKED' : 'CURRENT_SETUP_BLOCKED').toBe(expectedBodyDigest);
    yield* Effect.logInfo({
      bodyDigest: actualBodyDigest,
      bodyReceipt: oldSql ? 'OLD_BODY' : 'CURRENT_BODY',
      journalBoundary: 'VERIFIED',
      ownerVerifier: 'PASSED',
    });
  });
  yield* verifyArchiveRoutines();

  const migratedJournal = yield* journalFingerprint(isolated.connections.admin);
  yield* migrateOwner(isolated.connections, 'migrate', horizon);
  expect(yield* journalFingerprint(isolated.connections.admin)).toBe(migratedJournal);
  const fixture = yield* Effect.acquireRelease(
    makeLiveOperationFixture({
      access,
      actionExecutor: 'manager-only',
      actionKeys: [
        createCounterpartyPurchasingProfileAction,
        createCustomerGroupAction,
        assignCustomerGroupAction,
        applyCustomerGroupMembershipSourceAction,
        admitCustomerGroupMembershipSnapshotAction,
        archiveCustomerProfileAction,
        removeCustomerGroupAction,
        archiveCustomerGroupAction,
        reactivateCustomerGroupAction,
      ].map((action) => action.descriptor.actionKey),
      adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
      allowedAudiences: [audience],
      applicationComposition: { load: Effect.succeed(snapshot) },
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      compositionRevision: snapshot.composition.revision,
      expectedDeployment: ultramodernApiMarker,
      moduleKeys: [ownerModuleKey],
      ownerRegistration: commerceCustomerContextRegistration,
      runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
    }),
    (resource) => resource.close().pipe(Effect.orDie),
  );
  const { legalEntityId, tenantId } = fixture;
  const now = Effect.fn('GroupArchive.nativeClock')(function* nativeClock() {
    const [row] = yield* admin.execute<{ at: string; epoch: number }>(
      sql`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at, floor(extract(epoch from clock_timestamp()))::integer as epoch`,
      'objects',
    );
    return yield* Schema.decodeUnknownEffect(Schema.Struct({ at: Schema.String, epoch: Schema.Int }))(row);
  });
  const roles = new Map<string, { readonly roleResourceId: string; readonly roleResourceRevision: string }>();
  const profileCounterparties = new Map<string, typeof CounterpartyRefSchema.Type>();
  const configuredOrganizationProfiles = new Set<string>();
  const organizationChecks: { readonly input: CommerceOrganizationBusinessRequest; readonly requirementKey: string }[] =
    [];
  const testOrganizationPartyId = randomUUID();
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
  let sourcePrivacyDenied = false;
  let sourceRecoveryDenied = false;
  const sourcePrivacyChecks: CommerceSourceProcessingRequest[] = [];
  // INTERNAL_CONTRACT: the Privacy owner separately proves its current eligibility/erasure ledger.
  // This seam records exactly what the native Commerce owner submits and can revoke each attempt.
  const sourcePrivacy = Layer.succeed(CommerceSourceProcessingEligibility, {
    check: (scope, input) =>
      Effect.gen(function* internalSourcePrivacy() {
        expect(scope.tenantId).toBe(tenantId);
        expect(scope.legalEntityId).toBe(legalEntityId);
        sourcePrivacyChecks.push(input);
        if (sourcePrivacyDenied || (sourceRecoveryDenied && input.operation === 'customer-group-membership.recover')) {
          return yield* new CommerceSourceProcessingRejected({ code: 'DENIED', reason: 'Internal protected material' });
        }
        return yield* Effect.void;
      }),
  });
  const setSourcePrivacyDenied = (denied: boolean) => {
    sourcePrivacyDenied = denied;
  };
  const setSourceRecoveryDenied = (denied: boolean) => {
    sourceRecoveryDenied = denied;
  };
  // INTERNAL_CONTRACT owner-only seam: explicit configured TEST Organization/Privacy facts.
  // This proves Commerce's native protocol, never the production Party classification or HTTP decision.
  const organizationBusiness = Layer.succeed(CommerceOrganizationBusinessEligibility, {
    check: (scope, input, requirementKey) =>
      Effect.gen(function* internalOrganizationBusiness() {
        organizationChecks.push({ input, requirementKey });
        const known =
          input.kind === 'COUNTERPARTY_PROFILE' ? profileCounterparties.get(input.profileRef.resourceId) : undefined;
        const knownRole = known === undefined ? undefined : roles.get(known.resourceId);
        if (
          input.kind !== 'COUNTERPARTY_PROFILE' ||
          !configuredOrganizationProfiles.has(input.profileRef.resourceId) ||
          known === undefined ||
          knownRole === undefined ||
          scope.tenantId !== tenantId ||
          scope.legalEntityId !== legalEntityId
        ) {
          return yield* new CommerceSourceProcessingRejected({
            code: 'DENIED',
            reason: 'No explicit internal Organization business decision for this target',
          });
        }
        const partyRef = {
          moduleId: 'party.registry',
          resourceId: testOrganizationPartyId,
          resourceType: 'party.registry.party',
          tenantId,
        };
        const response = yield* Schema.decodeUnknownEffect(OrganizationBusinessApplicabilityCurrentSchema)({
          allowedFields: input.fields,
          applicabilityDecisionRef: 'internal-owner-only-organization-decision',
          authorityIncarnation: 'internal-owner-only',
          authorityRevision: '1',
          classification: 'CANONICAL_ORGANIZATION',
          consumerModuleId: input.consumerModuleId,
          evaluatedAt: (yield* now()).at,
          evidenceRefs: ['internal-owner-only-configured-proof'],
          holdBehavior: 'NO_ACTIVE_SCOPE_HOLD',
          inputDigest: input.inputDigest,
          kind: 'ORGANIZATION_BUSINESS_ONLY',
          liveProof: {
            kind: 'COUNTERPARTY_PROFILE',
            organization: {
              counterpartyRef: known,
              counterpartyRevision: computeCanonicalValueHash({ fixtureCounterparty: known }),
              currentCustomerRoleRef: {
                moduleId: 'party.registry',
                resourceId: knownRole.roleResourceId,
                resourceType: 'party.registry.counterparty-role-period',
                tenantId,
              },
              currentCustomerRoleRevision: computeCanonicalValueHash({ fixtureRole: knownRole }),
              legalEntityRef: {
                moduleId: 'core.identity',
                resourceId: legalEntityId,
                resourceType: 'core.identity.legal-entity',
                tenantId,
              },
              outcome: 'CURRENT_CANONICAL_ORGANIZATION_CUSTOMER',
              partyRef,
              partyRevision: 1,
              sourceCitation: null,
              typeAssertionId: testOrganizationPartyId,
              typeAssertionRevision: computeCanonicalValueHash({ fixtureOrganization: testOrganizationPartyId }),
              typeRecordedAt: (yield* now()).at,
              typeValidFrom: (yield* now()).at,
              typeValidTo: null,
            },
            profile: {
              _tag: 'CURRENT',
              counterpartyRef: known,
              counterpartyRevision: computeCanonicalValueHash({ fixtureCounterparty: known }),
              currentCustomerRoleRef: {
                moduleId: 'party.registry',
                resourceId: knownRole.roleResourceId,
                resourceType: 'party.registry.counterparty-role-period',
                tenantId,
              },
              currentCustomerRoleRevision: computeCanonicalValueHash({ fixtureRole: knownRole }),
              legalEntityRef: {
                moduleId: 'core.identity',
                resourceId: legalEntityId,
                resourceType: 'core.identity.legal-entity',
                tenantId,
              },
              partyRef,
              partyRevision: 1,
              profileRef: input.profileRef,
              profileRevision: input.expectedProfileRevision,
            },
          },
          operation: input.operation,
          outcome: 'NOT_APPLICABLE',
          policyRevisions: [],
          projectionVersion: input.projectionVersion,
        }).pipe(
          Effect.mapError((cause) =>
            Object.defineProperty(
              new CommerceSourceProcessingRejected({
                code: 'UNAVAILABLE',
                reason: 'Internal owner-only decision is invalid',
              }),
              'cause',
              { value: cause },
            ),
          ),
        );
        return yield* validateOrganizationBusinessDecision(scope, input, response);
      }).pipe(
        Effect.mapError((cause) =>
          Schema.is(CommerceSourceProcessingRejected)(cause)
            ? cause
            : Object.defineProperty(
                new CommerceSourceProcessingRejected({
                  code: 'UNAVAILABLE',
                  reason: 'Internal owner-only decision is unavailable',
                }),
                'cause',
                { value: cause },
              ),
        ),
      ),
  });
  const ordinary = Layer.mergeAll(
    role,
    sourcePrivacy,
    organizationBusiness,
    profileReactivationEligibilityEvaluatorFactoryLive,
    partyRegistryGuestResolverFactoryLive,
    partyRegistryRetailPartyResolverFactoryLive,
  ).pipe(Layer.provideMerge(ContextAccessLive), Layer.provide(profileReconfirmationPolicyUnavailableLive));
  // O70: the v2 capability is scope-wide, so one principal no longer differs from another by a
  // SpiceDB tuple. The owner overlay is the per-request seam where the acting principal is known;
  // a suite that proves one principal is refused while the fixture's own manager keeps its allow
  // names that principal here, exactly as a live gate with no matching assignment would (O62).
  const ownerOverlay = Context.get(
    yield* Layer.build(commerceCustomerContextOwnerAuthorizationOverlayLive.pipe(Layer.provide(ContextAccessLive))),
    OwnerAuthorizationOverlay,
  );
  const deniedOwnerAccess = new Set<string>();
  const denyOwnerAccess = (principalId: string, capabilityKey: string) => {
    deniedOwnerAccess.add(ownerAccessKey(principalId, capabilityKey));
  };
  const overlay = Layer.succeed(OwnerAuthorizationOverlay, {
    authorize: (transaction, input) =>
      deniedOwnerAccess.has(ownerAccessKey(input.scope.principalId, input.capabilityKey))
        ? Effect.succeed('denied' as const)
        : ownerOverlay.authorize(transaction, input),
  });
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
    profileCounterparties.set(profile.profileRef.resourceId, counterpartyRef);
    return { profileKind: 'COUNTERPARTY' as const, profileRef: profile.profileRef };
  });
  const subject = yield* createProfile();
  const setOrganizationBusinessAllowed = (allowed: boolean) => {
    if (allowed) {
      configuredOrganizationProfiles.add(subject.profileRef.resourceId);
    } else {
      configuredOrganizationProfiles.delete(subject.profileRef.resourceId);
    }
  };
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
  const applySource = Effect.fn('GroupArchive.applySource')(function* applySource(
    payload: ApplyCustomerGroupMembershipSourcePayload,
    key = randomUUID(),
  ) {
    return yield* runAction({
      payload,
      principal: yield* authenticate(),
      registration: applyCustomerGroupMembershipSourceAction,
      transport: transport(key),
    }).pipe(Effect.provideContext(runtimeContext));
  });
  const recoverSource = Effect.fn('GroupArchive.recoverSource')(function* recoverSource(
    input: CustomerGroupMembershipSourceReceiptRequest,
  ) {
    return yield* Context.get(runtimeContext, ReadRuntime)
      .runRead({
        input,
        principal: yield* authenticate(),
        registration: customerGroupMembershipSourceReceiptRead,
        transport: { correlationId: randomUUID(), targetModuleKey: ownerModuleKey },
      })
      .pipe(Effect.provideContext(runtimeContext));
  });
  const admitSnapshot = Effect.fn('GroupArchive.admitSnapshot')(function* admitSnapshot(
    payload: AdmitCustomerGroupMembershipSnapshotPayload,
  ) {
    return yield* runAction({
      payload,
      principal: yield* authenticate(),
      registration: admitCustomerGroupMembershipSnapshotAction,
      transport: transport(),
    }).pipe(Effect.provideContext(runtimeContext));
  });
  const archiveProfile = Effect.fn('GroupArchive.archiveProfile')(function* archiveProfile() {
    return yield* runAction({
      payload: yield* Schema.decodeUnknownEffect(ArchiveCustomerProfilePayloadSchema)({
        effectiveAt: (yield* now()).at,
        expectedRevision: 1,
        expectedState: 'ACTIVE',
        profileRef: { ...subject.profileRef, kind: subject.profileKind },
        reason: 'INTERNAL_CONTRACT historical source recovery after profile archive',
      }),
      principal: yield* authenticate(),
      registration: archiveCustomerProfileAction,
      transport: transport(),
    }).pipe(Effect.provideContext(runtimeContext));
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
    admitSnapshot,
    applySource,
    archive,
    archiveProfile,
    assign,
    authenticate,
    coreEvidenceExecutor,
    create,
    createProfile,
    denyOwnerAccess,
    fixture,
    isolated,
    legalEntityId,
    membershipRows,
    now,
    organizationChecks,
    permissions,
    reactivate,
    read,
    recoverSource,
    remove,
    restart,
    setOrganizationBusinessAllowed,
    setSourcePrivacyDenied,
    setSourceRecoveryDenied,
    sourcePrivacyChecks,
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
      // The effective-membership Read is decided by its own v2 capability (the fixture's scripted
      // gate); the retired resource tuple no longer widens or narrows it (O62).
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

it.live('preserves exact end boundaries and cancelled future periods', () =>
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
      // The v2 Archive capability is scope-wide (Q2), so one company-scoped principal no longer
      // differs from another by a SpiceDB tuple. The owner overlay is the per-request seam where the
      // acting principal is known, so refuse the other principal's Archive there and prove no owner
      // row moves while the fixture's own manager keeps its allow (O62, O67-Q1).
      const deniedBefore = yield* test.membershipRows();
      const archiveCapabilityKey = archiveCustomerGroupAction.descriptor.accessDeclaration?.key;
      assert(archiveCapabilityKey !== undefined);
      test.denyOwnerAccess(test.fixture.legalEntityOnly.principalId, archiveCapabilityKey);
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

it.live('refuses Archive at the gate before any owner write when the capability is denied', () =>
  Effect.scoped(
    Effect.gen(function* deniedArchiveGate() {
      // The v2 capability is scope-wide (Q2), so one principal no longer differs from another by a
      // tuple; the denial under test is the gate's own answer for the Archive capability. Setup
      // capabilities stay allowed so the fixture can build the exact owner state first.
      const test = yield* nativeFixture({
        'commerce.customer-context.counterparty-purchasing-profile.create': 'allowed',
        'commerce.customer-context.customer-group.archive': 'denied',
        'commerce.customer-context.customer-group.assign': 'allowed',
        'commerce.customer-context.customer-group.create': 'allowed',
        'commerce.customer-context.customer-group.remove': 'allowed',
      });
      const group = yield* test.create('DENIED_GATE', 'Observe the gate denial before any owner write');
      const future = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe((yield* test.now()).at), { days: 1 }));
      const never = yield* test.assign(group.groupRef, future);
      yield* test.remove(never, future);
      const deniedBefore = yield* test.membershipRows();
      const denied = yield* Effect.flip(test.archive(group, (yield* test.now()).at));

      expect(Schema.is(ActionPermissionDenied)(denied)).toBe(true);
      expect(yield* test.membershipRows()).toEqual(deniedBefore);
    }).pipe(Effect.provide(services)),
  ),
);

it.live('keeps native source processing class explicit despite untrusted projection settings', () =>
  Effect.scoped(
    Effect.gen(function* nativeProcessingClassIsolation() {
      const test = yield* nativeFixture();
      const group = yield* test.create('PROCESSING_CLASS', 'Internal source processing-class isolation');
      const { at } = yield* test.now();
      const personal = yield* Schema.decodeUnknownEffect(ApplyCustomerGroupMembershipSourcePayloadSchema)({
        effectiveAt: at,
        groupRef: group.groupRef,
        manager: {
          factFamily: 'CUSTOMER_GROUP_MEMBERSHIP',
          issuer: 'class-source',
          sourceNamespace: 'membership',
          tenantId: test.tenantId,
        },
        operation: 'ASSIGN',
        profile: test.subject,
        reason: 'INTERNAL_CONTRACT original personal processing path',
        route: { id: 'class-source', revision: '1' },
        source: {
          assertionId: 'class-source-1',
          effectId: 'class-source-1',
          order: 1,
          sourceRecordId: 'internal-profile',
        },
      });
      yield* test.admin.insert(customerGroupMembershipSourceRoutes).values({
        active: true,
        allowComplete: true,
        completenessContractCoverage: 'ALL_GROUP_MEMBERSHIPS_FOR_EXACT_PROFILE',
        completenessContractRef: 'internal-class-completeness',
        completenessContractRevision: '1',
        issuer: personal.manager.issuer,
        legalEntityId: test.legalEntityId,
        principalId: test.fixture.manager.principalId,
        routeId: personal.route.id,
        routeRevision: personal.route.revision,
        sourceNamespace: personal.manager.sourceNamespace,
        tenantId: test.tenantId,
      });
      const runtimeContext = yield* Layer.build(
        PgClient.layer({ url: Redacted.make(test.isolated.connections.runtime.connectionString) }).pipe(
          Layer.provideMerge(Reactivity.layer),
        ),
      );
      const runtime = yield* makeWithDefaults({ relations: commerceCustomerContextRelations }).pipe(
        Effect.provide(runtimeContext),
      );
      const personalJson = yield* Schema.encodeEffect(
        Schema.fromJsonString(ApplyCustomerGroupMembershipSourcePayloadSchema),
      )(personal);
      const { reason: _personalReason, ...withoutReason } = personal;
      const organization = yield* Schema.decodeUnknownEffect(OrganizationMembershipSourcePayloadSchema)({
        ...withoutReason,
        processingKind: 'ORG_BUSINESS_REFERENCE',
        reasonCode: 'SOURCE_MEMBERSHIP_ASSERTED',
      });
      const organizationJson = yield* Schema.encodeEffect(
        Schema.fromJsonString(OrganizationMembershipSourcePayloadSchema),
      )(organization);
      const organizationQueryJson = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json))({
        effectId: personal.source.effectId,
        manager: personal.manager,
        processingKind: 'ORG_BUSINESS_REFERENCE',
        profile: personal.profile,
        route: personal.route,
      });
      const complete = yield* Schema.decodeUnknownEffect(OrganizationMembershipSourcePayloadSchema)({
        ...organization,
        completenessProofRef: 'internal-class-complete-2',
        effectiveAt: DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(at), { hours: 1 })),
        groupRefs: [],
        operation: 'COMPLETE',
        reasonCode: 'SOURCE_COMPLETE_SET_RECONCILED',
        source: { ...organization.source, assertionId: 'class-source-2', effectId: 'class-source-2', order: 2 },
      });
      const completeJson = yield* Schema.encodeEffect(Schema.fromJsonString(OrganizationMembershipSourcePayloadSchema))(
        complete,
      );
      const admission = yield* Schema.decodeUnknownEffect(AdmitCustomerGroupMembershipSnapshotPayloadSchema)({
        completenessContract: {
          coverage: 'ALL_GROUP_MEMBERSHIPS_FOR_EXACT_PROFILE',
          ref: 'internal-class-completeness',
          revision: '1',
        },
        expiresAt: DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(at), { hours: 2 })),
        snapshot: complete,
      });
      const admissionJson = yield* Schema.encodeEffect(
        Schema.fromJsonString(AdmitCustomerGroupMembershipSnapshotPayloadSchema),
      )(admission);
      const completeQueryJson = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json))({
        effectId: complete.source.effectId,
        manager: complete.manager,
        processingKind: 'ORG_BUSINESS_REFERENCE',
        profile: complete.profile,
        route: complete.route,
      });
      yield* runtime.transaction((transaction) =>
        Effect.gen(function* hostileProjectionSettings() {
          yield* transaction.execute(
            sql`select set_config('ontos.tenant_id',${test.tenantId},true),set_config('ontos.legal_entity_id',${test.legalEntityId},true),set_config('ontos.ccc_membership_processing_kind','ORG_BUSINESS_REFERENCE',true),set_config('ontos.ccc_membership_reason_code','SOURCE_MEMBERSHIP_ASSERTED',true)`,
            'objects',
          );
          const [fresh] = yield* transaction.execute<{ outcome: string; result: unknown }>(
            sql`select * from commerce_customer_context.apply_customer_group_membership_source(${test.tenantId}::uuid,${test.legalEntityId}::uuid,${test.fixture.manager.principalId}::uuid,${randomUUID()}::uuid,${at}::timestamptz,${personalJson}::jsonb)`,
            'objects',
          );
          expect(fresh?.outcome).toBe('APPLIED');
          const original = yield* Schema.decodeUnknownEffect(ApplyCustomerGroupMembershipSourceResultSchema)(
            fresh?.result,
          );
          expect(original.processingKind).toBeUndefined();
          const [crossClass] = yield* transaction.execute<{ outcome: string; result: unknown }>(
            sql`select * from commerce_customer_context.apply_customer_group_membership_source(${test.tenantId}::uuid,${test.legalEntityId}::uuid,${test.fixture.manager.principalId}::uuid,${randomUUID()}::uuid,${at}::timestamptz,${organizationJson}::jsonb)`,
            'objects',
          );
          expect(crossClass).toMatchObject({ outcome: 'SOURCE_CONFLICT', result: null });
          const [crossClassRead] = yield* transaction.execute<{ outcome: string; result: unknown }>(
            sql`select * from commerce_customer_context.read_customer_group_membership_source_receipt(${test.tenantId}::uuid,${test.legalEntityId}::uuid,${test.fixture.manager.principalId}::uuid,${organizationQueryJson}::jsonb)`,
            'objects',
          );
          expect(crossClassRead).toMatchObject({ outcome: 'SOURCE_AUTHORITY_DENIED', result: null });
          // INTERNAL_CONTRACT SQL boundary proof only. Public ORG Actions additionally require
          // the live current-Organization/Privacy decision; this test never claims that authority.
          const [admitted] = yield* transaction.execute<{ outcome: string; result: unknown }>(
            sql`select * from commerce_customer_context.admit_customer_group_membership_snapshot(${test.tenantId}::uuid,${test.legalEntityId}::uuid,${test.fixture.manager.principalId}::uuid,${randomUUID()}::uuid,${at}::timestamptz,${admissionJson}::jsonb)`,
            'objects',
          );
          expect(admitted?.outcome).toBe('APPLIED');
          const [ended] = yield* transaction.execute<{ outcome: string; result: unknown }>(
            sql`select * from commerce_customer_context.apply_customer_group_membership_source(${test.tenantId}::uuid,${test.legalEntityId}::uuid,${test.fixture.manager.principalId}::uuid,${randomUUID()}::uuid,${at}::timestamptz,${completeJson}::jsonb)`,
            'objects',
          );
          expect(ended?.outcome).toBe('APPLIED');
          const safe = yield* Schema.decodeUnknownEffect(OrganizationMembershipSourceResultSchema, {
            onExcessProperty: 'error',
          })(ended?.result);
          expect(safe.items).toHaveLength(1);
          expect(safe.items[0]?.outcome).toBe('ENDED');
          const [recovered] = yield* transaction.execute<{ outcome: string; result: unknown }>(
            sql`select * from commerce_customer_context.read_customer_group_membership_source_receipt(${test.tenantId}::uuid,${test.legalEntityId}::uuid,${test.fixture.manager.principalId}::uuid,${completeQueryJson}::jsonb)`,
            'objects',
          );
          expect(recovered).toMatchObject({ outcome: 'FOUND', result: safe });
          const [settings] = yield* transaction.execute<{ processingKind: string; reasonCode: string }>(
            sql`select current_setting('ontos.ccc_membership_processing_kind') as "processingKind",current_setting('ontos.ccc_membership_reason_code') as "reasonCode"`,
            'objects',
          );
          expect(settings).toEqual({
            processingKind: 'ORG_BUSINESS_REFERENCE',
            reasonCode: 'SOURCE_MEMBERSHIP_ASSERTED',
          });
        }),
      );
      const receipts = yield* test.admin
        .select()
        .from(customerGroupMembershipSourceReceipts)
        .where(eq(customerGroupMembershipSourceReceipts.tenantId, test.tenantId));
      expect(receipts).toHaveLength(2);
      expect(receipts.find((receipt) => receipt.sourceOrder === 1)?.processingKind).toBe('PERSON');
      const businessReceipt = receipts.find((receipt) => receipt.sourceOrder === 2);
      expect(businessReceipt?.processingKind).toBe('ORG_BUSINESS_REFERENCE');
      const durableSafe = yield* Schema.decodeUnknownEffect(OrganizationMembershipSourceResultSchema, {
        onExcessProperty: 'error',
      })(businessReceipt?.result);
      expect(durableSafe.reasonCode).toBe('SOURCE_COMPLETE_SET_RECONCILED');
      const proofs = yield* test.admin
        .select()
        .from(customerGroupMembershipSnapshotProofs)
        .where(eq(customerGroupMembershipSnapshotProofs.tenantId, test.tenantId));
      expect(proofs).toHaveLength(1);
      expect(proofs[0]?.processingKind).toBe('ORG_BUSINESS_REFERENCE');
      expect(yield* test.membershipRows()).toHaveLength(1);
    }).pipe(Effect.provide(services)),
  ),
);

it.live('governs explicit organization source memberships with safe native receipts and events', () =>
  Effect.scoped(
    Effect.gen(function* organizationSourceMembership() {
      const test = yield* nativeFixture('allowed', 'source');
      const firstGroup = yield* test.create('ORG_SOURCE_FIRST', 'Internal explicit Organization source cohort');
      const secondGroup = yield* test.create('ORG_SOURCE_SECOND', 'Internal explicit Organization source page');
      const { at } = yield* test.now();
      const assign = yield* Schema.decodeUnknownEffect(OrganizationMembershipSourcePayloadSchema)({
        effectiveAt: at,
        groupRef: firstGroup.groupRef,
        manager: {
          factFamily: 'CUSTOMER_GROUP_MEMBERSHIP',
          issuer: 'organization-source',
          sourceNamespace: 'membership',
          tenantId: test.tenantId,
        },
        operation: 'ASSIGN',
        processingKind: 'ORG_BUSINESS_REFERENCE',
        profile: test.subject,
        reasonCode: 'SOURCE_MEMBERSHIP_ASSERTED',
        route: { id: 'organization-source', revision: '1' },
        source: {
          assertionId: 'organization-source-1',
          effectId: 'organization-source-1',
          order: 1,
          sourceRecordId: 'internal-company-profile',
        },
      });
      yield* test.admin.insert(customerGroupMembershipSourceRoutes).values({
        active: true,
        allowComplete: true,
        completenessContractCoverage: 'ALL_GROUP_MEMBERSHIPS_FOR_EXACT_PROFILE',
        completenessContractRef: 'internal-organization-completeness',
        completenessContractRevision: '1',
        issuer: assign.manager.issuer,
        legalEntityId: test.legalEntityId,
        principalId: test.fixture.manager.principalId,
        routeId: assign.route.id,
        routeRevision: assign.route.revision,
        sourceNamespace: assign.manager.sourceNamespace,
        tenantId: test.tenantId,
      });
      const personalChecksBefore = test.sourcePrivacyChecks.length;
      expect(yield* Effect.flip(test.applySource(assign))).toMatchObject({ code: 'SOURCE_AUTHORITY_DENIED' });
      expect(yield* test.membershipRows()).toEqual([]);
      // Explicit owner-only fixture qualification; production current Party/Privacy proof is separate.
      test.setOrganizationBusinessAllowed(true);
      const first = yield* test.applySource(assign);
      const firstSafe = yield* Schema.decodeUnknownEffect(OrganizationMembershipSourceResultSchema, {
        onExcessProperty: 'error',
      })(first);
      const [firstItem] = firstSafe.items;
      assert(firstItem?.outcome === 'ASSIGNED');
      expect(test.organizationChecks.at(-1)).toMatchObject({
        input: {
          expectedProfileRevision: 1,
          inputDigest: computeCanonicalValueHash(assign),
          operation: 'customer-group-membership.write',
          profileRef: test.subject.profileRef,
        },
        requirementKey: 'commerce.customer-context.requirement.org-membership-write-privacy',
      });
      const recovery = yield* Schema.decodeUnknownEffect(CustomerGroupMembershipSourceReceiptRequestSchema)({
        effectId: assign.source.effectId,
        manager: assign.manager,
        processingKind: assign.processingKind,
        profile: assign.profile,
        route: assign.route,
      });
      expect(yield* test.recoverSource(recovery)).toEqual(firstSafe);
      expect(test.organizationChecks.at(-1)?.requirementKey).toBe(
        'commerce.customer-context.requirement.org-membership-recovery-privacy',
      );
      const { processingKind: _processingKind, ...personalRecovery } = recovery;
      expect(yield* Effect.flip(test.recoverSource(personalRecovery))).toBeInstanceOf(ReadHandlerNotFound);
      const partial = yield* Schema.decodeUnknownEffect(OrganizationMembershipSourcePayloadSchema)({
        ...assign,
        groupRefs: [secondGroup.groupRef],
        operation: 'PARTIAL',
        reasonCode: 'SOURCE_PARTIAL_SET_ASSERTED',
        source: { ...assign.source, assertionId: 'organization-source-2', effectId: 'organization-source-2', order: 2 },
      });
      yield* test.applySource(partial);
      const future = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(at), { hours: 1 }));
      const remove = yield* Schema.decodeUnknownEffect(OrganizationMembershipSourcePayloadSchema)({
        ...assign,
        effectiveAt: future,
        expectedRevision: firstItem.membership.revision,
        membershipRef: firstItem.membership.membershipRef,
        operation: 'REMOVE',
        reasonCode: 'SOURCE_MEMBERSHIP_WITHDRAWN',
        source: { ...assign.source, assertionId: 'organization-source-3', effectId: 'organization-source-3', order: 3 },
      });
      yield* test.applySource(remove);
      const complete = yield* Schema.decodeUnknownEffect(OrganizationMembershipSourcePayloadSchema)({
        ...assign,
        completenessProofRef: 'internal-organization-complete-4',
        effectiveAt: DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(at), { hours: 2 })),
        groupRefs: [],
        operation: 'COMPLETE',
        reasonCode: 'SOURCE_COMPLETE_SET_RECONCILED',
        source: { ...assign.source, assertionId: 'organization-source-4', effectId: 'organization-source-4', order: 4 },
      });
      const admission = yield* Schema.decodeUnknownEffect(AdmitCustomerGroupMembershipSnapshotPayloadSchema)({
        completenessContract: {
          coverage: 'ALL_GROUP_MEMBERSHIPS_FOR_EXACT_PROFILE',
          ref: 'internal-organization-completeness',
          revision: '1',
        },
        expiresAt: DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(at), { hours: 4 })),
        snapshot: complete,
      });
      yield* test.admitSnapshot(admission);
      expect(test.organizationChecks.at(-1)?.requirementKey).toBe(
        'commerce.customer-context.requirement.org-membership-snapshot-admit-privacy',
      );
      const ended = yield* test.applySource(complete);
      expect(ended.items).toHaveLength(1);
      test.setOrganizationBusinessAllowed(false);
      expect(yield* Effect.flip(test.recoverSource(recovery))).toBeInstanceOf(ReadHandlerNotFound);
      expect(yield* Effect.flip(test.applySource(assign))).toMatchObject({ code: 'SOURCE_AUTHORITY_DENIED' });
      test.setOrganizationBusinessAllowed(true);
      expect(yield* test.applySource(assign)).toEqual(firstSafe);
      expect(test.organizationChecks.at(-1)).toMatchObject({
        input: { operation: 'customer-group-membership.recover' },
        requirementKey: 'commerce.customer-context.requirement.org-membership-write-privacy',
      });
      expect(yield* test.recoverSource(recovery)).toEqual(firstSafe);
      expect(test.sourcePrivacyChecks).toHaveLength(personalChecksBefore);
      const receipts = yield* test.admin
        .select()
        .from(customerGroupMembershipSourceReceipts)
        .where(eq(customerGroupMembershipSourceReceipts.tenantId, test.tenantId));
      expect(receipts).toHaveLength(4);
      for (const receipt of receipts) {
        expect(receipt.processingKind).toBe('ORG_BUSINESS_REFERENCE');
        yield* Schema.decodeUnknownEffect(OrganizationMembershipSourceResultSchema, { onExcessProperty: 'error' })(
          receipt.result,
        );
      }
      const evidence = yield* test.fixture.evidence(test.coreEvidenceExecutor);
      const events = evidence.events.filter((event) =>
        event.eventType.startsWith('commerce.customer-context.organization-customer-group-membership-'),
      );
      expect(events).toHaveLength(4);
      for (const event of events) {
        yield* Schema.decodeUnknownEffect(OrganizationMembershipChangeEventSchema, { onExcessProperty: 'error' })(
          event.payloadJson,
        );
        expect(evidence.outbox.filter((message) => message.domainEventId === event.domainEventId)).toHaveLength(1);
      }
      expect((yield* test.membershipRows()).every((membership) => membership.lifecycle === 'ENDED')).toBe(true);
    }).pipe(Effect.provide(services)),
  ),
);

it.live('commits source effects once and gates historical receipts through governed owner operations', () =>
  Effect.scoped(
    Effect.gen(function* sourceMembership() {
      const oldSql = yield* Config.Boolean('ONTOS_GROUP_ARCHIVE_PRE_MIGRATION').pipe(Config.withDefault(false));
      if (oldSql) {
        return;
      }
      const test = yield* nativeFixture('allowed', 'source');
      const group = yield* test.create('SOURCE');
      const { at } = yield* test.now();
      // INTERNAL_CONTRACT: source and bound route have no production configuration or external authority.
      const assign = yield* Schema.decodeUnknownEffect(ApplyCustomerGroupMembershipSourcePayloadSchema)({
        effectiveAt: at,
        groupRef: group.groupRef,
        manager: {
          factFamily: 'CUSTOMER_GROUP_MEMBERSHIP',
          issuer: 'internal-source',
          sourceNamespace: 'membership',
          tenantId: test.tenantId,
        },
        operation: 'ASSIGN',
        profile: test.subject,
        reason: 'Internal source assignment',
        route: { id: 'internal-route', revision: '1' },
        source: { assertionId: 'assertion-1', effectId: 'effect-1', order: 1, sourceRecordId: 'profile-1' },
      });
      const unauthorized = yield* Effect.flip(test.applySource(assign));
      expect(unauthorized).toBeInstanceOf(CustomerGroupMembershipSourceRejected);
      expect(unauthorized).toMatchObject({ code: 'SOURCE_AUTHORITY_DENIED' });
      yield* test.admin.insert(customerGroupMembershipSourceRoutes).values({
        active: true,
        allowComplete: true,
        issuer: assign.manager.issuer,
        legalEntityId: test.legalEntityId,
        principalId: test.fixture.manager.principalId,
        routeId: assign.route.id,
        routeRevision: assign.route.revision,
        sourceNamespace: assign.manager.sourceNamespace,
        tenantId: test.tenantId,
      });
      const idempotencyKey = randomUUID();
      const [first, concurrent] = yield* Effect.all(
        [test.applySource(assign, idempotencyKey), test.applySource(assign)],
        { concurrency: 2 },
      );
      expect(concurrent).toEqual(first);
      expect(first.items).toMatchObject([
        { membership: { management: { kind: 'EXTERNAL_SOURCE' } }, outcome: 'ASSIGNED' },
      ]);
      const previous = DateTime.formatIso(DateTime.subtract(DateTime.makeUnsafe(at), { milliseconds: 1 }));
      expect((yield* test.read(previous)).items).toEqual([]);
      const effective = yield* test.read(at);
      expect(effective.items).toMatchObject([
        {
          groupRef: group.groupRef,
          management: { kind: 'EXTERNAL_SOURCE', manager: assign.manager, source: { order: assign.source.order } },
          revision: 1,
        },
      ]);
      expect(effective.items[0]?.management).toEqual({
        kind: 'EXTERNAL_SOURCE',
        manager: assign.manager,
        source: { order: assign.source.order },
      });
      expect(effective.items[0]?.membershipRef).toEqual(
        first.items[0]?.outcome === 'ASSIGNED' ? first.items[0].membership.membershipRef : undefined,
      );
      const recoveryInput = {
        effectId: assign.source.effectId,
        manager: assign.manager,
        profile: assign.profile,
        route: assign.route,
      };
      expect(yield* test.recoverSource(recoveryInput)).toEqual(first);
      yield* test.restart();
      const repeatedInvocation = yield* Effect.flip(test.applySource(assign, idempotencyKey));
      expect(repeatedInvocation).toBeInstanceOf(ActionAlreadyCommitted);
      expect(repeatedInvocation).not.toHaveProperty('items');
      expect(repeatedInvocation).not.toHaveProperty('source');
      const replay = yield* test.applySource(assign);
      expect(replay).toEqual(first);
      test.setSourceRecoveryDenied(true);
      expect(yield* Effect.flip(test.applySource(assign))).toMatchObject({ code: 'SOURCE_AUTHORITY_DENIED' });
      expect(yield* Effect.flip(test.recoverSource(recoveryInput))).toBeInstanceOf(ReadHandlerNotFound);
      test.setSourceRecoveryDenied(false);
      test.setSourcePrivacyDenied(true);
      expect(yield* Effect.flip(test.applySource(assign))).toMatchObject({ code: 'SOURCE_AUTHORITY_DENIED' });
      expect(yield* Effect.flip(test.recoverSource(recoveryInput))).toBeInstanceOf(ReadHandlerNotFound);
      test.setSourcePrivacyDenied(false);
      expect(yield* test.recoverSource(recoveryInput)).toEqual(first);
      expect(test.sourcePrivacyChecks.at(-1)).toEqual({
        operation: 'customer-group-membership.recover',
        source: {
          issuer: assign.manager.issuer,
          namespace: assign.manager.sourceNamespace,
          occurrenceId: assign.source.assertionId,
          recordId: assign.source.sourceRecordId,
          recordType: assign.manager.factFamily,
          routeRef: assign.route.id,
        },
        target: { kind: 'COUNTERPARTY_PURCHASING_PROFILE', resourceId: assign.profile.profileRef.resourceId },
      });
      const evidence = yield* test.fixture.evidence(test.coreEvidenceExecutor);
      const assigned = evidence.events.filter(
        (event) => event.eventType === 'commerce.customer-context.customer-group-membership-assigned.v1',
      );
      expect(assigned).toHaveLength(1);
      expect(evidence.outbox.filter((message) => message.domainEventId === assigned[0]?.domainEventId)).toHaveLength(1);
      expect(
        yield* test.admin
          .select()
          .from(customerGroupMembershipSourceReceipts)
          .where(eq(customerGroupMembershipSourceReceipts.tenantId, test.tenantId)),
      ).toHaveLength(1);
      const spoofed = yield* Schema.decodeUnknownEffect(ApplyCustomerGroupMembershipSourcePayloadSchema)({
        ...assign,
        manager: { ...assign.manager, issuer: 'unrelated-source' },
      });
      expect(yield* Effect.flip(test.applySource(spoofed))).toMatchObject({ code: 'SOURCE_AUTHORITY_DENIED' });
      const crossTenant = yield* Schema.decodeUnknownEffect(ApplyCustomerGroupMembershipSourcePayloadSchema)({
        ...assign,
        manager: { ...assign.manager, tenantId: randomUUID() },
      });
      const privacyChecksBeforeScopeDenial = test.sourcePrivacyChecks.length;
      expect(yield* Effect.flip(test.applySource(crossTenant))).toMatchObject({ code: 'SOURCE_SCOPE_MISMATCH' });
      expect(test.sourcePrivacyChecks).toHaveLength(privacyChecksBeforeScopeDenial);
      yield* test.admin
        .update(customerGroupMembershipSourceRoutes)
        .set({ routeRevision: '2' })
        .where(
          and(
            eq(customerGroupMembershipSourceRoutes.tenantId, test.tenantId),
            eq(customerGroupMembershipSourceRoutes.routeId, assign.route.id),
          ),
        );
      expect(yield* Effect.flip(test.applySource(assign))).toMatchObject({ code: 'SOURCE_AUTHORITY_DENIED' });
      const rotated = yield* Schema.decodeUnknownEffect(ApplyCustomerGroupMembershipSourcePayloadSchema)({
        ...assign,
        route: { ...assign.route, revision: '2' },
      });
      expect(yield* test.applySource(rotated)).toEqual(first);
      expect(yield* test.recoverSource({ ...recoveryInput, route: rotated.route })).toEqual(first);
      const finalEvidence = yield* test.fixture.evidence(test.coreEvidenceExecutor);
      expect(
        finalEvidence.events.filter(
          (event) => event.eventType === 'commerce.customer-context.customer-group-membership-assigned.v1',
        ),
      ).toHaveLength(1);
      yield* test.archiveProfile();
      test.setSourcePrivacyDenied(true);
      expect(yield* Effect.flip(test.recoverSource({ ...recoveryInput, route: rotated.route }))).toBeInstanceOf(
        ReadHandlerNotFound,
      );
      test.setSourcePrivacyDenied(false);
      expect(yield* test.recoverSource({ ...recoveryInput, route: rotated.route })).toEqual(first);
      expect(yield* Effect.flip(test.applySource(rotated))).toMatchObject({ code: 'TARGET_INELIGIBLE' });
      expect(yield* test.membershipRows()).toHaveLength(1);
    }),
  ).pipe(Effect.provide(services)),
);

it.live('reconciles only the exact source manager and preserves scheduled removal through group reactivation', () =>
  Effect.scoped(
    Effect.gen(function* sourceCompleteMembership() {
      const test = yield* nativeFixture('allowed', 'source');
      const manualGroup = yield* test.create('SOURCE_MANUAL', 'Internal manual membership retention');
      const ownedGroup = yield* test.create('SOURCE_OWNED', 'Internal source E assigned customer cohort');
      const foreignGroup = yield* test.create('SOURCE_FOREIGN', 'Internal source F assigned customer cohort');
      const { at } = yield* test.now();
      const manual = yield* test.assign(manualGroup.groupRef, at);
      const payload = (issuer: string, group: typeof ownedGroup, order: number) =>
        Schema.decodeUnknownEffect(ApplyCustomerGroupMembershipSourcePayloadSchema)({
          effectiveAt: at,
          groupRef: group.groupRef,
          manager: {
            factFamily: 'CUSTOMER_GROUP_MEMBERSHIP',
            issuer,
            sourceNamespace: 'membership',
            tenantId: test.tenantId,
          },
          operation: 'ASSIGN',
          profile: test.subject,
          reason: 'INTERNAL_CONTRACT explicit source assignment',
          route: { id: issuer, revision: '1' },
          source: {
            assertionId: `${issuer}-${order}`,
            effectId: `${issuer}-${order}`,
            order,
            sourceRecordId: 'internal-profile',
          },
        });
      for (const issuer of ['source-e', 'source-f']) {
        yield* test.admin.insert(customerGroupMembershipSourceRoutes).values({
          active: true,
          allowComplete: true,
          issuer,
          legalEntityId: test.legalEntityId,
          principalId: test.fixture.manager.principalId,
          routeId: issuer,
          routeRevision: '1',
          sourceNamespace: 'membership',
          tenantId: test.tenantId,
        });
      }
      const firstInput = yield* payload('source-e', ownedGroup, 1);
      const first = yield* test.applySource(firstInput);
      const foreignInput = yield* payload('source-f', foreignGroup, 1);
      yield* test.applySource(foreignInput);
      const satisfied = yield* test.applySource(yield* payload('source-e', manualGroup, 2));
      expect(satisfied.items).toEqual([{ groupRef: manualGroup.groupRef, outcome: 'SATISFIED_BY_OTHER_MANAGER' }]);
      const complete = yield* Schema.decodeUnknownEffect(ApplyCustomerGroupMembershipSourcePayloadSchema)({
        ...firstInput,
        completenessProofRef: 'internal-complete-3',
        groupRefs: [],
        operation: 'COMPLETE',
        source: { ...firstInput.source, assertionId: 'source-e-3', effectId: 'source-e-3', order: 3 },
      });
      expect(yield* Effect.flip(test.applySource(complete))).toMatchObject({ code: 'SOURCE_AUTHORITY_DENIED' });
      const invalidComplete = yield* Schema.decodeUnknownEffect(ApplyCustomerGroupMembershipSourcePayloadSchema)({
        ...complete,
        completenessProofRef: 'internal-invalid-complete-3',
        groupRefs: [{ ...ownedGroup.groupRef, resourceId: randomUUID() }],
      });
      const completenessContract = {
        coverage: 'ALL_GROUP_MEMBERSHIPS_FOR_EXACT_PROFILE',
        ref: 'internal-qualified-membership-snapshot',
        revision: '1',
      };
      const invalidAdmission = yield* Schema.decodeUnknownEffect(AdmitCustomerGroupMembershipSnapshotPayloadSchema)({
        completenessContract,
        expiresAt: DateTime.formatIso(DateTime.add(DateTime.makeUnsafe((yield* test.now()).at), { hours: 1 })),
        snapshot: invalidComplete,
      });
      // A caller cannot turn its own declaration into authority on an unqualified route.
      expect(yield* Effect.flip(test.admitSnapshot(invalidAdmission))).toMatchObject({
        code: 'SOURCE_AUTHORITY_DENIED',
      });
      // INTERNAL_CONTRACT operator qualification, independent from incoming snapshot contents.
      yield* test.admin
        .update(customerGroupMembershipSourceRoutes)
        .set({
          completenessContractCoverage: completenessContract.coverage,
          completenessContractRef: completenessContract.ref,
          completenessContractRevision: completenessContract.revision,
        })
        .where(
          and(
            eq(customerGroupMembershipSourceRoutes.tenantId, test.tenantId),
            eq(customerGroupMembershipSourceRoutes.legalEntityId, test.legalEntityId),
          ),
        );
      expect(yield* Effect.flip(test.admitSnapshot(invalidAdmission))).toMatchObject({ code: 'TARGET_NOT_FOUND' });
      expect((yield* test.read(at)).items).toHaveLength(3);
      const foreignAdmission = yield* Schema.decodeUnknownEffect(AdmitCustomerGroupMembershipSnapshotPayloadSchema)({
        completenessContract,
        expiresAt: DateTime.formatIso(DateTime.add(DateTime.makeUnsafe((yield* test.now()).at), { hours: 1 })),
        snapshot: {
          ...foreignInput,
          completenessProofRef: 'internal-source-f-proof-2',
          groupRefs: [foreignGroup.groupRef],
          operation: 'COMPLETE',
          source: { ...foreignInput.source, assertionId: 'source-f-2', effectId: 'source-f-2', order: 2 },
        },
      });
      const foreignProof = yield* test.admitSnapshot(foreignAdmission);
      const foreignProofRows = yield* test.admin
        .select()
        .from(customerGroupMembershipSnapshotProofs)
        .where(
          and(
            eq(customerGroupMembershipSnapshotProofs.tenantId, test.tenantId),
            eq(customerGroupMembershipSnapshotProofs.proofRef, foreignProof.proofRef),
          ),
        );
      expect(foreignProofRows).toHaveLength(1);
      const producerInvocationId = foreignProofRows[0]?.qualifiedByActionInvocationId;
      expect(producerInvocationId).not.toBeNull();
      const producerEvidence = yield* test.fixture.evidence(test.coreEvidenceExecutor);
      const producerAccesses = producerEvidence.accesses.filter(
        (access) => access.actionInvocationId === producerInvocationId,
      );
      expect(producerAccesses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            queryHash: `membership-snapshot-profile:${test.subject.profileRef.resourceId}`,
            resultCount: 1,
            targetResourceId: test.subject.profileRef.resourceId,
            targetResourceType: test.subject.profileRef.resourceType,
          }),
          expect.objectContaining({
            queryHash: `membership-snapshot-group:${foreignGroup.groupRef.resourceId}`,
            resultCount: 1,
            targetModuleKey: foreignGroup.groupRef.moduleId,
            targetResourceId: foreignGroup.groupRef.resourceId,
            targetResourceType: foreignGroup.groupRef.resourceType,
          }),
        ]),
      );
      for (const access of producerAccesses) {
        expect(access.evidenceCaptureMode).toBe('metadata_only');
        expect(access.evidencePayloadJson).toBeNull();
      }
      expect(yield* test.admitSnapshot(foreignAdmission)).toEqual(foreignProof);
      const replayEvidence = yield* test.fixture.evidence(test.coreEvidenceExecutor);
      const newProducerAccesses = replayEvidence.accesses.filter(
        (access) => !producerEvidence.accesses.some((before) => before.dataAccessEventId === access.dataAccessEventId),
      );
      expect(
        newProducerAccesses.filter((access) => access.targetResourceType === foreignGroup.groupRef.resourceType),
      ).toEqual([]);
      const admission = yield* Schema.decodeUnknownEffect(AdmitCustomerGroupMembershipSnapshotPayloadSchema)({
        completenessContract,
        expiresAt: DateTime.formatIso(DateTime.add(DateTime.makeUnsafe((yield* test.now()).at), { seconds: 5 })),
        snapshot: complete,
      });
      const unqualifiedAdmission = yield* Schema.decodeUnknownEffect(AdmitCustomerGroupMembershipSnapshotPayloadSchema)(
        {
          ...admission,
          completenessContract: { ...completenessContract, revision: 'unqualified' },
        },
      );
      expect(yield* Effect.flip(test.admitSnapshot(unqualifiedAdmission))).toMatchObject({
        code: 'SOURCE_AUTHORITY_DENIED',
      });
      test.setSourcePrivacyDenied(true);
      expect(yield* Effect.flip(test.admitSnapshot(admission))).toMatchObject({ code: 'SOURCE_AUTHORITY_DENIED' });
      test.setSourcePrivacyDenied(false);
      const proof = yield* test.admitSnapshot(admission);
      expect(proof.proofRef).toBe('internal-complete-3');
      expect(yield* test.admitSnapshot(admission)).toEqual(proof);
      const alteredAdmission = yield* Schema.decodeUnknownEffect(AdmitCustomerGroupMembershipSnapshotPayloadSchema)({
        ...admission,
        expiresAt: DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(admission.expiresAt), { minutes: 1 })),
      });
      expect(yield* Effect.flip(test.admitSnapshot(alteredAdmission))).toMatchObject({ code: 'SOURCE_CONFLICT' });
      const proofRows = yield* test.admin
        .select()
        .from(customerGroupMembershipSnapshotProofs)
        .where(
          and(
            eq(customerGroupMembershipSnapshotProofs.tenantId, test.tenantId),
            eq(customerGroupMembershipSnapshotProofs.proofRef, proof.proofRef),
          ),
        );
      expect(proofRows).toHaveLength(1);
      expect(proofRows[0]?.qualifiedByActionInvocationId).not.toBeNull();
      expect(proofRows[0]?.qualifiedByPrincipalId).toBe(test.fixture.manager.principalId);
      expect(proofRows[0]?.proofDigest).toBe(proof.digest);
      const ended = yield* test.applySource(complete);
      expect(ended.items).toHaveLength(1);
      expect(ended.items[0]).toMatchObject({ membership: { groupRef: ownedGroup.groupRef }, outcome: 'ENDED' });
      const remaining = yield* test.read(at);
      expect(remaining.items.some((item) => item.membershipRef.resourceId === manual.membershipRef.resourceId)).toBe(
        true,
      );
      expect(remaining.items.some((item) => item.groupRef.resourceId === foreignGroup.groupRef.resourceId)).toBe(true);
      expect(remaining.items).toHaveLength(2);
      yield* Effect.sleep('5100 millis');
      // Expired admission cannot authorize a new diff; exact recovery returns the retained effect.
      expect(yield* test.applySource(complete)).toEqual(ended);
      const conflictingComplete = yield* Schema.decodeUnknownEffect(ApplyCustomerGroupMembershipSourcePayloadSchema)({
        ...complete,
        reason: 'Conflicting content',
      });
      expect(yield* Effect.flip(test.applySource(conflictingComplete))).toMatchObject({
        code: 'SOURCE_CONFLICT',
      });
      const lateOld = yield* Schema.decodeUnknownEffect(ApplyCustomerGroupMembershipSourcePayloadSchema)({
        ...firstInput,
        source: { ...firstInput.source, assertionId: 'late-old', effectId: 'late-old' },
      });
      expect(yield* Effect.flip(test.applySource(lateOld))).toMatchObject({ code: 'SOURCE_CONFLICT' });
      const recovered = yield* test.recoverSource({
        effectId: firstInput.source.effectId,
        manager: firstInput.manager,
        profile: firstInput.profile,
        route: firstInput.route,
      });
      expect(recovered).toEqual(first);
      expect((yield* test.read(at)).items).toHaveLength(2);
      const scheduledGroup = yield* test.create('SOURCE_SCHEDULED', 'Internal scheduled source membership lifecycle');
      const assignedAt = (yield* test.now()).at;
      const scheduledInput = yield* Schema.decodeUnknownEffect(ApplyCustomerGroupMembershipSourcePayloadSchema)({
        ...firstInput,
        effectiveAt: assignedAt,
        groupRef: scheduledGroup.groupRef,
        source: { ...firstInput.source, assertionId: 'source-e-4', effectId: 'source-e-4', order: 4 },
      });
      const scheduled = yield* test.applySource(scheduledInput);
      const [assignedItem] = scheduled.items;
      assert(assignedItem?.outcome === 'ASSIGNED');
      const futureAt = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(assignedAt), { hours: 1 }));
      const scheduledRemove = yield* Schema.decodeUnknownEffect(ApplyCustomerGroupMembershipSourcePayloadSchema)({
        ...scheduledInput,
        effectiveAt: futureAt,
        expectedRevision: assignedItem.membership.revision,
        membershipRef: assignedItem.membership.membershipRef,
        operation: 'REMOVE',
        source: { ...firstInput.source, assertionId: 'source-e-5', effectId: 'source-e-5', order: 5 },
      });
      const removed = yield* test.applySource(scheduledRemove);
      expect(removed.items[0]).toMatchObject({ membership: { effectiveTo: futureAt }, outcome: 'ENDED' });
      const archiveAt = (yield* test.now()).at;
      const archived = yield* test.archive(scheduledGroup, archiveAt);
      const reactivatedAt = (yield* test.now()).at;
      yield* test.reactivate(archived.group, reactivatedAt);
      expect(
        (yield* test.read(futureAt)).items.some(
          (item) => item.groupRef.resourceId === scheduledGroup.groupRef.resourceId,
        ),
      ).toBe(false);
      expect(yield* test.applySource(scheduledInput)).toEqual(scheduled);
      expect(
        (yield* test.read(futureAt)).items.some(
          (item) => item.groupRef.resourceId === scheduledGroup.groupRef.resourceId,
        ),
      ).toBe(false);
    }),
  ).pipe(Effect.provide(services)),
);
