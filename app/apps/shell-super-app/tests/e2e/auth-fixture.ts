import { makeDatabaseIdentityEnrollmentLive } from '@app/core-runtime';
import { SHARED_RUNTIME_IDENTITY } from '@app/core-runtime/db/database-identity-manifest';
import { TenantAccessBootstrap, TenantAccessBootstrapLive } from '@app/core-runtime/access/bootstrap';
import { AccessCatalogModulesSchema } from '@app/core-runtime/access/catalog';
import { AccessChangesStoreLive } from '@app/core-runtime/access/changes/persistence/drizzle-store';
import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '@app/core-runtime/access/compiler/spice-db-compiler';
import {
  AccessScopeIdSchema,
  LegalEntityIdSchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  TenantIdSchema,
} from '@app/core-runtime/access/ids';
import type { AccessScopeId, RoleId, RoleRevisionId, TenantId } from '@app/core-runtime/access/ids';
import { AccessCatalogSnapshotWriterLive } from '@app/core-runtime/access/intent/catalog-snapshot-writer';
import { AccessMembershipStoreLive } from '@app/core-runtime/access/intent/memberships';
import { AccessProjectionCompiler } from '@app/core-runtime/access/intent/projection-compiler';
import { AccessProjectionWriter, AccessProjectionWriterLive } from '@app/core-runtime/access/intent/projection-writer';
import { TenantIntentLoaderLive } from '@app/core-runtime/access/intent/tenant-intent-loader';
import { AccessWriteJournalStoreLive } from '@app/core-runtime/access/lifecycle/persistence/journal-store';
import { loadSpiceDbConfig } from '@app/core-runtime/access/spicedb-config';
import type { SpiceDbConfigValue } from '@app/core-runtime/access/spicedb-config';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { CoreDatabase } from '@app/core-runtime/db/client';
import { installedModuleKeysOf, stageScopeOf } from '@app/core-runtime/install/stage-context-bootstrap';
import { APP_ENV_PATH, APP_WORKSPACE_ROOT } from '@app/core-runtime/workspace-environment';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { betterAuth } from 'better-auth';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { Context, Crypto, DateTime, Effect, FileSystem, Layer, Path, Redacted, Schema } from 'effect';

import { AccessChangesStore } from '../../../../packages/core-runtime/src/access/changes/persistence/store.ts';
import type { Cell } from '../../../../packages/core-runtime/src/access/model.ts';
import { writeGrantIncarnations } from '../../../../packages/core-runtime/src/access/intent/grant-incarnations.ts';
import { configureDatabasePool } from '../../../../packages/core-runtime/src/db/pool-configuration.ts';
import {
  accessAssignments,
  accessMemberships,
  coreRelations,
  legalEntities,
  principalAuthBindings,
  principals,
  tenantModuleStates,
  tenants,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../../../../packages/core-runtime/src/db/types.ts';
import {
  acquireOutlivingCleanup,
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { SHELL_DATABASE_IDENTITY_ENROLLMENT } from '../../api/database-identity-enrollment.ts';
import { loadAuthConfig } from '../../api/auth/config.ts';
import { makeAuthDatabase } from '../../api/auth/db/client.ts';
import { account, session, user } from '../../api/auth/db/schema.ts';

const contactsModuleId = 'party.registry';
const shellAppModuleId = 'shell-super-app';

// Real server deadlines are what bound this fixture's finalizers: a stuck statement would
// otherwise keep a pooled connection busy and hold the client scope open. Keep the shared
// connect bound and shorten the statement bound so PostgreSQL cancels stuck work itself.
// Never use query_timeout or a Promise race -- neither cancels server work.
const e2ePoolDeadlines = {
  connectTimeoutMillis: 5000,
  statement_timeout: 10_000,
} as const;

class E2eAuthorizationFixtureError extends Schema.TaggedError<E2eAuthorizationFixtureError>()(
  'E2eAuthorizationFixtureError',
  { reason: Schema.String },
) {}

interface FixtureTenant {
  readonly legalEntityId: string;
  readonly name: string;
  readonly principalId: string;
  readonly tenantId: string;
}

// Database module activation does not grant access: a tenant's authority comes only from v2 intent.
// Each E2E tenant is bootstrapped the way a product tenant is (scopes, its owner's memberships, the
// release of its installed modules and "Plný přístup" in every scope), then reconciled by the single
// Core writer the Shell's gate reads.
const accessRuntime = (executor: CoreDatabaseExecutor, configuration: SpiceDbConfigValue) => {
  const engine = Layer.effect(
    AccessProjectionCompiler,
    Effect.acquireRelease(
      Effect.sync(() => makeAccessProjectionTransport(configuration)),
      (transport) => Effect.sync(() => transport.close()),
    ).pipe(Effect.map((transport) => makeAccessProjectionCompiler(transport))),
  );
  const platform = Layer.mergeAll(
    Layer.succeed(CoreDatabase, { executor }),
    engine,
    makeDatabaseIdentityEnrollmentLive(SHELL_DATABASE_IDENTITY_ENROLLMENT),
  );
  const stores = Layer.mergeAll(
    TenantIntentLoaderLive,
    AccessWriteJournalStoreLive,
    AccessMembershipStoreLive,
    AccessChangesStoreLive,
  ).pipe(Layer.provide(platform));
  const catalog = AccessCatalogSnapshotWriterLive.pipe(Layer.provide(stores));
  const writer = AccessProjectionWriterLive.pipe(Layer.provide(Layer.mergeAll(stores, platform)));
  const bootstrap = TenantAccessBootstrapLive.pipe(Layer.provide(Layer.mergeAll(stores, platform, catalog, writer)));
  return Layer.mergeAll(bootstrap, writer, stores);
};

const loadAccessCatalog = Effect.fn('loadAccessCatalog')(function* loadAccessCatalogEffect() {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = yield* fileSystem.readFileString(path.join(APP_WORKSPACE_ROOT, 'topology/authorization-catalog.json'));
  const artifact = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Struct({ modules: AccessCatalogModulesSchema })),
  )(source);
  return artifact.modules;
});

