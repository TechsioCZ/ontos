import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { MerchandiseCommandSchema, MerchandiseLifecycleConflict } from '../../shared/actions/apply-command.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';
import { assertStorefrontScope } from '../../shared/actions/command-guard.ts';
import { evolveMerchandiseState, toProductRecord } from '../../src/services/persistence.service.ts';

const actor = {
  principalId: '20000000-0000-4000-8000-000000000002',
  tenantId: '20000000-0000-4000-8000-000000000001',
};
const t0 = DateTime.makeUnsafe('2026-10-19T10:00:00Z');
const empty: MerchandiseState = { movements: [], orders: [], products: [] };
const decodeCommand = Schema.decodeUnknownSync(MerchandiseCommandSchema);
const isConflict = Schema.is(MerchandiseLifecycleConflict);
type CommandInput = typeof MerchandiseCommandSchema.Encoded;

const apply = (state: MerchandiseState, command: CommandInput, resourceId: string) =>
  evolveMerchandiseState(state, decodeCommand(command), { actor, now: t0, resourceId });

/** Coffee (12 % VAT) with two real variants: 250 g at net 25 804 (gross 289 Kč) and 1 kg at net 88 304 (989 Kč). */
const seeded = Effect.gen(function* seedCoffee() {
  const created = yield* apply(
    empty,
    {
      _tag: 'CreateProduct',
      active: true,
      category: 'Zrnková káva',
      lowStockThreshold: 3,
      name: 'Etiopie',
      priceMinor: 25_804,
      sku: 'ETH',
      unit: 'ks',
      vatRate: 12,
    },
    'p1',
  );
  const withVariants = yield* apply(
    created.state,
    {
      _tag: 'UpdateProduct',
      id: 'p1',
      patch: {
        variants: [
          { attributes: '250 g', name: '250 g / zrnková', priceMinor: 25_804, sku: 'ETH-250' },
          { attributes: '1 kg', name: '1 kg / zrnková', priceMinor: 88_304, sku: 'ETH-1KG' },
        ],
      },
    },
    'u1',
  );
  const stocked = yield* apply(
    withVariants.state,
    { _tag: 'RecordStockMovement', delta: 10, productId: 'p1', reason: 'RECEIPT', variantId: 'u1-v1' },
    'm1',
  );
  return stocked.state;
});

const guestOrder = (
  overrides: Partial<Extract<CommandInput, { _tag: 'PlaceStorefrontOrder' }>> = {},
): CommandInput => ({
  _tag: 'PlaceStorefrontOrder',
  clientRequestId: 'client-request-0001',
  contact: { email: 'tereza@example.cz', name: 'Tereza Ukázková' },
  deliveryAddress: { city: 'Brno', postalCode: '602 00', street: 'Ukázková 12' },
  lines: [{ expectedUnitPriceMinor: 28_900, productId: 'p1', quantity: 2, variantId: 'u1-v1' }],
  shippingMethod: 'ZASILKOVNA',
  ...overrides,
});

it.effect('variants get identities, gross prices and their own availability', () =>
  Effect.gen(function* variantRecords() {
    const state = yield* seeded;
    const [product] = state.products;
    const record = toProductRecord(product!, state.movements);
    expect(
      record.variantRecords?.map((variant) => [variant.id, variant.grossPriceMinor, variant.availability]),
    ).toEqual([
      ['u1-v1', 28_900, 'IN_STOCK'],
      ['u1-v2', 98_900, 'OUT_OF_STOCK'],
    ]);
    expect(record.grossPriceMinor).toBe(28_900);
    expect(record.availability).toBe('IN_STOCK');
  }),
);

it.effect('PlaceStorefrontOrder saves once and replays the same order for the same client request id', () =>
  Effect.gen(function* idempotent() {
    const state = yield* seeded;
    const first = yield* apply(state, guestOrder(), 'inv-1');
    expect(first.storefrontOrder?.outcome).toBe('PLACED');
    expect(first.storefrontOrder?.orderNumber).toBe('OBJ-2026-0001');
    expect(first.storefrontOrder?.totalMinor).toBe(2 * 28_900 + 7_900);
    const [order] = first.state.orders;
    expect(order?.demo).toBe(true);
    expect(order?.status).toBe('NEW');
    expect(first.state.movements).toHaveLength(state.movements.length);
    const again = yield* apply(first.state, guestOrder(), 'inv-2');
    expect(again.storefrontOrder?.outcome).toBe('REPLAYED');
    expect(again.storefrontOrder?.orderNumber).toBe('OBJ-2026-0001');
    expect(again.state).toBe(first.state);
    expect(again.state.orders).toHaveLength(1);
  }),
);

