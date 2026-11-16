// The price a products list row shows: the stored price including VAT when the product has one, else its net price,
// always labelled for what it is (a net price is never presented as including VAT).
import type { ProductRecord } from '../../../../../shared/apis/records.ts';

export interface ListPrice {
  /** With variants the list shows the lowest variant price. */
  readonly fromVariants: boolean;
  readonly minor: number;
  readonly withVat: boolean;
}

export const listPriceOf = (
  product: Pick<ProductRecord, 'currentPriceMinor' | 'grossPriceMinor' | 'variantCount'>,
): ListPrice => {
  const fromVariants = (product.variantCount ?? 0) > 0;
  return product.grossPriceMinor === undefined
    ? { fromVariants, minor: product.currentPriceMinor, withVat: false }
    : { fromVariants, minor: product.grossPriceMinor, withVat: true };
};
