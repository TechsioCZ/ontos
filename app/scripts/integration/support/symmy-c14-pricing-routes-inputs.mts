import { randomUUID } from 'node:crypto';

import { executeCreateProductWithAuthorization } from '@app/catalog/api/client';
import { ProductActionInvocationIdSchema } from '@app/catalog/domain/product';
import { bootstrapInternalC14CatalogPricingReadiness } from '@app/catalog/testing/c14-pricing-readiness-native';
import { executeSetSupportedCurrenciesWithAuthorization } from '@app/pricing/api/client';
import { bootstrapInternalC14PriceInputFacts } from '@app/pricing/testing/c14-price-input-bootstrap';
import { CurrentSupportedCurrenciesRequestSchema } from '@app/pricing-contracts/current-supported-currencies';
import { executeCurrentSupportedCurrenciesWithAuthorization } from '@app/pricing-contracts/current-supported-currencies/client';
import { SetSupportedCurrenciesV2PayloadSchema } from '@app/pricing-contracts/domain/currency-support';
import { DateTime, Effect, Redacted, Schema } from 'effect';

import type { makeInternalC14PricingRouteFixture } from './symmy-c14-pricing-routes-runtime.mts';
import { SymmyC14ProductFixtureUnavailable } from './symmy-c14-product-runtime.mts';

type Fixture = Effect.Success<ReturnType<typeof makeInternalC14PricingRouteFixture>>;

