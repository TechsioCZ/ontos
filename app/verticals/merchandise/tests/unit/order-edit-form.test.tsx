// @rstest-environment happy-dom
// The order edit form through its real i18n, router, product picker and generated HTTP clients.
import { acted, buttons, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
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
import { ManageCatalogResultSchema } from '../../shared/actions/manage-catalog.ts';
import type { ManageCatalogPayloadSchema } from '../../shared/actions/manage-catalog.ts';
import { ManageCatalogActionApi } from '../../shared/apis/manage-catalog-action.ts';
import { OrderSchema, ProductRecordSchema, RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { Order, ProductRecord } from '../../shared/apis/records.ts';
import { OrderEditForm } from '../../src/routes/[lang]/prodej/objednavky/order-edit-form.tsx';
import type { CompanyVat } from '../../src/routes/[lang]/provoz/produkty/product-tax-classification.ts';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const copy = moduleText('cs');
const opened = '2026-10-15T10:00:00.000Z';
const savedHere = '2026-10-15T10:06:00.000Z';

const orderOf = (fields: { readonly note?: string; readonly updatedAt: string }): Order =>
  Schema.decodeSync(OrderSchema)({
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
        taxRuleRevisionId: 'tax-rule-revision-standard-21',
        unitPriceMinor: 100,
        vatRate: 21,
      },
    ],
    note: fields.note ?? '',
    number: 'ORD-1',
    partyId: 'party-1',
    status: 'NEW',
    totalMinor: 200,
    totalVatMinor: 42,
    updatedAt: fields.updatedAt,
  });

const rate = Schema.decodeSync(TaxRateViewSchema);
/** Today Tax gives the standard classification 23 %: the order's own line keeps the 21 % it was snapshotted with. */
const standardRate = rate({ code: CZ_VAT_STANDARD, effectiveFrom: '2020-01-01T00:00:00Z', ratePercent: 23 });
const reducedRate = rate({ code: CZ_VAT_REDUCED, effectiveFrom: '2020-01-01T00:00:00Z', ratePercent: 12 });
/** The company's rates the page passes in; a test replaces them. */
const payer: CompanyVat = { rates: [standardRate, reducedRate], regime: 'VAT_PAYER' };
let vat: CompanyVat = payer;

const beans: ProductRecord = Schema.decodeSync(ProductRecordSchema)({
  active: true,
  category: 'Káva',
  createdAt: opened,
  currentPriceMinor: 800,
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

const offered = { current: beans };

const recordsWith = (order: Order, revision: number) =>
  Schema.decodeSync(RecordsResponseSchema)({
    actorPrincipalRef: {
      principalId: '20000000-0000-4000-8000-000000000002',
      tenantId: '20000000-0000-4000-8000-000000000001',
    },
    canWrite: true,
    indicators: { lowStockCount: 0, openOrderValueMinor: 200, orderCount: 1, productCount: 1, stockValueMinor: 1000 },
    movements: [],
    orders: [Schema.encodeSync(OrderSchema)(order)],
    products: [],
    revision,
  });

const commands: (typeof ManageCatalogPayloadSchema.Encoded)[] = [];
const edits = () => commands.length;
/** The order the form edits; a test replaces it. */
let shownOrder: Order = orderOf({ updatedAt: opened });
/** The lines of the edits the owner received. */
const sentLines = () =>
  commands.flatMap((payload) =>
    Predicate.isTagged(payload.command, 'EditOrder') ? (payload.command.lines ?? []) : [],
  );

const OwnerActionApi = ManageCatalogActionApi.prefix('/merchandise-api');
const OwnerRecordsApi = RecordsApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'manageCatalogAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          commands.push(payload);
          return Schema.decodeSync(ManageCatalogResultSchema)({ entityIds: [], revision: 8 });
        }),
      ),
    ).pipe(Layer.provide(manageCatalogActionSchemaErrorLive)),
  ),
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          const records = recordsWith(orderOf({ note: 'Zavolat předem', updatedAt: savedHere }), 8);
          return payload.view?.ordersLimit === 0 ? { ...records, orders: [], products: [offered.current] } : records;
        }),
      ),
    ),
  ),
);

const mount = Effect.gen(function* mountForm() {
  yield* pinTestDocument;
  const cancelled: string[] = [];
  const saved: string[] = [];
  yield* mountInRoute(
    <OrderEditForm
      movesStock={false}
      onCancel={() => {
        cancelled.push('cancel');
      }}
      onSaved={(message) => {
        saved.push(message);
      }}
      order={shownOrder}
      products={[]}
      revision={7}
      vat={vat}
    />,
    { path: 'prodej/objednavky', url: '/cs/prodej/objednavky' },
  );
  return { cancelled, saved };
});

