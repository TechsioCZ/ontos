import { CZ_VAT_REDUCED, CZ_VAT_STANDARD } from '@app/shared-contracts/cz-vat-classifications';
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { ProductRecordSchema } from '../../shared/domain/merchandise-model.ts';
import type { ProductRecord } from '../../shared/domain/merchandise-model.ts';
import {
  detailDraftInvalid,
  detailSaveOf,
  draftOf,
  measurementInvalid,
  sameDetailDraft,
} from '../../src/routes/[lang]/provoz/produkty/product-detail-draft.ts';

// contract: once package B's ProductSchema carries `taxClassificationCode`, put it into the decoded input and drop
// `vatRate` and this spread.
const product: ProductRecord = {
  ...Schema.decodeSync(ProductRecordSchema)({
    active: true,
    category: 'Zrnková káva',
    createdAt: '2026-10-20T09:00:00.000Z',
    currentPriceMinor: 25_804,
    description: 'Etiopie, 250 g.',
    id: 'product-1',
    lowStock: false,
    lowStockThreshold: 3,
    name: 'Etiopie',
    priceHistory: [],
    shortDescription: 'Svěží káva',
    sku: 'ETI-250',
    stockOnHand: 12,
    stockValueMinor: 309_648,
    unit: 'ks',
    updatedAt: '2026-10-20T09:00:00.000Z',
    variants: [{ attributes: 'velikost: 250 g', name: '250 g' }],
    vatRate: 12,
  }),
  taxClassificationCode: CZ_VAT_REDUCED,
};
const saved = draftOf(product);

describe('product detail draft', () => {
  it('treats a draft that differs only in spaces or number formatting as already saved', () => {
    expect(sameDetailDraft(saved, { ...saved, lowStockText: '03', name: 'Etiopie ', priceText: '258.040' })).toBe(true);
    expect(sameDetailDraft(saved, { ...saved, name: 'Etiopie A' })).toBe(false);
    expect(sameDetailDraft(saved, { ...saved, priceCzk: 258.05 })).toBe(false);
    expect(sameDetailDraft(saved, { ...saved, active: false })).toBe(false);
    expect(
      sameDetailDraft(saved, { ...saved, variants: [{ attributes: 'velikost: 250 g', key: 0, name: 'Půl kila' }] }),
    ).toBe(false);
  });

  it('sends only the changed fields and a changed price as its own change', () => {
    const untouched = detailSaveOf(saved, saved);
    expect(untouched.patch).toEqual({});
    expect(untouched.priceChanged).toBe(false);

    const renamed = detailSaveOf({ ...saved, active: false, name: ' Etiopie B ' }, saved);
    expect(renamed.patch).toEqual({ active: false, name: 'Etiopie B' });
    expect(renamed.priceChanged).toBe(false);

    const repriced = detailSaveOf({ ...saved, priceCzk: 300 }, saved);
    expect(repriced.patch).toEqual({});
    expect(repriced.priceChanged).toBe(true);
    expect(repriced.priceMinor).toBe(30_000);

    const edited = detailSaveOf(
      { ...saved, description: 'Nová káva', lowStock: 5, shortDescription: '', taxClassificationCode: CZ_VAT_STANDARD },
      saved,
    );
    expect(edited.patch).toMatchObject({
      description: 'Nová káva',
      lowStockThreshold: 5,
      shortDescription: '',
      taxClassificationCode: CZ_VAT_STANDARD,
    });
    expect(edited.patch).not.toHaveProperty('vatRate');
  });

  it('takes the classification from the product and treats a changed one as an unsaved change', () => {
    expect(saved.taxClassificationCode).toBe(CZ_VAT_REDUCED);
    expect(saved).not.toHaveProperty('vatRate');
    expect(sameDetailDraft(saved, { ...saved, taxClassificationCode: CZ_VAT_STANDARD })).toBe(false);
    expect(detailSaveOf({ ...saved, taxClassificationCode: CZ_VAT_STANDARD }, saved).patch).toEqual({
      taxClassificationCode: CZ_VAT_STANDARD,
    });
  });

  it('never sends a draft the command would refuse', () => {
    expect(detailDraftInvalid(saved)).toBe(false);
    expect(detailDraftInvalid({ ...saved, name: '  ' })).toBe(true);
    expect(detailDraftInvalid({ ...saved, category: '' })).toBe(true);
    expect(detailDraftInvalid({ ...saved, name: 'n'.repeat(201) })).toBe(true);
    expect(detailDraftInvalid({ ...saved, lowStock: -1 })).toBe(true);
    expect(detailDraftInvalid({ ...saved, priceCzk: -1 })).toBe(true);
    expect(detailDraftInvalid({ ...saved, widthMm: '2,5' })).toBe(true);
    expect(detailDraftInvalid({ ...saved, variants: [{ attributes: '', key: 0, name: '   ' }] })).toBe(true);
    expect(measurementInvalid('')).toBe(false);
    expect(measurementInvalid('0')).toBe(true);
  });
});
