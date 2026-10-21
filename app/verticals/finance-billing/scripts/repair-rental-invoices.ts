import { DateTime, Effect } from 'effect';
import type { FinanceCommand } from '../shared/actions/apply-command.ts';
import type { FinanceState } from '../shared/apis/records.ts';
import { transitionFinance } from '../src/services/persistence.service.ts';

export const rentalRepairScope = {
  tenantId: '70000000-0000-4000-8000-000000000020',
  legalEntityId: '71000000-0000-4000-8000-000000000021',
};
export const rentalInvoiceCorrections = [
  {
    originalId: '6770419a-5ec7-483d-9935-9f3d0d401822',
    replacementId: 'e12a77c6-c624-46bf-88fe-13d8c386e005',
    sourceDocument: 'NAJ-R101-2026-11',
    name: 'Kavárna U Parku s.r.o.',
  },
  {
    originalId: '7a04529c-a661-4a73-beaf-bbf641896ce1',
    replacementId: 'e12a77c6-c624-46bf-88fe-13d8c386e008',
    sourceDocument: 'NAJ-A101-2026-10',
    name: 'Technoservis Praha a.s.',
  },
] as const;

/** Owner-only fixture repair. Issued customers, amounts, payments and signed exports are never overwritten. */
export const repairRentalInvoices = (original: FinanceState, now: DateTime.Utc) =>
  Effect.gen(function* () {
    let state = original;
    const apply = (command: FinanceCommand, resourceId: string) =>
      transitionFinance(
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
      ).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            state = result.state;
          }),
        ),
      );

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
        return yield* Effect.die('Missing scoped rental fixture; refusing partial repair');
      }
      if (replacement !== undefined) {
        if (
          old.businessState !== 'VOIDED' ||
          replacement.correctsInvoiceRef?.resourceId !== old.ref.resourceId ||
          replacement.businessState !== 'CONFIRMED' ||
          replacement.totalMinor !== old.totalMinor ||
          replacement.counterpartyRef.resourceId !== source.counterpartyRef.resourceId
        ) {
          return yield* Effect.die('Unexpected replacement state; manual review required');
        }
        continue;
      }
      if (
        old.businessState !== 'CONFIRMED' ||
        old.note?.includes('demo-v2-seed') !== true ||
        old.ref.tenantId !== rentalRepairScope.tenantId ||
        old.lines === undefined ||
        old.paidMinor !== 0 ||
        old.accountingSyncState !== 'NOT_SYNCED' ||
        old.recurringTemplateId === undefined ||
        old.recurringPeriod === undefined ||
        old.documentKind === undefined ||
        state.accountingExports?.some((entry) => entry.invoiceResourceIds.includes(old.ref.resourceId)) === true
      ) {
        return yield* Effect.die('Issued fixture has changed or was handed over; refusing automatic repair');
      }
      yield* apply({ _tag: 'VoidInvoice', invoiceRef: old.ref }, old.ref.resourceId);
      const draft = yield* apply(
        {
          _tag: 'CreateInvoiceDraft',
          counterpartyRef: source.counterpartyRef,
          partyId: source.partyId,
          contractRef: source.contractRef,
          occupancyRef: source.occupancyRef,
          propertyRef: source.propertyRef,
          unitRef: source.unitRef,
          currency: old.currency,
          direction: old.direction,
          documentNumber: `OPR-${old.number ?? old.documentNumber}`,
          issueDate: old.issueDate,
          dueDate: old.dueDate,
          lines: old.lines,
          note: `DEMO: náhradní doklad k ${old.number ?? old.documentNumber} po stornu chybného odběratele. Původní částka a období zachovány.`,
        },
        correction.replacementId,
      );
      if (draft.invoice?.totalMinor !== old.totalMinor) return yield* Effect.die('Replacement changed invoice amount');
      // Capture narrowed values before crossing into the map callback.
      const { documentKind, recurringPeriod, recurringTemplateId } = old;
      // Only the newly created draft receives display/recurrence/correction metadata.
      state = {
        ...state,
        invoices: state.invoices.map((entry) =>
          entry.ref.resourceId === correction.replacementId
            ? {
                ...entry,
                ...(old.budgetCategory === undefined ? {} : { budgetCategory: old.budgetCategory }),
                counterpartyName: correction.name,
                correctsInvoiceRef: old.ref,
                documentKind,
                recurringPeriod,
                recurringTemplateId,
              }
            : entry,
        ),
      };
      yield* apply({ _tag: 'MarkInvoicesPrepared', invoiceRefs: [draft.invoice.ref] }, correction.replacementId);
      yield* apply({ _tag: 'ConfirmInvoice', invoiceRef: draft.invoice.ref }, correction.replacementId);
    }
    const duplicate = state.invoices.find((entry) => entry.ref.resourceId === '8471308c-6070-4f0b-a9a1-545e30b698ee');
    const retained = state.invoices.find((entry) => entry.ref.resourceId === '23e891be-5ab3-462c-84fd-d628605a068b');
    if (duplicate === undefined || retained === undefined) return yield* Effect.die('Missing duplicate fixture');
    if (duplicate.businessState !== 'VOIDED') {
      if (
        duplicate.businessState !== 'DRAFT' ||
        retained.businessState !== 'DRAFT' ||
        duplicate.totalMinor !== retained.totalMinor ||
        duplicate.issueDate !== retained.issueDate ||
        duplicate.counterpartyRef.resourceId !== retained.counterpartyRef.resourceId ||
        duplicate.occupancyRef?.resourceId !== retained.occupancyRef?.resourceId
      ) {
        return yield* Effect.die('Duplicate draft no longer matches; refusing cancellation');
      }
      yield* apply({ _tag: 'VoidInvoice', invoiceRef: duplicate.ref }, duplicate.ref.resourceId);
    }
    // Register the retained rental-lane draft with the recurrence guard before cancelling its duplicate.
    const linkedRetained = state.invoices.find((entry) => entry.ref.resourceId === retained.ref.resourceId)!;
    if (linkedRetained.recurringTemplateId === undefined && duplicate.recurringTemplateId !== undefined) {
      const recurringTemplateId = duplicate.recurringTemplateId;
      state = {
        ...state,
        invoices: state.invoices.map((entry) =>
          entry.ref.resourceId === retained.ref.resourceId
            ? {
                ...entry,
                documentKind: 'RECURRING' as const,
                recurringTemplateId,
                recurringPeriod: retained.issueDate.slice(0, 7),
              }
            : entry,
        ),
      };
    }
    return state;
  });
