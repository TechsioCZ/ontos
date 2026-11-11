// @rstest-environment happy-dom
// The new invoice form keeps the safeguards of its old button behind the shared Uložit: a 0 Kč line needs a second,
// deliberate Uložit, a failed create keeps the input and shows the error toast, and a draft sent for approval is
// announced and closes the panel. Only the i18n runtime, the router blocker, the toaster and the two pickers are
// replaced.
import { requiredLabelFor } from '@app/admin-ui';
import { Effect } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { createElement } from 'react';
import { CreateInvoiceDialog } from '../../src/routes/[lang]/finance/create-invoice-dialog.tsx';
import type { FinanceViewModel } from '../../src/routes/[lang]/finance/finance-ui.tsx';
import type { DraftInvoiceInput, DraftInvoiceOutcome } from '../../src/routes/[lang]/finance/use-finance-records.ts';
import {
  clickCancel,
  clickSave,
  fakeVm,
  invoiceFixture,
  leaveQuestion,
  mount,
  pick,
  typeInto,
  unmountAll,
  waitUntil,
} from './finance-form-harness.ts';

interface Toast {
  readonly title?: unknown;
  readonly type?: unknown;
}
const { toasts } = rstest.hoisted(() => {
  const recorded: Toast[] = [];
  return { toasts: recorded };
});
// The toaster records what the forms announce.
rstest.mock('@techsio/ui-kit/molecules/toast', () => ({
  Toaster: () => null,
  toaster: { attrs: {} },
  useToast: () => ({
    create: (toast: { readonly title?: unknown; readonly type?: unknown }) => {
      toasts.push({ title: toast.title, type: toast.type });
    },
    dismiss: constVoid,
  }),
}));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ proceed: constVoid, reset: constVoid, status: 'idle' }),
}));
// The pickers: one button that picks the first item; its `data-pick` names the field.
rstest.mock('@app/admin-ui/select-template', () => ({
  SelectTemplate: (props: {
    readonly items: readonly { readonly value: string }[];
    readonly label?: unknown;
    readonly onValueChange?: (details: { readonly value: string[] }) => void;
  }) =>
    createElement('button', {
      'data-pick': String(props.label),
      onClick: () => props.onValueChange?.({ value: props.items.slice(0, 1).map((item) => item.value) }),
      type: 'button',
    }),
}));
rstest.mock('@techsio/ui-kit/molecules/combobox', () => ({
  Combobox: (props: {
    readonly items: readonly { readonly value: string }[];
    readonly label?: unknown;
    readonly onChange: (values: string[]) => void;
  }) =>
    createElement('button', {
      'data-pick': String(props.label),
      onClick: () => props.onChange(props.items.slice(0, 1).map((item) => item.value)),
      type: 'button',
    }),
}));

const invoice = invoiceFixture();
const { tenantId } = invoice.ref;
const customer: FinanceViewModel['references']['customers'][number] = {
  city: null,
  companyId: '12345678',
  counterpartyId: 'c0000000-0000-4000-8000-000000000012',
  counterpartyRef: invoice.counterpartyRef,
  createdAt: '2026-10-01T08:00:00.000Z',
  displayName: 'Kavárna Dolce',
  email: null,
  partyId: 'c0000000-0000-4000-8000-000000000013',
  partyRef: {
    moduleId: 'party.registry',
    resourceId: 'c0000000-0000-4000-8000-000000000013',
    resourceType: 'party.registry.party',
    tenantId,
  },
  partyRevision: 1,
  phone: null,
  status: 'ACTIVE',
  vatId: null,
};

const withCustomer = (vm: FinanceViewModel): FinanceViewModel => ({
  ...vm,
  references: { ...vm.references, customers: [customer] },
});

const closes: boolean[] = [];
const onOpenChange = (open: boolean) => {
  closes.push(open);
};

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  closes.length = 0;
  toasts.length = 0;
});

const ZERO_PRICE = 'finance-billing.faktury.form.zeroPriceConfirm';
const CREATE_FAILED = 'finance-billing.faktury.form.createFailed';
const PENDING_APPROVAL = 'finance-billing.demo.feedback.pendingApproval';

