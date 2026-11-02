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

const product: ProductRecord = Schema.decodeSync(ProductRecordSchema)({
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
});
const saved = draftOf(product);

describe('product detail autosave draft', () => {
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
    const untouched = detailSaveOf(saved, product);
    expect(untouched.patch).toEqual({});
    expect(untouched.priceChanged).toBe(false);

    const renamed = detailSaveOf({ ...saved, active: false, name: ' Etiopie B ' }, product);
    expect(renamed.patch).toEqual({ active: false, name: 'Etiopie B' });
    expect(renamed.priceChanged).toBe(false);

    const repriced = detailSaveOf({ ...saved, priceCzk: 300 }, product);
    expect(repriced.patch).toEqual({});
    expect(repriced.priceChanged).toBe(true);
    expect(repriced.priceMinor).toBe(30_000);

    const edited = detailSaveOf(
      { ...saved, description: 'Nová káva', lowStock: 5, shortDescription: '', vatRate: 21 },
      product,
    );
    expect(edited.patch).toMatchObject({
      description: 'Nová káva',
      lowStockThreshold: 5,
      shortDescription: '',
      vatRate: 21,
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
