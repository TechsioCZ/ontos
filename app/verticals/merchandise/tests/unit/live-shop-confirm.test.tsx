// @rstest-environment happy-dom
// One-click commands that change what the public e-shop shows ask first, naming what changes: bulk Aktivovat /
// Deaktivovat names how many products, archiving a DEMO product names the product. Zrušit runs nothing. Only the
// generated clients and the i18n runtime are replaced.
import { Effect, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ProductRecordSchema } from '../../shared/domain/merchandise-model.ts';
import { executeCleanupDemo } from '../../src/api/cleanup-demo-action-client.ts';
import { ProductBulkBar } from '../../src/routes/[lang]/provoz/produkty/product-bulk-bar.tsx';
import { DemoArchiveSection } from '../../src/routes/[lang]/provoz/produkty/product-eshop-sections.tsx';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

rstest.mock('../../src/api/records-consumer.ts');
rstest.mock('../../src/api/cleanup-demo-action-client.ts');
/** Shows the key with its values, so a test sees what the question names. */
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    language: 'cs',
    t: (key: string, values?: Record<string, number | string>) => [key, ...Object.values(values ?? {})].join(' '),
  }),
}));

const copy = {
  activate: 'merchandise.pages.products.bulk.activate',
  activateTitle: 'merchandise.pages.products.bulk.activateTitle 3',
  archiveTitle: 'merchandise.pages.products.eshop.archiveTitle Etiopie',
  cancel: 'merchandise.pages.products.common.cancel',
  deactivate: 'merchandise.pages.products.bulk.deactivate',
  deactivateDescription: 'merchandise.pages.products.bulk.deactivateDescription 3',
};

const product = Schema.decodeSync(ProductRecordSchema)({
  active: false,
  category: 'Zrnková káva',
  createdAt: '2026-10-20T09:00:00.000Z',
  currentPriceMinor: 25_804,
  id: 'product-1',
  lowStock: false,
  lowStockThreshold: 3,
  name: 'Etiopie',
  priceHistory: [],
  published: false,
  sku: 'ETI-250',
  stockOnHand: 12,
  stockValueMinor: 309_648,
  unit: 'ks',
  updatedAt: '2026-10-20T09:00:00.000Z',
  variants: [],
  vatRate: 12,
});

const settle = async (): Promise<void> => {
  await browserRuntime.runPromise(Effect.yieldNow);
};

const unmounts: (() => void)[] = [];

const mount = async (element: ReactNode) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
    await settle();
  });
  unmounts.push(() => {
    act(() => {
      root.unmount();
      container.remove();
    });
  });
};

const buttons = (name: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.trim() === name);
const button = (name: string) => Option.getOrThrow(Option.fromNullishOr(buttons(name)[0]));
const byTestId = (id: string) =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)));
const text = () => document.body.textContent ?? '';

const click = (element: HTMLElement) =>
  Effect.promise(() =>
    act(async () => {
      element.click();
      await settle();
    }),
  );

const type = (id: string, value: string) =>
  Effect.promise(() =>
    act(async () => {
      const field = Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`input[id="${id}"]`)));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await settle();
    }),
  );

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rstest.resetAllMocks();
  rstest.mocked(executeCleanupDemo).mockReturnValue(Effect.succeed({ entityIds: [], revision: 2 }));
});

afterEach(() => {
  for (const unmount of unmounts) {
    unmount();
  }
  unmounts.length = 0;
  rstest.unstubAllGlobals();
});

const bulkBar = (onSetActive: (active: boolean) => void) => (
  <ProductBulkBar
    busy={false}
    canWrite
    count={3}
    onChangeCategory={constVoid}
    onChangePrice={constVoid}
    onClear={constVoid}
    onSetActive={onSetActive}
    onTags={constVoid}
  />
);

it.effect('bulk Aktivovat asks first, naming how many products go on the e-shop', () =>
  Effect.gen(function* activate() {
    const calls: boolean[] = [];
    yield* Effect.promise(() =>
      mount(
        bulkBar((active) => {
          calls.push(active);
        }),
      ),
    );
    yield* click(button(copy.activate));
    expect(calls).toEqual([]);
    expect(text()).toContain(copy.activateTitle);
    yield* click(byTestId('live-shop-confirm'));
    expect(calls).toEqual([true]);
  }),
);

it.effect('bulk Deaktivovat names the products leaving the e-shop; Zrušit changes nothing', () =>
  Effect.gen(function* deactivate() {
    const calls: boolean[] = [];
    yield* Effect.promise(() =>
      mount(
        bulkBar((active) => {
          calls.push(active);
        }),
      ),
    );
    yield* click(button(copy.deactivate));
    expect(text()).toContain(copy.deactivateDescription);
    yield* click(button(copy.cancel));
    expect(calls).toEqual([]);
    yield* click(button(copy.deactivate));
    yield* click(byTestId('live-shop-confirm'));
    expect(calls).toEqual([false]);
  }),
);

it.effect('archiving a DEMO product asks first, naming the product, and runs once after the confirmation', () =>
  Effect.gen(function* archive() {
    const archived: string[] = [];
    yield* Effect.promise(() =>
      mount(
        <DemoArchiveSection
          onArchived={() => {
            archived.push('archived');
          }}
          onCommitted={constVoid}
          onReload={constVoid}
          product={product}
          revision={4}
        />,
      ),
    );
    yield* type('demo-archive-reason', 'Testovací produkt');
    yield* click(byTestId('demo-archive'));
    expect(executeCleanupDemo).not.toHaveBeenCalled();
    expect(text()).toContain(copy.archiveTitle);
    yield* click(byTestId('live-shop-confirm'));
    yield* Effect.promise(() => act(settle));
    yield* Effect.promise(() => act(settle));
    expect(executeCleanupDemo).toHaveBeenCalledTimes(1);
    expect(rstest.mocked(executeCleanupDemo).mock.calls[0]?.[0]).toMatchObject({
      command: { _tag: 'ArchiveDemoProduct', reason: 'Testovací produkt' },
      expectedRevision: 4,
    });
    expect(archived).toEqual(['archived']);
  }),
);