const button = (name: string): HTMLButtonElement => {
  const [found] = buttons(name);
  expect(found).toBeDefined();
  return found ?? document.createElement('button');
};

const noteField = (): HTMLTextAreaElement => {
  const label = [...document.querySelectorAll('label')].find(
    (entry) => entry.textContent?.trim() === copy('merchandise.ui.orderNote'),
  );
  return Option.getOrThrow(
    Option.fromNullOr(document.querySelector<HTMLTextAreaElement>(`textarea[id="${label?.htmlFor ?? ''}"]`)),
  );
};

/** Types like a user: React sees a native input event. */
const typeNote = (value: string) =>
  acted(() => {
    const field = noteField();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });

const click = (target: HTMLElement) => acted(() => target.click());

/** What the form shows, with non-breaking spaces (money, percent) read as plain spaces. */
const text = () => (document.body.textContent ?? '').replaceAll('\u00A0', ' ');

/** Selects the actual search result, then waits for its full record to reach the form. */
const pickProduct = Effect.gen(function* pickProduct() {
  const input = Option.getOrThrow(
    Option.fromNullOr(document.querySelector<HTMLInputElement>('input[data-scope="combobox"][data-part="input"]')),
  );
  yield* click(input);
  yield* waitUntil(() => document.querySelector('[role="option"][data-scope="combobox"]') !== null);
  const option = Option.getOrThrow(
    Option.fromNullOr(document.querySelector<HTMLElement>('[role="option"][data-scope="combobox"]')),
  );
  yield* click(option);
  yield* waitUntil(() => !button('Přidat').disabled || text().includes('nelze přidat'));
});

beforeEach(() => {
  commands.length = 0;
  offered.current = beans;
  shownOrder = orderOf({ updatedAt: opened });
  vat = payer;
});

afterEach(unmountAll);

it.layer(network, { excludeTestServices: true })('order edit form with one Save button', (suite) => {
  suite.effect('has one Save button, disabled until something changes, and typing sends nothing', () =>
    Effect.gen(function* oneButton() {
      yield* mount;
      expect(buttons('Uložit')).toHaveLength(1);
      expect(button('Uložit').disabled).toBe(true);
      expect(text()).not.toMatch(/automat/iu);

      yield* typeNote('Zavolat předem');
      expect(button('Uložit').disabled).toBe(false);
      expect(text()).toContain('Neuložené změny');
      // Longer than any debounce the form ever had.
      yield* Effect.sleep('1 second');
      yield* networkIdle;
      expect(edits()).toBe(0);
    }),
  );

  suite.effect('one click on Save sends one edit and shows it saved', () =>
    Effect.gen(function* saveOnce() {
      yield* mount;
      yield* typeNote('Zavolat předem');
      yield* click(button('Uložit'));
      yield* waitUntil(() => text().includes('Uloženo'));
      yield* networkIdle;
      expect(edits()).toBe(1);
      expect(button('Uložit').disabled).toBe(true);
    }),
  );

  suite.effect('leaving with unsaved changes asks first; Zůstat keeps the form, Zahodit změny leaves unsaved', () =>
    Effect.gen(function* leave() {
      const view = yield* mount;
      yield* typeNote('Zavolat předem');
      yield* click(button(copy('merchandise.pages.orders.detail.backToDetail')));
      expect(buttons('Zahodit změny')).toHaveLength(1);
      expect(buttons('Zůstat')).toHaveLength(1);
      expect(view.cancelled).toEqual([]);

      yield* click(button('Zůstat'));
      yield* waitUntil(() => buttons('Zůstat').length === 0);
      expect(noteField().value).toBe('Zavolat předem');

      yield* click(button(copy('merchandise.pages.orders.detail.backToDetail')));
      yield* click(button('Zahodit změny'));
      expect(view.cancelled).toEqual(['cancel']);
      yield* networkIdle;
      expect(edits()).toBe(0);
    }),
  );

  suite.effect('Uložit in the question saves once and then leaves', () =>
    Effect.gen(function* saveAndLeave() {
      const view = yield* mount;
      yield* typeNote('Zavolat předem');
      yield* click(button(copy('merchandise.pages.orders.detail.backToDetail')));
      // The question's own Save button is the last one: the dialog renders after the form.
      const inDialog = buttons('Uložit').at(-1);
      expect(inDialog).toBeDefined();
      yield* click(inDialog ?? document.createElement('button'));
      yield* waitUntil(() => view.saved.length === 1);
      yield* networkIdle;
      expect(view.saved).toHaveLength(1);
      expect(edits()).toBe(1);
    }),
  );

  suite.effect('an unchanged form leaves without asking', () =>
    Effect.gen(function* cleanLeave() {
      const view = yield* mount;
      yield* click(button(copy('merchandise.pages.orders.detail.backToDetail')));
      expect(buttons('Zůstat')).toHaveLength(0);
      expect(view.cancelled).toEqual(['cancel']);
    }),
  );
});

