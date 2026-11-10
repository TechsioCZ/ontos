// @rstest-environment happy-dom
// The invoice extras (manual payment, reminder) and the accounting setup send their one command only from the shared
// Save button ("Uložit"), last in the footer. Typing changes only the draft; an untouched form closes without asking.
// Only the i18n runtime and the router blocker are replaced.
import { Effect } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { AccountingSetupForm } from '../../src/routes/[lang]/finance/accounting-setup-form.tsx';
import type { FinanceViewModel } from '../../src/routes/[lang]/finance/finance-ui.tsx';
import { InvoicePaymentForm } from '../../src/routes/[lang]/finance/invoice-payment-form.tsx';
import { InvoiceReminderForm } from '../../src/routes/[lang]/finance/invoice-reminder-form.tsx';
import {
  clickCancel,
  clickDiscard,
  clickSave,
  fakeVm,
  invoiceFixture,
  lastFooterButton,
  leaveQuestion,
  mount,
  saveButton,
  typeInto,
  unmountAll,
  waitUntil,
} from './finance-form-harness.ts';

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ proceed: constVoid, reset: constVoid, status: 'idle' }),
}));

type Command = Parameters<FinanceViewModel['execute']>[0];

const invoice = invoiceFixture();
const smtp = { kind: 'ready', provider: { configured: true, label: null } } as const;
const closes: string[] = [];
const onClose = () => {
  closes.push('closed');
};

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  closes.length = 0;
});

afterEach(() => {
  unmountAll();
  rstest.unstubAllGlobals();
});

describe('invoice extras and accounting setup save from Uložit only', () => {
  it.live('a manual payment is recorded once by Uložit and the dialog closes', () =>
    Effect.gen(function* step1() {
      const sent: Command[] = [];
      yield* mount(<InvoicePaymentForm invoice={invoice} onClose={onClose} remaining={100_000} vm={fakeVm(sent)} />);
      expect(saveButton().disabled).toBe(true);
      expect(lastFooterButton()).toBe(saveButton());

      yield* typeInto('payment-amount', '400');
      yield* typeInto('payment-note', 'Platba převodem');
      expect(sent).toEqual([]);
      yield* clickSave;
      yield* waitUntil(() => closes.length === 1);
      expect(sent).toEqual([
        {
          _tag: 'RecordManualPayment',
          actorLabel: 'Jana Nováková',
          amountMinor: 40_000,
          invoiceRef: invoice.ref,
          note: 'Platba převodem',
          paidOn: '2026-10-20',
        },
      ]);
    }),
  );

  it.live('a payment over the remaining amount is never sent', () =>
    Effect.gen(function* step2() {
      const sent: Command[] = [];
      yield* mount(<InvoicePaymentForm invoice={invoice} onClose={onClose} remaining={100_000} vm={fakeVm(sent)} />);
      yield* typeInto('payment-amount', '5000');
      expect(saveButton().disabled).toBe(true);
      yield* clickSave;
      expect(sent).toEqual([]);
    }),
  );

  it.live('the suggested reminder text closes untouched; a typed recipient asks before leaving', () =>
    Effect.gen(function* step3() {
      const sent: Command[] = [];
      const props = { counterpartyName: 'Kavárna Dolce', invoice, issuerName: 'OntOS Demo s.r.o.', provider: smtp };
      yield* mount(<InvoiceReminderForm {...props} onClose={onClose} vm={fakeVm(sent)} />);
      yield* clickCancel;
      expect(closes).toEqual(['closed']);
      expect(leaveQuestion()).toBe(false);

      unmountAll();
      closes.length = 0;
      yield* mount(<InvoiceReminderForm {...props} onClose={onClose} vm={fakeVm(sent)} />);
      yield* typeInto('reminder-recipient', 'fakturace@kavarna.cz');
      yield* clickCancel;
      expect(leaveQuestion()).toBe(true);
      yield* clickDiscard;
      expect(closes).toEqual(['closed']);
      expect(sent).toEqual([]);
    }),
  );

  it.live('a reminder is recorded once by Uložit with the recipient and the suggested text', () =>
    Effect.gen(function* step4() {
      const sent: Command[] = [];
      yield* mount(
        <InvoiceReminderForm
          counterpartyName="Kavárna Dolce"
          invoice={invoice}
          issuerName="OntOS Demo s.r.o."
          onClose={onClose}
          provider={smtp}
          vm={fakeVm(sent)}
        />,
      );
      yield* typeInto('reminder-recipient', 'fakturace@kavarna.cz');
      expect(lastFooterButton()).toBe(saveButton());
      yield* clickSave;
      yield* waitUntil(() => closes.length === 1);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        _tag: 'RecordReminder',
        invoiceRef: invoice.ref,
        recipient: 'fakturace@kavarna.cz',
      });
    }),
  );

  it.live('the accounting setup is saved once by Uložit and the form closes', () =>
    Effect.gen(function* step5() {
      const sent: Command[] = [];
      yield* mount(
        <AccountingSetupForm
          onClose={onClose}
          vm={fakeVm(sent, { state: { accountingSetup: { product: 'POHODA' } } })}
        />,
      );
      expect(saveButton().disabled).toBe(true);
      yield* typeInto('setup-issuerIco', '12345678');
      yield* typeInto('setup-accountant', 'Eva Malá');
      yield* clickSave;
      yield* waitUntil(() => closes.length === 1);
      expect(sent).toEqual([
        {
          _tag: 'UpdateAccountingSetup',
          accountant: 'Eva Malá',
          actorLabel: 'Jana Nováková',
          issuerIco: '12345678',
          product: 'POHODA',
        },
      ]);
    }),
  );

  it.live('an accounting setup someone else changed meanwhile is refused as a conflict', () =>
    Effect.gen(function* step6() {
      const sent: Command[] = [];
      const rerender = yield* mount(
        <AccountingSetupForm
          onClose={onClose}
          vm={fakeVm(sent, { state: { accountingSetup: { product: 'POHODA' } } })}
        />,
      );
      yield* typeInto('setup-accountant', 'Eva Malá');
      // Someone else saved another accounting system; the page data now shows it.
      yield* rerender(
        <AccountingSetupForm
          onClose={onClose}
          vm={fakeVm(sent, { state: { accountingSetup: { product: 'Money S3' } } })}
        />,
      );
      yield* clickSave;
      yield* waitUntil(() => document.querySelector('[data-save-state="conflict"]') !== null);
      expect(sent).toEqual([]);
      expect(closes).toEqual([]);
    }),
  );
});
