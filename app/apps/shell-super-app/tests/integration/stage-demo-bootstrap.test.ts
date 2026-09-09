import { describe, expect, it, rstest } from 'effect-rstest';
import { randomUUID } from 'node:crypto';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { verifyPassword } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import { Cause, DateTime, Deferred, Effect, Exit, Fiber } from 'effect';
import { loadAuthConfig } from '../../api/auth/config.ts';
import { AuthDatabase, makeAuthDatabase } from '../../api/auth/db/client.ts';
import { account, session, user } from '../../api/auth/db/schema.ts';
import {
  bootstrapStageDemo,
  ensureStageDemoAuthUser,
} from '../../api/auth/stage-demo-bootstrap-runtime-infrastructure.ts';

describe('stage-demo-bootstrap', () => {
  it.live('replaces an unreadable demo password and revokes its sessions', () =>
    Effect.scoped(
      Effect.gen(function* replacesPassword() {
        const baseConfiguration = yield* loadAuthConfig();
        const persistence = yield* makeAuthDatabase(baseConfiguration);
        const database = persistence.executor;
        const email = `stage-password-reset-${randomUUID()}@example.test`;
        const initialPassword = `initial-${randomUUID()}`;
        const replacementPassword = `replacement-${randomUUID()}`;
        const configuration = {
          accounts: [
            { email, password: initialPassword, principalDisplayName: 'Password reset fixture' },
            {
              email: `unused-${randomUUID()}@example.test`,
              password: randomUUID(),
              principalDisplayName: 'Unused fixture',
            },
          ],
          authBaseUrl: baseConfiguration.baseUrl,
          authSecret: baseConfiguration.secret,
          databaseAdminUrl: baseConfiguration.connectionString,
        } as const;
        const cleanup = Effect.gen(function* cleanupPasswordFixture() {
          const users = yield* database
            .select({ id: user.id })
            .from(user)
            .where(eq(user.email, email));
          for (const existingUser of users) {
            yield* database.delete(session).where(eq(session.userId, existingUser.id));
            yield* database.delete(account).where(eq(account.userId, existingUser.id));
            yield* database.delete(user).where(eq(user.id, existingUser.id));
          }
        }).pipe(Effect.orDie);
        yield* cleanup;
        yield* Effect.addFinalizer(() => cleanup);
        const created = yield* ensureStageDemoAuthUser(
          configuration,
          configuration.accounts[0],
        ).pipe(Effect.provideService(AuthDatabase, persistence));
        yield* database
          .update(account)
          .set({ password: randomUUID() })
          .where(eq(account.userId, created.userId));
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
        const replaced = yield* ensureStageDemoAuthUser(configuration, {
          ...configuration.accounts[0],
          password: replacementPassword,
        }).pipe(Effect.provideService(AuthDatabase, persistence));
        expect(replaced).toEqual({ status: 'password-reset', userId: created.userId });
        const [credential] = yield* database
          .select({ password: account.password })
          .from(account)
          .where(eq(account.userId, created.userId));
        expect(credential?.password).toBeDefined();
        const replacementMatches = yield* Effect.promise(() =>
          verifyPassword({ hash: credential?.password ?? '', password: replacementPassword }),
        );
        const initialMatches = yield* Effect.promise(() =>
          verifyPassword({ hash: credential?.password ?? '', password: initialPassword }),
        );
        expect(replacementMatches).toBe(true);
        expect(initialMatches).toBe(false);
        const remainingSessions = yield* database
          .select({ id: session.id })
          .from(session)
          .where(eq(session.userId, created.userId));
        expect(remainingSessions).toHaveLength(0);
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
            const database = yield* makeAuthDatabase(configuration);
            return yield* bootstrapStageDemo({
              accounts: [
                {
                  email: `stage-first-${randomUUID()}@example.test`,
                  password: randomUUID(),
                  principalDisplayName: 'First',
                },
                {
                  email: `stage-second-${randomUUID()}@example.test`,
                  password: randomUUID(),
                  principalDisplayName: 'Second',
                },
              ],
              authBaseUrl: configuration.baseUrl,
              authSecret: configuration.secret,
              databaseAdminUrl: configuration.connectionString,
            }).pipe(
              Effect.provideService(AuthDatabase, {
                adapter: (options) => {
                  const adapter = sdkAdapter(options);
                  const create = adapter.create.bind(adapter);
                  rstest
                    .spyOn(adapter, 'create')
                    .mockImplementation((input: Parameters<typeof create>[0]) => {
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
          return { closedBeforeSettlement, exit: yield* Fiber.await(bootstrap), pending };
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
