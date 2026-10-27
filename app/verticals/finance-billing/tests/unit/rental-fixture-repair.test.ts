import { FinanceRecurringTemplateIdSchema } from '../../shared/apis/records.ts';
import { describe, expect, it } from 'effect-rstest';
import { DateTime, Effect, Exit, Schema } from 'effect';
import type { FinanceState, Invoice } from '../../shared/apis/records.ts';
import {
  repairRentalInvoices,
  rentalInvoiceCorrections,
  rentalRepairScope,
} from '../../scripts/repair-rental-invoices.ts';
import { transitionFinance } from '../../src/services/persistence.service.ts';
import { alignRentalTemplates } from '../../scripts/align-rental-templates.ts';

const now = DateTime.makeUnsafe('2026-10-20T20:00:00Z');
const { tenantId } = rentalRepairScope;
const ref = (id: string): Invoice['ref'] => ({
  moduleId: 'finance.billing',
  resourceId: id,
  resourceType: 'finance.billing.invoice',
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
        resourceId: `wrong-${index}`,
        resourceType: 'party.registry.counterparty',
        tenantId,
      },
      createdAt: now,
      currency: 'CZK',
      direction: 'OUTGOING',
      documentKind: 'RECURRING',
      documentNumber: `FV-2026-000${index + 5}`,
      dueDate: '2026-10-15',
      issueDate: '2026-10-01',
      lines: [{ description: 'Nájemné – říjen 2026', quantity: 1, unitPriceMinor: 10_000, vatRate: 21 }],
      note: 'Vydaná faktura (demo-v2-seed)',
      number: `FV-2026-000${index + 5}`,
      paidMinor: 0,
      paymentState: 'UNPAID',
      recurringPeriod: '2026-10',
      recurringTemplateId: Schema.decodeSync(FinanceRecurringTemplateIdSchema)(`template-${index}`),
      ref: ref(entry.originalId),
      totalMinor: 12_100,
      updatedAt: now,
    };
    return [
      base,
      {
        ...base,
        businessState: 'DRAFT',
        contractRef: {
          moduleId: 'legal.agreements',
          resourceId: `contract-${index}`,
          resourceType: 'legal.agreements.contract',
          tenantId,
        },
        counterpartyRef: { ...base.counterpartyRef, resourceId: `correct-${index}` },
        documentNumber: entry.sourceDocument,
        occupancyRef: {
          moduleId: 'property.leasing',
          resourceId: `lease-${index}`,
          resourceType: 'property.leasing.occupancy',
          tenantId,
        },
        partyId: `party-${index}`,
        propertyRef: {
          moduleId: 'property.portfolio',
          resourceId: `property-${index}`,
          resourceType: 'property.portfolio.property',
          tenantId,
        },
        ref: ref(`source-${index}`),
        unitRef: {
          moduleId: 'property.portfolio',
          resourceId: `unit-${index}`,
          resourceType: 'property.portfolio.unit',
          tenantId,
        },
      },
    ];
  });
  const [, base] = invoices;
  if (base === undefined || base.lines === undefined) {
    expect.unreachable('The rental source fixture must contain its invoice lines');
  }
  const { recurringPeriod: _period, recurringTemplateId: _template, ...unlinked } = base;
  const retained: Invoice = {
    ...unlinked,
    dueDate: '2026-11-10',
    issueDate: '2026-11-01',
    ref: ref('23e891be-5ab3-462c-84fd-d628605a068b'),
  };
  const duplicate: Invoice = {
    ...retained,
    documentNumber: 'FV-2026-0009',
    recurringPeriod: '2026-11',
    recurringTemplateId: Schema.decodeSync(FinanceRecurringTemplateIdSchema)('template-0'),
    ref: ref('8471308c-6070-4f0b-a9a1-545e30b698ee'),
  };
  return {
    financialPlanEntries: [],
    invoices: [...invoices, retained, duplicate],

    recurringTemplates: [
      {
        active: true,
        counterpartyRef: base.counterpartyRef,
        createdAt: now,
        dueDays: 9,
        id: Schema.decodeSync(FinanceRecurringTemplateIdSchema)('template-0'),
        issueDay: 1,
        lines: base.lines,
        name: 'Nájem R101',
      },
    ],
  };
};

