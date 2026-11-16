import type { ProductSchema } from '@app/catalog/domain/product';
import { CreateProductPayloadSchema } from '@app/catalog/api/create-product-action';
import { bootstrapInternalC14CatalogPricingReadiness } from '@app/catalog/testing/c14-pricing-readiness-native';
import type { ProductUnitRefSchema } from '@app/catalog/resources/product-unit';
import type { VariantRefSchema } from '@app/catalog/resources/variant';
import { DefinePricePayloadSchema } from '@app/pricing/actions/define-price';
import { executeSetSupportedCurrenciesWithAuthorization } from '@app/pricing/api/client';
import { CurrentSupportedCurrenciesRequestSchema } from '@app/pricing-contracts/current-supported-currencies';
import { executeCurrentSupportedCurrenciesWithAuthorization } from '@app/pricing-contracts/current-supported-currencies/client';
import { SetSupportedCurrenciesV2PayloadSchema } from '@app/pricing-contracts/domain/currency-support';
import type { makeApiKeyGatewayNativeFixture } from '@app/shell-super-app/testing/api-key-gateway-native';
import { ExternalPriceSourceAuthorityGrantSchema } from '@app/pricing/testing/c14-source-authority';
import { SymmyInternalExecutionPlanSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { Crypto, DateTime, Effect, Redacted, Schema } from 'effect';

import { internalProductSource } from './symmy-c14-product-plan.mts';
import { SymmyC14ProductFixtureUnavailable } from './symmy-c14-product-runtime.mts';

const catalogModule = 'commerce.catalog';
const readyEffectKey = 'catalog-ready-source';

export const internalPriceSource = {
  // Price facts in this scenario are records in the same explicit Product feed enrollment.
  namespace: internalProductSource.namespace,
  ownerModuleId: 'external.internal-c14',
  recordId: 'INTERNAL_C14_PRICE_CURRENCY_MISMATCH',
  sourceSystemRef: 'INTERNAL_C14_PRICE_SOURCE_SYSTEM',
};

/** Every referenced owner fact is an accepted native result; the new Price is only a proposed create. */
export const makeInternalC14PriceFailurePlan = Effect.fn('InternalC14Product.priceFailurePlan')(
  function* makePlan(input: {
    readonly at: string;
    readonly marketId: string;
    readonly priceId: string;
    readonly priceOccurrenceId: string;
    readonly product: typeof ProductSchema.Type;
    readonly productOccurrenceId: string;
    readonly sellingLegalEntityId: string;
    readonly sourceAssertionId: string;
    readonly unitRef: typeof ProductUnitRefSchema.Type;
    readonly variantRef: typeof VariantRefSchema.Type;
  }) {
    const pricingModule = 'commerce.pricing';
    const authority = { sourceAuthorityRef: 'INTERNAL_C14_PRICE_AUTHORITY', sourceAuthorityVersion: 'v1' };
    const mapping = {
      mappingContractRef: 'INTERNAL_C14_PRICE_MAPPING',
      mappingContractVersion: internalProductSource.mappingVersion,
    };
    const payload = yield* Schema.decodeUnknownEffect(DefinePricePayloadSchema)({
      effectiveFrom: input.at,
      identityKey: {
        catalogSelection: { productRef: input.product.productRef, variantRef: input.variantRef },
        commercialScope: {
          channelId: 'B2C',
          marketId: input.marketId,
          sellingLegalEntityId: input.sellingLegalEntityId,
        },
        currencyCode: 'CZK',
        priceGroupSelector: { kind: 'NO_GROUP' },
        unitBasis: { quantity: '1', unitRef: input.unitRef },
      },
      monetaryAmount: { amount: '25', currencyCode: 'CZK' },
      priceRef: {
        moduleId: pricingModule,
        resourceId: input.priceId,
        resourceType: 'commerce.pricing.price',
        tenantId: input.product.productRef.tenantId,
      },
      reason: 'INTERNAL_C14 native owner must reject contradictory source currency independently of Catalog',
      sourceAssertion: {
        lineage: { kind: 'INITIAL' },
        mapping,
        originalAssertion: {
          monetaryAmount: { amount: '25', currencyCode: 'USD' },
          monetaryBoundary: 'PRE_TAX',
          unitBasis: { quantity: '1', unitRef: input.unitRef },
        },
        sourceAssertionId: input.sourceAssertionId,
        sourceAuthority: authority,
        sourceRecord: {
          sourceChangeCorrelation: input.sourceAssertionId,
          sourceRecordRef: internalPriceSource.recordId,
          sourceRecordVersion: 'INTERNAL_C14_VERSION_1',
          sourceSystem: {
            ownerModuleId: internalPriceSource.ownerModuleId,
            sourceSystemRef: internalPriceSource.sourceSystemRef,
          },
        },
        timing: { importedAt: input.at, ownerBusinessEffectiveAt: input.at, sourceEffectiveAt: input.at },
      },
    });
    const grant = yield* Schema.decodeUnknownEffect(ExternalPriceSourceAuthorityGrantSchema)({
      authority,
      effectivePeriod: { effectiveFrom: input.at },
      exactIdentityKey: payload.identityKey,
      family: 'PRICE',
      mapping,
      ownerModuleId: pricingModule,
      schemaVersion: '1',
      verificationRef: 'INTERNAL_C14_EXPLICIT_OWNER_SOURCE_GRANT',
      verifiedAt: input.at,
    });
    const plan = yield* Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
      items: [
        {
          effects: [
            {
              effectKey: 'catalog-independent-update',
              intent: {
                _tag: 'CatalogUpdateProduct',
                payload: {
                  expectedRevision: input.product.revision,
                  productRef: input.product.productRef,
                  reason: 'INTERNAL_C14 independent accepted Catalog sibling',
                  targetLifecycle: 'DRAFT',
                },
              },
              operation: {
                entrypointKey: 'commerce.catalog.update-product',
                moduleId: catalogModule,
                schemaVersion: '1',
              },
              originalTarget: input.product.productRef,
            },
          ],
          itemKey: 'independent-product',
          source: {
            entityKind: 'PRODUCT',
            issuerId: internalProductSource.issuerId,
            sourceNamespace: internalProductSource.namespace,
            sourceRecordId: internalProductSource.productRecordId,
          },
          sourceOccurrenceId: input.productOccurrenceId,
        },
        {
          effects: [
            {
              effectKey: 'price-known-invalid',
              intent: { _tag: 'PriceDefine', payload: yield* Schema.encodeEffect(DefinePricePayloadSchema)(payload) },
              operation: {
                entrypointKey: 'commerce.pricing.define-price',
                moduleId: pricingModule,
                schemaVersion: '2',
              },
              originalTarget: payload.priceRef,
            },
          ],
          itemKey: 'independent-price',
          source: {
            entityKind: 'PRICE',
            issuerId: internalProductSource.issuerId,
            sourceNamespace: internalPriceSource.namespace,
            sourceRecordId: internalPriceSource.recordId,
          },
          sourceOccurrenceId: input.priceOccurrenceId,
        },
      ],
    });
    return { grant, payload, plan };
  },
);

