import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { MerchandiseCommandSchema } from '../../shared/actions/apply-command.ts';
import { MerchandiseStateSchema } from '../../shared/apis/records.ts';
import { OrderSchema } from '../../shared/domain/merchandise-model.ts';
import { decodeOrderDocument, orderRowOf } from '../../src/services/merchandise-store.ts';
import { evolveMerchandiseState } from '../../src/services/persistence.service.ts';

const at = '2026-10-19T08:00:00.000Z';
const actor = { principalId: '20000000-0000-4000-8000-000000000002', tenantId: '20000000-0000-4000-8000-000000000001' };
const state = Schema.decodeUnknownSync(MerchandiseStateSchema)({
  movements: [{ at, delta: 5, id: 'receipt', productId: 'product-1', reason: 'RECEIPT' }],
  orders: [],
  products: [
    {
      active: true,
      category: 'Šrouby',
      createdAt: at,
      currentPriceMinor: 100,
      id: 'product-1',
      lowStockThreshold: 0,
      name: 'Šroub',
      priceHistory: [],
      sku: 'SKU-1',
      unit: 'ks',
      updatedAt: at,
      vatRate: 21,
    },
  ],
});
const recipient = { firstName: 'Jana', lastName: 'Nováková', phone: '+420777987654' };
const contact = { email: 'petr@example.invalid', name: 'Petr Novák', phone: '+420777123456' };
const command = {
  _tag: 'PlaceStorefrontOrder',
  billingAddress: { city: 'Brno', country: 'CZ', postalCode: '60200', street: 'Fakturační 1' },
  clientRequestId: 'recipient-order-1',
  contact,
  deliveryAddress: { city: 'Praha', country: 'CZ', postalCode: '11000', street: 'Dodací 2' },
  deliveryRecipient: recipient,
  lines: [{ expectedUnitPriceMinor: 121, productId: 'product-1', quantity: 1 }],
  partyId: 'customer-party',
  shippingMethod: 'OSOBNI_ODBER',
};
const input = { actor, now: DateTime.makeUnsafe(at), resourceId: 'order-1' };

it.effect('preserves a separate recipient through native command decoding, placement and stored order encoding', () =>
  Effect.gen(function* preservesStorefrontRecipient() {
    const placed = yield* evolveMerchandiseState(
      state,
      Schema.decodeUnknownSync(MerchandiseCommandSchema)(command),
      input,
    );
    expect(placed.storefrontOrder?.outcome).toBe('PLACED');
    const order = Schema.decodeUnknownSync(Schema.toType(OrderSchema))(placed.state.orders[0]);
    const expected = {
      billingAddress: command.billingAddress,
      contact,
      deliveryAddress: command.deliveryAddress,
      deliveryRecipient: recipient,
    };
    expect(order).toMatchObject(expected);
    const row = orderRowOf({ legalEntityId: 'company-1', tenantId: actor.tenantId }, order);
    expect(row.document).toMatchObject(expected);
    expect(decodeOrderDocument(row.document)).toMatchObject(expected);

    const replayed = yield* evolveMerchandiseState(
      placed.state,
      Schema.decodeUnknownSync(MerchandiseCommandSchema)({
        ...command,
        billingAddress: { ...command.billingAddress, street: 'Changed billing' },
        deliveryRecipient: { ...recipient, firstName: 'Changed' },
      }),
      input,
    );
    expect(replayed.storefrontOrder?.outcome).toBe('REPLAYED');
    expect(replayed.state.orders[0]?.deliveryRecipient).toEqual(recipient);
    expect(replayed.state.orders[0]?.billingAddress).toEqual(command.billingAddress);

    const edited = yield* evolveMerchandiseState(
      placed.state,
      Schema.decodeUnknownSync(MerchandiseCommandSchema)({
        _tag: 'EditOrder',
        deliveryAddress: { city: 'Praha', country: 'CZ', postalCode: '11000', street: 'Dodací 3' },
        id: order.id,
      }),
      input,
    );
    expect(edited.state.orders[0]?.deliveryRecipient).toEqual(recipient);
    expect(edited.state.orders[0]?.billingAddress).toEqual(command.billingAddress);
  }),
);

it('rejects incomplete or malformed billing addresses in the native command contract', () => {
  for (const invalid of [
    { ...command.billingAddress, city: '' },
    { ...command.billingAddress, postalCode: '1' },
    { ...command.billingAddress, street: '' },
    { city: 'Brno', postalCode: '60200' },
  ]) {
    expect(() => Schema.decodeUnknownSync(MerchandiseCommandSchema)({ ...command, billingAddress: invalid })).toThrow();
  }
});

it('rejects incomplete or malformed recipient data in the native command contract', () => {
  for (const invalid of [
    { firstName: '', lastName: recipient.lastName, phone: recipient.phone },
    { firstName: recipient.firstName, lastName: '', phone: recipient.phone },
    { firstName: recipient.firstName, lastName: recipient.lastName },
    { ...recipient, phone: '' },
    { ...recipient, phone: 777_987_654 },
  ]) {
    expect(() =>
      Schema.decodeUnknownSync(MerchandiseCommandSchema)({ ...command, deliveryRecipient: invalid }),
    ).toThrow();
  }
});
