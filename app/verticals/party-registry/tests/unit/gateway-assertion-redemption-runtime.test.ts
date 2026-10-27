// @effect-diagnostics strictEffectProvide:off -- Test-owned scripted database entrypoint; expires: 2026-12-31.
import { GatewayAssertionReplayError } from '@app/core-runtime';
import { GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS } from '@app/shared-contracts';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Cause, Clock, Effect, Exit, Layer, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';
import { Reactivity } from 'effect/reactivity';
import type { SqlError } from 'effect/sql/SqlError';

import { scriptedPgClientLayer } from '../../../../packages/core-runtime/src/testing/scripted-pg-client.ts';
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
const redemptionInsertPrefix = 'insert into "contacts"."gateway_assertion_redemptions"';

// Native Drizzle and SqlClient run the production redemption transaction; only the wire connection is replaced.
const makeRedemptionFixture = (
  execute: (sql: string, params: readonly unknown[]) => Effect.Effect<readonly object[], SqlError>,
) =>
  Effect.gen(function* makeRedemptionFixtureEffect() {
    const executor = yield* makeWithDefaults({
      relations: partyRelations,
    }).pipe(
      Effect.provide(
        scriptedPgClientLayer(Effect.succeed(testSqlConnection(execute))).pipe(Layer.provideMerge(Reactivity.layer)),
      ),
    );
    const clock = yield* TestClock.make();
    yield* clock.setTime(expiryWithSkewMs - 1);
    return { clock, redemption: makeGatewayAssertionRedemption(executor) };
  });

it.effect('preserves unrelated redemption statement defects', () =>
  Effect.gen(function* preserveProgrammingDefect() {
    const defect = new Error('fixture programming defect');
    const statements: string[] = [];
    const fixture = yield* makeRedemptionFixture((sql) => {
      statements.push(sql);
      return sql.startsWith(redemptionInsertPrefix) ? Effect.die(defect) : Effect.succeed([]);
    });
    const exit = yield* fixture.redemption
      .consume(assertion)
      .pipe(Effect.provideService(Clock.Clock, fixture.clock), Effect.exit);
    assert.isOk(Exit.isFailure(exit));
    expect(statements.some((statement) => statement.startsWith(redemptionInsertPrefix))).toBe(true);
    expect(exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === defect)).toBe(true);
  }),
);

it.effect('rejects assertions crossing expiry before redemption without deleting replay evidence', () =>
  Effect.gen(function* preserveExpiredReplayEvidence() {
    const statements: string[] = [];
    const fixture = yield* makeRedemptionFixture((sql) => {
      statements.push(sql);
      return Effect.succeed(sql.startsWith(redemptionInsertPrefix) ? [{ jti: assertion.jti }] : []);
    });
    yield* fixture.redemption.consume(assertion).pipe(Effect.provideService(Clock.Clock, fixture.clock));
    expect(
      statements.some((statement) => statement.startsWith(redemptionInsertPrefix)),
      'the last millisecond of skew remains usable',
    ).toBe(true);
    const cleanupIndex = statements.findIndex((statement) =>
      statement.startsWith('select contacts.prune_expired_gateway_assertion_redemptions('),
    );
    const insertIndex = statements.findIndex((statement) => statement.startsWith(redemptionInsertPrefix));
    expect(cleanupIndex, 'usable assertions prune expired evidence').toBeGreaterThanOrEqual(0);
    expect(insertIndex).toBeGreaterThan(cleanupIndex);
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
