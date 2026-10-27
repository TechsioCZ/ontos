import type { Order, MerchandiseStateSchema } from '../shared/apis/records.ts';

type Encoded = typeof MerchandiseStateSchema.Encoded;

/** Fictional named contacts; .invalid is reserved and cannot address a real mailbox. */
export const akrosSampleContacts = [
  { email: 'jan.novak@akros-demo.invalid', name: 'Jan Novák' },
  { email: 'petra.mala@akros-demo.invalid', name: 'Petra Malá' },
  { email: 'karel.dvorak@akros-demo.invalid', name: 'Karel Dvořák' },
  { email: 'jana.vesela@akros-demo.invalid', name: 'Jana Veselá' },
  { email: 'pavel.cerny@akros-demo.invalid', name: 'Pavel Černý' },
  { email: 'eva.bila@akros-demo.invalid', name: 'Eva Bílá' },
] as const;
const akrosOrderIds = [
  '2d4f33c1-d9ca-5bc8-8c9d-1ea4f78ab384',
  '35dfeed7-61d7-518c-9cc4-8403ab864580',
  'bad65908-6475-5c0c-935e-f4d404746829',
  '985b5ec5-6116-53c4-9999-ae169da68feb',
  '6c62c028-85af-5c2c-aef2-24d3e35ac6b1',
  '3c19e491-9840-5e44-bbbd-729f767b3699',
];

/** Bootstrap converts only the six known demo orders; real contacts require separate operator intent. */
export const orderCustomerSeedEligible = (order: Order, includeRealOrders: boolean): boolean =>
  order.demoCleanup === undefined &&
  order.channel === 'STOREFRONT' &&
  order.contact !== undefined &&
  (includeRealOrders || (order.demo === true && akrosOrderIds.includes(order.id)));

/** Only replace untouched fixture placeholders, never visitor contacts or staff edits. */
export const refreshAkrosOrderPresentation = (state: Encoded): Encoded => ({
  ...state,
  orders: state.orders.map((order) => {
    const index = akrosOrderIds.indexOf(order.id);
    const contact = akrosSampleContacts[index];
    if (contact === undefined || order.contact?.email !== `zakaznik${index + 1}@example.invalid`) {
      return order;
    }
    return { ...order, contact: { ...order.contact, email: contact.email } };
  }),
});

/** Fixed presentation dates, not a moving clock. Preserve completed history and financial snapshots. */
const obchodOpenOrders = [
  {
    createdAt: '2026-10-16T08:00:00.000Z',
    id: '55fe62e5-99e2-53ee-9b6b-126e1acb48a6',
    number: 'OBJ-2026-0016',
    status: 'SHIPPED',
    updatedAt: '2026-10-19T12:00:00.000Z',
  },
  {
    createdAt: '2026-10-16T09:00:00.000Z',
    id: 'd22db708-c590-53e0-a482-cf3b225ed38f',
    number: 'OBJ-2026-0017',
    status: 'CONFIRMED',
    updatedAt: '2026-10-19T10:00:00.000Z',
  },
  {
    createdAt: '2026-10-19T08:00:00.000Z',
    id: '53de7381-a66b-5a10-b5e7-ad0c41db2942',
    number: 'OBJ-2026-0018',
    status: 'CONFIRMED',
    updatedAt: '2026-10-20T07:00:00.000Z',
  },
  {
    createdAt: '2026-10-18T08:00:00.000Z',
    id: '6cc710be-6aad-529c-ae88-6d25da11362f',
    number: 'OBJ-2026-0039',
    status: 'SHIPPED',
    updatedAt: '2026-10-19T13:00:00.000Z',
  },
  {
    createdAt: '2026-10-19T09:00:00.000Z',
    id: 'e13b65b9-73c5-594d-8f9a-8235aa899c1c',
    number: 'OBJ-2026-0040',
    status: 'CONFIRMED',
    updatedAt: '2026-10-20T08:00:00.000Z',
  },
] as const;

export const refreshObchodOrderPresentation = (state: Encoded): Encoded => {
  const refreshed = new Map<string, { after: string; before: string }>();
  const orders = state.orders.map((order) => {
    const target = obchodOpenOrders.find(
      (entry) => entry.id === order.id && entry.number === order.number && entry.status === order.status,
    );
    // An updated live record is not an untouched old seed: leave it alone.
    if (target === undefined || order.createdAt >= '2026-01-01' || order.updatedAt !== order.createdAt) {
      return order;
    }
    refreshed.set(order.number, { after: target.createdAt, before: order.createdAt });
    return { ...order, createdAt: target.createdAt, updatedAt: target.updatedAt };
  });
  return {
    ...state,
    movements: state.movements.map((movement) => {
      const dates = movement.reference === undefined ? undefined : refreshed.get(movement.reference);
      return dates !== undefined && movement.reason === 'ORDER' && movement.at === dates.before
        ? { ...movement, at: dates.after }
        : movement;
    }),
    orders,
  };
};
