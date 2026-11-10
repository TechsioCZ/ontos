// Mounts one finance form under happy-dom and drives it the way a person does: type, Uložit, Zrušit. The test files
// replace the i18n runtime, the router blocker and the two pickers; everything else is the real form.
import { saveLabelsFor } from '@app/admin-ui';
import { DateTime, Effect, Option } from 'effect';
import { constVoid } from 'effect/Function';
import { expect } from 'effect-rstest';
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Invoice } from '../../shared/apis/records.ts';
import type { FinanceViewModel } from '../../src/routes/[lang]/finance/finance-ui.tsx';

export const labels = saveLabelsFor('cs');
export const CANCEL_KEY = 'finance-billing.financeUi.common.cancel';

const tenantId = 'c0000000-0000-4000-8000-000000000001';
const now = DateTime.makeUnsafe('2026-10-20T08:00:00Z');

export const invoiceFixture = (overrides: Partial<Invoice> = {}): Invoice => ({
  accountingCorrelation: 'acc-invoice-1',
  accountingSyncState: 'NOT_SYNCED',
  businessState: 'CONFIRMED',
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: 'c0000000-0000-4000-8000-000000000012',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  createdAt: now,
  currency: 'CZK',
  direction: 'OUTGOING',
  documentNumber: 'FV-2026-001',
  dueDate: '2026-10-30',
  issueDate: '2026-10-01',
  paidMinor: 0,
  paymentState: 'UNPAID',
  ref: {
    moduleId: 'finance.billing',
    resourceId: 'c0000000-0000-4000-8000-000000000021',
    resourceType: 'finance.billing.invoice',
    tenantId,
  },
  totalMinor: 100_000,
  updatedAt: now,
  ...overrides,
});

type Snapshot = NonNullable<FinanceViewModel['snapshot']>;
type Command = Parameters<FinanceViewModel['execute']>[0];

/** A required view-model member whose value is intentionally absent; the forms never read it. */
const absent = <Value>(): Value | undefined => undefined;

const indicators = {
  costMinor: 0,
  costVarianceMinor: 0,
  draftCount: 0,
  grossOutstandingMinor: 0,
  openIncomingInvoices: 0,
  openInvoices: 0,
  openOutgoingInvoices: 0,
  overdueInvoices: 0,
  payablesOutstandingMinor: 0,
  plannedCostMinor: 0,
  plannedRevenueMinor: 0,
  receivablesOutstandingMinor: 0,
  revenueMinor: 0,
  revenueVarianceMinor: 0,
};

const unavailableName = (): undefined => {
  // Rental object labels are not loaded in these tests.
};

/** The page's view model as the forms see it; every command it executes is recorded in `sent`. */
export const fakeVm = (
  sent: Command[],
  overrides: Partial<FinanceViewModel> & { readonly state?: Partial<Snapshot['state']> } = {},
): FinanceViewModel => {
  const { state, ...rest } = overrides;
  return {
    actorLabel: 'Jana Nováková',
    busy: false,
    cancelConfirm: constVoid,
    cancelVoid: constVoid,
    canWrite: true,
    closeDetail: constVoid,
    closeDocumentDetail: constVoid,
    confirmInvoice: constVoid,
    confirmPending: constVoid,
    confirmTarget: absent<Invoice>(),
    confirmVoid: constVoid,
    createDraft: () => Effect.succeed({ feedback: 'unavailable', ok: false }),
    detailConflict: false,
    documentId: absent<NonNullable<FinanceViewModel['documentId']>>(),
    execute: (command: Command) =>
      Effect.sync(() => {
        sent.push(command);
        return { invoice: invoiceFixture(), ok: true } as const;
      }),
    feedback: 'ready',
    fetchDocument: () => Effect.succeed(Option.none()),
    indicators,
    invoiceDetail: absent<NonNullable<FinanceViewModel['invoiceDetail']>>(),
    invoices: [],
    objects: {
      available: false,
      contractName: unavailableName,
      contracts: [],
      properties: [],
      propertyName: unavailableName,
      unitName: unavailableName,
      units: [],
    },
    openDetail: constVoid,
    referenceDate: '2026-10-20',
    references: {
      customerById: new Map(),
      customers: [],
      customersLoading: false,
      opportunitiesForbidden: false,
      opportunityTitles: new Map(),
      products: [],
      productsReadable: false,
      referencesFailed: false,
    },
    relatedCustomer: false,
    reload: constVoid,
    requestVoid: constVoid,
    selected: absent<Invoice>(),
    snapshot: {
      canWrite: true,
      indicators,
      referenceDate: '2026-10-05',
      revision: 1,
      state: { financialPlanEntries: [], invoices: [], ...state },
    },
    t: String,
    voidTarget: absent<Invoice>(),
    ...rest,
  };
};

