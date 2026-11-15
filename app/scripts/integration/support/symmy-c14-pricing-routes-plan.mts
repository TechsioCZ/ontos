import { SymmyInternalExecutionPlanSchema } from '@app/symmy-integration/symmy-internal-contracts';
import type { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import type { ProductUnitRefSchema } from '@app/catalog/resources/product-unit';
import type { PriceGroupRefSchema } from '@app/price-group-catalog/resources/price-group';
import { DefinePricePayloadSchema } from '@app/pricing/actions/define-price';
import { ExternalPriceSourceAuthorityGrantSchema } from '@app/pricing/testing/c14-source-authority';
import { Effect, Schema } from 'effect';

export const internalPricingRouteSource = {
  issuerId: 'INTERNAL_C14_PRICING_ISSUER',
  mappingVersion: 'INTERNAL_C14_PRICING_MAPPING_V1',
  namespace: 'INTERNAL_C14_PRICE_LISTS',
  routeRevision: 'INTERNAL_C14_PRICING_ROUTE_V1',
} as const;

export const internalPricingNativeSourceSystem = {
  ownerModuleId: 'external.internal-c14',
  sourceSystemRef: 'INTERNAL_C14_PRICE_SOURCE_SYSTEM',
} as const;

/** What the price list route enrolls for a price assertion: the grant refs, never a price. */
export const internalPricingPriceSource = {
  mapping: {
    mappingContractRef: 'INTERNAL_C14_PRICE_ROUTE_MAPPING',
    mappingContractVersion: internalPricingRouteSource.mappingVersion,
  },
  sourceAuthority: { sourceAuthorityRef: 'INTERNAL_C14_PRICE_ROUTE_AUTHORITY', sourceAuthorityVersion: '1' },
} as const;

interface InternalC14PriceFacts {
  readonly at: string;
  readonly importedAt: (typeof DefinePricePayloadSchema.fields.sourceAssertion.fields.timing.Type)['importedAt'];
  readonly marketId: string;
  readonly occurrenceId: string;
  readonly priceId: string;
  readonly recordId: string;
  readonly selection: typeof CatalogSelectionSchema.Type;
  readonly sellingLegalEntityId: string;
  readonly unitRef: typeof ProductUnitRefSchema.Type;
}
const pricingModule = 'commerce.pricing';
const nativePriceOperation = {
  entrypointKey: 'commerce.pricing.define-price',
  moduleId: pricingModule,
  schemaVersion: '2',
};
const priceFields = (input: InternalC14PriceFacts) => ({
  effectiveFrom: input.at,
  identityKey: {
    catalogSelection: input.selection,
    commercialScope: { channelId: 'B2C', marketId: input.marketId, sellingLegalEntityId: input.sellingLegalEntityId },
    currencyCode: 'CZK',
    unitBasis: { quantity: '1', unitRef: input.unitRef },
  },
  monetaryAmount: { amount: '25', currencyCode: 'CZK' },
  priceRef: {
    moduleId: pricingModule,
    resourceId: input.priceId,
    resourceType: 'commerce.pricing.price',
    tenantId: input.selection.productRef.tenantId,
  },
  reason: 'INTERNAL_C14 explicit source-backed pre-Tax Price',
  sourceAssertion: {
    lineage: { kind: 'INITIAL' },
    mapping: internalPricingPriceSource.mapping,
    originalAssertion: {
      monetaryAmount: { amount: '25', currencyCode: 'CZK' },
      monetaryBoundary: 'PRE_TAX',
      unitBasis: { quantity: '1', unitRef: input.unitRef },
    },
    sourceAssertionId: input.occurrenceId,
    sourceAuthority: internalPricingPriceSource.sourceAuthority,
    sourceRecord: {
      sourceChangeCorrelation: input.occurrenceId,
      sourceRecordRef: input.recordId,
      sourceRecordVersion: '1',
      sourceSystem: internalPricingNativeSourceSystem,
    },
    timing: { importedAt: input.importedAt, ownerBusinessEffectiveAt: input.at, sourceEffectiveAt: input.at },
  },
});
const priceSource = (input: InternalC14PriceFacts) => ({
  entityKind: 'PRICE',
  issuerId: internalPricingRouteSource.issuerId,
  sourceNamespace: internalPricingRouteSource.namespace,
  sourceRecordId: input.recordId,
});

export const decodeInternalC14CapturedPriceGrant = (
  payload: typeof DefinePricePayloadSchema.Type,
  verifiedAt: string,
) =>
  Schema.decodeUnknownEffect(ExternalPriceSourceAuthorityGrantSchema)({
    authority: payload.sourceAssertion.sourceAuthority,
    effectivePeriod: { effectiveFrom: payload.effectiveFrom },
    exactIdentityKey: payload.identityKey,
    family: 'PRICE',
    mapping: payload.sourceAssertion.mapping,
    ownerModuleId: pricingModule,
    schemaVersion: '1',
    verificationRef: 'INTERNAL_C14_EXPLICIT_NATIVE_PRICE_ROUTE_SOURCE_GRANT',
    verifiedAt,
  });

export const decodeInternalC14SourcePricePlan = Effect.fn('InternalC14PricingRoutes.pricePlan')(
  function* decodePricePlan(input: InternalC14PriceFacts & { readonly groupRef: typeof PriceGroupRefSchema.Type }) {
    const facts = priceFields(input);
    const payload = yield* Schema.decodeUnknownEffect(DefinePricePayloadSchema)({
      ...facts,
      identityKey: { ...facts.identityKey, priceGroupSelector: { kind: 'PRICE_GROUP', priceGroupRef: input.groupRef } },
    });
    const grant = yield* decodeInternalC14CapturedPriceGrant(payload, input.importedAt);
    const plan = yield* Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
      items: [
        {
          effects: [
            {
              effectKey: 'price-define',
              intent: { _tag: 'PriceDefine', payload: yield* Schema.encodeEffect(DefinePricePayloadSchema)(payload) },
              operation: nativePriceOperation,
              originalTarget: payload.priceRef,
            },
          ],
          itemKey: 'source-price',
          source: priceSource(input),
          sourceOccurrenceId: input.occurrenceId,
        },
      ],
    });
    return { grant, payload, plan };
  },
);
