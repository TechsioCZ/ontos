import type { Auth } from 'better-auth';
import { isAPIError } from 'better-auth/api';
import { Duration, Effect, Context, Layer, Schema } from 'effect';

import { CommercePortalAuthInstance } from '../auth.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../config.ts';
import { CommercePortalAuthRecoveryProviderFailure } from './provider-failure.ts';
import { CommercePortalAuthRecoveryRateLimitService } from '../../rate-limit-service.ts';
import type { CommercePortalAuthRecoveryRateLimit } from '../../rate-limit-service.ts';
import { CommercePortalAuthRecoveryStoreService } from './store-service.ts';
import type { CommercePortalAuthRecoveryStore } from './store-service.ts';

type RequestPasswordResetInput = Parameters<Auth['api']['requestPasswordReset']>[0];
type RequestPasswordResetResult = Awaited<ReturnType<Auth['api']['requestPasswordReset']>>;
type ResetPasswordInput = Parameters<Auth['api']['resetPassword']>[0];
type ResetPasswordResult = Awaited<ReturnType<Auth['api']['resetPassword']>>;
type SendVerificationEmailInput = Parameters<Auth['api']['sendVerificationEmail']>[0];
type SendVerificationEmailResult = Awaited<ReturnType<Auth['api']['sendVerificationEmail']>>;

export interface CommercePortalAuthRecoveryProvider {
  readonly requestPasswordReset: (
    input: RequestPasswordResetInput,
  ) => Effect.Effect<RequestPasswordResetResult, CommercePortalAuthRecoveryProviderFailure>;
  readonly resetPassword: (
    input: ResetPasswordInput,
  ) => Effect.Effect<ResetPasswordResult, CommercePortalAuthRecoveryProviderFailure>;
  readonly sendVerificationEmail: (
    input: SendVerificationEmailInput,
  ) => Effect.Effect<SendVerificationEmailResult, CommercePortalAuthRecoveryProviderFailure>;
}

export class CommercePortalAuthRecoveryProviderService extends Context.Service<
  CommercePortalAuthRecoveryProviderService,
  CommercePortalAuthRecoveryProvider
>()(
  '@app/commerce-customer-context/api/portal-auth/provider/recovery/provider-service/CommercePortalAuthRecoveryProviderService',
) {}

const providerTimeout = Duration.millis(COMMERCE_PORTAL_AUTH_POLICY.accountCreation.providerCallTimeoutMilliseconds);

const ProviderCodeSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));
const ProviderStatusSchema = Schema.Finite.check(Schema.isInt());

const withCause = <ErrorValue extends object>(error: ErrorValue, cause: unknown): ErrorValue =>
  Object.defineProperty(error, 'cause', { configurable: true, value: cause });

/** Better Auth diagnostics are classified here so no provider body survives past this bridge. */
const providerFailure = (operation: string, cause: unknown): CommercePortalAuthRecoveryProviderFailure => {
  const apiError = isAPIError(cause) ? cause : undefined;
  return withCause(
    new CommercePortalAuthRecoveryProviderFailure({
      operation,
      providerCode: Schema.is(ProviderCodeSchema)(apiError?.body?.code) ? apiError.body.code : undefined,
      providerStatus: Schema.is(ProviderStatusSchema)(apiError?.statusCode) ? apiError.statusCode : undefined,
    }),
    cause,
  );
};

const call = <Result>(
  operation: string,
  run: () => Promise<Result>,
): Effect.Effect<Result, CommercePortalAuthRecoveryProviderFailure> =>
  Effect.tryPromise({
    catch: (cause) => providerFailure(operation, cause),
    try: run,
  }).pipe(
    Effect.timeoutOrElse({
      duration: providerTimeout,
      orElse: () => Effect.fail(providerFailure(operation, { reason: 'PROVIDER_TIMEOUT' })),
    }),
  );

/** Better Auth's Promise API is kept behind this narrow provider-owned Effect bridge. */
export const makeCommercePortalAuthRecoveryProvider = (
  auth: Pick<Auth, 'api'>,
): CommercePortalAuthRecoveryProvider => ({
  requestPasswordReset: (input) => call('request-password-reset', auth.api.requestPasswordReset.bind(auth.api, input)),
  resetPassword: (input) => call('reset-password', auth.api.resetPassword.bind(auth.api, input)),
  sendVerificationEmail: (input) =>
    call('send-verification-email', auth.api.sendVerificationEmail.bind(auth.api, input)),
});

const RATE_LIMIT_OPERATION = 'recovery-rate-limit';

/**
 * Better Auth enforced the deployment's recovery limits inside its router against the realm's own
 * durable `rateLimit` table (`rateLimit.storage: 'database'`, `../auth.ts`). The typed `auth.api`
 * surface this group reaches never runs them, so the owner re-applies the same rules against the
 * same durable counter store through its own persistence seam: every replica of the deployment
 * spends one shared budget instead of a per-process one. A store that cannot answer within the
 * provider call budget fails closed, so no request is ever served uncounted.
 */
export const makeCommercePortalAuthRecoveryRateLimit = (
  store: CommercePortalAuthRecoveryStore,
): CommercePortalAuthRecoveryRateLimit => ({
  consume: (key, rule) =>
    store.consumeRateLimitBudget({ key, rule }).pipe(
      Effect.mapError((cause) => providerFailure(RATE_LIMIT_OPERATION, cause)),
      Effect.timeoutOrElse({
        duration: providerTimeout,
        orElse: () => Effect.fail(providerFailure(RATE_LIMIT_OPERATION, { reason: 'RATE_LIMIT_STORE_TIMEOUT' })),
      }),
    ),
});

/** The constructed realm stays a visible requirement; the composition root supplies it once. */
export const CommercePortalAuthRecoveryProviderLive = Layer.effect(
  CommercePortalAuthRecoveryProviderService,
  Effect.gen(function* makeCommercePortalAuthRecoveryProviderLive() {
    const auth = yield* CommercePortalAuthInstance;
    return makeCommercePortalAuthRecoveryProvider(auth);
  }),
);

/** The owner ledger owns the recovery budget, so the counters stay durable across every replica. */
export const CommercePortalAuthRecoveryRateLimitLive = Layer.effect(
  CommercePortalAuthRecoveryRateLimitService,
  Effect.gen(function* makeCommercePortalAuthRecoveryRateLimitLive() {
    const store = yield* CommercePortalAuthRecoveryStoreService;
    return makeCommercePortalAuthRecoveryRateLimit(store);
  }),
);
