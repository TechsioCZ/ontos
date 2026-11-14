// A financial plan item as its form edits it: nothing is sent until Uložit.
import type { PlanItem } from '../../../../shared/apis/records.ts';
import { minorToInput, parseAmountMinor } from './finance-ui.tsx';
import type { FinanceCommandDraft, FinanceViewModel } from './finance-ui.tsx';
import { emptyObjectSelection, objectAnchors } from './object-fields.tsx';
import type { ObjectSelection } from './object-fields.tsx';

export interface PlanDraft {
  readonly amount: string;
  readonly existing?: Pick<PlanItem, 'contractRef' | 'propertyRef' | 'unitRef'>;
  readonly expectedDate: PlanItem['expectedDate'];
  readonly id?: string;
  readonly kind: PlanItem['kind'];
  readonly note: string;
  readonly object: ObjectSelection;
  readonly probability: string;
  readonly projectName: string;
  readonly title: string;
}

export const newPlanDraft = (date: string): PlanDraft => ({
  amount: '',
  expectedDate: date,
  kind: 'REVENUE',
  note: '',
  object: emptyObjectSelection,
  probability: '',
  projectName: '',
  title: '',
});

export const editPlanItemDraft = (item: PlanItem): PlanDraft => ({
  amount: minorToInput(item.amountMinor),
  existing: item,
  expectedDate: item.expectedDate,
  id: item.id,
  kind: item.kind,
  note: item.note ?? '',
  object: {
    contractId: item.contractRef?.resourceId ?? '',
    costCenter: '',
    propertyId: item.propertyRef?.resourceId ?? '',
    unitId: item.unitRef?.resourceId ?? '',
  },
  probability: item.probabilityPercent === undefined ? '' : String(item.probabilityPercent),
  projectName: item.projectName ?? '',
  title: item.title,
});

export const buildPlanItemCommand = ({
  amountMinor,
  draft,
  probability,
  vm,
}: {
  readonly amountMinor: number;
  readonly draft: PlanDraft;
  readonly probability?: number | undefined;
  readonly vm: Pick<FinanceViewModel, 'actorLabel' | 'objects'>;
}): FinanceCommandDraft<'UpsertPlanItem'> => {
  const upsertPlanItemCommand: FinanceCommandDraft<'UpsertPlanItem'> = {
    _tag: 'UpsertPlanItem',
    amountMinor,
    currency: 'CZK',
    expectedDate: draft.expectedDate,
    kind: draft.kind,
    title: draft.title.trim(),
    ...(({ costCenter: _costCenter, ...anchors }) => anchors)(
      objectAnchors(vm.objects, draft.object, draft.id === undefined ? undefined : draft.existing),
    ),
  };
  if (vm.actorLabel !== undefined) {
    upsertPlanItemCommand.actorLabel = vm.actorLabel;
  }
  if (draft.id !== undefined) {
    upsertPlanItemCommand.id = draft.id;
  }
  if (draft.note.trim() !== '') {
    upsertPlanItemCommand.note = draft.note.trim();
  }
  if (probability !== undefined) {
    upsertPlanItemCommand.probabilityPercent = probability;
  }
  if (draft.projectName.trim() !== '') {
    upsertPlanItemCommand.projectName = draft.projectName.trim();
  }
  return upsertPlanItemCommand;
};

const parsedProbability = (draft: PlanDraft) =>
  draft.probability.trim() === '' ? undefined : Number(draft.probability.replace('%', '').trim());

/** Why the draft cannot be saved yet, or undefined when it can. */
export const planItemProblem = (draft: PlanDraft): string | undefined => {
  const amountMinor = parseAmountMinor(draft.amount);
  if (draft.title.trim() === '' || amountMinor === undefined || amountMinor === 0 || draft.expectedDate === '') {
    return 'Vyplňte název, kladnou částku a očekávané datum.';
  }
  const probability = parsedProbability(draft);
  if (probability !== undefined && (!Number.isInteger(probability) || probability < 1 || probability > 100)) {
    return 'Pravděpodobnost zadejte jako celé číslo 1–100 %, nebo ji nechte prázdnou.';
  }
  return undefined;
};

/** UpsertPlanItem for a valid draft; undefined while `planItemProblem` reports something. */
export const planItemCommandOf = (
  draft: PlanDraft,
  vm: Pick<FinanceViewModel, 'actorLabel' | 'objects'>,
): FinanceCommandDraft<'UpsertPlanItem'> | undefined => {
  const amountMinor = parseAmountMinor(draft.amount);
  if (planItemProblem(draft) !== undefined || amountMinor === undefined) {
    return undefined;
  }
  return buildPlanItemCommand({ amountMinor, draft, probability: parsedProbability(draft), vm });
};
