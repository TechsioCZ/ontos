import { describe, expect, it } from 'effect-rstest';
import { ConfigProvider, DateTime, Effect, Exit, Option, Schema } from 'effect';
import type { FinanceCommand } from '../../shared/actions/apply-command.ts';
import {
  AccountingExportSchema,
  AccountingSetupSchema,
  CalendarMonthSchema,
  FinanceDocumentSchema,
  FinanceInvoiceResourceIdSchema,
  FinanceRecurringTemplateIdSchema,
  FinanceStateSchema,
  InvoiceLineSchema,
  InvoiceSchema,
  ManualPaymentSchema,
  PaymentTermsSchema,
  PriorSettlementEntrySchema,
  PriorSettlementSchema,
  RecordsRequestSchema,
} from '../../shared/apis/records.ts';
import type { FinanceState, Invoice } from '../../shared/apis/records.ts';
import {
  budgetVariance,
  cashFlowMonths,
  isInvoiceOverdue,
  paymentEvents,
} from '../../shared/domain/finance-planning.ts';
import { alignRentalTemplates } from '../../scripts/align-rental-templates.ts';
import { transitionFinance } from '../../src/services/persistence.service.ts';
import type { FinanceValidators } from '../../src/services/persistence.service.ts';

const tenantId = 'a0000000-0000-4000-8000-000000000001';
const scope = { legalEntityId: 'a0000000-0000-4000-8000-000000000002', tenantId };
const now = DateTime.makeUnsafe('2026-10-20T08:00:00Z');
const validators: FinanceValidators = {
  exportReferences: Effect.succeed({ issuerName: 'Nájempark', partners: new Map() }),
  invoice: () => Effect.void,
};
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
    moduleId: 'finance.billing',
    resourceId: id,
    resourceType: 'finance.billing.invoice',
    tenantId,
  },
  totalMinor: 100_000,
  updatedAt: now,
  ...overrides,
});
const empty: FinanceState = {
  financialPlanEntries: [],
  invoices: [],
};
let counter = 0;
const run = (state: FinanceState, command: FinanceCommand) => {
  counter += 1;
  return transitionFinance(state, command, scope, validators, {
    attemptId: `attempt-${counter}`,
    now,
    principalId: 'principal-1',
    resourceId: `resource-${counter}`,
  }).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnvRecord({ ONTOS_GATEWAY_ISSUER: 'https://shell.example.test' }),
    ),
  );
};

