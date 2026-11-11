// @rstest-environment happy-dom
// The product editor as the user sees it: one Save button under the detail form, the draft's status next to it, a
// question before unsaved changes are left, and nothing sent unless Save is clicked. Only the generated clients, the
// i18n runtime and the router blocker are replaced.
import { Effect, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ProductRecordSchema } from '../../shared/domain/merchandise-model.ts';
import { executeManageCatalog } from '../../src/api/manage-catalog-action-client.ts';
import { ProductDetailView } from '../../src/routes/[lang]/provoz/produkty/product-detail-dialog.tsx';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

rstest.mock('../../src/api/records-consumer.ts');
rstest.mock('../../src/api/manage-catalog-action-client.ts');
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
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
  id: 'product-1',
  lowStock: false,
  lowStockThreshold: 3,
  name: 'Etiopie',
  priceHistory: [],
  shortDescription: 'Svěží káva',
  sku: 'ETI-250',
  stockOnHand: 12,
  stockValueMinor: 309_648,
  unit: 'ks',
  updatedAt: '2026-10-20T09:00:00.000Z',
  variants: [],
  vatRate: 12,
};
const product = Schema.decodeSync(ProductRecordSchema)(productInput);

/** The product the page passes in; a test replaces it to deliver a reloaded record. */
let shown = product;

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
          tab="detail"
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
