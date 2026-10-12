import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { RecordsRequestSchema } from '../../shared/apis/records.ts';
import { MinorAmountSchema } from '../../shared/domain/merchandise-model.ts';

const isPayload = Schema.is(ApplyCommandPayloadSchema);

it('accepts a CreateOrder command with a caller-supplied order id', () => {
  expect(
    isPayload({
      command: {
        _tag: 'CreateOrder',
        id: 'order-1',
        lines: [{ productId: 'product-1', quantity: 2 }],
        partyId: 'party-1',
      },
      expectedRevision: 0,
    }),
  ).toBe(true);
});

it('rejects a VAT rate outside 0, 10, 12, 21', () => {
  expect(
    isPayload({
      command: {
        _tag: 'CreateProduct',
        active: true,
        category: 'IT',
        lowStockThreshold: 2,
        name: 'Kabel',
        priceMinor: 19_900,
        sku: 'KAB-1',
        unit: 'ks',
        vatRate: 15,
      },
      expectedRevision: 0,
    }),
  ).toBe(false);
});

it('keeps ORDER out of manual stock movement reasons', () => {
  expect(
    isPayload({
      command: { _tag: 'RecordStockMovement', delta: -1, productId: 'product-1', reason: 'ORDER' },
      expectedRevision: 0,
    }),
  ).toBe(false);
});

it('rejects fractional money amounts', () => {
  expect(Schema.is(MinorAmountSchema)(199.5)).toBe(false);
  expect(Schema.is(MinorAmountSchema)(19_950)).toBe(true);
});

it('accepts a records request with no view and with a view filter', () => {
  expect(Schema.is(RecordsRequestSchema)({})).toBe(true);
  expect(Schema.is(RecordsRequestSchema)({ view: { lowStockOnly: true, orderStatus: 'NEW' } })).toBe(true);
});
