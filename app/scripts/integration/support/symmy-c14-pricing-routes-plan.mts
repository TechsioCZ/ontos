import type { CatalogSelectionSchema } from '@app/catalog-selection-contracts/catalog-selection';
import type { ProductUnitRefSchema } from '@app/catalog-selection-contracts/resources/product-unit';
import type { PriceGroupRefSchema } from '@app/price-group-catalog/resources/price-group';
import type { DefinePricePayloadSchema } from '@app/pricing/actions/define-price';
import { ExternalPriceSourceAuthorityGrantSchema } from '@app/pricing/testing/c14-source-authority';
import { Schema } from 'effect';

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

const pricingModule = 'commerce.pricing';

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

/** The grant of one exact price identity, as an operator would capture it before the price is defined. */
export const decodeInternalC14PriceGrantFor = (input: {
  readonly effectiveFrom: string;
  readonly groupRef: typeof PriceGroupRefSchema.Type;
  readonly marketId: string;
  readonly selection: typeof CatalogSelectionSchema.Type;
  readonly sellingLegalEntityId: string;
  readonly unitRef: typeof ProductUnitRefSchema.Type;
  readonly verifiedAt: string;
}) =>
  Schema.decodeUnknownEffect(ExternalPriceSourceAuthorityGrantSchema)({
    authority: internalPricingPriceSource.sourceAuthority,
    effectivePeriod: { effectiveFrom: input.effectiveFrom },
    exactIdentityKey: {
      catalogSelection: input.selection,
      commercialScope: {
        channelId: 'B2C',
        marketId: input.marketId,
        sellingLegalEntityId: input.sellingLegalEntityId,
      },
      currencyCode: 'CZK',
      priceGroupSelector: { kind: 'PRICE_GROUP', priceGroupRef: input.groupRef },
      unitBasis: { quantity: '1', unitRef: input.unitRef },
    },
    family: 'PRICE',
    mapping: internalPricingPriceSource.mapping,
    ownerModuleId: pricingModule,
    schemaVersion: '1',
    verificationRef: 'INTERNAL_C14_EXPLICIT_NATIVE_PRICE_ROUTE_SOURCE_GRANT',
    verifiedAt: input.verifiedAt,
  });
