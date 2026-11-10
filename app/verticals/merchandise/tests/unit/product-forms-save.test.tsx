// @rstest-environment happy-dom
// The create and bulk product forms send their command only from the shared Save button ("Uložit"), last in the
// footer: typing and Enter change only the draft. Only the generated catalog client, the i18n runtime and the router
// blocker are replaced.
import { saveLabelsFor } from '@app/admin-ui';
import { Effect, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ProductIdSchema } from '../../shared/domain/merchandise-model.ts';
import { executeManageCatalog } from '../../src/api/manage-catalog-action-client.ts';
import { CategoryDialog, PriceChangeDialog } from '../../src/routes/[lang]/provoz/produkty/product-forms.tsx';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

rstest.mock('../../src/api/records-consumer.ts');
rstest.mock('../../src/api/manage-catalog-action-client.ts');
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ proceed: constVoid, reset: constVoid, status: 'idle' }),
}));

const labels = saveLabelsFor('cs');
const ids = [Schema.decodeUnknownSync(ProductIdSchema)('product-1')];

const sent = () => rstest.mocked(executeManageCatalog).mock.calls.map(([payload]) => payload.command);

const settle = async (): Promise<void> => {
  await browserRuntime.runPromise(Effect.yieldNow);
};

const unmounts: (() => void)[] = [];
const committed: string[] = [];
const openChanges: boolean[] = [];

const dialogProps = {
  ids,
  onCommitted: (message: string) => {
    committed.push(message);
  },
  onOpenChange: (open: boolean) => {
    openChanges.push(open);
  },
  onReload: constVoid,
  open: true,
  revision: 4,
};

/** Mounts `element` and returns how to render it again with other props. */
const mount = async (element: ReactElement) => {
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
  /** Renders the same tree again with other props, as the page does. */
  return (next: ReactElement) =>
    Effect.promise(() =>
      act(async () => {
        root.render(next);
        await settle();
      }),
    );
};

const footerButtons = (): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.closest('form') === null);

const saveButton = (): HTMLButtonElement =>
  Option.getOrThrow(Option.fromNullishOr(footerButtons().find((button) => button.textContent?.trim() === labels.save)));

const field = (id: string): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`#${id}`)));

const typeInto = (id: string, value: string) =>
  Effect.promise(() =>
    act(async () => {
      const input = field(id);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await settle();
    }),
  );

const pressEnter = (id: string) =>
  Effect.promise(() =>
    act(async () => {
      const input = field(id);
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
      input.form?.requestSubmit();
      await settle();
    }),
  );

const click = (element: HTMLElement) =>
  Effect.promise(() =>
    act(async () => {
      element.click();
      await settle();
    }),
  );

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
  committed.length = 0;
  openChanges.length = 0;
  rstest.mocked(executeManageCatalog).mockImplementation(() => Effect.succeed({ entityIds: [], revision: 5 }));
});

afterEach(() => {
  for (const unmount of unmounts) {
    unmount();
  }
  unmounts.length = 0;
  rstest.unstubAllGlobals();
});

it.effect('the category change is sent once, from Uložit only, never on Enter', () =>
  Effect.gen(function* categorySave() {
    yield* Effect.promise(() => mount(<CategoryDialog {...dialogProps} />));
    expect(saveButton().disabled).toBe(true);
    expect(footerButtons().at(-1)).toBe(saveButton());

    yield* typeInto('bulk-category', 'Nářadí');
    yield* pressEnter('bulk-category');
    expect(sent()).toEqual([]);
    expect(saveButton().disabled).toBe(false);

    yield* click(saveButton());
    yield* Effect.promise(() => waitUntil(() => committed.length === 1));
    expect(sent()).toEqual([{ _tag: 'BulkUpdateProducts', ids, patch: { category: 'Nářadí' } }]);
    expect(openChanges).toEqual([false]);
  }),
);

it.effect('the price change it opens with is sent by the first Uložit', () =>
  Effect.gen(function* priceSave() {
    yield* Effect.promise(() => mount(<PriceChangeDialog {...dialogProps} />));
    expect(saveButton().disabled).toBe(false);
    expect(sent()).toEqual([]);

    yield* click(saveButton());
    yield* Effect.promise(() => waitUntil(() => committed.length === 1));
    expect(sent()).toEqual([{ _tag: 'BulkUpdateProducts', ids, patch: { priceChangePercent: 5 } }]);
  }),
);

type ManageCatalogFailure = Effect.Error<ReturnType<typeof executeManageCatalog>>;
/** The action's refusal for a user without the permission. */
const forbidden: Extract<ManageCatalogFailure, { readonly _tag: 'ManageCatalogActionForbiddenProblem' }> = {
  _tag: 'ManageCatalogActionForbiddenProblem',
  code: 'action_permission_denied',
  detail: 'The actor may not change prices',
  status: 403,
  title: 'Forbidden',
  type: 'https://ontos.dev/problems/forbidden',
};

/** Whether closing or reloading the tab would ask now. */
const unloadAsks = (): boolean => {
  const event = new Event('beforeunload', { cancelable: true });
  globalThis.dispatchEvent(event);
  return event.defaultPrevented;
};

it.effect('the price change becomes savable when rows are selected after the page mounted it', () =>
  Effect.gen(function* lateSelection() {
    // The products page mounts the dialog before anything is selected.
    const rerender = yield* Effect.promise(() => mount(<PriceChangeDialog {...dialogProps} ids={[]} open={false} />));
    yield* rerender(<PriceChangeDialog {...dialogProps} open />);
    expect(saveButton().disabled).toBe(false);

    yield* click(saveButton());
    yield* Effect.promise(() => waitUntil(() => committed.length === 1));
    expect(sent()).toEqual([{ _tag: 'BulkUpdateProducts', ids, patch: { priceChangePercent: 5 } }]);
  }),
);

it.effect('the price change asks before leaving only for a percent the user typed in the open panel', () =>
  Effect.gen(function* untouchedPrice() {
    const rerender = yield* Effect.promise(() => mount(<PriceChangeDialog {...dialogProps} ids={[]} open={false} />));
    expect(unloadAsks()).toBe(false);
    yield* rerender(<PriceChangeDialog {...dialogProps} open />);
    // The 5 % it opens with is not typed input.
    expect(unloadAsks()).toBe(false);
    yield* typeInto('price-percent', '7');
    expect(unloadAsks()).toBe(true);
  }),
);

it.effect('the price change it opens with asks before leaving once its save failed', () =>
  Effect.gen(function* failedOpeningPrice() {
    rstest.mocked(executeManageCatalog).mockImplementation(() => Effect.fail(forbidden));
    yield* Effect.promise(() => mount(<PriceChangeDialog {...dialogProps} />));
    expect(unloadAsks()).toBe(false);
    yield* click(saveButton());
    yield* Effect.promise(() => waitUntil(() => sent().length === 1));
    yield* Effect.promise(() => waitUntil(() => unloadAsks()));
    expect(committed).toEqual([]);
  }),
);
