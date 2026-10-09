import { LegalEntityRefSchema } from '@app/core-runtime/resources/legal-entity';
import { Schema } from 'effect';

const stableMarketId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
  Schema.isTrimmed(),
  Schema.makeFilter((value) => (value === '*' ? 'Commerce Market must be one exact value' : undefined)),
);

/** Consumer binding of Commerce Market Catalog's `MarketChannelSchema`; Pricing adds no channel registry. */
export const PricingChannelIdSchema = Schema.Literals(['B2C', 'B2B']);
export type PricingChannelId = typeof PricingChannelIdSchema.Type;

/** Consumer binding of `MarketRef.resourceId`: stable owner text, not a Pricing-generated UUID. */
export const PricingMarketIdSchema = stableMarketId.pipe(
  Schema.brand('PricingMarketId'),
  Schema.decodeTo(Schema.String),
);
export type PricingMarketId = typeof PricingMarketIdSchema.Type;

/** Pricing consumes Core's published Legal Entity resource identity without owning seller identity. */
export const PricingSellingLegalEntityIdSchema = LegalEntityRefSchema.fields.resourceId;
export type PricingSellingLegalEntityId = typeof PricingSellingLegalEntityIdSchema.Type;

/** One exact backend commercial scope; Storefront and currency are deliberately separate. */
export const PricingCommercialScopeSchema = Schema.Struct({
  channelId: PricingChannelIdSchema,
  marketId: PricingMarketIdSchema,
  sellingLegalEntityId: PricingSellingLegalEntityIdSchema,
});
export type PricingCommercialScope = typeof PricingCommercialScopeSchema.Type;
