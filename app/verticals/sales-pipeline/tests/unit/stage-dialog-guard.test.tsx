// @rstest-environment happy-dom
// The stage change stays a one-click command with its own button, but a typed note is not lost silently: closing the
// dialog with a note asks first, closing without one leaves at once. The i18n runtime, the router blocker and the
// select template (by a native select) are replaced.
import { saveLabelsFor } from '@app/admin-ui';
import { Effect, Option } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { StageDialog } from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-dialogs.tsx';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

interface ItemsProps {
  readonly items: readonly { readonly label: string; readonly value: string }[];
  readonly name?: string;
  readonly onValueChange?: (details: { readonly value: string[] }) => void;
}

rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@app/admin-ui/select-template', () => ({
  SelectTemplate: ({ items, name, onValueChange }: ItemsProps) =>
    createElement(
      'select',
      {
        name,
        onChange: (event: { readonly target: { readonly value: string } }) =>
          onValueChange?.({ value: [event.target.value] }),
      },
      ...items.map((item) => createElement('option', { key: item.value, value: item.value }, item.label)),
    ),
}));

const labels = saveLabelsFor('cs');
const copy = {
  cancel: 'sales-pipeline.pages.records.stageDialog.cancel',
  description: 'description',
  note: 'Zákazník čeká na nabídku',
} as const;

const settle = async (): Promise<void> => {
  await browserRuntime.runPromise(Effect.yieldNow);
};

const views: (() => void)[] = [];

const mount = async (events: string[]) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  views.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  await act(async () => {
    root.render(
      <StageDialog
        busy={false}
        currentStage="LEAD"
        description={copy.description}
        onOpenChange={(open) => {
          events.push(open ? 'open' : 'closed');
        }}
        onSubmit={() => {
          events.push('submitted');
        }}
        showNote
      />,
    );
  });
  await settle();
};

const buttons = (name: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.trim() === name);

const button = (name: string): HTMLButtonElement => Option.getOrThrow(Option.fromNullishOr(buttons(name).at(0)));

const act$ = async (run: () => void) => {
  await act(async () => {
    run();
  });
  await settle();
};

const typeNote = (value: string) =>
  act$(() => {
    const input = Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLTextAreaElement>('#stage-note')));
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  for (const unmount of views.splice(0)) {
    unmount();
  }
  rstest.unstubAllGlobals();
});

describe('stage dialog note', () => {
  it.live('closing without a note leaves at once', () =>
    Effect.promise(async () => {
      const events: string[] = [];
      await mount(events);
      await act$(() => button(copy.cancel).click());
      expect(buttons(labels.discard)).toHaveLength(0);
      expect(events).toEqual(['closed']);
    }),
  );

  it.live('closing with a typed note asks first; Zůstat keeps it, Zahodit změny leaves', () =>
    Effect.promise(async () => {
      const events: string[] = [];
      await mount(events);
      await typeNote(copy.note);
      await act$(() => button(copy.cancel).click());
      expect(buttons(labels.discard)).toHaveLength(1);
      expect(events).toEqual([]);

      await act$(() => button(labels.stay).click());
      expect(events).toEqual([]);
      expect(document.querySelector<HTMLTextAreaElement>('#stage-note')?.value).toBe(copy.note);

      await act$(() => button(copy.cancel).click());
      await act$(() => button(labels.discard).click());
      expect(events).toEqual(['closed']);
    }),
  );
});
