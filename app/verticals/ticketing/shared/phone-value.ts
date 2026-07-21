export type PhoneValueValidationFailure = 'control_character' | 'line_separator' | 'too_long';

export type PhoneValueValidationResult =
  | { readonly ok: true; readonly value: string | null }
  | { readonly failure: PhoneValueValidationFailure; readonly ok: false };

const unicodeWhitespaceOnly = /^\p{White_Space}*$/u;
const controlCharacter = /\p{Cc}/u;
const lineSeparator = /[\u2028\u2029]/u;

export const validatePhoneValue = (value: string | null): PhoneValueValidationResult => {
  if (value === null) {
    return { ok: true, value: null };
  }
  if (controlCharacter.test(value)) {
    return { failure: 'control_character', ok: false };
  }
  if (lineSeparator.test(value)) {
    return { failure: 'line_separator', ok: false };
  }
  if ([...value].length > 256) {
    return { failure: 'too_long', ok: false };
  }
  return unicodeWhitespaceOnly.test(value) ? { ok: true, value: null } : { ok: true, value };
};

export const phoneTelHref = (value: string): string => `tel:${encodeURIComponent(value)}`;
