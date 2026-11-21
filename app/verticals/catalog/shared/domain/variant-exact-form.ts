import { Option } from 'effect';
import type { CatalogIdentityScope } from '@app/catalog-selection-contracts/identity-scope';

import type { Product, ProductVariant } from './product.ts';

const sameCatalogRef = (
  left: ProductVariant['productRef'] | ProductVariant['variantRef'],
  right: ProductVariant['productRef'] | ProductVariant['variantRef'],
): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId &&
  left.resourceId === right.resourceId;

/**
 * Resolve an exact form only from an explicitly recorded Variant of this Product.
 * A bare VariantRef cannot prove parentage; an absent form is not synthesized from
 * possible axis values. Lifecycle and Current rules remain separate checks.
 */
export const resolveVariantExactForm = (
  product: Pick<Product, 'productRef' | 'variants'>,
  variantRef: ProductVariant['variantRef'],
): Option.Option<CatalogIdentityScope> => {
  const match = product.variants.find(
    (variant) =>
      sameCatalogRef(variant.productRef, product.productRef) &&
      variant.variantRef.tenantId === product.productRef.tenantId &&
      sameCatalogRef(variant.variantRef, variantRef) &&
      variant.variantId === variant.variantRef.resourceId,
  );
  return match === undefined
    ? Option.none()
    : Option.some({ productRef: product.productRef, variantRef: match.variantRef });
};

export type ProductOnlyVariantResolution =
  | { readonly exactForm: CatalogIdentityScope; readonly status: 'RESOLVED' }
  | { readonly status: 'AMBIGUOUS' | 'NO_ELIGIBLE_VARIANT' };

/** Resolve identity only; this is not proof that a Catalog Selection is Current or VALID. */
export const resolveProductOnlyVariant = (
  product: Pick<Product, 'productRef' | 'variants'>,
): ProductOnlyVariantResolution => {
  let exactForm: CatalogIdentityScope | undefined;
  for (const variant of product.variants) {
    if (
      variant.lifecycle !== 'ACTIVE' ||
      !sameCatalogRef(variant.productRef, product.productRef) ||
      variant.variantRef.tenantId !== product.productRef.tenantId ||
      variant.variantId !== variant.variantRef.resourceId
    ) {
      continue;
    }
    if (exactForm !== undefined) {
      return { status: 'AMBIGUOUS' };
    }
    exactForm = { productRef: product.productRef, variantRef: variant.variantRef };
  }
  return exactForm === undefined ? { status: 'NO_ELIGIBLE_VARIANT' } : { exactForm, status: 'RESOLVED' };
};
