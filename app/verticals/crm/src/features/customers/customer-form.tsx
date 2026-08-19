import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';

export interface CustomerFormValues {
  readonly dic: string;
  readonly dissolvedOn: string;
  readonly establishedOn: string;
  readonly ico: string;
  readonly legalFormCode: string;
  readonly name: string;
}

export interface CustomerFormCopy {
  readonly cancel: string;
  readonly dicHint: string;
  readonly dicInvalid: string;
  readonly dicLabel: string;
  readonly dissolvedBeforeEstablished: string;
  readonly dissolvedOnHint: string;
  readonly dissolvedOnLabel: string;
  readonly establishedOnHint: string;
  readonly establishedOnLabel: string;
  readonly icoHint: string;
  readonly icoInvalid: string;
  readonly icoLabel: string;
  readonly legalFormCodeHint: string;
  readonly legalFormCodeInvalid: string;
  readonly legalFormCodeLabel: string;
  readonly nameHint: string;
  readonly nameInvalid: string;
  readonly nameLabel: string;
  readonly nameRequired: string;
  readonly save: string;
  readonly saving: string;
}

export interface CustomerFormStatus {
  readonly message: string;
  readonly status: 'default' | 'error' | 'success' | 'warning';
}

export type CustomerFormFieldErrors = Readonly<Partial<Record<keyof CustomerFormValues, string>>>;

export interface CustomerFormProps {
  readonly copy: CustomerFormCopy;
  readonly disabled?: boolean;
  readonly fieldErrors?: CustomerFormFieldErrors;
  readonly formStatus?: CustomerFormStatus;
  readonly onCancel: () => void;
  readonly onSubmit: (values: CustomerFormValues) => Promise<void> | void;
  readonly onValuesChange: (values: CustomerFormValues) => void;
  readonly pending?: boolean;
  readonly values: CustomerFormValues;
}

const icoPattern = /^\d{8}$/u;
const legalFormCodePattern = /^\d{3}$/u;
const dicMaxLength = 20;
const nameMaxLength = 200;

const normalizeValues = (values: CustomerFormValues): CustomerFormValues => ({
  dic: values.dic.trim().toUpperCase(),
  dissolvedOn: values.dissolvedOn.trim(),
  establishedOn: values.establishedOn.trim(),
  ico: values.ico.trim(),
  legalFormCode: values.legalFormCode.trim(),
  name: values.name.trim(),
});

const nameError = (values: CustomerFormValues, copy: CustomerFormCopy) => {
  if (values.name.length === 0) {
    return copy.nameRequired;
  }
  return values.name.length > nameMaxLength ? copy.nameInvalid : undefined;
};

const icoError = (values: CustomerFormValues, copy: CustomerFormCopy) =>
  values.ico.length > 0 && !icoPattern.test(values.ico) ? copy.icoInvalid : undefined;

const dicError = (values: CustomerFormValues, copy: CustomerFormCopy) =>
  values.dic.length > dicMaxLength ? copy.dicInvalid : undefined;

const legalFormCodeError = (values: CustomerFormValues, copy: CustomerFormCopy) =>
  values.legalFormCode.length > 0 && !legalFormCodePattern.test(values.legalFormCode)
    ? copy.legalFormCodeInvalid
    : undefined;

const dissolvedOnError = (values: CustomerFormValues, copy: CustomerFormCopy) =>
  values.establishedOn.length > 0 &&
  values.dissolvedOn.length > 0 &&
  values.dissolvedOn < values.establishedOn
    ? copy.dissolvedBeforeEstablished
    : undefined;