describe('S07 invoices', () => {
  it('S07-01 an unpaid incoming invoice due yesterday is overdue against the real business date', () => {
    const due = invoice('in-1', { direction: 'INCOMING', dueDate: '2026-10-19' });
    expect(isInvoiceOverdue(due, '2026-10-20')).toBe(true);
    expect(isInvoiceOverdue(due, '2026-10-19')).toBe(false);
  });

  it.effect('S07-02 a confirmed payment of 400 Kč of 1 000 Kč leaves 600 Kč and is partial', () =>
    Effect.gen(function* partialPayment() {
      const unpaid = invoice('out-1');
      const state = { ...empty, invoices: [unpaid] };
      const result = yield* run(state, {
        _tag: 'RecordManualPayment',
        actorLabel: 'Finance',
        amountMinor: 40_000,
        invoiceRef: unpaid.ref,
        paidOn: '2026-10-20',
      });
      expect(result.invoice?.paymentState).toBe('PARTIALLY_PAID');
      expect((result.invoice?.totalMinor ?? 0) - (result.invoice?.paidMinor ?? 0)).toBe(60_000);
      expect(result.state.manualPayments?.length).toBe(1);
      const over = yield* Effect.exit(
        run(result.state, {
          _tag: 'RecordManualPayment',
          amountMinor: 70_000,
          invoiceRef: unpaid.ref,
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
        counterpartyName: 'Kavárna U Parku s.r.o.',
        counterpartyRef,
        dueDays: 14,
        issueDay: 1,
        lines: [{ description: 'Nájem jednotky A1', quantity: 1, unitPriceMinor: 2_500_000, vatRate: 21 }],
        name: 'Nájem A1',
        occupancyRef: {
          moduleId: 'property.leasing',
          resourceId: 'lease-1',
          resourceType: 'property.leasing.occupancy',
          tenantId,
        },
      });
      const templateId = yield* Schema.decodeEffect(FinanceRecurringTemplateIdSchema)(
        created.state.recurringTemplates?.[0]?.id ?? '',
      );
      const first = yield* run(created.state, {
        _tag: 'GenerateRecurringInvoice',
        confirmDuplicate: false,
        period: '2026-11',
        templateId,
      });
      expect(first.invoice?.occupancyRef?.resourceId).toBe('lease-1');
      expect(first.invoice?.counterpartyName).toBe('Kavárna U Parku s.r.o.');
      expect(first.invoice?.lines).toEqual(created.state.recurringTemplates?.[0]?.lines);
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
      expect(result.state.documents?.[0]?.sha256).toBe(
        '71077e8389695f09b1e50bcfc288fb4998894a86ae7cd9657b31ac618a094eab',
      );
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
        invoiceResourceIds: yield* Schema.decodeEffect(AccountingExportSchema.fields.invoiceResourceIds)([
          'a',
          'b',
          'c',
        ]),
      });
      const created = first.state.accountingExports?.[0];
      expect(created?.invoiceResourceIds).toEqual(['a', 'b', 'c']);
      expect(created?.status).toBe('PREPARED');
      expect(created?.content.trim().split('\r\n').length).toBe(4);
      expect(created?.version).toBe(1);
      for (const id of ['a', 'b', 'c']) {
        expect(created?.content).toContain(`https://shell.example.test/cs/finance?resourceId=${id}`);
      }
      expect(created?.content).not.toContain('ontos://');
      const second = yield* run(first.state, {
        _tag: 'CreateAccountingExport',
        format: 'JSON',
        invoiceResourceIds: yield* Schema.decodeEffect(AccountingExportSchema.fields.invoiceResourceIds)(['d']),
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
        {
          amountMinor: 100_000,
          id: 'p1',
          invoiceResourceId: Schema.decodeSync(FinanceInvoiceResourceIdSchema)('x'),
          paidOn: '2026-10-10',
          recordedAt: now,
        },
      ],
    };
    const [october] = cashFlowMonths(state, { businessDate: '2026-10-20', fromMonth: '2026-10', months: 1 });
    expect(october?.paidInMinor).toBe(100_000);
    expect(october?.expectedInMinor).toBe(0);
    expect(october?.forecastBalanceMinor).toBe(100_000);
    expect(paymentEvents(state).reduce((sum, event) => sum + event.amountMinor, 0)).toBe(100_000);
  });

  it('S09-03 a zero budget has no percentage deviation', () => {
    expect(budgetVariance(0, 5000).percent).toBeUndefined();
    expect(budgetVariance(10_000, 12_000).percent).toBeCloseTo(0.2);
  });
});

describe('Rental demo consistency', () => {
  it('uses the linked rental terms for templates and unissued drafts without rewriting issued history', () => {
    const source = invoice('source', {
      counterpartyName: 'Kavárna U Parku s.r.o.',
      documentNumber: 'NAJ-R101-2026-11',
      lines: [
        { description: 'Nájemné R101 – listopad 2026', quantity: 1, unitPriceMinor: 4_800_000, vatRate: 21 },
        { description: 'Zálohy na služby R101 – listopad 2026', quantity: 1, unitPriceMinor: 650_000, vatRate: 21 },
      ],
      occupancyRef: {
        moduleId: 'property.leasing',
        resourceId: 'lease',
        resourceType: 'property.leasing.occupancy',
        tenantId,
      },
    });
    const templateId = Schema.decodeSync(FinanceRecurringTemplateIdSchema)('template');
    const legacy = invoice('legacy', { recurringTemplateId: templateId });
    const draft = invoice('draft', { businessState: 'DRAFT', recurringTemplateId: templateId });
    const result = alignRentalTemplates({
      ...empty,
      invoices: [source, legacy, draft],
      recurringTemplates: [
        {
          active: true,
          counterpartyName: 'Technoservis',
          counterpartyRef,
          createdAt: now,
          dueDays: 14,
          id: templateId,
          issueDay: 1,
          lines: [{ description: 'Nájemné R101', quantity: 1, unitPriceMinor: 4_500_000, vatRate: 21 }],
          name: 'Nájem R101',
        },
      ],
    });
    expect(result.recurringTemplates?.[0]?.counterpartyName).toBe('Kavárna U Parku s.r.o.');
    expect(result.recurringTemplates?.[0]?.lines.length).toBe(2);
    expect(result.invoices[2]?.totalMinor).toBe(6_594_500);
    expect(result.invoices[2]?.occupancyRef).toEqual(source.occupancyRef);
    expect(result.invoices[1]).toEqual(legacy);
  });
});

