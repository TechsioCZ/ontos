import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { MerchandiseCommandSchema } from '../../shared/actions/apply-command.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';
import { shippingMethodFor } from '../../shared/domain/merchandise-model.ts';
import { storefrontBrandOf } from '../../shared/domain/storefront-brand.ts';
import { evolveMerchandiseState } from '../../src/services/persistence.service.ts';

const demoShopCompany = '71000000-0000-4000-8000-000000000024';
const akrosPlaygroundCompany = 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7';
const kavarnaCompany = '71000000-0000-4000-8000-000000000023';

it('names each e-shop after its own company and keeps AKROS only for the AKROS company', () => {
  expect(storefrontBrandOf(demoShopCompany)).toBe('ŠroubShop');
  expect(storefrontBrandOf(akrosPlaygroundCompany)).toBe('AKROS');
  expect(storefrontBrandOf(kavarnaCompany)).toBe('Kavárna Doma');
  expect(storefrontBrandOf('71000000-0000-4000-8000-000000000021')).toBeUndefined();
});

it('names personal pickup after the brand and leaves it unnamed without one', () => {
  expect(shippingMethodFor('OSOBNI_ODBER', 'ŠroubShop').label).toBe('Osobní odběr – ŠroubShop');
  expect(shippingMethodFor('OSOBNI_ODBER', 'AKROS').label).toBe('Osobní odběr – AKROS');
  expect(shippingMethodFor('OSOBNI_ODBER').label).toBe('Osobní odběr');
  expect(shippingMethodFor('PPL', 'ŠroubShop').label).toBe('PPL – doručení na adresu');
});

const actor = {
  principalId: '20000000-0000-4000-8000-000000000002',
  tenantId: '20000000-0000-4000-8000-000000000001',
};
const now = DateTime.makeUnsafe('2026-11-02T10:00:00Z');
const decodeCommand = Schema.decodeUnknownSync(MerchandiseCommandSchema);
type CommandInput = typeof MerchandiseCommandSchema.Encoded;

/** One stocked product of an imported source catalog. */
const sourceCatalogState = Effect.gen(function* seedSourceCatalog() {
  const empty: MerchandiseState = { movements: [], orders: [], products: [] };
  const apply = (state: MerchandiseState, command: CommandInput, resourceId: string) =>
    evolveMerchandiseState(state, decodeCommand(command), { actor, now, resourceId });
  const created = yield* apply(
    empty,
    {
      _tag: 'CreateProduct',
      active: true,
      category: 'Šrouby',
      lowStockThreshold: 3,
      name: 'Šroub DIN 912',
      priceMinor: 1000,
      sku: 'DIN912',
      unit: 'ks',
      vatRate: 21,
    },
    'p1',
  );
  const stocked = yield* apply(
    created.state,
    { _tag: 'RecordStockMovement', delta: 10, productId: 'p1', reason: 'RECEIPT' },
    'm1',
  );
  const sourceCatalog: MerchandiseState = { ...stocked.state, sourceCatalog: true };
  return sourceCatalog;
});

const pickupOrder = decodeCommand({
  _tag: 'PlaceStorefrontOrder',
  clientRequestId: 'client-request-0001',
  contact: { email: 'tereza@example.cz', name: 'Tereza Ukázková' },
  deliveryAddress: { city: 'Jihlava', postalCode: '586 01', street: 'Ukázková 12' },
  lines: [{ expectedUnitPriceMinor: 1210, productId: 'p1', quantity: 1 }],
  partyId: 'test-customer-party',
  shippingMethod: 'OSOBNI_ODBER',
} satisfies CommandInput);

it.effect('stores the pickup point of a storefront order under the company brand persistence supplies', () =>
  Effect.gen(function* storesCompanyPickup() {
    const state = yield* sourceCatalogState;
    const branded = yield* evolveMerchandiseState(state, pickupOrder, {
      actor,
      now,
      resourceId: 'inv-1',
      storefrontBrand: 'ŠroubShop',
    });
    expect(branded.state.orders.at(-1)?.shipping?.label).toBe('Osobní odběr – ŠroubShop');

    const unbranded = yield* evolveMerchandiseState(state, pickupOrder, { actor, now, resourceId: 'inv-2' });
    expect(unbranded.state.orders.at(-1)?.shipping?.label).toBe('Osobní odběr');
  }),
);
