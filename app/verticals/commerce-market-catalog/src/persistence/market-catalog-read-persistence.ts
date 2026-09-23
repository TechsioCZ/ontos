import type { ReadServiceFactory, ScopedRoutineInvocationError } from '@app/core-runtime';
import { OperationContextUnavailable, defineScopedRoutine } from '@app/core-runtime';
import { DateTime, Effect, Option, Schema } from 'effect';

import type {
  CurrentMarketCatalogRequest,
  CurrentMarketCatalogResponse,
} from '../../shared/apis/current-market-catalog.ts';
import { CurrentMarketCatalogResponseSchema } from '../../shared/apis/current-market-catalog.ts';
import type { MarketHistoryResponse } from '../../shared/apis/market-history.ts';
import { MarketHistoryResponseSchema } from '../../shared/apis/market-history.ts';

const CurrentCatalogRowSchema = Schema.Struct({ payload: Schema.Unknown });
const MarketHistoryRowSchema = Schema.Struct({ payload: Schema.Unknown });
const ownerModuleKey = 'commerce.market-catalog';
const schema = 'commerce_market_catalog';
const parameters = [
  { source: 'tenantId', type: 'uuid' },
  { source: 'legalEntityId', type: 'uuid' },
  { source: 'input', type: 'jsonb' },
] as const;

const readCurrentMarketCatalogRoutine = defineScopedRoutine({
  name: 'read_current_market_catalog',
  ownerModuleKey,
  parameters,
  resultSchema: CurrentCatalogRowSchema,
  routineKey: 'market-catalog-read.current',
  schema,
});

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

export interface MarketCatalogReadPersistence {
  readonly current: (
    input: CurrentMarketCatalogRequest,
  ) => Effect.Effect<CurrentMarketCatalogResponse, MarketCatalogReadPersistenceUnavailable>;
  readonly history: (
    marketId: string,
  ) => Effect.Effect<Option.Option<MarketHistoryResponse>, MarketCatalogReadPersistenceUnavailable>;
}

const unavailable = (cause?: unknown) => {
  const failure = new MarketCatalogReadPersistenceUnavailable({
    code: 'market_catalog_read_persistence_unavailable',
    reason: 'Commerce Market Catalog owner state is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

export const marketCatalogReadPersistenceForScope: ReadServiceFactory<MarketCatalogReadPersistence> = (
  transaction,
  scope,
) => {
  if (scope.legalEntityId === undefined) {
    return Effect.fail(
      new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Commerce Market Catalog reads require a trusted Legal Entity scope',
      }),
    );
  }

  const current: MarketCatalogReadPersistence['current'] = Effect.fn('MarketCatalogReadPersistence.current')(
    function* currentCatalog(input) {
      const rows = yield* transaction
        .invoke(readCurrentMarketCatalogRoutine, [{ at: DateTime.formatIso(input.at) }])
        .pipe(Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)));
      const [row] = rows;
      return row === undefined
        ? yield* unavailable('The governed Current Market Catalog routine returned no owner snapshot')
        : yield* Schema.decodeUnknownEffect(CurrentMarketCatalogResponseSchema)(row.payload).pipe(
            Effect.mapError(unavailable),
          );
    },
  );

  const history: MarketCatalogReadPersistence['history'] = Effect.fn('MarketCatalogReadPersistence.history')(
    function* marketHistory(marketId) {
      const rows = yield* transaction
        .invoke(readMarketHistoryRoutine, [{ marketId }])
        .pipe(Effect.mapError((cause: ScopedRoutineInvocationError) => unavailable(cause)));
      const [row] = rows;
      if (row === undefined) {
        return Option.none();
      }
      const decoded = yield* Schema.decodeUnknownEffect(MarketHistoryResponseSchema)(row.payload).pipe(
        Effect.mapError(unavailable),
      );
      return Option.some(decoded);
    },
  );

  return Effect.succeed(Object.freeze({ current, history }));
};