/** Explicit internal owner prerequisites, obtained from real public Actions and the guarded Catalog test seam. */
export const bootstrapInternalC14PricingRouteInputs = Effect.fn('InternalC14PricingRoutes.inputs')(
  function* bootstrapInputs(fixture: Fixture) {
    const catalogGateway = yield* fixture.shell.issueFixtureSetupGateway({ audience: 'catalog' });
    const marketGateway = yield* fixture.shell.issueFixtureSetupGateway({
      audience: 'commerce-market-catalog',
      legalEntityId: fixture.legalEntityId,
    });
    const nativeInputs = yield* bootstrapInternalC14PriceInputFacts({
      market: {
        authorization: Redacted.make(`Bearer ${marketGateway.token}`),
        options: {
          baseUrl: `http://127.0.0.1:${fixture.marketPort}/commerce-market-catalog-api`,
          compositionRevision: fixture.snapshot.composition.revision,
          idempotencyKey: 'INTERNAL_C14_PRICE_ROUTE_MARKET',
        },
        payload: {
          channels: ['B2C'],
          effectivePeriod: { startsAt: yield* DateTime.now },
          jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
          lifecycle: 'ACTIVE',
          marketCode: 'INTERNAL_C14_PRICE_ROUTE_MARKET',
          marketId: randomUUID(),
          purpose: 'Explicit INTERNAL_C14 positive Price route fixture',
          reason: 'Explicit internal source-backed pricing context',
          sellingLegalEntityRef: {
            moduleId: 'core.identity',
            resourceId: fixture.legalEntityId,
            resourceType: 'core.identity.legal-entity',
            tenantId: fixture.tenantId,
          },
          supportedLocales: ['en'],
        },
        requestCorrelation: randomUUID(),
      },
      unit: {
        authorization: Redacted.make(`Bearer ${catalogGateway.token}`),
        options: {
          baseUrl: `http://127.0.0.1:${fixture.catalogPort}/catalog-api`,
          compositionRevision: fixture.snapshot.composition.revision,
          idempotencyKey: 'INTERNAL_C14_PRICE_ROUTE_UNIT',
        },
        payload: {
          code: 'INTERNAL_C14_PRICE_ROUTE_UNIT',
          evidenceRefs: ['internal:c14:explicit-whole-unit'],
          label: 'Explicit internal whole Unit',
          reason: 'Explicit INTERNAL_C14 Unit prerequisite',
          rule: { rounding: 'HALF_UP', step: '1' },
          unitRef: {
            moduleId: 'commerce.catalog',
            resourceId: randomUUID(),
            resourceType: 'commerce.catalog.product-unit',
            tenantId: fixture.tenantId,
          },
        },
        requestCorrelation: randomUUID(),
      },
    });
    const createKey = 'INTERNAL_C14_PRICE_ROUTE_PRODUCT';
    const productGateway = yield* fixture.shell.issueFixtureSetupGateway({ audience: 'catalog' });
    const created = yield* executeCreateProductWithAuthorization(
      { name: 'INTERNAL_C14 actual Price route Product', reason: 'Explicit fresh native Price fixture Product' },
      `Bearer ${productGateway.token}`,
      randomUUID(),
      {
        baseUrl: `http://127.0.0.1:${fixture.catalogPort}/catalog-api`,
        compositionRevision: fixture.snapshot.composition.revision,
        idempotencyKey: createKey,
      },
    );
    if (!('product' in created)) {
      return yield* new SymmyC14ProductFixtureUnavailable({
        message: 'The actual fresh Product create did not return native facts',
      });
    }
    const variant = created.product.variants.find(({ variantId }) => variantId === created.variantId);
    if (variant === undefined) {
      return yield* new SymmyC14ProductFixtureUnavailable({
        message: 'The actual Product result does not identify its initial Variant',
      });
    }
    const invocations = yield* fixture.admin`select action_invocation_id from core.action_invocations
      where tenant_id=${fixture.tenantId} and principal_id=${fixture.integration.issuerPrincipalId}
      and action_key='commerce.catalog.create-product' and idempotency_key=${createKey} and status='succeeded'`.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ action_invocation_id: ProductActionInvocationIdSchema })),
        ),
      ),
    );
    const invocation = invocations.length === 1 ? invocations[0] : undefined;
    if (invocation === undefined) {
      return yield* new SymmyC14ProductFixtureUnavailable({
        message: 'The actual original Product invocation could not be uniquely verified',
      });
    }
    const readinessGateway = yield* fixture.shell.issueFixtureSetupGateway({ audience: 'catalog' });
    const readiness = yield* bootstrapInternalC14CatalogPricingReadiness({
      expectedProductRevision: created.product.revision,
      expectedUnitRule: nativeInputs.unit.ruleRevision,
      expectedVariantRevision: 1,
      fixtureFacts: {
        categoryName: 'INTERNAL_C14 explicit pricing category',
        divisible: false,
        locale: 'en',
        localizedName: 'INTERNAL_C14 explicit priced realization',
        structuredAttributesRequired: false,
        variantAxesRequired: false,
      },
      operatorPrincipalId: fixture.integration.issuerPrincipalId,
      operatorProviderUserId: fixture.shell.providerUserId,
      originalCreateInvocationId: invocation.action_invocation_id,
      ownedDatabase: fixture.isolated,
      productRef: created.product.productRef,
      purpose: 'implementation-1096-registered-workload-gateway',
      runtimeConnectionString: Redacted.make(fixture.isolated.connections.runtime.connectionString),
      tenantId: fixture.tenantId,
      validation: {
        authorization: Redacted.make(`Bearer ${readinessGateway.token}`),
        baseUrl: `http://127.0.0.1:${fixture.catalogPort}/catalog-api`,
        compositionRevision: fixture.snapshot.composition.revision,
        requestCorrelation: randomUUID(),
      },
      variantRef: variant.variantRef,
    });
    const currencyGateway = yield* fixture.shell.issueFixtureSetupGateway({ audience: 'pricing' });
    const options = {
      baseUrl: `http://127.0.0.1:${fixture.pricingPort}/pricing-api`,
      compositionRevision: fixture.snapshot.composition.revision,
    };
    const at = DateTime.formatIso(yield* DateTime.now);
    const current = yield* executeCurrentSupportedCurrenciesWithAuthorization(
      yield* Schema.decodeUnknownEffect(CurrentSupportedCurrenciesRequestSchema)({
        effectiveAt: at,
        tenantId: fixture.tenantId,
      }),
      `Bearer ${currencyGateway.token}`,
      randomUUID(),
      options,
    );
    if (
      current.outcome !== 'SUPPORTED_CURRENCIES_UNAVAILABLE' ||
      current.code !== 'pricing_currency_support_not_initialized'
    ) {
      return yield* new SymmyC14ProductFixtureUnavailable({
        message: 'The fresh fixture CurrencySupport state was not absent',
      });
    }
    const currencySetGateway = yield* fixture.shell.issueFixtureSetupGateway({ audience: 'pricing' });
    yield* executeSetSupportedCurrenciesWithAuthorization(
      yield* Schema.decodeUnknownEffect(SetSupportedCurrenciesV2PayloadSchema)({
        expectedState: { state: 'ABSENT' },
        intendedEffectivePeriod: { effectiveFrom: at, effectiveTo: null },
        intent: 'ESTABLISH_CURRENT',
        reason: 'INTERNAL_C14 explicit CZK prerequisite, no inferred currency',
        schemaVersion: '2',
        supportedCurrencies: ['CZK'],
      }),
      `Bearer ${currencySetGateway.token}`,
      randomUUID(),
      { ...options, idempotencyKey: 'INTERNAL_C14_PRICE_ROUTE_CURRENCY' },
    );
    return { ...nativeInputs, readiness };
  },
);