/** Lets the form's running saves finish, then flushes React's updates. */
const settle: Effect.Effect<void> = Effect.sleep('5 millis').pipe(
  Effect.andThen(
    Effect.sync(() => {
      act(constVoid);
    }),
  ),
);

/** Runs `step` inside React's act, then lets what it started settle. */
const acted = (step: () => void): Effect.Effect<void> =>
  Effect.sync(() => {
    act(() => {
      step();
    });
  }).pipe(Effect.andThen(settle));

const unmounts: (() => void)[] = [];

/** Mounts `element` and returns how to render it again with other props; `unmountAll` removes it after the test. */
export const mount = (element: ReactElement): Effect.Effect<(next: ReactElement) => Effect.Effect<void>> =>
  Effect.suspend(() => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    unmounts.push(() => {
      act(() => root.unmount());
      container.remove();
    });
    const render = (next: ReactElement) => acted(() => root.render(next));
    return render(element).pipe(Effect.as(render));
  });

export const unmountAll = (): void => {
  for (const unmount of unmounts.splice(0)) {
    unmount();
  }
};

const buttons = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>('button')];
const named = (text: string) => buttons().filter((button) => (button.textContent ?? '').trim() === text);

/** The form's own Save button, not the one of the leave question. */
export const saveButton = (): HTMLButtonElement =>
  Option.getOrThrow(
    Option.fromNullishOr(named(labels.save).find((button) => button.closest('[role="alertdialog"]') === null)),
  );

/** The control that comes last in the footer that holds the Save button. */
export const lastFooterButton = (): HTMLButtonElement | undefined => {
  const footer = saveButton().parentElement?.parentElement;
  return [...(footer?.querySelectorAll<HTMLButtonElement>('button') ?? [])].at(-1);
};

const field = (id: string): HTMLInputElement | HTMLTextAreaElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[id="${id}"]`)));

export const typeInto = (id: string, value: string): Effect.Effect<void> =>
  acted(() => {
    const input = field(id);
    const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

export const pressEnter = (id: string): Effect.Effect<void> => acted(() => field(id).form?.requestSubmit());

const click = (find: () => HTMLButtonElement): Effect.Effect<void> => acted(() => find().click());

export const clickSave: Effect.Effect<void> = click(saveButton);

export const clickCancel: Effect.Effect<void> = click(() =>
  Option.getOrThrow(Option.fromNullishOr(named(CANCEL_KEY).at(-1))),
);

/** Zahodit změny in the leave question. */
export const clickDiscard: Effect.Effect<void> = click(() =>
  Option.getOrThrow(Option.fromNullishOr(named(labels.discard).at(-1))),
);

/** Picks the first item of the (replaced) picker whose label is `label`. */
export const pick = (label: string): Effect.Effect<void> =>
  click(() =>
    Option.getOrThrow(Option.fromNullishOr(document.querySelector<HTMLButtonElement>(`button[data-pick="${label}"]`))),
  );

/** Whether the Uložit / Zahodit změny / Zůstat question is up. */
export const leaveQuestion = (): boolean =>
  [...document.querySelectorAll('[role="alertdialog"]')].some((dialog) =>
    (dialog.textContent ?? '').includes(labels.leaveTitle),
  );

/** Lets the form work until `condition` holds; fails the test when it never does. */
export const waitUntil = (condition: () => boolean, attempt = 0): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (condition() || attempt >= 200) {
      return Effect.sync(() => {
        expect(condition()).toBe(true);
      });
    }
    return settle.pipe(Effect.andThen(waitUntil(condition, attempt + 1)));
  });
