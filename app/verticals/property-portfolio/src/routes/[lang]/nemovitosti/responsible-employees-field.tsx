import { Badge } from '@techsio/ui-kit/atoms/badge';

import type { RecordForm, ResponsibleSelection } from './use-property-editor.ts';

const fieldId = 'property-responsible-employees';

/** Texts of the field, already translated by the page. */
export interface ResponsibleEmployeesCopy {
  readonly empty: string;
  readonly label: string;
  readonly loading: string;
  readonly placeholder: string;
  readonly required: string;
  /** Read after the label of the required field. */
  readonly requiredLabel: string;
  readonly retry: string;
  /** Shown instead of an employee the current user cannot see; never the employee's identifier. */
  readonly unavailable: string;
}

export interface ResponsibleEmployeesFieldProps {
  readonly copy: ResponsibleEmployeesCopy;
  readonly disabled: boolean;
  /** Why the employee register could not be read; empty while it can. */
  readonly error: string;
  /** The building or unit form whose `responsibleEmployeeIds` field holds the choice. */
  readonly form: RecordForm;
  readonly invalid: boolean;
  readonly loading: boolean;
  readonly onRetry: () => void;
  readonly selection: ResponsibleSelection;
}

/**
 * Responsible employees of a building. The multiple-choice combobox keeps its input for searching only, so the chosen
 * employees (or an older building's stored name) are listed under it; otherwise a stored choice would look empty.
 */
export const ResponsibleEmployeesField = ({
  copy,
  disabled,
  error,
  form,
  invalid,
  loading,
  onRetry,
  selection,
}: ResponsibleEmployeesFieldProps) => {
  const shown =
    selection.legacyName === undefined
      ? selection.selected.map((choice) => ({ key: choice.id, label: choice.name ?? copy.unavailable }))
      : [{ key: 'legacy', label: selection.legacyName }];
  return (
    <div className="grid gap-100">
      <form.responsibleEmployeeIds
        allowCustomValue={false}
        closeOnSelect={false}
        disabled={disabled}
        error={error}
        id={fieldId}
        items={selection.options.map((choice) => ({ label: choice.name ?? copy.unavailable, value: choice.id }))}
        label={copy.label}
        loading={loading}
        loadingMessage={copy.loading}
        name="responsibleEmployeeIds"
        noResultsMessage={copy.empty}
        onRetry={onRetry}
        openOnClick
        placeholder={copy.placeholder}
        required
        requiredLabel={copy.requiredLabel}
        retryLabel={copy.retry}
        selectionBehavior="clear"
        {...(invalid ? { helpText: copy.required, invalid: true } : {})}
      />
      {shown.length > 0 && (
        <ul aria-labelledby={`${fieldId}-label`} className="flex flex-wrap gap-50">
          {shown.map((item) => (
            <li key={item.key}>
              <Badge appearance="outline" severity="neutral" size="sm">
                {item.label}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
