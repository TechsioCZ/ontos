// @rstest-environment happy-dom
// The create panel of an opportunity as the user sees it: typing and picking change only the draft, Enter sends
// nothing, the shared Save button ("Uložit", last in the footer) creates the opportunity once, an untouched panel
// closes without asking and a refused create keeps the input. The i18n runtime, the router blocker, the ui-kit
// combobox (by one button per item) and the select template (by a native select) are replaced.
import { saveLabelsFor } from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { Effect, Option, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { PartyIdSchema } from '../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import { OpportunityCreatePanel } from '../../src/routes/[lang]/prodej/prilezitosti/opportunity-create-panel.tsx';
import type { CreateCommand } from '../../src/routes/[lang]/prodej/prilezitosti/opportunity-fields.tsx';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

/** The props the stand-ins of the combobox and the select read. */
interface ItemsProps {
  readonly items: readonly { readonly label: string; readonly value: string }[];
  readonly name?: string;
  readonly onChange?: (value: string[]) => void;
  readonly onValueChange?: (details: { readonly value: string[] }) => void;
}

rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@techsio/ui-kit/molecules/combobox', () => ({
  Combobox: ({ items, name, onChange }: ItemsProps) =>
    createElement(
      'div',
      null,
      ...items.map((item) =>
        createElement(
          'button',
          {
            'data-testid': `${name ?? 'combobox'}-${item.value}`,
            key: item.value,
            onClick: () => onChange?.([item.value]),
            type: 'button',
          },
          item.label,
        ),
      ),
    ),
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
  cancel: 'sales-pipeline.pages.records.create.cancel',
  close: '2026-12-01',
  title: 'Dodávka regálů',
} as const;
const partyId = Schema.decodeSync(PartyIdSchema)('10000000-0000-4000-8000-000000000001');

const created: CreateCommand[] = [];
let answer: SaveOutcome = 'saved';

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
      <OpportunityCreatePanel
        customers={{
          items: [{ archived: false, companyId: null, counterpartyId: 'cp-1', id: partyId, name: 'Akros CZ' }],
          status: 'ready',
        }}
        employees={{ items: [], status: 'ready' }}
        onCreate={(command) =>
          Effect.sync(() => {
            created.push(command);
            return answer;
          })
        }
        onCreated={() => {
          events.push('created');
        }}
        onOpenChange={(open) => {
          events.push(open ? 'open' : 'closed');
        }}
        products={{ items: [], status: 'ready' }}
      />,
    );
  });
  await settle();
};

const buttons = (name: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.trim() === name);

const button = (name: string): HTMLButtonElement => Option.getOrThrow(Option.fromNullishOr(buttons(name).at(0)));

const field = (id: string): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`[id="${id}"]`)));

const act$ = async (run: () => void) => {
  await act(async () => {
    run();
  });
  await settle();
};

const typeInto = (id: string, value: string) =>
  act$(() => {
    const input = field(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

const fillIn = async () => {
  await act$(() => {
    Option.getOrThrow(
      Option.fromNullOr(document.querySelector<HTMLElement>(`[data-testid="partyId-${partyId}"]`)),
    ).click();
  });
  await typeInto('opportunity-title', copy.title);
  await typeInto('opportunity-close-date', copy.close);
};

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  created.length = 0;
  answer = 'saved';
});

afterEach(() => {
  for (const unmount of views.splice(0)) {
    unmount();
  }
  rstest.unstubAllGlobals();
});

describe('opportunity create panel with the shared Uložit', () => {
  it.live('typing sends nothing; one click on Uložit creates the opportunity once', () =>
    Effect.promise(async () => {
      const events: string[] = [];
      await mount(events);
      expect(buttons(labels.save)).toHaveLength(1);
      expect(button(labels.save).disabled).toBe(true);

      await fillIn();
      await act$(() => field('opportunity-title').form?.requestSubmit());
      expect(created).toEqual([]);

      await act$(() => button(labels.save).click());
      expect(created).toEqual([
        {
          _tag: 'CreateOpportunity',
          expectedCloseDate: copy.close,
          lines: [],
          note: '',
          partyId,
          title: copy.title,
        },
      ]);
      expect(events).toEqual(['created']);
    }),
  );

  it.live('an untouched panel closes without asking; typed input asks first', () =>
    Effect.promise(async () => {
      const events: string[] = [];
      await mount(events);
      await act$(() => button(copy.cancel).click());
      expect(buttons(labels.discard)).toHaveLength(0);
      expect(events).toEqual(['closed']);

      await typeInto('opportunity-title', copy.title);
      await act$(() => button(copy.cancel).click());
      expect(buttons(labels.discard)).toHaveLength(1);
      expect(events).toEqual(['closed']);
    }),
  );

  it.live('a refused create keeps the input and the panel open', () =>
    Effect.promise(async () => {
      answer = 'failed';
      const events: string[] = [];
      await mount(events);
      await fillIn();
      await act$(() => button(labels.save).click());
      expect(created).toHaveLength(1);
      expect(field('opportunity-title').value).toBe(copy.title);
      expect(events).toEqual([]);
      expect(document.querySelector<HTMLElement>('[data-save-state]')?.dataset.saveState).toBe('error');
    }),
  );
});
