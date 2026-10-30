import { DateTime } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import type { BudgetLine, PlanItem } from '../../shared/apis/records.ts';
import { emptyObjectSelection } from '../../src/routes/[lang]/finance/object-fields.tsx';
import type { ObjectSelection } from '../../src/routes/[lang]/finance/object-fields.tsx';
import { buildPlanItemCommand, editPlanItemDraft } from '../../src/routes/[lang]/finance/plan-items-section.tsx';
import { buildBudgetLineCommand, editBudgetDraft } from '../../src/routes/[lang]/finance/planning-panel.tsx';
import type { RentalObjects } from '../../src/routes/[lang]/finance/use-rental-objects.ts';

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
const planItem: PlanItem = {
  amountMinor: 10_000,
  contractRef,
  createdAt: now,
  currency: 'CZK',
  expectedDate: '2026-10-30',
  id: 'plan-1',
  kind: 'REVENUE',
  propertyRef,
  title: 'Nájem',
  unitRef,
  updatedAt: now,
};
const budget: BudgetLine = {
  category: 'Nájem',
  id: 'budget-1',
  kind: 'COST',
  period: '2026-10',
  plannedMinor: 10_000,
  propertyRef,
  unitRef,
  updatedAt: now,
};
const unavailableName = (): undefined => {
  // Labels are unavailable while rental options are empty.
};
const objects = {
  available: false,
  contractName: unavailableName,
  contracts: [],
  properties: [],
  propertyName: unavailableName,
  unitName: unavailableName,
  units: [],
} satisfies RentalObjects;
const vm = { actorLabel: 'Editor', objects };
const selection: ObjectSelection = {
  contractId: contractRef.resourceId,
  costCenter: '',
  propertyId: propertyRef.resourceId,
  unitId: unitRef.resourceId,
};

const callers = [
  {
    build: (object: ObjectSelection) =>
      buildPlanItemCommand({
        amountMinor: 20_000,
        draft: { ...editPlanItemDraft(planItem), object },
        vm,
      }),
    expected: {
      _tag: 'UpsertPlanItem',
      actorLabel: 'Editor',
      amountMinor: 20_000,
      contractRef,
      currency: 'CZK',
      expectedDate: planItem.expectedDate,
      id: planItem.id,
      kind: planItem.kind,
      propertyRef,
      title: planItem.title,
      unitRef,
    },
    label: 'planned item',
  },
  {
    build: (object: ObjectSelection) =>
      buildBudgetLineCommand({
        budgetMonth: budget.period,
        draft: { ...editBudgetDraft(budget), object },
        planned: 20_000,
        vm,
      }),
    expected: {
      _tag: 'UpsertBudgetLine',
      actorLabel: 'Editor',
      category: budget.category,
      id: budget.id,
      kind: budget.kind,
      period: budget.period,
      plannedMinor: 20_000,
      propertyRef,
      unitRef,
    },
    label: 'budget line',
  },
];

const expectNoAnchors = (command: ReturnType<(typeof callers)[number]['build']>) => {
  expect(command).not.toHaveProperty('propertyRef');
  expect(command).not.toHaveProperty('unitRef');
  expect(command).not.toHaveProperty('contractRef');
};

describe('Planning editor command callers with unavailable rental options', () => {
  for (const { build, expected, label } of callers) {
    it(`keeps typed original references when editing a ${label}`, () => {
      const command = build(selection);
      expect(command).toEqual(expected);
      expect(command.propertyRef).toBe(propertyRef);
      expect(command.unitRef).toBe(unitRef);
      expect(command.actorLabel).toBe('Editor');
    });

    it(`removes references after explicit Bez vazby for a ${label}`, () => {
      expectNoAnchors(build(emptyObjectSelection));
    });

    it(`does not invent references for changed unavailable IDs in a ${label}`, () => {
      expectNoAnchors(
        build({ ...selection, contractId: 'other-contract', propertyId: 'other-property', unitId: 'other-unit' }),
      );
    });

    it(`does not keep the original unit under a changed property in a ${label}`, () => {
      const command = build({ ...selection, propertyId: 'other-property' });
      expect(command).not.toHaveProperty('propertyRef');
      expect(command).not.toHaveProperty('unitRef');
    });

    it(`can explicitly clear just the unit in a ${label}`, () => {
      const command = build({ ...selection, unitId: '' });
      expect(command.propertyRef).toBe(propertyRef);
      expect(command).not.toHaveProperty('unitRef');
    });
  }

  it('does not manufacture references in either create flow', () => {
    expectNoAnchors(
      buildPlanItemCommand({
        amountMinor: 20_000,
        draft: {
          amount: '200',
          expectedDate: planItem.expectedDate,
          kind: planItem.kind,
          note: '',
          object: selection,
          probability: '',
          projectName: '',
          title: planItem.title,
        },
        vm,
      }),
    );
    expectNoAnchors(
      buildBudgetLineCommand({
        budgetMonth: budget.period,
        draft: {
          actual: '',
          category: budget.category,
          explanation: '',
          kind: budget.kind,
          object: selection,
          planned: '200',
        },
        planned: 20_000,
        vm,
      }),
    );
  });
});
