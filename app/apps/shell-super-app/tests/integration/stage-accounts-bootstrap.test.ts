import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { SHARED_RUNTIME_IDENTITY, configureDatabasePool, loadDatabaseConnectionPair } from '@app/core-runtime';
import type { DatabaseConnectionPair } from '@app/core-runtime';
import { loadSpiceDbConfig } from '@app/core-runtime/access/spicedb-config';
import type { SpiceDbConfigValue } from '@app/core-runtime/access/spicedb-config';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { CoreDatabase } from '@app/core-runtime/db/client';
import { STAGE_RETIREMENT_REASON } from '@app/core-runtime/install/stage-context-bootstrap';
import { STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY } from '@app/core-runtime/install/stage-accounts-file';
import { randomUUID } from 'node:crypto';

import { memoryAdapter } from 'better-auth/adapters/memory';
import { verifyPassword } from 'better-auth/crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  Cause,
  ConfigProvider,
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Redacted,
  Ref,
  Stdio,
} from 'effect';
import { describe, expect, it, rstest } from 'effect-rstest';

import { loadAuthConfig } from '../../api/auth/config.ts';
import { AuthDatabase, makeAuthDatabase } from '../../api/auth/db/client.ts';
import { OAuthCredentialsLive } from '../../api/auth/db/oauth-credentials-live.ts';
import {
  account,
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  session,
  user,
} from '../../api/auth/db/schema.ts';
import type { AuthDatabaseExecutor } from '../../api/auth/db/types.ts';
import {
  parseStageAccountsBootstrapConfig,
  stageAccountsDryRunLines,
  stageAccountsFailureLine,
  stageDepartureLine,
} from '../../api/auth/stage-accounts-bootstrap-contract.ts';
import type {
  StageAccountsBootstrapConfig,
  StageAccountsBootstrapError,
  StageAccountsExecution,
} from '../../api/auth/stage-accounts-bootstrap-contract.ts';
import {
  bootstrapStageAccounts,
  ensureStageAccountAuthUser,
  rehearseStageAccounts,
} from '../../api/auth/stage-accounts-bootstrap-runtime-infrastructure.ts';
import { evaluateLiveChecks } from '../../api/oauth-connections/connection-service.ts';
import { loadUserAccount } from '../../api/oauth-connections/grant-store.ts';
import {
  makeStageAccountsAuthDatabase,
  makeStageAccountsCommand,
  makeStageAccountsRuntime,
  stageAccessModules,
} from '../../scripts/bootstrap-stage-accounts.mts';
import { newSpiceDbGrpcClient } from '../../../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../../../packages/core-runtime/src/permissions/schema.ts';

/**
 * The stage container's own pool setting (`ONTOS_DATABASE_POOL_SHARED: 'true'` in app/zerops.yaml). Every case that
 * builds the operator composition runs under it, so CI builds the composition in the environment the operator runs it
 * in, where only the composition's own rule keeps its pools private.
 */
const StagePoolSettingLive = ConfigProvider.layerAdd(
  ConfigProvider.fromEnvRecord({ ONTOS_DATABASE_POOL_SHARED: 'true' }),
  {
    asPrimary: true,
  },
);

/** An operator accounts file as JSON, before the operator command's own parser decodes it. */
interface OperatorFile {
  readonly attachedLogins?: readonly {
    readonly authBindingId: string;
    readonly displayName: string;
    readonly email: string;
    readonly principalId: string;
    readonly tenantId: string;
  }[];
  readonly retiredAccountEmails: readonly string[];
  readonly retiredPrincipals?: readonly {
    readonly email: string;
    readonly principalId: string;
    readonly tenantId: string;
  }[];
  readonly retiredTenants: readonly never[];
  readonly tenants: readonly unknown[];
}

const byGrant = (left: { readonly grant: string }, right: { readonly grant: string }) =>
  left.grant < right.grant ? -1 : 1;

/** The integration engine starts from exactly the schema Core serves, as every suite that projects does. */
const writeEngineSchema = (configuration: SpiceDbConfigValue) =>
  Effect.acquireUseRelease(
    Effect.sync(() => newSpiceDbGrpcClient(configuration)),
    (client) =>
      Effect.tryPromise(
        async () => await client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })),
      ).pipe(Effect.orDie),
    (client) => Effect.sync(() => client.close()),
  );

/** The operator file as the operator command parses it, read with the integration environment's own values. */
const operatorConfigurationOf =
  (environment: {
    readonly authConfiguration: { readonly baseUrl: string; readonly secret: string };
    readonly connections: DatabaseConnectionPair;
    readonly declaredWorkloadKeys: ReadonlySet<string>;
  }) =>
  (file: OperatorFile) =>
    parseStageAccountsBootstrapConfig(
      {
        BETTER_AUTH_SECRET: environment.authConfiguration.secret,
        BETTER_AUTH_URL: environment.authConfiguration.baseUrl,
        DATABASE_ADMIN_URL: environment.connections.admin.connectionString,
        [STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY]: '/operator/stage-accounts.json',
        ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
      },
      () => Effect.succeed({ mode: 0o600, source: JSON.stringify({ schemaVersion: 2, ...file }) }),
      environment.declaredWorkloadKeys,
    );

/**
 * Deletes the Better Auth logins a case created, with their sessions, credentials, tokens and consent, and the OAuth
 * client it registered. Core's rows of the case's random tenants stay: their governed history cannot be deleted.
 */
const deleteLogins = (auth: AuthDatabaseExecutor, emails: readonly string[], clientId: string) =>
  Effect.gen(function* deleteCaseLogins() {
    const users = yield* auth
      .select({ id: user.id })
      .from(user)
      .where(inArray(user.email, [...emails]));
    const userIds = users.map(({ id }) => id);
    if (userIds.length > 0) {
      yield* auth.delete(oauthAccessToken).where(inArray(oauthAccessToken.userId, userIds));
      yield* auth.delete(oauthRefreshToken).where(inArray(oauthRefreshToken.userId, userIds));
      yield* auth.delete(oauthConsent).where(inArray(oauthConsent.userId, userIds));
      yield* auth.delete(session).where(inArray(session.userId, userIds));
      yield* auth.delete(account).where(inArray(account.userId, userIds));
      yield* auth.delete(user).where(inArray(user.id, userIds));
    }
    yield* auth.delete(oauthClient).where(eq(oauthClient.clientId, clientId));
  }).pipe(Effect.orDie);

