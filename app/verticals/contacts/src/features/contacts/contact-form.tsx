import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { PhoneInput } from '@techsio/ui-kit/molecules/phone-input';
import { useRef, useState } from 'react';
import type { SubmitEvent } from 'react';

export interface ContactFormValues {
  readonly email: string;
  readonly name: string;
  readonly phone: string;
}

export interface ContactFormCopy {
  readonly cancel: string;
  readonly emailInvalid: string;
  readonly emailLabel: string;
  readonly emailRequired: string;
  readonly nameInvalid: string;
  readonly nameLabel: string;
  readonly nameRequired: string;
  readonly phoneCountryLabel: string;
  readonly phoneInvalid: string;
  readonly phoneLabel: string;
  readonly phonePlaceholder: string;
  readonly phoneRequired: string;
  readonly submit: string;
  readonly submitting: string;
}

export interface ContactFormStatus {
  readonly message: string;
  readonly status: 'default' | 'error' | 'success' | 'warning';
}

export interface ContactFormFieldErrors {
  readonly email?: string;
  readonly name?: string;
  readonly phone?: string;
}

interface MutableContactFormFieldErrors {
  email?: string;
  name?: string;
  phone?: string;
}

export interface ContactFormProps {
  readonly copy: ContactFormCopy;
  readonly disabled?: boolean;
  readonly fieldErrors?: ContactFormFieldErrors;
  readonly formStatus?: ContactFormStatus;
  readonly initialValues: ContactFormValues;
  readonly onCancel: () => void;
  readonly onSubmit: (values: ContactFormValues) => Promise<void> | void;
  readonly onValuesChange?: (values: ContactFormValues) => void;
  readonly pending?: boolean;
}

interface ContactFormFeedbackIdentity {
  readonly fieldErrors: ContactFormFieldErrors | undefined;
  readonly formStatus: ContactFormStatus | undefined;
}

const contactEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

const normalizeValues = (values: ContactFormValues): ContactFormValues => ({
  email: values.email.trim(),
  name: values.name.trim(),
  phone: values.phone.trim(),
});

const localErrors = (values: ContactFormValues, copy: ContactFormCopy): ContactFormFieldErrors => {
  const errors: MutableContactFormFieldErrors = {};
  if (values.name.length === 0) {
    errors.name = copy.nameRequired;
  } else if (values.name.length > 200) {
    errors.name = copy.nameInvalid;
  }
  if (values.email.length === 0) {
    errors.email = copy.emailRequired;
  } else if (
    values.email.length < 3 ||
    values.email.length > 320 ||
    !contactEmailPattern.test(values.email)
  ) {
    errors.email = copy.emailInvalid;
  }
  if (values.phone.length === 0) {
    errors.phone = copy.phoneRequired;
  } else if (values.phone.length > 100) {
    errors.phone = copy.phoneInvalid;
  }
  return errors;
};

const displayedErrors = (
  dismissed: boolean,
  fieldErrors: ContactFormFieldErrors | undefined,
  validationErrors: ContactFormFieldErrors,
) =>
  dismissed || fieldErrors === undefined
    ? validationErrors
    : { ...fieldErrors, ...validationErrors };

const displayedFormStatus = (dismissed: boolean, formStatus: ContactFormStatus | undefined) =>
  dismissed ? undefined : formStatus;

const isFeedbackDismissed = (
  dismissedFeedback: ContactFormFeedbackIdentity | null,
  fieldErrors: ContactFormFieldErrors | undefined,
  formStatus: ContactFormStatus | undefined,
) =>
  dismissedFeedback !== null &&
  dismissedFeedback.fieldErrors === fieldErrors &&
  dismissedFeedback.formStatus === formStatus;

