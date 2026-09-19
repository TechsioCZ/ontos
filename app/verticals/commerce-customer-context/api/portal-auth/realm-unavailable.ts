import { getSession as betterAuthGetSession, signOut as betterAuthSignOut } from 'better-auth/api';
import { Effect, Layer, Redacted } from 'effect';

import type { CommercePortalAuthOptions } from './provider/auth.ts';
import { CommercePortalAuthAccountCreationService } from './provider/account-creation-service.ts';
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
 * The Commerce portal realm is optional. A deployment that never supplied `COMMERCE_PORTAL_AUTH_*`
 * has no Better Auth secret, no provider database and no transactional email transport, and the
 * real realm layers cannot be built there. Building them anyway is what turned every route of this
 * vertical — readiness included — into a 500: `assembleEffectBffRuntime` requires a handler Layer
 * whose error channel is `never`, so the composition root ends in `Layer.orDie` and one failing
 * provider layer becomes a defect for the whole router.
 *
 * This module is the other half of that decision: the same service tags the four portal-auth
 * groups read, implemented so that every portal operation fails closed with the owner's retryable
 * 503 problem while readiness and the business routes keep serving. It follows the leaf the step-up
 * transport already installs (`CommercePortalAuthStepUpHttpProviderUnavailableLive`) and the owner
 * ports the composition root installs beside it (`profileReconfirmationPolicyUnavailableLive`,
 * `ProfileReconciliationOwnerVerifierUnavailableLive`).
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
  Effect.fail(commercePortalAuthMfaProviderUnavailable(operation, { reason: UNAVAILABLE_REASON }));

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

const unavailableSessionLifecycle: CommercePortalAuthSessionLifecycle['Service'] = {
  disableAccount: () => Effect.fail(sessionUnavailable('disable-account')),
  evidenceForSession: () => Effect.fail(sessionUnavailable('evidence-for-session')),
  refresh: () => Effect.fail(sessionUnavailable('refresh')),
  revoke: () => Effect.fail(sessionUnavailable('revoke')),
  revokeAll: () => Effect.fail(sessionUnavailable('revoke-all')),
  rotateIdentifierForCookie: () => Effect.fail(sessionUnavailable('rotate-identifier')),
  signIn: () => Effect.fail(sessionUnavailable('sign-in')),
  signOut: () => Effect.fail(sessionUnavailable('sign-out')),
};

const unavailableMfaService: CommercePortalAuthMfaService['Service'] = {
  disableTwoFactor: () => mfaUnavailable('disable-two-factor'),
  enableTwoFactor: () => mfaUnavailable('enable-two-factor'),
  generateBackupCodes: () => mfaUnavailable('generate-backup-codes'),
  getTOTPURI: () => mfaUnavailable('get-totp-uri'),
  sendTwoFactorOTP: () => mfaUnavailable('send-two-factor-otp'),
  verifyBackupCode: () => mfaUnavailable('verify-backup-code'),
  verifyTOTP: () => mfaUnavailable('verify-totp'),
  verifyTwoFactorOTP: () => mfaUnavailable('verify-two-factor-otp'),
};

const unavailableRecoveryService: CommercePortalAuthRecoveryService['Service'] = {
  registerEmailVerificationToken: () => Effect.fail(recoveryUnavailable('register-email-verification-token')),
  requestEmailVerification: () => Effect.fail(recoveryUnavailable('request-email-verification')),
  requestPasswordReset: () => Effect.fail(recoveryUnavailable('request-password-reset')),
  resetPassword: () => Effect.fail(recoveryUnavailable('reset-password')),
  verifyEmail: () => Effect.fail(recoveryUnavailable('verify-email')),
};

const unavailableStepUpService: CommercePortalAuthStepUpService['Service'] = {
  issue: () => Effect.fail(stepUpUnavailable('issue')),
  verify: () => Effect.fail(stepUpUnavailable('verify')),
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
  createAccount: () => Effect.fail(new CommercePortalAuthAccountCreationUnavailable({ reason: UNAVAILABLE_REASON })),
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
    Layer.succeed(CommercePortalAuthRecoveryRateLimitService, {
      consume: () => Effect.fail(budgetUnavailable('consume')),
    }),
    Layer.succeed(CommercePortalAuthRecoveryService, unavailableRecoveryService),
    Layer.succeed(CommercePortalAuthService, { api: unavailableProviderApi }),
    Layer.succeed(CommercePortalAuthSessionLifecycle, unavailableSessionLifecycle),
    Layer.succeed(CommercePortalAuthStepUpService, unavailableStepUpService),
    CommercePortalAuthStepUpHttpProviderUnavailableLive,
  );
