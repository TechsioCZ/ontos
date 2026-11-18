// @rstest-environment happy-dom
// The real order form, router, i18n, pickers and generated clients. The owner answers its HTTP contracts in process;
// a deferred full product response keeps the loading state observable independently of the search response.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, settle, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { CZ_VAT_REDUCED, CZ_VAT_STANDARD, TaxRateViewSchema } from '@app/shared-contracts/cz-vat-classifications';
import {
  browserNetwork,
  networkIdle,
  networkQuietExcept,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Layer, Option, Predicate, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { manageCatalogActionSchemaErrorLive } from '../../api/manage-catalog-action-problems.ts';
import csResource from '../../locales/cs/merchandise.json';
import enResource from '../../locales/en/merchandise.json';
import type { ManageCatalogPayloadSchema } from '../../shared/actions/manage-catalog.ts';
import { ManageCatalogActionApi } from '../../shared/apis/manage-catalog-action.ts';
import { ProductRecordSchema, RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { ProductRecord, RecordsResponse } from '../../shared/apis/records.ts';
import type { CustomerDirectory } from '../../src/routes/[lang]/prodej/objednavky/customers-directory.ts';
import { OrderCreateDialog } from '../../src/routes/[lang]/prodej/objednavky/order-create-dialog.tsx';
import type { CompanyVat } from '../../src/routes/[lang]/provoz/produkty/product-tax-classification.ts';
import { mountInRoute } from '../support/module-ui.ts';

const resources = { cs: { merchandise: csResource }, en: { merchandise: enResource } };
const labels = saveLabelsFor('cs');
const at = '2026-10-19T08:00:00.000Z';

const decodeProduct = Schema.decodeUnknownSync(ProductRecordSchema);
const productInput = {
  active: true,
  category: 'Šrouby',
  createdAt: at,
  currentPriceMinor: 800,
  id: 'product-1',
  lowStock: false,
  lowStockThreshold: 5,
  name: 'Nerezový šroub',
  priceHistory: [],
  sku: 'DIN933',
  stockOnHand: 40,
  stockValueMinor: 32_000,
  unit: 'ks',
  updatedAt: at,
};
const product: ProductRecord = decodeProduct({ ...productInput, taxClassificationCode: CZ_VAT_STANDARD });
const reducedProduct: ProductRecord = decodeProduct({ ...productInput, taxClassificationCode: CZ_VAT_REDUCED });

const rate = Schema.decodeSync(TaxRateViewSchema);
const standardRate = rate({ code: CZ_VAT_STANDARD, effectiveFrom: '2020-01-01T00:00:00Z', ratePercent: 21 });
const reducedRate = rate({ code: CZ_VAT_REDUCED, effectiveFrom: '2020-01-01T00:00:00Z', ratePercent: 12 });
/** The company's VAT the page passes in (a payer with both rates); a test replaces it. */
const payer: CompanyVat = { rates: [standardRate, reducedRate], regime: 'VAT_PAYER' };
let vat: CompanyVat = payer;

const customers: CustomerDirectory = {
  active: [{ companyId: '12345678', name: 'Kavárna Dolce', partyId: 'party-1', status: 'ACTIVE' }],
  entries: [{ companyId: '12345678', name: 'Kavárna Dolce', partyId: 'party-1', status: 'ACTIVE' }],
  nameOf: () => 'Kavárna Dolce',
  reload: constVoid,
  status: 'ready',
};

const baseRecords = Schema.decodeUnknownSync(RecordsResponseSchema)({
  actorPrincipalRef: {
    principalId: '20000000-0000-4000-8000-000000000002',
    tenantId: '20000000-0000-4000-8000-000000000001',
  },
  canWrite: true,
  indicators: { lowStockCount: 0, openOrderValueMinor: 0, orderCount: 0, productCount: 1, stockValueMinor: 32_000 },
  movements: [],
  orders: [],
  products: [],
  revision: 4,
});
const recordsFor = (picked: ProductRecord): RecordsResponse => ({ ...baseRecords, products: [picked] });
const commands: (typeof ManageCatalogPayloadSchema.Encoded)['command'][] = [];
const productReads: string[] = [];
const created: string[] = [];
let offered: ProductRecord = product;
let recordAnswer: Effect.Effect<RecordsResponse> = Effect.succeed(recordsFor(product));
const sent = () => commands;
const OwnerRecordsApi = RecordsApi.prefix('/merchandise-api');
const OwnerActionApi = ManageCatalogActionApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          if (payload.view?.productIds !== undefined) {
            productReads.push(...payload.view.productIds);
            return recordAnswer;
          }
          return Effect.succeed(recordsFor(offered));
        }),
      ),
    ),
  ),
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'manageCatalogAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          commands.push(payload.command);
          return { entityIds: [], revision: 5 };
        }),
      ),
    ).pipe(Layer.provide(manageCatalogActionSchemaErrorLive)),
  ),
);

