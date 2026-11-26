/**
 * The ONE place that knows how Better Auth's two-factor plugin names and stores a one-time code (E-08). Better Auth does not
 * export these facts, so Auth's one-time-code delivery and its recovery store would otherwise each hard-code them and break
 * silently on a Better Auth upgrade. Everything below is verified against {@link VERIFIED_BETTER_AUTH_VERSION}; the canary
 * `tests/unit/portal-auth-better-auth-two-factor.test.ts` reads the installed plugin and fails when its version or any of
 * these facts changes, so an upgrade is a deliberate re-verification here and never a silent break.
 */

/** The `better-auth` release whose two-factor plugin these facts were read from (`src/plugins/two-factor`). */
export const VERIFIED_BETTER_AUTH_VERSION = '1.7.23';

/** The name of the signed cookie that names a pending two-factor sign-in challenge (`constant.ts`: `TWO_FACTOR_COOKIE_NAME`). */
export const TWO_FACTOR_COOKIE_NAME = 'two_factor';

/**
 * The prefix of the verification identifier a one-time code is stored under: `2fa-otp-<key>` (`otp/index.ts`). The realm hashes
 * every verification identifier at rest, so the stored identifier is the digest of this text (see the recovery store).
 */
export const OTP_STORAGE_IDENTIFIER_PREFIX = '2fa-otp-';

/** The text a one-time code's challenge key is stored under, before the realm hashes it. */
export const otpStorageIdentifierOf = (challengeKey: string): string =>
  `${OTP_STORAGE_IDENTIFIER_PREFIX}${challengeKey}`;

/**
 * A one-time code is a run of digits (`generateRandomString(digits, '0-9')`). The realm configures a six-digit code; this is the
 * bound of what Auth treats as a code at all, so an arbitrary stored value is never compared as one.
 */
export const OTP_CODE_PATTERN = /^\d{1,12}$/u;

/** The separator of a stored one-time code: `<code>:<failed presentations counted>` (`otp/index.ts`). */
const STORED_OTP_SEPARATOR = ':';

export interface StoredOneTimeCode {
  readonly code: string;
  /** The failed presentations Better Auth counted against the code. */
  readonly failedAttempts: number;
}

/** Splits the value Better Auth stores for a one-time code into the code and its counted failures. */
export const storedOneTimeCodeOf = (stored: string): StoredOneTimeCode => {
  const [code, counted] = stored.split(STORED_OTP_SEPARATOR);
  return { code: code ?? '', failedAttempts: Math.trunc(Number(counted ?? '')) || 0 };
};
