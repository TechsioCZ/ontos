import { GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS } from '@app/shared-contracts';
import { recoverSqlTransactionError } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { Clock, Context, DateTime, Duration, Effect, Layer, Schema } from 'effect';

import { AuthDatabase } from './db/client.ts';
import { gatewayRelayExchanges } from './db/schema.ts';
import type { AuthDatabaseExecutor } from './db/types.ts';

import { GatewayRelayExchangeReplay } from './gateway-relay-exchange-replay.ts';
import { GatewayRelayExchangeUnavailable } from './gateway-relay-exchange-unavailable.ts';

export { GatewayRelayExchangeReplay } from './gateway-relay-exchange-replay.ts';
export { GatewayRelayExchangeUnavailable } from './gateway-relay-exchange-unavailable.ts';

export interface GatewayRelayExchangeInput {
  readonly exchangeId: string;
  readonly expiresAtEpochSeconds: number;
  readonly requestFingerprint: string;
  readonly sourceJti: string;
}

const exchangeInputSchema = Schema.Struct({
  exchangeId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('GatewayRelayExchangeId')),
  expiresAtEpochSeconds: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  requestFingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  sourceJti: Schema.String.check(Schema.isUUID()),
});

export class GatewayRelayExchangeLedger extends Context.Service<
  GatewayRelayExchangeLedger,
  {
    readonly reserve: (
      input: GatewayRelayExchangeInput,
    ) => Effect.Effect<void, GatewayRelayExchangeReplay | GatewayRelayExchangeUnavailable>;
  }
>()('@app/shell-super-app/api/auth/gateway-relay-exchanges.service/GatewayRelayExchangeLedger') {}

const unavailable = (cause: unknown) =>
  new GatewayRelayExchangeUnavailable({ cause, reason: 'Gateway exchange persistence is unavailable' });
const replay = () =>
  new GatewayRelayExchangeReplay({ reason: 'Gateway exchange has already been reserved or expired' });

/** Authentication mechanics only: no token, credential, business payload or permission decision is stored. */
export const makeGatewayRelayExchangeLedger = (
  executor: Pick<AuthDatabaseExecutor, 'execute' | 'insert'>,
): typeof GatewayRelayExchangeLedger.Service => ({
  reserve: Effect.fn('GatewayRelayExchangeLedger.reserve')(function* reserve(input: GatewayRelayExchangeInput) {
    const decoded = yield* Schema.decodeEffect(exchangeInputSchema)(input).pipe(Effect.mapError(unavailable));
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.succeed(decoded).pipe(
      Effect.filterOrFail(
        (exchange) => Duration.toMillis(Duration.seconds(exchange.expiresAtEpochSeconds)) > now,
        replay,
      ),
    );
    // The verifier can still accept a proof within clock skew. Keep its replay slot throughout that interval.
    const cleanupBefore = DateTime.toDateUtc(
      DateTime.makeUnsafe(now - Duration.toMillis(Duration.seconds(GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS))),
    );
    yield* executor
      .execute(sql`
      delete from ${gatewayRelayExchanges}
      where (source_jti, exchange_id) in (
        select source_jti, exchange_id from ${gatewayRelayExchanges}
        where expires_at < ${cleanupBefore}
        order by expires_at limit 256
      )
    `)
      .pipe(recoverSqlTransactionError, Effect.mapError(unavailable));
    const inserted = yield* executor
      .insert(gatewayRelayExchanges)
      .values({
        exchangeId: decoded.exchangeId,
        expiresAt: DateTime.toDateUtc(
          DateTime.makeUnsafe(Duration.toMillis(Duration.seconds(decoded.expiresAtEpochSeconds))),
        ),
        requestFingerprint: decoded.requestFingerprint,
        sourceJti: decoded.sourceJti,
      })
      .onConflictDoNothing({ target: [gatewayRelayExchanges.sourceJti, gatewayRelayExchanges.exchangeId] })
      .returning({ exchangeId: gatewayRelayExchanges.exchangeId })
      .pipe(recoverSqlTransactionError, Effect.mapError(unavailable));
    yield* Effect.succeed(inserted).pipe(Effect.filterOrFail((rows) => rows.length === 1, replay));
  }),
});

export const GatewayRelayExchangeLedgerLive = Layer.effect(
  GatewayRelayExchangeLedger,
  Effect.gen(function* relayLedger() {
    const database = yield* AuthDatabase;
    return makeGatewayRelayExchangeLedger(database.executor);
  }),
);
