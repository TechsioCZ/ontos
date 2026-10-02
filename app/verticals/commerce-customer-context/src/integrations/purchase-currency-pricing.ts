import {
  CurrentSupportedCurrenciesRequestSchema,
  CurrentSupportedCurrenciesSuccessSchema,
  executeCurrentSupportedCurrenciesWithAuthorization,
} from '@app/pricing-contracts';
import type { CurrentSupportedCurrenciesRequest, CurrentSupportedCurrenciesResponse } from '@app/pricing-contracts';
import { Effect, Match, Option, Redacted, Schema } from 'effect';

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
import { PricingCurrencySupportSchema } from '../../shared/domain/purchase-currency-resolution.ts';

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

const unverifiable = (reason: string, cause: unknown): PurchaseCurrencyDependencyUnavailable => {
  const failure = unavailablePurchaseCurrencyDependency('pricing_currency_support_unverifiable', reason);
  return Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

const ownerFailure = (
  result: Exclude<CurrentSupportedCurrenciesResponse, { readonly outcome: 'SUPPORTED_CURRENCIES_CURRENT' }>,
): PurchaseCurrencyDependencyUnavailable => {
  const code = Match.value(result).pipe(
    Match.discriminator('outcome')('SUPPORTED_CURRENCIES_INVALID', () => 'pricing_currency_support_invalid' as const),
    Match.discriminator('outcome')('SUPPORTED_CURRENCIES_STALE', () => 'pricing_currency_support_stale' as const),
    Match.discriminator('outcome')(
      'SUPPORTED_CURRENCIES_UNAVAILABLE',
      () => 'pricing_currency_support_unavailable' as const,
    ),
    Match.discriminator('outcome')(
      'SUPPORTED_CURRENCIES_UNVERIFIABLE',
      () => 'pricing_currency_support_unverifiable' as const,
    ),
    Match.exhaustive,
  );
  return unavailablePurchaseCurrencyDependency(
    code,
    `Pricing could not establish Current supported currencies: ${result.reason}`,
  );
};

const ownerSupportEvidence = (
  result: Extract<CurrentSupportedCurrenciesResponse, { readonly outcome: 'SUPPORTED_CURRENCIES_CURRENT' }>,
) => {
  const untrustedResult: unknown = result;
  return Schema.decodeUnknownEffect(CurrentSupportedCurrenciesSuccessSchema)(untrustedResult).pipe(
    Effect.flatMap(({ outcome: _outcome, ...supportEvidence }) =>
      Schema.decodeEffect(PricingCurrencySupportSchema)(supportEvidence),
    ),
    Effect.mapError((cause) => unverifiable('Pricing returned inconsistent Currency Support evidence', cause)),
  );
};

const requestPayload = (
  input: Parameters<PurchaseCurrencyPricingPortService['resolveCurrent']>[0],
): Effect.Effect<CurrentSupportedCurrenciesRequest, PurchaseCurrencyDependencyUnavailable> =>
  Schema.decodeEffect(CurrentSupportedCurrenciesRequestSchema)({
    effectiveAt: input.effectiveAt,
    tenantId: input.tenantId,
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
          ? ownerSupportEvidence(result)
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
