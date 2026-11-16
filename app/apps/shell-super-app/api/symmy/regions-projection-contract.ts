import { MarketRefSchema } from '@app/commerce-market-catalog/resources/market';
import { PricingCurrencyCodeSchema } from '@app/pricing-contracts/current-supported-currencies';
import { Schema } from 'effect';
import { SymmyQualifiedReadIdSchema } from './read-projection-contracts.ts';

export const SymmyRegionSourceIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
  Schema.isTrimmed(),
).pipe(Schema.brand('SymmyRegionSourceId'));

/** Only the resolved Market reference is exposed as evidence of the configured Region mapping. */
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
      id: SymmyQualifiedReadIdSchema,
      market_code: Schema.String,
      marketRef: MarketRefSchema,
      source_record_id: SymmyRegionSourceIdSchema,
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
