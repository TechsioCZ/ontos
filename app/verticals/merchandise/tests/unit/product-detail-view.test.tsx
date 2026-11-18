// @rstest-environment happy-dom
// The product editor as the user sees it: one Save button under the detail form, the draft's status next to it, a
// question before unsaved changes are left, and nothing sent unless Save is clicked. The real clients, i18n and
// router run against the owner HTTP contracts in process.
import { CZ_VAT_REDUCED, CZ_VAT_STANDARD, TaxRateViewSchema } from '@app/shared-contracts/cz-vat-classifications';
import type { TaxRateView } from '@app/shared-contracts/cz-vat-classifications';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { settle as uiSettle, waitUntil as uiWaitUntil, unmountAll } from '@app/admin-ui/testing/module-ui';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Option, Predicate, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { act } from 'react';
import { ProductRecordSchema, ProductSchema } from '../../shared/domain/merchandise-model.ts';
import { stockLevelsOf, toProductRecord } from '../../src/services/stock-levels.ts';
import { manageCatalogActionSchemaErrorLive } from '../../api/manage-catalog-action-problems.ts';
import { recordStockMovementActionSchemaErrorLive } from '../../api/record-stock-movement-action-problems.ts';
import { ManageCatalogActionApi } from '../../shared/apis/manage-catalog-action.ts';
import { RecordStockMovementActionApi } from '../../shared/apis/record-stock-movement-action.ts';
import { ManageCatalogResultSchema } from '../../shared/actions/manage-catalog.ts';
import type { ManageCatalogPayloadSchema } from '../../shared/actions/manage-catalog.ts';
import type { RecordStockMovementPayloadSchema } from '../../shared/actions/record-stock-movement.ts';
import { mountInRoute } from '../support/module-ui.ts';
import { ProductDetailView } from '../../src/routes/[lang]/provoz/produkty/product-detail-dialog.tsx';
import type { CompanyVat } from '../../src/routes/[lang]/provoz/produkty/product-tax-classification.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

const catalogRequests: (typeof ManageCatalogPayloadSchema.Encoded)[] = [];
const movementRequests: (typeof RecordStockMovementPayloadSchema.Encoded)[] = [];
const saved = Schema.decodeSync(ManageCatalogResultSchema)({ entityIds: [], revision: 2 });
const CatalogApi = ManageCatalogActionApi.prefix('/merchandise-api');
const MovementApi = RecordStockMovementActionApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    CatalogApi,
    HttpApiBuilder.group(CatalogApi, 'manageCatalogAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          catalogRequests.push(payload);
          return saved;
        }),
      ),
    ).pipe(Layer.provide(manageCatalogActionSchemaErrorLive)),
  ),
  serveApi(
    MovementApi,
    HttpApiBuilder.group(MovementApi, 'recordStockMovementAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          movementRequests.push(payload);
          return saved;
        }),
      ),
    ).pipe(Layer.provide(recordStockMovementActionSchemaErrorLive)),
  ),
);

const productInput: typeof ProductRecordSchema.Encoded = {
  active: true,
  category: 'Zrnková káva',
  createdAt: '2026-10-20T09:00:00.000Z',
  currentPriceMinor: 25_804,
  description: 'Etiopie, 250 g.',
  // The stored gross as staff records carry it (entered with the price; 289 Kč at 12 %).
  grossPriceMinor: 28_900,
  id: 'product-1',
  lowStock: false,
  lowStockThreshold: 3,
  name: 'Etiopie',
  priceHistory: [],
  shortDescription: 'Svěží káva',
  sku: 'ETI-250',
  stockOnHand: 12,
  stockValueMinor: 309_648,
  taxClassificationCode: CZ_VAT_REDUCED,
  unit: 'ks',
  updatedAt: '2026-10-20T09:00:00.000Z',
  variants: [],
};
const product = Schema.decodeSync(ProductRecordSchema)(productInput);

