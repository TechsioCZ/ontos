import { SelectTemplate } from '@app/admin-ui/select-template';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput, FormTextarea } from '@app/admin-ui/form-controls';
import { tagColorValue } from '../../../../components/tag-controls.tsx';
import { subjectKindValues, tagColorValues } from '../../../../../shared/apis/records.ts';
import type { SubjectKind } from '../../../../../shared/apis/records.ts';
import { tagNameProblem } from './tag-draft.ts';
import type { TagDraft } from './tag-draft.ts';

const toggleKind = (kinds: readonly SubjectKind[], kind: SubjectKind, checked: boolean) => {
  const selected = new Set(kinds);
  return subjectKindValues.filter((value) => (value === kind ? checked : selected.has(value)));
};

const nameErrorKey = {
  required: 'tagging.tags.form.nameRequired',
  tooLong: 'tagging.tags.form.nameTooLong',
} as const;

/** The fields of one tag, shared by the create dialog and the edit panel. Changing them only changes the draft. */
export const TagFields = ({
  draft,
  onChange,
  showErrors,
}: {
  readonly draft: TagDraft;
  readonly onChange: (update: (current: TagDraft) => TagDraft) => void;
  /** Inline field errors are shown (after the first create attempt; always while editing). */
  readonly showErrors: boolean;
}) => {
  const { t } = useModernI18n();
  const nameProblem = tagNameProblem(draft);
  const showNameError = showErrors && nameProblem !== null;
  const showKindsError = showErrors && draft.kinds.length === 0;
  const selectedKinds = new Set(draft.kinds);
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
      <FormInput
        autoComplete="off"
        helpText={nameProblem !== null && showNameError ? t(nameErrorKey[nameProblem]) : undefined}
        id="tag-name"
        label={t('tagging.tags.form.name')}
        name="name"
        onChange={(event) => {
          const { value } = event.target;
          onChange((current) => ({ ...current, name: value }));
        }}
        required
        validateStatus={showNameError ? 'error' : 'default'}
        value={draft.name}
      />
      <SelectTemplate
        items={colorItems}
        label={t('tagging.tags.form.color')}
        name="color"
        onValueChange={(details) => {
          const picked = tagColorValues.find((value) => value === details.value[0]);
          if (picked !== undefined) {
            onChange((current) => ({ ...current, color: picked }));
          }
        }}
        placeholder={t('tagging.tags.selectPlaceholder')}
        value={[draft.color]}
      />
      <FormTextarea
        autoComplete="off"
        id="tag-description"
        label={t('tagging.tags.form.description')}
        name="description"
        onChange={(event) => {
          const { value } = event.target;
          onChange((current) => ({ ...current, description: value }));
        }}
        value={draft.description}
      />
      <fieldset className="flex flex-col gap-100">
        <legend className="font-medium text-sm">{t('tagging.tags.form.kinds')}</legend>
        {subjectKindValues.map((kind) => (
          <FormCheckbox
            checked={selectedKinds.has(kind)}
            key={kind}
            name="kinds"
            onCheckedChange={(checked) =>
              onChange((current) => ({ ...current, kinds: toggleKind(current.kinds, kind, checked) }))
            }
            value={kind}
          >
            {t(`tagging.kinds.${kind}`)}
          </FormCheckbox>
        ))}
        {showKindsError && (
          <StatusText showIcon status="error">
            {t('tagging.tags.form.kindsRequired')}
          </StatusText>
        )}
      </fieldset>
    </>
  );
};
