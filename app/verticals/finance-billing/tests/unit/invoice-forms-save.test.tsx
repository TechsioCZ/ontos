// @rstest-environment happy-dom
// The real forms, router, translations and finance hook send saves through the owner's HTTP contracts.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder, HttpRouter, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Option, Predicate, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { useEffect } from 'react';
import type { ReactElement } from 'react';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import { InvoiceSchema, RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { AccountingSetupForm } from '../../src/routes/[lang]/finance/accounting-setup-form.tsx';
import type { FinanceViewModel } from '../../src/routes/[lang]/finance/finance-ui.tsx';
import { InvoicePaymentForm } from '../../src/routes/[lang]/finance/invoice-payment-form.tsx';
import { InvoiceReminderForm } from '../../src/routes/[lang]/finance/invoice-reminder-form.tsx';
import { useFinanceRecords } from '../../src/routes/[lang]/finance/use-finance-records.ts';
import { moduleText, mountInRoute } from '../support/module-ui.ts';
import { invoiceFixture } from './finance-form-harness.ts';

type Command = Parameters<FinanceViewModel['execute']>[0];
const czech = moduleText('cs');
const labels = saveLabelsFor('cs');
const REVIEW_BACK = czech('finance-billing.financeUi.payments.reviewBack');
const REVIEW_CONFIRM = czech('finance-billing.financeUi.payments.reviewConfirm');
const REMINDER_BACK = czech('finance-billing.financeUi.reminders.reviewBack');
const REMINDER_CONFIRM = czech('finance-billing.financeUi.reminders.reviewConfirm');
const paymentReview = () => document.querySelector('[data-testid="payment-review"]') !== null;
const reminderReview = () => document.querySelector('[data-testid="reminder-review"]')?.textContent ?? undefined;
const invoice = invoiceFixture();
const smtp = { kind: 'ready', provider: { configured: true, label: null } } as const;
const closes: string[] = [];
const sent: Command[] = [];
const onClose = () => {
  closes.push('closed');
};

const recordsAt = (product: string) =>
  Schema.decodeUnknownSync(RecordsResponseSchema)({
    businessDate: '2026-10-20',
    canWrite: true,
    indicators: {
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
    },
    referenceDate: '2026-10-05',
    revision: 1,
    state: {
      accountingSetup: { product },
      financialPlanEntries: [],
      invoices: [Schema.encodeSync(InvoiceSchema)(invoice)],
    },
  });
let records = recordsAt('POHODA');
const committed = Schema.decodeUnknownSync(ApplyCommandResultSchema)({ changed: true, revision: 2 });
const ActionApi = ApplyCommandActionApi.prefix('/finance-billing-api');
const LedgerApi = RecordsApi.prefix('/finance-billing-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'finance-billing': '/finance-billing-api' }).application,
  HttpRouter.add(
    'GET',
    '/shell-super-app-api/auth/session',
    Effect.succeed(HttpServerResponse.jsonUnsafe({ identity: { displayName: 'Jana Nováková' } })),
  ),
  serveApi(
    ActionApi,
    HttpApiBuilder.group(ActionApi, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          sent.push(payload.command);
          return committed;
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
  serveApi(
    LedgerApi,
    HttpApiBuilder.group(LedgerApi, 'records', (group) => group.handle('execute', () => Effect.sync(() => records))),
  ),
);

let latest: FinanceViewModel | null = null;
let scopeNumber = 0;
const current = () => Option.getOrThrow(Option.fromNullOr(latest));
const FormHarness = ({
  render,
  scope,
}: {
  readonly render: (vm: FinanceViewModel) => ReactElement;
  readonly scope: string;
}) => {
  const vm = useFinanceRecords({ scope });
  useEffect(() => {
    latest = vm;
  }, [vm]);
  return vm.canWrite && vm.actorLabel !== undefined ? render(vm) : null;
};
const mount = (render: (vm: FinanceViewModel) => ReactElement) =>
  Effect.gen(function* mountForm() {
    yield* pinTestDocument;
    scopeNumber += 1;
    latest = null;
    yield* mountInRoute(<FormHarness render={render} scope={`invoice-forms-save-${scopeNumber}`} />, {
      language: 'cs',
      path: 'finance',
      url: '/cs/finance',
    });
    yield* waitUntil(() => document.querySelector('input') !== null);
  });
const clickNamed = (name: string) =>
  acted(() => Option.getOrThrow(Option.fromUndefinedOr(buttons(name).at(-1))).click());
const saveButton = () =>
  Option.getOrThrow(
    Option.fromUndefinedOr(buttons(labels.save).find((button) => button.closest('[role="alertdialog"]') === null)),
  );
const clickSave = acted(() => saveButton().click());
const clickCancel = clickNamed(czech('finance-billing.financeUi.common.cancel'));
const leaveQuestion = () =>
  [...document.querySelectorAll('[role="alertdialog"]')].some((dialog) =>
    (dialog.textContent ?? '').includes(labels.leaveTitle),
  );
const typeInto = (id: string, value: string) =>
  acted(() => {
    const input = Option.getOrThrow(
      Option.fromNullOr(document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[id="${id}"]`)),
    );
    const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
beforeEach(() => {
  closes.length = 0;
  sent.length = 0;
  records = recordsAt('POHODA');
});
afterEach(unmountAll);

it.layer(network, { excludeTestServices: true })(
  'invoice extras and accounting setup save from Uložit only',
  (suite) => {
    suite.effect(
      'Uložit opens the payment review; only its confirmation records the payment once, then the dialog closes',
      () =>
        Effect.gen(function* step1() {
          yield* mount((vm) => <InvoicePaymentForm invoice={invoice} onClose={onClose} remaining={100_000} vm={vm} />);
          expect(saveButton().disabled).toBe(true);

          yield* typeInto('payment-amount', '400');
          yield* typeInto('payment-note', 'Platba převodem');
          yield* networkIdle;
          expect(sent).toEqual([]);
          yield* clickSave;
          expect(paymentReview()).toBe(true);
          yield* networkIdle;
          expect(sent).toEqual([]);
          yield* clickNamed(REVIEW_BACK);
          expect(paymentReview()).toBe(false);
          yield* networkIdle;
          expect(sent).toEqual([]);

          yield* clickSave;
          yield* clickNamed(REVIEW_CONFIRM);
          yield* waitUntil(() => closes.length === 1);
          yield* networkIdle;
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

    suite.effect('Uložit in the leave question opens the review too; nothing is recorded before it is confirmed', () =>
      Effect.gen(function* reviewOnLeave() {
        yield* mount((vm) => <InvoicePaymentForm invoice={invoice} onClose={onClose} remaining={100_000} vm={vm} />);
        yield* typeInto('payment-amount', '250');
        yield* clickCancel;
        expect(leaveQuestion()).toBe(true);
        yield* clickNamed(labels.save);
        expect(leaveQuestion()).toBe(false);
        expect(paymentReview()).toBe(true);
        yield* networkIdle;
        expect(sent).toEqual([]);
        yield* clickNamed(REVIEW_CONFIRM);
        yield* waitUntil(() => closes.length === 1);
        yield* networkIdle;
        expect(sent).toHaveLength(1);
        expect(Predicate.isTagged(sent[0], 'RecordManualPayment')).toBe(true);
        expect(sent[0]).toMatchObject({ amountMinor: 25_000 });
      }),
    );

    suite.effect('a payment over the remaining amount is never sent', () =>
      Effect.gen(function* step2() {
        yield* mount((vm) => <InvoicePaymentForm invoice={invoice} onClose={onClose} remaining={100_000} vm={vm} />);
        yield* typeInto('payment-amount', '5000');
        expect(saveButton().disabled).toBe(true);
        yield* clickSave;
        yield* networkIdle;
        expect(sent).toEqual([]);
      }),
    );

    suite.effect(
      'Uložit opens a review naming the recipient; only its confirmation sends the reminder e-mail once',
      () =>
        Effect.gen(function* step4() {
          yield* mount((vm) => (
            <InvoiceReminderForm
              counterpartyName="Kavárna Dolce"
              invoice={invoice}
              issuerName="OntOS Demo s.r.o."
              onClose={onClose}
              provider={smtp}
              vm={vm}
            />
          ));
          yield* typeInto('reminder-recipient', 'fakturace@kavarna.cz');

          yield* clickSave;
          expect(reminderReview()).toContain('fakturace@kavarna.cz');
          yield* networkIdle;
          expect(sent).toEqual([]);
          yield* clickNamed(REMINDER_BACK);
          expect(reminderReview()).toBeUndefined();
          yield* networkIdle;
          expect(sent).toEqual([]);

          yield* clickSave;
          yield* clickNamed(REMINDER_CONFIRM);
          yield* waitUntil(() => closes.length === 1);
          yield* networkIdle;
          expect(sent).toHaveLength(1);
          expect(Predicate.isTagged(sent[0], 'RecordReminder')).toBe(true);
          expect(sent[0]).toMatchObject({ invoiceRef: invoice.ref, recipient: 'fakturace@kavarna.cz' });
        }),
    );

    suite.effect('Uložit in the leave question opens the reminder review; it never sends the e-mail by itself', () =>
      Effect.gen(function* reminderOnLeave() {
        const props = { counterpartyName: 'Kavárna Dolce', invoice, issuerName: 'OntOS Demo s.r.o.', provider: smtp };
        yield* mount((vm) => <InvoiceReminderForm {...props} onClose={onClose} vm={vm} />);
        yield* typeInto('reminder-recipient', 'fakturace@kavarna.cz');
        yield* clickCancel;
        expect(leaveQuestion()).toBe(true);
        yield* clickNamed(labels.save);
        expect(leaveQuestion()).toBe(false);
        expect(reminderReview()).toContain('fakturace@kavarna.cz');
        yield* networkIdle;
        expect(sent).toEqual([]);
        expect(closes).toEqual([]);
        yield* clickNamed(REMINDER_CONFIRM);
        yield* waitUntil(() => closes.length === 1);
        yield* networkIdle;
        expect(sent).toHaveLength(1);
      }),
    );

    suite.effect('the accounting setup is saved once by Uložit and the form closes', () =>
      Effect.gen(function* step5() {
        yield* mount((vm) => <AccountingSetupForm onClose={onClose} vm={vm} />);
        expect(saveButton().disabled).toBe(true);
        yield* typeInto('setup-issuerIco', '12345678');
        yield* typeInto('setup-accountant', 'Eva Malá');
        yield* clickSave;
        yield* waitUntil(() => closes.length === 1);
        yield* networkIdle;
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

    suite.effect('an accounting setup someone else changed meanwhile is refused as a conflict', () =>
      Effect.gen(function* step6() {
        yield* mount((vm) => <AccountingSetupForm onClose={onClose} vm={vm} />);
        yield* typeInto('setup-accountant', 'Eva Malá');
        // Someone else saved another accounting system; the page data now shows it.
        records = recordsAt('Money S3');
        yield* acted(() => current().reload());
        yield* waitUntil(() => current().snapshot?.state.accountingSetup?.product === 'Money S3');
        yield* clickSave;
        yield* waitUntil(() => document.querySelector('[data-save-state="conflict"]') !== null);
        yield* networkIdle;
        expect(sent).toEqual([]);
        expect(closes).toEqual([]);
      }),
    );
  },
);
