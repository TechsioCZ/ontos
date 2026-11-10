// The draft of the "E-shop a obrázky" tab and the commands one Uložit sends for it.
import { Predicate } from 'effect';
import type { ProductPatch } from '../../../../../shared/actions/apply-command.ts';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import type { ProductCommand } from './products-api.ts';

export interface EshopDraft {
  /** The gallery in the order the e-shop shows it; the first picture is the main one. */
  readonly images: readonly string[];
  readonly published: boolean;
  readonly slug: string;
  readonly stockTracked: boolean;
}

export const slugInvalidOf = (slug: string) => slug.trim() !== '' && !/^[a-z0-9-]{1,120}$/u.test(slug.trim());

export const eshopDraftOf = (product: ProductRecord): EshopDraft => ({
  images: product.images ?? [],
  published: product.published !== false,
  slug: product.slug ?? '',
  stockTracked: product.stockTracked !== false,
});

export const sameImages = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((image, index) => image === right[index]);

/** What one save sends: only the parts of the draft that differ from the version the server confirmed. */
export const eshopCommandsOf = (
  productId: ProductRecord['id'],
  value: EshopDraft,
  confirmed: EshopDraft,
): readonly ProductCommand[] => {
  const commands: ProductCommand[] = [];
  const settingsChanged =
    value.published !== confirmed.published ||
    value.slug !== confirmed.slug ||
    value.stockTracked !== confirmed.stockTracked;
  if (settingsChanged) {
    const patch: { -readonly [Key in keyof ProductPatch]: ProductPatch[Key] } = {
      published: value.published,
      stockTracked: value.stockTracked,
    };
    if (value.slug.trim() !== '') {
      patch.slug = value.slug.trim();
    }
    commands.push({ _tag: 'UpdateProduct', id: productId, patch });
  }
  if (!sameImages(value.images, confirmed.images)) {
    commands.push({ _tag: 'ChangeProductImages', change: { _tag: 'Set', images: value.images }, id: productId });
  }
  return commands;
};

/**
 * What the server has when the settings of one save went through and its gallery was refused: the draft's settings
 * with the confirmed gallery. A retry then sends the gallery alone.
 */
export const eshopPartlyConfirmed = (
  value: EshopDraft,
  confirmed: EshopDraft,
  sent: readonly ProductCommand[],
): EshopDraft => (sent.some(Predicate.isTagged('UpdateProduct')) ? { ...value, images: confirmed.images } : confirmed);
