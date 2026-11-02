// The editable fields of a demo order: the draft as typed, and when two drafts would be saved the same.
import type { Order } from '../../../../../shared/apis/records.ts';
import type { ProductId, ShippingMethod, VariantId } from '../../../../../shared/domain/merchandise-model.ts';
import { moneyInputText } from '../../../../form-number.ts';

type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };

export interface DraftLine {
  readonly key: string;
  readonly name: string;
  readonly priceText: string;
  readonly productId: ProductId;
  readonly quantityText: string;
  readonly sku: string;
  readonly variantId?: VariantId;
  readonly variantName?: string;
  readonly vatRate: Order['lines'][number]['vatRate'];
}

export interface Draft {
  readonly city: string;
  readonly country: string;
  readonly email: string;
  readonly lines: readonly DraftLine[];
  readonly name: string;
  readonly note: string;
  readonly phone: string;
  readonly postalCode: string;
  readonly reason: string;
  readonly shippingMethod: ShippingMethod | null;
  readonly shippingPriceText: string;
  readonly street: string;
}

/** A typed amount in the order currency, in minor units; null when it is not a non-negative number. */
export const parseAmount = (text: string): number | null => {
  const normalized = text.replaceAll(/\s/gu, '').replace(',', '.');
  if (normalized === '') {
    return null;
  }
  const value = Number(normalized);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
};

export const parseQuantity = (text: string): number | null => {
  const value = Number(text.replaceAll(/\s/gu, '').replace(',', '.'));
  return Number.isFinite(value) && value > 0 && value <= 1_000_000 ? value : null;
};

const draftLineOf = (line: Order['lines'][number], index: number): DraftLine => {
  const draft: Mutable<DraftLine> = {
    key: `existing-${index}`,
    name: line.productName,
    priceText: moneyInputText(line.unitPriceMinor / 100),
    productId: line.productId,
    quantityText: String(line.quantity),
    sku: line.sku,
    vatRate: line.vatRate,
  };
  if (line.variantId !== undefined) {
    draft.variantId = line.variantId;
  }
  if (line.variantName !== undefined) {
    draft.variantName = line.variantName;
  }
  return draft;
};

/** The draft of an existing order, read from the register. */
export const draftOf = (order: Order): Draft => ({
  city: order.deliveryAddress?.city ?? '',
  country: order.deliveryAddress?.country ?? '',
  email: order.contact?.email ?? '',
  lines: order.lines.map((line, index) => draftLineOf(line, index)),
  name: order.contact?.name ?? '',
  note: order.note ?? '',
  phone: order.contact?.phone ?? '',
  postalCode: order.deliveryAddress?.postalCode ?? '',
  reason: '',
  shippingMethod: order.shipping?.method ?? null,
  shippingPriceText: order.shipping === undefined ? '' : moneyInputText(order.shipping.priceMinor / 100),
  street: order.deliveryAddress?.street ?? '',
});

const sameLine = (left: DraftLine, right: DraftLine): boolean =>
  left.productId === right.productId &&
  left.variantId === right.variantId &&
  parseQuantity(left.quantityText) === parseQuantity(right.quantityText) &&
  parseAmount(left.priceText) === parseAmount(right.priceText);

/**
 * Two drafts the server would store the same: surrounding spaces do not count, and the quantity and price inputs are
 * read as numbers, so `1,00` and `1` are one quantity.
 */
export const sameOrderDraft = (left: Draft, right: Draft): boolean =>
  left.city.trim() === right.city.trim() &&
  left.country.trim() === right.country.trim() &&
  left.email.trim() === right.email.trim() &&
  left.name.trim() === right.name.trim() &&
  left.note.trim() === right.note.trim() &&
  left.phone.trim() === right.phone.trim() &&
  left.postalCode.trim() === right.postalCode.trim() &&
  left.reason.trim() === right.reason.trim() &&
  left.shippingMethod === right.shippingMethod &&
  parseAmount(left.shippingPriceText) === parseAmount(right.shippingPriceText) &&
  left.street.trim() === right.street.trim() &&
  left.lines.length === right.lines.length &&
  left.lines.every((line, index) => {
    const other = right.lines[index];
    return other !== undefined && sameLine(line, other);
  });
