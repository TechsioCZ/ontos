/**
 * The deterministic PHONE canonicalization protocol Party owns and every ingress shares.
 *
 * Party is the owner of phone rules: the contact-point schemas, the durable contact point and the
 * canonical lookup value a duplicate check compares. Enrollment ingress needs the same answer
 * *before* it digests a start request or writes an Attempt, so the routine is published as this
 * immutable contract instead of being duplicated at the caller. It declares no imports, holds no
 * state and never reads the Party database: the same input always answers the same way.
 *
 * Formats, unchanged from the Party contact point rules:
 * - International (`+...`): 7 to 15 digits, first digit 1 to 9; lookup value `+<digits>`.
 * - National: an explicit two-letter country context is required; only CZ is approved, at exactly
 *   9 digits; lookup value `+420<digits>`.
 * - The extension is validated but never part of the lookup value.
 */

export interface NormalizedContactPhone {
  readonly countryCode: null | string;
  readonly displayValue: string;
  readonly extension: null | string;
  readonly lookupValue: string;
}

/**
 * A refused normalization carries the exact rule that refused it, so an owner keeps its own error
 * vocabulary while the rule itself has one home.
 */
export type ContactPhoneNormalizationResult =
  | { readonly normalized: NormalizedContactPhone; readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export const normalizeContactPhone = (
  rawValue: string,
  rawCountryCode?: string,
  rawExtension?: string,
): ContactPhoneNormalizationResult => {
  const displayValue = rawValue.trim();
  const countryCode = rawCountryCode?.trim().toUpperCase();
  const digits = displayValue.replaceAll(/[^0-9]/gu, '');
  const extension = rawExtension?.trim() ?? null;
  if (countryCode !== undefined && !/^[A-Z]{2}$/u.test(countryCode)) {
    return { ok: false, reason: 'PHONE country context must be a two-letter country code' };
  }
  if (extension !== null && !/^[0-9]{1,12}$/u.test(extension)) {
    return { ok: false, reason: 'PHONE extension must contain 1 to 12 digits' };
  }
  if (!/^\+?[()0-9 .-]+$/u.test(displayValue)) {
    return { ok: false, reason: 'PHONE contains unsupported characters' };
  }
  if (displayValue.startsWith('+')) {
    if (!/^[1-9][0-9]{6,14}$/u.test(digits)) {
      return {
        ok: false,
        reason: 'PHONE international form must contain 7 to 15 digits and start with 1 to 9',
      };
    }
    return {
      normalized: {
        countryCode: countryCode ?? (digits.startsWith('420') ? 'CZ' : null),
        displayValue,
        extension,
        lookupValue: `+${digits}`,
      },
      ok: true,
    };
  }
  if (countryCode === undefined) {
    return { ok: false, reason: 'National PHONE requires an explicit country context' };
  }
  if (countryCode !== 'CZ' || digits.length !== 9) {
    return { ok: false, reason: 'National PHONE has no approved normalization rule for this country' };
  }
  return {
    normalized: { countryCode, displayValue, extension, lookupValue: `+420${digits}` },
    ok: true,
  };
};
