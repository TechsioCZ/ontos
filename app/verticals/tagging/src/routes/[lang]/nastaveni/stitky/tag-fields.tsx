import { requiredLabelFor } from '@app/admin-ui';
import {
  FormBuilder,
  FormReact,
  FormRoot,
  SelectTemplateField,
  TextAreaField,
  TextField,
  makeCheckboxGroupField,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect, Schema } from 'effect';
import type { Option } from 'effect';
import type { Atom } from 'effect/reactivity';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { tagColorValue } from '../../../../tags/tag-colors.ts';
import { subjectKindValues, tagColorValues } from '../../../../../shared/apis/records.ts';
import type { SubjectKind, TagColor } from '../../../../../shared/apis/records.ts';
import { TagKindsFieldSchema, TagNameFieldSchema } from './tag-draft.ts';
import type { TagDraft } from './tag-draft.ts';

const SubjectKindsField = makeCheckboxGroupField<SubjectKind>();

/**
 * The fields of one tag, checked by the create payload's rules. Uložit sends the draft through the panel's save bar,
 * so the form's own submit (Enter) only checks the fields and hands over to the panel.
 */
const tagFormOf = (validation: 'onChange' | 'onSubmit') =>
  FormReact.make(
    FormBuilder.empty
      .addField('name', TagNameFieldSchema)
      .addField('color', Schema.String)
      .addField('description', Schema.String)
      .addField('subjectKinds', TagKindsFieldSchema),
    {
      fields: {
        color: SelectTemplateField,
        description: TextAreaField,
        name: TextField,
        subjectKinds: SubjectKindsField,
      },
      mode: validation === 'onChange' ? { validation: 'onChange' } : { validation: 'onSubmit' },
      onSubmit: () => Effect.void,
      runtime: browserAtomRuntime,
    },
  );

const tagForms = {
  /** Creating a tag shows the field errors from the first attempt to send it (Enter or Uložit) on. */
  create: tagFormOf('onSubmit'),
  /** Editing a tag shows a field's error as soon as the field is changed. */
  edit: tagFormOf('onChange'),
};

type BuiltTagForm = typeof tagForms.create;
/** What the fields of one tag show. */
export interface TagValues {
  readonly color: string;
  readonly description: string;
  readonly name: string;
  readonly subjectKinds: readonly SubjectKind[];
}

/** The state of a tag form its panel reads and drives: the values, a submit (Enter) and an explicit check. */
export interface TagFormState {
  readonly setValues: Atom.Writable<TagValues>;
  readonly submit: Atom.AtomResultFn<void, void, Schema.SchemaError>;
  readonly validate: Atom.AtomResultFn<void, void>;
  readonly values: Atom.Atom<Option.Option<TagValues>>;
}
export const tagCreateState: TagFormState = tagForms.create;
export const tagEditState: TagFormState = tagForms.edit;

/** What the fields show for a draft. */
export const tagValuesOf = (draft: TagDraft): TagValues => ({
  color: draft.color,
  description: draft.description,
  name: draft.name,
  subjectKinds: draft.kinds,
});

/** The draft the fields hold. The colour is only ever one of the offered ones; anything else keeps `base`'s. */
export const tagDraftOfValues = (values: TagValues, base: TagDraft): TagDraft => ({
  color: tagColorValues.find((color: TagColor) => color === values.color) ?? base.color,
  description: values.description,
  kinds: values.subjectKinds,
  name: values.name,
});

/** Whether the fields show exactly these values; spaces and kind order count. */
export const sameTagValues = (left: TagValues, right: TagValues): boolean =>
  left.name === right.name &&
  left.color === right.color &&
  left.description === right.description &&
  left.subjectKinds.join(',') === right.subjectKinds.join(',');

/** The fields of one tag. Changing them only changes the draft. */
const TagFields = ({ tagForm }: { readonly tagForm: BuiltTagForm }) => {
  const { language, t } = useModernI18n();
  const colorItems = tagColorValues.map((color) => ({
    displayValue: t(`tagging.colors.${color}`),
    label: (
      <span className="flex items-center gap-100">
        <span
          aria-hidden
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: tagColorValue[color] }}
        />
        {t(`tagging.colors.${color}`)}
      </span>
    ),
    value: color,
  }));
  return (
    <>
      <tagForm.name
        autoComplete="off"
        id="tag-name"
        label={t('tagging.tags.form.name')}
        required
        requiredLabel={requiredLabelFor(language)}
      />
      <tagForm.color
        items={colorItems}
        label={t('tagging.tags.form.color')}
        placeholder={t('tagging.tags.selectPlaceholder')}
      />
      <tagForm.description autoComplete="off" id="tag-description" label={t('tagging.tags.form.description')} />
      <tagForm.subjectKinds
        className="flex flex-col gap-100"
        items={subjectKindValues.map((kind) => ({ label: t(`tagging.kinds.${kind}`), value: kind }))}
        legend={t('tagging.tags.form.kinds')}
        legendClassName="font-medium text-sm"
      />
    </>
  );
};

/** The form of one tag, shared by the create and the edit panel: the fields, opened with `defaultValues`. */
export const TagForm = ({
  defaultValues,
  kind,
}: {
  readonly defaultValues: TagValues;
  readonly kind: 'create' | 'edit';
}) => {
  const { t } = useModernI18n();
  const tagForm = tagForms[kind];
  return (
    <FormRoot
      className="flex flex-col gap-200 py-200"
      defaultValues={defaultValues}
      form={tagForm}
      translateMessage={(message) => t(message)}
    >
      <TagFields tagForm={tagForm} />
    </FormRoot>
  );
};
