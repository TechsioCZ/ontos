// @rstest-environment happy-dom
// The product editor as the user sees it: one Save button under the detail form, the draft's status next to it, a
// question before unsaved changes are left, and nothing sent unless Save is clicked. Only the generated clients, the
// i18n runtime and the router blocker are replaced.
import { CZ_VAT_REDUCED, CZ_VAT_STANDARD, TaxRateViewSchema } from '@app/shared-contracts/cz-vat-classifications';
import type { TaxRateView } from '@app/shared-contracts/cz-vat-classifications';
import { Effect, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ProductRecordSchema } from '../../shared/domain/merchandise-model.ts';
import { executeManageCatalog } from '../../src/api/manage-catalog-action-client.ts';
import { ProductDetailView } from '../../src/routes/[lang]/provoz/produkty/product-detail-dialog.tsx';
import type { CompanyVat } from '../../src/routes/[lang]/provoz/produkty/product-tax-classification.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';
import { translateCs, translateIn } from './merchandise-translate.ts';

rstest.mock('../../src/api/records-consumer.ts');
rstest.mock('../../src/api/manage-catalog-action-client.ts');
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    language: 'cs',
    t: (key: string, values?: Record<string, number | string>) => translateCs(key, values),
  }),
}));

/** The router's blocked navigation: `blocked` while a route change waits for the question's answer. */
interface Navigation {
  proceeded: number;
  reset: number;
  status: 'blocked' | 'idle';
}
const navigation: Navigation = { proceeded: 0, reset: 0, status: 'idle' };
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({
    proceed: () => {
      navigation.proceeded += 1;
    },
    reset: () => {
      navigation.reset += 1;
    },
    status: navigation.status,
  }),
}));

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

const commands = () => rstest.mocked(executeManageCatalog).mock.calls.map(([payload]) => payload.command._tag);

const settle = async (): Promise<void> => {
  await browserRuntime.runPromise(Effect.yieldNow);
};

const unmounts: (() => void)[] = [];

const mount = async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const back: string[] = [];
  const show = async () => {
    await act(async () => {
      root.render(
        <ProductDetailView
          canWrite
          movements={[]}
          onBack={() => {
            back.push('back');
          }}
          onCommitted={constVoid}
          onReload={constVoid}
          onTabChange={constVoid}
          product={shown}
          revision={1}
          tab={shownTab}
          vat={vat}
        />,
      );
      await settle();
    });
  };
  await show();
  let live = true;
  const unmount = () => {
    if (live) {
      live = false;
      act(() => {
        root.unmount();
        container.remove();
      });
    }
  };
  unmounts.push(unmount);
  return { back, rerender: show, unmount };
};

const buttons = (name: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.trim() === name);

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

const waitUntil = async (condition: () => boolean, attempt = 0): Promise<void> => {
  if (condition() || attempt >= 400) {
    expect(condition()).toBe(true);
    return;
  }
  await act(settle);
  await waitUntil(condition, attempt + 1);
};

const text = () => document.body.textContent ?? '';

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rstest.resetAllMocks();
  rstest.mocked(executeManageCatalog).mockReturnValue(Effect.succeed({ entityIds: [], revision: 2 }));
  navigation.proceeded = 0;
  navigation.reset = 0;
  navigation.status = 'idle';
  shown = product;
  shownTab = 'detail';
  vat = { rates: companyRates, regime: 'VAT_PAYER' };
});

afterEach(() => {
  for (const unmount of unmounts) {
    unmount();
  }
  unmounts.length = 0;
  rstest.unstubAllGlobals();
});

