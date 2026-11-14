import { Option, Schema } from 'effect';
import { Url, UrlParams } from 'effect/http';
import type { ProductVariant, VariantId } from '../../../../../shared/domain/merchandise-model.ts';
import { VariantIdSchema, isRealVariant } from '../../../../../shared/domain/merchandise-model.ts';

/** The opaque URL target and the exact row it selects; no other variant may stand in for it. */
export type ProductVariantDestination =
  | { readonly kind: 'none' }
  | { readonly kind: 'unavailable'; readonly variantId: string }
  | { readonly draftKey: string; readonly kind: 'selected'; readonly variantId: string };

interface ProductVariantDestinationSource {
  readonly variantRecords?:
    | readonly { readonly active: boolean; readonly id: VariantId; readonly priceMinor: number }[]
    | undefined;
  readonly variants?: readonly ProductVariant[] | undefined;
}

/** Read the opaque variant id from the current query string; absent means no target at all. */
export const productVariantIdFromSearch = (search: string): string | undefined => {
  let query = search;
  if (query === '') {
    query = '?';
  } else if (!query.startsWith('?')) {
    query = `?${query}`;
  }
  const params = Url.urlParams(new URL(query, 'https://product.invalid'));
  const value = Option.getOrUndefined(UrlParams.getFirst(params, 'variantId'));
  if (value === undefined) {
    return undefined;
  }
  return Option.getOrUndefined(Schema.decodeOption(VariantIdSchema)(value)) ?? value;
};

/**
 * Resolve an opaque `variantId` against the one current authorized product. The variant must exist exactly once as a
 * real, active, priced leaf on this product; missing, foreign, inactive, invalid or ambiguous ids are unavailable and
 * never fall back to another row.
 */
export const resolveProductVariantDestination = (
  product: ProductVariantDestinationSource,
  variantId: string | undefined,
): ProductVariantDestination => {
  if (variantId === undefined) {
    return { kind: 'none' };
  }
  if (variantId.length === 0 || variantId.length > 300) {
    return { kind: 'unavailable', variantId };
  }
  const drafts: ProductVariant[] = [];
  for (const variant of product.variants ?? []) {
    if (isRealVariant(variant) && variant.id === variantId) {
      drafts.push(variant);
    }
  }
  const records = (product.variantRecords ?? []).filter((record) => record.id === variantId);
  if (drafts.length !== 1 || records.length !== 1) {
    return { kind: 'unavailable', variantId };
  }
  const [draft] = drafts;
  const [record] = records;
  if (record === undefined || draft === undefined || !record.active || record.priceMinor < 0) {
    return { kind: 'unavailable', variantId };
  }
  if (draft.active === false) {
    return { kind: 'unavailable', variantId };
  }
  return { draftKey: variantId, kind: 'selected', variantId };
};
