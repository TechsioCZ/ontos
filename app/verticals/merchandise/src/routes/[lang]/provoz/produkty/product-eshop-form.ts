// The form of the "E-shop a obrázky" tab: the gallery, publication, address, availability reporting and the reason of
// an archiving. Typing changes only this form; the tab's Save button sends the draft and the archive button its own
// command, so the form itself is never submitted.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import {
  FormBuilder,
  FormInputField,
  FormReact,
  FormRoot,
  SwitchField,
  unrenderedField,
  useAtomSet,
} from '@app/core-runtime/ui/form';
import { Effect, Option, Schema } from 'effect';
import { Atom } from 'effect/reactivity';
import type { FC, ReactNode } from 'react';
import { jsx } from 'react/jsx-runtime';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { eshopDraftOf } from './product-eshop-draft.ts';
import type { EshopDraft } from './product-eshop-draft.ts';

const eshopForm = FormReact.make(
  FormBuilder.empty
    .addField('archiveReason', Schema.String)
    .addField('images', Schema.Array(Schema.String))
    .addField('published', Schema.Boolean)
    .addField('slug', Schema.String)
    .addField('sourceBaseProduct', Schema.Boolean)
    .addField('stockTracked', Schema.Boolean),
  {
    fields: {
      archiveReason: FormInputField,
      // The gallery editor writes the pictures.
      images: unrenderedField<readonly string[]>(),
      published: SwitchField,
      slug: FormInputField,
      sourceBaseProduct: SwitchField,
      stockTracked: SwitchField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
type EshopValues = typeof eshopForm.schema.Encoded;

/** The form's values for the tab's draft, with the archive reason as typed. */
const eshopValuesOf = (draft: EshopDraft, archiveReason: string): EshopValues => ({
  archiveReason,
  images: draft.images,
  published: draft.published,
  slug: draft.slug,
  sourceBaseProduct: draft.sourceBaseProduct,
  stockTracked: draft.stockTracked,
});

/** The tab's draft as the form has it (the archive reason is its own command's); none before it is initialized. */
export const eshopDraft = eshopForm.values.pipe(
  Atom.map(
    Option.map((values): EshopDraft => ({
      images: values.images,
      published: values.published,
      slug: values.slug,
      sourceBaseProduct: values.sourceBaseProduct,
      stockTracked: values.stockTracked,
    })),
  ),
);
export const archiveReason = eshopForm.values.pipe(
  Atom.map(Option.match({ onNone: () => '', onSome: (values) => values.archiveReason })),
);
type InputProps = FormReact.ExtractExtraProps<typeof FormInputField>;
type SwitchProps = FormReact.ExtractExtraProps<typeof SwitchField>;

/** The inputs of the tab; they render inside `EshopForm`. */
export const eshopFields: {
  readonly archiveReason: FC<InputProps>;
  readonly published: FC<SwitchProps>;
  readonly slug: FC<InputProps>;
  readonly sourceBaseProduct: FC<SwitchProps>;
  readonly stockTracked: FC<SwitchProps>;
} = eshopForm;

/*
 * An update of a field from the form's current values. A field's own `setValue` takes values only: it is an effect
 * function that runs again with its last argument, so a function given to it would be applied more than once.
 */
const imagesUpdate = Atom.writable(
  (get) => get(eshopForm.values),
  (ctx, change: { readonly update: (current: readonly string[]) => readonly string[] }) => {
    const values = ctx.get(eshopForm.values);
    if (Option.isSome(values)) {
      ctx.set(eshopForm.setValues, { ...values.value, images: change.update(values.value.images) });
    }
  },
);

/** Puts a draft into the form (a reloaded product, Zahodit změny, a kept draft) with the archive reason as typed. */
export const useSetEshopDraft = (): ((draft: EshopDraft, archiveReason: string) => void) => {
  const setValues = useAtomSet(eshopForm.setValues);
  return (draft, reason) => setValues(eshopValuesOf(draft, reason));
};
/** The gallery editor's writes of the pictures. */
export const useUpdateEshopImages = (): ((update: (current: readonly string[]) => readonly string[]) => void) => {
  const set = useAtomSet(imagesUpdate);
  return (update) => set({ update });
};

/** The tab's form, opening with `product` as the server has it. Whatever reads the form renders inside it. */
export const EshopForm = ({ children, product }: { readonly children: ReactNode; readonly product: ProductRecord }) => {
  const { t } = useModernI18n();
  return jsx(FormRoot, {
    children,
    className: 'flex flex-col gap-250',
    defaultValues: eshopValuesOf(eshopDraftOf(product), ''),
    form: eshopForm,
    translateMessage: t,
  });
};