const localErrors = (values: CustomerFormValues, copy: CustomerFormCopy): CustomerFormFieldErrors =>
  Object.fromEntries(
    Object.entries({
      dic: dicError(values, copy),
      dissolvedOn: dissolvedOnError(values, copy),
      ico: icoError(values, copy),
      legalFormCode: legalFormCodeError(values, copy),
      name: nameError(values, copy),
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

const fieldFeedback = (
  error: string | undefined,
  hint: string,
  hintId: string,
  errorId: string,
) => {
  const feedbackId = error === undefined ? hintId : errorId;
  return {
    'aria-describedby': feedbackId,
    'aria-errormessage': error === undefined ? undefined : errorId,
    'aria-invalid': error === undefined ? undefined : (true as const),
    helpText: <span id={feedbackId}>{error ?? hint}</span>,
    validateStatus: error === undefined ? ('default' as const) : ('error' as const),
  };
};

export const CustomerForm = ({
  copy,
  disabled = false,
  fieldErrors,
  formStatus,
  onCancel,
  onSubmit,
  onValuesChange,
  pending = false,
  values,
}: CustomerFormProps) => {
  const [validationErrors, setValidationErrors] = useState<CustomerFormFieldErrors>({});
  const nameInputRef = useRef<HTMLInputElement>(null);
  const icoInputRef = useRef<HTMLInputElement>(null);
  const dicInputRef = useRef<HTMLInputElement>(null);
  const legalFormCodeInputRef = useRef<HTMLInputElement>(null);
  const dissolvedOnInputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const errors = { ...fieldErrors, ...validationErrors };
  const controlsDisabled = disabled || pending;

  const changeValue = (field: keyof CustomerFormValues, value: string) => {
    setValidationErrors((current) => {
      const fieldsToClear =
        field === 'establishedOn' || field === 'dissolvedOn'
          ? new Set<keyof CustomerFormValues>(['establishedOn', 'dissolvedOn'])
          : new Set<keyof CustomerFormValues>([field]);
      if ([...fieldsToClear].every((candidate) => current[candidate] === undefined)) {
        return current;
      }
      if (field === 'establishedOn' || field === 'dissolvedOn') {
        const { dissolvedOn: _dissolvedOn, establishedOn: _establishedOn, ...next } = current;
        return next;
      }
      const { [field]: _fieldError, ...next } = current;
      return next;
    });
    onValuesChange({ ...values, [field]: value });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (controlsDisabled || submittingRef.current) {
      return;
    }
    const normalized = normalizeValues(values);
    const nextErrors = localErrors(normalized, copy);
    setValidationErrors(nextErrors);
    if (nextErrors.name !== undefined) {
      nameInputRef.current?.focus();
      return;
    }
    if (nextErrors.ico !== undefined) {
      icoInputRef.current?.focus();
      return;
    }
    if (nextErrors.dic !== undefined) {
      dicInputRef.current?.focus();
      return;
    }
    if (nextErrors.legalFormCode !== undefined) {
      legalFormCodeInputRef.current?.focus();
      return;
    }
    if (nextErrors.dissolvedOn !== undefined) {
      dissolvedOnInputRef.current?.focus();
      return;
    }

    submittingRef.current = true;
    let submission: Promise<void> | void;
    try {
      submission = onSubmit(normalized);
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
    <form className="crm:grid crm:min-w-0 crm:gap-6" noValidate onSubmit={submit}>
      <FormInput
        {...fieldFeedback(errors.name, copy.nameHint, 'customer-name-hint', 'customer-name-error')}
        disabled={controlsDisabled}
        id="customer-name"
        label={copy.nameLabel}
        name="name"
        onChange={(event) => changeValue('name', event.currentTarget.value)}
        ref={nameInputRef}
        required
        type="text"
        value={values.name}
      />

      <div className="crm:grid crm:min-w-0 crm:gap-6 crm:sm:grid-cols-2">
        <FormInput
          {...fieldFeedback(errors.ico, copy.icoHint, 'customer-ico-hint', 'customer-ico-error')}
          disabled={controlsDisabled}
          id="customer-ico"
          inputMode="numeric"
          label={copy.icoLabel}
          name="ico"
          onChange={(event) => changeValue('ico', event.currentTarget.value)}
          ref={icoInputRef}
          type="text"
          value={values.ico}
        />

        <FormInput
          {...fieldFeedback(errors.dic, copy.dicHint, 'customer-dic-hint', 'customer-dic-error')}
          disabled={controlsDisabled}
          id="customer-dic"
          label={copy.dicLabel}
          name="dic"
          onChange={(event) => changeValue('dic', event.currentTarget.value)}
          ref={dicInputRef}
          type="text"
          value={values.dic}
        />

        <FormInput
          {...fieldFeedback(
            errors.legalFormCode,
            copy.legalFormCodeHint,
            'customer-legal-form-code-hint',
            'customer-legal-form-code-error',
          )}
          disabled={controlsDisabled}
          id="customer-legal-form-code"
          inputMode="numeric"
          label={copy.legalFormCodeLabel}
          name="legalFormCode"
          onChange={(event) => changeValue('legalFormCode', event.currentTarget.value)}
          ref={legalFormCodeInputRef}
          type="text"
          value={values.legalFormCode}
        />

        <FormInput
          aria-describedby="customer-established-on-hint"
          disabled={controlsDisabled}
          helpText={<span id="customer-established-on-hint">{copy.establishedOnHint}</span>}
          id="customer-established-on"
          label={copy.establishedOnLabel}
          name="establishedOn"
          onChange={(event) => changeValue('establishedOn', event.currentTarget.value)}
          type="date"
          value={values.establishedOn}
        />

        <FormInput
          {...fieldFeedback(
            errors.dissolvedOn,
            copy.dissolvedOnHint,
            'customer-dissolved-on-hint',
            'customer-dissolved-on-error',
          )}
          disabled={controlsDisabled}
          id="customer-dissolved-on"
          label={copy.dissolvedOnLabel}
          name="dissolvedOn"
          onChange={(event) => changeValue('dissolvedOn', event.currentTarget.value)}
          ref={dissolvedOnInputRef}
          type="date"
          value={values.dissolvedOn}
        />
      </div>

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
