// A price list item as the price list dialog edits it: created once, saved on the explicit Uložit.
import type { SaveOutcome } from '@app/admin-ui';
import { Option } from 'effect';
import type { PriceListItem, VatRate } from '../../../../shared/apis/records.ts';
import { minorToInput, parseAmountMinor } from './finance-ui.tsx';
import type { FinanceCommandDraft } from './finance-ui.tsx';

export interface ItemDraft {
  readonly code: string;
  readonly name: string;
  readonly price: string;
  readonly unit: string;
  readonly vatRate: VatRate;
}

export const emptyItem: ItemDraft = { code: '', name: '', price: '', unit: 'měsíc', vatRate: 21 };

export const itemDraftOf = (item: PriceListItem): ItemDraft => ({
  code: item.code ?? '',
  name: item.name,
  price: minorToInput(item.unitPriceMinor),
  unit: item.unit ?? '',
  vatRate: item.vatRate,
});

/** Drafts that store the same item: surrounding spaces do not count. */
export const sameItemDraft = (left: ItemDraft, right: ItemDraft): boolean =>
  left.code.trim() === right.code.trim() &&
  left.name.trim() === right.name.trim() &&
  left.price.trim() === right.price.trim() &&
  left.unit.trim() === right.unit.trim() &&
  left.vatRate === right.vatRate;

export interface ItemProblems {
  readonly name: boolean;
  readonly price: boolean;
}

export const itemProblems = (draft: ItemDraft): ItemProblems => ({
  name: draft.name.trim() === '',
  price: parseAmountMinor(draft.price) === undefined,
});

/**
 * The upsert a draft sends; None while the name or price is invalid, so an invalid draft is never saved. `existing`
 * keeps the item's id and offer state when it is edited.
 */
export const itemCommandOf = (
  draft: ItemDraft,
  existing?: PriceListItem,
  actorLabel?: string,
): Option.Option<FinanceCommandDraft<'UpsertPriceListItem'>> => {
  const price = parseAmountMinor(draft.price);
  if (draft.name.trim() === '' || price === undefined) {
    return Option.none();
  }
  const command: FinanceCommandDraft<'UpsertPriceListItem'> = {
    _tag: 'UpsertPriceListItem',
    active: existing?.active ?? true,
    name: draft.name.trim(),
    unitPriceMinor: price,
    vatRate: draft.vatRate,
  };
  if (actorLabel !== undefined) {
    command.actorLabel = actorLabel;
  }
  if (draft.code.trim() !== '') {
    command.code = draft.code.trim();
  }
  if (existing !== undefined) {
    command.id = existing.id;
  }
  if (draft.unit.trim() !== '') {
    command.unit = draft.unit.trim();
  }
  return Option.some(command);
};

/** Whether the price list still holds the item as the draft's base version. */
export const itemUnchangedSince =
  (id: string, base: ItemDraft) =>
  (items: readonly PriceListItem[]): boolean => {
    const current = items.find((item) => item.id === id);
    return current !== undefined && sameItemDraft(itemDraftOf(current), base);
  };

/**
 * A finance command outcome as a save sees it: a write is saved, a concurrent change a conflict, a change parked
 * for approval is proposed (nothing saved yet, and not a failure), anything else a failure.
 */
export const financeSaveOutcome = (
  outcome: { readonly ok: true } | { readonly feedback: string; readonly ok: false },
): SaveOutcome => {
  if (outcome.ok) {
    return 'saved';
  }
  if (outcome.feedback === 'pendingApproval') {
    return 'proposed';
  }
  return outcome.feedback === 'conflict' ? 'conflict' : 'failed';
};
