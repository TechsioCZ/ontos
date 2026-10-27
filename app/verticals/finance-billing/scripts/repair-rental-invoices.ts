import type { DateTime } from 'effect';
import { Effect, Schema } from 'effect';
import type { FinanceCommand } from '../shared/actions/apply-command.ts';
import { InvoiceSchema } from '../shared/apis/records.ts';
import type { FinanceState, Invoice } from '../shared/apis/records.ts';
import { transitionFinance } from '../src/services/persistence.service.ts';

export const rentalRepairScope = {
  legalEntityId: '71000000-0000-4000-8000-000000000021',
  tenantId: '70000000-0000-4000-8000-000000000020',
};
export const rentalInvoiceCorrections = [
  {
    name: 'Kavárna U Parku s.r.o.',
    originalId: '6770419a-5ec7-483d-9935-9f3d0d401822',
    replacementId: 'e12a77c6-c624-46bf-88fe-13d8c386e005',
    sourceDocument: 'NAJ-R101-2026-11',
  },
  {
    name: 'Technoservis Praha a.s.',
    originalId: '7a04529c-a661-4a73-beaf-bbf641896ce1',
    replacementId: 'e12a77c6-c624-46bf-88fe-13d8c386e008',
    sourceDocument: 'NAJ-A101-2026-10',
  },
] as const;

class RentalInvoiceRepairRejected extends Schema.TaggedError<RentalInvoiceRepairRejected>()(
  'RentalInvoiceRepairRejected',
  {
    reason: Schema.String,
  },
) {}

const CorrectableInvoiceSchema = Schema.Struct({
  ...InvoiceSchema.fields,
  documentKind: Schema.requiredKey(InvoiceSchema.fields.documentKind),
  lines: Schema.requiredKey(InvoiceSchema.fields.lines),
  recurringPeriod: Schema.requiredKey(InvoiceSchema.fields.recurringPeriod),
  recurringTemplateId: Schema.requiredKey(InvoiceSchema.fields.recurringTemplateId),
}).check(
  Schema.makeFilter(
    (invoice) =>
      invoice.businessState === 'CONFIRMED' &&
      invoice.note?.includes('demo-v2-seed') === true &&
      invoice.ref.tenantId === rentalRepairScope.tenantId &&
      invoice.paidMinor === 0 &&
      invoice.accountingSyncState === 'NOT_SYNCED',
  ),
);

const replacementMatches = (old: Invoice, replacement: Invoice, source: Invoice): boolean =>
  old.businessState === 'VOIDED' &&
  replacement.correctsInvoiceRef?.resourceId === old.ref.resourceId &&
  replacement.businessState === 'CONFIRMED' &&
  replacement.totalMinor === old.totalMinor &&
  replacement.counterpartyRef.resourceId === source.counterpartyRef.resourceId;

const repairRentalDuplicate = Effect.fn('Finance.repairRentalDuplicate')(function* repairRentalDuplicateProgram(
  original: FinanceState,
  now: DateTime.Utc,
) {
  let state = original;
  const duplicate = state.invoices.find((entry) => entry.ref.resourceId === '8471308c-6070-4f0b-a9a1-545e30b698ee');
  const retained = state.invoices.find((entry) => entry.ref.resourceId === '23e891be-5ab3-462c-84fd-d628605a068b');
  if (duplicate === undefined || retained === undefined) {
    return yield* new RentalInvoiceRepairRejected({ reason: 'Missing duplicate fixture' });
  }
  if (duplicate.businessState !== 'VOIDED') {
    if (
      duplicate.businessState !== 'DRAFT' ||
      retained.businessState !== 'DRAFT' ||
      duplicate.totalMinor !== retained.totalMinor ||
      duplicate.issueDate !== retained.issueDate ||
      duplicate.counterpartyRef.resourceId !== retained.counterpartyRef.resourceId ||
      duplicate.occupancyRef?.resourceId !== retained.occupancyRef?.resourceId
    ) {
      return yield* new RentalInvoiceRepairRejected({
        reason: 'Duplicate draft no longer matches; refusing cancellation',
      });
    }
    const result = yield* transitionFinance(
      state,
      { _tag: 'VoidInvoice', invoiceRef: duplicate.ref },
      rentalRepairScope,
      { invoice: () => Effect.void },
      {
        attemptId: `rental-fixture-repair:${duplicate.ref.resourceId}`,
        now,
        principalId: '72000000-0000-4000-8000-000000000023',
        resourceId: duplicate.ref.resourceId,
      },
    );
    ({ state } = result);
  }
  // Register the retained rental-lane draft with the recurrence guard before cancelling its duplicate.
  const linkedRetained = state.invoices.find((entry) => entry.ref.resourceId === retained.ref.resourceId);
  if (linkedRetained === undefined) {
    return yield* new RentalInvoiceRepairRejected({
      reason: 'Retained draft disappeared during duplicate cancellation',
    });
  }
  if (linkedRetained.recurringTemplateId === undefined && duplicate.recurringTemplateId !== undefined) {
    const { recurringTemplateId } = duplicate;
    state = {
      ...state,
      invoices: state.invoices.map((entry) =>
        entry.ref.resourceId === retained.ref.resourceId
          ? {
              ...entry,
              documentKind: 'RECURRING' as const,
              recurringPeriod: retained.issueDate.slice(0, 7),
              recurringTemplateId,
            }
          : entry,
      ),
    };
  }
  return state;
});