const ownerScopeOf = ({ principalId, tenantId }: FixtureTenant) => stageScopeOf({ principalId, tenantId });

/**
 * Ends an E2E tenant the way a retired tenant ends: access evidence is never removed, so its memberships
 * and assignments are revoked and its identity rows archived, and the reconcile that follows takes the
 * projected tuples with them.
 */
const retireTenant = Effect.fn('retireE2eTenant')(function* retireE2eTenantEffect(
  executor: CoreDatabaseExecutor,
  tenant: FixtureTenant,
) {
  const scope = yield* ownerScopeOf(tenant);
  const retiredAt = yield* DateTime.nowAsDate;
  const { tenantId } = tenant;
  yield* executor.transaction((transaction) =>
    Effect.gen(function* retireInTenantScope() {
      // The access tables are tenant-guarded: without the tenant's scope no row would match.
      yield* installOperationalScope(transaction, scope, SHELL_DATABASE_IDENTITY_ENROLLMENT);
      yield* transaction
        .update(principalAuthBindings)
        .set({ revokedAt: retiredAt, status: 'revoked' })
        .where(and(eq(principalAuthBindings.tenantId, tenantId), ne(principalAuthBindings.status, 'revoked')));
      yield* transaction
        .update(accessMemberships)
        .set({ status: 'revoked' })
        .where(and(eq(accessMemberships.tenantId, tenantId), ne(accessMemberships.status, 'revoked')));
      yield* transaction
        .update(accessAssignments)
        .set({ status: 'revoked' })
        .where(and(eq(accessAssignments.tenantId, tenantId), ne(accessAssignments.status, 'revoked')));
      yield* transaction.update(principals).set({ status: 'archived' }).where(eq(principals.tenantId, tenantId));
      yield* transaction
        .update(tenantModuleStates)
        .set({ state: 'archived' })
        .where(eq(tenantModuleStates.tenantId, tenantId));
      yield* transaction.update(legalEntities).set({ status: 'archived' }).where(eq(legalEntities.tenantId, tenantId));
      yield* transaction.update(tenants).set({ status: 'archived' }).where(eq(tenants.tenantId, tenantId));
    }),
  );
  const writer = yield* AccessProjectionWriter;
  yield* writer.reconcileTenant({ scope });
});

type AccessAssignment = typeof accessAssignments.$inferSelect;
type NewAccessAssignment = typeof accessAssignments.$inferInsert;

/** Assigns a narrowed role in place of revoked assignments; a decision witnesses a cell only through its grant incarnation. */
const assignNarrowedAccess = Effect.fn('assignNarrowedE2eAccess')(function* assignNarrowedE2eAccessEffect(
  transaction: CoreTransaction,
  input: {
    readonly cells: readonly Cell[];
    readonly replacements: readonly NewAccessAssignment[];
    readonly roleId: RoleId;
    readonly roleRevisionId: RoleRevisionId;
    readonly scopeIds: readonly AccessScopeId[];
    readonly tenantId: TenantId;
  },
) {
  yield* writeGrantIncarnations(transaction, {
    addedCells: input.cells,
    removedCells: [],
    roleId: input.roleId,
    scopeIds: input.scopeIds,
    targetRevisionId: input.roleRevisionId,
    tenantId: input.tenantId,
  });
  return yield* transaction
    .insert(accessAssignments)
    .values([...input.replacements])
    .returning();
});

