// @rstest-environment happy-dom
// Creating a product, as staff see it: the VAT select starts on the first classification the company has a rate for,
// the chosen classification travels in the CreateProduct payload, and a company without any rate in force is told why
// the product cannot be created instead of being offered a disabled default. Only the generated clients, the i18n
// runtime and the router blocker are replaced.
import { saveLabelsFor } from '@app/admin-ui';
import { CZ_VAT_REDUCED, CZ_VAT_STANDARD, TaxRateViewSchema } from '@app/shared-contracts/cz-vat-classifications';
import { Effect, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { executeApplyCommand } from '../../src/api/apply-command-action-client.ts';
import { CreateProductDialog } from '../../src/routes/[lang]/provoz/produkty/product-forms.tsx';
import type { CompanyVat } from '../../src/routes/[lang]/provoz/produkty/product-tax-classification.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';
import { translateTaxCs } from './merchandise-translate.ts';

rstest.mock('../../src/api/records-consumer.ts');
rstest.mock('../../src/api/apply-command-action-client.ts');
rstest.mock('../../src/api/manage-catalog-action-client.ts');
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    language: 'cs',
    t: (key: string, values?: Record<string, number | string>) => translateTaxCs(key, values),
  }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ proceed: constVoid, reset: constVoid, status: 'idle' }),
}));

const rate = Schema.decodeSync(TaxRateViewSchema);
const standardRate = rate({ code: CZ_VAT_STANDARD, effectiveFrom: '2020-01-01T00:00:00Z', ratePercent: 21 });
const reducedRate = rate({ code: CZ_VAT_REDUCED, effectiveFrom: '2020-01-01T00:00:00Z', ratePercent: 12 });
const payerWith = (...rates: (typeof standardRate)[]): CompanyVat => ({ rates, regime: 'VAT_PAYER' });
const labels = saveLabelsFor('cs');

const settle = async (): Promise<void> => {
  await browserRuntime.runPromise(Effect.yieldNow);
};
const unmounts: (() => void)[] = [];
const mount = async (vat: CompanyVat) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <CreateProductDialog
        onCommitted={constVoid}
        onOpenChange={constVoid}
        onReload={constVoid}
        open
        revision={3}
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

const fieldById = (id: string): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`input[id="${id}"]`)));
const typeInto = async (id: string, value: string) => {
  await act(async () => {
    const field = fieldById(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await settle();
  });
};
const vatSelect = (): HTMLSelectElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLSelectElement>('select[name="taxClassification"]')));
const pickVat = async (value: string) => {
  await act(async () => {
    const select = vatSelect();
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
  });
};
const saveButton = (): HTMLButtonElement =>
  Option.getOrThrow(
    Option.fromUndefinedOr(
      [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent.trim() === labels.save,
      ),
    ),
  );
const fillRequired = async () => {
  await typeInto('product-sku', 'KAVA-500');
  await typeInto('product-name', 'Káva 500 g');
  await typeInto('product-category', 'Káva');
  await typeInto('product-price', '250');
};
const sentClassifications = () =>
  rstest
    .mocked(executeApplyCommand)
    .mock.calls.flatMap(([payload]) =>
      payload.command._tag === 'CreateProduct' ? [payload.command.taxClassificationCode] : [],
    );
const text = () => (document.body.textContent ?? '').replaceAll(' ', ' ');

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rstest.resetAllMocks();
  rstest.mocked(executeApplyCommand).mockReturnValue(Effect.succeed({ entityIds: [], revision: 4 }));
});

afterEach(() => {
  for (const unmount of unmounts.splice(0)) {
    unmount();
  }
  rstest.unstubAllGlobals();
});

it.effect('sends the classification staff picked in the CreateProduct payload', () =>
  Effect.promise(async () => {
    await mount(payerWith(standardRate, reducedRate));
    expect(vatSelect().value).toBe(CZ_VAT_STANDARD);
    await fillRequired();
    await pickVat(CZ_VAT_REDUCED);
    await act(async () => {
      saveButton().click();
      await settle();
    });
    expect(sentClassifications()).toEqual([CZ_VAT_REDUCED]);
  }),
);

it.effect('starts on the first classification with a rate when the standard one has none', () =>
  Effect.promise(async () => {
    await mount(payerWith(reducedRate));
    expect(vatSelect().value).toBe(CZ_VAT_REDUCED);
    await fillRequired();
    await act(async () => {
      saveButton().click();
      await settle();
    });
    expect(sentClassifications()).toEqual([CZ_VAT_REDUCED]);
  }),
);

it.effect('a company without any rate in force is told why, and nothing is sent', () =>
  Effect.promise(async () => {
    await mount(payerWith());
    expect(text()).toContain('Firma zatím nemá v modulu Daně platnou sazbu DPH, produkt proto nelze založit.');
    await fillRequired();
    await act(async () => {
      saveButton().click();
      await settle();
    });
    expect(sentClassifications()).toEqual([]);
  }),
);
