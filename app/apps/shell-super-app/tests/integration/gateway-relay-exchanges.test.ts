import { randomUUID } from 'node:crypto';

import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS } from '@app/shared-contracts';
import { eq, inArray, sql } from 'drizzle-orm';
import { Clock, DateTime, Duration, Effect, Exit, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeAuthDatabase } from '../../api/auth/db/client.ts';
import { gatewayRelayExchanges } from '../../api/auth/db/schema.ts';
import { makeGatewayRelayExchangeLedger } from '../../api/auth/gateway-relay-exchanges.service.ts';

it.live(
  'durably rejects replay across separate ledger instances, including changed request tuples and concurrent claims',
  () =>
    Effect.scoped(
      Effect.gen(function* durableReplay() {
        const connections = yield* loadDatabaseConnectionPair();
        const config = { connectionString: connections.runtime.connectionString };
        const first = yield* makeAuthDatabase(config);
        const second = yield* makeAuthDatabase(config);
        const sourceJti = randomUUID();
        yield* Effect.addFinalizer(() =>
          first.executor
            .delete(gatewayRelayExchanges)
            .where(eq(gatewayRelayExchanges.sourceJti, sourceJti))
            .pipe(Effect.orDie),
        );
        const now = yield* Clock.currentTimeMillis;
        const input = {
          exchangeId: randomUUID(),
          expiresAtEpochSeconds:
            Math.floor(now / Duration.toMillis(Duration.seconds(1))) + Duration.toSeconds(Duration.minutes(5)),
          requestFingerprint: 'a'.repeat(64),
          sourceJti,
        };
        const claims = yield* Effect.all(
          [
            Effect.exit(makeGatewayRelayExchangeLedger(first.executor).reserve(input)),
            Effect.exit(makeGatewayRelayExchangeLedger(second.executor).reserve(input)),
          ],
          { concurrency: 2 },
        );
        expect(claims.filter(Exit.isSuccess)).toHaveLength(1);
        expect(claims.filter(Exit.isFailure)).toHaveLength(1);
        const changed = yield* Effect.flip(
          makeGatewayRelayExchangeLedger(second.executor).reserve({ ...input, requestFingerprint: 'b'.repeat(64) }),
        );
        expect(Predicate.isTagged(changed, 'GatewayRelayExchangeReplay')).toBe(true);
        const rows = yield* second.executor
          .select()
          .from(gatewayRelayExchanges)
          .where(eq(gatewayRelayExchanges.sourceJti, sourceJti));
        expect(rows).toHaveLength(1);
        expect(rows[0]?.requestFingerprint).toBe(input.requestFingerprint);
        expect(Object.keys(rows[0] ?? {}).toSorted()).toEqual([
          'createdAt',
          'exchangeId',
          'expiresAt',
          'requestFingerprint',
          'sourceJti',
        ]);
      }),
    ),
);

it.live('retains a consumed slot throughout source clock skew and cleans only fully expired slots', () =>
  Effect.scoped(
    Effect.gen(function* expiryWindow() {
      const connections = yield* loadDatabaseConnectionPair();
      const config = { connectionString: connections.runtime.connectionString };
      const database = yield* makeAuthDatabase(config);
      const sourceJti = randomUUID();
      yield* Effect.addFinalizer(() =>
        database.executor
          .delete(gatewayRelayExchanges)
          .where(eq(gatewayRelayExchanges.sourceJti, sourceJti))
          .pipe(Effect.orDie),
      );
      const now = yield* Clock.currentTimeMillis;
      const retained = randomUUID();
      const expired = randomUUID();
      yield* database.executor.insert(gatewayRelayExchanges).values([
        {
          exchangeId: retained,
          expiresAt: DateTime.toDateUtc(
            DateTime.makeUnsafe(now - Duration.toMillis(Duration.seconds(GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS)) / 2),
          ),
          requestFingerprint: 'a'.repeat(64),
          sourceJti,
        },
        {
          exchangeId: expired,
          expiresAt: DateTime.toDateUtc(
            DateTime.makeUnsafe(
              now -
                Duration.toMillis(Duration.seconds(GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS)) -
                Duration.toMillis(Duration.minutes(1)),
            ),
          ),
          requestFingerprint: 'b'.repeat(64),
          sourceJti,
        },
      ]);
      const ledger = makeGatewayRelayExchangeLedger(database.executor);
      yield* ledger.reserve({
        exchangeId: randomUUID(),
        expiresAtEpochSeconds:
          Math.floor(now / Duration.toMillis(Duration.seconds(1))) + Duration.toSeconds(Duration.minutes(5)),
        requestFingerprint: 'c'.repeat(64),
        sourceJti,
      });
      const rows = yield* database.executor
        .select()
        .from(gatewayRelayExchanges)
        .where(inArray(gatewayRelayExchanges.exchangeId, [retained, expired]));
      expect(rows.map((row) => row.exchangeId)).toEqual([retained]);
      const stale = yield* Effect.flip(
        ledger.reserve({
          exchangeId: randomUUID(),
          expiresAtEpochSeconds: Math.floor(now / Duration.toMillis(Duration.seconds(1))) - 1,
          requestFingerprint: 'd'.repeat(64),
          sourceJti,
        }),
      );
      expect(Predicate.isTagged(stale, 'GatewayRelayExchangeReplay')).toBe(true);
    }),
  ),
);

it.live('returns a typed unavailable outcome for a real PostgreSQL write failure', () =>
  Effect.scoped(
    Effect.gen(function* databaseFailure() {
      const connections = yield* loadDatabaseConnectionPair();
      const database = yield* makeAuthDatabase({ connectionString: connections.runtime.connectionString });
      const now = yield* Clock.currentTimeMillis;
      const sourceJti = randomUUID();
      const failure = yield* Effect.flip(
        database.executor.transaction(
          Effect.fnUntraced(function* readonlyTransaction(transaction) {
            yield* transaction.execute(sql`set transaction read only`);
            return yield* makeGatewayRelayExchangeLedger(transaction).reserve({
              exchangeId: randomUUID(),
              expiresAtEpochSeconds:
                Math.floor(now / Duration.toMillis(Duration.seconds(1))) + Duration.toSeconds(Duration.minutes(5)),
              requestFingerprint: 'e'.repeat(64),
              sourceJti,
            });
          }),
        ),
      );
      expect(Predicate.isTagged(failure, 'GatewayRelayExchangeUnavailable')).toBe(true);
      expect(
        yield* database.executor
          .select()
          .from(gatewayRelayExchanges)
          .where(eq(gatewayRelayExchanges.sourceJti, sourceJti)),
      ).toEqual([]);
    }),
  ),
);
