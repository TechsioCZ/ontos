// The editable fields of a product: how a draft of them is compared, validated and turned into an update patch.
import { Option, Schema } from 'effect';
import type { ProductPatch } from '../../../../../shared/actions/apply-command.ts';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import { isRealVariant, ProductMetadataSchema } from '../../../../../shared/domain/merchandise-model.ts';
import { moneyInputText } from '../../../../form-number.ts';
import type {
  ProductMetadata,
  ProductUnit,
  ProductVariant,
  VatRate,
} from '../../../../../shared/domain/merchandise-model.ts';

/** Editable product fields as typed: the two money/stock inputs keep their text so "2,5" reaches validation. */
export interface DetailDraft {
  readonly active: boolean;
  readonly category: string;
  readonly description: string;
  readonly heightMm: string;
  readonly lengthMm: string;
  readonly lowStock: number;
  readonly lowStockText: string;
  readonly name: string;
  readonly nextVariantId: number;
  readonly priceCzk: number;
  readonly priceText: string;
  /** Real (sellable) variants are edited on the Varianty tab; the detail form passes them through unchanged. */
  readonly realVariants: readonly ProductVariant[];
  readonly shortDescription: string;
  readonly unit: ProductUnit;
  readonly variants: readonly { readonly attributes: string; readonly key: number; readonly name: string }[];
  readonly vatRate: VatRate;
  readonly weightGrams: string;
  readonly widthMm: string;
}

export const measurementText = (value: Option.Option<number> | undefined): string =>
  Option.match(value ?? Option.none(), { onNone: () => '', onSome: String });

export const measurementOf = (value: string): number | null => (value.trim() === '' ? null : Number(value));

export const measurementInvalid = (value: string): boolean => {
  const number = measurementOf(value);
  return number !== null && (!Number.isInteger(number) || number < 1 || number > 1_000_000_000);
};

const legacyVariantDraftsOf = (product: ProductRecord): DetailDraft['variants'] => {
  const variants: DetailDraft['variants'][number][] = [];
  for (const variant of product.variants ?? []) {
    if (!isRealVariant(variant)) {
      variants.push({ attributes: variant.attributes, key: variants.length, name: variant.name });
    }
  }
  return variants;
};

/** The draft of an existing product, read from the register. */
export const draftOf = (product: ProductRecord): DetailDraft => ({
  active: product.active,
  category: product.category,
  description: product.description ?? '',
  heightMm: measurementText(product.heightMm),
  lengthMm: measurementText(product.lengthMm),
  lowStock: product.lowStockThreshold,
  lowStockText: String(product.lowStockThreshold),
  name: product.name,
  nextVariantId: product.variants?.length ?? 0,
  priceCzk: product.currentPriceMinor / 100,
  priceText: moneyInputText(product.currentPriceMinor / 100),
  realVariants: (product.variants ?? []).filter(isRealVariant),
  shortDescription: product.shortDescription ?? '',
  unit: product.unit,
  variants: legacyVariantDraftsOf(product),
  vatRate: product.vatRate,
  weightGrams: measurementText(product.weightGrams),
  widthMm: measurementText(product.widthMm),
});

/**
 * Two drafts that would be saved the same: the server trims every text, and the money/stock inputs are read as
 * numbers, so surrounding spaces, `05` for `5` or `2,50` for `2.5` do not count as a change.
 */
export const sameDetailDraft = (left: DetailDraft, right: DetailDraft): boolean =>
  left.active === right.active &&
  left.category.trim() === right.category.trim() &&
  left.description.trim() === right.description.trim() &&
  left.heightMm.trim() === right.heightMm.trim() &&
  left.lengthMm.trim() === right.lengthMm.trim() &&
  left.lowStock === right.lowStock &&
  left.name.trim() === right.name.trim() &&
  left.priceCzk === right.priceCzk &&
  left.shortDescription.trim() === right.shortDescription.trim() &&
  left.unit === right.unit &&
  left.vatRate === right.vatRate &&
  left.weightGrams.trim() === right.weightGrams.trim() &&
  left.widthMm.trim() === right.widthMm.trim() &&
  left.variants.length === right.variants.length &&
  left.variants.every((variant, index) => {
    const other = right.variants[index];
    return (
      other !== undefined &&
      variant.name.trim() === other.name.trim() &&
      variant.attributes.trim() === other.attributes.trim()
    );
  });

