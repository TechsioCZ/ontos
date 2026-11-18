import { MarketRefSchema } from '@app/commerce-market-catalog/resources/market';
import { PricingCurrencyCodeSchema } from '@app/pricing-contracts/current-supported-currencies';
import { Schema, Struct } from 'effect';

import type { SymmyRegionFieldName } from './contract.ts';
import { SymmyQualifiedReadIdSchema } from './read-projection-contracts.ts';
import { SymmyInternalRegionsProjectionSchema, SymmyRegionSourceIdSchema } from './regions-projection-contract.ts';
import type { SymmyInternalRegionsProjection } from './regions-projection-contract.ts';

const regionFields = {
  countryCodes: Schema.Tuple([Schema.Literal('CZ')]),
  currencyCode: PricingCurrencyCodeSchema,
  id: SymmyQualifiedReadIdSchema,
  marketCode: Schema.String,
  marketRef: MarketRefSchema,
  sourceRecordId: SymmyRegionSourceIdSchema,
};
const envelope = {
  count: SymmyInternalRegionsProjectionSchema.fields.count,
  limit: SymmyInternalRegionsProjectionSchema.fields.limit,
  offset: SymmyInternalRegionsProjectionSchema.fields.offset,
};

/** The public body of `GET /admin/regions`: camelCase, no internal markers and no nullable field. */
export const SymmyRegionsResponseSchema = Schema.Struct({
  ...envelope,
  regions: Schema.Array(Schema.Struct(regionFields)),
});
type SymmyRegionsResponse = typeof SymmyRegionsResponseSchema.Type;

/** The body with `fields`: every item key except `id` is optional. The full body is validated first. */
export const SymmyRegionsSelectedResponseSchema = Schema.Struct({
  ...envelope,
  regions: Schema.Array(
    Schema.Struct({
      countryCodes: Schema.optionalKey(regionFields.countryCodes),
      currencyCode: Schema.optionalKey(regionFields.currencyCode),
      id: regionFields.id,
      marketCode: Schema.optionalKey(regionFields.marketCode),
      marketRef: Schema.optionalKey(regionFields.marketRef),
      sourceRecordId: Schema.optionalKey(regionFields.sourceRecordId),
    }),
  ),
});
type SymmyRegionsSelectedResponse = typeof SymmyRegionsSelectedResponseSchema.Type;

export const SymmyRegionsSuccessSchema = Schema.Union([SymmyRegionsResponseSchema, SymmyRegionsSelectedResponseSchema]);

/** `unsupported_fields` is still computed by the projection and is deliberately not exposed. */
export const mapSymmyRegionsProjection = (projection: SymmyInternalRegionsProjection): SymmyRegionsResponse => ({
  count: projection.count,
  limit: projection.limit,
  offset: projection.offset,
  regions: projection.regions.map((region) => ({
    countryCodes: region.country_codes,
    currencyCode: region.currency_code,
    id: region.id,
    marketCode: region.market_code,
    marketRef: region.marketRef,
    sourceRecordId: region.source_record_id,
  })),
});

/** Keeps `id` and the named keys. A repeated or `id` name has no effect. */
export const selectSymmyRegionFields = (
  body: SymmyRegionsResponse,
  names: readonly SymmyRegionFieldName[],
): SymmyRegionsSelectedResponse => ({
  count: body.count,
  limit: body.limit,
  offset: body.offset,
  regions: body.regions.map((region) => Struct.pick(region, ['id', ...names])),
});
