import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { PgClient } from '@effect/sql-pg';
import { Effect, Layer } from 'effect';
import { expect, it } from 'effect-rstest';
import { Reactivity } from 'effect/reactivity';

import { awaitQueuedLockWaiters } from '../integration/database-fixture.ts';

it.live('observes a queued lock on the live clock without requiring a TestClock', () =>
  Effect.gen(function* observeLiveLock() {
    let observations = 0;
    const clientLayer = scriptedPgClientLayer(
      Effect.succeed(
        testSqlConnection(() =>
          Effect.sync(() => {
            observations += 1;
            return [{ waiting: observations < 2 ? 0 : 1 }];
          }),
        ),
      ),
    ).pipe(Layer.provide(Reactivity.layer));
    const waiting = yield* PgClient.PgClient.pipe(
      Effect.flatMap((client) => awaitQueuedLockWaiters(client, { expected: 1, holderPid: 42 })),
      Effect.provide(clientLayer),
    );
    expect(waiting).toBe(1);
  }),
);
