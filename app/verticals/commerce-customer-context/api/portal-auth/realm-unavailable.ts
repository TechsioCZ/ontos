import { getSession as betterAuthGetSession, signOut as betterAuthSignOut } from 'better-auth/api';
import { Effect, Layer, Redacted } from 'effect';

import type { CommercePortalAuthOptions } from './provider/auth.ts';
import { CommercePortalAuthAccountCreationService } from './provider/account-create.ts';
import { CommercePortalAuthAccountCreationUnavailable } from './provider/account-creation-unavailable.ts';
import { CommercePortalAuthConfig } from './provider/config-service.ts';
import type { CommercePortalAuthConfigValue } from './provider/config.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from './provider/config.ts';
import { CommercePortalAuthRecoveryRateLimitService } from './rate-limit-service.ts';
import { CommercePortalAuthRecoveryProviderFailure } from './provider/recovery/provider-failure.ts';
import { CommercePortalAuthRecoveryService } from './provider/recovery/service.ts';
import { CommercePortalAuthRecoveryUnavailable } from './provider/recovery/unavailable.ts';
import { CommercePortalAuthMfaService, commercePortalAuthMfaProviderUnavailable } from './provider/mfa/service.ts';
import { CommercePortalAuthStepUpService } from './provider/step-up/step-up-service.ts';
import { CommercePortalAuthStepUpUnavailable } from './provider/step-up/unavailable.ts';
import { CommercePortalAuthStepUpHttpProviderUnavailableLive } from './provider/step-up/http-provider-unavailable.ts';
import { CommercePortalAuthSessionLifecycle } from './session/lifecycle-service.ts';
import { CommercePortalAuthProviderUnavailable, CommercePortalAuthSessionUnavailable } from './session/errors.ts';
import { CommercePortalAuthService } from './session/http.ts';

/**
 * The Commerce portal realm is optional, and `assembleEffectBffRuntime` requires a handler Layer
 * whose error channel is `never`: building the real realm layers without `COMMERCE_PORTAL_AUTH_*`
 * would turn one failing provider layer into a defect for the whole router. These leaves implement
 * the same service tags so every portal operation fails closed with the owner's retryable 503
 * while readiness and the business routes keep serving.
 */
const UNAVAILABLE_REASON = 'The Commerce portal authentication realm is not installed in this deployment';

const sessionUnavailable = (operation: string): CommercePortalAuthSessionUnavailable =>
  new CommercePortalAuthSessionUnavailable({ operation, reason: UNAVAILABLE_REASON });

const providerUnavailable = (operation: string): CommercePortalAuthProviderUnavailable =>
  new CommercePortalAuthProviderUnavailable({ operation, reason: UNAVAILABLE_REASON });

const recoveryUnavailable = (operation: string): CommercePortalAuthRecoveryUnavailable =>
  new CommercePortalAuthRecoveryUnavailable({ operation, reason: UNAVAILABLE_REASON });

const stepUpUnavailable = (operation: string): CommercePortalAuthStepUpUnavailable =>
  new CommercePortalAuthStepUpUnavailable({ operation, reason: UNAVAILABLE_REASON });

const budgetUnavailable = (operation: string): CommercePortalAuthRecoveryProviderFailure =>
  new CommercePortalAuthRecoveryProviderFailure({ operation });

const mfaUnavailable = (operation: string) =>
  commercePortalAuthMfaProviderUnavailable(operation, { reason: UNAVAILABLE_REASON });

/**
 * Every method of an uninstalled capability answers the same typed refusal, so a stub method is
 * only the operation it reports. The operation names are the published vocabulary of the refusal —
 * they reach the caller's problem body — so each Tag names its own rather than deriving them.
 */
const unavailableService =
  <Failure>(refuse: (operation: string) => Failure) =>
  (operation: string) =>
  (): Effect.Effect<never, Failure> =>
    Effect.fail(refuse(operation));

/**
 * The realm descriptor an uninstalled deployment answers with. It holds no secret material and no
 * connection string: nothing here can mint, sign or verify anything, because every operation that
 * would read or write the provider fails closed above. The trusted origins are the host's own, so
 * a first-party caller receives the retryable 503 that names the real condition instead of the
 * untrusted-origin 403 an empty list would answer for every request.
 */
const unavailableConfiguration = (trustedOrigins: readonly string[]): CommercePortalAuthConfigValue =>
  Object.freeze({
    baseUrl: trustedOrigins[0] ?? '',
    connectionString: Redacted.make(''),
    nodeEnvironment: '',
    policy: COMMERCE_PORTAL_AUTH_POLICY,
    secret: Redacted.make(''),
    secureCookies: true,
    trustedOrigins: Object.freeze([...trustedOrigins]),
    trustedProxies: Object.freeze([]),
    versionedSecrets: Object.freeze([]),
  });

const sessionRefusal = unavailableService(sessionUnavailable);
const unavailableSessionLifecycle: CommercePortalAuthSessionLifecycle['Service'] = {
  disableAccount: sessionRefusal('disable-account'),
  evidenceForSession: sessionRefusal('evidence-for-session'),
  refresh: sessionRefusal('refresh'),
  revoke: sessionRefusal('revoke'),
  revokeAll: sessionRefusal('revoke-all'),
  rotateIdentifierForCookie: sessionRefusal('rotate-identifier'),
  signIn: sessionRefusal('sign-in'),
  signOut: sessionRefusal('sign-out'),
};

