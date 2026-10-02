import { CurrentSupportedCurrenciesSuccessSchema } from '../apis/current-supported-currencies.ts';
import { Schema } from 'effect';

import { PriceGroupFallbackResolutionInputSchema, PriceGroupFallbackResolutionSchema } from './price-group-fallback.ts';

type ResolutionInput = typeof PriceGroupFallbackResolutionInputSchema.Type;
type ResolutionPath = typeof PriceGroupFallbackResolutionSchema.Type;

const GuestInputTagSchema = Schema.TaggedStruct('GUEST', {});
const FoundPathTagSchema = Schema.Union([
  Schema.TaggedStruct('GROUP_PRICE', {}),
  Schema.TaggedStruct('NO_GROUP_AFTER_PROVEN_GROUP_ABSENCE', {}),
  Schema.TaggedStruct('NO_GROUP_GUEST', {}),
  Schema.TaggedStruct('NO_GROUP_NONE', {}),
]);
const AbsentPathTagSchema = Schema.TaggedStruct('NO_APPLICABLE_PRICE', {});
const ConflictPathTagSchema = Schema.TaggedStruct('CONFLICT', {});
const ConfigurationErrorPathTagSchema = Schema.TaggedStruct('CONFIGURATION_ERROR', {});
const IndeterminatePathTagSchema = Schema.TaggedStruct('INDETERMINATE', {});

const basisOf = (input: ResolutionInput) =>
  Schema.is(GuestInputTagSchema)(input) ? input.basis : input.interpretation.basis;

const supportMatchesInput = (input: {
  readonly currencySupport: typeof CurrentSupportedCurrenciesSuccessSchema.Type;
  readonly resolutionInput: ResolutionInput;
}): string | undefined => {
  const basis = basisOf(input.resolutionInput);
  if (
    input.currencySupport.effectiveAt !== input.resolutionInput.effectiveAt ||
    input.currencySupport.tenantId !== basis.catalogSelection.productRef.tenantId
  ) {
    return 'Exact Price resolution requires Tenant Current Currency Support for the trusted evaluation instant';
  }
  return input.currencySupport.supportedCurrencies.includes(basis.currencyCode)
    ? undefined
    : 'Exact Price resolution currency must be present in Tenant Current Currency Support';
};

const supportMatchesPath = (input: {
  readonly currencySupport: typeof CurrentSupportedCurrenciesSuccessSchema.Type;
  readonly path: ResolutionPath;
}): string | undefined =>
  supportMatchesInput({
    currencySupport: input.currencySupport,
    resolutionInput: input.path.resolutionInput,
  });

/** Verified owner inputs required before any exact Price key can be consulted. */
export const ExactPriceResolutionInputSchema = Schema.Struct({
  currencySupport: CurrentSupportedCurrenciesSuccessSchema,
  resolutionInput: PriceGroupFallbackResolutionInputSchema,
}).check(Schema.makeFilter(supportMatchesInput));
export type ExactPriceResolutionInput = typeof ExactPriceResolutionInputSchema.Type;

export const ExactPriceFoundResolutionSchema = Schema.TaggedStruct('PRICE_FOUND', {
  currencySupport: CurrentSupportedCurrenciesSuccessSchema,
  path: PriceGroupFallbackResolutionSchema,
}).check(
  Schema.makeFilter((value) =>
    Schema.is(FoundPathTagSchema)(value.path)
      ? supportMatchesPath(value)
      : 'PRICE_FOUND must retain a successful exact Group/no-group resolution path',
  ),
);
export type ExactPriceFoundResolution = typeof ExactPriceFoundResolutionSchema.Type;

export const ExactPriceAbsentResolutionSchema = Schema.TaggedStruct('NO_APPLICABLE_PRICE', {
  currencySupport: CurrentSupportedCurrenciesSuccessSchema,
  path: PriceGroupFallbackResolutionSchema,
}).check(
  Schema.makeFilter((value) =>
    Schema.is(AbsentPathTagSchema)(value.path)
      ? supportMatchesPath(value)
      : 'NO_APPLICABLE_PRICE must retain complete permitted-path absence evidence',
  ),
);
export type ExactPriceAbsentResolution = typeof ExactPriceAbsentResolutionSchema.Type;

export const ExactPriceConflictResolutionSchema = Schema.TaggedStruct('PRICING_CONFLICT', {
  currencySupport: CurrentSupportedCurrenciesSuccessSchema,
  path: PriceGroupFallbackResolutionSchema,
}).check(
  Schema.makeFilter((value) =>
    Schema.is(ConflictPathTagSchema)(value.path)
      ? supportMatchesPath(value)
      : 'PRICING_CONFLICT must retain its conflicting owner path evidence',
  ),
);
export type ExactPriceConflictResolution = typeof ExactPriceConflictResolutionSchema.Type;

export const ExactPriceConfigurationErrorResolutionSchema = Schema.TaggedStruct('PRICING_CONFIGURATION_ERROR', {
  currencySupport: CurrentSupportedCurrenciesSuccessSchema,
  path: PriceGroupFallbackResolutionSchema,
}).check(
  Schema.makeFilter((value) =>
    Schema.is(ConfigurationErrorPathTagSchema)(value.path)
      ? supportMatchesPath(value)
      : 'PRICING_CONFIGURATION_ERROR must retain its invalid owner path evidence',
  ),
);
export type ExactPriceConfigurationErrorResolution = typeof ExactPriceConfigurationErrorResolutionSchema.Type;

export const ExactPriceIndeterminateResolutionSchema = Schema.TaggedStruct('PRICING_INDETERMINATE', {
  currencySupport: CurrentSupportedCurrenciesSuccessSchema,
  path: PriceGroupFallbackResolutionSchema,
}).check(
  Schema.makeFilter((value) =>
    Schema.is(IndeterminatePathTagSchema)(value.path)
      ? supportMatchesPath(value)
      : 'PRICING_INDETERMINATE must retain its unavailable or unverifiable owner path evidence',
  ),
);
export type ExactPriceIndeterminateResolution = typeof ExactPriceIndeterminateResolutionSchema.Type;

type ExactPriceResolutionMembers = readonly [
  typeof ExactPriceFoundResolutionSchema,
  typeof ExactPriceAbsentResolutionSchema,
  typeof ExactPriceConflictResolutionSchema,
  typeof ExactPriceConfigurationErrorResolutionSchema,
  typeof ExactPriceIndeterminateResolutionSchema,
];

const ExactPriceResolutionUnionSchema: Schema.Union<ExactPriceResolutionMembers> = Schema.Union([
  ExactPriceFoundResolutionSchema,
  ExactPriceAbsentResolutionSchema,
  ExactPriceConflictResolutionSchema,
  ExactPriceConfigurationErrorResolutionSchema,
  ExactPriceIndeterminateResolutionSchema,
]);

export type ExactPriceResolutionSchemaContract = typeof ExactPriceResolutionUnionSchema;

/** Exact-price result before Tier, Fee, Discount, allocation, and final decision composition. */
export const ExactPriceResolutionSchema: ExactPriceResolutionSchemaContract = ExactPriceResolutionUnionSchema;
export type ExactPriceResolution = typeof ExactPriceResolutionSchema.Type;