/** A view model whose `createDraft` records each draft and answers `outcome`. */
const draftVm = (drafts: DraftInvoiceInput[], outcome: () => DraftInvoiceOutcome): FinanceViewModel =>
  withCustomer({
    ...fakeVm([]),
    createDraft: (input: DraftInvoiceInput) =>
      Effect.sync(() => {
        drafts.push(input);
        return outcome();
      }),
  });

const fillInvoice = (price: string) =>
  Effect.gen(function* fill() {
    yield* pick('finance-billing.faktury.form.customer');
    yield* typeInto('invoice-line-description-line-1', 'Pronájem kavárny');
    yield* typeInto('invoice-line-price-line-1', price);
  });

afterEach(() => {
  unmountAll();
  rstest.unstubAllGlobals();
});

describe('new invoice safeguards', () => {
  it.live('reads the required text of a required field in Czech', () =>
    Effect.gen(function* requiredText() {
      const drafts: DraftInvoiceInput[] = [];
      yield* mount(
        <CreateInvoiceDialog onOpenChange={onOpenChange} open vm={draftVm(drafts, () => ({ invoice, ok: true }))} />,
      );
      expect(document.body.textContent).toContain(requiredLabelFor('cs'));
      expect(document.body.textContent).not.toContain('(required)');
      const issueDateLabel = [...document.querySelectorAll('label')].find((label) =>
        label.textContent?.includes('finance-billing.faktury.form.issueDate'),
      );
      expect(issueDateLabel?.textContent ?? '').toContain(requiredLabelFor('cs'));
    }),
  );

  it.live('a 0 Kč line needs a second Uložit: the first only warns, a changed line asks again', () =>
    Effect.gen(function* zeroPrice() {
      const drafts: DraftInvoiceInput[] = [];
      yield* mount(
        <CreateInvoiceDialog onOpenChange={onOpenChange} open vm={draftVm(drafts, () => ({ invoice, ok: true }))} />,
      );
      yield* fillInvoice('0');
      expect(document.body.textContent).not.toContain(ZERO_PRICE);
      yield* clickSave;
      expect(drafts).toEqual([]);
      expect(document.body.textContent).toContain(ZERO_PRICE);

      yield* typeInto('invoice-line-description-line-1', 'Dárek');
      expect(document.body.textContent).not.toContain(ZERO_PRICE);
      yield* clickSave;
      expect(drafts).toEqual([]);
      yield* clickSave;
      yield* waitUntil(() => closes.length === 1);
      expect(drafts).toHaveLength(1);
    }),
  );

  it.live('a failed create keeps the form and its input and shows the error toast', () =>
    Effect.gen(function* failed() {
      const drafts: DraftInvoiceInput[] = [];
      yield* mount(
        <CreateInvoiceDialog
          onOpenChange={onOpenChange}
          open
          vm={draftVm(drafts, () => ({ feedback: 'unavailable', ok: false }))}
        />,
      );
      yield* fillInvoice('1000');
      yield* clickSave;
      yield* waitUntil(() => toasts.length === 1);
      expect(toasts[0]).toMatchObject({ title: CREATE_FAILED, type: 'error' });
      expect(closes).toEqual([]);
      expect(drafts).toHaveLength(1);
      yield* clickCancel;
      expect(leaveQuestion()).toBe(true);
    }),
  );

  it.live('a draft sent for approval announces it and closes the panel', () =>
    Effect.gen(function* proposed() {
      const drafts: DraftInvoiceInput[] = [];
      yield* mount(
        <CreateInvoiceDialog
          onOpenChange={onOpenChange}
          open
          vm={draftVm(drafts, () => ({ feedback: 'pendingApproval', ok: false }))}
        />,
      );
      yield* fillInvoice('1000');
      yield* clickSave;
      yield* waitUntil(() => closes.length === 1);
      expect(closes).toEqual([false]);
      expect(toasts).toEqual([{ title: PENDING_APPROVAL, type: 'info' }]);
      expect(drafts).toHaveLength(1);
    }),
  );
});
