// The form of the "Obsah e-shopu" tab: category, labels, parameters, main image alt text and the extra content
// (additional categories, homepage order, brand, SEO, documents, related products). Typing changes only this form; the
// tab's Save button sends it, so the form itself is never submitted.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import {
  Field,
  FormBuilder,
  FormInputField,
  FormReact,
  FormRoot,
  FormTextareaField,
  SwitchField,
  unrenderedField,
  useAtomSet,
} from '@app/core-runtime/ui/form';
import { Effect, Option, Schema } from 'effect';
import { Atom } from 'effect/reactivity';
import type { FC, ReactNode } from 'react';
import { jsx } from 'react/jsx-runtime';
import { CategoryTrailSchema } from '../../../../../shared/apis/records.ts';
import type { CategoryTrail } from '../../../../../shared/apis/records.ts';
import { CatalogCategoryIdSchema, ProductIdReferenceSchema } from '../../../../../shared/domain/merchandise-model.ts';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { ContentExtras, DocumentDraft } from './product-content-extras-draft.ts';

export interface ParameterDraft {
  readonly key: number;
  readonly label: string;
  readonly unit: string;
  readonly value: string;
}

export interface Flags {
  readonly isAction: boolean;
  readonly isNew: boolean;
  readonly isRecommended: boolean;
  readonly isSale: boolean;
}

/** The content form's draft. `category` is the tree category picked here; `keep` keeps the product's own. */
export interface ContentDraft {
  readonly category: CategoryTrail | null | 'keep';
  readonly extras: ContentExtras;
  readonly flags: Flags;
  readonly imageAlt: string;
  readonly parameters: readonly ParameterDraft[];
}

type CategoryTrailValue = typeof CategoryTrailSchema.Encoded;

