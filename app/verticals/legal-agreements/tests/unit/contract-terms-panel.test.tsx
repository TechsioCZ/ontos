// @rstest-environment happy-dom
// The contract terms panel as the person sees it: one Save button in the panel footer, the draft's status next to it,
// and a question before unsaved changes are left. Only the generated clients, the i18n runtime and the router are
// replaced.
import { Effect, Option } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Contract } from '../../shared/apis/records.ts';
import { ContractTermsPanel } from '../../src/routes/[lang]/smlouvy/contract-terms.tsx';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

const { apply, records } = rstest.hoisted(() => ({ apply: rstest.fn(), records: rstest.fn() }));

rstest.mock('../../src/api/apply-command-action-client.ts', () => ({ executeApplyCommand: apply }));
rstest.mock('../../src/api/records-client.ts', () => ({ executeRecords: records }));
rstest.mock('@app/party-registry/api/client', () => ({
  executeCounterpartyRead: rstest.fn(),
  listCustomers: rstest.fn(),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
  useNavigate: () => () => {},
  useRouterState: () => '',
}));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));

const tenantId = '11111111-1111-4111-8111-111111111111';
const contractRef = {
  moduleId: 'legal.agreements',
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'legal.agreements.contract',
  tenantId,
} as const;
const contract: Contract = {
  contractRef,
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: '44444444-4444-4444-8444-444444444444',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  endDate: '2027-10-05',
  kind: 'LEASE',
  lifecycleState: 'ACTIVE',
  note: null,
  occupancyRef: null,
  propertyRef: null,
  renewalNoticeDate: null,
  rentTerms: { currency: 'CZK', monthlyRentMinor: 1_850_000, paymentDay: 15, serviceChargesMinor: 250_050 },
  responsiblePerson: 'Jana Nováková',
  signatureState: 'SIGNED',
  startDate: '2026-10-05',
  subject: 'Nájem kanceláře',
  supersedesContractRef: null,
  unitRef: null,
};

const sends = () => apply.mock.calls.length;

const settle = async (): Promise<void> => {
  await browserRuntime.runPromise(Effect.yieldNow);
};

interface View {
  readonly closed: string[];
  readonly unmount: () => void;
}

const views: View[] = [];

const mount = async (): Promise<View> => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const closed: string[] = [];
  await act(async () => {
    root.render(
      <ContractTermsPanel
        contract={contract}
        onClose={() => {
          closed.push('close');
        }}
        revision={4}
      />,
    );
    await settle();
  });
  let live = true;
  const view: View = {
    closed,
    unmount: () => {
      if (live) {
        live = false;
        act(() => {
          root.unmount();
          container.remove();
        });
      }
    },
  };
  views.push(view);
  return view;
};

const buttons = (name: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.trim() === name);

const button = (name: string): HTMLButtonElement => {
  const [found] = buttons(name);
  expect(found).toBeDefined();
  return found ?? document.createElement('button');
};

const field = (id: string): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`input[id="${id}"]`)));

/** Types like a person: React sees a native input event, then focus leaves the field. */
const type = async (id: string, value: string) => {
  await act(async () => {
    const input = field(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await settle();
  });
};

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

const notice = 'contract-terms-notice';
const close = 'legal-agreements.detail.close';

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  apply.mockReset();
  records.mockReset();
  apply.mockReturnValue(Effect.succeed({ resourceRef: contractRef, revision: 5 }));
});

afterEach(() => {
  for (const view of views) {
    view.unmount();
  }
  views.length = 0;
  rstest.unstubAllGlobals();
});

describe('contract terms panel with one Save button', () => {
  it.live('typing, waiting and closing the panel send nothing', () =>
    Effect.gen(function* typing() {
      const view = yield* Effect.promise(mount);
      expect(buttons('Uložit')).toHaveLength(1);
      expect(button('Uložit').disabled).toBe(true);
      expect(text()).not.toMatch(/automat/iu);

      yield* Effect.promise(() => type(notice, '3 měsíce'));
      expect(button('Uložit').disabled).toBe(false);
      expect(text()).toContain('Neuložené změny');
      yield* Effect.sleep('1 second');
      yield* Effect.promise(() => act(settle));
      expect(sends()).toBe(0);

      view.unmount();
      yield* Effect.sleep('1 second');
      expect(sends()).toBe(0);
    }),
  );

  it.effect('one click on Save sends the terms once and shows them saved', () =>
    Effect.gen(function* saveOnce() {
      yield* Effect.promise(mount);
      yield* Effect.promise(() => type(notice, '3 měsíce'));
      yield* Effect.promise(() => click(button('Uložit')));
      yield* Effect.promise(() => waitUntil(() => text().includes('Uloženo')));
      expect(sends()).toBe(1);
      expect(apply.mock.calls[0]?.[0]).toMatchObject({
        command: { _tag: 'SetContractTerms', noticePeriod: '3 měsíce' },
        expectedRevision: 4,
      });
      expect(button('Uložit').disabled).toBe(true);
    }),
  );

  it.effect('an invalid rent keeps Save disabled', () =>
    Effect.gen(function* invalid() {
      yield* Effect.promise(mount);
      yield* Effect.promise(() => type('contract-terms-monthly', 'hodně'));
      expect(button('Uložit').disabled).toBe(true);
      expect(sends()).toBe(0);
    }),
  );

  it.effect('closing with unsaved changes asks first; Zůstat keeps the draft, Zahodit změny closes unsaved', () =>
    Effect.gen(function* leave() {
      const view = yield* Effect.promise(mount);
      yield* Effect.promise(() => type(notice, '3 měsíce'));
      yield* Effect.promise(() => click(button(close)));
      expect(buttons('Zahodit změny')).toHaveLength(1);
      expect(view.closed).toEqual([]);

      yield* Effect.promise(() => click(button('Zůstat')));
      yield* Effect.promise(() => waitUntil(() => buttons('Zůstat').length === 0));
      expect(field(notice).value).toBe('3 měsíce');

      yield* Effect.promise(() => click(button(close)));
      yield* Effect.promise(() => click(button('Zahodit změny')));
      expect(view.closed).toEqual(['close']);
      expect(sends()).toBe(0);
    }),
  );

  it.effect('Uložit in the question saves once and then closes', () =>
    Effect.gen(function* saveAndLeave() {
      const view = yield* Effect.promise(mount);
      yield* Effect.promise(() => type(notice, '3 měsíce'));
      yield* Effect.promise(() => click(button(close)));
      const inDialog = buttons('Uložit').at(-1);
      expect(inDialog).toBeDefined();
      yield* Effect.promise(() => click(inDialog ?? document.createElement('button')));
      yield* Effect.promise(() => waitUntil(() => view.closed.length === 1));
      expect(sends()).toBe(1);
    }),
  );

  it.effect('an unchanged panel closes without asking', () =>
    Effect.gen(function* cleanLeave() {
      const view = yield* Effect.promise(mount);
      yield* Effect.promise(() => click(button(close)));
      expect(buttons('Zůstat')).toHaveLength(0);
      expect(view.closed).toEqual(['close']);
    }),
  );
});