/** Owner-only fixture repair. Issued customers, amounts, payments and signed exports are never overwritten. */
export const repairRentalInvoices = Effect.fn('Finance.repairRentalInvoices')(function* repairRentalInvoicesProgram(
  original: FinanceState,
  now: DateTime.Utc,
) {
  let state = original;
  const apply = Effect.fn('Finance.repairRentalInvoices.apply')(function* applyRepairCommand(
    command: FinanceCommand,
    resourceId: string,
  ) {
    const result = yield* transitionFinance(
      state,
      command,
      rentalRepairScope,
      { invoice: () => Effect.void },
      {
        attemptId: `rental-fixture-repair:${resourceId}`,
        now,
        principalId: '72000000-0000-4000-8000-000000000023',
        resourceId,
      },
    );
    ({ state } = result);
    return result;
  });

  for (const correction of rentalInvoiceCorrections) {
    const old = state.invoices.find((entry) => entry.ref.resourceId === correction.originalId);
    const replacement = state.invoices.find((entry) => entry.ref.resourceId === correction.replacementId);
    const source = state.invoices.find((entry) => entry.documentNumber === correction.sourceDocument);
    if (
      old === undefined ||
      source?.occupancyRef === undefined ||
      source.partyId === undefined ||
      source.contractRef === undefined ||
      source.propertyRef === undefined ||
      source.unitRef === undefined
    ) {
      return yield* new RentalInvoiceRepairRejected({
        reason: 'Missing scoped rental fixture; refusing partial repair',
      });
    }
    if (replacement !== undefined) {
      if (!replacementMatches(old, replacement, source)) {
        return yield* new RentalInvoiceRepairRejected({
          reason: 'Unexpected replacement state; manual review required',
        });
      }
      continue;
    }
    if (
      !Schema.is(CorrectableInvoiceSchema)(old) ||
      state.accountingExports?.some((entry) =>
        entry.invoiceResourceIds.some((invoiceResourceId) => invoiceResourceId === old.ref.resourceId),
      ) === true
    ) {
      return yield* new RentalInvoiceRepairRejected({
        reason: 'Issued fixture has changed or was handed over; refusing automatic repair',
      });
    }
    yield* apply({ _tag: 'VoidInvoice', invoiceRef: old.ref }, old.ref.resourceId);
    const draft = yield* apply(
      {
        _tag: 'CreateInvoiceDraft',
        contractRef: source.contractRef,
        counterpartyRef: source.counterpartyRef,
        currency: old.currency,
        direction: old.direction,
        documentNumber: `OPR-${old.number ?? old.documentNumber}`,
        dueDate: old.dueDate,
        issueDate: old.issueDate,
        lines: old.lines,
        note: `DEMO: náhradní doklad k ${old.number ?? old.documentNumber} po stornu chybného odběratele. Původní částka a období zachovány.`,
        occupancyRef: source.occupancyRef,
        partyId: source.partyId,
        propertyRef: source.propertyRef,
        unitRef: source.unitRef,
      },
      correction.replacementId,
    );
    if (draft.invoice?.totalMinor !== old.totalMinor) {
      return yield* new RentalInvoiceRepairRejected({ reason: 'Replacement changed invoice amount' });
    }
    // Capture narrowed values before crossing into the map callback.
    const { documentKind, recurringPeriod, recurringTemplateId } = old;
    // Only the newly created draft receives display/recurrence/correction metadata.
    state = {
      ...state,
      invoices: state.invoices.map((entry) => {
        if (entry.ref.resourceId !== correction.replacementId) {
          return entry;
        }
        const updated = {
          ...entry,
          correctsInvoiceRef: old.ref,
          counterpartyName: correction.name,
          documentKind,
          recurringPeriod,
          recurringTemplateId,
        };
        return old.budgetCategory === undefined ? updated : { ...updated, budgetCategory: old.budgetCategory };
      }),
    };
    yield* apply({ _tag: 'MarkInvoicesPrepared', invoiceRefs: [draft.invoice.ref] }, correction.replacementId);
    yield* apply({ _tag: 'ConfirmInvoice', invoiceRef: draft.invoice.ref }, correction.replacementId);
  }
  return yield* repairRentalDuplicate(state, now);
});
