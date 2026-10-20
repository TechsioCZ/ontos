import { expect, it } from 'effect-rstest';
import type { MerchandiseStateSchema } from '../../shared/apis/records.ts';
import { refreshAkrosOrderPresentation, refreshObchodOrderPresentation } from '../../scripts/order-presentation.ts';

type State = typeof MerchandiseStateSchema.Encoded;
const order: State['orders'][number] = {
  id: '53de7381-a66b-5a10-b5e7-ad0c41db2942',
  number: 'OBJ-2026-0018',
  createdAt: '2025-11-20T08:00:00.000Z',
  updatedAt: '2025-11-20T08:00:00.000Z',
  status: 'CONFIRMED',
  partyId: 'customer',
  totalMinor: 11046090,
  totalVatMinor: 1917090,
  lines: [{ productId: 'p', productName: 'Počítač', quantity: 1, sku: 'PC', unitPriceMinor: 9129000, vatRate: 21 }],
};
const state: State = {
  products: [],
  orders: [order],
  movements: [
    { id: 'movement', productId: 'p', reason: 'ORDER', delta: -1, reference: order.number, at: order.createdAt },
    { id: 'receipt', productId: 'p', reason: 'RECEIPT', delta: 10, at: order.createdAt },
  ],
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
    id: '2d4f33c1-d9ca-5bc8-8c9d-1ea4f78ab384',
    contact: { name: 'Jan Novák', email: 'zakaznik1@example.invalid' },
    clientRequestId: 'akros-sample-order-0',
    history: [],
  };
  const input = {
    ...state,
    orders: [
      sample,
      { ...sample, id: 'visitor' },
      {
        ...sample,
        id: '35dfeed7-61d7-518c-9cc4-8403ab864580',
        contact: { name: 'Petra Malá', email: 'petra@demo.invalid' },
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