export const ContactForm = ({
  copy,
  disabled = false,
  fieldErrors,
  formStatus,
  initialValues,
  onCancel,
  onSubmit,
  onValuesChange,
  pending = false,
}: ContactFormProps) => {
  const [values, setValues] = useState(initialValues);
  const [validationErrors, setValidationErrors] = useState<ContactFormFieldErrors>({});
  const [dismissedFeedback, setDismissedFeedback] = useState<ContactFormFeedbackIdentity | null>(
    null,
  );
  const nameInputRef = useRef<HTMLInputElement>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const phoneInputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const controlsDisabled = disabled || pending;
  const suppliedFeedbackDismissed = isFeedbackDismissed(dismissedFeedback, fieldErrors, formStatus);
  const errors = displayedErrors(suppliedFeedbackDismissed, fieldErrors, validationErrors);
  const visibleFormStatus = displayedFormStatus(suppliedFeedbackDismissed, formStatus);
  const nameErrorId = 'contact-name-error';
  const emailErrorId = 'contact-email-error';
  const phoneErrorId = 'contact-phone-error';

  const changeValues = (nextValues: ContactFormValues, field: keyof ContactFormValues) => {
    setValues(nextValues);
    setDismissedFeedback({ fieldErrors, formStatus });
    setValidationErrors((current) => {
      if (current[field] === undefined) {
        return current;
      }
      return Object.fromEntries(Object.entries(current).filter(([key]) => key !== field));
    });
    onValuesChange?.(nextValues);
  };

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
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
    if (nextErrors.email !== undefined) {
      emailInputRef.current?.focus();
      return;
    }
    if (nextErrors.phone !== undefined) {
      phoneInputRef.current?.focus();
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
    // oxlint-disable-next-line promise/prefer-await-to-then -- React form callbacks stay synchronous, and both outcomes release the interaction guard.
    void Promise.resolve(submission).then(releaseSubmission, releaseSubmission);
  };

  return (
    <form className="contacts:grid contacts:min-w-0 contacts:gap-6" noValidate onSubmit={submit}>
      <FormInput
        aria-describedby={errors.name === undefined ? undefined : nameErrorId}
        aria-errormessage={errors.name === undefined ? undefined : nameErrorId}
        aria-invalid={errors.name === undefined ? undefined : true}
        disabled={controlsDisabled}
        helpText={
          errors.name === undefined ? undefined : <span id={nameErrorId}>{errors.name}</span>
        }
        id="contact-name"
        label={copy.nameLabel}
        name="name"
        onChange={(event) => changeValues({ ...values, name: event.currentTarget.value }, 'name')}
        ref={nameInputRef}
        required
        type="text"
        validateStatus={errors.name === undefined ? 'default' : 'error'}
        value={values.name}
      />

      <FormInput
        aria-describedby={errors.email === undefined ? undefined : emailErrorId}
        aria-errormessage={errors.email === undefined ? undefined : emailErrorId}
        aria-invalid={errors.email === undefined ? undefined : true}
        disabled={controlsDisabled}
        helpText={
          errors.email === undefined ? undefined : <span id={emailErrorId}>{errors.email}</span>
        }
        id="contact-email"
        label={copy.emailLabel}
        name="email"
        onChange={(event) => changeValues({ ...values, email: event.currentTarget.value }, 'email')}
        ref={emailInputRef}
        required
        type="email"
        validateStatus={errors.email === undefined ? 'default' : 'error'}
        value={values.email}
      />

      <PhoneInput
        disabled={controlsDisabled}
        id="contact-phone"
        name="phone"
        nativeValidation={false}
        onValueChange={(details) => changeValues({ ...values, phone: details.value }, 'phone')}
        required
        validateStatus={errors.phone === undefined ? 'default' : 'error'}
        value={values.phone}
      >
        <PhoneInput.Label>{copy.phoneLabel}</PhoneInput.Label>
        <PhoneInput.Control>
          <PhoneInput.CountryPicker triggerProps={{ 'aria-label': copy.phoneCountryLabel }} />
          <PhoneInput.Input
            aria-describedby={errors.phone === undefined ? undefined : phoneErrorId}
            aria-errormessage={errors.phone === undefined ? undefined : phoneErrorId}
            placeholder={copy.phonePlaceholder}
            ref={phoneInputRef}
          />
        </PhoneInput.Control>
        {errors.phone === undefined ? null : (
          <PhoneInput.StatusText id={phoneErrorId} showIcon status="error">
            {errors.phone}
          </PhoneInput.StatusText>
        )}
      </PhoneInput>

      {visibleFormStatus === undefined ? null : (
        <output aria-live="polite">
          <StatusText showIcon status={visibleFormStatus.status}>
            {visibleFormStatus.message}
          </StatusText>
        </output>
      )}

      <div className="contacts:flex contacts:flex-col-reverse contacts:gap-3 contacts:sm:flex-row contacts:sm:justify-end">
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
          loadingText={copy.submitting}
          type="submit"
          variant="primary"
        >
          {copy.submit}
        </Button>
      </div>
    </form>
  );
};
