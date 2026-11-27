// The form of the "Varianty a ceny" tab: one row per real variant (name, attributes, SKU, net price, active and the
// storefront details of its detail editor) and the search box of the list. Typing changes only this form; the tab's
// Save button sends it, so the form itself is never submitted.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import {
  Field,
  FormBuilder,
  FormInputField,
  FormReact,
  FormTextareaField,
  NumberTextSchema,
  FormRoot,
  NumericField,
  SwitchField,
  makePartInputField,
  unrenderedField,
  useAtomSet,
} from '@app/core-runtime/ui/form';
import type { PartInputProps } from '@app/core-runtime/ui/form';
import { Effect, Option, Schema } from 'effect';
import { Atom } from 'effect/reactivity';
import type { FC, ReactNode } from 'react';
import { jsx } from 'react/jsx-runtime';
import { VariantIdSchema } from '../../../../../shared/domain/merchandise-model.ts';
import type { VariantId } from '../../../../../shared/domain/merchandise-model.ts';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { TierDraftSchema, parseCzkText } from './product-sales-terms-draft.ts';
import type { TierDraft } from './product-sales-terms-draft.ts';

export interface VariantParameterDraft {
  readonly key: number;
  readonly label: string;
  readonly unit: string;
  readonly value: string;
}

export interface VariantFlagsDraft {
  readonly isAction: boolean;
  readonly isNew: boolean;
  readonly isRecommended: boolean;
  readonly isSale: boolean;
}

/** The detail fields of one variant draft, as typed. Empty text means "not set". */
export interface VariantDetailDraft {
  readonly description: string;
  readonly flags: VariantFlagsDraft;
  readonly imageSrc: string;
  readonly minimumQuantityText: string;
  readonly originalPriceText: string;
  readonly packageQuantityText: string;
  readonly parameters: readonly VariantParameterDraft[];
  readonly sourceUnit: string;
  readonly tiers: readonly TierDraft[];
  readonly tiersEdited: boolean;
  /** The minimum `tiers` were written for: the rows follow a minimum changed since (`variantTiersShown`). */
  readonly tiersMinimumText: string;
  readonly unit: string;
  readonly weightGramsText: string;
}

/** One variant of the tab's draft: a stored variant (`id`) or a new one; `key` names its row. */
export interface VariantDraft extends VariantDetailDraft {
  readonly active: boolean;
  readonly attributes: string;
  readonly id?: VariantId;
  readonly key: string;
  readonly name: string;
  readonly priceText: string;
  readonly sku: string;
}

const VariantParametersSchema = Schema.Array(
  Schema.Struct({ key: Schema.Number, label: Schema.String, unit: Schema.String, value: Schema.String }),
);
export type VariantParameters = typeof VariantParametersSchema.Encoded;

/** A variant's tier rows: as typed, whether they were edited, and the minimum they were written for. */
const VariantTiersSchema = Schema.Struct({
  edited: Schema.Boolean,
  minimumText: Schema.String,
  rows: Schema.Array(TierDraftSchema),
});
export type VariantTiers = typeof VariantTiersSchema.Encoded;

const VariantRowSchema = Schema.Struct({
  active: Schema.Boolean,
  attributes: Schema.String,
  description: Schema.String,
  id: Schema.OptionFromUndefinedOr(VariantIdSchema),
  imageSrc: Schema.String,
  isAction: Schema.Boolean,
  isNew: Schema.Boolean,
  isRecommended: Schema.Boolean,
  isSale: Schema.Boolean,
  key: Schema.String,
  minimumQuantityText: Schema.String,
  name: Schema.String,
  originalPriceText: Schema.String,
  packageQuantityText: Schema.String,
  parameters: VariantParametersSchema,
  price: NumberTextSchema,
  sku: Schema.String,
  sourceUnit: Schema.String,
  tiers: VariantTiersSchema,
  unit: Schema.String,
  weightGramsText: Schema.String,
});
export type VariantRow = typeof VariantRowSchema.Encoded;

