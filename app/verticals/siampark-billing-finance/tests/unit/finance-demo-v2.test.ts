import { describe, expect, it } from 'effect-rstest';
import { DateTime, Effect, Exit } from 'effect';
import type { FinanceCommand } from '../../shared/actions/apply-command.ts';
import type { FinanceState, Invoice } from '../../shared/apis/records.ts';
import {
  budgetVariance,
  cashFlowMonths,
  isInvoiceOverdue,
  paymentEvents,
} from '../../shared/domain/finance-planning.ts';
import { transitionFinance } from '../../src/services/persistence.service.ts';
import type { FinanceValidators } from '../../src/services/persistence.service.ts';

const tenantId = 'a0000000-0000-4000-8000-000000000001';
const scope = { legalEntityId: 'a0000000-0000-4000-8000-000000000002', tenantId };
const now = DateTime.makeUnsafe('2026-10-20T08:00:00Z');
const validators: FinanceValidators = { invoice: () => Effect.void };
const counterpartyRef = {
  moduleId: 'party.registry' as const,
  resourceId: 'a0000000-0000-4000-8000-000000000012',
  resourceType: 'party.registry.counterparty' as const,
  tenantId,
};
const invoice = (id: string, overrides: Partial<Invoice> = {}): Invoice => ({
  accountingCorrelation: `acc-${id}`,
  accountingSyncState: 'NOT_SYNCED',
  businessState: 'CONFIRMED',
  counterpartyRef,
  createdAt: now,
  currency: 'CZK',
  direction: 'OUTGOING',
  documentNumber: id,
  dueDate: '2026-10-30',
  issueDate: '2026-10-01',
  paidMinor: 0,
  paymentState: 'UNPAID',
  ref: {
    moduleId: 'siampark.billing-finance',
    resourceId: id,
    resourceType: 'siampark.billing-finance.invoice',
    tenantId,
  },
  totalMinor: 100_000,
  updatedAt: now,
  ...overrides,
});
const empty: FinanceState = {
  accountingObservations: [],
  financialPlanEntries: [],
  invoices: [],
  paymentObservations: [],
};
let counter = 0;
const run = (state: FinanceState, command: FinanceCommand) => {
  counter += 1;
  return transitionFinance(state, command, scope, validators, {
    attemptId: `attempt-${counter}`,
    now,
    principalId: 'principal-1',
    resourceId: `resource-${counter}`,
  });
};

describe('S07 invoices', () => {
  it('S07-01 an unpaid incoming invoice due yesterday is overdue against the real business date', () => {
    const due = invoice('in-1', { direction: 'INCOMING', dueDate: '2026-10-19' });
    expect(isInvoiceOverdue(due, '2026-10-20')).toBe(true);
    expect(isInvoiceOverdue(due, '2026-10-19')).toBe(false);
  });

  it.effect('S07-02 a confirmed payment of 400 Kč of 1 000 Kč leaves 600 Kč and is partial', () =>
    Effect.gen(function* partialPayment() {
      const state = { ...empty, invoices: [invoice('out-1')] };
      const result = yield* run(state, {
        _tag: 'RecordManualPayment',
        actorLabel: 'Finance',
        amountMinor: 40_000,
        invoiceRef: state.invoices[0]!.ref,
        paidOn: '2026-10-20',
      });
      expect(result.invoice?.paymentState).toBe('PARTIALLY_PAID');
      expect((result.invoice?.totalMinor ?? 0) - (result.invoice?.paidMinor ?? 0)).toBe(60_000);
      expect(result.state.manualPayments?.length).toBe(1);
      const over = yield* Effect.exit(
        run(result.state, {
          _tag: 'RecordManualPayment',
          amountMinor: 70_000,
          invoiceRef: state.invoices[0]!.ref,
          paidOn: '2026-10-20',
        }),
      );
      expect(Exit.isFailure(over)).toBe(true);
    }),
  );

  it.effect('S07-05 a second recurring invoice for the same period needs an explicit confirmation', () =>
    Effect.gen(function* recurring() {
      const created = yield* run(empty, {
        _tag: 'CreateRecurringTemplate',
        counterpartyRef,
        dueDays: 14,
        issueDay: 1,
        lines: [{ description: 'Nájem jednotky A1', quantity: 1, unitPriceMinor: 2_500_000, vatRate: 21 }],
        name: 'Nájem A1',
      });
      const templateId = created.state.recurringTemplates?.[0]?.id ?? '';
      const first = yield* run(created.state, {
        _tag: 'GenerateRecurringInvoice',
        confirmDuplicate: false,
        period: '2026-11',
        templateId,
      });
      expect(first.invoice?.issueDate).toBe('2026-11-01');
      expect(first.invoice?.dueDate).toBe('2026-11-15');
      const duplicate = yield* Effect.exit(
        run(first.state, { _tag: 'GenerateRecurringInvoice', confirmDuplicate: false, period: '2026-11', templateId }),
      );
      expect(Exit.isFailure(duplicate)).toBe(true);
      const confirmed = yield* run(first.state, {
        _tag: 'GenerateRecurringInvoice',
        confirmDuplicate: true,
        period: '2026-11',
        templateId,
      });
      expect(confirmed.state.invoices.length).toBe(2);
    }),
  );

  it.effect('records an incoming invoice with an attached PDF and keeps only metadata in the state', () =>
    Effect.gen(function* incoming() {
      const result = yield* run(empty, {
        _tag: 'RecordIncomingInvoice',
        document: {
          contentBase64: Buffer.from('%PDF-1.4 demo').toString('base64'),
          fileName: 'f.pdf',
          mimeType: 'application/pdf',
        },
        documentNumber: '2026-118',
        dueDate: '2026-10-19',
        issueDate: '2026-10-05',
        supplierName: 'Energie Plus s.r.o.',
        totalMinor: 1_210_000,
      });
      expect(result.invoice?.businessState).toBe('CONFIRMED');
      expect(result.state.documents?.[0]?.sizeBytes).toBe(13);
      expect(result.documentWrites?.length).toBe(1);
      const twice = yield* Effect.exit(
        run(result.state, {
          _tag: 'RecordIncomingInvoice',
          documentNumber: '2026-118',
          dueDate: '2026-10-19',
          issueDate: '2026-10-05',
          supplierName: 'energie plus s.r.o.',
          totalMinor: 1_210_000,
        }),
      );
      expect(Exit.isFailure(twice)).toBe(true);
    }),
  );
});

