import { Label as KitLabel } from '@techsio/ui-kit/atoms/label';
import { CascadeSelect as KitCascadeSelect } from '@techsio/ui-kit/molecules/cascade-select';
import { Combobox as KitCombobox } from '@techsio/ui-kit/molecules/combobox';
import type { ComboboxProps } from '@techsio/ui-kit/molecules/combobox';
import { DatePicker as KitDatePicker } from '@techsio/ui-kit/molecules/date-picker';
import { FileUpload as KitFileUpload } from '@techsio/ui-kit/molecules/file-upload';
import { FormInput as KitFormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormNumericInput as KitFormNumericInput } from '@techsio/ui-kit/molecules/form-numeric-input';
import { FormTextarea as KitFormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { PhoneInput as KitPhoneInput } from '@techsio/ui-kit/molecules/phone-input';
import { QuantityField as KitQuantityField } from '@techsio/ui-kit/molecules/quantity-field';
import { RadioCard as KitRadioCard } from '@techsio/ui-kit/molecules/radio-card';
import { RadioGroup as KitRadioGroup } from '@techsio/ui-kit/molecules/radio-group';
import { SearchForm as KitSearchForm } from '@techsio/ui-kit/molecules/search-form';
import { Switch as KitSwitch } from '@techsio/ui-kit/molecules/switch';
import { useSyncExternalStore } from 'react';
import type { ComponentProps, ReactElement } from 'react';

import { requiredLabelFor } from './required-labels.ts';

/**
 * ui-kit form controls mark a required field with "*" and read a hidden text after its label; ui-kit's own text is
 * English. These controls are ui-kit's with the page language's text passed in, so admin forms import them from here
 * and change nothing else. The page language is the document's `lang`, which the Shell sets for every page, modules
 * included; this package has no i18n runtime of its own. The server render and a document without `lang` read Czech,
 * the admin's language. A `requiredLabel` the caller passes still wins.
 */
const subscribeToLanguage = (onChange: () => void): (() => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ['lang'], attributes: true });
  return () => {
    observer.disconnect();
  };
};
const documentLanguage = (): string => document.documentElement.lang;
const serverLanguage = (): string => 'cs';
const useRequiredLabel = (): string =>
  requiredLabelFor(useSyncExternalStore(subscribeToLanguage, documentLanguage, serverLanguage) || undefined);

export const Label = (props: ComponentProps<typeof KitLabel>): ReactElement => (
  <KitLabel requiredLabel={useRequiredLabel()} {...props} />
);

export const FormInput = (props: ComponentProps<typeof KitFormInput>): ReactElement => (
  <KitFormInput requiredLabel={useRequiredLabel()} {...props} />
);

export const FormTextarea = (props: ComponentProps<typeof KitFormTextarea>): ReactElement => (
  <KitFormTextarea requiredLabel={useRequiredLabel()} {...props} />
);

export const FormNumericInput = (props: ComponentProps<typeof KitFormNumericInput>): ReactElement => (
  <KitFormNumericInput requiredLabel={useRequiredLabel()} {...props} />
);

export const Combobox = <T,>(props: ComboboxProps<T>): ReactElement => (
  <KitCombobox<T> requiredLabel={useRequiredLabel()} {...props} />
);

export const QuantityField = (props: ComponentProps<typeof KitQuantityField>): ReactElement => (
  <KitQuantityField requiredLabel={useRequiredLabel()} {...props} />
);

export const Switch = (props: ComponentProps<typeof KitSwitch>): ReactElement => (
  <KitSwitch requiredLabel={useRequiredLabel()} {...props} />
);

/* Compound controls take `required` on the root and read the text in their `Label` part; only that part changes. */

const DatePickerLabel = (props: ComponentProps<typeof KitDatePicker.Label>): ReactElement => (
  <KitDatePicker.Label requiredLabel={useRequiredLabel()} {...props} />
);
export const DatePicker: typeof KitDatePicker = Object.assign(
  (props: ComponentProps<typeof KitDatePicker>) => <KitDatePicker {...props} />,
  KitDatePicker,
  { Label: DatePickerLabel },
);

const RadioGroupLabel = (props: ComponentProps<typeof KitRadioGroup.Label>): ReactElement => (
  <KitRadioGroup.Label requiredLabel={useRequiredLabel()} {...props} />
);
export const RadioGroup: typeof KitRadioGroup = Object.assign(
  (props: ComponentProps<typeof KitRadioGroup>) => <KitRadioGroup {...props} />,
  KitRadioGroup,
  { Label: RadioGroupLabel },
);

const RadioCardLabel = (props: ComponentProps<typeof KitRadioCard.Label>): ReactElement => (
  <KitRadioCard.Label requiredLabel={useRequiredLabel()} {...props} />
);
export const RadioCard: typeof KitRadioCard = Object.assign(
  (props: ComponentProps<typeof KitRadioCard>) => <KitRadioCard {...props} />,
  KitRadioCard,
  { Label: RadioCardLabel },
);

const SearchFormLabel = (props: ComponentProps<typeof KitSearchForm.Label>): ReactElement => (
  <KitSearchForm.Label requiredLabel={useRequiredLabel()} {...props} />
);
export const SearchForm: typeof KitSearchForm = Object.assign(
  (props: ComponentProps<typeof KitSearchForm>) => <KitSearchForm {...props} />,
  KitSearchForm,
  { Label: SearchFormLabel },
);

const FileUploadLabel = (props: ComponentProps<typeof KitFileUpload.Label>): ReactElement => (
  <KitFileUpload.Label requiredLabel={useRequiredLabel()} {...props} />
);
export const FileUpload: typeof KitFileUpload = Object.assign(
  (props: ComponentProps<typeof KitFileUpload>) => <KitFileUpload {...props} />,
  KitFileUpload,
  { Label: FileUploadLabel },
);

const PhoneInputLabel = (props: ComponentProps<typeof KitPhoneInput.Label>): ReactElement => (
  <KitPhoneInput.Label requiredLabel={useRequiredLabel()} {...props} />
);
export const PhoneInput: typeof KitPhoneInput = Object.assign(
  (props: ComponentProps<typeof KitPhoneInput>) => <KitPhoneInput {...props} />,
  KitPhoneInput,
  { Label: PhoneInputLabel },
);

const CascadeSelectLabel = (props: ComponentProps<typeof KitCascadeSelect.Label>): ReactElement => (
  <KitCascadeSelect.Label requiredLabel={useRequiredLabel()} {...props} />
);
export const CascadeSelect: typeof KitCascadeSelect = Object.assign(
  (props: ComponentProps<typeof KitCascadeSelect>) => <KitCascadeSelect {...props} />,
  KitCascadeSelect,
  { Label: CascadeSelectLabel },
);
