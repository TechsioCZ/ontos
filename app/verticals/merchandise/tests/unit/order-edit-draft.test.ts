import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { ProductIdSchema, VariantIdSchema } from '../../shared/domain/merchandise-model.ts';
import {
  parseAmount,
  parseQuantity,
  sameOrderDraft,
} from '../../src/routes/[lang]/prodej/objednavky/order-edit-draft.ts';
import type { Draft, DraftLine } from '../../src/routes/[lang]/prodej/objednavky/order-edit-draft.ts';

const coffee = Schema.decodeSync(ProductIdSchema)('product-coffee');
const tea = Schema.decodeSync(ProductIdSchema)('product-tea');
const large = Schema.decodeSync(VariantIdSchema)('variant-large');

const coffeeLine: DraftLine = {
  key: 'existing-0',
  name: 'Etiopie',
  priceText: '258,04',
  productId: coffee,
  quantityText: '2',
  sku: 'ETI-250',
  vatRate: 12,
};
const draft: Draft = {
  city: 'Praha',
  country: 'CZ',
  email: 'jana@example.test',
  lines: [coffeeLine],
  name: 'Jana Nováková',
  note: '',
  phone: '+420 777 123 456',
  postalCode: '11000',
  reason: '',
  shippingMethod: 'OSOBNI_ODBER',
  shippingPriceText: '0',
  street: 'Dlouhá 1',
};

describe('order edit draft', () => {
  it('treats a draft that differs only in spaces or number formatting as already saved', () => {
    expect(sameOrderDraft(draft, { ...draft, name: ' Jana Nováková ', note: '   ' })).toBe(true);
    expect(sameOrderDraft(draft, { ...draft, shippingPriceText: '0,00' })).toBe(true);
    expect(
      sameOrderDraft(draft, {
        ...draft,
        lines: [{ ...coffeeLine, priceText: '258,040', quantityText: '2,0' }],
      }),
    ).toBe(true);
  });

  it('notices a changed field, a changed line and a different line count', () => {
    expect(sameOrderDraft(draft, { ...draft, street: 'Dlouhá 2' })).toBe(false);
    expect(sameOrderDraft(draft, { ...draft, reason: 'Oprava adresy' })).toBe(false);
    expect(sameOrderDraft(draft, { ...draft, shippingMethod: 'PPL' })).toBe(false);
    expect(sameOrderDraft(draft, { ...draft, lines: [{ ...coffeeLine, quantityText: '3' }] })).toBe(false);
    expect(sameOrderDraft(draft, { ...draft, lines: [] })).toBe(false);
    expect(
      sameOrderDraft(draft, {
        ...draft,
        lines: [
          coffeeLine,
          {
            key: 'new-1',
            name: 'Sencha',
            priceText: '180',
            productId: tea,
            quantityText: '1',
            sku: 'SEN-100',
            variantId: large,
            vatRate: 12,
          },
        ],
      }),
    ).toBe(false);
  });

  it('reads the typed quantity and price as numbers the server would store', () => {
    expect(parseQuantity('2')).toBe(2);
    expect(parseQuantity(' 2,5 ')).toBe(2.5);
    expect(parseQuantity('0')).toBeNull();
    expect(parseQuantity('abc')).toBeNull();
    expect(parseAmount('258,04')).toBe(25_804);
    expect(parseAmount('258.040')).toBe(25_804);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('-1')).toBeNull();
  });
});
