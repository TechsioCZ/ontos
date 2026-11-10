import type { OperationalScope } from '@app/core-runtime';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import type { Crypto } from 'effect';
import { Effect } from 'effect';
import {
  executeEligibleMarketTuplesWithAuthorization,
  executeResolveCommerceMarketWithAuthorization,
} from '@app/commerce-market-catalog/api/client';

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
): MarketBootstrapMarketPortService => {
  const admitted = acquireDelegatedGatewayContext(
    {
      audience: 'commerce-market-catalog',
      callingAppId: 'commerce-customer-context',
      legalEntityScope: 'subject',
      requestCorrelation: scope.correlationId,
      subject: { _tag: 'Assertion', scope },
    },
    crypto,
  );
  return {
    eligibleTuples: (input) =>
      admitted.pipe(
        Effect.flatMap((issued) =>
          executeEligibleMarketTuplesWithAuthorization(input, issued.authorization, scope.correlationId, {
            baseUrl: new URL(issued.apiBaseUrl),
            compositionRevision: issued.compositionRevision,
          }),
        ),
        Effect.mapError(unavailable),
      ),
    resolveMarket: (input) =>
      admitted.pipe(
        Effect.flatMap((issued) =>
          executeResolveCommerceMarketWithAuthorization(input, issued.authorization, scope.correlationId, {
            baseUrl: new URL(issued.apiBaseUrl),
            compositionRevision: issued.compositionRevision,
          }),
        ),
        Effect.mapError(unavailable),
      ),
  };
};
