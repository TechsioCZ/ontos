import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { ProductUnitRefSchema } from '@app/catalog/resources/product-unit';
import { PriceGroupRefSchema } from '@app/price-group-catalog-contracts/resources/price-group';
import { Schema } from 'effect';

import { PricingCurrencyCodeSchema, PricingInstantSchema } from '../apis/current-supported-currencies.ts';
import { PriceRefSchema } from '../resources/price.ts';
import { PricingCommercialScopeSchema } from './pricing-commercial-scope.ts';
import type { PricingCommercialScope } from './pricing-commercial-scope.ts';

export const PRICE_DECIMAL_PRECISION = 38;
export const PRICE_DECIMAL_SCALE = 9;
export const PRICE_DECIMAL_INTEGER_DIGITS = PRICE_DECIMAL_PRECISION - PRICE_DECIMAL_SCALE;

const priceDecimalPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const priceDecimalBounds = Schema.makeFilter((value: string) => {
  if (!priceDecimalPattern.test(value)) {
    return 'Price decimal must be a canonical non-negative decimal';
  }
  const [integer = '', fraction = ''] = value.split('.');
  return integer.length <= PRICE_DECIMAL_INTEGER_DIGITS && fraction.length <= PRICE_DECIMAL_SCALE
    ? undefined
    : `Price decimal must fit numeric(${PRICE_DECIMAL_PRECISION}, ${PRICE_DECIMAL_SCALE})`;
});

export const PriceNonNegativeDecimalSchema = Schema.String.check(priceDecimalBounds).pipe(
  Schema.brand('PricingPriceNonNegativeDecimal'),
  Schema.decodeTo(Schema.String),
);
export const PricePositiveDecimalSchema = Schema.String.check(
  priceDecimalBounds,
  Schema.makeFilter((value) => (/^0(?:\.0+)?$/u.test(value) ? 'Price basis quantity must be positive' : undefined)),
).pipe(Schema.brand('PricingPricePositiveDecimal'), Schema.decodeTo(Schema.String));

/** Exact numeric equality for already-validated Price decimals; preserves each value's original lexical form. */
export const priceDecimalValuesEqual = (left: string, right: string): boolean => {
  const normalized = (value: string): string => {
    const [integer = '', fraction = ''] = value.split('.');
    return `${integer}.${fraction.padEnd(PRICE_DECIMAL_SCALE, '0')}`;
  };
  return normalized(left) === normalized(right);
};

/** Price facts and runtime decisions share one mandatory exact SLE + Channel + Commerce Market scope. */
export const PriceCommercialScopeSchema = PricingCommercialScopeSchema;
export type PriceCommercialScope = PricingCommercialScope;

export const PriceUnitBasisSchema = Schema.Struct({
  quantity: PricePositiveDecimalSchema,
  unitRef: ProductUnitRefSchema,
});
export type PriceUnitBasis = typeof PriceUnitBasisSchema.Type;

export const PriceGroupSelectorSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('NO_GROUP') }),
  Schema.Struct({ kind: Schema.Literal('PRICE_GROUP'), priceGroupRef: PriceGroupRefSchema }),
]);
export type PriceGroupSelector = typeof PriceGroupSelectorSchema.Type;

export const PriceIdentityKeySchema = Schema.Struct({
  catalogSelection: CatalogSelectionSchema,
  commercialScope: PriceCommercialScopeSchema,
  currencyCode: PricingCurrencyCodeSchema,
  priceGroupSelector: PriceGroupSelectorSchema,
  unitBasis: PriceUnitBasisSchema,
}).check(
  Schema.makeFilter((key) => {
    const { catalogSelection, priceGroupSelector, unitBasis } = key;
    const { tenantId } = catalogSelection.productRef;
    if (unitBasis.unitRef.tenantId !== tenantId) {
      return 'Price Unit and Catalog Selection must belong to the same Tenant';
    }
    return priceGroupSelector.kind === 'PRICE_GROUP' && priceGroupSelector.priceGroupRef.tenantId !== tenantId
      ? 'Price Group and Catalog Selection must belong to the same Tenant'
      : undefined;
  }),
);
export type PriceIdentityKey = typeof PriceIdentityKeySchema.Type;

export const PriceRevisionIdSchema = Schema.String.check(Schema.isUUID(), Schema.isTrimmed()).pipe(
  Schema.brand('PricingPriceRevisionId'),
  Schema.decodeTo(Schema.String),
);
export const PriceRevisionNumberSchema = Schema.Int.check(Schema.isGreaterThan(0));
export const PriceRevisionSchema = Schema.Struct({
  effectiveFrom: PricingInstantSchema,
  monetaryAmount: Schema.Struct({
    amount: PriceNonNegativeDecimalSchema,
    currencyCode: PricingCurrencyCodeSchema,
  }),
  monetaryBoundary: Schema.Literal('PRE_TAX'),
  revision: PriceRevisionNumberSchema,
  revisionId: PriceRevisionIdSchema,
});
export type PriceRevision = typeof PriceRevisionSchema.Type;

export const PriceDefinitionSchema = Schema.Struct({
  identityKey: PriceIdentityKeySchema,
  priceRef: PriceRefSchema,
  revision: PriceRevisionSchema,
}).check(
  Schema.makeFilter(({ identityKey, priceRef, revision }) => {
    if (priceRef.tenantId !== identityKey.catalogSelection.productRef.tenantId) {
      return 'Price and Catalog Selection must belong to the same Tenant';
    }
    return identityKey.currencyCode === revision.monetaryAmount.currencyCode
      ? undefined
      : 'Price Revision currency must equal its stable Price key currency';
  }),
);
export type PriceDefinition = typeof PriceDefinitionSchema.Type;
