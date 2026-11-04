import { executeEligibleMarketTuples, executeResolveCommerceMarket } from '@app/commerce-market-catalog/api/client';
import { Effect } from 'effect';

import { MarketBootstrapDependencyUnavailable } from '../../shared/domain/market-bootstrap-dependency.ts';
import type { MarketBootstrapMarketPortService } from '../../shared/domain/market-bootstrap-market-port.ts';

const unavailable = (cause: unknown) => {
  const failure = new MarketBootstrapDependencyUnavailable({
    dependency: 'MARKET',
    reason: 'The Current Commerce Market owner is unavailable',
    retryable: true,
  });
  return Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

/** Contract-derived adapter; this module imports only the Market owner's published client. */
export const marketBootstrapMarketPortFromPublishedClient: MarketBootstrapMarketPortService = {
  eligibleTuples: (input, requestCorrelation) =>
    executeEligibleMarketTuples(input, requestCorrelation).pipe(Effect.mapError(unavailable)),
  resolveMarket: (input, requestCorrelation) =>
    executeResolveCommerceMarket(input, requestCorrelation).pipe(Effect.mapError(unavailable)),
};