describe('Finance wire compatibility', () => {
  it('keeps identifier trimming and bounds at the existing string wire boundary', () => {
    const identifiers = [
      InvoiceLineSchema.fields.priceListItemId,
      PriorSettlementEntrySchema.fields.invoiceResourceId,
      PriorSettlementSchema.fields.confirmedByPrincipalId,
      PaymentTermsSchema.fields.updatedByPrincipalId,
      InvoiceSchema.fields.counterpartyCompanyId,
      InvoiceSchema.fields.recurringTemplateId,
      FinanceDocumentSchema.fields.actorPrincipalId,
      FinanceDocumentSchema.fields.invoiceResourceId,
      ManualPaymentSchema.fields.invoiceResourceId,
      RecordsRequestSchema.fields.documentId,
    ];
    for (const identifier of identifiers) {
      expect(Schema.decodeUnknownSync(identifier)('  original-id  ')).toBe('original-id');
      expect(Option.isNone(Schema.decodeUnknownOption(identifier)('   '))).toBe(true);
      expect(Option.isNone(Schema.decodeUnknownOption(identifier)('x'.repeat(501)))).toBe(true);
    }
    expect(
      Schema.decodeUnknownSync(AccountingSetupSchema)({ issuerIco: '12345678', issuerVatId: 'CZ12345678' }),
    ).toEqual({ issuerIco: '12345678', issuerVatId: 'CZ12345678' });
    expect(Option.isNone(Schema.decodeUnknownOption(AccountingSetupSchema)({ issuerIco: '1234567' }))).toBe(true);
    expect(Option.isNone(Schema.decodeUnknownOption(AccountingSetupSchema)({ issuerVatId: 'CZ1234567' }))).toBe(true);
    expect(Schema.decodeUnknownSync(AccountingExportSchema.fields.invoiceResourceIds)([' original-id '])).toEqual([
      'original-id',
    ]);
    expect(Schema.decodeUnknownSync(CalendarMonthSchema)('2026-10')).toBe('2026-10');
    expect(Option.isNone(Schema.decodeUnknownOption(CalendarMonthSchema)('2026-13'))).toBe(true);
  });

  it.effect('keeps state JSON, UTC timestamps, calendar dates and money snapshots unchanged', () =>
    Effect.gen(function* wireCompatibility() {
      const state: FinanceState = { ...empty, invoices: [invoice('wire-invoice')] };
      const encoded = yield* Schema.encodeEffect(FinanceStateSchema)(state);
      const json = yield* Schema.encodeEffect(Schema.fromJsonString(FinanceStateSchema))(state);
      const wire = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.toEncoded(FinanceStateSchema)))(json);
      expect(wire).toEqual(encoded);
      expect(wire.invoices[0]?.createdAt).toBe('2026-10-20T08:00:00.000Z');
      expect(wire.invoices[0]?.issueDate).toBe('2026-10-01');
      expect(wire.invoices[0]?.totalMinor).toBe(100_000);
      const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(FinanceStateSchema))(json);
      expect(Schema.toEquivalence(FinanceStateSchema)(decoded, state)).toBe(true);
    }),
  );
});
