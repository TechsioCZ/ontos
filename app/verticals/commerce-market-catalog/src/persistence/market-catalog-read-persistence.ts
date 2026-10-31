import type { ReadServiceFactory, ScopedRoutineInvocationError } from '@app/core-runtime';
import { OperationContextUnavailable, defineScopedRoutine } from '@app/core-runtime';
import { DateTime, Effect, Schema } from 'effect';
import type { Option } from 'effect';

import type {
  CurrentMarketCatalogRequest,
  CurrentMarketCatalogResponse,
} from '../../shared/apis/current-market-catalog.ts';
import { CurrentMarketCatalogResponseSchema } from '../../shared/apis/current-market-catalog.ts';
import type { MarketHistoryResponse } from '../../shared/apis/market-history.ts';
import type { MarketCatalogReadPersistenceUnavailable } from './market-history-routine.ts';
import { marketCatalogReadUnavailable as unavailable, readMarketHistoryWithInvoker } from './market-history-routine.ts';

const CurrentCatalogRowSchema = Schema.Struct({ payload: Schema.Unknown });
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

export interface MarketCatalogReadPersistence {
  readonly current: (
    input: CurrentMarketCatalogRequest,
  ) => Effect.Effect<CurrentMarketCatalogResponse, MarketCatalogReadPersistenceUnavailable>;
  readonly history: (
    marketId: string,
  ) => Effect.Effect<Option.Option<MarketHistoryResponse>, MarketCatalogReadPersistenceUnavailable>;
}

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

  const history: MarketCatalogReadPersistence['history'] = (marketId) =>
    readMarketHistoryWithInvoker(transaction, marketId);

  return Effect.succeed(Object.freeze({ current, history }));
};
