import { describe, expect, it, rstest } from 'effect-rstest';
import { randomUUID } from 'node:crypto';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { Cause, Deferred, Effect, Exit, Fiber } from 'effect';
import { loadAuthConfig } from '../../api/auth/config.ts';
import { AuthDatabase, makeAuthDatabase } from '../../api/auth/db/client.ts';
import { bootstrapStageDemo } from '../../api/auth/stage-demo-bootstrap-runtime-infrastructure.ts';

describe('stage-demo-bootstrap', () => {
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
