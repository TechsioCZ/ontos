import type { SymmyProductHintKind, SymmyProductRows } from '@app/symmy-integration/symmy-internal-contracts';
import { DateTime } from 'effect';
import type { Types } from 'effect';

import type { SymmyProductsBatchRequest } from './products-batch-request-contract.ts';

type Product = SymmyProductsBatchRequest['products'][number];
type Variant = Product['variants'][number];
type Price = NonNullable<Variant['prices']>[number];
type Text = NonNullable<Variant['localized']>[number];

const filled = (values: readonly unknown[] | undefined): boolean => values !== undefined && values.length > 0;

/** A localized text with no name and no description states a language and nothing else, so it writes nothing. */
const hasText = ({ description, name }: Text): boolean => description !== undefined || name !== undefined;

/**
 * The public fields no Symmy intent writes, by the group each is reported under. A field is reported when the
 * body names it, so nothing a client sent is dropped without a trace: the owner admission turns each group into
 * an unsupported branch of the product item.
 */
const unsupportedGroups = (product: Product): readonly SymmyProductHintKind[] => {
  const { variants } = product;
  const groups: readonly (readonly [SymmyProductHintKind, boolean])[] = [
    ['CategoryHint', filled(product.categories)],
    ['AttributeHint', filled(product.attributes) || variants.some(({ attributes }) => filled(attributes))],
    ['MediaHint', filled(product.media)],
    [
      'VariantUpdateHint',
      variants.some(({ lifecycle }) => lifecycle !== undefined && lifecycle !== 'WORK_IN_PROGRESS'),
    ],
    [
      'DescriptiveHint',
      filled(product.localized) ||
        product.sku !== undefined ||
        product.gtin !== undefined ||
        variants.some(
          ({ gtin, localized, sku }) =>
            sku !== undefined || gtin !== undefined || (localized ?? []).some((text) => !hasText(text)),
        ),
    ],
    [
      'ClassificationHint',
      product.productType !== undefined ||
        product.brand !== undefined ||
        product.manufacturer !== undefined ||
        filled(product.relationships) ||
        filled(product.sizes),
    ],
  ];
  return groups.flatMap(([kind, supplied]) => (supplied ? [kind] : []));
};

type PriceRow = SymmyProductRows[number]['variants'][number]['prices'][number];
type VariantRow = SymmyProductRows[number]['variants'][number];
type ProductRow = SymmyProductRows[number];

const mapPrice = (price: Price): PriceRow => {
  const mapped: Types.Mutable<PriceRow> = { amount: price.amount, currencyCode: price.currencyCode };
  const { commercialScope } = price;
  if (commercialScope !== undefined) {
    const scope: Types.Mutable<NonNullable<PriceRow['commercialScope']>> = {};
    if (commercialScope.channelRef !== undefined) {
      scope.channelId = commercialScope.channelRef.resourceId;
    }
    if (commercialScope.commerceMarketRef !== undefined) {
      scope.marketId = commercialScope.commerceMarketRef.resourceId;
    }
    if (commercialScope.sellingLegalEntityRef !== undefined) {
      scope.sellingLegalEntityId = commercialScope.sellingLegalEntityRef.resourceId;
    }
    mapped.commercialScope = scope;
  }
  if (price.effectiveFrom !== undefined) {
    mapped.effectiveFrom = DateTime.formatIso(price.effectiveFrom);
  }
  if (price.priceGroupCode !== undefined) {
    mapped.priceGroupCode = price.priceGroupCode;
  }
  if (price.unitBasis !== undefined) {
    mapped.unitBasis = price.unitBasis;
  }
  return mapped;
};

const mapVariant = (variant: Variant): VariantRow => {
  const mapped: Types.Mutable<VariantRow> = {
    localized: (variant.localized ?? []).filter(hasText),
    prices: (variant.prices ?? []).map(mapPrice),
  };
  if (variant.identifier !== undefined) {
    mapped.identifier = variant.identifier;
  }
  return mapped;
};

const mapProduct = (product: Product): ProductRow => {
  const [initial, ...further] = product.variants;
  const mapped: Types.Mutable<ProductRow> = {
    name: product.name,
    unsupported: unsupportedGroups(product),
    variants: [mapVariant(initial), ...further.map(mapVariant)],
  };
  if (product.description !== undefined) {
    mapped.description = product.description;
  }
  if (product.identifier !== undefined) {
    mapped.identifier = product.identifier;
  }
  if (product.lifecycle !== undefined) {
    mapped.lifecycle = product.lifecycle;
  }
  return mapped;
};

/**
 * The public products as the owner admission receives them. The route never sends a reason, an evidence
 * reference, an identity, a source fact or a version: the route enrollment and the admission derive those.
 * The first variant stays first, because it is the initial variant created with the product.
 */
export const mapSymmyProductsBatchRequest = ({ products }: SymmyProductsBatchRequest): SymmyProductRows => {
  const [first, ...rest] = products;
  return [mapProduct(first), ...rest.map(mapProduct)];
};