describe('product editor with one Save button', () => {
  it.live('typing and leaving a field send nothing, not after a delay and not on unmount', () =>
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
      view.unmount();
      yield* Effect.promise(() => act(settle));
      expect(commands()).toEqual([]);
    }),
  );

  it.effect('one click on Save sends the changed fields once', () =>
    Effect.gen(function* saveOnce() {
      yield* Effect.promise(mount);
      yield* Effect.promise(() => typeName('Etiopie B'));
      yield* Effect.promise(() => click(button('Uložit')));
      yield* Effect.promise(() => waitUntil(() => text().includes('Uloženo')));
      expect(commands()).toEqual(['UpdateProduct']);
    }),
  );

  it.effect('an empty name holds the Save button back', () =>
    Effect.gen(function* invalid() {
      yield* Effect.promise(mount);
      yield* Effect.promise(() => typeName(''));
      expect(button('Uložit').disabled).toBe(true);
      expect(commands()).toEqual([]);
    }),
  );

  it.effect('a blocked navigation asks; Zahodit změny lets it go without saving', () =>
    Effect.gen(function* blockedNavigation() {
      const view = yield* Effect.promise(mount);
      yield* Effect.promise(() => typeName('Etiopie B'));
      navigation.status = 'blocked';
      yield* Effect.promise(view.rerender);
      expect(buttons('Zůstat')).toHaveLength(1);

      yield* Effect.promise(() => click(button('Zahodit změny')));
      expect(navigation.proceeded).toBe(1);
      expect(nameField().value).toBe('Etiopie');
      expect(commands()).toEqual([]);
    }),
  );

  it.effect('Zůstat keeps the draft and cancels the navigation', () =>
    Effect.gen(function* stay() {
      const view = yield* Effect.promise(mount);
      yield* Effect.promise(() => typeName('Etiopie B'));
      navigation.status = 'blocked';
      yield* Effect.promise(view.rerender);
      yield* Effect.promise(() => click(button('Zůstat')));
      expect(navigation.reset).toBe(1);
      expect(navigation.proceeded).toBe(0);
      expect(nameField().value).toBe('Etiopie B');
    }),
  );

  it.effect('a reloaded product keeps the unsaved draft of another tab and asks before it is left', () =>
    Effect.gen(function* keepTabDraft() {
      const view = yield* Effect.promise(mount);
      yield* Effect.promise(() => typeInto('content-image-alt', 'Balení kávy'));
      yield* Effect.promise(() => typeInto('eshop-slug', 'etiopie-b'));
      // Another tab was saved, or a photo changed: the page passes the re-read product in.
      shown = reloaded({ name: 'Etiopie 2' });
      yield* Effect.promise(view.rerender);
      expect(fieldById('content-image-alt').value).toBe('Balení kávy');
      expect(fieldById('eshop-slug').value).toBe('etiopie-b');

      navigation.status = 'blocked';
      yield* Effect.promise(view.rerender);
      expect(buttons('Zůstat').length).toBeGreaterThan(0);
      expect(commands()).toEqual([]);
    }),
  );

  it.effect('a clean tab takes the reloaded product', () =>
    Effect.gen(function* cleanTabFollows() {
      const view = yield* Effect.promise(mount);
      shown = reloaded({ imageAlt: 'Nový popis', slug: 'etiopie-nova' });
      yield* Effect.promise(view.rerender);
      expect(fieldById('content-image-alt').value).toBe('Nový popis');
      expect(fieldById('eshop-slug').value).toBe('etiopie-nova');
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
  rstest
    .mocked(executeManageCatalog)
    .mock.calls.map(([payload]) => payload.command)
    .flatMap((command) => (command._tag === 'UpdateProduct' ? [command.patch] : []));

describe('VAT classification on the product editor', () => {
  it.effect("names both classifications with today's rate and hints a scheduled change", () =>
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

  it.effect('a classification the company has no rule for is offered disabled, with the reason', () =>
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

  it.effect('a company Tax gives no rate at all shows that explicitly, never a number', () =>
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

  it.effect('a picked classification is a draft change: nothing is sent until Save, then only the code', () =>
    Effect.gen(function* throughTheDraft() {
      yield* Effect.promise(mount);
      yield* Effect.promise(() => pickVat(CZ_VAT_STANDARD));
      expect(text()).toContain('Neuložené změny');
      expect(commands()).toEqual([]);

      yield* Effect.promise(() => click(button('Uložit')));
      yield* Effect.promise(() => waitUntil(() => text().includes('Uloženo')));
      expect(sentPatches()).toEqual([{ taxClassificationCode: CZ_VAT_STANDARD }]);
    }),
  );

  it.effect('leaving with a picked classification unsaved asks first', () =>
    Effect.gen(function* guarded() {
      const view = yield* Effect.promise(mount);
      yield* Effect.promise(() => pickVat(CZ_VAT_STANDARD));
      navigation.status = 'blocked';
      yield* Effect.promise(view.rerender);
      expect(buttons('Zůstat')).toHaveLength(1);
      yield* Effect.promise(() => click(button('Zahodit změny')));
      expect(vatSelect().value).toBe(CZ_VAT_REDUCED);
      expect(commands()).toEqual([]);
    }),
  );
});

/** One variant record of the product, priced net and with its stored gross. */
const variant = (id: string, priceMinor: number, grossPriceMinor: number) => ({
  active: true,
  attributes: '',
  availability: 'IN_STOCK' as const,
  grossPriceMinor,
  id,
  name: id,
  priceHistory: [],
  priceMinor,
  sku: `ETI-${id}`,
  stockOnHand: 1,
});

describe('the price including VAT on the product editor', () => {
  it.effect(
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

  it.effect('without a stored gross a classification change says nothing about the VAT share', () =>
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

  it.effect('a product with variants shows its lowest variant price as such, unmoved by the product net price', () =>
    Effect.gen(function* fromVariants() {
      // Net 1 Kč on the product; its variants sell at 2,40 and 2,60 Kč net (2,90 and 3,15 Kč stored with VAT).
      shown = Schema.decodeSync(ProductRecordSchema)({
        ...productInput,
        currentPriceMinor: 100,
        grossPriceMinor: 290,
        taxClassificationCode: CZ_VAT_STANDARD,
        variantRecords: [variant('v1', 240, 290), variant('v2', 260, 315)],
      });
      yield* Effect.promise(mount);
      expect(text()).toContain('Cena s DPH od (nejnižší cena varianty, Kč)');
      expect(fieldById('detail-price-gross').value.replaceAll('\u00A0', ' ')).toBe('2,90 Kč');
      // The product's own net price does not change what its variants sell at: no preview of a product-level gross.
      yield* Effect.promise(() => typeInto('detail-price', '2'));
      expect(fieldById('detail-price-gross').value.replaceAll('\u00A0', ' ')).toBe('2,90 Kč');
      expect(text()).not.toContain('Cena s DPH po uložení (náhled, Kč)');
    }),
  );

  it.effect('an edited net price shows a preview of the gross saving will store, labelled as such', () =>
    Effect.gen(function* preview() {
      shown = { ...product, currentPriceMinor: 1000, grossPriceMinor: 1211, taxClassificationCode: CZ_VAT_STANDARD };
      yield* Effect.promise(mount);
      yield* Effect.promise(() => typeInto('detail-price', '20'));
      expect(fieldById('detail-price-gross').value.replaceAll('\u00A0', ' ')).toBe('24,20 Kč');
      expect(text()).toContain('Cena s DPH po uložení (náhled, Kč)');
    }),
  );
});

describe('the variants tab', () => {
  it.effect('explains prices in one translated sentence that names the classification', () =>
    Effect.gen(function* variantsIntro() {
      shownTab = 'variants';
      yield* Effect.promise(mount);
      expect(text()).toContain('Varianta má vlastní SKU, cenu, sklad a stav.');
      expect(text()).toContain('se uloží při uložení ceny podle sazby Snížená (12');
      const english = translateIn('en')('merchandise.ui.variantsIntro', { vat: 'Reduced (12 %)' });
      expect(english).toContain('at the rate Reduced (12 %).');
      expect(english).not.toMatch(/[áčďéěíňóřšťúůýž]/u);
    }),
  );
});
