/**
 * Text screen readers announce after the label of a required field. ui-kit marks the field with "*" and reads its
 * own English "(required)" unless it gets this text, so the admin's form controls (`./form-controls.tsx`) pass it.
 */
const byLanguage: ReadonlyMap<string, string> = new Map([
  ['cs', '(povinné)'],
  ['en', '(required)'],
  ['sk', '(povinné)'],
]);

/** Czech wording: what a required field reads outside the i18n runtime. */
export const requiredLabel = '(povinné)';

/** The wording for the language the i18n runtime reports (`useModernI18n().language`); Czech for any other. */
export const requiredLabelFor = (language: string | undefined): string =>
  byLanguage.get((language ?? 'cs').slice(0, 2).toLowerCase()) ?? requiredLabel;
