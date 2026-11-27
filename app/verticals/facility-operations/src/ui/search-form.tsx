// A search box over a list: a one-field form whose text the list filters by. Every list has its own form, so two
// lists never share their search text; Enter filters nothing more than typing does.
import { BareTextField, FormBuilder, FormReact, FormRoot, useAtomValue } from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect, Option, Schema } from 'effect';
import { Atom } from 'effect/reactivity';
import { browserAtomRuntime } from '../runtime/browser-effect-runtime.ts';

const searchFields = FormBuilder.empty.addField('search', Schema.String);

const searchFormOf = () => {
  const form = FormReact.make(searchFields, {
    fields: { search: BareTextField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  });
  return { form, text: form.getFieldAtoms(form.fields.search).value.pipe(Atom.map(Option.getOrElse(() => ''))) };
};

/** The lists that have a search box. */
export const SearchedListSchema = Schema.Literals(['assets', 'devices', 'documents', 'meters', 'movements', 'stock']);
export type SearchedList = typeof SearchedListSchema.Type;

const searchForms = {
  assets: searchFormOf(),
  devices: searchFormOf(),
  documents: searchFormOf(),
  meters: searchFormOf(),
  movements: searchFormOf(),
  stock: searchFormOf(),
};

const empty = { search: '' };

/** The text typed into a list's search box; `""` before the box is on screen. */
export const useListSearch = (list: SearchedList): string => useAtomValue(searchForms[list].text);

/** The search box of one list. */
export const ListSearch = ({
  className,
  label,
  list,
  placeholder,
  size,
  type,
}: {
  /** Of the input. */
  readonly className?: string | undefined;
  /** The accessible name of the box. */
  readonly label: string;
  readonly list: SearchedList;
  readonly placeholder: string;
  readonly size: 'sm' | 'md';
  readonly type?: 'search' | undefined;
}) => {
  const { t } = useModernI18n();
  const { form } = searchForms[list];
  return (
    <FormRoot defaultValues={empty} form={form} translateMessage={(message) => t(message)}>
      <form.search aria-label={label} className={className} placeholder={placeholder} size={size} type={type} />
    </FormRoot>
  );
};
