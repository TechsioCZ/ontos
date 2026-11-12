// @rstest-environment happy-dom
// The new order dialog as a user fills it: customer first, then a product whose full record loads afterwards. Uložit
// becomes enabled once that record is there, and one click sends one CreateOrder. The two pickers are replaced by
// buttons that pick, the product record read is answered by the test, and only the generated catalog client, the
// i18n runtime and the router blocker are replaced besides.
import { saveLabelsFor } from '@app/admin-ui';
import { CZ_VAT_REDUCED, CZ_VAT_STANDARD, TaxRateViewSchema } from '@app/shared-contracts/cz-vat-classifications';
import type { CompanyVat } from '../../src/routes/[lang]/provoz/produkty/product-tax-classification.ts';
import { Effect, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ProductRecordSchema } from '../../shared/apis/records.ts';
import type { ProductRecord } from '../../shared/apis/records.ts';
import { executeManageCatalog } from '../../src/api/manage-catalog-action-client.ts';
import { OrderCreateDialog } from '../../src/routes/[lang]/prodej/objednavky/order-create-dialog.tsx';
import type { CustomerDirectory } from '../../src/routes/[lang]/prodej/objednavky/customers-directory.ts';
import type { ProductRecordState } from '../../src/routes/[lang]/provoz/produkty/product-reads.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';
import { translateCs } from './merchandise-translate.ts';

/** A read of a picked product's full record, waiting for the test to answer it. */
interface ProductRead {
  readonly answer: (state: ProductRecordState) => void;
  readonly productId: string;
}

/** The product the mocked picker picks. */
interface OfferedProduct {
  current: ProductRecord | null;
}

const { offered, productReads } = rstest.hoisted(() => {
  const reads: ProductRead[] = [];
  // The product the mocked picker picks; set before each test, since the mocks exist before this module's constants.
  const pick: OfferedProduct = { current: null };
  return { offered: pick, productReads: reads };
});

rstest.mock('../../src/api/records-consumer.ts');
rstest.mock('../../src/api/manage-catalog-action-client.ts');
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    language: 'cs',
    t: (key: string, values?: Record<string, number | string>) => translateCs(key, values),
  }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ proceed: constVoid, reset: constVoid, status: 'idle' }),
}));
// The customer picker: one button that picks the first active customer.
rstest.mock('@techsio/ui-kit/molecules/combobox', () => ({
  Combobox: (props: {
    readonly items: readonly { readonly value: string }[];
    readonly onChange: (v: string[]) => void;
  }) =>
    createElement(
      'button',
      { onClick: () => props.onChange(props.items.slice(0, 1).map((item) => item.value)), type: 'button' },
      'pick customer',
    ),
}));
// The product picker: one button that picks the product the test offers.
rstest.mock('../../src/routes/[lang]/provoz/produkty/product-search.tsx', () => ({
  ProductSearchCombobox: (props: { readonly onSelect: (product: ProductRecord | null) => void }) =>
    createElement('button', { onClick: () => props.onSelect(offered.current), type: 'button' }, 'pick product'),
}));
// The full record of a picked product: read when picked, answered by the test.
rstest.mock('../../src/routes/[lang]/provoz/produkty/product-reads.ts', () => ({
  loadProductRecord: (productId: string, answer: (state: ProductRecordState) => void) => {
    productReads.push({ answer, productId });
  },
}));

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

const sent = () => rstest.mocked(executeManageCatalog).mock.calls.map(([payload]) => payload.command);

const settle = async (): Promise<void> => {
  await browserRuntime.runPromise(Effect.yieldNow);
};

const unmounts: (() => void)[] = [];
const created: string[] = [];

const mount = async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
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
    );
    await settle();
  });
  unmounts.push(() => {
    act(() => {
      root.unmount();
      container.remove();
    });
  });
};

const buttonNamed = (name: string): HTMLButtonElement =>
  Option.getOrThrow(
    Option.fromUndefinedOr(
      [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === name),
    ),
  );

