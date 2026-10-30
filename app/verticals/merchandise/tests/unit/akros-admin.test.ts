import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { MerchandiseCommandSchema, MerchandiseLifecycleConflict } from '../../shared/actions/apply-command.ts';
import {
  AKROS_LEGAL_ENTITY_ID,
  ESHOP_LEGAL_ENTITY_ID,
  staffCommandAllowed,
} from '../../shared/actions/command-guard.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';
import { isOrderQuantityValid, orderQuantityRules } from '../../shared/domain/order-quantity.ts';
import { evolveMerchandiseState } from '../../src/services/persistence.service.ts';

const actor = { principalId: '20000000-0000-4000-8000-000000000002', tenantId: '20000000-0000-4000-8000-000000000001' };
const now = DateTime.makeUnsafe('2026-10-20T15:00:00Z');
const decode = Schema.decodeUnknownSync(MerchandiseCommandSchema);
const apply = (state: MerchandiseState, command: typeof MerchandiseCommandSchema.Encoded) =>
  evolveMerchandiseState(state, decode(command), { actor, now, resourceId: 'admin-proof' });
it('accepts 1 000 pieces in 500-piece packages and rejects stock/minimum/package violations', () => {
  const rules = orderQuantityRules({ minimumQuantity: 500, packageQuantity: 500, stockOnHand: 2000 });
  for (const quantity of [500, 1000, 2000]) {
    expect(isOrderQuantityValid(quantity, rules)).toBe(true);
  }
  for (const quantity of [0, 1, 600, 2500, Number.NaN, Infinity]) {
    expect(isOrderQuantityValid(quantity, rules)).toBe(false);
  }
});
it('allows dispatch only status processing and stock movement while preserving other company behavior', () => {
  for (const tag of [
    'EditOrder',
    'ChangePrice',
    'UpdateProduct',
    'CreateProduct',
    'BulkUpdateProducts',
    'CreateOrder',
    'RemoveDemoOrder',
  ]) {
    expect(staffCommandAllowed(AKROS_LEGAL_ENTITY_ID, false, tag)).toBe(false);
    expect(staffCommandAllowed(AKROS_LEGAL_ENTITY_ID, true, tag)).toBe(true);
  }
  for (const tag of ['ChangeOrderStatus', 'RecordStockMovement']) {
    expect(staffCommandAllowed(AKROS_LEGAL_ENTITY_ID, false, tag)).toBe(true);
  }
  expect(staffCommandAllowed(ESHOP_LEGAL_ENTITY_ID, false, 'EditOrder')).toBe(true);
  expect(staffCommandAllowed(ESHOP_LEGAL_ENTITY_ID, false, 'RemoveDemoOrder')).toBe(false);
});
const seeded = Effect.gen(function* seed() {
  const product = yield* apply(
    { movements: [], orders: [], products: [] },
    {
      _tag: 'CreateProduct',
      active: true,
      category: 'Spojovací materiál',
      lowStockThreshold: 0,
      name: 'Šroub',
      priceMinor: 100,
      sku: 'SROUB',
      unit: 'ks',
      vatRate: 21,
    },
  );
  const stock = yield* apply(product.state, {
    _tag: 'RecordStockMovement',
    delta: 2000,
    productId: 'admin-proof',
    reason: 'RECEIPT',
  });
  const placed = yield* apply(stock.state, {
    _tag: 'PlaceStorefrontOrder',
    clientRequestId: 'akros-admin-proof-1',
    contact: { email: 'jan@example.invalid', name: 'Jan Ukázkový' },
    deliveryAddress: { city: 'Brno', postalCode: '60200', street: 'Ukázková 1' },
    lines: [{ expectedUnitPriceMinor: 121, productId: 'admin-proof', quantity: 1000 }],
    partyId: 'test-customer-party',
    shippingMethod: 'OSOBNI_ODBER',
  });
  return placed.state;
});
it.effect('saves a note on a 1 000-piece order without modifying quantity or stock', () =>
  Effect.gen(function* unchangedQuantity() {
    const state = yield* seeded;
    const changed = yield* apply(state, {
      _tag: 'EditOrder',
      id: state.orders[0].id,
      note: 'Upřesnění objednávky',
      reason: 'Dohoda se zákazníkem',
    });
    expect(changed.state.orders[0]?.lines[0]?.quantity).toBe(1000);
    expect(changed.state.orders[0]?.history?.at(-1)?.actor).toEqual(actor);
    expect(changed.state.movements).toBe(state.movements);
  }),
);
it.effect('cleans a terminal DEMO order with retained audit and submission replay identity', () =>
  Effect.gen(function* remove() {
    const state = yield* seeded;
    const terminal: MerchandiseState = {
      ...state,
      orders: state.orders.map((order) => ({ ...order, demo: true, status: 'DELIVERED' as const })),
    };
    const changed = yield* apply(terminal, {
      _tag: 'RemoveDemoOrder',
      id: terminal.orders[0].id,
      reason: 'Úklid prezentace',
    });
    expect(changed.state.orders[0]?.demoCleanup?.actor).toEqual(actor);
    expect(changed.state.orders[0]?.clientRequestId).toBe('akros-admin-proof-1');
    expect(changed.state.orders[0]?.history?.at(-1)?.reason).toBe('Úklid prezentace');
    expect(changed.state.orders[0]?.status).toBe('DELIVERED');
    expect(
      changed.state.movements
        .filter((movement) => movement.reason === 'ORDER')
        .reduce((sum, movement) => sum + movement.delta, 0),
    ).toBe(0);
    const repeat = yield* apply(changed.state, {
      _tag: 'RemoveDemoOrder',
      id: terminal.orders[0].id,
      reason: 'Úklid prezentace',
    });
    expect(repeat.state).toBe(changed.state);
  }),
);
it.effect('never removes non-DEMO or staff orders', () =>
  Effect.gen(function* reject() {
    const state = yield* seeded;
    for (const patch of [{ demo: false }, { channel: 'STAFF' as const }]) {
      const guarded = { ...state, orders: state.orders.map((order) => ({ ...order, ...patch })) };
      const failure = yield* apply(guarded, {
        _tag: 'RemoveDemoOrder',
        id: state.orders[0].id,
        reason: 'Úklid prezentace',
      }).pipe(Effect.flip);
      expect(Schema.is(MerchandiseLifecycleConflict)(failure)).toBe(true);
    }
  }),
);

it('preserves fractional-length packages and does not invent an integer package rule', () => {
  const rules = orderQuantityRules({ minimumQuantity: 6.21, packageQuantity: 6.21, stockOnHand: 100 });
  expect(isOrderQuantityValid(12.42, rules)).toBe(true);
  expect(isOrderQuantityValid(12.4, rules)).toBe(false);
  expect(isOrderQuantityValid(1.5, orderQuantityRules({ stockOnHand: 10 }))).toBe(true);
  expect(isOrderQuantityValid(0.75, orderQuantityRules({ minimumQuantity: 0.5, stockOnHand: 10 }))).toBe(true);
});
