import type { OperationalScope } from '@app/core-runtime';
import type { Crypto } from 'effect';
import { acquireOwnerGatewayContext } from './server-owner-gateway.ts';
import {
  executeEligibleMarketTuplesWithAuthorization,
  executeResolveCommerceMarketWithAuthorization,
} from '@app/commerce-market-catalog/api/client';
import { Redacted, Effect } from 'effect';

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
export const marketBootstrapMarketPortFromPublishedClient = (
  scope: OperationalScope,
  crypto: Crypto.Crypto,
): MarketBootstrapMarketPortService => ({
  eligibleTuples: (input) =>
    acquireOwnerGatewayContext(scope, crypto, {
      audience: 'commerce-market-catalog',
      operationKey: 'commerce.market-catalog.api.eligible-market-tuples',
    }).pipe(
      Effect.flatMap((issued) =>
        executeEligibleMarketTuplesWithAuthorization(input, Redacted.value(issued.authorization), scope.correlationId, {
          baseUrl: issued.apiUrl,
          compositionRevision: issued.compositionRevision,
        }),
      ),
      Effect.mapError(unavailable),
    ),
  resolveMarket: (input) =>
    acquireOwnerGatewayContext(scope, crypto, {
      audience: 'commerce-market-catalog',
      operationKey: 'commerce.market-catalog.api.resolve-commerce-market',
    }).pipe(
      Effect.flatMap((issued) =>
        executeResolveCommerceMarketWithAuthorization(
          input,
          Redacted.value(issued.authorization),
          scope.correlationId,
          {
            baseUrl: issued.apiUrl,
            compositionRevision: issued.compositionRevision,
          },
        ),
      ),
      Effect.mapError(unavailable),
    ),
});
