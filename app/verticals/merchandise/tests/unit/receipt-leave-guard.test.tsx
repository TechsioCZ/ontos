// @rstest-environment happy-dom
// Příjem zboží stays a stock-movement command with its own button, but closing it with typed input asks the shared
// leave question (Zůstat / Zahodit změny, Uložit offered but disabled), never an older dialog of its own. Its own
// button stays disabled until a product and a valid quantity are filled in.
import { saveLabelsFor } from '@app/admin-ui';
import { Effect, Option } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ReceiptDialog } from '../../src/routes/[lang]/provoz/produkty/product-forms.tsx';
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
const copy = {
  cancel: 'merchandise.pages.products.common.cancel',
  oldKeep: 'merchandise.pages.products.detail.discardKeep',
  submit: 'merchandise.pages.products.receipt.submit',
  typed: 'typed-note',
} as const;

const settle = async (): Promise<void> => {
  await browserRuntime.runPromise(Effect.yieldNow);
};

const unmounts: (() => void)[] = [];
const openChanges: boolean[] = [];

const mount = Effect.promise(async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ReceiptDialog
        onCommitted={constVoid}
        onOpenChange={(open) => {
          openChanges.push(open);
        }}
        onReload={constVoid}
        open
        revision={4}
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
});

const buttons = (label: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.trim() === label);
const button = (label: string): HTMLButtonElement => Option.getOrThrow(Option.fromNullishOr(buttons(label)[0]));
const typeNote = (value: string) =>
  Effect.promise(() =>
    act(async () => {
      const input = Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>('#receipt-note')));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
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

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  openChanges.length = 0;
});

afterEach(() => {
  for (const unmount of unmounts) {
    unmount();
  }
  unmounts.length = 0;
  rstest.unstubAllGlobals();
});

it.effect('closing with typed input asks the shared leave question; Zůstat keeps it, Zahodit změny closes', () =>
  Effect.gen(function* leave() {
    yield* mount;
    yield* typeNote(copy.typed);
    yield* click(button(copy.cancel));
    expect(buttons(copy.oldKeep)).toHaveLength(0);
    expect(buttons(labels.stay)).toHaveLength(1);
    expect(buttons(labels.discard)).toHaveLength(1);
    // The question never sends the receipt: only the command's own button does.
    expect(button(labels.save).disabled).toBe(true);
    expect(openChanges).toEqual([]);

    yield* click(button(labels.stay));
    expect(buttons(labels.stay)).toHaveLength(0);
    expect(document.querySelector<HTMLInputElement>('#receipt-note')?.value).toBe(copy.typed);

    yield* click(button(copy.cancel));
    yield* click(button(labels.discard));
    expect(openChanges).toEqual([false]);
  }),
);

it.effect('an untouched receipt closes at once', () =>
  Effect.gen(function* untouched() {
    yield* mount;
    yield* click(button(copy.cancel));
    expect(buttons(labels.stay)).toHaveLength(0);
    expect(openChanges).toEqual([false]);
  }),
);

it.effect('the receipt button stays disabled until a product is picked', () =>
  Effect.gen(function* disabledSubmit() {
    yield* mount;
    expect(button(copy.submit).disabled).toBe(true);
    yield* typeNote(copy.typed);
    expect(button(copy.submit).disabled).toBe(true);
  }),
);
