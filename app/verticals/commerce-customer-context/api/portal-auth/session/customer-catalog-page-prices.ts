import { ReadHandlerUnavailable } from '@app/core-runtime';
import type { CatalogPagePricesPage } from '@app/pricing-contracts/catalog-page-prices';
import { executeCatalogPagePricesWithAuthorization } from '@app/pricing-contracts/catalog-page-prices/client';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import { Crypto, DateTime, Effect } from 'effect';

import { admittedCustomerPrincipal } from './own-customer-principal.ts';
import type { CustomerOwnPortalScope } from './own-customer-principal.ts';

const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: "The signed-in customer's catalogue page Prices are unavailable",
    }),
    'cause',
    { configurable: true, value: cause },
  );

/**
 * Pricing's catalogue page Prices for the signed-in customer. The freshly admitted customer is the person Pricing acts
 * for, and the customer's own Retail profile (the one the session is bound to) is the profile whose Price Group Pricing
 * asks this module for. Commerce's Price Group rule then decides inside that call; nothing here names a group.
 */
export const readCustomerOwnCatalogPagePrices = Effect.fn('CustomerOwnCatalogPagePrices.read')(function* read(
  scope: CustomerOwnPortalScope,
  page: CatalogPagePricesPage,
) {
  const principal = yield* admittedCustomerPrincipal(scope, unavailable);
  const crypto = yield* Crypto.Crypto;
  const requestCorrelation = yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable));
  const issued = yield* acquireDelegatedGatewayContext(
    {
      audience: 'pricing',
      callingAppId: 'commerce-customer-context',
      legalEntityScope: 'subject',
      requestCorrelation,
      subject: { _tag: 'Assertion', scope: principal },
    },
    crypto,
  ).pipe(Effect.mapError(unavailable));
  if (issued.expiresAt * 1000 <= DateTime.toEpochMillis(yield* DateTime.now)) {
    return yield* unavailable();
  }
  return yield* executeCatalogPagePricesWithAuthorization(
    {
      ...page,
      customer: {
        authorizationSubject: { kind: 'RETAIL' },
        profile: {
          kind: 'RETAIL',
          moduleId: 'commerce.customer-context',
          resourceId: scope.authority.profileId,
          resourceType: 'commerce.customer-context.retail-customer-profile',
          tenantId: scope.tenantId,
        },
      },
    },
    issued.authorization,
    requestCorrelation,
    { baseUrl: new URL(issued.apiBaseUrl), compositionRevision: issued.compositionRevision },
  ).pipe(Effect.mapError(unavailable));
});
