import { bootstrapInternalC14CatalogPricingReadiness } from '@app/catalog/testing/c14-pricing-readiness-native';
import { executeSetSupportedCurrenciesWithAuthorization } from '@app/pricing/api/client';
import { CurrentSupportedCurrenciesRequestSchema } from '@app/pricing-contracts/current-supported-currencies';
import { executeCurrentSupportedCurrenciesWithAuthorization } from '@app/pricing-contracts/current-supported-currencies/client';
import { SetSupportedCurrenciesV2PayloadSchema } from '@app/pricing-contracts/domain/currency-support';
import type { makeApiKeyGatewayNativeFixture } from '@app/shell-super-app/testing/api-key-gateway-native';
import { ExternalPriceSourceAuthorityGrantSchema } from '@app/pricing/testing/c14-source-authority';
import { Crypto, DateTime, Effect, Redacted, Schema } from 'effect';

import { internalProductPriceSource } from './symmy-c14-product-plan.mts';
import { SymmyC14ProductFixtureUnavailable } from './symmy-c14-product-runtime.mts';

/** The grant of one exact price identity, as an operator would capture it once the product and variant exist. */
export const makeInternalC14ProductPriceGrant = (input: {
  readonly effectiveFrom: string;
  readonly exactIdentityKey: typeof Schema.Json.Type;
  readonly marketId: string;
  readonly unitRef: typeof Schema.Json.Type;
  readonly verifiedAt: string;
}) => {
  const source = internalProductPriceSource({ marketId: input.marketId, unitRef: input.unitRef });
  return Schema.decodeUnknownEffect(ExternalPriceSourceAuthorityGrantSchema)({
    authority: source.sourceAuthority,
    effectivePeriod: { effectiveFrom: input.effectiveFrom },
    exactIdentityKey: input.exactIdentityKey,
    family: 'PRICE',
    mapping: source.mapping,
    ownerModuleId: 'commerce.pricing',
    schemaVersion: '1',
    verificationRef: 'INTERNAL_C14_EXPLICIT_OWNER_SOURCE_GRANT',
    verifiedAt: input.verifiedAt,
  });
};

/** Establish real mandatory facts before admission, never as an automatic source-create side effect. */
export const bootstrapInternalC14SupportedProductPriceFacts = Effect.fn('InternalC14Product.supportedPriceFacts')(
  function* bootstrap(input: {
    readonly catalogReadiness: Omit<Parameters<typeof bootstrapInternalC14CatalogPricingReadiness>[0], 'validation'>;
    readonly catalogUrl: string;
    readonly compositionRevision: string;
    readonly pricingUrl: string;
    readonly shell: Effect.Success<ReturnType<typeof makeApiKeyGatewayNativeFixture>>;
    readonly tenantId: string;
  }) {
    const crypto = yield* Crypto.Crypto;
    const catalogGateway = yield* input.shell.issueFixtureSetupGateway({ audience: 'catalog' });
    const readiness = yield* bootstrapInternalC14CatalogPricingReadiness({
      ...input.catalogReadiness,
      validation: {
        authorization: Redacted.make(`Bearer ${catalogGateway.token}`),
        baseUrl: input.catalogUrl,
        compositionRevision: input.compositionRevision,
        requestCorrelation: yield* crypto.randomUUIDv4(),
      },
    });
    const options = { baseUrl: input.pricingUrl, compositionRevision: input.compositionRevision };
    const at = DateTime.formatIso(yield* DateTime.now);
    const request = yield* Schema.decodeUnknownEffect(CurrentSupportedCurrenciesRequestSchema)({
      effectiveAt: at,
      tenantId: input.tenantId,
    });
    const initialGateway = yield* input.shell.issueFixtureSetupGateway({ audience: 'pricing' });
    const current = yield* executeCurrentSupportedCurrenciesWithAuthorization(
      request,
      `Bearer ${initialGateway.token}`,
      yield* crypto.randomUUIDv4(),
      options,
    );
    if (
      current.outcome !== 'SUPPORTED_CURRENCIES_UNAVAILABLE' ||
      current.code !== 'pricing_currency_support_not_initialized'
    ) {
      return yield* new SymmyC14ProductFixtureUnavailable({
        message: 'Expected absent CurrencySupport before explicit positive fixture configuration',
      });
    }
    const setGateway = yield* input.shell.issueFixtureSetupGateway({ audience: 'pricing' });
    yield* executeSetSupportedCurrenciesWithAuthorization(
      yield* Schema.decodeUnknownEffect(SetSupportedCurrenciesV2PayloadSchema)({
        expectedState: { state: 'ABSENT' },
        intendedEffectivePeriod: { effectiveFrom: at, effectiveTo: null },
        intent: 'ESTABLISH_CURRENT',
        reason: 'INTERNAL_C14 explicit CZK prerequisite for supported existing Product',
        schemaVersion: '2',
        supportedCurrencies: ['CZK'],
      }),
      `Bearer ${setGateway.token}`,
      yield* crypto.randomUUIDv4(),
      { ...options, idempotencyKey: 'INTERNAL_C14_PRODUCT_POSITIVE_CURRENCY' },
    );
    const afterGateway = yield* input.shell.issueFixtureSetupGateway({ audience: 'pricing' });
    const configured = yield* executeCurrentSupportedCurrenciesWithAuthorization(
      request,
      `Bearer ${afterGateway.token}`,
      yield* crypto.randomUUIDv4(),
      options,
    );
    if (configured.outcome !== 'SUPPORTED_CURRENCIES_CURRENT' || !configured.supportedCurrencies.includes('CZK')) {
      return yield* new SymmyC14ProductFixtureUnavailable({
        message: 'Native CurrencySupport did not verify the explicitly configured CZK',
      });
    }
    return readiness;
  },
);