it.layer(network, { excludeTestServices: true })('VAT of the order lines', (suite) => {
  suite.effect("an order's own line shows the VAT it was snapshotted with, named by its classification", () =>
    Effect.gen(function* snapshot() {
      yield* mount;
      expect(text()).toContain(`${copy('merchandise.pages.orders.detail.lineVat')} Základní (21 %)`);
      expect(text()).not.toContain('23 %');
      // 2 × 1 Kč net + 21 % VAT, as the order already counted it.
      expect(text()).toContain('2,42 Kč');
    }),
  );

  suite.effect("an added product takes its classification from the product and today's rate from Tax", () =>
    Effect.gen(function* added() {
      yield* mount;
      yield* pickProduct;
      yield* click(button('Přidat'));
      expect(text()).toContain(`${copy('merchandise.pages.orders.detail.lineVat')} Snížená (12 %)`);
      // 2,42 Kč for the order's line, plus 8 Kč net and 0,96 Kč VAT for the new one.
      expect(text()).toContain('11,38 Kč');
      yield* networkIdle;
      expect(edits()).toBe(0);
    }),
  );

  suite.effect('a product whose classification has no rate in force cannot be added, and the form says why', () =>
    Effect.gen(function* missing() {
      vat = { ...payer, rates: [standardRate] };
      yield* mount;
      yield* pickProduct;
      expect(text()).toContain('Sazba DPH „Snížená“ není pro tuto firmu nastavená, produkt nelze přidat.');
      expect(button('Přidat').disabled).toBe(true);
    }),
  );

  suite.effect('a product without a VAT classification cannot be added, and the form says why', () =>
    Effect.gen(function* unclassified() {
      const { taxClassificationCode: _code, ...withoutClassification } = beans;
      void _code;
      offered.current = withoutClassification;
      yield* mount;
      yield* pickProduct;
      expect(text()).toContain('Produkt nemá zařazení do sazby DPH, proto ho nelze přidat.');
      yield* networkIdle;
      expect(text()).not.toContain('„není nastaveno“');
      expect(button('Přidat').disabled).toBe(true);
    }),
  );

  suite.effect('a company that is not a VAT payer adds a product at 0 % and the line says so', () =>
    Effect.gen(function* nonPayer() {
      vat = { rates: [], regime: 'NON_PAYER' };
      yield* mount;
      yield* pickProduct;
      expect(button('Přidat').disabled).toBe(false);
      yield* click(button('Přidat'));
      expect(text()).toContain(`${copy('merchandise.pages.orders.detail.lineVat')} Snížená (0 %)`);
      // 2,42 Kč for the order's line, plus 8 Kč net and no VAT for the new one.
      expect(text()).toContain('10,42 Kč');
      yield* networkIdle;
      expect(text()).not.toContain('není nastaveno');
    }),
  );
});

it.layer(network, { excludeTestServices: true })('a line added to a storefront order (prices include VAT)', (suite) => {
  suite.effect('takes the stored price including VAT and sends it as the offered price unless staff change it', () =>
    Effect.gen(function* storedGross() {
      shownOrder = { ...orderOf({ updatedAt: opened }), pricesIncludeVat: true };
      // Stored gross 10 Kč, not 8 Kč net plus 12 % (8,96 Kč).
      offered.current = { ...beans, grossPriceMinor: 1000 };
      yield* mount;
      yield* pickProduct;
      yield* click(button('Přidat'));
      yield* networkIdle;
      expect(text()).not.toContain('8,96 Kč');
      expect(text()).toContain('10 Kč');
      yield* click(button('Uložit'));
      yield* waitUntil(() => commands.length === 1);
      yield* networkIdle;
      expect(commands).toHaveLength(1);
      // The offered price travels with the line: the server stores that price or refuses when it changed meanwhile.
      expect(sentLines().find((line) => line.productId === beans.id)).toEqual({
        offeredUnitPriceMinor: 1000,
        productId: beans.id,
        quantity: 1,
      });
    }),
  );
});
