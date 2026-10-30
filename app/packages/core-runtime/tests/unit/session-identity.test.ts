// @effect-diagnostics strictEffectProvide:off -- Test-owned scripted session client; expires: 2026-12-31.
import { PgClient } from '@effect/sql-pg';
import { Effect, Exit, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { Reactivity } from 'effect/reactivity';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';

import { SESSION_ROLE_MISMATCH_REASON, verifySessionRoleOnFirstUse } from '../../src/db/session-identity.ts';
import { scriptedPgClientLayer } from '../../src/testing/scripted-pg-client.ts';
import { testSqlConnection } from '../support/sql-connection.ts';

const refused = new SqlError({
  reason: new ConnectionError({
    cause: 'remaining connection slots are reserved for roles with the SUPERUSER attribute',
  }),
});

/** A server that refuses the first `refusals` connections, then answers as `role`; it records every statement. */
const scriptedServer = (refusals: number, role: string) => {
  let connections = 0;
  const statements: string[] = [];
  const acquirer = Effect.suspend(() => {
    connections += 1;
    return connections <= refusals
      ? Effect.fail(refused)
      : Effect.succeed(
          testSqlConnection((statement) => {
            statements.push(statement);
            return Effect.succeed(statement.includes('session_user') ? [{ role }] : [{ value: 1 }]);
          }),
        );
  });
  return {
    connections: () => connections,
    layer: scriptedPgClientLayer(acquirer).pipe(Layer.provideMerge(Reactivity.layer)),
    statements,
  };
};

const verifiedClient = Effect.gen(function* makeVerifiedClient() {
  return verifySessionRoleOnFirstUse(yield* PgClient.PgClient, 'ontos_runtime');
});

it.effect('building the verified client opens no connection', () =>
  Effect.gen(function* buildWithoutConnection() {
    const server = scriptedServer(0, 'ontos_runtime');
    yield* verifiedClient.pipe(Effect.provide(server.layer));
    expect(server.connections()).toBe(0);
    expect(server.statements).toEqual([]);
  }),
);

it.effect('the first use confirms the session role once before its statement runs', () =>
  Effect.gen(function* verifyOnFirstUse() {
    const server = scriptedServer(0, 'ontos_runtime');
    yield* Effect.gen(function* useTwice() {
      const client = yield* verifiedClient;
      yield* client.unsafe('select 1').values;
      yield* client.unsafe('select 2').values;
    }).pipe(Effect.provide(server.layer));
    expect(server.statements).toEqual(['select session_user::text as role', 'select 1', 'select 2']);
  }),
);

it.effect('a refused first connection fails only that use and the next use verifies again', () =>
  Effect.gen(function* refusedConnectionRecovers() {
    const server = scriptedServer(1, 'ontos_runtime');
    const { first, second } = yield* Effect.gen(function* useAfterRefusal() {
      const client = yield* verifiedClient;
      return {
        first: yield* Effect.exit(client.unsafe('select 1').values),
        second: yield* Effect.exit(client.unsafe('select 1').values),
      };
    }).pipe(Effect.provide(server.layer));
    expect(Exit.isFailure(first)).toBe(true);
    expect(Exit.isSuccess(second)).toBe(true);
    expect(server.statements).toEqual(['select session_user::text as role', 'select 1']);
  }),
);

it.effect('a session under another role runs no statement and fails as a connection error', () =>
  Effect.gen(function* foreignRoleIsRefused() {
    const server = scriptedServer(0, 'party_registry_runtime');
    const exit = yield* Effect.gen(function* useForeignSession() {
      const client = yield* verifiedClient;
      return yield* Effect.exit(client.unsafe('select 1').values);
    }).pipe(Effect.provide(server.layer));
    const error = Option.getOrUndefined(Exit.findErrorOption(exit));
    expect(Schema.is(SqlError)(error)).toBe(true);
    expect(Schema.is(ConnectionError)(error?.reason)).toBe(true);
    expect(error?.reason.message).toBe(SESSION_ROLE_MISMATCH_REASON);
    expect(server.statements).toEqual(['select session_user::text as role']);
  }),
);