const rate = Schema.decodeSync(TaxRateViewSchema);
/** The company's rates: 21\u00A0% and 12\u00A0% in force, and 23\u00A0% scheduled for the standard classification. */
const companyRates: readonly TaxRateView[] = [
  rate({
    code: CZ_VAT_STANDARD,
    effectiveFrom: '2020-01-01T00:00:00Z',
    effectiveTo: '2099-01-01T00:00:00Z',
    ratePercent: 21,
  }),
  rate({ code: CZ_VAT_STANDARD, effectiveFrom: '2099-01-01T00:00:00Z', ratePercent: 23 }),
  rate({ code: CZ_VAT_REDUCED, effectiveFrom: '2020-01-01T00:00:00Z', ratePercent: 12 }),
];
/** The rates the page passes in; a test replaces them. */
let vat: CompanyVat = { rates: companyRates, regime: 'VAT_PAYER' };

/** The product the page passes in; a test replaces it to deliver a reloaded record. */
let shown = product;
/** The editor tab the test shows. */
let shownTab: 'detail' | 'variants' = 'detail';

/** The record as a reload delivers it after someone saved it: a newer `updatedAt` and the given changes. */
const reloaded = (changes: Partial<typeof ProductRecordSchema.Encoded>) =>
  Schema.decodeSync(ProductRecordSchema)({ ...productInput, ...changes, updatedAt: '2026-10-21T09:00:00.000Z' });

const commands = () => catalogRequests.map(({ command }) => command._tag);
const settle = () => browserRuntime.runPromise(uiSettle);

const element = () => (
  <ProductDetailView
    canWrite
    movements={[]}
    onBack={constVoid}
    onCommitted={constVoid}
    onReload={constVoid}
    onTabChange={constVoid}
    product={shown}
    revision={1}
    tab={shownTab}
    vat={vat}
  />
);

const buttons = (name: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.trim() === name);

const mount = async () => {
  await browserRuntime.runPromise(pinTestDocument);
  const view = await browserRuntime.runPromise(mountInRoute(element(), { url: '/cs/test' }));
  return {
    attemptLeave: Effect.promise(async () => {
      await act(async () => {
        void view.router.navigate({ to: '/cs/away' });
        await Promise.resolve();
      });
    }).pipe(Effect.andThen(uiWaitUntil(() => buttons('Zůstat').length > 0))),
    rerender: () => browserRuntime.runPromise(view.rerender(element())),
    router: view.router,
    unmount: unmountAll,
  };
};

const button = (name: string): HTMLButtonElement => {
  const [found] = buttons(name);
  expect(found).toBeDefined();
  return found ?? document.createElement('button');
};

const nameField = (): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>('input[id="detail-name"]')));

const fieldById = (id: string): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`input[id="${id}"]`)));

