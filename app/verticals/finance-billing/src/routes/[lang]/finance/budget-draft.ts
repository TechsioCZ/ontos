// A budget line and the opening balance as the planning forms edit them: nothing is sent until Uložit.
import type { BudgetLine, CashFlowOpening } from '../../../../shared/apis/records.ts';
import { minorToInput, parseAmountMinor } from './finance-ui.tsx';
import type { FinanceCommandDraft, FinanceViewModel } from './finance-ui.tsx';
import { emptyObjectSelection, objectAnchors } from './object-fields.tsx';
import type { ObjectSelection } from './object-fields.tsx';

export interface BudgetDraft {
  readonly actual: string;
  readonly category: string;
  readonly existing?: Pick<BudgetLine, 'propertyRef' | 'unitRef'>;
  readonly explanation: string;
  readonly id?: string;
  readonly kind: BudgetLine['kind'];
  readonly object: ObjectSelection;
  readonly planned: string;
}

export const newBudgetDraft = (): BudgetDraft => ({
  actual: '',
  category: 'Energie',
  explanation: '',
  kind: 'COST',
  object: emptyObjectSelection,
  planned: '',
});

export const editBudgetDraft = (budget: BudgetLine): BudgetDraft => ({
  actual: minorToInput(budget.actualManualMinor),
  category: budget.category,
  existing: budget,
  explanation: budget.explanation ?? '',
  id: budget.id,
  kind: budget.kind,
  object: {
    contractId: '',
    costCenter: budget.costCenter ?? '',
    propertyId: budget.propertyRef?.resourceId ?? '',
    unitId: budget.unitRef?.resourceId ?? '',
  },
  planned: minorToInput(budget.plannedMinor),
});

export const BUDGET_INVALID = 'Zkontrolujte kategorii a částky (např. 25 000 nebo 25 000,50).';

/** The planned and manual actual amounts of a draft; undefined while the category or an amount is invalid. */
export const budgetAmounts = (
  draft: BudgetDraft,
): { readonly actual: number | undefined; readonly planned: number } | undefined => {
  const planned = parseAmountMinor(draft.planned === '' ? '0' : draft.planned);
  const actual = draft.actual.trim() === '' ? undefined : parseAmountMinor(draft.actual);
  if (planned === undefined || (draft.actual.trim() !== '' && actual === undefined) || draft.category.trim() === '') {
    return undefined;
  }
  return { actual, planned };
};

export const buildBudgetLineCommand = ({
  actual,
  budgetMonth,
  draft,
  planned,
  vm,
}: {
  readonly actual?: number | undefined;
  readonly budgetMonth: string;
  readonly draft: BudgetDraft;
  readonly planned: number;
  readonly vm: Pick<FinanceViewModel, 'actorLabel' | 'objects'>;
}): FinanceCommandDraft<'UpsertBudgetLine'> => {
  const upsertBudgetLineCommand: FinanceCommandDraft<'UpsertBudgetLine'> = {
    _tag: 'UpsertBudgetLine',
    category: draft.category.trim(),
    kind: draft.kind,
    period: budgetMonth,
    plannedMinor: planned,
    ...objectAnchors(
      vm.objects,
      { ...draft.object, contractId: '' },
      draft.id === undefined ? undefined : draft.existing,
    ),
  };
  if (vm.actorLabel !== undefined) {
    upsertBudgetLineCommand.actorLabel = vm.actorLabel;
  }
  if (actual !== undefined) {
    upsertBudgetLineCommand.actualManualMinor = actual;
  }
  if (draft.explanation.trim() !== '') {
    upsertBudgetLineCommand.explanation = draft.explanation.trim();
  }
  if (draft.id !== undefined) {
    upsertBudgetLineCommand.id = draft.id;
  }
  return upsertBudgetLineCommand;
};

export interface OpeningDraft {
  readonly amount: string;
  readonly date: string;
}

/** The confirmed opening balance in the form's shape; an unset one opens empty on the first day of `month`. */
export const openingDraftOf = (opening: CashFlowOpening | undefined, month: string): OpeningDraft => ({
  amount: minorToInput(opening?.openingBalanceMinor),
  date: opening?.openingDate ?? `${month}-01`,
});

export const OPENING_INVALID = 'Zadejte počáteční stav a datum.';

/** SetOpeningBalance for a draft; undefined while the amount or date is missing. A leading minus is a negative balance. */
export const openingCommandOf = (
  draft: OpeningDraft,
  actorLabel: string | undefined,
): FinanceCommandDraft<'SetOpeningBalance'> | undefined => {
  const negative = draft.amount.trim().startsWith('-');
  const amount = parseAmountMinor(negative ? draft.amount.trim().slice(1) : draft.amount);
  if (amount === undefined || draft.date === '') {
    return undefined;
  }
  const command: FinanceCommandDraft<'SetOpeningBalance'> = {
    _tag: 'SetOpeningBalance',
    openingBalanceMinor: negative ? -amount : amount,
    openingDate: draft.date,
  };
  if (actorLabel !== undefined) {
    command.actorLabel = actorLabel;
  }
  return command;
};
