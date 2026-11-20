import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { SHARED_RUNTIME_IDENTITY, loadDatabaseConnectionPair } from '@app/core-runtime';
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
import { Cause, Context, DateTime, Deferred, Effect, Exit, Fiber, Layer, Redacted } from 'effect';
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
import {
  parseStageAccountsBootstrapConfig,
  stageAccountsFailureLine,
} from '../../api/auth/stage-accounts-bootstrap-contract.ts';
import {
  bootstrapStageAccounts,
  ensureStageAccountAuthUser,
} from '../../api/auth/stage-accounts-bootstrap-runtime-infrastructure.ts';
import { evaluateLiveChecks } from '../../api/oauth-connections/connection-service.ts';
import { loadUserAccount } from '../../api/oauth-connections/grant-store.ts';
import {
  makeStageAccountsAuthDatabase,
  makeStageAccountsRuntime,
  stageAccessModules,
} from '../../scripts/bootstrap-stage-accounts.mts';
import { newSpiceDbGrpcClient } from '../../../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../../../packages/core-runtime/src/permissions/schema.ts';

/** An operator accounts file as JSON, before the operator command's own parser decodes it. */
interface OperatorFile {
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
      ),
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
    ),
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
          // The very graph the operator command builds, from the integration environment's two URLs: no client of the
          // run is constructed here.
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
          const configurationOf = (file: OperatorFile) =>
            parseStageAccountsBootstrapConfig(
              {
                BETTER_AUTH_SECRET: authConfiguration.secret,
                BETTER_AUTH_URL: authConfiguration.baseUrl,
                DATABASE_ADMIN_URL: connections.admin.connectionString,
                [STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY]: '/operator/stage-accounts.json',
                ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
              },
              () => Effect.succeed({ mode: 0o600, source: JSON.stringify({ schemaVersion: 2, ...file }) }),
              declaredWorkloadKeys,
            );
          const run = (file: OperatorFile) =>
            configurationOf(file).pipe(
              Effect.flatMap((configuration) => bootstrapStageAccounts(configuration, { modules })),
              Effect.provide(context),
            );
          // Core's rows of the random tenant stay: its governed history cannot be deleted. Its logins and their tokens go.
          const cleanup = Effect.gen(function* cleanupStageRun() {
            const users = yield* auth
              .select({ id: user.id })
              .from(user)
              .where(inArray(user.email, [ownerEmail, leaverEmail]));
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
          expect(retired.retiredPrincipals).toEqual([{ email: leaverEmail, principalId: leaver, tenantId }]);
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
          // The same file again ends nothing, so it records nothing, and finds nothing left to delete.
          const replayed = yield* run(retirement);
          expect(replayed.endedConnectedApps).toEqual([]);
          expect(yield* revocationEvents).toEqual(recorded);
          for (const grantId of leaverGrants) {
            expect(yield* tokenCountsOf(grantId)).toEqual([0, 0, 0]);
          }
          expect(yield* tokenCountsOf(survivingGrant)).toEqual([1, 1, 1]);
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    180_000,
  );
});