/** Types like a user, then leaves the field: React sees native input and blur events. */
const typeInto = async (id: string, value: string) => {
  await act(async () => {
    const field = fieldById(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await settle();
  });
};

const typeName = (value: string) => typeInto('detail-name', value);

const click = async (target: HTMLElement) => {
  await act(async () => {
    target.click();
    await settle();
  });
};

const waitUntil = (condition: () => boolean) => browserRuntime.runPromise(uiWaitUntil(condition));

const text = () => document.body.textContent ?? '';

beforeEach(() => {
  catalogRequests.length = 0;
  movementRequests.length = 0;
  shown = product;
  shownTab = 'detail';
  vat = { rates: companyRates, regime: 'VAT_PAYER' };
});

afterEach(unmountAll);

it.layer(network, { excludeTestServices: true })('product editor with one Save button', (suite) => {
  suite.effect('typing and leaving a field send nothing, not after a delay and not on unmount', () =>
    Effect.gen(function* noAutomaticSave() {
      const view = yield* Effect.promise(mount);
      expect(buttons('Uložit')).toHaveLength(1);
      expect(button('Uložit').disabled).toBe(true);

      yield* Effect.promise(() => typeName('Etiopie B'));
      expect(button('Uložit').disabled).toBe(false);
      expect(text()).toContain('Neuložené změny');
      expect(text()).not.toMatch(/automat/iu);
      // Longer than any debounce the form ever had.
      yield* Effect.sleep('1 second');
      yield* Effect.promise(() => act(settle));
      yield* networkIdle;
      expect(commands()).toEqual([]);
      view.unmount();
      // A save the unmount wrongly started goes through the gateway and then the Action; it has arrived by now.
      yield* networkIdle;
      expect(commands()).toEqual([]);
    }),
  );

  suite.effect('an empty name holds the Save button back', () =>
    Effect.gen(function* invalid() {
      yield* Effect.promise(mount);
      yield* Effect.promise(() => typeName(''));
      expect(button('Uložit').disabled).toBe(true);
      yield* networkIdle;
      expect(commands()).toEqual([]);
    }),
  );

  suite.effect('a blocked navigation asks; Zahodit změny lets it go without saving', () =>
    Effect.gen(function* blockedNavigation() {
      const view = yield* Effect.promise(mount);
      yield* Effect.promise(() => typeName('Etiopie B'));
      yield* view.attemptLeave;
      expect(buttons('Zůstat')).toHaveLength(1);

      yield* Effect.promise(() => click(button('Zahodit změny')));
      expect(view.router.state.location.pathname).toBe('/cs/away');
      expect(nameField().value).toBe('Etiopie');
      yield* networkIdle;
      expect(commands()).toEqual([]);
    }),
  );

  suite.effect('Zůstat keeps the draft and cancels the navigation', () =>
    Effect.gen(function* stay() {
      const view = yield* Effect.promise(mount);
      yield* Effect.promise(() => typeName('Etiopie B'));
      yield* view.attemptLeave;
      yield* Effect.promise(() => click(button('Zůstat')));
      expect(buttons('Zůstat')).toHaveLength(0);
      expect(view.router.state.location.pathname).toBe('/cs/test');
      expect(nameField().value).toBe('Etiopie B');
    }),
  );

  suite.effect('a reloaded product keeps the unsaved draft of another tab and asks before it is left', () =>
    Effect.gen(function* keepTabDraft() {
      const view = yield* Effect.promise(mount);
      yield* Effect.promise(() => typeInto('content-image-alt', 'Balení kávy'));
      yield* Effect.promise(() => typeInto('eshop-slug', 'etiopie-b'));
      // Another tab was saved, or a photo changed: the page passes the re-read product in.
      shown = reloaded({ name: 'Etiopie 2' });
      yield* Effect.promise(view.rerender);
      expect(fieldById('content-image-alt').value).toBe('Balení kávy');
      expect(fieldById('eshop-slug').value).toBe('etiopie-b');

      yield* view.attemptLeave;
      expect(buttons('Zůstat').length).toBeGreaterThan(0);
      yield* networkIdle;
      expect(commands()).toEqual([]);
    }),
  );

  suite.effect('a clean tab takes the reloaded product', () =>
    Effect.gen(function* cleanTabFollows() {
      const view = yield* Effect.promise(mount);
      shown = reloaded({ imageAlt: 'Nový popis', slug: 'etiopie-nova' });
      yield* Effect.promise(view.rerender);
      expect(fieldById('content-image-alt').value).toBe('Nový popis');
      expect(fieldById('eshop-slug').value).toBe('etiopie-nova');
      yield* networkIdle;
      expect(commands()).toEqual([]);
    }),
  );
});

const vatSelect = (): HTMLSelectElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLSelectElement>('select[name="taxClassification"]')));

/** The VAT options as the list offers them: label and whether it can be picked. */
const vatOptions = () =>
  [...document.querySelectorAll<HTMLElement>('[role="option"][data-value^="cz.vat."]')].map((option) => ({
    disabled: option.dataset.disabled !== undefined,
    label: option.textContent.trim(),
    value: option.dataset.value,
  }));

/** Picks a classification through the native select the select component keeps in sync. */
const pickVat = async (value: string) => {
  await act(async () => {
    const select = vatSelect();
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
  });
};