const click = async (name: string) => {
  await act(async () => {
    buttonNamed(name).click();
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

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rstest.resetAllMocks();
  productReads.length = 0;
  offered.current = product;
  created.length = 0;
  vat = payer;
  rstest.mocked(executeManageCatalog).mockImplementation(() => Effect.succeed({ entityIds: [], revision: 5 }));
});

afterEach(() => {
  for (const unmount of unmounts.splice(0)) {
    unmount();
  }
  rstest.unstubAllGlobals();
});

it.effect('customer first, then a product whose record loads later: Uložit enables and one click sends one order', () =>
  Effect.promise(async () => {
    await mount();
    expect(buttonNamed(labels.save).disabled).toBe(true);

    await click('pick customer');
    expect(buttonNamed(labels.save).disabled).toBe(true);
    await click('pick product');
    // The product record is still loading: the line cannot be priced yet.
    expect(productReads.map((read) => read.productId)).toEqual(['product-1']);
    expect(buttonNamed(labels.save).disabled).toBe(true);

    await act(async () => {
      productReads[0]?.answer({ product, status: 'ready' });
      await settle();
    });
    expect(buttonNamed(labels.save).disabled).toBe(false);

    await click(labels.save);
    await waitUntil(() => created.length === 1);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({
      _tag: 'CreateOrder',
      lines: [{ productId: 'product-1', quantity: 1 }],
      partyId: 'party-1',
    });
  }),
);

/** What the dialog shows, with non-breaking spaces (money, percent) read as plain spaces. */
const text = () => (document.body.textContent ?? '').replaceAll('\u00A0', ' ');

/** Picks the customer and the offered product, and answers the product's record read. */
const fillOneLine = async (picked: ProductRecord) => {
  offered.current = picked;
  await mount();
  await click('pick customer');
  await click('pick product');
  await act(async () => {
    productReads[0]?.answer({ product: picked, status: 'ready' });
    await settle();
  });
};

it.effect("the line shows its product's classification with today's rate, and the totals use it", () =>
  Effect.promise(async () => {
    await fillOneLine(reducedProduct);
    expect(text()).toContain('Cena 8 Kč, skladem 40 ks, DPH Snížená (12 %)');
    // 8 Kč net, 12 % VAT per line rounded half-up: 0,96 Kč, 8,96 Kč with VAT.
    expect(text()).toContain('0,96 Kč');
    expect(text()).toContain('8,96 Kč');
    expect(buttonNamed(labels.save).disabled).toBe(false);
  }),
);

it.effect('standard 21 % keeps the arithmetic the order editor has always shown', () =>
  Effect.promise(async () => {
    await fillOneLine(product);
    expect(text()).toContain('DPH Základní (21 %)');
    expect(text()).toContain('1,68 Kč');
    expect(text()).toContain('9,68 Kč');
  }),
);

it.effect('a product whose classification has no rate in force says so and cannot be ordered', () =>
  Effect.promise(async () => {
    vat = { ...payer, rates: [standardRate] };
    await fillOneLine(reducedProduct);
    expect(text()).toContain('DPH Snížená (není nastaveno)');
    expect(buttonNamed(labels.save).disabled).toBe(true);
    expect(sent()).toEqual([]);
  }),
);

it.effect('a company that is not a VAT payer orders at 0 %: the line says so and the order can be saved', () =>
  Effect.promise(async () => {
    vat = { rates: [], regime: 'NON_PAYER' };
    await fillOneLine(product);
    expect(text()).toContain('DPH Základní (firma není plátce DPH)');
    expect(text()).not.toContain('není nastaveno');
    expect(buttonNamed(labels.save).disabled).toBe(false);
    await click(labels.save);
    await waitUntil(() => sent().length === 1);
    expect(sent()).toEqual([expect.objectContaining({ _tag: 'CreateOrder' })]);
  }),
);

it.effect('rates the tax module has not confirmed yet are named as such above the lines', () =>
  Effect.promise(async () => {
    vat = { ...payer, confirmedAt: null };
    await mount();
    expect(text()).toContain('Sazby DPH zatím nepotvrdil modul Daně');
  }),
);

it.effect('two rules in force at once for the classification: the line says why and nothing is sent', () =>
  Effect.promise(async () => {
    vat = {
      ...payer,
      rates: [
        standardRate,
        rate({ code: CZ_VAT_STANDARD, effectiveFrom: '2024-01-01T00:00:00Z', ratePercent: 20 }),
        reducedRate,
      ],
    };
    await fillOneLine(product);
    expect(text()).toContain(
      'Pro sazbu DPH „Základní“ platí v modulu Daně více pravidel zároveň, produkt nelze přidat.',
    );
    expect(buttonNamed(labels.save).disabled).toBe(true);
    expect(sent()).toEqual([]);
  }),
);