export const internalReadyProductSource = {
  initialVariantRecordId: 'INTERNAL_C14_READY_INITIAL_VARIANT',
  recordId: 'INTERNAL_C14_READY_SOURCE_PRODUCT',
};

/** This preparation job creates DRAFT/WIP only. Readiness is an explicit later operator fixture step. */
export const makeInternalC14ReadyProductPreparation = Effect.fn('InternalC14Product.readyPreparation')(
  function* prepare(input: { readonly occurrenceId: string; readonly sourceRouteId: string }) {
    const createPayload = yield* Schema.decodeUnknownEffect(CreateProductPayloadSchema)({
      name: 'INTERNAL_C14 explicitly prepared existing source Product',
      sourceCorrelation: {
        initialVariantRecordId: internalReadyProductSource.initialVariantRecordId,
        issuerId: internalProductSource.issuerId,
        mappingRevision: internalProductSource.mappingVersion,
        recordId: internalReadyProductSource.recordId,
        recordNamespace: internalProductSource.namespace,
        routeScope: input.sourceRouteId,
        sourceOccurrenceId: input.occurrenceId,
      },
    });
    const plan = yield* Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
      items: [
        {
          effects: [
            {
              effectKey: readyEffectKey,
              intent: {
                _tag: 'CatalogCreateProduct',
                payload: yield* Schema.encodeEffect(CreateProductPayloadSchema)(createPayload),
              },
              operation: {
                entrypointKey: 'commerce.catalog.create-product',
                moduleId: catalogModule,
                schemaVersion: '2',
              },
            },
          ],
          itemKey: 'ready-source-product',
          source: {
            entityKind: 'PRODUCT',
            issuerId: internalProductSource.issuerId,
            sourceNamespace: internalProductSource.namespace,
            sourceRecordId: internalReadyProductSource.recordId,
          },
          sourceOccurrenceId: input.occurrenceId,
        },
      ],
    });
    return { createPayload, plan };
  },
);

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

/** Same-item acceptance uses a genuinely existing ready selection; Catalog create remains a semantic replay. */
export const makeInternalC14AcceptedProductPricePlan = Effect.fn('InternalC14Product.acceptedPricePlan')(
  function* makePlan(
    input: Parameters<typeof makeInternalC14PriceFailurePlan>[0] & {
      readonly createPayload: typeof CreateProductPayloadSchema.Type;
    },
  ) {
    const proposal = yield* makeInternalC14PriceFailurePlan(input);
    const payload = yield* Schema.decodeUnknownEffect(DefinePricePayloadSchema)({
      ...proposal.payload,
      reason: 'INTERNAL_C14 supported existing Product Price; no source-create activation inferred',
      sourceAssertion: {
        ...proposal.payload.sourceAssertion,
        originalAssertion: {
          ...proposal.payload.sourceAssertion.originalAssertion,
          monetaryAmount: { amount: '25', currencyCode: 'CZK' },
        },
        sourceRecord: {
          ...proposal.payload.sourceAssertion.sourceRecord,
          sourceRecordRef: internalReadyProductSource.recordId,
        },
      },
    });
    const source = {
      entityKind: 'PRODUCT',
      issuerId: internalProductSource.issuerId,
      sourceNamespace: internalProductSource.namespace,
      sourceRecordId: internalReadyProductSource.recordId,
    };
    const plan = yield* Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
      items: [
        {
          effects: [
            {
              effectKey: readyEffectKey,
              intent: {
                _tag: 'CatalogCreateProduct',
                payload: yield* Schema.encodeEffect(CreateProductPayloadSchema)(input.createPayload),
              },
              operation: {
                entrypointKey: 'commerce.catalog.create-product',
                moduleId: catalogModule,
                schemaVersion: '2',
              },
            },
            {
              dependsOn: [readyEffectKey],
              effectKey: 'price-ready-accepted',
              intent: { _tag: 'PriceDefine', payload: yield* Schema.encodeEffect(DefinePricePayloadSchema)(payload) },
              operation: {
                entrypointKey: 'commerce.pricing.define-price',
                moduleId: 'commerce.pricing',
                schemaVersion: '2',
              },
              originalTarget: payload.priceRef,
            },
          ],
          itemKey: 'ready-source-product',
          source,
          sourceOccurrenceId: input.productOccurrenceId,
        },
      ],
    });
    return { grant: proposal.grant, payload, plan };
  },
);