const sentPatches = () =>
  catalogRequests
    .map(({ command }) => command)
    .flatMap((command) => (Predicate.isTagged(command, 'UpdateProduct') ? [command.patch] : []));

it.layer(network, { excludeTestServices: true })('VAT classification on the product editor', (suite) => {
  suite.effect("names both classifications with today's rate and hints a scheduled change", () =>
    Effect.gen(function* namedByTax() {
      yield* Effect.promise(mount);
      expect(vatOptions()).toEqual([
        { disabled: false, label: 'Základní (21\u00A0%)', value: CZ_VAT_STANDARD },
        { disabled: false, label: 'Snížená (12\u00A0%)', value: CZ_VAT_REDUCED },
      ]);
      expect(vatSelect().value).toBe(CZ_VAT_REDUCED);
      expect(fieldById('detail-price-gross').value).toContain('289');
      expect(text()).not.toContain('Od 1. 1. 2099');
      // No rate input anywhere: the classification is the only VAT field.
      expect(document.querySelector('input[name="vat"], input[name="vatRate"]')).toBeNull();

      yield* Effect.promise(() => pickVat(CZ_VAT_STANDARD));
      expect(text()).toContain('Od 1. 1. 2099 23\u00A0%');
    }),
  );

  suite.effect('a classification the company has no rule for is offered disabled, with the reason', () =>
    Effect.gen(function* missingRule() {
      vat = { ...vat, rates: companyRates.filter((entry) => entry.code === CZ_VAT_STANDARD) };
      yield* Effect.promise(mount);
      expect(vatOptions()).toEqual([
        { disabled: false, label: 'Základní (21\u00A0%)', value: CZ_VAT_STANDARD },
        { disabled: true, label: 'Snížená (není nastaveno)', value: CZ_VAT_REDUCED },
      ]);
      // The product keeps its classification and its stored price including VAT.
      expect(fieldById('detail-price-gross').value).toContain('289');
    }),
  );

  suite.effect('a company Tax gives no rate at all shows that explicitly, never a number', () =>
    Effect.gen(function* noRates() {
      vat = { ...vat, rates: [] };
      yield* Effect.promise(mount);
      expect(text()).toContain('Pro tuto firmu není nastavená žádná sazba DPH.');
      expect(vatOptions().map((option) => option.label)).toEqual([
        'Základní (není nastaveno)',
        'Snížená (není nastaveno)',
      ]);
      expect(vatOptions().every((option) => option.disabled)).toBe(true);
      // The stored price including VAT is still the price; no rate is shown anywhere.
      expect(fieldById('detail-price-gross').value).toContain('289');
      expect(text()).not.toMatch(/\d\s?%/u);
    }),
  );

  suite.effect('a picked classification is a draft change: nothing is sent until Save, then only the code', () =>
    Effect.gen(function* throughTheDraft() {
      yield* Effect.promise(mount);
      yield* Effect.promise(() => pickVat(CZ_VAT_STANDARD));
      expect(text()).toContain('Neuložené změny');
      yield* networkIdle;
      expect(commands()).toEqual([]);

      yield* Effect.promise(() => click(button('Uložit')));
      yield* Effect.promise(() => waitUntil(() => text().includes('Uloženo')));
      expect(sentPatches()).toEqual([{ taxClassificationCode: CZ_VAT_STANDARD }]);
    }),
  );

  suite.effect('leaving with a picked classification unsaved asks first', () =>
    Effect.gen(function* guarded() {
      const view = yield* Effect.promise(mount);
      yield* Effect.promise(() => pickVat(CZ_VAT_STANDARD));
      yield* view.attemptLeave;
      expect(buttons('Zůstat')).toHaveLength(1);
      yield* Effect.promise(() => click(button('Zahodit změny')));
      expect(vatSelect().value).toBe(CZ_VAT_REDUCED);
      yield* networkIdle;
      expect(commands()).toEqual([]);
    }),
  );
});

/**
 * The coffee with variants as the staff records read builds it (`toProductRecord`): its own net 1 Kč and a gross of
 * 9,99 Kč stored on the product itself, and variants at the given net and stored gross (none: no gross stored yet).
 */
