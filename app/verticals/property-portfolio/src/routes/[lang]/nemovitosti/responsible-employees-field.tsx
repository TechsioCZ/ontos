import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';

import type { ResponsibleSelection } from './use-property-editor.ts';

const fieldId = 'property-responsible-employees';

/** Texts of the field, already translated by the page. */
export interface ResponsibleEmployeesCopy {
  readonly empty: string;
  readonly label: string;
  readonly loading: string;
  readonly placeholder: string;
  readonly required: string;
  readonly retry: string;
  /** Shown instead of an employee the current user cannot see; never the employee's identifier. */
  readonly unavailable: string;
}

export interface ResponsibleEmployeesFieldProps {
  readonly copy: ResponsibleEmployeesCopy;
  readonly disabled: boolean;
  /** Why the employee register could not be read; empty while it can. */
  readonly error: string;
  readonly invalid: boolean;
  readonly loading: boolean;
  readonly onChange: (value: string | string[]) => void;
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
  invalid,
  loading,
  onChange,
  onRetry,
  selection,
}: ResponsibleEmployeesFieldProps) => {
  const shown =
    selection.legacyName === undefined
      ? selection.selected.map((choice) => ({ key: choice.id, label: choice.name ?? copy.unavailable }))
      : [{ key: 'legacy', label: selection.legacyName }];
  return (
    <div className="propertyportfolio:grid gap-100">
      <Combobox
        allowCustomValue={false}
        closeOnSelect={false}
        disabled={disabled}
        error={error}
        id={fieldId}
        items={selection.options.map((choice) => ({ label: choice.name ?? copy.unavailable, value: choice.id }))}
        label={copy.label}
        loading={loading}
        loadingMessage={copy.loading}
        multiple
        name="responsibleEmployeeIds"
        noResultsMessage={copy.empty}
        onChange={onChange}
        onRetry={onRetry}
        openOnClick
        placeholder={copy.placeholder}
        required
        retryLabel={copy.retry}
        selectionBehavior="clear"
        value={selection.selected.map((choice) => choice.id)}
        {...(invalid ? { helpText: copy.required, validateStatus: 'error' as const } : {})}
      />
      {shown.length > 0 && (
        <ul aria-labelledby={`${fieldId}-label`} className="propertyportfolio:flex propertyportfolio:flex-wrap gap-50">
          {shown.map((item) => (
            <li key={item.key}>
              <Badge size="sm" variant="outline">
                {item.label}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
