// @rstest-environment happy-dom
// The create forms (recurring template, received invoice, new invoice) create their record only from the shared Save
// button ("Uložit"), last in the footer: typing changes only the draft, an untouched form closes without asking, and
// typed input asks before it is left. Only the i18n runtime, the router blocker and the two pickers are replaced.
import { Effect, Predicate } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { baselineVatChoices } from '../support/finance-tax-rates.ts';
import { createElement } from 'react';
import { CreateInvoiceDialog } from '../../src/routes/[lang]/finance/create-invoice-dialog.tsx';
import type { FinanceViewModel } from '../../src/routes/[lang]/finance/finance-ui.tsx';
import { IncomingInvoiceDialog } from '../../src/routes/[lang]/finance/incoming-invoice-dialog.tsx';
import { RecurringTemplateEditor } from '../../src/routes/[lang]/finance/recurring-template-form.tsx';
import type { DraftInvoiceInput } from '../../src/routes/[lang]/finance/use-finance-records.ts';
import {
  clickCancel,
  clickDiscard,
  clickSave,
  fakeVm,
  invoiceFixture,
  lastFooterButton,
  leaveQuestion,
  mount,
  pick,
  pressEnter,
  saveButton,
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
// Tax answers with the company's baseline rates: 21 % standard and 12 % reduced.
rstest.mock('../../src/routes/[lang]/finance/use-vat-choices.ts', () => ({
  choicesOf: (vat: { readonly choices?: unknown }) => vat.choices,
  useVatChoices: () => ({
    choices: baselineVatChoices('00000000-0000-4000-8000-0000000000aa', '2026-10-05'),
    state: 'ready',
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

type Command = Parameters<FinanceViewModel['execute']>[0];

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

const CREATED = 'finance-billing.faktury.form.created';

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

describe('create forms save from Uložit only', () => {
  it.live('a recurring template is created once by Uložit; its suggested values close without asking', () =>
    Effect.gen(function* step1() {
      const sent: Command[] = [];
      const vm = withCustomer(fakeVm(sent));
      const left: string[] = [];
      const onClose = () => {
        left.push('closed');
      };
      yield* mount(<RecurringTemplateEditor onClose={onClose} vm={vm} />);
      yield* clickCancel;
      expect(left).toEqual(['closed']);

      unmountAll();
      left.length = 0;
      yield* mount(<RecurringTemplateEditor onClose={onClose} vm={vm} />);
      yield* pick('finance-billing.financeUi.recurring.tenant');
      yield* typeInto('template-name', 'Nájem kavárna');
      yield* typeInto('template-amount', '18 000');
      expect(lastFooterButton()).toBe(saveButton());
      yield* clickSave;
      yield* waitUntil(() => left.length === 1);
      expect(sent).toHaveLength(1);
      expect(Predicate.isTagged(sent[0], 'CreateRecurringTemplate')).toBe(true);
      expect(sent[0]).toMatchObject({ dueDays: 14, issueDay: 1, name: 'Nájem kavárna', partyId: customer.partyId });
    }),
  );

  it.live('a received invoice is recorded once by Uložit; typed input asks before leaving', () =>
    Effect.gen(function* step2() {
      const sent: Command[] = [];
      yield* mount(<IncomingInvoiceDialog onOpenChange={onOpenChange} open vm={fakeVm(sent)} />);
      expect(saveButton().disabled).toBe(true);
      yield* typeInto('incoming-supplier', 'ČEZ Prodej');
      yield* clickCancel;
      expect(leaveQuestion()).toBe(true);
      yield* clickDiscard;
      expect(closes).toEqual([false]);
      expect(sent).toEqual([]);

      unmountAll();
      closes.length = 0;
      yield* mount(<IncomingInvoiceDialog onOpenChange={onOpenChange} open vm={fakeVm(sent)} />);
      yield* typeInto('incoming-supplier', 'ČEZ Prodej');
      yield* typeInto('incoming-number', 'ZF-2026-77');
      yield* typeInto('invoice-line-description-incoming-line-1', 'Elektřina říjen');
      yield* typeInto('invoice-line-price-incoming-line-1', '1000');
      expect(lastFooterButton()).toBe(saveButton());
      yield* clickSave;
      yield* waitUntil(() => closes.length === 1);
      expect(sent).toHaveLength(1);
      expect(Predicate.isTagged(sent[0], 'RecordIncomingInvoice')).toBe(true);
      expect(sent[0]).toMatchObject({ documentNumber: 'ZF-2026-77', supplierName: 'ČEZ Prodej', totalMinor: 121_000 });
    }),
  );

  it.live('a new invoice draft is created once by Uložit; the untouched form closes without asking', () =>
    Effect.gen(function* step3() {
      const sent: Command[] = [];
      const drafts: DraftInvoiceInput[] = [];
      const vm = withCustomer({
        ...fakeVm(sent),
        createDraft: (input: DraftInvoiceInput) =>
          Effect.sync(() => {
            drafts.push(input);
            return { invoice, ok: true } as const;
          }),
      });
      yield* mount(<CreateInvoiceDialog onOpenChange={onOpenChange} open vm={vm} />);
      yield* clickCancel;
      expect(closes).toEqual([false]);
      expect(leaveQuestion()).toBe(false);

      unmountAll();
      closes.length = 0;
      yield* mount(<CreateInvoiceDialog onOpenChange={onOpenChange} open vm={vm} />);
      yield* fillInvoice('1000');
      expect(lastFooterButton()).toBe(saveButton());
      yield* pressEnter('invoice-line-description-line-1');
      expect(drafts).toEqual([]);
      yield* clickSave;
      yield* waitUntil(() => closes.length === 1);
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({ customer: { partyId: customer.partyId }, documentKind: 'STANDARD' });
      expect(toasts.map((toast) => toast.title)).toEqual([CREATED]);
    }),
  );
});
