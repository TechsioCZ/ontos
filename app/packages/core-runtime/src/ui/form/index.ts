/**
 * `@app/core-runtime/ui/form`: the one form model for module UI.
 *
 * A form takes its fields and validation from the Action payload Schema (`fromPayload`), holds its
 * state in effect-form atoms and renders every control through the kit bindings below. Module UI
 * imports forms only from here; `ontos-form/one-form-model` fails any other form state, form
 * library or kit form control.
 */
export { useAtomSet, useAtomSubscribe, useAtomValue } from '@effect/atom-react';
export { Field, FormBuilder, FormReact } from '@lucas-barake/effect-form-react';
export { makeActionAttempt } from './action-attempt.ts';
export { fromPayload } from './payload-form.ts';
export type { PayloadFormFields } from './payload-form.ts';
export { FormRoot, FormRootError, SubmitButton, useFormPending } from './form-root.ts';
export {
  CheckboxField,
  ChoiceField,
  MultiChoiceField,
  OptionalTextAreaField,
  OptionalTextField,
  RadioField,
  TextAreaField,
  TextField,
} from './kit-fields.ts';
export type { FieldChoice } from './kit-fields.ts';
export { ComboboxField } from './kit-fields-combobox.ts';
export { EntryTextField, MemberCheckboxField, makeMemberCheckboxField } from './kit-fields-set.ts';
export { NumericField, makeItemNumericField } from './kit-fields-numeric.ts';
export type { ItemNumber } from './kit-fields-numeric.ts';
export { SwitchField } from './kit-fields-switch.ts';
export { EntryTextAreaField } from './kit-fields-entry-textarea.ts';
export { FilePickerField } from './kit-fields-file.ts';
export { DateRangeField } from './kit-fields-date.ts';
export type { DayRangeValue } from './kit-fields-date.ts';
export { ClearableChoiceField } from './kit-fields-select.ts';
export { SelectTemplateField } from './kit-fields-select-template.ts';
export { RichRadioField } from './kit-fields-rich-radio.ts';
export type { RichChoice } from './kit-fields-rich-radio.ts';
