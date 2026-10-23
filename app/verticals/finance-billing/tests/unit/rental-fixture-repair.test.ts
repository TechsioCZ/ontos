import { describe, expect, it } from 'effect-rstest';
import { DateTime, Effect, Exit } from 'effect';
import type { FinanceState, Invoice } from '../../shared/apis/records.ts';
import {
  repairRentalInvoices,
  rentalInvoiceCorrections,
  rentalRepairScope,
} from '../../scripts/repair-rental-invoices.ts';
import { transitionFinance } from '../../src/services/persistence.service.ts';
import { alignRentalTemplates } from '../../scripts/align-rental-templates.ts';

const now = DateTime.makeUnsafe('2026-10-20T20:00:00Z');
const tenantId = rentalRepairScope.tenantId;
const ref = (id: string): Invoice['ref'] => ({
  moduleId: 'finance.billing',
  resourceType: 'finance.billing.invoice',
  resourceId: id,
  tenantId,
});
const fixture = (): FinanceState => {
  const invoices: Invoice[] = rentalInvoiceCorrections.flatMap((entry, index) => {
    const base: Invoice = {
      accountingCorrelation: `correlation-${index}`,
      accountingSyncState: 'NOT_SYNCED',
      businessState: 'CONFIRMED',
      counterpartyRef: {
        moduleId: 'party.registry',
        resourceType: 'party.registry.counterparty',
        resourceId: `wrong-${index}`,
        tenantId,
      },
      currency: 'CZK',
      direction: 'OUTGOING',
      documentNumber: `FV-2026-000${index + 5}`,
      number: `FV-2026-000${index + 5}`,
      dueDate: '2026-10-15',
      issueDate: '2026-10-01',
      note: 'Vydaná faktura (demo-v2-seed)',
      lines: [{ description: 'Nájemné – říjen 2026', quantity: 1, unitPriceMinor: 10000, vatRate: 21 }],
      totalMinor: 12100,
      paidMinor: 0,
      paymentState: 'UNPAID',
      createdAt: now,
      updatedAt: now,
      ref: ref(entry.originalId),
      recurringTemplateId: `template-${index}`,
      recurringPeriod: '2026-10',
      documentKind: 'RECURRING',
    };
    return [
      base,
      {
        ...base,
        businessState: 'DRAFT',
        documentNumber: entry.sourceDocument,
        ref: ref(`source-${index}`),
        counterpartyRef: { ...base.counterpartyRef, resourceId: `correct-${index}` },
        partyId: `party-${index}`,
        occupancyRef: {
          moduleId: 'property.leasing',
          resourceType: 'property.leasing.occupancy',
          resourceId: `lease-${index}`,
          tenantId,
        },
        contractRef: {
          moduleId: 'legal.agreements',
          resourceType: 'legal.agreements.contract',
          resourceId: `contract-${index}`,
          tenantId,
        },
        propertyRef: {
          moduleId: 'property.portfolio',
          resourceType: 'property.portfolio.property',
          resourceId: `property-${index}`,
          tenantId,
        },
        unitRef: {
          moduleId: 'property.portfolio',
          resourceType: 'property.portfolio.unit',
          resourceId: `unit-${index}`,
          tenantId,
        },
      },
    ];
  });
  const base = invoices[1]!;
  const { recurringTemplateId: _template, recurringPeriod: _period, ...unlinked } = base;
  const retained: Invoice = {
    ...unlinked,
    ref: ref('23e891be-5ab3-462c-84fd-d628605a068b'),
    issueDate: '2026-11-01',
    dueDate: '2026-11-10',
  };
  const duplicate: Invoice = {
    ...retained,
    ref: ref('8471308c-6070-4f0b-a9a1-545e30b698ee'),
    documentNumber: 'FV-2026-0009',
    recurringTemplateId: 'template-0',
    recurringPeriod: '2026-11',
  };
  return {
    invoices: [...invoices, retained, duplicate],
    financialPlanEntries: [],

    recurringTemplates: [
      {
        active: true,
        id: 'template-0',
        name: 'Nájem R101',
        counterpartyRef: base.counterpartyRef,
        dueDays: 9,
        issueDay: 1,
        lines: base.lines!,
        createdAt: now,
      },
    ],
  };
};