/** One stage tenant of an operator file: its company and its accounts, an owner or a holder of "Plný přístup". */
const stageTenantOf = (
  tenantId: string,
  legalEntityId: string,
  accounts: readonly {
    readonly displayName: string;
    readonly email: string;
    readonly owner: boolean;
    readonly principalId: string;
  }[],
) => ({
  accounts: accounts.map(({ displayName, email, owner, principalId }) => ({
    authBindingId: randomUUID(),
    displayName,
    email,
    grants: owner ? { owner: true, roles: [] } : { owner: false, roles: ['full_access'] },
    password: randomUUID(),
    principalId,
  })),
  defaultLocale: 'cs',
  displayName: `Stage dry run ${tenantId}`,
  legalEntity: {
    legalEntityId,
    legalName: `Stage dry run ${tenantId} s.r.o.`,
    registrationCountry: 'CZ',
    registrationNumber: tenantId,
  },
  moduleKey: 'party.registry',
  moduleStateId: randomUUID(),
  slug: `stage-dry-${tenantId}`,
  tenantId,
});

/**
 * One connected app of a person as the product leaves it, with a refresh token, an access token and a consent: a live
 * one is `active` on its grant and its `oauth_grant` binding; a disconnected one is a grant the person revoked, whose
 * binding the product only disabled.
 */
const seedAppConnection = (
  auth: AuthDatabaseExecutor,
  connection: {
    readonly app: { readonly binding: string; readonly grant: string; readonly name: string };
    readonly clientId: string;
    readonly company: string;
    readonly person: string;
    readonly tenantId: string;
    readonly userId: string;
  },
  ending: { readonly by: string; readonly reason: 'user' } | null,
) =>
  Effect.gen(function* seedConnectedApp() {
    const { app, clientId, company, person, tenantId, userId } = connection;
    yield* auth.execute(
      sql`insert into core.oauth_connection_grants
            (grant_id, tenant_id, legal_entity_id, user_id, user_principal_id, acting_principal_id, acting_kind,
             client_id, client_name, client_host, client_kind, modules_json, write_policy, profile_id,
             auth_binding_id, status, consented_at, last_used_at, revoked_at, revoked_by_principal_id, revoke_reason)
          values (${app.grant}, ${tenantId}, ${company}, ${userId}, ${person}, ${person}, 'human',
                  ${clientId}, ${app.name}, ${new URL(clientId).host}, 'cimd', '"all"'::jsonb, 'direct',
                  gen_random_uuid(), ${app.binding}, ${ending === null ? 'active' : 'revoked'},
                  now() - interval '10 days', now() - interval '1 day',
                  ${ending === null ? null : sql`now() - interval '2 days'`}, ${ending?.by ?? null},
                  ${ending?.reason ?? null})`,
    );
    yield* auth.execute(
      sql`insert into core.principal_auth_bindings
            (principal_auth_binding_id, tenant_id, principal_id, authentication_namespace_id, provider,
             subject_type, provider_subject_id, status)
          values (${app.binding}, ${tenantId}, ${person}, ${STAFF_AUTHENTICATION_NAMESPACE_ID}, 'better_auth',
                  'oauth_grant', ${app.grant}, ${ending === null ? 'active' : 'disabled'})`,
    );
    const refreshId = randomUUID();
    const scopes = ['openid'];
    yield* auth
      .insert(oauthRefreshToken)
      .values({ clientId, id: refreshId, referenceId: app.grant, scopes, token: randomUUID(), userId });
    yield* auth
      .insert(oauthAccessToken)
      .values({ clientId, id: randomUUID(), referenceId: app.grant, refreshId, scopes, token: randomUUID(), userId });
    yield* auth.insert(oauthConsent).values({ clientId, id: randomUUID(), referenceId: app.grant, scopes, userId });
  });

/** Every Core table the stage run writes, each read whole for the tenants a case names. */
const STAGE_RUN_TABLES = [
  'principals',
  'principal_auth_bindings',
  'oauth_connection_grants',
  'access_memberships',
  'access_assignments',
  'access_delegations',
  'access_team_members',
  'access_agent_connections',
  'principal_company_memberships',
  'audit_events',
] as const;

/**
 * Every row the stage run writes for two tenants and one login, as one comparable picture: each Core table of the
 * tenants, and the login's Better Auth user, credential, sessions, tokens and consent.
 */
const stageRunRowsOf = (
  auth: AuthDatabaseExecutor,
  scope: { readonly emails: readonly string[]; readonly tenantIds: readonly [string, string]; readonly userId: string },
) =>
  Effect.all(
    {
      accessTokens: auth
        .select()
        .from(oauthAccessToken)
        .where(eq(oauthAccessToken.userId, scope.userId))
        .orderBy(oauthAccessToken.id),
      accounts: auth.select().from(account).where(eq(account.userId, scope.userId)).orderBy(account.id),
      consents: auth.select().from(oauthConsent).where(eq(oauthConsent.userId, scope.userId)).orderBy(oauthConsent.id),
      core: Effect.forEach(
        STAGE_RUN_TABLES,
        (table) =>
          auth.execute<{ readonly entry: unknown }>(
            sql`select to_jsonb(t) as entry from ${sql.identifier('core')}.${sql.identifier(table)} t
                  where t.tenant_id in (${scope.tenantIds[0]}, ${scope.tenantIds[1]}) order by 1`,
            'objects',
          ),
        { concurrency: 1 },
      ),
      refreshTokens: auth
        .select()
        .from(oauthRefreshToken)
        .where(eq(oauthRefreshToken.userId, scope.userId))
        .orderBy(oauthRefreshToken.id),
      sessions: auth.select().from(session).where(eq(session.userId, scope.userId)).orderBy(session.id),
      users: auth
        .select()
        .from(user)
        .where(inArray(user.email, [...scope.emails]))
        .orderBy(user.id),
    },
    { concurrency: 1 },
  );

/** One kind of run of an operator file, through the operator composition a case built. */
const runOperatorFile =
  <Value, Failure, Requirements, Services>(
    configurationOf: (file: OperatorFile) => Effect.Effect<StageAccountsBootstrapConfig, StageAccountsBootstrapError>,
    context: Context.Context<Services>,
    kind: (configuration: StageAccountsBootstrapConfig) => Effect.Effect<Value, Failure, Requirements>,
  ) =>
  (file: OperatorFile) =>
    configurationOf(file).pipe(Effect.flatMap(kind), Effect.provide(context));

