import type {
  EligibleMarketTuplesRequest,
  EligibleMarketTuplesResponse,
  ResolveCommerceMarketRequest,
  ResolveCommerceMarketResponse,
} from '@app/commerce-market-catalog/api/client';
import type { Effect } from 'effect';

import type { MarketBootstrapDependencyUnavailable } from './market-bootstrap-dependency.ts';

// oxlint-disable-next-line effect-native/require-context-service-for-service-interface -- The bootstrap resolver receives this narrow owner port through its explicit services value.
export interface MarketBootstrapMarketPortService {
  readonly eligibleTuples: (
    input: EligibleMarketTuplesRequest,
    requestCorrelation: string,
  ) => Effect.Effect<EligibleMarketTuplesResponse, MarketBootstrapDependencyUnavailable>;
  readonly resolveMarket: (
    input: ResolveCommerceMarketRequest,
    requestCorrelation: string,
  ) => Effect.Effect<ResolveCommerceMarketResponse, MarketBootstrapDependencyUnavailable>;
}