describe('S08 accounting handover', () => {
  it.effect('S08-02 exports exactly the three selected confirmed invoices with version and history', () =>
    Effect.gen(function* exports() {
      const state = { ...empty, invoices: [invoice('a'), invoice('b'), invoice('c'), invoice('d')] };
      const first = yield* run(state, {
        _tag: 'CreateAccountingExport',
        format: 'CSV',
        invoiceResourceIds: ['a', 'b', 'c'],
      });
      const created = first.state.accountingExports?.[0];
      expect(created?.invoiceResourceIds).toEqual(['a', 'b', 'c']);
      expect(created?.status).toBe('HANDED_OVER');
      expect(created?.content.trim().split('\r\n').length).toBe(4);
      expect(created?.version).toBe(1);
      const second = yield* run(first.state, {
        _tag: 'CreateAccountingExport',
        format: 'JSON',
        invoiceResourceIds: ['d'],
      });
      expect(second.state.accountingExports?.map((entry) => entry.version)).toEqual([1, 2]);
      // S08-03: nothing becomes "booked"; the invoices keep their accounting state.
      expect(second.state.invoices.every((entry) => entry.accountingSyncState === 'NOT_SYNCED')).toBe(true);
    }),
  );
});

describe('S09 planning', () => {
  it('S09-01 opening 10 000 + income 5 000 − expense 3 000 = 12 000 estimate', () => {
    const months = cashFlowMonths(
      {
        ...empty,
        cashFlowOpening: { confirmedAt: now, openingBalanceMinor: 1_000_000, openingDate: '2026-10-01' },
        invoices: [
          invoice('in', { totalMinor: 500_000 }),
          invoice('out', { direction: 'INCOMING', totalMinor: 300_000 }),
        ],
      },
      { businessDate: '2026-10-20', fromMonth: '2026-10', months: 2 },
    );
    expect(months[0]?.forecastBalanceMinor).toBe(1_200_000);
    expect(months[1]?.forecastBalanceMinor).toBe(1_200_000);
  });

  it('S09-02 an invoice of 1 000 that becomes paid is counted exactly once', () => {
    const paid = invoice('x', { paidMinor: 100_000, paymentState: 'PAID' });
    const state = {
      ...empty,
      cashFlowOpening: { confirmedAt: now, openingBalanceMinor: 0, openingDate: '2026-10-01' },
      invoices: [paid],
      manualPayments: [
        { amountMinor: 100_000, id: 'p1', invoiceResourceId: 'x', paidOn: '2026-10-10', recordedAt: now },
      ],
    };
    const [october] = cashFlowMonths(state, { businessDate: '2026-10-20', fromMonth: '2026-10', months: 1 });
    expect(october?.paidInMinor).toBe(100_000);
    expect(october?.expectedInMinor).toBe(0);
    expect(october?.forecastBalanceMinor).toBe(100_000);
    expect(paymentEvents(state).reduce((sum, event) => sum + event.amountMinor, 0)).toBe(100_000);
  });

  it('S09-03 a zero budget has no percentage deviation', () => {
    expect(budgetVariance(0, 5_000).percent).toBeUndefined();
    expect(budgetVariance(10_000, 12_000).percent).toBeCloseTo(0.2);
  });
});