describe('Siampark scoped rental fixture repair', () => {
  it.effect('preserves issued snapshots and exports, creates correctly anchored replacements, and is idempotent', () =>
    Effect.gen(function* replacementHistory() {
      const original = fixture();
      const repaired = yield* repairRentalInvoices(original, now);
      expect(repaired.invoices).toHaveLength(original.invoices.length + 2);
      for (const correction of rentalInvoiceCorrections) {
        const old = original.invoices.find((entry) => entry.ref.resourceId === correction.originalId);
        if (old === undefined) {
          expect.unreachable('The rental fixture must contain its old invoice');
        }
        expect(repaired.invoices.find((entry) => entry.ref.resourceId === correction.originalId)).toEqual({
          ...old,
          businessState: 'VOIDED',
          updatedAt: now,
        });
        const replacement = repaired.invoices.find((entry) => entry.ref.resourceId === correction.replacementId);
        if (replacement === undefined) {
          expect.unreachable('The rental fixture must contain its replacement invoice');
        }
        const source = original.invoices.find((entry) => entry.documentNumber === correction.sourceDocument);
        if (source === undefined) {
          expect.unreachable('The rental fixture must contain its source invoice');
        }
        expect(replacement).toMatchObject({
          businessState: 'CONFIRMED',
          correctsInvoiceRef: old.ref,
          counterpartyRef: source.counterpartyRef,
          dueDate: old.dueDate,
          issueDate: old.issueDate,
          lines: old.lines,
          occupancyRef: source.occupancyRef,
          paidMinor: 0,
          partyId: source.partyId,
          totalMinor: old.totalMinor,
        });
      }
      expect(repaired.accountingExports).toBe(original.accountingExports);
      expect(
        repaired.invoices.find((entry) => entry.ref.resourceId === '8471308c-6070-4f0b-a9a1-545e30b698ee')
          ?.businessState,
      ).toBe('VOIDED');
      expect(
        repaired.invoices.find((entry) => entry.ref.resourceId === '23e891be-5ab3-462c-84fd-d628605a068b'),
      ).toMatchObject({ businessState: 'DRAFT', recurringPeriod: '2026-11', recurringTemplateId: 'template-0' });
      expect(yield* repairRentalInvoices(repaired, DateTime.makeUnsafe('2026-10-21T00:00:00Z'))).toEqual(repaired);
      const generation = yield* transitionFinance(
        repaired,
        {
          _tag: 'GenerateRecurringInvoice',
          confirmDuplicate: false,
          period: '2026-11',
          templateId: yield* Schema.decodeEffect(FinanceRecurringTemplateIdSchema)('template-0'),
        },
        rentalRepairScope,
        { invoice: () => Effect.void },
        { attemptId: 'duplicate-check', now, resourceId: 'unexpected' },
      ).pipe(Effect.exit);
      expect(Exit.isFailure(generation)).toBe(true);
    }),
  );
  it.effect('refuses paid originals instead of erasing payment history', () =>
    Effect.gen(function* paidOriginals() {
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
    const [, source] = original.invoices;
    if (source === undefined || source.lines === undefined) {
      expect.unreachable('The rental fixture must contain its source invoice');
    }
    const aligned = alignRentalTemplates({
      ...original,
      recurringTemplates: [
        {
          active: true,
          counterpartyRef: source.counterpartyRef,
          createdAt: now,
          dueDays: 9,
          id: Schema.decodeSync(FinanceRecurringTemplateIdSchema)('template-0'),
          issueDay: 1,
          lines: source.lines,
          name: 'Nájem R101',
        },
      ],
    });
    expect(
      aligned.invoices.find((entry) => entry.ref.resourceId === '23e891be-5ab3-462c-84fd-d628605a068b'),
    ).toMatchObject({ recurringPeriod: '2026-11', recurringTemplateId: 'template-0' });
    expect(aligned.invoices[0]).toEqual(original.invoices[0]);
  });
});
