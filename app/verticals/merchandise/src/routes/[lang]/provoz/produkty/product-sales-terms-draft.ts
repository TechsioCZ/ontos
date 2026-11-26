// Sales-terms drafts: Kč and quantity text parsing and the quantity tier rows the product and variant editors share.
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import { moneyInputText } from '../../../../form-number.ts';

/** Kč text to minor units; null for empty or invalid text. */
export const parseCzkText = (text: string): number | null => {
  const normalized = text.replaceAll(/\s/gu, '').replace(',', '.');
  if (normalized === '') {
    return null;
  }
  const value = Number(normalized);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
};

/** A positive quantity typed as text; null for empty or invalid text. */
export const parseQuantityText = (text: string): number | null => {
  const normalized = text.replaceAll(/\s/gu, '').replace(',', '.');
  if (normalized === '') {
    return null;
  }
  const value = Number(normalized);
  return Number.isFinite(value) && value > 0 ? value : null;
};

export const czkText = (minor: number | undefined): string => (minor === undefined ? '' : moneyInputText(minor / 100));

/** One quantity tier row as typed: from quantity, net and gross price in Kč. */
export interface TierDraft {
  readonly grossText: string;
  readonly key: number;
  readonly minimumText: string;
  readonly netText: string;
}

export type PriceTiers = NonNullable<ProductRecord['priceTiers']>;

export const tierDraftsOf = (tiers: PriceTiers | undefined): readonly TierDraft[] =>
  (tiers ?? []).map((tier, index) => ({
    grossText: czkText(tier.priceMinor),
    key: index,
    minimumText: String(tier.minimumQuantity),
    netText: czkText(tier.priceExcludingVatMinor),
  }));

/** Whether a tier row cannot be saved: every tier starts above the order minimum and has both prices. */
export const tierRowsInvalid = (tiers: readonly TierDraft[], minimum: number | null): boolean =>
  tiers.some((tier) => {
    const from = parseQuantityText(tier.minimumText);
    return (
      from === null ||
      (minimum !== null && from <= minimum) ||
      parseCzkText(tier.netText) === null ||
      parseCzkText(tier.grossText) === null
    );
  });

/** The tiers a valid draft saves, ascending by quantity. */
export const priceTiersOf = (tiers: readonly TierDraft[]): PriceTiers =>
  tiers
    .map((tier) => ({
      minimumQuantity: parseQuantityText(tier.minimumText) ?? 0,
      priceExcludingVatMinor: parseCzkText(tier.netText) ?? 0,
      priceMinor: parseCzkText(tier.grossText) ?? 0,
    }))
    .toSorted((left, right) => left.minimumQuantity - right.minimumQuantity);

/** Whether two saved tier lists are the same. */
export const sameTiers = (left: PriceTiers, right: PriceTiers): boolean =>
  left.length === right.length &&
  left.every((tier, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      other.minimumQuantity === tier.minimumQuantity &&
      other.priceExcludingVatMinor === tier.priceExcludingVatMinor &&
      other.priceMinor === tier.priceMinor
    );
  });

/** The key a newly added tier row gets. */
export const nextTierKey = (tiers: readonly TierDraft[]): number => {
  let next = 0;
  for (const tier of tiers) {
    next = Math.max(next, tier.key + 1);
  }
  return next;
};
