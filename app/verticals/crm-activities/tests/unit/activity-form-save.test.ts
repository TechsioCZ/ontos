// @rstest-environment happy-dom
// The activity form is savable only for a contact the current search found: a new search that no longer lists the
// chosen contact holds Uložit back, and one that lists it again releases it, without the user typing again. The
// generated clients, the router, the i18n runtime and the ui-kit select are replaced; the select by a native one.
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { Effect, Option } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import React, { act, createElement } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { RecordsPage } from '../../src/routes/[lang]/aktivity/page.tsx';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

/** The props the native stand-in of the ui-kit select reads. */
interface NativeSelectProps {
  readonly items: readonly { readonly label: string; readonly value: string }[];
  readonly onValueChange: (details: { readonly value: string[] }) => void;
  readonly value: readonly string[];
}

const { apply, counterparties, records, selectPart, workRecords } = rstest.hoisted(() => ({
  apply: rstest.fn(),
  counterparties: rstest.fn(),
  records: rstest.fn(),
  // The parts of the select only pass their children through.
  selectPart: { render: ({ children }: { readonly children?: ReactNode }) => children ?? null },
  workRecords: rstest.fn(),
}));

rstest.mock('../../src/api/records-consumer.ts', () => ({ executeRecords: records }));
rstest.mock('../../src/api/apply-command-action-client.ts', () => ({ executeApplyCommand: apply }));
rstest.mock('@app/work-tasks/clients/records', () => ({ executeRecords: workRecords }));
rstest.mock('@app/party-registry/api/client', () => ({
  executeCounterpartyRead: rstest.fn(),
  loadCounterpartiesClient: counterparties,
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
  useRouterState: () => '',
}));
rstest.mock('../../src/routes/ultramodern-route-head', () => ({ UltramodernRouteHead: () => null }));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  FederatedI18nBoundary: ({ children }: { readonly children: ReactNode }) => children,
  useModernI18n: () => ({ language: 'cs', t: String }),
}));
// A native select in place of the ui-kit one: same items, same value, same change callback.
rstest.mock('@techsio/ui-kit/molecules/select', () => ({
  Select: Object.assign(
    ({ items, onValueChange, value }: NativeSelectProps) =>
      createElement(
        'select',
        {
          'data-native-select': '',
          onChange: (event: { readonly target: { readonly value: string } }) =>
            onValueChange({ value: event.target.value === '' ? [] : [event.target.value] }),
          value: value[0] ?? '',
        },
        createElement('option', { value: '' }, '—'),
        ...items.map((item) => createElement('option', { key: item.value, value: item.value }, item.label)),
      ),
    {
      Content: selectPart.render,
      Control: selectPart.render,
      Item: selectPart.render,
      ItemText: selectPart.render,
      Label: selectPart.render,
      Positioner: selectPart.render,
      Trigger: selectPart.render,
      ValueText: selectPart.render,
    },
  ),
}));

const tenantId = '70000000-0000-4000-8000-000000000020';
const props: ModulePageProps = {
  context: { legalEntityId: 'company-a', principalId: 'seller-a', tenantId },
  routeParams: {},
  search: '',
};
const key = 'crm-activities.pages.records';
const dolce = {
  party: { title: 'Kavárna Dolce' },
  ref: { resourceId: '44444444-4444-4444-8444-444444444444', tenantId },
};
const other = {
  party: { title: 'Pekárna Novák' },
  ref: { resourceId: '55555555-5555-4555-8555-555555555555', tenantId },
};

const settle = async (): Promise<void> => {
  await act(async () => {
    await browserRuntime.runPromise(Effect.yieldNow);
  });
};

const waitUntil = async (condition: () => boolean, attempt = 0): Promise<void> => {
  if (condition() || attempt >= 400) {
    expect(condition()).toBe(true);
    return;
  }
  await settle();
  await waitUntil(condition, attempt + 1);
};

const element = <E extends Element>(selector: string): E =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<E>(selector)));

const buttonNamed = (name: string): HTMLButtonElement =>
  Option.getOrThrow(
    Option.fromUndefinedOr(
      [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === name),
    ),
  );

/** Types like a user: React sees a native input event. */
const typeInto = async (selector: string, value: string) => {
  await act(async () => {
    const input = element<HTMLInputElement>(selector);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
};

/** Searches the contacts; the search answers with `found`. */
const search = async (query: string, found: readonly (typeof dolce)[]) => {
  counterparties.mockReturnValue(Effect.succeed(found));
  await typeInto('#counterparty-query', query);
  await act(async () => {
    buttonNamed(`${key}.find`).click();
  });
  await settle();
};

const chooseContact = async (resourceId: string) => {
  await act(async () => {
    const select = element<HTMLSelectElement>('[data-native-select]');
    select.value = resourceId;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
};

const saveButton = () => buttonNamed('Uložit');

const unmounts: (() => void)[] = [];

beforeEach(() => {
  // The owner's Node-only test config compiles TSX with the classic React runtime.
  rstest.stubGlobal('React', React);
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  for (const mock of [apply, counterparties, records, workRecords]) {
    mock.mockReset();
  }
  records.mockReturnValue(
    Effect.succeed({
      actorPrincipalRef: { principalId: '72000000-0000-4000-8000-000000000021', tenantId },
      canWrite: true,
      items: [],
      revision: 3,
    }),
  );
  workRecords.mockReturnValue(Effect.succeed({ items: [] }));
});

afterEach(() => {
  for (const unmount of unmounts.splice(0)) {
    unmount();
  }
  rstest.unstubAllGlobals();
});

describe('the activity form', () => {
  it.live('follows the contact search: Uložit is held back while the chosen contact is not listed', () =>
    Effect.promise(async () => {
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      unmounts.push(() => {
        act(() => {
          root.unmount();
        });
        container.remove();
      });
      await act(async () => {
        root.render(createElement(RecordsPage, props));
      });
      await waitUntil(() => document.querySelector('#activity-summary') !== null);

      await search('Dolce', [dolce]);
      await chooseContact(dolce.ref.resourceId);
      await typeInto('#activity-summary', 'Domluvena ochutnávka');
      expect(saveButton().disabled).toBe(false);

      // Another search that does not list the chosen contact: nothing typed, yet the draft cannot be sent.
      await search('Novák', [other]);
      await waitUntil(() => saveButton().disabled);

      // Listed again: savable again.
      await search('Dolce', [dolce, other]);
      await waitUntil(() => !saveButton().disabled);
      expect(apply).not.toHaveBeenCalled();
    }),
  );
});
