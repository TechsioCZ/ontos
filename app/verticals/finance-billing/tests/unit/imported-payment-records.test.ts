import { describe, expect, it } from 'effect-rstest';
import { ConfigProvider, DateTime, Effect, Schema } from 'effect';
import type { FinanceCommand } from '../../shared/actions/apply-command.ts';
import { FinanceInvoiceResourceIdSchema } from '../../shared/apis/records.ts';
import type { FinanceState, Invoice, ManualPayment } from '../../shared/apis/records.ts';
import {
  ImportedPaymentRecordsRefused,
  cashFlowMonths,
  paymentEvents,
  withImportedPaymentRecords,
} from '../../shared/domain/finance-planning.ts';
import { transitionFinance } from '../../src/services/persistence.service.ts';
import type { FinanceValidators } from '../../src/services/persistence.service.ts';

const tenantId = 'a0000000-0000-4000-8000-000000000001';
const scope = { legalEntityId: 'a0000000-0000-4000-8000-000000000002', tenantId };
const seededAt = DateTime.makeUnsafe('2026-09-10T12:00:00.000Z');
const editedAt = DateTime.makeUnsafe('2026-10-20T08:00:00.000Z');
const validators: FinanceValidators = { invoice: () => Effect.void };
const invoice = (id: string, overrides: Partial<Invoice> = {}): Invoice => ({
  accountingCorrelation: `acc-${id}`,
  accountingSyncState: 'NOT_SYNCED',
  businessState: 'CONFIRMED',
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: 'a0000000-0000-4000-8000-000000000012',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  createdAt: seededAt,
  currency: 'CZK',
  direction: 'OUTGOING',
  documentNumber: id,
  dueDate: '2026-09-30',
  issueDate: '2026-09-01',
  paidMinor: 0,
  paymentState: 'UNPAID',
  ref: { moduleId: 'finance.billing', resourceId: id, resourceType: 'finance.billing.invoice', tenantId },
  totalMinor: 100_000,
  updatedAt: seededAt,
  ...overrides,
});
const payment = (id: string, invoiceId: string, amountMinor: number, paidOn: string): ManualPayment => ({
  amountMinor,
  id,
  invoiceResourceId: Schema.decodeSync(FinanceInvoiceResourceIdSchema)(invoiceId),
  paidOn,
  recordedAt: seededAt,
});
const ledger = (invoices: readonly Invoice[], manualPayments?: readonly ManualPayment[]): FinanceState => {
  const state: FinanceState = { financialPlanEntries: [], invoices };
  return manualPayments === undefined ? state : { ...state, manualPayments };
};
const run = (state: FinanceState, command: FinanceCommand) =>
  transitionFinance(state, command, scope, validators, {
    attemptId: 'attempt-1',
    now: editedAt,
    principalId: 'principal-1',
    resourceId: 'resource-1',
  }).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnvRecord({ ONTOS_GATEWAY_ISSUER: 'https://shell.example.test' }),
    ),
  );

