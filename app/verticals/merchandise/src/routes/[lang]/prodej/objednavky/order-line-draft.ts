import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import type { VariantId, VariantRecord } from '../../../../../shared/domain/merchandise-model.ts';
import type { ProductRecordState } from '../../provoz/produkty/product-reads.ts';
import { classificationChoice } from '../../provoz/produkty/product-tax-classification.ts';
import type { ClassificationChoice, CompanyVat } from '../../provoz/produkty/product-tax-classification.ts';
import type { DateTime } from 'effect';

export interface DraftLine {
  readonly key: string;
  /** The picked list row; its full record arrives in `record`. */
  readonly picked: Pick<ProductRecord, 'id' | 'name' | 'sku'> | null;
  readonly quantity: number;
  /** The quantity input's text, kept as typed so "2,5" reaches validation instead of becoming 25. */
  readonly quantityText: string;
  /** Full record of the picked product (variants, prices), read on pick. */
  readonly record: ProductRecordState;
  /** Chosen variant of a product with sellable variants. */
  readonly variantId: VariantId | null;
}

export type DraftLinePatch = Partial<Pick<DraftLine, 'picked' | 'quantity' | 'quantityText' | 'record' | 'variantId'>>;

/** The full record of a line's product once it has loaded. */
export const lineProduct = (line: DraftLine): ProductRecord | null =>
  line.record.status === 'ready' ? line.record.product : null;

/** Active variants of a product; a product without them is sold as itself. */
export const activeVariants = (product: ProductRecord | null): readonly VariantRecord[] =>
  (product?.variantRecords ?? []).filter((variant) => variant.active);

/**
 * The VAT a line for `product` gets: the product's classification with the rate Tax gives it at `now`. The server
 * snapshots the same rate onto the line; without a rate in force the product cannot be ordered.
 */
export const lineClassification = (
  product: ProductRecord | null,
  vat: CompanyVat,
  now: DateTime.Utc,
): ClassificationChoice | null =>
  product === null || product.taxClassificationCode === undefined
    ? null
    : classificationChoice(vat, product.taxClassificationCode, now);
