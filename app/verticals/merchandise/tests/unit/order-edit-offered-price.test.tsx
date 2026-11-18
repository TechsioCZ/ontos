// @rstest-environment happy-dom
// A line added in the order editor whose product changed price before the edit was saved, as staff live through it:
// the server refuses the save with "the offered price changed", the form reads the product again, puts the current
// price on the line, says so with the new price, and the next Uložit sends that price and succeeds. When the form cannot
// read a new price (the product reads at the price the line carries, or cannot be read at all), it names the line and
// asks staff to remove and add it again until a save succeeds. Picking the same product again refreshes an added
// line's price too. The form uses its real picker, i18n, router and clients, with in-process owner HTTP endpoints.
import { acted, buttons, settle, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { CZ_VAT_REDUCED, CZ_VAT_STANDARD, TaxRateViewSchema } from '@app/shared-contracts/cz-vat-classifications';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Option, Predicate, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { manageCatalogActionSchemaErrorLive } from '../../api/manage-catalog-action-problems.ts';
import {
  ManageCatalogActionApi,
  ManageCatalogActionConflictProblemSchema,
} from '../../shared/apis/manage-catalog-action.ts';
import type { ManageCatalogPayloadSchema } from '../../shared/apis/manage-catalog-action.ts';
import { ManageCatalogResultSchema } from '../../shared/actions/manage-catalog.ts';
import { OrderMarketSchema, convertGrossMinor } from '../../shared/domain/market-offers.ts';
import { OrderSchema, ProductRecordSchema, RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { Order, ProductRecord } from '../../shared/apis/records.ts';
import { OrderEditForm } from '../../src/routes/[lang]/prodej/objednavky/order-edit-form.tsx';
import type { CompanyVat } from '../../src/routes/[lang]/provoz/produkty/product-tax-classification.ts';
import { mountInRoute } from '../support/module-ui.ts';

/** The catalog record returned by the real search and product reads. */
let currentProduct: ProductRecord | null = null;
const commands: (typeof ManageCatalogPayloadSchema.Encoded)[] = [];
let refusalsRemaining = 0;

const opened = '2026-10-15T10:00:00.000Z';

/** A storefront order (prices include VAT) with one cable line. */
const order: Order = Schema.decodeSync(OrderSchema)({
  contact: { email: 'ada@example.test', name: 'Ada Guest' },
  createdAt: opened,
  deliveryAddress: { city: 'Brno', country: 'CZ', postalCode: '60200', street: 'Kavárna 1' },
  demo: true,
  id: 'order-1',
  lines: [
    {
      productId: 'product-1',
      productName: 'Cable',
      quantity: 2,
      sku: 'CABLE',
      taxClassificationCode: CZ_VAT_STANDARD,
      unitPriceMinor: 100,
      vatRate: 21,
    },
  ],
  note: '',
  number: 'ORD-1',
  partyId: 'party-1',
  pricesIncludeVat: true,
  status: 'NEW',
  totalMinor: 200,
  totalVatMinor: 35,
  updatedAt: opened,
});

const rate = Schema.decodeSync(TaxRateViewSchema);
const vat: CompanyVat = {
  rates: [
    rate({ code: CZ_VAT_STANDARD, effectiveFrom: '2020-01-01T00:00:00Z', ratePercent: 21 }),
    rate({ code: CZ_VAT_REDUCED, effectiveFrom: '2020-01-01T00:00:00Z', ratePercent: 12 }),
  ],
  regime: 'VAT_PAYER',
};

/** Coffee beans stored at the given price including VAT. */
const beansAt = (grossPriceMinor: number): ProductRecord =>
  Schema.decodeSync(ProductRecordSchema)({
    active: true,
    category: 'Káva',
    createdAt: opened,
    currentPriceMinor: 800,
    grossPriceMinor,
    id: 'product-2',
    lowStock: false,
    lowStockThreshold: 0,
    name: 'Zrnková káva',
    priceHistory: [],
    sku: 'BEANS',
    stockOnHand: 50,
    stockValueMinor: 40_000,
    taxClassificationCode: CZ_VAT_REDUCED,
    unit: 'ks',
    updatedAt: opened,
  });

const priceChanged = ManageCatalogActionConflictProblemSchema.make({
  code: 'merchandise_offered_price_changed',
  detail: 'The Action conflicts with current state.',
  status: 409,
  title: 'Action conflict',
  type: 'https://ontos.dev/problems/action-conflict',
});

const saved = Schema.decodeUnknownSync(ManageCatalogResultSchema)({ entityIds: [], revision: 8 });
const OwnerActionApi = ManageCatalogActionApi.prefix('/merchandise-api');
const OwnerRecordsApi = RecordsApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'manageCatalogAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          commands.push(payload);
          if (refusalsRemaining > 0) {
            refusalsRemaining -= 1;
            return Effect.fail(priceChanged);
          }
          return Effect.succeed(saved);
        }),
      ),
    ).pipe(Layer.provide(manageCatalogActionSchemaErrorLive)),
  ),
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() =>
          Schema.decodeUnknownSync(RecordsResponseSchema)({
            actorPrincipalRef: {
              principalId: '20000000-0000-4000-8000-000000000002',
              tenantId: '20000000-0000-4000-8000-000000000001',
            },
            canWrite: true,
            indicators: {
              lowStockCount: 0,
              openOrderValueMinor: 0,
              orderCount: 1,
              productCount: 1,
              stockValueMinor: 0,
            },
            movements: [],
            orders: [Schema.encodeSync(OrderSchema)(order)],
            products:
              currentProduct === null || payload.view?.limit === 0
                ? []
                : [Schema.encodeSync(ProductRecordSchema)(currentProduct)],
            revision: 8,
          }),
        ),
      ),
    ),
  ),
);