/** Revokes the narrowed assignments and grants the revoked originals again, in one write. */
const swapBackAssignments = Effect.fn('swapBackE2eAssignments')(function* swapBackE2eAssignmentsEffect(
  transaction: CoreTransaction,
  input: {
    readonly narrowed: readonly AccessAssignment[];
    readonly regranted: readonly NewAccessAssignment[];
    readonly tenantId: string;
  },
) {
  if (input.narrowed.length > 0) {
    yield* transaction
      .update(accessAssignments)
      .set({ status: 'revoked' })
      .where(
        and(
          eq(accessAssignments.tenantId, input.tenantId),
          inArray(
            accessAssignments.incarnationId,
            input.narrowed.map(({ incarnationId }) => incarnationId),
          ),
        ),
      );
  }
  yield* transaction.insert(accessAssignments).values([...input.regranted]);
});

export const createAuthenticationFixture = Effect.fn('createAuthenticationFixture')(
  function* createAuthenticationFixtureEffect() {
    const crypto = yield* Crypto.Crypto;
    const fixtureId = yield* crypto.randomUUIDv4();
    const e2eCredentials = {
      email: `e2e.${fixtureId}@example.test`,
      password: 'e2e-correct-horse-battery-staple',
    };
    const makeTenant = (name: string) =>
      Effect.all({
        legalEntityId: crypto.randomUUIDv4(),
        name: Effect.succeed(name),
        principalId: crypto.randomUUIDv4(),
        tenantId: crypto.randomUUIDv4(),
      });
    const e2eTenants = yield* Effect.all({
      first: makeTenant('E2E Alpha tenant'),
      second: makeTenant('E2E Zeta tenant'),
    });
    const { baseUrl: baseURL, connectionString, secret } = yield* loadAuthConfig({ envPath: APP_ENV_PATH });

    const { connectTimeout, startupParameters } = yield* configureDatabasePool(
      Redacted.make(connectionString),
      e2ePoolDeadlines,
    );
    const coreClient = yield* makeTestPgClient(connectionString, { connectTimeout, startupParameters });
    const coreDatabase = yield* makeTestDatabaseFromClient(coreClient, coreRelations);
    const spiceDb = yield* loadSpiceDbConfig();
    if (!spiceDb.endpoint.startsWith('localhost:')) {
      return yield* new E2eAuthorizationFixtureError({
        reason: 'E2E authorization fixtures require localhost SpiceDB',
      });
    }
    const catalog = yield* loadAccessCatalog();
    const access = yield* Layer.build(accessRuntime(coreDatabase, spiceDb));
    const { adapter, executor: authDatabase } = yield* acquireOutlivingCleanup(
      makeAuthDatabase({ connectionString, expectedRole: SHARED_RUNTIME_IDENTITY.role }),
    );
    const authentication = betterAuth({
      baseURL,
      database: adapter,
      emailAndPassword: {
        autoSignIn: false,
        enabled: true,
      },
      secret,
      trustedOrigins: [baseURL, 'http://127.0.0.1:3020'],
    });

    const removeAuthUsers = Effect.fn('removeE2eAuthUsers')(function* removeE2eAuthUsersEffect() {
      const existingUsers = yield* authDatabase
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, e2eCredentials.email));
      yield* Effect.all(
        existingUsers.map((existingUser) =>
          Effect.gen(function* removeExistingAuthUser() {
            yield* authDatabase.delete(session).where(eq(session.userId, existingUser.id));
            yield* authDatabase.delete(account).where(eq(account.userId, existingUser.id));
            yield* authDatabase.delete(user).where(eq(user.id, existingUser.id));
          }),
        ),
        { concurrency: 'unbounded', discard: true },
      );
    });

    yield* Effect.addFinalizer(() => removeAuthUsers().pipe(Effect.orDie));
    const createdUser = yield* Effect.tryPromise(
      async () =>
        await authentication.api.signUpEmail({
          body: {
            email: e2eCredentials.email,
            name: 'E2E user',
            password: e2eCredentials.password,
          },
        }),
    ).pipe(Effect.uninterruptible);
    yield* coreDatabase.insert(tenants).values([
      {
        defaultLocale: 'en',
        name: e2eTenants.first.name,
        slug: `e2e-alpha-${fixtureId}`,
        status: 'active',
        tenantId: e2eTenants.first.tenantId,
      },
      {
        defaultLocale: 'en',
        name: e2eTenants.second.name,
        slug: `e2e-zeta-${fixtureId}`,
        status: 'active',
        tenantId: e2eTenants.second.tenantId,
      },
    ]);
    yield* coreDatabase.insert(principals).values([
      {
        displayName: 'E2E user',
        kind: 'human',
        principalId: e2eTenants.first.principalId,
        status: 'active',
        tenantId: e2eTenants.first.tenantId,
      },
      {
        displayName: 'E2E user second tenant',
        kind: 'human',
        principalId: e2eTenants.second.principalId,
        status: 'active',
        tenantId: e2eTenants.second.tenantId,
      },
    ]);
    yield* coreDatabase.insert(legalEntities).values([
      {
        legalEntityId: e2eTenants.first.legalEntityId,
        legalName: 'E2E Alpha company',
        registrationCountry: 'CZ',
        registrationNumber: 'E2E-ALPHA',
        status: 'active',
        tenantId: e2eTenants.first.tenantId,
      },
      {
        legalEntityId: e2eTenants.second.legalEntityId,
        legalName: 'E2E Zeta company',
        registrationCountry: 'CZ',
        registrationNumber: 'E2E-ZETA',
        status: 'active',
        tenantId: e2eTenants.second.tenantId,
      },
    ]);
    yield* coreDatabase.insert(principalAuthBindings).values([
      {
        authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        principalId: e2eTenants.first.principalId,
        provider: 'better_auth',
        providerSubjectId: createdUser.user.id,
        status: 'active',
        subjectType: 'user',
        tenantId: e2eTenants.first.tenantId,
      },
      {
        authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
        principalId: e2eTenants.second.principalId,
        provider: 'better_auth',
        providerSubjectId: createdUser.user.id,
        status: 'active',
        subjectType: 'user',
        tenantId: e2eTenants.second.tenantId,
      },
    ]);
    // The tenant installs Party Registry and the Shell's own administration next to Core's modules; only
    // installed modules enter the release the owner's role is compiled from.
    const installedModuleKeys = installedModuleKeysOf([contactsModuleId, shellAppModuleId], catalog);
    yield* coreDatabase
      .insert(tenantModuleStates)
      .values(
        Object.values(e2eTenants).flatMap(({ tenantId }) =>
          installedModuleKeys.map((moduleKey) => ({ moduleKey, state: 'active' as const, tenantId })),
        ),
      );
    yield* Effect.addFinalizer(() =>
      Effect.forEach(Object.values(e2eTenants), (tenant) => retireTenant(coreDatabase, tenant), {
        discard: true,
      }).pipe(Effect.provideContext(access), Effect.orDie),
    );
    const bootstrap = Context.get(access, TenantAccessBootstrap);
    const bootstrapE2eTenant = (tenant: FixtureTenant) =>
      Effect.gen(function* bootstrapE2eTenantAccess() {
        return yield* bootstrap.bootstrapTenantAccess({
          legalEntityIds: [LegalEntityIdSchema.make(tenant.legalEntityId)],
          modules: catalog,
          scope: yield* ownerScopeOf(tenant),
        });
      });
    const firstTenantAccess = yield* bootstrapE2eTenant(e2eTenants.first);
    yield* bootstrapE2eTenant(e2eTenants.second);
    // v2 has no per-module accessor tuple to delete: the first owner's authority is its role
    // assignments. One scoped browser step revokes exactly those, assigns the same scopes a role of
    // every owner cell except Party Registry's, and reconciles, so only Contacts is refused while the
    // Shell keeps working. On release that role is revoked, the original roles are granted again as new
    // assignments (a revoked assignment is never reopened) and the tenant is reconciled once more. No
    // arbitrary target or grant can be supplied.
    const firstTenant = e2eTenants.first;
    const firstTenantId = TenantIdSchema.make(firstTenant.tenantId);
    const firstOwnerId = PrincipalIdSchema.make(firstTenant.principalId);
    const accessChanges = Context.get(access, AccessChangesStore);
    const inFirstTenantScope = <Value, Failure>(
      body: (transaction: CoreTransaction) => Effect.Effect<Value, Failure>,
    ) =>
      Effect.gen(function* runInFirstTenantScope() {
        const scope = yield* ownerScopeOf(firstTenant);
        return yield* coreDatabase.transaction((transaction) =>
          installOperationalScope(transaction, scope, SHELL_DATABASE_IDENTITY_ENROLLMENT).pipe(
            Effect.andThen(body(transaction)),
          ),
        );
      });
    const reconcileFirstTenant = Effect.gen(function* reconcileFirstE2eTenant() {
      const writer = yield* AccessProjectionWriter;
      yield* writer.reconcileTenant({ scope: yield* ownerScopeOf(firstTenant) });
    }).pipe(Effect.provideContext(access));
    const restoreFirstTenantAccess = (revoked: readonly AccessAssignment[], narrowed: readonly AccessAssignment[]) =>
      Effect.gen(function* restoreOwnedFirstTenantAccess() {
        if (revoked.length === 0) {
          return;
        }
        const restoredAt = yield* DateTime.nowAsDate;
        const regranted: NewAccessAssignment[] = [];
        for (const assignment of revoked) {
          const incarnationId = yield* crypto.randomUUIDv4();
          regranted.push({ ...assignment, incarnationId, status: 'active' as const, validFrom: restoredAt });
        }
        yield* inFirstTenantScope((transaction) =>
          swapBackAssignments(transaction, { narrowed, regranted, tenantId: firstTenant.tenantId }),
        );
        yield* reconcileFirstTenant;
      });
    // Every cell the owner was bootstrapped with except Party Registry's, as one role of its own.
    const recordAccessWithoutContacts = Effect.gen(function* recordFirstOwnerAccessWithoutContacts() {
      const [roleUuid, roleRevisionUuid, recordedAt] = yield* Effect.all([
        crypto.randomUUIDv4(),
        crypto.randomUUIDv4(),
        DateTime.nowAsDate,
      ]);
      const roleId = RoleIdSchema.make(roleUuid);
      const roleRevisionId = RoleRevisionIdSchema.make(roleRevisionUuid);
      const cells = firstTenantAccess.cells.filter((cell) => !cell.capabilityKey.startsWith(`${contactsModuleId}.`));
      yield* accessChanges.recordRole({
        revision: {
          catalogSnapshotId: firstTenantAccess.catalogSnapshotId,
          cells,
          createdAt: recordedAt,
          createdBy: firstOwnerId,
          id: roleRevisionId,
          provenance: 'manual',
          revision: 1,
          roleId,
          tenantId: firstTenantId,
        },
        role: {
          createdAt: recordedAt,
          createdBy: firstOwnerId,
          id: roleId,
          name: 'E2E access without Party Registry',
          tenantId: firstTenantId,
        },
        scope: yield* ownerScopeOf(firstTenant),
      });
      return { cells, recordedAt, roleId, roleRevisionId };
    });
    const acquireFirstTenantContactsAccessRevocation = () =>
      Effect.gen(function* revokeOwnedFirstTenantContactsAccess() {
        const revoked: AccessAssignment[] = [];
        const narrowed: AccessAssignment[] = [];
        // Restore even when the revocation is indeterminate or the browser test fails.
        yield* Effect.addFinalizer(() => restoreFirstTenantAccess(revoked, narrowed).pipe(Effect.orDie));
        revoked.push(
          ...(yield* inFirstTenantScope((transaction) =>
            transaction
              .update(accessAssignments)
              .set({ status: 'revoked' })
              .where(
                and(
                  eq(accessAssignments.tenantId, firstTenant.tenantId),
                  eq(accessAssignments.principalId, firstTenant.principalId),
                  eq(accessAssignments.status, 'active'),
                ),
              )
              .returning(),
          )),
        );
        if (revoked.length === 0) {
          return yield* new E2eAuthorizationFixtureError({
            reason: 'The first Tenant owner holds no active assignment to revoke',
          });
        }
        const { cells, recordedAt, roleId, roleRevisionId } = yield* recordAccessWithoutContacts;
        const scopeIds = [...new Set(revoked.map(({ scopeId }) => scopeId))].map((scopeId) =>
          AccessScopeIdSchema.make(scopeId),
        );
        const replacements: NewAccessAssignment[] = [];
        for (const assignment of revoked) {
          const incarnationId = yield* crypto.randomUUIDv4();
          replacements.push({
            ...assignment,
            incarnationId,
            roleId,
            roleRevisionId,
            status: 'active' as const,
            validFrom: recordedAt,
          });
        }
        narrowed.push(
          ...(yield* inFirstTenantScope((transaction) =>
            assignNarrowedAccess(transaction, {
              cells,
              replacements,
              roleId,
              roleRevisionId,
              scopeIds,
              tenantId: firstTenantId,
            }),
          )),
        );
        return yield* reconcileFirstTenant;
      });
    return { acquireFirstTenantContactsAccessRevocation, credentials: e2eCredentials, tenants: e2eTenants };
  },
  Effect.provide(Layer.mergeAll(NodeCrypto.layer, NodeServices.layer)),
);

export type AuthenticationFixture = Effect.Success<ReturnType<typeof createAuthenticationFixture>>;