/** A count a case read per table, by the table's name. */
const countOf = (rows: readonly { readonly count: number; readonly table: string }[], table: string) =>
  rows.find((row) => row.table === table)?.count ?? -1;

/** Bindings in one order, by provider, subject and status. */
const byBinding = (
  left: { readonly provider: string; readonly status: string; readonly subjectType: string },
  right: { readonly provider: string; readonly status: string; readonly subjectType: string },
) =>
  `${left.provider}/${left.subjectType}/${left.status}`.localeCompare(
    `${right.provider}/${right.subjectType}/${right.status}`,
  );

/** When a connected app was last used, as the dry run prints it. */
const lastUseOf = (app: { readonly lastUsedAt: Date | null } | undefined) => app?.lastUsedAt?.toISOString() ?? 'never';

describe('stage-accounts-bootstrap', () => {
  it.live(
    'replaces an unreadable account password and revokes its sessions through the explicit operator identity',
    () =>
      Effect.scoped(
        Effect.gen(function* replacesPassword() {
          const baseConfiguration = yield* loadAuthConfig();
          const connections = yield* loadDatabaseConnectionPair();
          // The Better Auth store exactly as the operator command composes it.
          const context = yield* Layer.build(
            OAuthCredentialsLive.pipe(Layer.provideMerge(makeStageAccountsAuthDatabase(connections))),
          );
          const persistence = Context.get(context, AuthDatabase);
          const database = persistence.executor;
          const identity = yield* database.execute<{ role: string }>(sql`select session_user::text as role`, 'objects');
          expect(identity[0]?.role).toBe(connections.admin.user);
          expect(identity[0]?.role).not.toBe(connections.runtime.user);
          const email = `stage-password-reset-${randomUUID()}@example.test`;
          const initialPassword = `initial-${randomUUID()}`;
          const replacementPassword = `replacement-${randomUUID()}`;
          const configuration = {
            accounts: [{ displayName: 'Password reset fixture', email, password: Redacted.make(initialPassword) }],
            authBaseUrl: baseConfiguration.baseUrl,
            authSecret: baseConfiguration.secret,
          } as const;
          const cleanup = Effect.gen(function* cleanupPasswordFixture() {
            const users = yield* database.select({ id: user.id }).from(user).where(eq(user.email, email));
            for (const existingUser of users) {
              yield* database.delete(session).where(eq(session.userId, existingUser.id));
              yield* database.delete(account).where(eq(account.userId, existingUser.id));
              yield* database.delete(user).where(eq(user.id, existingUser.id));
            }
          }).pipe(Effect.orDie);
          yield* cleanup;
          yield* Effect.addFinalizer(() => cleanup);
          const created = yield* ensureStageAccountAuthUser(configuration, configuration.accounts[0]).pipe(
            Effect.provideService(AuthDatabase, persistence),
          );
          yield* database.update(user).set({ emailVerified: false }).where(eq(user.id, created.userId));
          yield* database.update(account).set({ password: randomUUID() }).where(eq(account.userId, created.userId));
          const sessionCreatedAt = yield* DateTime.nowAsDate;
          const sessionExpiresAt = DateTime.makeUnsafe(sessionCreatedAt).pipe(
            DateTime.add({ minutes: 1 }),
            DateTime.toDateUtc,
          );
          yield* database.insert(session).values({
            createdAt: sessionCreatedAt,
            expiresAt: sessionExpiresAt,
            id: randomUUID(),
            token: randomUUID(),
            updatedAt: sessionCreatedAt,
            userId: created.userId,
          });
          const replaced = yield* ensureStageAccountAuthUser(configuration, {
            ...configuration.accounts[0],
            password: Redacted.make(replacementPassword),
          }).pipe(Effect.provideService(AuthDatabase, persistence));
          expect(replaced).toEqual({
            status: 'password-reset',
            userId: created.userId,
          });
          const [credential] = yield* database
            .select({ password: account.password })
            .from(account)
            .where(eq(account.userId, created.userId));
          expect(credential?.password).toBeDefined();
          const replacementMatches = yield* Effect.promise(() =>
            verifyPassword({
              hash: credential?.password ?? '',
              password: replacementPassword,
            }),
          );
          const initialMatches = yield* Effect.promise(() =>
            verifyPassword({
              hash: credential?.password ?? '',
              password: initialPassword,
            }),
          );
          expect(replacementMatches).toBe(true);
          expect(initialMatches).toBe(false);
          const restoredUser = yield* loadUserAccount(created.userId).pipe(Effect.provide(context));
          expect(restoredUser?.emailVerified).toBe(true);
          const remainingSessions = yield* database
            .select({ id: session.id })
            .from(session)
            .where(eq(session.userId, created.userId));
          expect(remainingSessions).toHaveLength(0);
        }),
      ).pipe(Effect.provide(StagePoolSettingLive)),
  );

  it.live('verifies only exact operator accounts and repairs their live OAuth eligibility idempotently', () =>
    Effect.scoped(
      Effect.gen(function* verifiesOperatorAccount() {
        const configuration = yield* loadAuthConfig();
        const connections = yield* loadDatabaseConnectionPair();
        // The Better Auth store exactly as the operator command composes it.
        const context = yield* Layer.build(
          OAuthCredentialsLive.pipe(Layer.provideMerge(makeStageAccountsAuthDatabase(connections))),
        );
        const persistence = Context.get(context, AuthDatabase);
        const database = persistence.executor;
        const operator = {
          displayName: 'Operator verification',
          email: `stage-operator-${randomUUID()}@example.test`,
          password: Redacted.make(randomUUID()),
        };
        const ordinaryEmail = `ordinary-user-${randomUUID()}@example.test`;
        yield* Effect.addFinalizer(() =>
          database
            .delete(user)
            .where(inArray(user.email, [operator.email, ordinaryEmail]))
            .pipe(Effect.orDie),
        );
        yield* database.insert(user).values({
          email: ordinaryEmail,
          emailVerified: false,
          id: randomUUID(),
          name: 'Not in the operator file',
        });
        const authConfiguration = { authBaseUrl: configuration.baseUrl, authSecret: configuration.secret };
        const created = yield* ensureStageAccountAuthUser(authConfiguration, operator).pipe(
          Effect.provideService(AuthDatabase, persistence),
        );
        expect(created.status).toBe('created');
        const createdUser = yield* loadUserAccount(created.userId).pipe(Effect.provide(context));
        expect(createdUser?.emailVerified).toBe(true);

        yield* database.update(user).set({ emailVerified: false }).where(eq(user.id, created.userId));
        const conflict = yield* Effect.flip(
          ensureStageAccountAuthUser(authConfiguration, { ...operator, displayName: 'Conflicting identity' }).pipe(
            Effect.provideService(AuthDatabase, persistence),
          ),
        );
        expect(conflict.code).toBe('stage_accounts_conflict');
        const conflictedUser = yield* loadUserAccount(created.userId).pipe(Effect.provide(context));
        expect(conflictedUser?.emailVerified).toBe(false);

        const repaired = yield* ensureStageAccountAuthUser(authConfiguration, operator).pipe(
          Effect.provideService(AuthDatabase, persistence),
        );
        expect(repaired).toEqual({ status: 'existing', userId: created.userId });
        const liveUser = yield* loadUserAccount(created.userId).pipe(Effect.provide(context));
        expect(liveUser?.emailVerified).toBe(true);
        expect(
          evaluateLiveChecks({
            actingKind: 'human',
            actingPrincipalStatus: 'active',
            agentInCompany: true,
            bindingStatus: 'active',
            connectionLive: true,
            grantStatus: 'active',
            hasCompanyAccess: true,
            operatorHolds: true,
            userBanned: liveUser?.banned ?? true,
            userEmailVerified: liveUser?.emailVerified ?? false,
            userExists: liveUser !== undefined,
            userPrincipalStatus: 'active',
          }),
        ).toEqual({ ok: true });
        const [beforeRepeat] = yield* database.select().from(user).where(eq(user.id, created.userId));
        yield* ensureStageAccountAuthUser(authConfiguration, operator).pipe(
          Effect.provideService(AuthDatabase, persistence),
        );
        const [afterRepeat] = yield* database.select().from(user).where(eq(user.id, created.userId));
        expect(afterRepeat).toEqual(beforeRepeat);
        const [ordinary] = yield* database.select().from(user).where(eq(user.email, ordinaryEmail));
        expect(ordinary?.emailVerified).toBe(false);
      }),
    ).pipe(Effect.provide(StagePoolSettingLive)),
  );

  it.live(
    'stage bootstrap waits for non-cancellable SDK writes before closing its database scope',
    () =>
      Effect.gen(function* waitsForSdkSettlement() {
        const store = { account: [], session: [], user: [], verification: [] };
        const sdkStarted = Deferred.makeUnsafe<null>();
        const sdkSettlement = Promise.withResolvers<null>();
        const sdkAdapter = memoryAdapter(store);
        // The SDK's user write starts, then waits for the test. Better Auth 1.7.23 writes through the adapter a
        // transaction hands its work, earlier versions through the adapter itself, so both are delayed.
        const delayUserCreate = (target: Pick<ReturnType<typeof sdkAdapter>, 'create'>) => {
          const create = target.create.bind(target);
          rstest.spyOn(target, 'create').mockImplementation((input: Parameters<typeof create>[0]) => {
            if (input.model === 'user') {
              Deferred.doneUnsafe(sdkStarted, Effect.succeed(null));
              return sdkSettlement.promise.then(() => create(input));
            }
            return create(input);
          });
        };
        type TransactionWork = Parameters<ReturnType<typeof sdkAdapter>['transaction']>[0];
        const delayedWork =
          (work: TransactionWork): TransactionWork =>
          async (transactionAdapter) => {
            delayUserCreate(transactionAdapter);
            return await work(transactionAdapter);
          };
        const delayTransactionUserCreate = (adapter: ReturnType<typeof sdkAdapter>) => {
          const transaction = adapter.transaction.bind(adapter);
          rstest
            .spyOn(adapter, 'transaction')
            .mockImplementation(async (work: TransactionWork) => await transaction(delayedWork(work)));
        };
        let databaseClosed = false;
        const configuration = yield* loadAuthConfig();
        const program = Effect.scoped(
          Effect.gen(function* bootstrapWithDelayedSdk() {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                databaseClosed = true;
              }),
            );
            const database = yield* makeAuthDatabase({ ...configuration, expectedRole: SHARED_RUNTIME_IDENTITY.role });
            return yield* ensureStageAccountAuthUser(
              { authBaseUrl: configuration.baseUrl, authSecret: configuration.secret },
              {
                displayName: 'First',
                email: `stage-first-${randomUUID()}@example.test`,
                password: Redacted.make(randomUUID()),
              },
            ).pipe(
              Effect.provideService(AuthDatabase, {
                adapter: (options) => {
                  const adapter = sdkAdapter(options);
                  delayUserCreate(adapter);
                  delayTransactionUserCreate(adapter);
                  return adapter;
                },
                executor: database.executor,
              }),
            );
          }),
        );
        const outcome = yield* Effect.gen(function* interruptPendingBootstrap() {
          const bootstrap = yield* program.pipe(Effect.forkChild);
          yield* Deferred.await(sdkStarted).pipe(Effect.raceFirst(Fiber.join(bootstrap)));
          const interruption = yield* Fiber.interrupt(bootstrap).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          const pending = bootstrap.pollUnsafe() === undefined;
          const closedBeforeSettlement = databaseClosed;
          sdkSettlement.resolve(null);
          yield* Fiber.join(interruption);
          return {
            closedBeforeSettlement,
            exit: yield* Fiber.await(bootstrap),
            pending,
          };
        }).pipe(Effect.ensuring(Effect.sync(() => sdkSettlement.resolve(null))));
        expect(outcome.pending).toBe(true);
        expect(outcome.closedBeforeSettlement).toBe(false);
        expect(Exit.isFailure(outcome.exit)).toBe(true);
        if (Exit.isFailure(outcome.exit)) {
          expect(Cause.hasInterrupts(outcome.exit.cause)).toBe(true);
        }
        expect(databaseClosed).toBe(true);
        expect(store.user).toHaveLength(1);
        expect(store.account).toHaveLength(1);
      }),
    10_000,
  );
  it.live(
    'runs through the operator composition: Better Auth as the administrative login, Core as the runtime login, one revocation event for the app the run ends, every ended app finished by grant id, and a replay that changes nothing',
    () =>
      Effect.scoped(
        Effect.gen(function* runsThroughTheOperatorComposition() {
          const authConfiguration = yield* loadAuthConfig();
          const connections = yield* loadDatabaseConnectionPair();
          const spiceDb = yield* loadSpiceDbConfig();
          yield* writeEngineSchema(spiceDb);
          // The environment says what the stage container says: pools shared through a host registry this test has not.
          expect(
            (yield* configureDatabasePool(Redacted.make(connections.runtime.connectionString))).processShared,
          ).toBe(true);
          // The very graph the operator command builds, from the integration environment's two URLs: no client of the
          // run is constructed here, and it builds on private pools all the same.
          const context = yield* Layer.build(
            makeStageAccountsRuntime({ databases: connections, spiceDb: Redacted.make(spiceDb) }),
          );
          const auth = Context.get(context, AuthDatabase).executor;
          const core = Context.get(context, CoreDatabase).executor;
          const sessionRole = sql`select session_user::text as role`;
          expect(yield* auth.execute<{ readonly role: string }>(sessionRole, 'objects')).toEqual([
            { role: connections.admin.user },
          ]);
          expect(yield* core.execute<{ readonly role: string }>(sessionRole, 'objects')).toEqual([
            { role: connections.runtime.user },
          ]);
          const { declaredWorkloadKeys, modules } = yield* stageAccessModules;
          const tenantId = randomUUID();
          const legalEntityId = randomUUID();
          const owner = randomUUID();
          const leaver = randomUUID();
          const ownerEmail = `stage-run-owner-${tenantId}@example.test`;
          const leaverEmail = `stage-run-leaver-${tenantId}@example.test`;
          const clientId = `https://stage-run-${tenantId}.example/metadata`;
          const configurationOf = operatorConfigurationOf({ authConfiguration, connections, declaredWorkloadKeys });
          const run = runOperatorFile(configurationOf, context, (configuration) =>
            bootstrapStageAccounts(configuration, { modules }),
          );
          const cleanup = deleteLogins(auth, [ownerEmail, leaverEmail], clientId);
          yield* Effect.addFinalizer(() => cleanup);
          // The tenant, created by the operator file itself: its owner and the person who will leave it.
          const created = yield* run({
            retiredAccountEmails: [],
            retiredTenants: [],
            tenants: [
              {
                accounts: [
                  {
                    authBindingId: randomUUID(),
                    displayName: 'Stage run owner',
                    email: ownerEmail,
                    grants: { owner: true, roles: [] },
                    password: randomUUID(),
                    principalId: owner,
                  },
                  {
                    authBindingId: randomUUID(),
                    displayName: 'Stage run leaver',
                    email: leaverEmail,
                    grants: { owner: false, roles: ['full_access'] },
                    password: randomUUID(),
                    principalId: leaver,
                  },
                ],
                defaultLocale: 'cs',
                displayName: 'Stage run fixture',
                legalEntity: {
                  legalEntityId,
                  legalName: 'Stage run s.r.o.',
                  registrationCountry: 'CZ',
                  registrationNumber: tenantId,
                },
                moduleKey: 'party.registry',
                moduleStateId: randomUUID(),
                slug: `stage-run-${tenantId}`,
                tenantId,
              },
            ],
          });
          expect(created.accounts.map(({ authUser, principalId }) => ({ authUser, principalId }))).toEqual([
            { authUser: 'created', principalId: owner },
            { authUser: 'created', principalId: leaver },
          ]);
          const [leaverUser] = yield* auth.select({ id: user.id }).from(user).where(eq(user.email, leaverEmail));
          const leaverUserId = leaverUser?.id ?? '';
          // The leaver's connected apps, as the product leaves them: one they disconnected, one an administrator
          // revoked earlier without any event, one still live, and one still live in a company the owner does not
          // administer. Another grant of the same login (one it holds as another Principal) keeps its tokens.
          const apps = {
            foreign: { binding: randomUUID(), grant: randomUUID(), name: 'Client of an unadministered company' },
            live: { binding: randomUUID(), grant: randomUUID(), name: 'Live client' },
            olderAdmin: { binding: randomUUID(), grant: randomUUID(), name: 'Older administrator revocation' },
            userRevoked: { binding: randomUUID(), grant: randomUUID(), name: 'Disconnected client' },
          };
          const survivingGrant = randomUUID();
          yield* auth.insert(oauthClient).values({ clientId, id: randomUUID(), redirectUris: ['http://127.0.0.1/cb'] });
          const connect = (
            app: { readonly binding: string; readonly grant: string; readonly name: string },
            ending: { readonly by: string; readonly reason: 'admin' | 'user' } | null,
            company = legalEntityId,
          ) =>
            Effect.gen(function* connectApp() {
              yield* auth.execute(
                sql`insert into core.oauth_connection_grants
                      (grant_id, tenant_id, legal_entity_id, user_id, user_principal_id, acting_principal_id, acting_kind,
                       client_id, client_name, client_host, client_kind, modules_json, write_policy, profile_id,
                       auth_binding_id, status, consented_at, last_used_at, revoked_at, revoked_by_principal_id,
                       revoke_reason)
                    values (${app.grant}, ${tenantId}, ${company}, ${leaverUserId}, ${leaver}, ${leaver}, 'human',
                            ${clientId}, ${app.name}, ${new URL(clientId).host}, 'cimd', '"all"'::jsonb, 'direct',
                            gen_random_uuid(), ${app.binding}, ${ending === null ? 'active' : 'revoked'},
                            now() - interval '10 days', now() - interval '1 day',
                            ${ending === null ? null : sql`now() - interval '2 days'`}, ${ending?.by ?? null},
                            ${ending?.reason ?? null})`,
              );
              yield* auth.execute(
                sql`insert into core.principal_auth_bindings
                      (principal_auth_binding_id, tenant_id, principal_id, authentication_namespace_id, provider,
                       subject_type, provider_subject_id, status)
                    values (${app.binding}, ${tenantId}, ${leaver}, ${STAFF_AUTHENTICATION_NAMESPACE_ID}, 'better_auth',
                            'oauth_grant', ${app.grant}, ${ending === null ? 'active' : 'disabled'})`,
              );
            });
          yield* connect(apps.userRevoked, { by: leaver, reason: 'user' });
          yield* connect(apps.olderAdmin, { by: owner, reason: 'admin' });
          yield* connect(apps.live, null);
          // A second company of the tenant that no access scope covers, so the acting owner administers nothing there.
          const unadministered = randomUUID();
          yield* auth.execute(
            sql`insert into core.legal_entities
                  (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status)
                values (${unadministered}, ${tenantId}, 'Unadministered s.r.o.', 'CZ', ${unadministered}, 'active')`,
          );
          yield* connect(apps.foreign, null, unadministered);
          const issue = (grantId: string) =>
            Effect.gen(function* issueGrantTokens() {
              const refreshId = randomUUID();
              const scopes = ['openid'];
              yield* auth.insert(oauthRefreshToken).values({
                clientId,
                id: refreshId,
                referenceId: grantId,
                scopes,
                token: randomUUID(),
                userId: leaverUserId,
              });
              yield* auth.insert(oauthAccessToken).values({
                clientId,
                id: randomUUID(),
                referenceId: grantId,
                refreshId,
                scopes,
                token: randomUUID(),
                userId: leaverUserId,
              });
              yield* auth
                .insert(oauthConsent)
                .values({ clientId, id: randomUUID(), referenceId: grantId, scopes, userId: leaverUserId });
            });
          const leaverGrants = [apps.userRevoked.grant, apps.olderAdmin.grant, apps.live.grant, apps.foreign.grant];
          yield* Effect.forEach([...leaverGrants, survivingGrant], issue, { concurrency: 1, discard: true });
          const tokenCountsOf = (grantId: string) =>
            Effect.all(
              [
                auth
                  .select({ id: oauthAccessToken.id })
                  .from(oauthAccessToken)
                  .where(eq(oauthAccessToken.referenceId, grantId)),
                auth
                  .select({ id: oauthRefreshToken.id })
                  .from(oauthRefreshToken)
                  .where(eq(oauthRefreshToken.referenceId, grantId)),
                auth.select({ id: oauthConsent.id }).from(oauthConsent).where(eq(oauthConsent.referenceId, grantId)),
              ],
              { concurrency: 1 },
            ).pipe(Effect.map((tables) => tables.map((rows) => rows.length)));
          const revocationEvents = auth.execute<{
            readonly auth_method: string;
            readonly company: string;
            readonly evidence: unknown;
            readonly grant: string;
            readonly outcome: string;
            readonly outcome_code: string;
            readonly principal: string;
          }>(
            sql`select target_resource_id as grant, principal_id::text as principal, legal_entity_id::text as company,
                       auth_method, outcome, outcome_code, evidence_json as evidence
                  from core.audit_events where tenant_id = ${tenantId} and event_type = 'oauth.connection.revoked'`,
            'objects',
          );
          const grantRows = auth.execute<{
            readonly grant: string;
            readonly reason: string | null;
            readonly revoked_by: string | null;
            readonly status: string;
          }>(
            sql`select grant_id::text as grant, status, revoke_reason as reason, revoked_by_principal_id::text as revoked_by
                  from core.oauth_connection_grants where tenant_id = ${tenantId}`,
            'objects',
          );
          const retirement = {
            retiredAccountEmails: [],
            retiredPrincipals: [{ email: leaverEmail, principalId: leaver, tenantId }],
            retiredTenants: [],
            tenants: [],
          };
          // The live app in a company the acting owner does not administer refuses the whole file under Core's own
          // code, which reaches the operator's output line, and the move transaction writes nothing.
          const grantsBefore = (yield* grantRows).toSorted(byGrant);
          const refused = yield* run(retirement).pipe(Effect.flip);
          expect(refused.code).toBe('stage_connected_app_not_administered');
          expect(refused.reason).toContain(`${apps.foreign.name} (${clientId})`);
          expect(refused.reason).toContain(`company ${unadministered}`);
          expect(stageAccountsFailureLine(refused)).toBe(
            `Stage accounts bootstrap failed (stage_connected_app_not_administered): ${refused.reason}`,
          );
          expect((yield* grantRows).toSorted(byGrant)).toEqual(grantsBefore);
          expect(yield* revocationEvents).toEqual([]);
          for (const grantId of [...leaverGrants, survivingGrant]) {
            expect(yield* tokenCountsOf(grantId)).toEqual([1, 1, 1]);
          }
          // The person disconnects that app in the product (the grant revoked, its binding only disabled), and the
          // same file then retires them.
          yield* auth.execute(
            sql`update core.oauth_connection_grants
                  set status = 'revoked', revoked_at = now(), revoked_by_principal_id = ${leaver}, revoke_reason = 'user'
                where grant_id = ${apps.foreign.grant}`,
          );
          yield* auth.execute(
            sql`update core.principal_auth_bindings
                  set status = 'disabled', binding_revision = binding_revision + 1, updated_at = now()
                where principal_auth_binding_id = ${apps.foreign.binding}`,
          );
          const retired = yield* run(retirement);
          expect(
            retired.departures.map(({ archives, email, principalId, tenantId: at }) => ({
              archives,
              at,
              email,
              principalId,
            })),
          ).toEqual([{ archives: true, at: tenantId, email: leaverEmail, principalId: leaver }]);
          expect(retired.endedConnectedApps.map(({ grantId, status }) => ({ grantId, status }))).toEqual([
            { grantId: apps.live.grant, status: 'active' },
          ]);
          expect((yield* grantRows).toSorted(byGrant)).toEqual(
            [
              { grant: apps.userRevoked.grant, reason: 'user', revoked_by: leaver, status: 'revoked' },
              { grant: apps.olderAdmin.grant, reason: 'admin', revoked_by: owner, status: 'revoked' },
              { grant: apps.live.grant, reason: 'admin', revoked_by: owner, status: 'revoked' },
              { grant: apps.foreign.grant, reason: 'user', revoked_by: leaver, status: 'revoked' },
            ].toSorted(byGrant),
          );
          // Core recorded exactly the app the run moved from active to revoked, in the run's transaction on the runtime
          // login: the acting owner as actor, reason admin, the bootstrap's note. The two disconnected apps and the older
          // administrator revocation get none.
          const recorded = [
            {
              auth_method: 'session',
              company: legalEntityId,
              evidence: {
                clientId,
                clientName: apps.live.name,
                grantId: apps.live.grant,
                note: STAGE_RETIREMENT_REASON,
                reason: 'admin',
                revokedByPrincipalId: owner,
                userPrincipalId: leaver,
              },
              grant: apps.live.grant,
              outcome: 'succeeded',
              outcome_code: 'admin',
              principal: owner,
            },
          ];
          expect(yield* revocationEvents).toEqual(recorded);
          // After the commit the Shell deleted the tokens and consent of every app of the person, by grant id, and
          // nothing of the login's other grant.
          for (const grantId of leaverGrants) {
            expect(yield* tokenCountsOf(grantId)).toEqual([0, 0, 0]);
          }
          expect(yield* tokenCountsOf(survivingGrant)).toEqual([1, 1, 1]);
          // The same file again ends nothing, so it records nothing, says so, and finds nothing left to delete.
          const replayed = yield* run(retirement);
          expect(replayed.endedConnectedApps).toEqual([]);
          expect(replayed.departures.map((departure) => stageDepartureLine(departure, 'commit'))).toEqual([
            `The Principal of ${leaverEmail} was retired already: tenant=${tenantId} principal=${leaver}; the run wrote nothing of it again`,
          ]);
          expect(yield* revocationEvents).toEqual(recorded);
          for (const grantId of leaverGrants) {
            expect(yield* tokenCountsOf(grantId)).toEqual([0, 0, 0]);
          }
          expect(yield* tokenCountsOf(survivingGrant)).toEqual([1, 1, 1]);
        }).pipe(Effect.provide(NodeServices.layer)),
      ).pipe(Effect.provide(StagePoolSettingLive)),
    180_000,
  );
  it.live(
    'rehearses the AKROS move by default: the real move transaction, rolled back, leaves every table as it was, and the real run then writes exactly what the rehearsal printed',
    () =>
      Effect.scoped(
        Effect.gen(function* dryRunsTheAkrosMove() {
          const authConfiguration = yield* loadAuthConfig();
          const connections = yield* loadDatabaseConnectionPair();
          const spiceDb = yield* loadSpiceDbConfig();
          yield* writeEngineSchema(spiceDb);
          const context = yield* Layer.build(
            makeStageAccountsRuntime({ databases: connections, spiceDb: Redacted.make(spiceDb) }),
          );
          const auth = Context.get(context, AuthDatabase).executor;
          const { declaredWorkloadKeys, modules } = yield* stageAccessModules;
          // The tenant an e-shop login leaves, and AKROS, where the same login gets a Principal of its own.
          const source = randomUUID();
          const destination = randomUUID();
          const sourceCompany = randomUUID();
          const owner = randomUUID();
          const leaver = randomUUID();
          const attached = { binding: randomUUID(), principal: randomUUID() };
          const emails = {
            destinationOwner: `stage-dry-destination-owner-${source}@example.test`,
            leaver: `stage-dry-leaver-${source}@example.test`,
            owner: `stage-dry-owner-${source}@example.test`,
          };
          const clientId = `https://stage-dry-${source}.example/metadata`;
          const configurationOf = operatorConfigurationOf({ authConfiguration, connections, declaredWorkloadKeys });
          const realRun = runOperatorFile(configurationOf, context, (configuration) =>
            bootstrapStageAccounts(configuration, { modules }),
          );
          const dryRun = runOperatorFile(configurationOf, context, (configuration) =>
            rehearseStageAccounts(configuration, { modules }),
          );
          yield* Effect.addFinalizer(() => deleteLogins(auth, Object.values(emails), clientId));
          yield* realRun({
            retiredAccountEmails: [],
            retiredTenants: [],
            tenants: [
              stageTenantOf(source, sourceCompany, [
                { displayName: 'Stage dry run owner', email: emails.owner, owner: true, principalId: owner },
                { displayName: 'Stage dry run leaver', email: emails.leaver, owner: false, principalId: leaver },
              ]),
              stageTenantOf(destination, randomUUID(), [
                {
                  displayName: 'Stage dry run AKROS owner',
                  email: emails.destinationOwner,
                  owner: true,
                  principalId: randomUUID(),
                },
              ]),
            ],
          });
          const [leaverUser] = yield* auth.select({ id: user.id }).from(user).where(eq(user.email, emails.leaver));
          const leaverUserId = leaverUser?.id ?? '';
          // The leaver's company directory row, the app they still use and one they disconnected, each with tokens.
          yield* auth.execute(
            sql`insert into core.principal_company_memberships (tenant_id, legal_entity_id, principal_id, affiliation, status)
                  values (${source}, ${sourceCompany}, ${leaver}, 'employee', 'active')`,
          );
          yield* auth.insert(oauthClient).values({ clientId, id: randomUUID(), redirectUris: ['http://127.0.0.1/cb'] });
          const live = { binding: randomUUID(), grant: randomUUID(), name: 'Live e-shop client' };
          const disconnected = { binding: randomUUID(), grant: randomUUID(), name: 'Disconnected client' };
          const connection = {
            clientId,
            company: sourceCompany,
            person: leaver,
            tenantId: source,
            userId: leaverUserId,
          };
          yield* seedAppConnection(auth, { ...connection, app: live }, null);
          yield* seedAppConnection(auth, { ...connection, app: disconnected }, { by: leaver, reason: 'user' });
          const snapshot = stageRunRowsOf(auth, {
            emails: Object.values(emails),
            tenantIds: [source, destination],
            userId: leaverUserId,
          });
          const leaverRows = (condition: SQL) =>
            auth.execute<{ readonly count: number; readonly table: string }>(
              sql`select 'membership' as table, count(*)::int as count from core.access_memberships
                    where tenant_id = ${source} and principal_id = ${leaver} and ${condition}
                  union all select 'assignment', count(*)::int from core.access_assignments
                    where tenant_id = ${source} and principal_id = ${leaver} and ${condition}`,
              'objects',
            );
          const bindingsOfTheLeaver = auth.execute<{
            readonly provider: string;
            readonly status: string;
            readonly subjectType: string;
          }>(
            sql`select provider, status, subject_type as "subjectType" from core.principal_auth_bindings
                  where tenant_id = ${source} and principal_id = ${leaver} order by 1, 2, 3`,
            'objects',
          );
          const before = yield* snapshot;
          const heldBefore = yield* leaverRows(sql`status not in ('revoked', 'expired')`);
          const revokedBefore = yield* leaverRows(sql`status = 'revoked'`);
          const bindingsBefore = yield* bindingsOfTheLeaver;
          const operatorFile: OperatorFile = {
            attachedLogins: [
              {
                authBindingId: attached.binding,
                displayName: 'Stage dry run leaver in AKROS',
                email: emails.leaver,
                principalId: attached.principal,
                tenantId: destination,
              },
            ],
            retiredAccountEmails: [],
            retiredPrincipals: [{ email: emails.leaver, principalId: leaver, tenantId: source }],
            retiredTenants: [],
            tenants: [],
          };
          // The operator's command with no argument, read as the command reads it, is the dry run: the very move
          // transaction of the real run, rolled back. Every table the real run writes is as it was.
          const requested = yield* Ref.make<readonly StageAccountsExecution[]>([]);
          yield* makeStageAccountsCommand((execution) => Ref.update(requested, (runs) => [...runs, execution])).pipe(
            Effect.provide(Stdio.layerTest({ args: Effect.succeed([]) })),
          );
          expect(yield* Ref.get(requested)).toEqual(['dry-run']);
          const dry = yield* dryRun(operatorFile);
          expect(yield* snapshot).toEqual(before);
          expect(dry.departures).toHaveLength(1);
          const [departure] = dry.departures;
          if (departure === undefined) {
            return yield* Effect.die(new Error('the dry run plans exactly one departure'));
          }
          expect(countOf(heldBefore, 'membership')).toBeGreaterThan(0);
          expect(countOf(heldBefore, 'assignment')).toBeGreaterThan(0);
          expect({
            archives: departure.archives,
            directory: departure.directory,
            ended: departure.ended,
            revocationEvents: departure.revocationEvents,
          }).toEqual({
            archives: true,
            directory: 1,
            ended: {
              assignments: countOf(heldBefore, 'assignment'),
              delegations: 0,
              memberships: countOf(heldBefore, 'membership'),
              teamPlaces: 0,
            },
            revocationEvents: 1,
          });
          expect(departure.bindings.toSorted(byBinding)).toEqual(bindingsBefore.toSorted(byBinding));
          expect(departure.bindings.toSorted(byBinding)).toEqual([
            { provider: 'better_auth', status: 'active', subjectType: 'oauth_grant' },
            { provider: 'better_auth', status: 'disabled', subjectType: 'oauth_grant' },
            { provider: 'better_auth', status: 'active', subjectType: 'user' },
          ]);
          expect(departure.connectedApps.map(({ grantId, status }) => ({ grantId, status }))).toEqual([
            { grantId: live.grant, status: 'active' },
          ]);
          expect(dry.attachments).toEqual([
            {
              authBindingId: attached.binding,
              created: true,
              email: emails.leaver,
              principalId: attached.principal,
              providerUserId: leaverUserId,
              tenantId: destination,
            },
          ]);
          expect(dry.connectedApps.map(({ grantId }) => grantId).toSorted()).toEqual(
            [live.grant, disconnected.grant].toSorted(),
          );
          expect([dry.accounts, dry.completedConnectedApps, dry.leftTenantIds]).toEqual([[], [], [source]]);
          // What the operator reads before the real run.
          const lines = stageAccountsDryRunLines(dry);
          expect(lines[0]).toMatch(/^Stage accounts dry run: .*nothing was written$/u);
          expect(lines.slice(1)).toEqual([
            `Would retire the Principal of ${emails.leaver}: tenant=${source} principal=${leaver} bindings=better_auth/oauth_grant:active=1,better_auth/oauth_grant:disabled=1,better_auth/user:active=1 memberships=${departure.ended.memberships} assignments=${departure.ended.assignments} delegations=0 teamPlaces=0 directory=1 auditEvents=1`,
            `Would end connected app "${live.name}" (${clientId}) of ${emails.leaver}: tenant=${source} grant=${live.grant} was=active lastUsed=${lastUseOf(departure.connectedApps[0])}`,
            `Would attach login ${emails.leaver}: tenant=${destination} principal=${attached.principal} binding=${attached.binding}`,
            'Would write 1 audit events (oauth.connection.revoked)',
            'Dry run skipped the clean-up after the commit: the run would delete the Better Auth tokens and consent of 2 connected apps of the people it retires',
            `Dry run skipped the authorization reconcile of tenant ${source}, which somebody leaves`,
            'Nothing was written. Check every line above; the real run of the same, unchanged file is `node scripts/bootstrap-stage-accounts.mts --commit`',
          ]);
          // The real run then writes exactly the moves the dry run printed.
          const real = yield* realRun(operatorFile);
          expect(dry.departures).toEqual(real.moves.departures.map((moved) => ({ ...moved, email: emails.leaver })));
          expect(dry.attachments).toEqual(real.moves.attachments.map((moved) => ({ ...moved, email: emails.leaver })));
          expect(real.endedConnectedApps.map(({ grantId }) => grantId)).toEqual([live.grant]);
          const revokedAfter = yield* leaverRows(sql`status = 'revoked'`);
          expect(countOf(revokedAfter, 'membership') - countOf(revokedBefore, 'membership')).toBe(
            departure.ended.memberships,
          );
          expect(countOf(revokedAfter, 'assignment') - countOf(revokedBefore, 'assignment')).toBe(
            departure.ended.assignments,
          );
          expect(yield* leaverRows(sql`status not in ('revoked', 'expired')`)).toEqual([
            { count: 0, table: 'membership' },
            { count: 0, table: 'assignment' },
          ]);
          expect((yield* bindingsOfTheLeaver).map(({ status }) => status)).toEqual(['revoked', 'revoked', 'revoked']);
          expect(
            yield* auth.execute<{ readonly directory: string; readonly principal: string }>(
              sql`select p.status as principal, d.status as directory from core.principals p
                    join core.principal_company_memberships d on d.tenant_id = p.tenant_id and d.principal_id = p.principal_id
                    where p.tenant_id = ${source} and p.principal_id = ${leaver}`,
              'objects',
            ),
          ).toEqual([{ directory: 'departed', principal: 'archived' }]);
          expect(
            yield* auth.execute<{ readonly grant: string; readonly principal: string }>(
              sql`select target_resource_id as grant, principal_id::text as principal from core.audit_events
                    where tenant_id = ${source} and event_type = 'oauth.connection.revoked'`,
              'objects',
            ),
          ).toEqual([{ grant: live.grant, principal: owner }]);
          expect(
            yield* auth.execute<{ readonly binding: string; readonly principal: string; readonly subject: string }>(
              sql`select p.status as principal, b.status as binding, b.provider_subject_id as subject
                    from core.principals p
                    join core.principal_auth_bindings b on b.tenant_id = p.tenant_id and b.principal_id = p.principal_id
                    where p.tenant_id = ${destination} and p.principal_id = ${attached.principal}`,
              'objects',
            ),
          ).toEqual([{ binding: 'active', principal: 'active', subject: leaverUserId }]);
          // The clean-up the dry run skipped ran after the real commit: no token or consent of either app is left.
          const { accessTokens, consents, refreshTokens } = yield* snapshot;
          expect([accessTokens.length, refreshTokens.length, consents.length]).toEqual([0, 0, 0]);
          return yield* Effect.void;
        }).pipe(Effect.provide(NodeServices.layer)),
      ).pipe(Effect.provide(StagePoolSettingLive)),
    180_000,
  );
});
