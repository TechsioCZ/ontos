import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { Cause, Deferred, Effect, Exit, Fiber } from 'effect';
import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import { loadAuthConfig } from '../../api/auth/config.ts';
import { AuthDatabase, makeAuthDatabase } from '../../api/auth/db/client.ts';
import { bootstrapStageDemo } from '../../api/auth/stage-demo-bootstrap-runtime-infrastructure.ts';

void test(
  'stage bootstrap waits for non-cancellable SDK writes before closing its database scope',
  { timeout: 10_000 },
  async (context) => {
    const store = { account: [], session: [], user: [], verification: [] };
    const sdkStarted = Deferred.makeUnsafe<null>();
    const sdkSettlement = Promise.withResolvers<null>();
    const sdkAdapter = memoryAdapter(store);
    let databaseClosed = false;
    const configuration = await runEffectTestPromise(loadAuthConfig());
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
              context.mock.method(
                adapter,
                'create',
                async (input: Parameters<typeof create>[0]) => {
                  if (input.model === 'user') {
                    Deferred.doneUnsafe(sdkStarted, Effect.succeed(null));
                    await sdkSettlement.promise;
                  }
                  return await create(input);
                },
              );
              return adapter;
            },
            executor: database.executor,
          }),
        );
      }),
    );
    const outcome = await runEffectTestPromise(
      Effect.gen(function* interruptPendingBootstrap() {
        const bootstrap = yield* program.pipe(Effect.forkChild);
        yield* Deferred.await(sdkStarted).pipe(Effect.raceFirst(Fiber.join(bootstrap)));
        const interruption = yield* Fiber.interrupt(bootstrap).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const pending = bootstrap.pollUnsafe() === undefined;
        const closedBeforeSettlement = databaseClosed;
        sdkSettlement.resolve(null);
        yield* Fiber.join(interruption);
        return { closedBeforeSettlement, exit: yield* Fiber.await(bootstrap), pending };
      }).pipe(Effect.ensuring(Effect.sync(() => sdkSettlement.resolve(null)))),
    );
    assert.equal(outcome.pending, true);
    assert.equal(outcome.closedBeforeSettlement, false);
    assert.ok(Exit.isFailure(outcome.exit));
    assert.equal(Cause.hasInterrupts(outcome.exit.cause), true);
    assert.equal(databaseClosed, true);
    assert.equal(store.user.length, 1);
    assert.equal(store.account.length, 1);
  },
);