const mount = (shown: Order = order) =>
  Effect.gen(function* mountOrder() {
    yield* pinTestDocument;
    yield* mountInRoute(
      <OrderEditForm
        movesStock={false}
        onCancel={() => {}}
        onSaved={() => {}}
        order={shown}
        products={[]}
        revision={7}
        vat={vat}
      />,
      { url: '/cs/prodej/objednavky' },
    );
  });
const button = (name: string): HTMLButtonElement => Option.getOrThrow(Option.fromUndefinedOr(buttons(name)[0]));
const click = (target: HTMLElement) => acted(() => target.click());
const beansOption = () =>
  [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) =>
    entry.textContent?.includes('Zrnková káva'),
  );
const pickProduct = Effect.gen(function* pickBeans() {
  const input = Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>('[role="combobox"]')));
  yield* acted(() => input.click());
  yield* waitUntil(() => beansOption() !== undefined);
  const option = Option.getOrThrow(Option.fromUndefinedOr(beansOption()));
  yield* click(option);
  yield* waitUntil(() => !button('Přidat').disabled);
});
const text = () => (document.body.textContent ?? '').replaceAll(' ', ' ');
const addedPrice = () =>
  document.querySelector<HTMLInputElement>('input[name^="price-new-"]')?.value.replaceAll(' ', ' ');
const sentBeans = () =>
  commands.flatMap((payload) =>
    Predicate.isTagged(payload.command, 'EditOrder')
      ? (payload.command.lines ?? []).filter((line) => line.productId === 'product-2')
      : [],
  );

beforeEach(() => {
  currentProduct = beansAt(1000);
  commands.length = 0;
  refusalsRemaining = 0;
});

afterEach(unmountAll);

it.live('a price changed before saving is refused, taken onto the line with a notice, and the next save succeeds', () =>
  Effect.gen(function* offeredPriceCase() {
    yield* mount();
    yield* pickProduct;
    yield* click(button('Přidat'));
    expect(addedPrice()).toContain('10');
    // The beans now sell at 12 Kč: the server refuses the 10 Kč offer.
    currentProduct = beansAt(1200);
    refusalsRemaining = 1;
    yield* click(button('Uložit'));
    yield* waitUntil(() => text().includes('Cena přidaného zboží se mezitím změnila'));
    expect(text()).toContain('Zrnková káva: 12 Kč');
    expect(addedPrice()).toContain('12');
    // Uložit again sends the current price and is not refused.
    yield* click(button('Uložit'));
    yield* waitUntil(() => sentBeans().length === 2);
    yield* networkIdle;
    expect(sentBeans().map((line) => line.offeredUnitPriceMinor)).toEqual([1000, 1200]);
    yield* waitUntil(() => !text().includes('Cena přidaného zboží se mezitím změnila'));
  }).pipe(Effect.provide(network)),
);