const metadataOf = (draft: DetailDraft): ProductMetadata => ({
  description: draft.description.trim(),
  heightMm: Option.fromNullOr(measurementOf(draft.heightMm)),
  lengthMm: Option.fromNullOr(measurementOf(draft.lengthMm)),
  shortDescription: draft.shortDescription.trim(),
  variants: [
    ...draft.realVariants,
    ...draft.variants.map(({ attributes, name }) => ({ attributes: attributes.trim(), name: name.trim() })),
  ],
  weightGrams: Option.fromNullOr(measurementOf(draft.weightGrams)),
  widthMm: Option.fromNullOr(measurementOf(draft.widthMm)),
});

const metadataEquivalent = Schema.toEquivalence(ProductMetadataSchema);

const metadataChanged = (draft: DetailDraft, base: DetailDraft): boolean =>
  !metadataEquivalent(metadataOf(draft), metadataOf(base));

export type DetailPatch = { -readonly [Key in keyof ProductPatch]?: ProductPatch[Key] };

export interface DetailSave {
  /** Only the fields that differ; empty when the basic fields are unchanged. */
  readonly patch: DetailPatch;
  readonly priceChanged: boolean;
  /** The price the draft asks for, in minor units. */
  readonly priceMinor: number;
}

/**
 * What one save sends: the basic fields that differ from `base`, and a changed price as its own command. `base`
 * is the draft of the version the server last confirmed (`draftOf` the product the form opened with, then every
 * saved draft), with the same real variants as `draft`. The product on the page is not the base: until the reload
 * after the form's own save lands it still shows the version before that save.
 */
export const detailSaveOf = (draft: DetailDraft, base: DetailDraft): DetailSave => {
  const patch: DetailPatch = metadataChanged(draft, base) ? { ...metadataOf(draft) } : {};
  if (draft.name.trim() !== base.name.trim()) {
    patch.name = draft.name.trim();
  }
  if (draft.category.trim() !== base.category.trim()) {
    patch.category = draft.category.trim();
  }
  if (draft.unit !== base.unit) {
    patch.unit = draft.unit;
  }
  if (draft.vatRate !== base.vatRate) {
    patch.vatRate = draft.vatRate;
  }
  if (draft.lowStock !== base.lowStock) {
    patch.lowStockThreshold = draft.lowStock;
  }
  if (draft.active !== base.active) {
    patch.active = draft.active;
  }
  const priceMinor = Math.round(draft.priceCzk * 100);
  return { patch, priceChanged: priceMinor !== Math.round(base.priceCzk * 100), priceMinor };
};

const tooLong = (value: string, maximum: number): boolean => value.trim().length > maximum;

/** Whether the draft may be sent at all: the command's own limits, not the per-field messages. */
export const detailDraftInvalid = (draft: DetailDraft): boolean =>
  draft.name.trim() === '' ||
  draft.category.trim() === '' ||
  tooLong(draft.name, 200) ||
  tooLong(draft.category, 120) ||
  !Number.isFinite(draft.priceCzk) ||
  draft.priceCzk < 0 ||
  !Number.isInteger(draft.lowStock) ||
  draft.lowStock < 0 ||
  draft.description.trim().length > 20_000 ||
  draft.shortDescription.trim().length > 500 ||
  draft.variants.length > 50 ||
  draft.variants.some(
    (variant) =>
      variant.name.trim() === '' || variant.name.trim().length > 100 || variant.attributes.trim().length > 1000,
  ) ||
  [draft.weightGrams, draft.lengthMm, draft.widthMm, draft.heightMm].some(measurementInvalid);
