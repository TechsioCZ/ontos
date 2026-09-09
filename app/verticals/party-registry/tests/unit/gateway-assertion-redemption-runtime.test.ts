import { GatewayAssertionRedemptionUnavailableError, GatewayAssertionReplayError } from '@app/core-runtime';
import { GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS } from '@app/shared-contracts';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Cause, Clock, Effect, Exit, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';
import { Reactivity } from 'effect/unstable/reactivity';
import { ConnectionError, SqlError } from 'effect/unstable/sql/SqlError';

import { testSqlConnection } from '../../../../packages/core-runtime/tests/support/sql-connection.ts';
import { makeGatewayAssertionRedemption } from '../../src/auth/gateway-assertion-redemption-runtime.ts';
import { partyRelations } from '../../src/db/schema.ts';

const assertion = {
  audience: 'party-registry',
  expiresAtEpochSeconds: 1_700_000_300,
  issuer: 'https://shell.ontos.test',
  jti: '60000000-0000-4000-8000-000000000001',
};
const expiryWithSkewMs = (assertion.expiresAtEpochSeconds + GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS) * 1000;

// Native Drizzle and SqlClient own transaction settlement; only the wire connection is replaced.
const makeRedemptionFixture = (
  execute: (sql: string, params: readonly unknown[]) => Effect.Effect<readonly object[], SqlError>,
) =>
  Effect.gen(function* makeRedemptionFixtureEffect() {
    const connection = testSqlConnection(execute);
    const reactivity = yield* Reactivity.make;
    const client = yield* PgClient.makeWith({
      acquirer: Effect.succeed(connection),
      config: {},
      listenAcquirer: Effect.die('The fixture does not support notifications'),
      transactionAcquirer: Effect.succeed(connection),
    }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity));
    const executor = yield* makeWithDefaults({
      relations: partyRelations,
    }).pipe(Effect.provideService(PgClient.PgClient, client));
    const clock = yield* TestClock.make();
    yield* clock.setTime(expiryWithSkewMs - 1);
    return { clock, redemption: makeGatewayAssertionRedemption(executor) };
  });

for (const settlement of ['COMMIT', 'ROLLBACK']) {
  it.effect(`maps native ${settlement} SQL defects to redemption unavailability`, () =>
    Effect.gen(function* rejectSqlSettlementFailure() {
      const sqlFailure = new SqlError({
        reason: new ConnectionError({
          cause: new Error('private fixture database details'),
          message: 'private fixture connection details',
          operation: settlement,
        }),
      });
      const statements: string[] = [];
      const fixture = yield* makeRedemptionFixture((sql) => {
        statements.push(sql);
        if (sql === settlement || (settlement === 'ROLLBACK' && sql.startsWith('insert'))) {
          return Effect.fail(sqlFailure);
        }
        return Effect.succeed(sql.startsWith('insert') ? [{ jti: assertion.jti }] : []);
      });
      const failure = yield* fixture.redemption
        .consume(assertion)
        .pipe(Effect.provideService(Clock.Clock, fixture.clock), Effect.flip);
      expect(Schema.is(GatewayAssertionRedemptionUnavailableError)(failure)).toBe(true);
      const serializedFailure = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(failure);
      expect(serializedFailure).not.toMatch(/private fixture/u);
      expect(statements.includes(settlement)).toBe(true);
    }),
  );
}

it.effect('preserves unrelated transaction defects', () =>
  Effect.gen(function* preserveProgrammingDefect() {
    const defect = new Error('fixture programming defect');
    const fixture = yield* makeRedemptionFixture((sql) =>
      sql === 'COMMIT' ? Effect.die(defect) : Effect.succeed(sql.startsWith('insert') ? [{ jti: assertion.jti }] : []),
    );
    const exit = yield* fixture.redemption
      .consume(assertion)
      .pipe(Effect.provideService(Clock.Clock, fixture.clock), Effect.exit);
    assert.isOk(Exit.isFailure(exit));
    expect(exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === defect)).toBe(true);
  }),
);

it.effect('rejects assertions crossing expiry before redemption without deleting replay evidence', () =>
  Effect.gen(function* preserveExpiredReplayEvidence() {
    const statements: string[] = [];
    const fixture = yield* makeRedemptionFixture((sql) => {
      statements.push(sql);
      return Effect.succeed(sql.startsWith('insert') ? [{ jti: assertion.jti }] : []);
    });
    yield* fixture.redemption.consume(assertion).pipe(Effect.provideService(Clock.Clock, fixture.clock));
    expect(statements.includes('COMMIT'), 'the last millisecond of skew remains usable').toBe(true);
    statements.length = 0;
    for (const now of [expiryWithSkewMs, expiryWithSkewMs + 1]) {
      yield* fixture.clock.setTime(now);
      const failure = yield* fixture.redemption
        .consume(assertion)
        .pipe(Effect.provideService(Clock.Clock, fixture.clock), Effect.flip);
      expect(Schema.is(GatewayAssertionReplayError)(failure)).toBe(true);
    }
    expect(statements, 'expired assertions cannot run replay-evidence cleanup').toEqual([]);
  }),
);
