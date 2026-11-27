// Sales-terms drafts: Kč and quantity text parsing and the quantity tier rows the product and variant editors share.
import { Schema } from 'effect';
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

/** One quantity tier row as typed: from quantity, net and gross price in Kč; `key` names the row. */
export const TierDraftSchema = Schema.Struct({
  grossText: Schema.String,
  key: Schema.Number,
  minimumText: Schema.String,
  netText: Schema.String,
});
export type TierDraft = typeof TierDraftSchema.Type;

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
      (minimum !== null && from < minimum) ||
      parseCzkText(tier.netText) === null ||
      parseCzkText(tier.grossText) === null
    );
  });

/**
 * The tier rows as they sell at `minimum` when they were written for the minimum `writtenFor`: a raised minimum moves
 * the rows below it up to it, and the rows it then starts on merge into the one that started highest (its price is what
 * the new minimum buys); a lowered minimum takes the rows that started at the old one down with it. The same list when
 * nothing moves, so the operator's own rows below the minimum still show their error.
 */
export const tiersAtMinimum = (
  tiers: readonly TierDraft[],
  writtenFor: number | null,
  minimum: number | null,
): readonly TierDraft[] => {
  if (writtenFor === null || minimum === null || writtenFor === minimum) {
    return tiers;
  }
  const at = (tier: TierDraft) => ({ ...tier, minimumText: String(minimum) });
  if (minimum < writtenFor) {
    return tiers.some((tier) => parseQuantityText(tier.minimumText) === writtenFor)
      ? tiers.map((tier) => (parseQuantityText(tier.minimumText) === writtenFor ? at(tier) : tier))
      : tiers;
  }
  const reached = tiers.flatMap((tier) => {
    const from = parseQuantityText(tier.minimumText);
    return from !== null && from <= minimum ? [{ from, tier }] : [];
  });
  const [first] = reached;
  if (first === undefined || reached.every((row) => row.from === minimum)) {
    return tiers;
  }
  let top = first;
  for (const row of reached) {
    top = row.from >= top.from ? row : top;
  }
  return tiers.flatMap((tier) => {
    if (tier === first.tier) {
      return [at(top.tier)];
    }
    return reached.some((row) => row.tier === tier) ? [] : [tier];
  });
};

/** A variant's order minimum as typed: empty is 1; null for invalid text. */
export const variantMinimumOf = (text: string): number | null => (text.trim() === '' ? 1 : parseQuantityText(text));

/** A variant's tier rows as they sell at its typed minimum ({@link tiersAtMinimum}); moved rows are saved. */
export const variantTiersShown = (draft: {
  readonly minimumQuantityText: string;
  readonly tiers: readonly TierDraft[];
  readonly tiersMinimumText: string;
}): readonly TierDraft[] =>
  tiersAtMinimum(draft.tiers, variantMinimumOf(draft.tiersMinimumText), variantMinimumOf(draft.minimumQuantityText));

/** What the operator is told when the rows follow a changed minimum ({@link tiersAtMinimum}); null when none moved. */
export const tiersAtMinimumNote = (
  written: readonly TierDraft[],
  shown: readonly TierDraft[],
  minimum: number | null,
): string | null =>
  shown === written || minimum === null
    ? null
    : `Množstevní ceny se posunuly na minimální odběr ${minimum}${
        shown.length < written.length ? '; ze sloučených platí cena od nejvyššího množství' : ''
      }. Uloží se tak, jak jsou zobrazené.`;

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
