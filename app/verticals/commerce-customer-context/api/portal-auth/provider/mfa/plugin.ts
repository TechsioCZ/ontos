import { twoFactor } from 'better-auth/plugins/two-factor';
import type { OTPOptions, TwoFactorOptions } from 'better-auth/plugins/two-factor';

/** The provider-owned MFA controls used by the Commerce Portal Better Auth realm. */
export interface CommercePortalAuthMfaPolicy {
  /** The maximum age of an MFA challenge and the challenge cookie, in seconds. */
  readonly challengeMaxAgeSeconds: number;
  /** The lockout duration after the failed-attempt threshold is reached, in seconds. */
  readonly lockoutDurationSeconds: number;
  /** The number of failed verifications before the account is temporarily locked. */
  readonly maxFailedAttempts: number;
  /** Better Auth expresses OTP lifetime in minutes. */
  readonly otpDigits: 6;
  readonly otpPeriodMinutes: number;
  /** TOTP codes use the RFC 6238 six-digit, thirty-second profile. */
  readonly totpDigits: 6;
  readonly totpPeriodSeconds: 30;
  /** A trusted-device cookie is disabled for this realm. */
  readonly trustDeviceMaxAgeSeconds: 0;
}

export const COMMERCE_PORTAL_AUTH_MFA_POLICY: CommercePortalAuthMfaPolicy = Object.freeze({
  challengeMaxAgeSeconds: 600,
  lockoutDurationSeconds: 300,
  maxFailedAttempts: 5,
  otpDigits: 6,
  otpPeriodMinutes: 10,
  totpDigits: 6,
  totpPeriodSeconds: 30,
  trustDeviceMaxAgeSeconds: 0,
});

export interface CommercePortalAuthMfaPluginInput {
  readonly policy: CommercePortalAuthMfaPolicy;
  readonly sendOTP: NonNullable<OTPOptions['sendOTP']>;
}

/**
 * Build the installed Better Auth two-factor plugin with the Commerce policy made explicit.
 * Keeping this value inferred is intentional: the root auth factory must pass the returned
 * plugin in an inferred BetterAuthOptions object so Better Auth exposes its server APIs.
 */
export type CommercePortalAuthTwoFactorPlugin = ReturnType<typeof twoFactor>;

export const createCommercePortalAuthTwoFactorPlugin = (
  input: CommercePortalAuthMfaPluginInput,
): CommercePortalAuthTwoFactorPlugin => {
  const { policy, sendOTP } = input;
  const options: TwoFactorOptions = {
    accountLockout: {
      durationSeconds: policy.lockoutDurationSeconds,
      enabled: true,
      maxFailedAttempts: policy.maxFailedAttempts,
    },
    allowPasswordless: false,
    backupCodeOptions: {
      storeBackupCodes: 'encrypted',
    },
    issuer: 'OntOS Commerce Portal',
    otpOptions: {
      allowedAttempts: policy.maxFailedAttempts,
      digits: policy.otpDigits,
      period: policy.otpPeriodMinutes,
      sendOTP,
    },
    skipVerificationOnEnable: false,
    totpOptions: {
      digits: policy.totpDigits,
      period: policy.totpPeriodSeconds,
    },
    trustDeviceMaxAge: policy.trustDeviceMaxAgeSeconds,
    twoFactorCookieMaxAge: policy.challengeMaxAgeSeconds,
  };
  return twoFactor(options);
};