const withVariants = (variants: readonly (readonly [string, number, number | undefined])[]) =>
  toProductRecord(
    Schema.decodeSync(ProductSchema)({
      active: true,
      category: 'Zrnková káva',
      createdAt: '2026-10-20T09:00:00.000Z',
      currentPriceMinor: 100,
      grossPriceMinor: 999,
      id: 'product-1',
      lowStockThreshold: 0,
      name: 'Etiopie',
      priceHistory: [],
      sku: 'ETI-250',
      taxClassificationCode: CZ_VAT_STANDARD,
      unit: 'ks',
      updatedAt: '2026-10-20T09:00:00.000Z',
      variants: variants.map(([id, priceMinor, grossPriceMinor]) =>
        grossPriceMinor === undefined
          ? { attributes: '', id, name: id, priceMinor, sku: `ETI-${id}` }
          : { attributes: '', grossPriceMinor, id, name: id, priceMinor, sku: `ETI-${id}` },
      ),
    }),
    stockLevelsOf([], 'product-1'),
    {},
    {},
  );

it.layer(network, { excludeTestServices: true })('the price including VAT on the product editor', (suite) => {
  suite.effect(
    'shows the stored gross, even when it is not net plus VAT, and keeps it when only the classification changes',
    () =>
      Effect.gen(function* storedGross() {
        // As on stage: net 1000, stored gross 1211 (one haléř off net plus 21 %).
        shown = { ...product, currentPriceMinor: 1000, grossPriceMinor: 1211, taxClassificationCode: CZ_VAT_STANDARD };
        yield* Effect.promise(mount);
        expect(fieldById('detail-price-gross').value.replaceAll('\u00A0', ' ')).toBe('12,11 Kč');
        yield* Effect.promise(() => pickVat(CZ_VAT_REDUCED));
        // The server keeps the stored gross on a classification change: the field says the same and why.
        expect(fieldById('detail-price-gross').value.replaceAll('\u00A0', ' ')).toBe('12,11 Kč');
        expect(text()).toContain('Cena s DPH zůstává stejná, změní se jen podíl DPH v ní.');
      }),
  );

  suite.effect('without a stored gross a classification change says nothing about the VAT share', () =>
    Effect.gen(function* noStoredGross() {
      const { grossPriceMinor: _none, ...withoutGross } = productInput;
      void _none;
      shown = Schema.decodeSync(ProductRecordSchema)({ ...withoutGross, taxClassificationCode: CZ_VAT_STANDARD });
      yield* Effect.promise(mount);
      expect(fieldById('detail-price-gross').value).toBe('není nastaveno');
      yield* Effect.promise(() => pickVat(CZ_VAT_REDUCED));
      expect(text()).not.toContain('změní se jen podíl DPH');
    }),
  );

  suite.effect('a product with variants shows its lowest variant price as such, unmoved by the product net price', () =>
    Effect.gen(function* fromVariants() {
      // Its variants sell at 2,40 and 2,60 Kč net (2,90 and 3,15 Kč stored with VAT); the 9,99 Kč on the product
      // itself is never what it sells at.
      shown = withVariants([
        ['v1', 240, 290],
        ['v2', 260, 315],
      ]);
      yield* Effect.promise(mount);
      expect(text()).toContain('Cena s DPH od (nejnižší cena varianty, Kč)');
      expect(fieldById('detail-price-gross').value.replaceAll('\u00A0', ' ')).toBe('2,90 Kč');
      // The product's own net price does not change what its variants sell at: no preview of a product-level gross,
      // and no sentence about one.
      yield* Effect.promise(() => typeInto('detail-price', '2'));
      expect(fieldById('detail-price-gross').value.replaceAll('\u00A0', ' ')).toBe('2,90 Kč');
      expect(text()).not.toContain('Cena s DPH po uložení (náhled, Kč)');
      expect(text()).not.toContain('nová cena bez DPH uloží novou cenu s DPH');
    }),
  );

  suite.effect('a product whose variants have no gross yet shows none under the variants label', () =>
    Effect.gen(function* noVariantGross() {
      shown = withVariants([['v1', 240, undefined]]);
      yield* Effect.promise(mount);
      expect(text()).toContain('Cena s DPH od (nejnižší cena varianty, Kč)');
      expect(fieldById('detail-price-gross').value).toBe('není nastaveno');
    }),
  );

  suite.effect('an edited net price shows a preview of the gross saving will store, labelled as such', () =>
    Effect.gen(function* preview() {
      shown = { ...product, currentPriceMinor: 1000, grossPriceMinor: 1211, taxClassificationCode: CZ_VAT_STANDARD };
      yield* Effect.promise(mount);
      yield* Effect.promise(() => typeInto('detail-price', '20'));
      expect(fieldById('detail-price-gross').value.replaceAll('\u00A0', ' ')).toBe('24,20 Kč');
      expect(text()).toContain('Cena s DPH po uložení (náhled, Kč)');
    }),
  );
});

