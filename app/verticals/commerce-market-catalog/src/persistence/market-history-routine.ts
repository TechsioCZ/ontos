import { defineScopedRoutine } from '@app/core-runtime';
import type { ScopedRoutineInvocationError, ScopedRoutineInvoker } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';

import type { MarketHistoryResponse } from '../../shared/apis/market-history.ts';
import { MarketHistoryResponseSchema } from '../../shared/apis/market-history.ts';

// Worker-safe: the Outbox Worker host resolves @app/core-runtime to Core's worker entrypoint.
const MarketHistoryRowSchema = Schema.Struct({ payload: Schema.Unknown });
const ownerModuleKey = 'commerce.market-catalog';
const schema = 'commerce_market_catalog';
const parameters = [
  { source: 'tenantId', type: 'uuid' },
  { source: 'legalEntityId', type: 'uuid' },
  { source: 'input', type: 'jsonb' },
] as const;

const readMarketHistoryRoutine = defineScopedRoutine({
  name: 'read_market_history',
  ownerModuleKey,
  parameters,
  resultSchema: MarketHistoryRowSchema,
  routineKey: 'market-catalog-read.history',
  schema,
});

export class MarketCatalogReadPersistenceUnavailable extends Schema.TaggedError<MarketCatalogReadPersistenceUnavailable>()(
  'MarketCatalogReadPersistenceUnavailable',
  {
    code: Schema.Literal('market_catalog_read_persistence_unavailable'),
    reason: Schema.String,
  },
) {}

export const marketCatalogReadUnavailable = (cause?: unknown) => {
  const failure = new MarketCatalogReadPersistenceUnavailable({
    code: 'market_catalog_read_persistence_unavailable',
    reason: 'Commerce Market Catalog owner state is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

/** One Market's definitions and associations as the owner routine sees them in the invoker's Legal Entity scope. */
export const readMarketHistoryWithInvoker = Effect.fn('MarketCatalogReadPersistence.historyWithInvoker')(
  function* readMarketHistoryWithInvoker(invoker: ScopedRoutineInvoker, marketId: string) {
    const rows = yield* invoker
      .invoke(readMarketHistoryRoutine, [{ marketId }])
      .pipe(Effect.mapError((cause: ScopedRoutineInvocationError) => marketCatalogReadUnavailable(cause)));
    const [row] = rows;
    if (row === undefined) {
      return Option.none<MarketHistoryResponse>();
    }
    const decoded = yield* Schema.decodeUnknownEffect(MarketHistoryResponseSchema)(row.payload).pipe(
      Effect.mapError(marketCatalogReadUnavailable),
    );
    return Option.some(decoded);
  },
);
