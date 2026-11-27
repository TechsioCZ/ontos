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
export { FormScope } from './form-scope.ts';
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
export { ComboboxField, MultiComboboxField } from './kit-fields-combobox.ts';
export { SwitchField } from './kit-fields-switch.ts';
export { FileField } from './kit-fields-file.ts';
export { ClearableChoiceField } from './kit-fields-clearable-select.ts';
export { SelectTemplateField } from './kit-fields-select-template.ts';
export { DateField, DateRangeField } from './kit-fields-date.ts';
export type { DayRangeValue } from './kit-fields-date.ts';
export { NumericField, makeItemNumericField } from './kit-fields-numeric.ts';
export type { ItemNumber } from './kit-fields-numeric.ts';
export { ChoiceLensField } from './kit-fields-choice-lens.ts';
export { CheckedTextField } from './kit-fields-checked-text.ts';
export { makeCheckboxGroupField } from './kit-fields-checkbox-group.ts';
export { SuggestedTextAreaField, SuggestedTextField } from './kit-fields-suggested.ts';
export { EntryTextField, MemberCheckboxField, makeMemberCheckboxField } from './kit-fields-set.ts';
export { EntryTextAreaField } from './kit-fields-entry-textarea.ts';
export { type FieldNotice, NoticedTextField } from './noticed-text-field.ts';
export { CheckboxSettingField } from './checkbox-setting-field.ts';
export { EntrySwitchField } from './entry-switch-field.ts';
export { UpperCaseTextField } from './upper-case-text-field.ts';
export { BareTextAreaField, BareTextField } from './kit-fields-bare.ts';
export { RuledTextAreaField, RuledTextField } from './kit-fields-ruled.ts';
export { TemplateChoiceField } from './kit-fields-template-choice.ts';
export { RichRadioField } from './kit-fields-rich-radio.ts';
export type { RichChoice } from './kit-fields-rich-radio.ts';
export { FlaggedTextAreaField, FlaggedTextField, RowCheckboxField } from './kit-fields-pickers.ts';
