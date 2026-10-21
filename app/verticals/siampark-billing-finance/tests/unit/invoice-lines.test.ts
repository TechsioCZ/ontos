import { describe, expect, it } from 'effect-rstest';
import { DateTime, Effect, Exit, Schema } from 'effect';
import type { FinanceCommand } from '../../shared/actions/apply-command.ts';
import { FinanceCommandSchema } from '../../shared/actions/apply-command.ts';
import { FinanceStateSchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { FinanceState, Invoice, InvoiceLine } from '../../shared/apis/records.ts';
import { computeInvoiceTotals, lineVatMinor, nextInvoiceNumber } from '../../shared/domain/invoice-totals.ts';
import { projectFinanceRecords, transitionFinance } from '../../src/services/persistence.service.ts';
import type { FinanceValidators } from '../../src/services/persistence.service.ts';

const tenantId = 'a0000000-0000-4000-8000-000000000001';
const legalEntityId = 'a0000000-0000-4000-8000-000000000002';
const now = DateTime.makeUnsafe('2026-10-06T12:00:00Z');
const scope = { legalEntityId, tenantId };
const validators: FinanceValidators = { invoice: () => Effect.void };
const partyId = 'a0000000-0000-4000-8000-000000000012';
const opportunityId = 'c0000000-0000-4000-8000-000000000001';
const counterpartyRef = {
  moduleId: 'party.registry' as const,
  resourceId: partyId,
  resourceType: 'party.registry.counterparty' as const,
  tenantId,
};
const legacyInvoice: Invoice = {
  accountingCorrelation: 'accounting-legacy',
  accountingSyncState: 'NOT_SYNCED',
  businessState: 'CONFIRMED',
  counterpartyRef: { ...counterpartyRef, resourceId: 'legacy-party' },
  createdAt: now,
  currency: 'CZK',
  direction: 'OUTGOING',
  documentNumber: 'LEGACY-1',
  dueDate: '2026-10-01',
  issueDate: '2026-09-15',
  paidMinor: 0,
  paymentState: 'UNPAID',
  ref: {
    moduleId: 'siampark.billing-finance',
    resourceId: 'invoice-legacy',
    resourceType: 'siampark.billing-finance.invoice',
    tenantId,
  },
  totalMinor: 500_000,
  updatedAt: now,
};
const empty: FinanceState = {
  accountingObservations: [],
  financialPlanEntries: [],
  invoices: [],
  paymentObservations: [],
};
const lines: readonly InvoiceLine[] = [
  { description: 'Konzultace', productId: 'p-1', quantity: 3, unitPriceMinor: 333, vatRate: 21 },
  { description: 'Licence', quantity: 1, unitPriceMinor: 1050, vatRate: 21 },
  { description: 'Kniha', quantity: 2, unitPriceMinor: 125, vatRate: 12 },
  { description: 'Školení zdarma', quantity: 1, unitPriceMinor: 0, vatRate: 0 },
];
const run = (snapshot: FinanceState, command: FinanceCommand, resourceId: string) =>
  transitionFinance(snapshot, command, scope, validators, { attemptId: 'attempt', now, resourceId });

describe('Invoice line totals', () => {
  it('rounds VAT per line half-up in minor units and reconciles the recap with the totals', () => {
    // 999 × 21 % = 209.79 → 210; 1050 × 21 % = 220.5 → 221 (half-up); 250 × 12 % = 30.
    expect(lineVatMinor({ quantity: 3, unitPriceMinor: 333, vatRate: 21 })).toBe(210);
    expect(lineVatMinor({ quantity: 1, unitPriceMinor: 1050, vatRate: 21 })).toBe(221);
    expect(lineVatMinor({ quantity: 1, unitPriceMinor: 1049, vatRate: 21 })).toBe(220);
    expect(lineVatMinor({ quantity: 1, unitPriceMinor: 25, vatRate: 10 })).toBe(3);
    expect(computeInvoiceTotals(lines)).toEqual({
      subtotalMinor: 2299,
      totalMinor: 2760,
      vatMinor: 461,
      vatRecap: [
        { baseMinor: 2049, rate: 21, vatMinor: 431 },
        { baseMinor: 250, rate: 12, vatMinor: 30 },
        { baseMinor: 0, rate: 0, vatMinor: 0 },
      ],
    });
    // Per-line rounding differs from rounding the per-rate base: 2 × 1050 → 221 + 221, not round(441).
    expect(
      computeInvoiceTotals([
        { description: 'A', quantity: 1, unitPriceMinor: 1050, vatRate: 21 },
        { description: 'B', quantity: 1, unitPriceMinor: 1050, vatRate: 21 },
      ])?.vatMinor,
    ).toBe(442);
    expect(
      computeInvoiceTotals([{ description: 'X', quantity: 1_000_000, unitPriceMinor: 1_000_000_000, vatRate: 0 }]),
    ).toBeUndefined();
  });

  it('rejects unsupported VAT rates, empty line lists and fractional quantities at the public contract', () => {
    const base = { _tag: 'CreateInvoiceFromOpportunity', lines, opportunityId, partyId };
    expect(Schema.is(FinanceCommandSchema)(base)).toBe(true);
    expect(Schema.is(FinanceCommandSchema)({ ...base, lines: [] })).toBe(false);
    expect(Schema.is(FinanceCommandSchema)({ ...base, lines: [{ ...lines[1], vatRate: 15 }] })).toBe(false);
    expect(Schema.is(FinanceCommandSchema)({ ...base, lines: [{ ...lines[1], quantity: 1.5 }] })).toBe(false);
    expect(Schema.is(FinanceCommandSchema)({ ...base, lines: [{ ...lines[1], unitPriceMinor: -1 }] })).toBe(false);
  });

  it('assigns monotonic FV-2026 numbers from state, ignoring foreign and legacy numbers', () => {
    expect(nextInvoiceNumber([])).toBe('FV-2026-0001');
    expect(nextInvoiceNumber([{ number: 'FV-2026-0007' }, {}, { number: 'FV-2026-0003' }])).toBe('FV-2026-0008');
    expect(nextInvoiceNumber([{ number: 'FV-2025-0099' }])).toBe('FV-2026-0001');
  });
});

describe('Invoice line snapshots', () => {
  it.effect('stores computed totals at create, recomputes only on draft update, and never after confirm', () =>
    Effect.gen(function* snapshotImmutability() {
      const create: FinanceCommand = {
        _tag: 'CreateInvoiceDraft',
        counterpartyRef,
        currency: 'CZK',
        direction: 'OUTGOING',
        documentNumber: 'MANUAL-1',
        dueDate: '2026-10-20',
        issueDate: '2026-10-06',
        lines,
        partyId,
        totalMinor: 1,
      };
      const draft = yield* run({ ...empty, invoices: [legacyInvoice] }, create, 'invoice-manual');
      expect(draft.invoice!).toMatchObject({
        businessState: 'DRAFT',
        number: 'FV-2026-0001',
        partyId,
        subtotalMinor: 2299,
        totalMinor: 2760,
        vatMinor: 461,
      });
      expect(draft.state.invoices[0]).toBe(legacyInvoice);

      const relined = yield* run(
        draft.state,
        {
          ...create,
          _tag: 'UpdateInvoiceDraft',
          invoiceRef: draft.invoice!.ref,
          lines: [{ description: 'Licence', quantity: 2, unitPriceMinor: 1000, vatRate: 21 }],
        },
        'unused',
      );
      expect(relined.invoice!).toMatchObject({
        number: 'FV-2026-0001',
        subtotalMinor: 2000,
        totalMinor: 2420,
        vatMinor: 420,
        vatRecap: [{ baseMinor: 2000, rate: 21, vatMinor: 420 }],
      });

      const plainConfirm = yield* Effect.exit(
        run(relined.state, { _tag: 'ConfirmInvoice', invoiceRef: draft.invoice!.ref }, 'unused'),
      );
      expect(Exit.isFailure(plainConfirm)).toBe(true);
      const prepared = yield* run(relined.state, { _tag: 'MarkInvoicesPrepared', invoiceRefs: [draft.invoice!.ref] }, 'unused');
      const confirmed = yield* run(prepared.state, { _tag: 'ConfirmInvoice', invoiceRef: draft.invoice!.ref }, 'unused');
      const {
        approvedAt: _approvedAt,
        businessState: _confirmedState,
        preparedAt: _confirmedPreparedAt,
        updatedAt: _confirmedAt,
        ...confirmedSnapshot
      } = confirmed.invoice!;
      const { businessState: _draftState, updatedAt: _draftAt, ...draftSnapshot } = relined.invoice!;
      expect(confirmedSnapshot).toEqual(draftSnapshot);
      expect(confirmed.invoice!.lines).toBe(relined.invoice!.lines);

      const lateEdit = yield* Effect.exit(
        run(confirmed.state, { ...create, _tag: 'UpdateInvoiceDraft', invoiceRef: draft.invoice!.ref, lines }, 'unused'),
      );
      expect(Exit.isFailure(lateEdit)).toBe(true);

      const voided = yield* run(confirmed.state, { _tag: 'VoidInvoice', invoiceRef: draft.invoice!.ref }, 'unused');
      expect(voided.invoice!.lines).toBe(relined.invoice!.lines);
      expect(voided.invoice!.totalMinor).toBe(2420);

      const roundTrip = yield* Schema.decodeEffect(FinanceStateSchema)(
        yield* Schema.encodeEffect(FinanceStateSchema)(confirmed.state),
      );
      expect(roundTrip.invoices[1]?.vatRecap).toEqual(confirmed.invoice!.vatRecap);
    }),
  );

  it.effect('keeps legacy totals without lines and requires a total when no lines are supplied', () =>
    Effect.gen(function* legacyTotals() {
      const legacy: FinanceCommand = {
        _tag: 'CreateInvoiceDraft',
        counterpartyRef,
        currency: 'CZK',
        direction: 'OUTGOING',
        documentNumber: 'MANUAL-2',
        dueDate: '2026-10-20',
        issueDate: '2026-10-06',
        totalMinor: 99_900,
      };
      const created = yield* run(empty, legacy, 'invoice-legacy-new');
      expect(created.invoice!.totalMinor).toBe(99_900);
      expect(created.invoice!.lines).toBeUndefined();
      expect(created.invoice!.vatRecap).toBeUndefined();
      const { totalMinor: _total, ...withoutTotal } = legacy;
      expect(Exit.isFailure(yield* Effect.exit(run(empty, withoutTotal, 'invoice-x')))).toBe(true);
      const zeroLines = yield* Effect.exit(
        run(
          empty,
          { ...withoutTotal, lines: [{ description: 'Zdarma', quantity: 1, unitPriceMinor: 0, vatRate: 21 }] },
          'x',
        ),
      );
      expect(Exit.isFailure(zeroLines)).toBe(true);
      // Pre-lines JSONB rows still decode.
      const decoded = yield* Schema.decodeEffect(FinanceStateSchema)(
        yield* Schema.encodeEffect(FinanceStateSchema)({ ...empty, invoices: [legacyInvoice] }),
      );
      expect(decoded.invoices[0]?.totalMinor).toBe(500_000);
    }),
  );
});

describe('CreateInvoiceFromOpportunity', () => {
  it.effect('drafts one outgoing invoice per opportunity and converges on redelivery', () =>
    Effect.gen(function* idempotentOpportunityInvoice() {
      const command: FinanceCommand = {
        _tag: 'CreateInvoiceFromOpportunity',
        issueDate: '2026-10-06',
        lines,
        opportunityId,
        partyId,
      };
      const first = yield* run({ ...empty, invoices: [legacyInvoice] }, command, 'invoice-opportunity');
      expect(first.changed).toBe(true);
      expect(first.invoice!).toMatchObject({
        businessState: 'DRAFT',
        counterpartyRef,
        direction: 'OUTGOING',
        documentNumber: 'FV-2026-0001',
        dueDate: '2026-10-20',
        issueDate: '2026-10-06',
        number: 'FV-2026-0001',
        opportunityId,
        partyId,
        paymentState: 'UNPAID',
        totalMinor: 2760,
      });

      const redelivered = yield* run(first.state, command, 'invoice-opportunity-duplicate');
      expect(redelivered.changed).toBe(false);
      expect(redelivered.state).toBe(first.state);
      expect(redelivered.invoice!.ref).toEqual(first.invoice!.ref);

      const differentLines = yield* run(
        first.state,
        { ...command, lines: [{ description: 'Jiné', quantity: 1, unitPriceMinor: 10, vatRate: 0 }] },
        'invoice-opportunity-other',
      );
      expect(differentLines.changed).toBe(false);
      expect(differentLines.invoice!.totalMinor).toBe(2760);

      const defaultDate = yield* run(
        first.state,
        { _tag: 'CreateInvoiceFromOpportunity', lines, opportunityId: 'c0000000-0000-4000-8000-000000000002', partyId },
        'invoice-opportunity-2',
      );
      expect(defaultDate.invoice).toMatchObject({
        dueDate: '2026-10-20',
        issueDate: '2026-10-06',
        number: 'FV-2026-0002',
      });

      const records = projectFinanceRecords(defaultDate.state, 3, { opportunityId });
      expect(records.state.invoices).toHaveLength(1);
      expect(records.indicators.draftCount).toBe(1);
      expect(Schema.is(RecordsResponseSchema)({ ...records, canWrite: true })).toBe(true);
      expect(projectFinanceRecords(defaultDate.state, 3, { partyId }).state.invoices).toHaveLength(2);
      // Legacy counterparty references are not Party snapshots. They have their own scoped filter.
      expect(projectFinanceRecords(defaultDate.state, 3, { partyId: 'legacy-party' }).state.invoices).toEqual([]);
      expect(
        projectFinanceRecords(defaultDate.state, 3, { counterpartyRef: legacyInvoice.counterpartyRef }).state.invoices,
      ).toEqual([legacyInvoice]);
      const all = projectFinanceRecords(defaultDate.state, 3, {});
      expect(all.indicators).toMatchObject({ draftCount: 2, revenueMinor: 500_000 });
    }),
  );
});
