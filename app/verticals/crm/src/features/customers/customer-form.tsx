import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';

export interface CustomerFormValues {
  readonly name: string;
}

export interface CustomerFormCopy {
  readonly cancel: string;
  readonly nameLabel: string;
  readonly nameRequired: string;
  readonly save: string;
  readonly saving: string;
}

export interface CustomerFormStatus {
  readonly message: string;
  readonly status: 'default' | 'error' | 'success' | 'warning';
}

export interface CustomerFormProps {
  readonly copy: CustomerFormCopy;
  readonly disabled?: boolean;
  readonly formStatus?: CustomerFormStatus;
  readonly initialValues: CustomerFormValues;
  readonly nameError?: string;
  readonly onCancel: () => void;
  readonly onSubmit: (values: CustomerFormValues) => Promise<void> | void;
  readonly onValuesChange?: (values: CustomerFormValues) => void;
  readonly pending?: boolean;
}

export const CustomerForm = ({
  copy,
  disabled = false,
  formStatus,
  initialValues,
  nameError,
  onCancel,
  onSubmit,
  onValuesChange,
  pending = false,
}: CustomerFormProps) => {
  const [name, setName] = useState(initialValues.name);
  const [localNameError, setLocalNameError] = useState<string>();
  const nameInputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const fieldError = localNameError ?? nameError;
  const controlsDisabled = disabled || pending;
  const nameErrorId = 'customer-name-error';

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (controlsDisabled || submittingRef.current) {
      return;
    }
    const normalizedName = name.trim();
    if (normalizedName.length === 0) {
      setLocalNameError(copy.nameRequired);
      nameInputRef.current?.focus();
      return;
    }

    setLocalNameError(undefined);
    submittingRef.current = true;
    let submission: Promise<void> | void;
    try {
      submission = onSubmit({ name: normalizedName });
    } catch (error) {
      submittingRef.current = false;
      throw error;
    }
    const releaseSubmission = () => {
      submittingRef.current = false;
    };
    // oxlint-disable-next-line promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- React form callbacks stay synchronous, and both outcomes release the interaction guard.
    void Promise.resolve(submission).then(releaseSubmission, releaseSubmission);
  };

  return (
    <form className="crm:grid crm:gap-6" noValidate onSubmit={submit}>
      <FormInput
        aria-describedby={fieldError === undefined ? undefined : nameErrorId}
        aria-errormessage={fieldError === undefined ? undefined : nameErrorId}
        aria-invalid={fieldError === undefined ? undefined : true}
        disabled={controlsDisabled}
        helpText={fieldError === undefined ? undefined : <span id={nameErrorId}>{fieldError}</span>}
        id="customer-name"
        label={copy.nameLabel}
        name="name"
        onChange={(event) => {
          const values = { name: event.currentTarget.value };
          setName(values.name);
          setLocalNameError(undefined);
          onValuesChange?.(values);
        }}
        ref={nameInputRef}
        required
        type="text"
        validateStatus={fieldError === undefined ? 'default' : 'error'}
        value={name}
      />

      {formStatus === undefined ? null : (
        <output aria-live="polite">
          <StatusText showIcon status={formStatus.status}>
            {formStatus.message}
          </StatusText>
        </output>
      )}

      <div className="crm:flex crm:flex-col-reverse crm:gap-3 crm:sm:flex-row crm:sm:justify-end">
        <Button
          disabled={controlsDisabled}
          onClick={onCancel}
          theme="outlined"
          type="button"
          variant="secondary"
        >
          {copy.cancel}
        </Button>
        <Button
          disabled={controlsDisabled}
          isLoading={pending}
          loadingText={copy.saving}
          type="submit"
          variant="primary"
        >
          {copy.save}
        </Button>
      </div>
    </form>
  );
};
