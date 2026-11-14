// The editable fields of a demo order: the draft as typed, when two drafts would be saved the same, and the edit
// one draft sends.
import type { MerchandiseCommand } from '../../../../../shared/actions/apply-command.ts';
import type { Order } from '../../../../../shared/apis/records.ts';
import type { ProductId, ShippingMethod, VariantId } from '../../../../../shared/domain/merchandise-model.ts';
import { moneyInputText } from '../../../../form-number.ts';
import type { CzVatClassificationCode } from '@app/shared-contracts/cz-vat-classifications';

export interface DraftLine {
  readonly key: string;
  readonly name: string;
  /**
   * A new line's price as the catalog offers it; the edit sends a price for the line only when staff changed it, so the
   * server prices the line itself (the stored gross of a storefront order, never one recomputed from net).
   */
  readonly offeredPriceText?: string;
  readonly priceText: string;
  readonly productId: ProductId;
  readonly quantityText: string;
  readonly sku: string;
  /** The line's VAT classification: the order's snapshot, or the picked product's for a new line. */
  /** Absent on lines from before classifications (10 % and 0 % history keep their rate only). */
  readonly taxClassificationCode?: CzVatClassificationCode | undefined;
  readonly variantId?: VariantId;
  readonly variantName?: string;
  /** The line's VAT percentage: the order's snapshot, or the rate Tax gives a new line's classification today. */
  readonly vatRate: number;
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
  const draft = {
    key: `existing-${index}`,
    name: line.productName,
    priceText: moneyInputText(line.unitPriceMinor / 100),
    productId: line.productId,
    quantityText: String(line.quantity),
    sku: line.sku,
    taxClassificationCode: line.taxClassificationCode,
    vatRate: line.vatRate,
  } satisfies DraftLine;
  const withVariant = line.variantId === undefined ? draft : { ...draft, variantId: line.variantId };
  return line.variantName === undefined ? withVariant : { ...withVariant, variantName: line.variantName };
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

const sameLines = (left: readonly DraftLine[], right: readonly DraftLine[]): boolean =>
  left.length === right.length &&
  left.every((line, index) => {
    const other = right[index];
    return other !== undefined && sameLine(line, other);
  });

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
  sameLines(left.lines, right.lines);

type EditCommand = Extract<MerchandiseCommand, { readonly _tag: 'EditOrder' }>;
type EditLine = NonNullable<EditCommand['lines']>[number];

const editLineOf = (line: DraftLine): EditLine => {
  const offered = line.offeredPriceText === undefined ? null : parseAmount(line.offeredPriceText);
  const price = parseAmount(line.priceText) ?? 0;
  const edit = { productId: line.productId, quantity: parseQuantity(line.quantityText) ?? 1 } satisfies EditLine;
  // An added line: the server prices it as new and refuses when the offered price is no longer the price.
  const withOffer = offered === null ? edit : { ...edit, offeredUnitPriceMinor: offered };
  const withPrice = offered === null || offered !== price ? { ...withOffer, unitPriceMinor: price } : withOffer;
  return line.variantId === undefined ? withPrice : { ...withPrice, variantId: line.variantId };
};

const addressOf = (draft: Draft) =>
  [draft.street, draft.city, draft.postalCode, draft.country].map((field) => field.trim());

const contactOf = (draft: Draft) => [draft.name, draft.email, draft.phone].map((field) => field.trim());

const sameTexts = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((text, index) => text === right[index]);

/** The delivery address was edited: it is then sent whole, and has to be complete. */
const addressTouched = (draft: Draft, base: Draft): boolean => !sameTexts(addressOf(draft), addressOf(base));

/** The contact was edited: it is then sent whole, and has to carry a name and an e-mail. */
const contactTouched = (draft: Draft, base: Draft): boolean => !sameTexts(contactOf(draft), contactOf(base));

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/**
 * An edited address that cannot be sent: it is sent whole, so the street, city and postal code have to be there.
 * `base` is the draft the edit is compared with (`editCommandOf`); an address left as `base` has it is not sent.
 */
export const addressIncomplete = (draft: Draft, base: Draft): boolean =>
  addressTouched(draft, base) && [draft.street, draft.city, draft.postalCode].some((field) => field.trim() === '');

/** An edited contact that cannot be sent: it is sent whole, so it has to carry a name and an e-mail. */
export const contactIncomplete = (draft: Draft, base: Draft): boolean =>
  contactTouched(draft, base) && (draft.name.trim() === '' || !EMAIL.test(draft.email.trim()));

const editAddress = (draft: Draft): NonNullable<EditCommand['deliveryAddress']> => {
  const address = { city: draft.city.trim(), postalCode: draft.postalCode.trim(), street: draft.street.trim() };
  return draft.country.trim() === '' ? address : { ...address, country: draft.country.trim() };
};

const editContact = (draft: Draft): NonNullable<EditCommand['contact']> => {
  const contact = { email: draft.email.trim(), name: draft.name.trim() };
  return draft.phone.trim() === '' ? contact : { ...contact, phone: draft.phone.trim() };
};

/**
 * The edit a valid draft sends: only the parts that differ from `base`, the draft of the order version the server
 * last confirmed, and that version's `updatedAt` as the precondition. The open order on the page is not the base: it
 * still shows the version before the form's own save until its reload lands, and after someone else's change it is
 * newer than what this draft was typed over. Null when nothing would change; a change reason alone is no change.
 */
export const editCommandOf = (
  order: Pick<Order, 'id'>,
  expectedUpdatedAt: Order['updatedAt'],
  draft: Draft,
  base: Draft,
): EditCommand | null => {
  const shippingPrice = parseAmount(draft.shippingPriceText);
  const linesChanged = !sameLines(draft.lines, base.lines);
  const shippingChanged =
    draft.shippingMethod !== null &&
    shippingPrice !== null &&
    (draft.shippingMethod !== base.shippingMethod || shippingPrice !== parseAmount(base.shippingPriceText));
  const addressChanged = addressTouched(draft, base);
  const contactChanged = contactTouched(draft, base);
  const noteChanged = draft.note.trim() !== base.note.trim();
  const reason = draft.reason.trim();
  const precondition = { _tag: 'EditOrder', expectedUpdatedAt, id: order.id } satisfies EditCommand;
  const withLines = linesChanged ? { ...precondition, lines: draft.lines.map(editLineOf) } : precondition;
  const withShipping =
    shippingChanged && draft.shippingMethod !== null && shippingPrice !== null
      ? { ...withLines, shipping: { method: draft.shippingMethod, priceMinor: shippingPrice } }
      : withLines;
  const withAddress = addressChanged ? { ...withShipping, deliveryAddress: editAddress(draft) } : withShipping;
  const withContact = contactChanged ? { ...withAddress, contact: editContact(draft) } : withAddress;
  const withNote = noteChanged ? { ...withContact, note: draft.note.trim() } : withContact;
  const command: EditCommand = reason === '' ? withNote : { ...withNote, reason };
  return linesChanged || shippingChanged || addressChanged || contactChanged || noteChanged ? command : null;
};
