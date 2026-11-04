import type { ProductUnit, VatRate } from '../../../../../shared/domain/merchandise-model.ts';
import type { ProductLabel } from './product-form-labels.ts';

export const UNITS: readonly ProductUnit[] = ['ks', 'bal', 'hod', 'lic'];
export const VAT_RATES: readonly VatRate[] = [0, 10, 12, 21];

/**
 * Text limits of the apply-command schema. The forms check them before sending: an over-long value would
 * otherwise fail to encode, send nothing, and surface only as the generic failure toast.
 */
export const PRODUCT_LIMITS = { category: 120, name: 200, note: 2000, sku: 64 } as const;

/** Length message for a trimmed text field over its limit, or undefined. Counts UTF-16 units, as the schema does. */
export const tooLongMessage = (k: ProductLabel, value: string, maximum: number): string | undefined =>
  value.trim().length > maximum ? k('validation.tooLong', { max: maximum }) : undefined;

/** Price in Kč, haléře allowed (the input keeps two decimals): a finite number above zero. An emptied input reports NaN. */
export const priceErrorKey = (priceCzk: number): string | undefined =>
  Number.isFinite(priceCzk) && priceCzk > 0 ? undefined : 'validation.positive';

/** Low-stock threshold: a whole number of zero or more. */
export const lowStockErrorKey = (lowStock: number): string | undefined =>
  Number.isInteger(lowStock) && lowStock >= 0 ? undefined : 'validation.lowStock';

export const fieldError = (submitted: boolean, message: string | undefined) =>
  submitted && message !== undefined ? { helpText: message, validateStatus: 'error' as const } : {};

/**
 * After a refused submit, moves focus to the first invalid field so keyboard and screen-reader users land on
 * the problem. Each entry is the field's DOM id and whether it is invalid, in form order.
 */
export const focusFirstInvalid = (fields: readonly (readonly [string, boolean])[]): void => {
  const first = fields.find(([, invalid]) => invalid);
  if (first !== undefined) {
    globalThis.document.querySelector<HTMLElement>(`[id="${first[0]}"]`)?.focus();
  }
};