const mount = () =>
  Effect.gen(function* mountDialog() {
    yield* pinTestDocument;
    yield* mountInRoute(
      <OrderCreateDialog
        customers={customers}
        onCreated={() => {
          created.push('created');
        }}
        onOpenChange={constVoid}
        open
        revision={4}
        vat={vat}
      />,
      { path: 'prodej/objednavky', resources, url: '/cs/prodej/objednavky' },
    );
  });

const buttonNamed = (name: string): HTMLButtonElement => Option.getOrThrow(Option.fromUndefinedOr(buttons(name)[0]));
const click = (name: string) => acted(() => buttonNamed(name).click());

const optionNamed = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((candidate) =>
    candidate.textContent?.includes(name),
  );

/** Opens the real listbox and selects its visible option. The product list is loaded by its real search client. */
const pick = (index: number, name: string) =>
  Effect.gen(function* pickOption() {
    const input = Option.getOrThrow(
      Option.fromUndefinedOr([...document.querySelectorAll<HTMLInputElement>('input[role="combobox"]')][index]),
    );
    yield* acted(() => {
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
    });
    yield* waitUntil(() => optionNamed(name) !== undefined, 2000);
    yield* acted(() => Option.getOrThrow(Option.fromUndefinedOr(optionNamed(name))).click());
  });
const pickCustomer = () => pick(0, 'Kavárna Dolce');
const pickProduct = () => pick(1, `${offered.name} (${offered.sku})`);

beforeEach(() => {
  commands.length = 0;
  productReads.length = 0;
  created.length = 0;
  offered = product;
  recordAnswer = Effect.succeed(recordsFor(product));
  vat = payer;
});
afterEach(unmountAll);

it.live('customer first, then a product whose record loads later: Uložit enables and one click sends one order', () =>
  Effect.gen(function* testDialog() {
    const gate = yield* Deferred.make<RecordsResponse>();
    recordAnswer = Deferred.await(gate);
    yield* mount();
    expect(buttonNamed(labels.save).disabled).toBe(true);

    yield* pickCustomer();
    expect(buttonNamed(labels.save).disabled).toBe(true);
    yield* pickProduct();
    // The product record is still loading: the line cannot be priced yet.
    yield* waitUntil(() => productReads.length === 1);
    yield* networkQuietExcept(1);
    expect(productReads).toEqual(['product-1']);
    expect(buttonNamed(labels.save).disabled).toBe(true);

    yield* Deferred.succeed(gate, recordsFor(product));
    yield* waitUntil(() => !buttonNamed(labels.save).disabled);
    yield* settle;
    expect(buttonNamed(labels.save).disabled).toBe(false);

    yield* click(labels.save);
    yield* waitUntil(() => created.length === 1);
    yield* networkIdle;
    expect(sent()).toHaveLength(1);
    expect(Predicate.isTagged(sent()[0], 'CreateOrder')).toBe(true);
    expect(sent()[0]).toMatchObject({
      lines: [{ productId: 'product-1', quantity: 1 }],
      partyId: 'party-1',
    });
  }).pipe(Effect.provide(network)),
);

