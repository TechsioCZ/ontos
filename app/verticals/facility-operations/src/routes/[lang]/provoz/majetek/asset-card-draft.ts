// The asset card's values: a new asset is submitted once, an edit of an existing one is sent on Uložit.
import { Option } from 'effect';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import { optionalField } from '../../../../../shared/domain/common.ts';
import type { PropertyRef } from '../../../../../shared/domain/common.ts';
import type { AcquisitionMethod, Asset, AssetKind } from '../../../../../shared/domain/assets.ts';
import { parseCzk } from './assets-model.ts';

type CreateFields = Omit<Extract<OpsCommand, { readonly _tag: 'AssetCreate' }>, '_tag'>;
/** The fields both create and update carry. */
type CardFields = Pick<
  CreateFields,
  | 'accountingProduct'
  | 'category'
  | 'kind'
  | 'location'
  | 'name'
  | 'note'
  | 'propertyId'
  | 'responsible'
  | 'serialNumber'
>;
type MutableCardFields = { -readonly [Key in keyof CardFields]: CardFields[Key] };
type UpdateCommand = Extract<OpsCommand, { readonly _tag: 'AssetUpdate' }>;

export interface AssetCardDraft {
  accountingProduct: string;
  /** Create only: an edit changes the value through a value change with a reason. */
  acquisitionDateInput: string;
  /** Create only. */
  acquisitionMethod: AcquisitionMethod;
  /** Create only: the typed amount (`12 500,50`). */
  acquisitionValue: string;
  category: string;
  inventoryNumber: string;
  kind: AssetKind;
  /** The picked location (`property:<id>` / `unit:<id>`), or '' for none. */
  location: string;
  name: string;
  note: string;
  /** Create only. */
  placedInServiceDateInput: string;
  responsible: string;
  serialNumber: string;
}

/** Where the card is placed: the picked location and the property it belongs to (both absent for none). */
export interface AssetPlacement {
  readonly location?: PropertyRef;
  readonly propertyId?: string;
}

const text = (value: string | undefined): string => value ?? '';

export const assetCardDraftOf = (asset?: Asset): AssetCardDraft => ({
  accountingProduct: text(asset?.accountingProduct),
  acquisitionDateInput: text(asset?.acquisitionDate),
  acquisitionMethod: asset?.acquisitionMethod ?? 'purchase',
  acquisitionValue: '',
  category: text(asset?.category),
  inventoryNumber: text(asset?.inventoryNumber),
  kind: asset?.kind ?? 'equipment',
  location: asset?.location === undefined ? '' : `${asset.location.kind}:${asset.location.id}`,
  name: text(asset?.name),
  note: text(asset?.note),
  placedInServiceDateInput: text(asset?.placedInServiceDate),
  responsible: text(asset?.responsible),
  serialNumber: text(asset?.serialNumber),
});

/** Optional free texts; blank ones are left out of a command (an update clears the stored value). */
const textKeys = ['accountingProduct', 'note', 'responsible', 'serialNumber'] as const;
/** Text fields whose surrounding spaces do not count when two drafts are compared. */
const trimmedKeys = [
  'accountingProduct',
  'acquisitionDateInput',
  'acquisitionValue',
  'category',
  'inventoryNumber',
  'name',
  'note',
  'placedInServiceDateInput',
  'responsible',
  'serialNumber',
] as const;

/** Drafts that describe the same card. */
export const sameAssetCardDraft = (left: AssetCardDraft, right: AssetCardDraft): boolean => {
  if (left.acquisitionMethod !== right.acquisitionMethod || left.kind !== right.kind) {
    return false;
  }
  if (left.location !== right.location) {
    return false;
  }
  return trimmedKeys.every((key) => left[key].trim() === right[key].trim());
};

export interface AssetCardProblems {
  /** The typed acquisition amount is not a number (create only). */
  readonly amount: boolean;
  readonly category: boolean;
  readonly inventoryNumber: boolean;
  readonly name: boolean;
}

export const assetCardProblems = (draft: AssetCardDraft): AssetCardProblems => ({
  amount: parseCzk(draft.acquisitionValue) === null,
  category: draft.category.trim() === '',
  inventoryNumber: draft.inventoryNumber.trim() === '',
  name: draft.name.trim() === '',
});

const anyProblem = (draft: AssetCardDraft): boolean => {
  const problems = assetCardProblems(draft);
  return problems.amount || problems.category || problems.inventoryNumber || problems.name;
};

/** The card fields a command carries: only filled-in optional values are sent. */
const cardFieldsOf = (draft: AssetCardDraft, placement: AssetPlacement): MutableCardFields => {
  const fields: MutableCardFields = {
    category: draft.category.trim(),
    kind: draft.kind,
    name: draft.name.trim(),
  };
  for (const key of textKeys) {
    const value = draft[key].trim();
    if (value !== '') {
      fields[key] = value;
    }
  }
  if (placement.location !== undefined) {
    fields.location = placement.location;
  }
  if (placement.propertyId !== undefined) {
    fields.propertyId = placement.propertyId;
  }
  return fields;
};

const optionalText = (value: string) => {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/** The create a new asset card sends; None while a required field or the amount is missing. */
export const assetCardCreateCommandOf = (
  draft: AssetCardDraft,
  placement: AssetPlacement,
): Option.Option<OpsCommand> => {
  const amount = parseCzk(draft.acquisitionValue);
  if (anyProblem(draft) || amount === null) {
    return Option.none();
  }
  const fields = cardFieldsOf(draft, placement);
  return Option.some({
    _tag: 'AssetCreate',
    ...fields,
    acquisitionMethod: draft.acquisitionMethod,
    inventoryNumber: draft.inventoryNumber.trim(),
    ...optionalField('acquisitionDate', optionalText(draft.acquisitionDateInput)),
    ...optionalField('acquisitionValueMinor', amount),
    ...optionalField('placedInServiceDate', optionalText(draft.placedInServiceDateInput)),
  });
};

/** The update an edit sends (the inventory number of a stored asset is fixed); None while the card is incomplete. */
export const assetCardUpdateCommandOf = (
  draft: AssetCardDraft,
  asset: Asset,
  placement: AssetPlacement,
): Option.Option<OpsCommand> => {
  // The inventory number and the acquisition of a stored asset are fixed; only the card itself is replaced.
  if (draft.category.trim() === '' || draft.name.trim() === '') {
    return Option.none();
  }
  const command: { -readonly [Key in keyof UpdateCommand]: UpdateCommand[Key] } = {
    _tag: 'AssetUpdate',
    assetId: asset.id,
    ...cardFieldsOf(draft, placement),
  };
  return Option.some(command);
};
