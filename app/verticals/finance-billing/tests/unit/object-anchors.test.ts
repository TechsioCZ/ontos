import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it, rstest } from 'effect-rstest';
import { FinanceCommandSchema } from '../../shared/actions/apply-command.ts';
import type { FinanceState } from '../../shared/apis/records.ts';
import { emptyObjectSelection, objectAnchors } from '../../src/routes/[lang]/finance/object-fields.tsx';
import type { RentalObjects } from '../../src/routes/[lang]/finance/use-rental-objects.ts';
import { transitionFinance } from '../../src/services/persistence.service.ts';

const tenantId = 'a0000000-0000-4000-8000-000000000001';
const propertyRef = {
  moduleId: 'property.portfolio',
  resourceId: 'a0000000-0000-4000-8000-000000000031',
  resourceType: 'property.portfolio.property',
  tenantId,
} as const;
const unitRef = {
  moduleId: 'property.portfolio',
  resourceId: 'a0000000-0000-4000-8000-000000000032',
  resourceType: 'property.portfolio.unit',
  tenantId,
} as const;
const contractRef = {
  moduleId: 'legal.agreements',
  resourceId: 'a0000000-0000-4000-8000-000000000033',
  resourceType: 'legal.agreements.contract',
  tenantId,
} as const;
const now = DateTime.makeUnsafe('2026-10-28T08:00:00Z');
const existing = { contractRef, propertyRef, unitRef };
const selection = {
  contractId: contractRef.resourceId,
  costCenter: '',
  propertyId: propertyRef.resourceId,
  unitId: unitRef.resourceId,
};
const unavailableObjects = {
  available: false,
  contractName: rstest.fn<RentalObjects['contractName']>(),
  contracts: [],
  properties: [],
  propertyName: rstest.fn<RentalObjects['propertyName']>(),
  unitName: rstest.fn<RentalObjects['unitName']>(),
  units: [],
} satisfies RentalObjects;
const state: FinanceState = {
  budgets: [
    {
      category: 'Nájem',
      id: 'budget-1',
      kind: 'COST',
      period: '2026-10',
      plannedMinor: 100,
      propertyRef,
      unitRef,
      updatedAt: now,
    },
  ],
  financialPlanEntries: [],
  invoices: [],
  planItems: [
    {
      ...existing,
      amountMinor: 100,
      createdAt: now,
      currency: 'CZK',
      expectedDate: '2026-10-30',
      id: 'plan-1',
      kind: 'REVENUE',
      title: 'Nájem',
      updatedAt: now,
    },
  ],
};
const run = (command: typeof FinanceCommandSchema.Encoded) =>
  Schema.decodeEffect(FinanceCommandSchema)(command).pipe(
    Effect.flatMap((decoded) =>
      transitionFinance(
        state,
        decoded,
        { legalEntityId: 'a0000000-0000-4000-8000-000000000002', tenantId },
        { anchors: () => Effect.void, invoice: () => Effect.void },
        { attemptId: 'edit-1', now, resourceId: 'unused' },
      ),
    ),
  );

// These are the same command spreads used by the plan-item and budget edit save paths.
const planCommand = (anchors: ReturnType<typeof objectAnchors>) => ({
  _tag: 'UpsertPlanItem' as const,
  amountMinor: 200,
  currency: 'CZK' as const,
  expectedDate: '2026-10-30',
  id: 'plan-1',
  kind: 'REVENUE' as const,
  title: 'Upravený nájem',
  ...anchors,
});
const budgetCommand = (anchors: ReturnType<typeof objectAnchors>) => ({
  _tag: 'UpsertBudgetLine' as const,
  category: 'Upravený nájem',
  id: 'budget-1',
  kind: 'COST' as const,
  period: '2026-10',
  plannedMinor: 200,
  ...anchors,
});

describe('Finance edit command object references', () => {
  for (const availability of ['pending', 'failed', 'forbidden', 'filtered-out']) {
    it.effect(`preserves typed existing references when option labels are ${availability}`, () =>
      Effect.gen(function* preserveExistingLinks() {
        const anchors = objectAnchors(unavailableObjects, selection, existing);
        expect(anchors).toEqual(existing);
        const plan = yield* run(planCommand(anchors));
        expect(plan.state.planItems?.[0]).toMatchObject({ ...existing, amountMinor: 200 });
        const budget = yield* run(
          budgetCommand(objectAnchors(unavailableObjects, { ...selection, contractId: '' }, existing)),
        );
        expect(budget.state.budgets?.[0]).toMatchObject({ plannedMinor: 200, propertyRef, unitRef });
      }),
    );
  }

  it.effect('keeps explicit unlinking distinct from unavailable option labels', () =>
    Effect.gen(function* unlinkExisting() {
      const anchors = objectAnchors(unavailableObjects, emptyObjectSelection, existing);
      expect(anchors).toEqual({});
      const plan = yield* run(planCommand(anchors));
      expect(plan.state.planItems?.[0]?.propertyRef).toBeUndefined();
      expect(plan.state.planItems?.[0]?.unitRef).toBeUndefined();
      expect(plan.state.planItems?.[0]?.contractRef).toBeUndefined();
      const budget = yield* run(budgetCommand(anchors));
      expect(budget.state.budgets?.[0]?.propertyRef).toBeUndefined();
      expect(budget.state.budgets?.[0]?.unitRef).toBeUndefined();
    }),
  );

  it('does not manufacture references for unknown new selections', () => {
    expect(objectAnchors(unavailableObjects, selection)).toEqual({});
    expect(
      objectAnchors(unavailableObjects, { ...selection, contractId: 'unknown', propertyId: 'unknown' }, existing),
    ).toEqual({});
    expect(objectAnchors(unavailableObjects, { ...selection, propertyId: '' }, existing)).toEqual({ contractRef });
  });

  it('does not carry an existing unit over to a different property', () => {
    const otherProperty = { ...propertyRef, resourceId: 'a0000000-0000-4000-8000-000000000034' };
    const objects = {
      ...unavailableObjects,
      available: true,
      properties: [{ code: 'B', label: 'B', ref: otherProperty }],
    };
    expect(objectAnchors(objects, { ...selection, propertyId: otherProperty.resourceId }, existing)).toEqual({
      contractRef,
      propertyRef: otherProperty,
    });
  });
});
