import {
  CurrentSupportedCurrenciesRequestSchema,
  CurrentSupportedCurrenciesSuccessSchema,
} from '@app/pricing-contracts/current-supported-currencies';
import type {
  CurrentSupportedCurrenciesRequest,
  CurrentSupportedCurrenciesResponse,
} from '@app/pricing-contracts/current-supported-currencies';
import { executeCurrentSupportedCurrenciesWithAuthorization } from '@app/pricing-contracts/current-supported-currencies/client';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import type { GatewayDelegationSubject } from '@app/shared-contracts/gateway-context-server';
import { Crypto, Effect, Match, Redacted, Schema } from 'effect';

import {
  PurchaseCurrencyDependencyUnavailable,
  unavailablePurchaseCurrencyDependency,
} from '../../shared/domain/purchase-currency-dependency.ts';
import type { PurchaseCurrencyPricingPortService } from '../../shared/domain/purchase-currency-pricing-port.ts';
import { PricingCurrencySupportSchema } from '../../shared/domain/purchase-currency-resolution.ts';

type CurrentSupportedCurrenciesClientEffect = ReturnType<typeof executeCurrentSupportedCurrenciesWithAuthorization>;
type CurrentSupportedCurrenciesClientFailure =
  CurrentSupportedCurrenciesClientEffect extends Effect.Effect<unknown, infer Failure, unknown> ? Failure : never;
type CurrentSupportedCurrenciesExecutor = (
  payload: CurrentSupportedCurrenciesRequest,
  credential: Redacted.Redacted,
  requestCorrelation: string,
  options: { readonly baseUrl: URL; readonly compositionRevision: string },
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

type DelegatedGatewayAcquisition = typeof acquireDelegatedGatewayContext;

const makePricingPort = (input: {
  readonly acquire: DelegatedGatewayAcquisition;
  readonly crypto: Crypto.Crypto;
  readonly execute: CurrentSupportedCurrenciesExecutor;
  readonly requestContext: {
    readonly requestCorrelation: string;
    readonly subject: GatewayDelegationSubject;
  };
}): PurchaseCurrencyPricingPortService => ({
  resolveCurrent: (request) =>
    requestPayload(request).pipe(
      Effect.flatMap((payload) =>
        input
          .acquire(
            {
              audience: 'pricing',
              callingAppId: 'commerce-customer-context',
              legalEntityScope: 'tenant',
              requestCorrelation: input.requestContext.requestCorrelation,
              subject: input.requestContext.subject,
            },
            input.crypto,
          )
          .pipe(
            Effect.mapError((cause) => unavailable('The Pricing gateway credential could not be issued', cause)),
            Effect.flatMap((issued) =>
              input.execute(payload, Redacted.make(issued.authorization), input.requestContext.requestCorrelation, {
                baseUrl: new URL(issued.apiBaseUrl),
                compositionRevision: issued.compositionRevision,
              }),
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

export const purchaseCurrencyPricingPortFromEnvironment = Effect.fn('PurchaseCurrencyPricing.portFromEnvironment')(
  function* purchaseCurrencyPricingPortFromEnvironment(
    requestContext: {
      readonly requestCorrelation: string;
      readonly subject: GatewayDelegationSubject;
    },
    execute: CurrentSupportedCurrenciesExecutor = executeAuthorizedCurrentSupportedCurrencies,
    acquire: DelegatedGatewayAcquisition = acquireDelegatedGatewayContext,
  ) {
    const crypto = yield* Crypto.Crypto;
    return makePricingPort({ acquire, crypto, execute, requestContext });
  },
);
