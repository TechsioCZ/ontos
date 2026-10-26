import { randomUUID } from 'node:crypto';

import { memoryAdapter } from 'better-auth/adapters/memory';
import { verifyPassword } from 'better-auth/crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { Cause, Context, DateTime, Deferred, Effect, Exit, Fiber, Layer, Redacted } from 'effect';
import { describe, expect, it, rstest } from 'effect-rstest';

import { DatabaseConfig, loadDatabaseConnectionPair } from '@app/core-runtime';
import { parseStageAccountsFile } from '@app/core-runtime/install/stage-accounts-file';

import { loadAuthConfig } from '../../api/auth/config.ts';
import { AuthDatabase, AuthDatabaseFromDatabaseConfigLive, makeAuthDatabase } from '../../api/auth/db/client.ts';
import { OAuthCredentialsLive } from '../../api/auth/db/oauth-credentials-live.ts';
import { account, session, user } from '../../api/auth/db/schema.ts';
import {
  bootstrapStageAccounts,
  ensureStageAccountAuthUser,
} from '../../api/auth/stage-accounts-bootstrap-runtime-infrastructure.ts';
import { evaluateLiveChecks } from '../../api/oauth-connections/connection-service.ts';
import { loadUserAccount } from '../../api/oauth-connections/grant-store.ts';

/** A one-account stage accounts file with fresh identifiers, as the operator would write it. */
const oneAccountFileSource = (): string =>
  JSON.stringify({
    actionAuthorization: { actionAssertions: [], roleGrants: [] },
    retiredAccountEmails: [],
    retiredTenants: [],
    schemaVersion: 4,
    scopedRoles: [],
    tenants: [
      {
        accounts: [
          {
            affiliation: 'employee',
            authBindingId: randomUUID(),
            displayName: 'First',
            email: `stage-first-${randomUUID()}@example.test`,
            grants: { explicitActions: [], tenantRelations: [] },
            password: randomUUID(),
            principalId: randomUUID(),
          },
        ],
        defaultLocale: 'cs',
        displayName: 'Tenant A',
        legalEntity: {
          legalEntityId: randomUUID(),
          legalName: 'Tenant A Legal',
          registrationCountry: 'CZ',
          registrationNumber: 'FIXTURE-A',
        },
        moduleKey: 'party.registry',
        moduleStateId: randomUUID(),
        slug: 'tenant-a',
        tenantId: randomUUID(),
      },
    ],
  });

describe('stage-accounts-bootstrap', () => {
  it.live(
    'replaces an unreadable account password and revokes its sessions through the explicit operator identity',
    () =>
      Effect.scoped(
        Effect.gen(function* replacesPassword() {
          const baseConfiguration = yield* loadAuthConfig();
          const connections = yield* loadDatabaseConnectionPair();
          const context = yield* Layer.build(
            OAuthCredentialsLive.pipe(
              Layer.provideMerge(AuthDatabaseFromDatabaseConfigLive),
              Layer.provide(Layer.succeed(DatabaseConfig, connections.admin)),
            ),
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
        const context = yield* Layer.build(
          OAuthCredentialsLive.pipe(
            Layer.provideMerge(AuthDatabaseFromDatabaseConfigLive),
            Layer.provide(Layer.succeed(DatabaseConfig, connections.admin)),
          ),
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
        let databaseClosed = false;
        const configuration = yield* loadAuthConfig();
        const program = Effect.scoped(
          Effect.gen(function* bootstrapWithDelayedSdk() {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                databaseClosed = true;
              }),
            );
            const connections = yield* loadDatabaseConnectionPair();
            const database = yield* makeAuthDatabase(connections.admin);
            const accountsFile = yield* parseStageAccountsFile({ mode: 0o600, source: oneAccountFileSource() });
            return yield* bootstrapStageAccounts({
              accountsFile,
              authBaseUrl: configuration.baseUrl,
              authSecret: configuration.secret,
              databaseAdminUrl: connections.admin.connectionString,
            }).pipe(
              Effect.provideService(AuthDatabase, {
                adapter: (options) => {
                  const adapter = sdkAdapter(options);
                  const create = adapter.create.bind(adapter);
                  rstest.spyOn(adapter, 'create').mockImplementation((input: Parameters<typeof create>[0]) => {
                    if (input.model === 'user') {
                      Deferred.doneUnsafe(sdkStarted, Effect.succeed(null));
                      // oxlint-disable-next-line sonarjs/no-nested-functions -- SDK settlement continuation stays inside its adapter mock.
                      return sdkSettlement.promise.then(() => create(input));
                    }
                    return create(input);
                  });
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
});