it.live('picking a product already added again takes its current price onto that line', () =>
  Effect.gen(function* offeredPriceCase() {
    yield* mount();
    yield* pickProduct;
    yield* click(button('Přidat'));
    currentProduct = beansAt(1200);
    yield* pickProduct;
    yield* click(button('Přidat'));
    expect(addedPrice()).toContain('12');
    yield* click(button('Uložit'));
    yield* waitUntil(() => sentBeans().length === 1);
    yield* networkIdle;
    expect(sentBeans()).toEqual([{ offeredUnitPriceMinor: 1200, productId: 'product-2', quantity: 2 }]);
  }).pipe(Effect.provide(network)),
);

it.live('a market order offers an added line in its own currency, as the server prices it', () =>
  Effect.gen(function* offeredPriceCase() {
    const market = Schema.decodeSync(OrderMarketSchema)({
      currency: 'EUR',
      exchangeRate: '0.04',
      marketCode: 'TEST-SK',
      marketId: '30000000-0000-4000-8000-000000000001',
      roundingMinor: 10,
    });
    yield* mount({ ...order, market });
    yield* pickProduct;
    yield* click(button('Přidat'));
    yield* click(button('Uložit'));
    yield* waitUntil(() => sentBeans().length === 1);
    // 10 Kč with VAT at 0.04 EUR per Kč, rounded to 0.10 EUR: 0.40 EUR, never the CZK amount.
    yield* networkIdle;
    expect(sentBeans()).toEqual([
      { offeredUnitPriceMinor: convertGrossMinor(1000, market), productId: 'product-2', quantity: 1 },
    ]);
    expect(convertGrossMinor(1000, market)).toBe(40);
  }).pipe(Effect.provide(network)),
);

const unreadable = 'novou cenu se nepodařilo načíst';

it.live(
  'a refused price the form reads back unchanged names the line and asks to add it again until a save succeeds',
  () =>
    Effect.gen(function* offeredPriceCase() {
      yield* mount();
      yield* pickProduct;
      yield* click(button('Přidat'));
      // The server refuses the 10 Kč offer, yet the product still reads at 10 Kč (e.g. priced without a stored gross
      // at a rate the server no longer uses): nothing new to take, and saving again is refused the same way.
      refusalsRemaining = 2;
      yield* click(button('Uložit'));
      yield* waitUntil(() => text().includes(unreadable));
      expect(text()).toContain('Řádek odeberte a přidejte znovu. Týká se: Zrnková káva.');
      expect(text()).not.toContain('Řádky teď nesou aktuální cenu');
      yield* click(button('Uložit'));
      yield* waitUntil(() => sentBeans().length === 2);
      yield* networkIdle;
      yield* settle;
      expect(text()).toContain(unreadable);
      // A save that succeeds ends it.
      yield* click(button('Uložit'));
      yield* waitUntil(() => sentBeans().length === 3);
      yield* waitUntil(() => !text().includes(unreadable));
    }).pipe(Effect.provide(network)),
);

it.live('a refused price whose product can no longer be read names that line', () =>
  Effect.gen(function* offeredPriceCase() {
    yield* mount();
    yield* pickProduct;
    yield* click(button('Přidat'));
    // The beans were deleted meanwhile: the form cannot read their new price.
    currentProduct = null;
    refusalsRemaining = 1;
    yield* click(button('Uložit'));
    yield* waitUntil(() => text().includes(unreadable));
    expect(text()).toContain('Týká se: Zrnková káva.');
    expect(addedPrice()).toContain('10');
    yield* click(button('Uložit'));
    yield* waitUntil(() => sentBeans().length === 2);
    yield* waitUntil(() => !text().includes(unreadable));
  }).pipe(Effect.provide(network)),
);
