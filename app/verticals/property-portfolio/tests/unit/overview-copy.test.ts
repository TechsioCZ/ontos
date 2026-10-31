import { DateTime } from 'effect';
import { expect, it } from 'effect-rstest';
import { addDays, attentionItems } from '../../src/routes/[lang]/nemovitosti/prehled/overview-model.ts';
import type { FinanceRecords, OverviewSources } from '../../src/routes/[lang]/nemovitosti/prehled/overview-model.ts';

it('uses Czech cardinal day forms in overdue invoice attention details', () => {
  const now = DateTime.makeUnsafe('2026-10-20T00:00:00Z');
  const tenantId = '70000000-0000-4000-8000-000000000020';
  for (const [days, copy] of [
    [1, '1 den'],
    [2, '2 dny'],
    [4, '4 dny'],
    [5, '5 dní'],
    [21, '21 dní'],
  ] as const) {
    const finance: FinanceRecords = {
      canWrite: true,
      indicators: {
        costMinor: 0,
        costVarianceMinor: 0,
        draftCount: 0,
        grossOutstandingMinor: 60_000,
        openIncomingInvoices: 0,
        openInvoices: 1,
        openOutgoingInvoices: 1,
        overdueInvoices: 1,
        payablesOutstandingMinor: 0,
        plannedCostMinor: 0,
        plannedRevenueMinor: 0,
        receivablesOutstandingMinor: 60_000,
        revenueMinor: 100_000,
        revenueVarianceMinor: 100_000,
      },
      referenceDate: '2026-10-05',
      revision: 0,
      state: {
        financialPlanEntries: [],

        invoices: [
          {
            accountingCorrelation: 'invoice-correlation',
            accountingSyncState: 'NOT_SYNCED',
            businessState: 'CONFIRMED',
            counterpartyRef: {
              moduleId: 'party.registry',
              resourceId: 'counterparty',
              resourceType: 'party.registry.counterparty',
              tenantId,
            },
            createdAt: now,
            currency: 'CZK',
            direction: 'OUTGOING',
            documentNumber: 'FV-2026-0007',
            dueDate: addDays('2026-10-20', -days),
            issueDate: '2026-09-01',
            paidMinor: 40_000,
            paymentState: 'PARTIALLY_PAID',
            ref: {
              moduleId: 'finance.billing',
              resourceId: 'invoice',
              resourceType: 'finance.billing.invoice',
              tenantId,
            },
            totalMinor: 100_000,
            updatedAt: now,
          },
        ],
      },
    };
    const sources: OverviewSources = {
      agreements: { status: 'unavailable' },
      finance: { data: finance, status: 'ready' },
      occupancy: { status: 'unavailable' },
      property: { status: 'unavailable' },
      work: { status: 'unavailable' },
    };
    const items = attentionItems(sources, '2026-10-20', 'cs');
    expect(items).toHaveLength(1);
    expect(items[0]?.detail).toContain(`${copy} po splatnosti`);
    expect(items[0]?.detail).toContain('600');
  }
});