const contentForm = FormReact.make(
  FormBuilder.empty
    .addField('additionalCategories', Schema.Array(CategoryTrailSchema))
    .addField('brand', Schema.String)
    // No value keeps the product's own category; null is no category picked.
    .addField('category', Schema.OptionFromUndefinedOr(Schema.OptionFromNullOr(CategoryTrailSchema)))
    .addField(
      Field.makeArrayField(
        'documents',
        Schema.Struct({ key: Schema.Number, label: Schema.String, url: Schema.String }),
      ),
    )
    .addField('featuredText', Schema.String)
    .addField('imageAlt', Schema.String)
    .addField('isAction', Schema.Boolean)
    .addField('isNew', Schema.Boolean)
    .addField('isRecommended', Schema.Boolean)
    .addField('isSale', Schema.Boolean)
    .addField(
      Field.makeArrayField(
        'parameters',
        Schema.Struct({ key: Schema.Number, label: Schema.String, unit: Schema.String, value: Schema.String }),
      ),
    )
    .addField('related', Schema.Array(ProductIdReferenceSchema))
    .addField('seoDescription', Schema.String)
    .addField('seoTitle', Schema.String),
  {
    fields: {
      // The categories and related products are picked in search comboboxes, which write these fields.
      additionalCategories: unrenderedField<readonly CategoryTrailValue[]>(),
      brand: FormInputField,
      category: unrenderedField<CategoryTrailValue | null | undefined>(),
      // `key` names a row.
      documents: { key: unrenderedField<number>(), label: FormInputField, url: FormInputField },
      featuredText: FormInputField,
      imageAlt: FormInputField,
      isAction: SwitchField,
      isNew: SwitchField,
      isRecommended: SwitchField,
      isSale: SwitchField,
      parameters: {
        key: unrenderedField<number>(),
        label: FormInputField,
        unit: FormInputField,
        value: FormInputField,
      },
      related: unrenderedField<readonly string[]>(),
      seoDescription: FormTextareaField,
      seoTitle: FormInputField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
type ContentValues = typeof contentForm.schema.Encoded;

const trailOf = ({ id, trail }: CategoryTrailValue): CategoryTrail => ({ id: CatalogCategoryIdSchema.make(id), trail });

const categoryOf = (value: CategoryTrailValue | null | undefined): ContentDraft['category'] => {
  if (value === undefined) {
    return 'keep';
  }
  return value === null ? null : trailOf(value);
};

const contentValuesOf = (draft: ContentDraft): ContentValues => ({
  additionalCategories: draft.extras.additionalCategories,
  brand: draft.extras.brand,
  category: draft.category === 'keep' ? undefined : draft.category,
  documents: draft.extras.documents,
  featuredText: draft.extras.featuredText,
  imageAlt: draft.imageAlt,
  isAction: draft.flags.isAction,
  isNew: draft.flags.isNew,
  isRecommended: draft.flags.isRecommended,
  isSale: draft.flags.isSale,
  parameters: draft.parameters,
  related: draft.extras.related,
  seoDescription: draft.extras.seoDescription,
  seoTitle: draft.extras.seoTitle,
});

const contentDraftOfValues = (values: ContentValues): ContentDraft => ({
  category: categoryOf(values.category),
  extras: {
    additionalCategories: values.additionalCategories.map(trailOf),
    brand: values.brand,
    documents: values.documents,
    featuredText: values.featuredText,
    related: values.related,
    seoDescription: values.seoDescription,
    seoTitle: values.seoTitle,
  },
  flags: { isAction: values.isAction, isNew: values.isNew, isRecommended: values.isRecommended, isSale: values.isSale },
  imageAlt: values.imageAlt,
  parameters: values.parameters,
});

/** The content as the form has it; none before it is initialized. */
export const contentDraft = contentForm.values.pipe(Atom.map(Option.map(contentDraftOfValues)));
type InputProps = FormReact.ExtractExtraProps<typeof FormInputField>;
type TextareaProps = FormReact.ExtractExtraProps<typeof FormTextareaField>;
type SwitchProps = FormReact.ExtractExtraProps<typeof SwitchField>;
type RowItem = FC<{ readonly children: ReactNode; readonly index: number }>;

/** The inputs of the tab; they render inside its form, a row's inside the row's `Item`. */
export const contentFields: {
  readonly brand: FC<InputProps>;
  readonly documents: { readonly Item: RowItem; readonly label: FC<InputProps>; readonly url: FC<InputProps> };
  readonly featuredText: FC<InputProps>;
  readonly imageAlt: FC<InputProps>;
  readonly isAction: FC<SwitchProps>;
  readonly isNew: FC<SwitchProps>;
  readonly isRecommended: FC<SwitchProps>;
  readonly isSale: FC<SwitchProps>;
  readonly parameters: {
    readonly Item: RowItem;
    readonly label: FC<InputProps>;
    readonly unit: FC<InputProps>;
    readonly value: FC<InputProps>;
  };
  readonly seoDescription: FC<TextareaProps>;
  readonly seoTitle: FC<InputProps>;
} = contentForm;

const categoryField = contentForm.getFieldAtoms(contentForm.fields.category);
const relatedField = contentForm.getFieldAtoms(contentForm.fields.related);

type DocumentRows = readonly DocumentDraft[];
type ParameterRows = readonly ParameterDraft[];

/*
 * An update of a field from the form's current values. A field's own `setValue` takes values only: it is an effect
 * function that runs again with its last argument, so a function given to it would be applied more than once.
 */
const contentUpdate = Atom.writable(
  (get) => get(contentForm.values),
  (ctx, change: { readonly update: (current: ContentValues) => ContentValues }) => {
    const values = ctx.get(contentForm.values);
    if (Option.isSome(values)) {
      ctx.set(contentForm.setValues, change.update(values.value));
    }
  },
);

/** Puts a draft into the form: a reloaded product, Zahodit změny, a kept draft. */
export const useSetContentDraft = (): ((draft: ContentDraft) => void) => {
  const setValues = useAtomSet(contentForm.setValues);
  return (draft) => setValues(contentValuesOf(draft));
};
/** The tree category picked in its search; null is none. */
export const useSetContentCategory = (): ((category: CategoryTrail | null) => void) =>
  useAtomSet(categoryField.setValue);
export const useUpdateAdditionalCategories = (): ((
  update: (current: readonly CategoryTrail[]) => readonly CategoryTrail[],
) => void) => {
  const set = useAtomSet(contentUpdate);
  return (update) =>
    set({
      update: (values) => ({ ...values, additionalCategories: update(values.additionalCategories.map(trailOf)) }),
    });
};
export const useUpdateContentDocuments = (): ((update: (current: DocumentRows) => DocumentRows) => void) => {
  const set = useAtomSet(contentUpdate);
  return (update) => set({ update: (values) => ({ ...values, documents: update(values.documents) }) });
};
export const useUpdateContentParameters = (): ((update: (current: ParameterRows) => ParameterRows) => void) => {
  const set = useAtomSet(contentUpdate);
  return (update) => set({ update: (values) => ({ ...values, parameters: update(values.parameters) }) });
};
/** The related products in display order. */
export const useSetRelatedProducts = (): ((related: readonly string[]) => void) => useAtomSet(relatedField.setValue);

/** The tab's form, opening with `draft`. Whatever reads the form's values renders inside it. */
export const ContentForm = ({
  children,
  className,
  draft,
}: {
  readonly children: ReactNode;
  readonly className: string;
  readonly draft: ContentDraft;
}) => {
  const { t } = useModernI18n();
  return jsx(FormRoot, {
    children,
    className,
    defaultValues: contentValuesOf(draft),
    form: contentForm,
    translateMessage: t,
  });
};
