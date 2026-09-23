import {
  CurrentSupportedCurrenciesRequestSchema,
  executeCurrentSupportedCurrenciesWithAuthorization,
} from '@app/pricing-contracts';
import type { CurrentSupportedCurrenciesRequest, CurrentSupportedCurrenciesResponse } from '@app/pricing-contracts';
import { Effect, Option, Redacted, Schema } from 'effect';

import {
  PurchaseCurrencyDependencyUnavailable,
  unavailablePurchaseCurrencyDependency,
} from '../../shared/domain/purchase-currency-dependency.ts';
import {
  PurchaseCurrencyPricingGatewayCredentialService,
  unavailablePurchaseCurrencyPricingGatewayCredentialIssuer,
} from '../../shared/domain/purchase-currency-pricing-gateway-credential.ts';
import type { PurchaseCurrencyPricingGatewayCredentialIssuer } from '../../shared/domain/purchase-currency-pricing-gateway-credential.ts';
import type { PurchaseCurrencyPricingPortService } from '../../shared/domain/purchase-currency-pricing-port.ts';

type CurrentSupportedCurrenciesClientEffect = ReturnType<typeof executeCurrentSupportedCurrenciesWithAuthorization>;
type CurrentSupportedCurrenciesClientFailure =
  CurrentSupportedCurrenciesClientEffect extends Effect.Effect<unknown, infer Failure, unknown> ? Failure : never;
type CurrentSupportedCurrenciesExecutor = (
  payload: CurrentSupportedCurrenciesRequest,
  credential: Redacted.Redacted,
  requestCorrelation: string,
  options: { readonly baseUrl: URL },
) => Effect.Effect<CurrentSupportedCurrenciesResponse, CurrentSupportedCurrenciesClientFailure>;

const executeAuthorizedCurrentSupportedCurrencies: CurrentSupportedCurrenciesExecutor = (
  payload,
  credential,
  requestCorrelation,
  options,
) =>
  executeCurrentSupportedCurrenciesWithAuthorization(payload, Redacted.value(credential), requestCorrelation, options);

const unavailable = (reason: string, cause?: unknown): PurchaseCurrencyDependencyUnavailable => {
  const failure = unavailablePurchaseCurrencyDependency('pricing_currency_support_unavailable', reason);
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

const ownerFailure = (
  result: Exclude<CurrentSupportedCurrenciesResponse, { readonly outcome: 'SUPPORTED_CURRENCIES_CURRENT' }>,
): PurchaseCurrencyDependencyUnavailable =>
  unavailable(`Pricing could not establish Current supported currencies: ${result.reason}`);

const requestPayload = (
  input: Parameters<PurchaseCurrencyPricingPortService['resolveCurrent']>[0],
): Effect.Effect<CurrentSupportedCurrenciesRequest, PurchaseCurrencyDependencyUnavailable> =>
  Schema.decodeUnknownEffect(CurrentSupportedCurrenciesRequestSchema)({
    cartId: input.context.purchasingContext.cartId,
    channelId: input.context.purchasingContext.channelId,
    contextRevision: input.context.contextRevision,
    effectiveAt: input.observedAt,
    marketId: input.context.purchasingContext.marketId,
    sellingLegalEntityId: input.context.purchasingContext.sellingLegalEntityId,
    storefrontId: input.context.purchasingContext.storefrontId,
    subject: input.subject,
    tenantId: input.context.purchasingContext.tenantId,
  }).pipe(Effect.mapError((cause) => unavailable('The exact Pricing request context is invalid', cause)));

const makePricingPort = (input: {
  readonly execute: CurrentSupportedCurrenciesExecutor;
  readonly issuer: PurchaseCurrencyPricingGatewayCredentialIssuer;
  readonly requestContext: { readonly legalEntityId: string; readonly requestCorrelation: string };
}): PurchaseCurrencyPricingPortService => ({
  resolveCurrent: (request) =>
    requestPayload(request).pipe(
      Effect.flatMap((payload) =>
        input.issuer
          .issue({
            audience: 'pricing',
            legalEntityId: input.requestContext.legalEntityId,
            requestCorrelation: input.requestContext.requestCorrelation,
          })
          .pipe(
            Effect.flatMap(({ baseUrl, credential }) =>
              input.execute(payload, credential, input.requestContext.requestCorrelation, { baseUrl }),
            ),
            Effect.mapError((cause) =>
              Schema.is(PurchaseCurrencyDependencyUnavailable)(cause)
                ? cause
                : unavailable('The Current Pricing Currency Support owner is unavailable', cause),
            ),
          ),
      ),
      Effect.flatMap((result) =>
        result.outcome === 'SUPPORTED_CURRENCIES_CURRENT'
          ? Effect.succeed({
              pricingRevision: result.pricingRevision,
              supportedCurrencies: result.supportedCurrencies,
            })
          : Effect.fail(ownerFailure(result)),
      ),
    ),
});

export const purchaseCurrencyPricingPortFromEnvironment = (
  requestContext: { readonly legalEntityId: string; readonly requestCorrelation: string },
  execute: CurrentSupportedCurrenciesExecutor = executeAuthorizedCurrentSupportedCurrencies,
): Effect.Effect<PurchaseCurrencyPricingPortService> =>
  Effect.serviceOption(PurchaseCurrencyPricingGatewayCredentialService).pipe(
    Effect.map((issuerOption) =>
      makePricingPort({
        execute,
        issuer: Option.isSome(issuerOption)
          ? issuerOption.value
          : unavailablePurchaseCurrencyPricingGatewayCredentialIssuer,
        requestContext,
      }),
    ),
  );
