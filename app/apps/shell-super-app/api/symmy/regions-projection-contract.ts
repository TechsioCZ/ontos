import { MarketRefSchema } from '@app/commerce-market-catalog/resources/market';
import { PricingCurrencyCodeSchema } from '@app/pricing-contracts/current-supported-currencies';
import { Schema } from 'effect';

export const SymmyRegionSourceIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
  Schema.isTrimmed(),
).pipe(Schema.brand('SymmyRegionSourceId'));

/** Internal projection only; the source Region identity is never a native Market identity. */
export const SymmyInternalRegionsProjectionSchema = Schema.Struct({
  contractVersion: Schema.Literal('INTERNAL_C14'),
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  projection: Schema.Literal('regions'),
  regions: Schema.Array(
    Schema.Struct({
      country_codes: Schema.Tuple([Schema.Literal('CZ')]),
      currency_code: PricingCurrencyCodeSchema,
      id: SymmyRegionSourceIdSchema,
      market_code: Schema.String,
      marketRef: MarketRefSchema,
    }),
  ),
  unsupported_fields: Schema.Tuple([
    Schema.Literal('name'),
    Schema.Literal('tax_rate'),
    Schema.Literal('tax_included'),
    Schema.Literal('payment_providers'),
  ]),
});
export type SymmyInternalRegionsProjection = typeof SymmyInternalRegionsProjectionSchema.Type;
