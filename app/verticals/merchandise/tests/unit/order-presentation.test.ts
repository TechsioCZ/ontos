import { expect, it } from 'effect-rstest';
import type { MerchandiseStateSchema } from '../../shared/apis/records.ts';
import { refreshAkrosOrderPresentation, refreshObchodOrderPresentation } from '../../scripts/order-presentation.ts';

type State = typeof MerchandiseStateSchema.Encoded;
const order: State['orders'][number] = {
  createdAt: '2025-11-20T08:00:00.000Z',
  id: '53de7381-a66b-5a10-b5e7-ad0c41db2942',
  lines: [{ productId: 'p', productName: 'Počítač', quantity: 1, sku: 'PC', unitPriceMinor: 9_129_000, vatRate: 21 }],
  number: 'OBJ-2026-0018',
  partyId: 'customer',
  status: 'CONFIRMED',
  totalMinor: 11_046_090,
  totalVatMinor: 1_917_090,
  updatedAt: '2025-11-20T08:00:00.000Z',
};
const state: State = {
  movements: [
    { at: order.createdAt, delta: -1, id: 'movement', productId: 'p', reason: 'ORDER', reference: order.number },
    { at: order.createdAt, delta: 10, id: 'receipt', productId: 'p', reason: 'RECEIPT' },
  ],
  orders: [order],
  products: [],
};

it('refreshes only selected open seed timestamps, retaining prices, quantities and matched movement chronology', () => {
  const fixed = refreshObchodOrderPresentation(state);
  expect(fixed.orders[0]).toEqual({
    ...order,
    createdAt: '2026-10-19T08:00:00.000Z',
    updatedAt: '2026-10-20T07:00:00.000Z',
  });
  expect(fixed.movements[0]).toEqual({ ...state.movements[0], at: '2026-10-19T08:00:00.000Z' });
  expect(fixed.movements[1]).toEqual(state.movements[1]);
  expect(refreshObchodOrderPresentation(fixed)).toEqual(fixed);
});
it('preserves completed orders, edited records and unrelated company fixture identities', () => {
  for (const candidate of [
    { ...order, status: 'DELIVERED' as const },
    { ...order, updatedAt: '2026-10-20T08:00:00.000Z' },
    { ...order, id: 'other' },
    { ...order, number: 'OBJ-2026-9999' },
  ]) {
    const input = { ...state, orders: [candidate] };
    expect(refreshObchodOrderPresentation(input)).toEqual(input);
  }
});
it('replaces only six known placeholder contacts and retains audit/replay identity', () => {
  const sample = {
    ...order,
    clientRequestId: 'akros-sample-order-0',
    contact: { email: 'zakaznik1@example.invalid', name: 'Jan Novák' },
    history: [],
    id: '2d4f33c1-d9ca-5bc8-8c9d-1ea4f78ab384',
  };
  const input = {
    ...state,
    orders: [
      sample,
      { ...sample, id: 'visitor' },
      {
        ...sample,
        contact: { email: 'petra@demo.invalid', name: 'Petra Malá' },
        id: '35dfeed7-61d7-518c-9cc4-8403ab864580',
      },
    ],
  };
  const fixed = refreshAkrosOrderPresentation(input);
  expect(fixed.orders[0]).toEqual({ ...sample, contact: { ...sample.contact, email: 'jan.novak@akros-demo.invalid' } });
  expect(fixed.orders.slice(1)).toEqual(input.orders.slice(1));
  expect(fixed.movements).toEqual(input.movements);
  expect(fixed.products).toEqual(input.products);
  expect(refreshAkrosOrderPresentation(fixed)).toEqual(fixed);
});
