// @effect-diagnostics strictEffectProvide:off -- Test-owned scripted session client; expires: 2026-12-31.
import { PgClient } from '@effect/sql-pg';
import { Duration, Effect, Exit, Fiber, Layer, Option, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';
import { Reactivity } from 'effect/reactivity';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';
import { TestClock } from 'effect/testing';

import { verifyDatabaseSessionRole } from '../../src/db/session-identity.ts';
import { scriptedPgClientLayer } from '../../src/testing/scripted-pg-client.ts';
import { testSqlConnection } from '../support/sql-connection.ts';

const refused = new SqlError({
  reason: new ConnectionError({
    cause: 'remaining connection slots are reserved for roles with the SUPERUSER attribute',
  }),
});

/** Verifies the session role over a server that refuses the first `refusals` connections. */
const verifyAfterRefusals = (refusals: number, role: string) =>
  Effect.gen(function* verifyOverRefusingServer() {
    let attempts = 0;
    const acquirer = Effect.suspend(() => {
      attempts += 1;
      return attempts <= refusals
        ? Effect.fail(refused)
        : Effect.succeed(testSqlConnection(() => Effect.succeed([{ role }])));
    });
    const fiber = yield* Effect.gen(function* verify() {
      const client = yield* PgClient.PgClient;
      return yield* verifyDatabaseSessionRole(client, 'ontos_runtime');
    }).pipe(
      Effect.provide(scriptedPgClientLayer(acquirer).pipe(Layer.provideMerge(Reactivity.layer))),
      Effect.exit,
      Effect.forkChild,
    );
    yield* TestClock.adjust(Duration.minutes(4));
    return { attempts: () => attempts, exit: yield* Fiber.join(fiber) };
  });

it.effect('a refused first connection is retried until the server admits the session', () =>
  Effect.gen(function* refusedConnectionRecovers() {
    const { attempts, exit } = yield* verifyAfterRefusals(5, 'ontos_runtime');
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(attempts()).toBe(6);
  }),
);

it.effect('a server that keeps refusing fails startup once the retry window closes', () =>
  Effect.gen(function* refusedConnectionGivesUp() {
    const { exit } = yield* verifyAfterRefusals(Number.MAX_SAFE_INTEGER, 'ontos_runtime');
    const error = Option.getOrUndefined(Exit.findErrorOption(exit));
    expect(Predicate.isTagged(error, 'DatabaseConnectionError')).toBe(true);
    expect(error).toMatchObject({ reason: 'Unable to verify the PostgreSQL session role' });
  }),
);

it.effect('a session under another role fails at once without retrying', () =>
  Effect.gen(function* foreignRoleIsRefused() {
    const { attempts, exit } = yield* verifyAfterRefusals(0, 'party_registry_runtime');
    const error = Option.getOrUndefined(Exit.findErrorOption(exit));
    expect(error).toMatchObject({ reason: 'The PostgreSQL session does not match the required database identity' });
    expect(attempts()).toBe(1);
  }),
);