describe('Siampark scoped rental fixture repair', () => {
  it.effect('preserves issued snapshots and exports, creates correctly anchored replacements, and is idempotent', () =>
    Effect.gen(function* () {
      const original = fixture();
      const repaired = yield* repairRentalInvoices(original, now);
      expect(repaired.invoices).toHaveLength(original.invoices.length + 2);
      for (const correction of rentalInvoiceCorrections) {
        const old = original.invoices.find((entry) => entry.ref.resourceId === correction.originalId)!;
        expect(repaired.invoices.find((entry) => entry.ref.resourceId === correction.originalId)).toEqual({
          ...old,
          businessState: 'VOIDED',
          updatedAt: now,
        });
        const replacement = repaired.invoices.find((entry) => entry.ref.resourceId === correction.replacementId)!;
        const source = original.invoices.find((entry) => entry.documentNumber === correction.sourceDocument)!;
        expect(replacement).toMatchObject({
          businessState: 'CONFIRMED',
          counterpartyRef: source.counterpartyRef,
          partyId: source.partyId,
          occupancyRef: source.occupancyRef,
          correctsInvoiceRef: old.ref,
          lines: old.lines,
          totalMinor: old.totalMinor,
          issueDate: old.issueDate,
          dueDate: old.dueDate,
          paidMinor: 0,
        });
      }
      expect(repaired.accountingExports).toBe(original.accountingExports);
      expect(
        repaired.invoices.find((entry) => entry.ref.resourceId === '8471308c-6070-4f0b-a9a1-545e30b698ee')
          ?.businessState,
      ).toBe('VOIDED');
      expect(
        repaired.invoices.find((entry) => entry.ref.resourceId === '23e891be-5ab3-462c-84fd-d628605a068b'),
      ).toMatchObject({ businessState: 'DRAFT', recurringTemplateId: 'template-0', recurringPeriod: '2026-11' });
      expect(yield* repairRentalInvoices(repaired, DateTime.makeUnsafe('2026-10-21T00:00:00Z'))).toEqual(repaired);
      const generation = yield* transitionFinance(
        repaired,
        { _tag: 'GenerateRecurringInvoice', templateId: 'template-0', period: '2026-11', confirmDuplicate: false },
        rentalRepairScope,
        { invoice: () => Effect.void },
        { attemptId: 'duplicate-check', now, resourceId: 'unexpected' },
      ).pipe(Effect.exit);
      expect(Exit.isFailure(generation)).toBe(true);
    }),
  );
  it.effect('refuses paid originals instead of erasing payment history', () =>
    Effect.gen(function* () {
      const original = fixture();
      const result = yield* repairRentalInvoices(
        {
          ...original,
          invoices: original.invoices.map((entry, index) =>
            index === 0 ? { ...entry, paidMinor: 100, paymentState: 'PARTIALLY_PAID' } : entry,
          ),
        },
        now,
      ).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );
  it('registers anchored rental drafts with their template to prevent future duplicate generation', () => {
    const original = fixture();
    const source = original.invoices[1]!;
    const aligned = alignRentalTemplates({
      ...original,
      recurringTemplates: [
        {
          active: true,
          id: 'template-0',
          name: 'Nájem R101',
          counterpartyRef: source.counterpartyRef,
          dueDays: 9,
          issueDay: 1,
          lines: source.lines!,
          createdAt: now,
        },
      ],
    });
    expect(
      aligned.invoices.find((entry) => entry.ref.resourceId === '23e891be-5ab3-462c-84fd-d628605a068b'),
    ).toMatchObject({ recurringTemplateId: 'template-0', recurringPeriod: '2026-11' });
    expect(aligned.invoices[0]).toEqual(original.invoices[0]);
  });
});