describe('imported payment records', () => {
  it.effect('a seeded paid balance keeps its payment date when the invoice is edited later', () =>
    Effect.gen(function* seededPaymentKeepsItsDate() {
      const seeded = yield* withImportedPaymentRecords(
        ledger([invoice('paid', { paidMinor: 100_000, paymentState: 'PAID' })]),
      );
      const [paid] = seeded.invoices;
      expect(paid).toBeDefined();
      const edited = yield* run(seeded, {
        _tag: 'SetPaymentTerms',
        invoiceRef: paid?.ref ?? invoice('paid').ref,
        skontoText: '2 % do 7 dnů',
      });
      expect(DateTime.formatIso(edited.invoice?.updatedAt ?? seededAt)).toBe('2026-10-20T08:00:00.000Z');
      expect(paymentEvents(edited.state)).toEqual([
        {
          amountMinor: 100_000,
          date: '2026-09-10',
          direction: 'OUTGOING',
          id: 'paid:import',
          invoiceResourceId: 'paid',
          source: 'IMPORT',
        },
      ]);
      // The payment predates the opening, so it is part of the opening balance and never counts again.
      const [october] = cashFlowMonths(
        {
          ...edited.state,
          cashFlowOpening: { confirmedAt: editedAt, openingBalanceMinor: 500_000, openingDate: '2026-10-01' },
        },
        { businessDate: '2026-10-20', fromMonth: '2026-10', months: 1 },
      );
      expect(october?.paidInMinor).toBe(0);
      expect(october?.forecastBalanceMinor).toBe(500_000);
    }),
  );

  it.effect('records only what no payment record or advance explains, after the existing records', () =>
    Effect.gen(function* recordsTheUnrecordedPart() {
      const advance = invoice('advance', { paidMinor: 30_000, paymentState: 'PAID', totalMinor: 30_000 });
      const final = invoice('final', {
        paidMinor: 80_000,
        paymentState: 'PARTIALLY_PAID',
        priorSettlement: {
          confirmedAt: seededAt,
          entries: [
            {
              amountMinor: 30_000,
              invoiceResourceId: yield* Schema.decodeEffect(FinanceInvoiceResourceIdSchema)('advance'),
              number: 'ZF-1',
            },
          ],
        },
        updatedAt: DateTime.makeUnsafe('2026-09-20T23:30:00.000+02:00'),
      });
      const partial = invoice('partial', { paidMinor: 60_000, paymentState: 'PARTIALLY_PAID' });
      const settled = invoice('settled', { paidMinor: 100_000, paymentState: 'PAID' });
      const unpaid = invoice('unpaid');
      const draft = invoice('draft', { businessState: 'DRAFT', paidMinor: 10_000, paymentState: 'PARTIALLY_PAID' });
      const existing = [
        payment('user-1', 'partial', 20_000, '2026-09-05'),
        payment('user-2', 'settled', 100_000, '2026-09-06'),
        payment('user-3', 'advance', 30_000, '2026-08-01'),
      ];
      const recorded = yield* withImportedPaymentRecords(
        ledger([advance, final, partial, settled, unpaid, draft], existing),
      );
      expect(recorded.manualPayments?.slice(0, 3)).toEqual(existing);
      expect(
        recorded.manualPayments
          ?.slice(3)
          .map((entry) => [entry.id, entry.invoiceResourceId, entry.amountMinor, entry.paidOn, entry.source]),
      ).toEqual([
        // 80 000 paid − 30 000 taken from the advance; dated on the UTC day of its timestamp.
        ['final:import', 'final', 50_000, '2026-09-20', 'IMPORT'],
        ['partial:import', 'partial', 40_000, '2026-09-10', 'IMPORT'],
        ['draft:import', 'draft', 10_000, '2026-09-10', 'IMPORT'],
      ]);
      // Every paid amount of a confirmed invoice is now explained by its events.
      const events = paymentEvents(recorded);
      for (const entry of [advance, final, partial, settled]) {
        expect(
          events
            .filter((event) => event.invoiceResourceId === entry.ref.resourceId)
            .reduce((sum, event) => sum + event.amountMinor, 0),
        ).toBe(entry.paidMinor);
      }
      // A draft's record never reaches the cash flow.
      expect(events.some((event) => event.invoiceResourceId === 'draft')).toBe(false);
    }),
  );

  it.effect('leaves a ledger with nothing unrecorded exactly as it is', () =>
    Effect.gen(function* nothingToRecord() {
      const empty = ledger([]);
      expect(yield* withImportedPaymentRecords(empty)).toBe(empty);
      const unpaid = ledger([invoice('unpaid')]);
      expect(yield* withImportedPaymentRecords(unpaid)).toBe(unpaid);
      const recorded = ledger(
        [invoice('paid', { paidMinor: 100_000, paymentState: 'PAID' })],
        [payment('user-1', 'paid', 100_000, '2026-09-11')],
      );
      expect(yield* withImportedPaymentRecords(recorded)).toBe(recorded);
      const overRecorded = ledger(
        [invoice('odd', { paidMinor: 10_000 })],
        [payment('user-1', 'odd', 20_000, '2026-09-11')],
      );
      expect(yield* withImportedPaymentRecords(overRecorded)).toBe(overRecorded);
    }),
  );

  it('dates a user payment on its own payment date and an advance on the approval date, never on the last edit', () => {
    const final = invoice('final', {
      approvedAt: DateTime.makeUnsafe('2026-09-15T10:00:00.000Z'),
      paidMinor: 50_000,
      priorSettlement: {
        confirmedAt: seededAt,
        entries: [
          {
            amountMinor: 30_000,
            invoiceResourceId: Schema.decodeSync(FinanceInvoiceResourceIdSchema)('advance'),
            number: 'ZF-1',
          },
        ],
      },
      updatedAt: editedAt,
    });
    expect(
      paymentEvents(ledger([final], [payment('user-1', 'final', 20_000, '2026-09-18')])).map((event) => [
        event.source,
        event.date,
      ]),
    ).toEqual([
      ['PRIOR', '2026-09-15'],
      ['MANUAL', '2026-09-18'],
    ]);
  });
  it.effect(
    'refuses a record id that is already taken, by a record or by another invoice with the same reference',
    () =>
      Effect.gen(function* refusesCollisions() {
        const paid = invoice('paid', { paidMinor: 100_000, paymentState: 'PAID' });
        const taken = yield* Effect.flip(
          withImportedPaymentRecords(ledger([paid], [payment('paid:import', 'other', 10_000, '2026-09-01')])),
        );
        expect(taken).toBeInstanceOf(ImportedPaymentRecordsRefused);
        expect([taken.invoice, taken.problem]).toEqual(['paid', 'a payment record already has the id paid:import']);
        const twice = yield* Effect.flip(withImportedPaymentRecords(ledger([paid, paid])));
        expect([twice.invoice, twice.problem]).toEqual([
          'paid',
          'another invoice of the ledger has the same reference',
        ]);
      }),
  );

  it.effect('takes a ledger up to 5000 payment records and refuses one more', () =>
    Effect.gen(function* refusesTooMany() {
      const recorded = Array.from({ length: 4999 }, (_, index) => payment(`user-${index}`, 'settled', 1, '2026-09-01'));
      const settled = invoice('settled', { paidMinor: 4999, paymentState: 'PARTIALLY_PAID' });
      const atLimit = yield* withImportedPaymentRecords(
        ledger([settled, invoice('paid', { paidMinor: 100_000, paymentState: 'PAID' })], recorded),
      );
      expect(atLimit.manualPayments?.length).toBe(5000);
      const over = yield* Effect.flip(
        withImportedPaymentRecords(
          ledger(
            [
              settled,
              invoice('paid', { paidMinor: 100_000, paymentState: 'PAID' }),
              invoice('paid-2', { paidMinor: 100_000, paymentState: 'PAID' }),
            ],
            recorded,
          ),
        ),
      );
      expect(over.problem).toBe('the ledger would hold more than 5000 payment records');
    }),
  );
});