const variantsForm = FormReact.make(
  FormBuilder.empty.addField(Field.makeArrayField('rows', VariantRowSchema)).addField('search', Schema.String),
  {
    fields: {
      rows: {
        active: SwitchField,
        attributes: FormInputField,
        description: FormTextareaField,
        // `id` names a stored variant, `key` the row; the image is picked by its thumbnail, which writes the row.
        id: unrenderedField<string | undefined>(),
        imageSrc: unrenderedField<string>(),
        isAction: SwitchField,
        isNew: SwitchField,
        isRecommended: SwitchField,
        isSale: SwitchField,
        key: unrenderedField<string>(),
        minimumQuantityText: FormInputField,
        name: FormInputField,
        originalPriceText: FormInputField,
        packageQuantityText: FormInputField,
        parameters: makePartInputField<VariantParameters>(),
        price: NumericField,
        sku: FormInputField,
        sourceUnit: FormInputField,
        tiers: makePartInputField<VariantTiers>(),
        unit: FormInputField,
        weightGramsText: FormInputField,
      },
      search: FormInputField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

export const variantRowOf = (draft: VariantDraft): VariantRow => ({
  active: draft.active,
  attributes: draft.attributes,
  description: draft.description,
  id: draft.id,
  imageSrc: draft.imageSrc,
  isAction: draft.flags.isAction,
  isNew: draft.flags.isNew,
  isRecommended: draft.flags.isRecommended,
  isSale: draft.flags.isSale,
  key: draft.key,
  minimumQuantityText: draft.minimumQuantityText,
  name: draft.name,
  originalPriceText: draft.originalPriceText,
  packageQuantityText: draft.packageQuantityText,
  parameters: draft.parameters,
  price: { number: (parseCzkText(draft.priceText) ?? Number.NaN) / 100, text: draft.priceText },
  sku: draft.sku,
  sourceUnit: draft.sourceUnit,
  tiers: { edited: draft.tiersEdited, minimumText: draft.tiersMinimumText, rows: draft.tiers },
  unit: draft.unit,
  weightGramsText: draft.weightGramsText,
});

export const variantDraftOf = (row: VariantRow): VariantDraft => {
  const draft: VariantDraft = {
    active: row.active,
    attributes: row.attributes,
    description: row.description,
    flags: { isAction: row.isAction, isNew: row.isNew, isRecommended: row.isRecommended, isSale: row.isSale },
    imageSrc: row.imageSrc,
    key: row.key,
    minimumQuantityText: row.minimumQuantityText,
    name: row.name,
    originalPriceText: row.originalPriceText,
    packageQuantityText: row.packageQuantityText,
    parameters: row.parameters,
    priceText: row.price.text,
    sku: row.sku,
    sourceUnit: row.sourceUnit,
    tiers: row.tiers.rows,
    tiersEdited: row.tiers.edited,
    tiersMinimumText: row.tiers.minimumText,
    unit: row.unit,
    weightGramsText: row.weightGramsText,
  };
  // A new variant has no id; the draft then has no `id` key at all, as the server's drafts of new rows.
  return row.id === undefined ? draft : { ...draft, id: VariantIdSchema.make(row.id) };
};

/** The form's values for the drafts, with an empty search. */
export const variantValuesOf = (drafts: readonly VariantDraft[]) => ({ rows: drafts.map(variantRowOf), search: '' });

/** The variants as the form has them; none before it is initialized. */
export const variantDrafts = variantsForm.values.pipe(
  Atom.map(Option.map((values): readonly VariantDraft[] => values.rows.map(variantDraftOf))),
);
export const variantSearch = variantsForm.values.pipe(
  Atom.map(Option.match({ onNone: () => '', onSome: (values) => values.search })),
);

type InputProps = FormReact.ExtractExtraProps<typeof FormInputField>;
type TextareaProps = FormReact.ExtractExtraProps<typeof FormTextareaField>;
type NumericProps = FormReact.ExtractExtraProps<typeof NumericField>;
type SwitchProps = FormReact.ExtractExtraProps<typeof SwitchField>;

/**
 * The inputs of the tab: the list's search box and the inputs of a variant's row, which render inside the row's
 * `Item` (the row `index` of the variants the inputs inside it edit).
 */
export const variantsFields: {
  readonly rows: {
    readonly active: FC<SwitchProps>;
    readonly attributes: FC<InputProps>;
    readonly description: FC<TextareaProps>;
    readonly isAction: FC<SwitchProps>;
    readonly isNew: FC<SwitchProps>;
    readonly isRecommended: FC<SwitchProps>;
    readonly isSale: FC<SwitchProps>;
    readonly Item: FC<{ readonly children: ReactNode; readonly index: number }>;
    readonly minimumQuantityText: FC<InputProps>;
    readonly name: FC<InputProps>;
    readonly originalPriceText: FC<InputProps>;
    readonly packageQuantityText: FC<InputProps>;
    readonly parameters: FC<PartInputProps<VariantParameters>>;
    readonly price: FC<NumericProps>;
    readonly sku: FC<InputProps>;
    readonly sourceUnit: FC<InputProps>;
    readonly tiers: FC<PartInputProps<VariantTiers>>;
    readonly unit: FC<InputProps>;
    readonly weightGramsText: FC<InputProps>;
  };
  readonly search: FC<InputProps>;
} = variantsForm;

/*
 * An update of a field from the form's current values. A field's own `setValue` takes values only: it is an effect
 * function that runs again with its last argument, so a function given to it would be applied more than once.
 */
const rowsUpdate = Atom.writable(
  (get) => get(variantsForm.values),
  (ctx, change: { readonly update: (current: readonly VariantRow[]) => readonly VariantRow[] }) => {
    const values = ctx.get(variantsForm.values);
    if (Option.isSome(values)) {
      ctx.set(variantsForm.setValues, { ...values.value, rows: change.update(values.value.rows) });
    }
  },
);
const searchAtoms = variantsForm.getFieldAtoms(variantsForm.fields.search);

/** Writes the variant rows: a typed detail no input holds, an added variant, a draft put back. */
export const useUpdateVariantRows = (): ((
  update: (current: readonly VariantRow[]) => readonly VariantRow[],
) => void) => {
  const set = useAtomSet(rowsUpdate);
  return (update) => set({ update });
};
export const useSetVariantSearch = (): ((search: string) => void) => useAtomSet(searchAtoms.setValue);

/** The tab's form, opening with `drafts`. Whatever reads the form's values renders inside it. */
export const VariantsForm = ({
  children,
  className,
  drafts,
}: {
  readonly children: ReactNode;
  readonly className: string;
  readonly drafts: readonly VariantDraft[];
}) => {
  const { t } = useModernI18n();
  return jsx(FormRoot, {
    children,
    className,
    defaultValues: variantValuesOf(drafts),
    form: variantsForm,
    translateMessage: t,
  });
};
