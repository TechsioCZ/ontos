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
export { EntryTextField, MemberCheckboxField, makeMemberCheckboxField } from './kit-fields-set.ts';
export {
  AllRowsCheckboxField,
  ComboboxField,
  DateField,
  FileField,
  NumberField,
  RowCheckboxField,
  SelectField,
} from './kit-fields-pickers.ts';