const mfaRefusal = unavailableService(mfaUnavailable);
const unavailableMfaService: CommercePortalAuthMfaService['Service'] = {
  disableTwoFactor: mfaRefusal('disable-two-factor'),
  enableTwoFactor: mfaRefusal('enable-two-factor'),
  generateBackupCodes: mfaRefusal('generate-backup-codes'),
  getTOTPURI: mfaRefusal('get-totp-uri'),
  sendTwoFactorOTP: mfaRefusal('send-two-factor-otp'),
  verifyBackupCode: mfaRefusal('verify-backup-code'),
  verifyTOTP: mfaRefusal('verify-totp'),
  verifyTwoFactorOTP: mfaRefusal('verify-two-factor-otp'),
};

const recoveryRefusal = unavailableService(recoveryUnavailable);
const unavailableRecoveryService: CommercePortalAuthRecoveryService['Service'] = {
  registerEmailVerificationToken: recoveryRefusal('register-email-verification-token'),
  requestEmailVerification: recoveryRefusal('request-email-verification'),
  requestPasswordReset: recoveryRefusal('request-password-reset'),
  resetPassword: recoveryRefusal('reset-password'),
  verifyEmail: recoveryRefusal('verify-email'),
};

const stepUpRefusal = unavailableService(stepUpUnavailable);
const unavailableStepUpService: CommercePortalAuthStepUpService['Service'] = {
  issue: stepUpRefusal('issue'),
  verify: stepUpRefusal('verify'),
};

const unavailableRecoveryRateLimit: CommercePortalAuthRecoveryRateLimitService['Service'] = {
  consume: unavailableService(budgetUnavailable)('consume'),
};

/**
 * `getSession` and `signOut` are the only provider calls the session transport makes. Better Auth
 * types both as its own route endpoints — a callable carrying that route's declared `options` and
 * `path` — so the uninstalled realm answers with those exact route descriptors and a call that
 * rejects. The transport already classifies a rejected provider call as the retryable
 * session-unavailable problem, which is the whole point: an absent realm must never answer
 * `anonymous`, the way a provider returning `null` for an unparseable cookie would.
 */
const providerGetSessionRoute = betterAuthGetSession<CommercePortalAuthOptions>();

/**
 * The uninstalled route refuses synchronously. `Effect.tryPromise` — the only way this transport
 * calls the provider — routes a synchronous throw through the very same `catch` mapper it applies
 * to a rejected promise, so the observable outcome is identical while this module keeps no Promise
 * of its own to construct or forget.
 */
const refuseProviderCall = (operation: string): never => {
  throw providerUnavailable(operation);
};

const unavailableProviderApi: CommercePortalAuthService['Service']['api'] = {
  getSession: Object.assign(() => refuseProviderCall('get-session'), {
    options: providerGetSessionRoute.options,
    path: providerGetSessionRoute.path,
  }),
  signOut: Object.assign(() => refuseProviderCall('sign-out'), {
    options: betterAuthSignOut.options,
    path: betterAuthSignOut.path,
  }),
};

/**
 * The private account-creation capability, fail-closed. The enrollment start route still creates
 * the durable Attempt and durably claims its `provider.account.create` transition under ordinary
 * governance, then answers the retryable 503 at the exact seam this deployment is missing rather
 * than silently accepting a credential it has nowhere to place. No caller can reach a provider
 * effect through this leaf.
 */
const unavailableAccountCreation: CommercePortalAuthAccountCreationService['Service'] = {
  createAccount: unavailableService(
    () => new CommercePortalAuthAccountCreationUnavailable({ reason: UNAVAILABLE_REASON }),
  )('create-account'),
};

/** Exactly the tags the five portal-auth groups read, with no provider, database or transport. */
export type CommercePortalAuthHandlerServices =
  | CommercePortalAuthAccountCreationService
  | CommercePortalAuthConfig
  | CommercePortalAuthMfaService
  | CommercePortalAuthRecoveryRateLimitService
  | CommercePortalAuthRecoveryService
  | CommercePortalAuthService
  | CommercePortalAuthSessionLifecycle
  | CommercePortalAuthStepUpService
  | Layer.Success<typeof CommercePortalAuthStepUpHttpProviderUnavailableLive>;

export const commercePortalAuthRealmUnavailableLive = (
  trustedOrigins: readonly string[],
): Layer.Layer<CommercePortalAuthHandlerServices> =>
  Layer.mergeAll(
    Layer.succeed(CommercePortalAuthAccountCreationService, unavailableAccountCreation),
    Layer.succeed(CommercePortalAuthConfig, unavailableConfiguration(trustedOrigins)),
    Layer.succeed(CommercePortalAuthMfaService, unavailableMfaService),
    Layer.succeed(CommercePortalAuthRecoveryRateLimitService, unavailableRecoveryRateLimit),
    Layer.succeed(CommercePortalAuthRecoveryService, unavailableRecoveryService),
    Layer.succeed(CommercePortalAuthService, { api: unavailableProviderApi }),
    Layer.succeed(CommercePortalAuthSessionLifecycle, unavailableSessionLifecycle),
    Layer.succeed(CommercePortalAuthStepUpService, unavailableStepUpService),
    CommercePortalAuthStepUpHttpProviderUnavailableLive,
  );