it.layer(network, { excludeTestServices: true })('variant editing', (suite) => {
  suite.effect('variant base-price editing omits inherited tiers while metadata-only editing keeps them', () =>
    Effect.gen(function* variantTierSubmission() {
      const tier = { minimumQuantity: 10, priceExcludingVatMinor: 800, priceMinor: 968 };
      const original = withVariants([
        ['v1', 1000, 1210],
        ['v2', 1000, 1210],
      ]);
      shown = {
        ...original,
        variants: original.variants?.map((variant) => ({ ...variant, priceTiers: [tier] })),
      };
      shownTab = 'variants';
      yield* Effect.promise(mount);
      yield* Effect.promise(() => typeInto('variant-price-v1', '20'));
      yield* Effect.promise(() => typeInto('variant-label-v2', 'Renamed'));
      // Every mounted tab has its own save bar; the variants tab saves its own drafts.
      const variantsPanel = fieldById('variant-price-v1').closest('[role="tabpanel"]');
      const saveVariants = [...(variantsPanel?.querySelectorAll('button') ?? [])].find(
        (entry) => entry.textContent?.trim() === 'Uložit',
      );
      expect(saveVariants?.disabled).toBe(false);
      yield* Effect.promise(() => click(saveVariants ?? document.createElement('button')));
      yield* Effect.promise(() => waitUntil(() => catalogRequests.length === 1));
      yield* networkIdle;
      expect(catalogRequests).toHaveLength(1);
      const command = catalogRequests[0]?.command;
      expect(Predicate.isTagged(command, 'UpdateProduct')).toBe(true);
      if (Predicate.isTagged(command, 'UpdateProduct')) {
        expect(command.patch.variants?.[0]?.priceMinor).toBe(2000);
        expect(command.patch.variants?.[0]).not.toHaveProperty('priceTiers');
        expect(command.patch.variants?.[1]?.priceTiers).toEqual([tier]);
      }
    }),
  );

  suite.effect('the variant movement form submits a fractional receipt without rounding it', () =>
    Effect.gen(function* fractionalVariantForm() {
      shown = withVariants([['v1', 1000, 1210]]);
      shownTab = 'variants';
      yield* Effect.promise(mount);
      yield* Effect.promise(() => typeInto('variant-stock-quantity', '0,125'));
      yield* Effect.promise(() => click(button('Zapsat pohyb')));
      yield* Effect.promise(() => waitUntil(() => movementRequests.length === 1));
      yield* networkIdle;
      expect(movementRequests).toHaveLength(1);
      expect(movementRequests[0]?.command).toMatchObject({
        delta: 0.125,
        productId: 'product-1',
        variantId: 'v1',
      });
      yield* Effect.promise(() => typeInto('variant-stock-quantity', '1000001'));
      yield* Effect.promise(() => click(button('Zapsat pohyb')));
      // A movement the refused quantity wrongly sent goes through the gateway and then the Action; it has arrived by now.
      yield* networkIdle;
      expect(movementRequests).toHaveLength(1);
    }),
  );
});
