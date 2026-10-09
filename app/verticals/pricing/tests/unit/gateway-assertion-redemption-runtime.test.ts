import { GatewayAssertionRedemptionUnavailableError, GatewayAssertionReplayError } from '@app/core-runtime';
import { GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS } from '@app/shared-contracts';
import { defineRelations } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { Cause, Clock, DateTime, Effect, Exit, Fiber, Layer, Result, Schema } from 'effect';
import { assert, expect, it, rs } from 'effect-rstest';
import { TestClock } from 'effect/testing';
import { Reactivity } from 'effect/unstable/reactivity';
import { ConnectionError, SqlError } from 'effect/unstable/sql/SqlError';

import { scriptedPgClientLayer } from '../../../../packages/core-runtime/src/testing/scripted-pg-client.ts';
import { testSqlConnection } from '../../../../packages/core-runtime/tests/support/sql-connection.ts';
import { makeGatewayAssertionRedemption } from '../../src/auth/gateway-assertion-redemption-runtime.ts';
import { gatewayAssertionRedemptions } from '../../src/database/schema.ts';

rs.mock('../../src/database/schema.ts', () => {
  const pricingSchema = pgSchema('pricing');
  return {
    gatewayAssertionRedemptions: pricingSchema.table('gateway_assertion_redemptions', {
      audience: text('audience').notNull(),
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
      issuer: text('issuer').notNull(),
      jti: uuid('jti').notNull(),
      redeemedAt: timestamp('redeemed_at', { withTimezone: true }).defaultNow().notNull(),
    }),
  };
});

const assertion = {
  audience: 'pricing',
  expiresAtEpochSeconds: 1_700_000_300,
  issuer: 'https://shell.ontos.test',
  jti: '60000000-0000-4000-8000-000000000797',
};
const expiryWithSkewMs = (assertion.expiresAtEpochSeconds + GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS) * 1000;
const pricingGatewayAssertionRedemptionRelations = defineRelations({ gatewayAssertionRedemptions });

// Native Drizzle and SqlClient own transaction settlement; only the wire connection is replaced.
const makeRedemptionFixture = (
  execute: (sql: string, params: readonly unknown[]) => Effect.Effect<readonly object[], SqlError>,
) =>
  Effect.scoped(
    Effect.gen(function* makeRedemptionFixtureEffect() {
      const context = yield* Layer.build(
        scriptedPgClientLayer(Effect.succeed(testSqlConnection(execute))).pipe(Layer.provideMerge(Reactivity.layer)),
      );
      const executor = yield* makeWithDefaults({
        relations: pricingGatewayAssertionRedemptionRelations,
      }).pipe(Effect.provide(context));
      const clock = yield* TestClock.make();
      yield* clock.setTime(expiryWithSkewMs - 1);
      return { clock, redemption: makeGatewayAssertionRedemption(executor) };
    }),
  );

it.effect('atomically accepts first use and rejects a repeated durable identity', () =>
  Effect.gen(function* acceptOnlyFirstUse() {
    const redeemed = new Set<string>();
    const statements: string[] = [];
    const fixture = yield* makeRedemptionFixture((sql, params) => {
      statements.push(sql);
      if (!sql.startsWith('insert')) {
        return Effect.succeed([]);
      }
      const key = params.join('|');
      if (redeemed.has(key)) {
        return Effect.succeed([]);
      }
      redeemed.add(key);
      return Effect.succeed([{ jti: assertion.jti }]);
    });

    yield* fixture.redemption.consume(assertion).pipe(Effect.provideService(Clock.Clock, fixture.clock));
    const failure = yield* fixture.redemption
      .consume(assertion)
      .pipe(Effect.provideService(Clock.Clock, fixture.clock), Effect.flip);

    expect(Schema.is(GatewayAssertionReplayError)(failure)).toBe(true);
    expect(statements.filter((statement) => statement === 'BEGIN')).toHaveLength(2);
    expect(statements.filter((statement) => statement === 'COMMIT')).toHaveLength(2);
  }),
);

it.effect('serializes concurrent redemption through the durable unique identity', () =>
  Effect.gen(function* acceptOnlyOneConcurrentUse() {
    const redeemed = new Set<string>();
    const fixture = yield* makeRedemptionFixture((sql, params) => {
      if (!sql.startsWith('insert')) {
        return Effect.succeed([]);
      }
      const key = params.join('|');
      if (redeemed.has(key)) {
        return Effect.succeed([]);
      }
      redeemed.add(key);
      return Effect.succeed([{ jti: assertion.jti }]);
    });
    const attempts = yield* Effect.all(
      [
        fixture.redemption.consume(assertion).pipe(Effect.provideService(Clock.Clock, fixture.clock), Effect.result),
        fixture.redemption.consume(assertion).pipe(Effect.provideService(Clock.Clock, fixture.clock), Effect.result),
      ],
      { concurrency: 'unbounded' },
    );

    expect(attempts.filter(Result.isSuccess)).toHaveLength(1);
    const failed = attempts.find(Result.isFailure);
    assert.isDefined(failed);
    if (Result.isFailure(failed)) {
      expect(Schema.is(GatewayAssertionReplayError)(failed.failure)).toBe(true);
    }
  }),
);