it.effect('PlaceStorefrontOrder rejects a stale price with the current one and saves nothing', () =>
  Effect.gen(function* stalePrice() {
    const state = yield* seeded;
    const result = yield* apply(
      state,
      guestOrder({ lines: [{ expectedUnitPriceMinor: 25_000, productId: 'p1', quantity: 1, variantId: 'u1-v1' }] }),
      'inv-1',
    );
    expect(result.state).toBe(state);
    expect(result.storefrontOrder?.outcome).toBe('REJECTED');
    expect(result.storefrontOrder?.issues[0]?.code).toBe('PRICE_CHANGED');
    expect(result.storefrontOrder?.issues[0]?.currentUnitPriceMinor).toBe(28_900);
  }),
);

it.effect('PlaceStorefrontOrder rejects sold-out variants and missing variant choice', () =>
  Effect.gen(function* unavailable() {
    const state = yield* seeded;
    const soldOut = yield* apply(
      state,
      guestOrder({ lines: [{ expectedUnitPriceMinor: 98_900, productId: 'p1', quantity: 1, variantId: 'u1-v2' }] }),
      'inv-1',
    );
    expect(soldOut.storefrontOrder?.issues.map((issue) => issue.code)).toEqual(['OUT_OF_STOCK']);
    const noVariant = yield* apply(
      state,
      guestOrder({ lines: [{ expectedUnitPriceMinor: 28_900, productId: 'p1', quantity: 1 }] }),
      'inv-2',
    );
    expect(noVariant.storefrontOrder?.issues.map((issue) => issue.code)).toEqual(['VARIANT_REQUIRED']);
  }),
);

it.effect('EditOrder recomputes totals and records before/after history; DELIVERED needs SHIPPED first', () =>
  Effect.gen(function* edit() {
    const state = yield* seeded;
    const placed = yield* apply(state, guestOrder(), 'inv-1');
    const orderId = placed.state.orders[0]!.id;
    const edited = yield* apply(
      placed.state,
      {
        _tag: 'EditOrder',
        id: orderId,
        lines: [{ productId: 'p1', quantity: 3, unitPriceMinor: 27_000, variantId: 'u1-v1' }],
        reason: 'Telefonická změna',
        shipping: { method: 'PPL', priceMinor: 9_900 },
      },
      'inv-2',
    );
    const order = edited.state.orders[0]!;
    expect(order.totalMinor).toBe(3 * 27_000 + 9_900);
    expect(order.history?.map((entry) => entry.kind)).toEqual(['CREATED', 'LINES', 'SHIPPING']);
    expect(order.history?.[1]?.reason).toBe('Telefonická změna');
    const skip = yield* Effect.flip(
      apply(edited.state, { _tag: 'ChangeOrderStatus', id: orderId, status: 'DELIVERED' }, 'inv-3'),
    );
    expect(isConflict(skip)).toBe(true);
    const confirmed = yield* apply(
      edited.state,
      { _tag: 'ChangeOrderStatus', id: orderId, status: 'CONFIRMED' },
      'inv-4',
    );
    const packing = yield* apply(
      confirmed.state,
      { _tag: 'ChangeOrderStatus', id: orderId, status: 'PACKING' },
      'inv-5',
    );
    const shipped = yield* apply(packing.state, { _tag: 'ChangeOrderStatus', id: orderId, status: 'SHIPPED' }, 'inv-6');
    const done = yield* apply(shipped.state, { _tag: 'ChangeOrderStatus', id: orderId, status: 'DELIVERED' }, 'inv-7');
    expect(done.state.orders[0]?.status).toBe('DELIVERED');
    expect(done.state.orders[0]?.history?.filter((entry) => entry.kind === 'STATUS')).toHaveLength(4);
  }),
);

it.effect('ChangePrice on a variant appends its own price history', () =>
  Effect.gen(function* variantPrice() {
    const state = yield* seeded;
    const changed = yield* apply(
      state,
      { _tag: 'ChangePrice', id: 'p1', priceMinor: 26_696, variantId: 'u1-v1' },
      'c1',
    );
    const record = toProductRecord(changed.state.products[0]!, changed.state.movements);
    const variant = record.variantRecords?.[0];
    expect(variant?.grossPriceMinor).toBe(29_900);
    expect(variant?.priceHistory).toHaveLength(2);
  }),
);

it.effect('the storefront API key may only place guest orders in the e-shop company', () =>
  Effect.gen(function* guard() {
    const eshop = '71000000-0000-4000-8000-000000000023';
    yield* assertStorefrontScope('non_human', eshop, 'PlaceStorefrontOrder');
    const denied = yield* Effect.flip(assertStorefrontScope('non_human', eshop, 'CreateProduct'));
    expect(denied._tag).toBe('MerchandisePermissionDenied');
    yield* assertStorefrontScope('human', eshop, 'EditOrder');
  }),
);