/** What the dialog shows, with non-breaking spaces (money, percent) read as plain spaces. */
const text = () => (document.body.textContent ?? '').replaceAll('\u00A0', ' ');

/** Picks through both real comboboxes and waits for the full product response to be displayed. */
const fillOneLine = (picked: ProductRecord) =>
  Effect.gen(function* fill() {
    offered = picked;
    recordAnswer = Effect.succeed(recordsFor(picked));
    yield* mount();
    yield* pickCustomer();
    yield* pickProduct();
    yield* waitUntil(() => text().includes('Cena 8 Kč, skladem 40 ks'));
  });

it.live("the line shows its product's classification with today's rate, and the totals use it", () =>
  Effect.gen(function* testDialog() {
    yield* fillOneLine(reducedProduct);
    expect(text()).toContain('Cena 8 Kč, skladem 40 ks, DPH Snížená (12 %)');
    // 8 Kč net, 12 % VAT per line rounded half-up: 0,96 Kč, 8,96 Kč with VAT.
    expect(text()).toContain('0,96 Kč');
    expect(text()).toContain('8,96 Kč');
    yield* waitUntil(() => !buttonNamed(labels.save).disabled);
    expect(buttonNamed(labels.save).disabled).toBe(false);
  }).pipe(Effect.provide(network)),
);

it.live('standard 21 % keeps the arithmetic the order editor has always shown', () =>
  Effect.gen(function* testDialog() {
    yield* fillOneLine(product);
    expect(text()).toContain('DPH Základní (21 %)');
    expect(text()).toContain('1,68 Kč');
    expect(text()).toContain('9,68 Kč');
  }).pipe(Effect.provide(network)),
);

it.live('a product whose classification has no rate in force says so and cannot be ordered', () =>
  Effect.gen(function* testDialog() {
    vat = { ...payer, rates: [standardRate] };
    yield* fillOneLine(reducedProduct);
    expect(text()).toContain('DPH Snížená (není nastaveno)');
    expect(buttonNamed(labels.save).disabled).toBe(true);
    yield* networkIdle;
    expect(sent()).toEqual([]);
  }).pipe(Effect.provide(network)),
);

it.live('a company that is not a VAT payer orders at 0 %: the line says so and the order can be saved', () =>
  Effect.gen(function* testDialog() {
    vat = { rates: [], regime: 'NON_PAYER' };
    yield* fillOneLine(product);
    expect(text()).toContain('DPH Základní (firma není plátce DPH)');
    expect(text()).not.toContain('není nastaveno');
    yield* waitUntil(() => !buttonNamed(labels.save).disabled);
    expect(buttonNamed(labels.save).disabled).toBe(false);
    yield* click(labels.save);
    yield* waitUntil(() => sent().length === 1);
    yield* networkIdle;
    expect(sent()).toEqual([expect.objectContaining({ _tag: 'CreateOrder' })]);
  }).pipe(Effect.provide(network)),
);

it.live('rates the tax module has not confirmed yet are named as such above the lines', () =>
  Effect.gen(function* testDialog() {
    vat = { ...payer, source: 'MIGRATION' };
    yield* mount();
    expect(text()).toContain('Sazby DPH zatím nepotvrdil modul Daně');
  }).pipe(Effect.provide(network)),
);

it.live('two rules in force at once for the classification: the line says why and nothing is sent', () =>
  Effect.gen(function* testDialog() {
    vat = {
      ...payer,
      rates: [
        standardRate,
        rate({ code: CZ_VAT_STANDARD, effectiveFrom: '2024-01-01T00:00:00Z', ratePercent: 20 }),
        reducedRate,
      ],
    };
    yield* fillOneLine(product);
    expect(text()).toContain(
      'Pro sazbu DPH „Základní“ platí v modulu Daně více pravidel zároveň, produkt nelze přidat.',
    );
    expect(buttonNamed(labels.save).disabled).toBe(true);
    yield* networkIdle;
    expect(sent()).toEqual([]);
  }).pipe(Effect.provide(network)),
);