it.effect('keys redemption by issuer, audience, and jti rather than jti alone', () =>
  Effect.gen(function* preserveCompleteDurableIdentity() {
    const redeemed = new Set<string>();
    const fixture = yield* makeRedemptionFixture((sql, params) => {
      if (!sql.startsWith('insert')) {
        return Effect.succeed([]);
      }
      const key = params.join('|');
      if (redeemed.has(key)) {
        return Effect.succeed([]);
      }
      redeemed.add(key);
      return Effect.succeed([{ jti: assertion.jti }]);
    });

    for (const input of [
      assertion,
      { ...assertion, issuer: 'https://another-shell.ontos.test' },
      { ...assertion, audience: 'another-pricing' },
    ]) {
      yield* fixture.redemption.consume(input).pipe(Effect.provideService(Clock.Clock, fixture.clock));
    }
    expect(redeemed.size).toBe(3);
  }),
);

it.effect('rejects expiry before cleanup and uses the skew-adjusted cleanup boundary', () =>
  Effect.gen(function* preserveExpiredReplayEvidence() {
    const statementParameters: { readonly params: readonly unknown[]; readonly sql: string }[] = [];
    const fixture = yield* makeRedemptionFixture((sql, params) => {
      statementParameters.push({ params, sql });
      return Effect.succeed(sql.startsWith('insert') ? [{ jti: assertion.jti }] : []);
    });

    yield* fixture.redemption.consume(assertion).pipe(Effect.provideService(Clock.Clock, fixture.clock));
    const cleanup = statementParameters.find(({ sql }) => sql.startsWith('delete'));
    expect(cleanup?.params).toContain(
      DateTime.toDateUtc(
        DateTime.makeUnsafe(expiryWithSkewMs - 1 - GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS * 1000),
      ).toISOString(),
    );
    statementParameters.length = 0;

    yield* fixture.clock.setTime(expiryWithSkewMs);
    const failure = yield* fixture.redemption
      .consume(assertion)
      .pipe(Effect.provideService(Clock.Clock, fixture.clock), Effect.flip);
    expect(Schema.is(GatewayAssertionReplayError)(failure)).toBe(true);
    expect(statementParameters).toEqual([]);
  }),
);

it.effect('maps SQL failures to a sanitized redemption-unavailable error', () =>
  Effect.gen(function* sanitizeSqlFailure() {
    const sqlFailure = new SqlError({
      reason: new ConnectionError({
        cause: new Error('private pricing fixture database details'),
        message: 'private pricing fixture connection details',
        operation: 'execute',
      }),
    });
    const fixture = yield* makeRedemptionFixture(() => Effect.fail(sqlFailure));
    const failure = yield* fixture.redemption
      .consume(assertion)
      .pipe(Effect.provideService(Clock.Clock, fixture.clock), Effect.flip);
    expect(Schema.is(GatewayAssertionRedemptionUnavailableError)(failure)).toBe(true);
    const serializedFailure = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(failure);
    expect(serializedFailure).not.toMatch(/private pricing fixture/u);
  }),
);

for (const settlement of ['COMMIT', 'ROLLBACK']) {
  it.effect(`maps native ${settlement} SQL defects to sanitized redemption unavailability`, () =>
    Effect.gen(function* rejectSqlSettlementFailure() {
      const sqlFailure = new SqlError({
        reason: new ConnectionError({
          cause: new Error('private pricing fixture database details'),
          message: 'private pricing fixture connection details',
          operation: settlement,
        }),
      });
      const fixture = yield* makeRedemptionFixture((sql) => {
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
      expect(serializedFailure).not.toMatch(/private pricing fixture/u);
    }),
  );
}

it.effect('preserves unrelated transaction defects', () =>
  Effect.gen(function* preserveProgrammingDefect() {
    const defect = new Error('pricing fixture programming defect');
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

it.effect('fails with sanitized unavailability after five seconds', () =>
  Effect.gen(function* enforceRedemptionDeadline() {
    const fixture = yield* makeRedemptionFixture((sql) =>
      sql.startsWith('delete') ? Effect.never : Effect.succeed([]),
    );
    const fiber = yield* fixture.redemption
      .consume(assertion)
      .pipe(Effect.provideService(Clock.Clock, fixture.clock), Effect.forkChild);
    yield* Effect.yieldNow;
    yield* fixture.clock.setTime(expiryWithSkewMs - 1 + 5000);
    const failure = yield* Fiber.join(fiber).pipe(Effect.flip);
    expect(Schema.is(GatewayAssertionRedemptionUnavailableError)(failure)).toBe(true);
  }),
);
