import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import { Duration, Effect, Redacted, Schema } from 'effect';
import type { HttpServerRequest } from 'effect/unstable/http';

import { hashSubjectKey, noStoreHeaders, requireTrustedOrigin, resolveClientKey } from '../../http-transport.ts';
import { commerceCustomerContextApi } from '../../../../shared/api.ts';
import type {
  CommercePortalAuthPasswordResetPendingResultSchema,
  CommercePortalAuthRecoveryServiceProblem,
} from '../../../../shared/portal-auth/recovery-api.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../config.ts';
import { CommercePortalAuthConfig } from '../config-service.ts';
import type { CommercePortalAuthConfigValue } from '../config.ts';
import type {
  CommercePortalAuthPasswordResetBoundary,
  CommercePortalAuthPasswordResetRequestBoundary,
} from './contracts.ts';
import { CommercePortalAuthRecoveryInvalidRequest } from './invalid-request.ts';
import {
  commercePortalAuthRecoveryInvalidCallbackProblem,
  commercePortalAuthRecoveryInvalidProblem,
  commercePortalAuthRecoveryRateLimitedProblem,
  commercePortalAuthRecoveryRejectedProblem,
  commercePortalAuthRecoverySchemaErrorLive,
  commercePortalAuthRecoveryUnavailableProblem,
  commercePortalAuthRecoveryUntrustedOriginProblem,
} from './problems.ts';
import { CommercePortalAuthRecoveryRateLimitService } from '../../rate-limit-service.ts';
import type { CommercePortalAuthRecoveryRateLimitRule } from '../../rate-limit-service.ts';
import { CommercePortalAuthRecoveryRejected } from './rejected.ts';
import { CommercePortalAuthRecoveryService } from './service.ts';
import type { CommercePortalAuthRecoveryFailure } from './service.ts';
import { CommercePortalAuthRecoveryUnavailable } from './unavailable.ts';

type CommercePortalAuthPasswordResetPendingResult = typeof CommercePortalAuthPasswordResetPendingResultSchema.Type;

const VERIFY_EMAIL_OPERATION = 'verify-email';
const recoveryBridgeTimeout = Duration.millis(
  COMMERCE_PORTAL_AUTH_POLICY.accountCreation.providerCallTimeoutMilliseconds,
);

interface CommercePortalAuthRecoveryRouteRateLimit extends CommercePortalAuthRecoveryRateLimitRule {
  readonly route: string;
}

/** Better Auth applied its `/request-password-reset` custom rule to the reset request (`../auth.ts`). */
const requestPasswordResetRateLimit: CommercePortalAuthRecoveryRouteRateLimit = {
  max: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.recovery.max,
  route: '/request-password-reset',
  windowSeconds: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.recovery.windowSeconds,
};

/** The reset submission carries no custom rule, so Better Auth limited it with the default one. */
const resetPasswordRateLimit: CommercePortalAuthRecoveryRouteRateLimit = {
  max: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.default.max,
  route: '/reset-password',
  windowSeconds: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.default.windowSeconds,
};

/** The owner ledger consumes the verification token, so this route needs its own guessing budget. */
const verifyEmailRateLimit: CommercePortalAuthRecoveryRouteRateLimit = {
  max: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.default.max,
  route: '/verify-email',
  windowSeconds: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.default.windowSeconds,
};

/**
 * Better Auth enforces the deployment's recovery limits inside its router (`auth.handler`); the
 * typed `auth.api` surface this group reaches through the owner service never runs them, so the
 * owner re-applies the same rules against its own durable counter store. That store is the realm's,
 * so a horizontally scaled deployment keeps one budget for reset-mail flooding and reset-token
 * replay rather than one per replica. A store that cannot answer refuses the request instead of
 * serving it uncounted.
 *
 * The key names the resolved client, the subject the attempt is for, and the route. The subject
 * half is what keeps one caller from denying recovery to everybody: this vertical is served by a
 * web handler whose request carries no socket peer (`../../http-transport.ts`), so
 * `resolveClientKey` answers the same unattributable value for every request and a client-only key
 * would be a single deployment-wide counter per route — three requests from anywhere would answer
 * every customer's password reset with 429 for the rest of the hour. Keyed on the subject, an
 * attempt can only spend the budget of the account or token it already names. The client half is
 * not decoration: where a deployment does observe a peer it keeps one client's attempts off
 * another client's budget for the same subject. It is the socket peer (or the hop a declared proxy
 * observed), never a caller-chosen header, so a forged `x-forwarded-for` cannot mint itself a
 * fresh budget.
 *
 * No second, deployment-wide ceiling is spent alongside this one. Such a bucket is the same
 * kill switch with a larger constant — one unattributable counter every caller shares — and the
 * two sibling transports the branch models this on (`../../session/http.ts` sign-in and
 * `../step-up/http.ts`) deliberately carry none either. What bounds guessing on the two token
 * routes is the token itself: a reset or verification token is high-entropy, single-use and
 * consumed by the owner ledger, and a guesser varying the token would side-step any shared counter
 * anyway. What this budget bounds is what the holder of one issued token — or the namer of one
 * account — can drive: reset-mail floods and repeated submission of the same credential.
 */
const consumeRecoveryBudget = Effect.fn('CommercePortalAuthRecoveryHttp.rateLimit')(
  function* consumeRecoveryBudgetEffect(
    limit: CommercePortalAuthRecoveryRouteRateLimit,
    request: HttpServerRequest.HttpServerRequest,
    subject: string,
  ) {
    const budget = yield* CommercePortalAuthRecoveryRateLimitService;
    const configuration = yield* CommercePortalAuthConfig;
    const client = resolveClientKey(request, configuration.trustedProxies);
    const scope = hashSubjectKey(subject, configuration.secret);
    const allowed = yield* budget.consume(`${client}|${scope}|${limit.route}`, limit).pipe(
      // The transport problem carries no provider detail, so the classified failure is reported
      // here rather than discarded at the seam that still knows which store step refused.
      Effect.catchTag('CommercePortalAuthRecoveryProviderFailure', (failure) =>
        Effect.annotateLogs(Effect.logError('Commerce portal recovery budget could not be spent', failure), {
          operation: failure.operation,
          route: limit.route,
        }).pipe(Effect.andThen(Effect.fail(commercePortalAuthRecoveryUnavailableProblem))),
      ),
    );
    if (!allowed) {
      return yield* Effect.fail(commercePortalAuthRecoveryRateLimitedProblem);
    }
    return yield* Effect.void;
  },
);

const untrustedOrigin = (): typeof commercePortalAuthRecoveryUntrustedOriginProblem =>
  commercePortalAuthRecoveryUntrustedOriginProblem;

const trustedOrigin = (value: string, trustedOrigins: readonly string[]): boolean => {
  try {
    const { origin } = new URL(value);
    return trustedOrigins.some((candidate) => {
      try {
        return new URL(candidate).origin === origin;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
};

/**
 * Relative callback URLs resolve against the configured portal origin rather than the request
 * host, so a forged Host header cannot widen the trusted set.
 */
const passwordResetPending = (
  candidate: string | undefined,
  configuration: CommercePortalAuthConfigValue,
): Effect.Effect<
  CommercePortalAuthPasswordResetPendingResult,
  typeof commercePortalAuthRecoveryInvalidCallbackProblem
> => {
  if (candidate === undefined || candidate.length === 0) {
    return Effect.succeed({ outcome: 'PASSWORD_RESET_PENDING' });
  }
  try {
    const callback = new URL(candidate, configuration.baseUrl);
    return (callback.protocol !== 'http:' && callback.protocol !== 'https:') ||
      callback.username.length > 0 ||
      callback.password.length > 0 ||
      !trustedOrigin(callback.href, configuration.trustedOrigins)
      ? Effect.fail(commercePortalAuthRecoveryInvalidCallbackProblem)
      : Effect.succeed({ callbackURL: callback.href, outcome: 'PASSWORD_RESET_PENDING' });
  } catch {
    return Effect.fail(commercePortalAuthRecoveryInvalidCallbackProblem);
  }
};

const recoveryProblem = (failure: CommercePortalAuthRecoveryFailure): CommercePortalAuthRecoveryServiceProblem => {
  if (Schema.is(CommercePortalAuthRecoveryInvalidRequest)(failure)) {
    return commercePortalAuthRecoveryInvalidProblem;
  }
  if (Schema.is(CommercePortalAuthRecoveryRejected)(failure)) {
    return failure.code === 'RATE_LIMITED'
      ? commercePortalAuthRecoveryRateLimitedProblem
      : commercePortalAuthRecoveryRejectedProblem(failure.code);
  }
  return commercePortalAuthRecoveryUnavailableProblem;
};

/**
 * The origin gate runs before the budget is spent. These trusted origins are the only CSRF
 * authority for this route (`../../http-transport.ts`), and a recovery body is a CORS simple
 * request, so a third-party page can drive a visitor's browser into this handler. Spending first
 * would let that page burn the named account's 3-per-hour budget and collect a 403 only
 * afterwards — the guard would be unable to protect the very budget it is there to protect. The
 * sibling sign-in and step-up transports order it the same way; Better Auth's router ordering is
 * not preserved here, because the owner's budget is not the provider's.
 *
 * The named address is the budget subject: it is the account the reset mail would go to, so an
 * exhausted budget denies exactly the address it was spent on, and a re-cased address cannot mint
 * itself a fresh one.
 */
const requestPasswordReset = Effect.fn('CommercePortalAuthRecoveryHttp.requestPasswordReset')(
  function* requestPasswordResetEffect(
    payload: CommercePortalAuthPasswordResetRequestBoundary,
    request: HttpServerRequest.HttpServerRequest,
  ) {
    yield* noStoreHeaders;
    yield* requireTrustedOrigin(request.headers, untrustedOrigin);
    yield* consumeRecoveryBudget(requestPasswordResetRateLimit, request, payload.email.trim().toLowerCase());
    const recovery = yield* CommercePortalAuthRecoveryService;
    return yield* recovery.requestPasswordReset(payload).pipe(Effect.mapError(recoveryProblem));
  },
);

/** The submitted token is the budget subject: only its holder can spend the budget it names. */
const resetPassword = Effect.fn('CommercePortalAuthRecoveryHttp.resetPassword')(function* resetPasswordEffect(
  payload: CommercePortalAuthPasswordResetBoundary,
  request: HttpServerRequest.HttpServerRequest,
) {
  yield* noStoreHeaders;
  yield* requireTrustedOrigin(request.headers, untrustedOrigin);
  // The token stays redacted everywhere but inside the keyed digest: only the digest is stored.
  yield* consumeRecoveryBudget(resetPasswordRateLimit, request, Redacted.value(payload.token));
  const recovery = yield* CommercePortalAuthRecoveryService;
  return yield* recovery.resetPassword(payload).pipe(Effect.mapError(recoveryProblem));
});

/** The reset token stays server-side: it is validated as a path parameter and never read here. */
const resetPasswordCallback = Effect.fn('CommercePortalAuthRecoveryHttp.resetPasswordCallback')(
  function* resetPasswordCallbackEffect(candidate: string | undefined) {
    yield* noStoreHeaders;
    const configuration = yield* CommercePortalAuthConfig;
    return yield* passwordResetPending(candidate, configuration);
  },
);

/**
 * The owner ledger consumes the token and Better Auth never sees this route, so the only ceiling on
 * the write transaction a submitted token drives is the owner's own durable budget, spent here
 * exactly as the two password routes spend theirs and keyed on the same thing they are: the
 * credential the attempt names. This route is reached by following a link from a verification
 * mail, so it carries no `Origin` header of its own and runs no origin gate — the token is the
 * whole authority, which is also why it, not a shared counter, is the budget subject.
 */
const verifyEmail = Effect.fn('CommercePortalAuthRecoveryHttp.verifyEmail')(function* verifyEmailEffect(
  token: string,
  request: HttpServerRequest.HttpServerRequest,
) {
  yield* noStoreHeaders;
  yield* consumeRecoveryBudget(verifyEmailRateLimit, request, token);
  const recovery = yield* CommercePortalAuthRecoveryService;
  return yield* recovery.verifyEmail({ token: Redacted.make(token) }).pipe(
    Effect.timeoutOrElse({
      duration: recoveryBridgeTimeout,
      orElse: () =>
        Effect.fail(
          new CommercePortalAuthRecoveryUnavailable({
            operation: VERIFY_EMAIL_OPERATION,
            reason: 'Commerce portal email verification timed out',
          }),
        ),
    }),
    Effect.mapError(recoveryProblem),
  );
});

/**
 * Root provides the recovery service, the recovery budget and the portal configuration this group
 * reads, so every mount of these routes counts against the one budget the deployment owns.
 */
export const portalAuthRecoveryApiLive = HttpApiBuilder.group(
  commerceCustomerContextApi,
  'portalAuthRecovery',
  (handlers) =>
    handlers
      .handle('requestPasswordReset', ({ payload, request }) => requestPasswordReset(payload, request))
      .handle('resetPassword', ({ payload, request }) => resetPassword(payload, request))
      .handle('resetPasswordCallback', ({ query }) => resetPasswordCallback(query.callbackURL))
      .handle('verifyEmail', ({ query, request }) => verifyEmail(query.token, request)),
).pipe(Layer.provide(commercePortalAuthRecoverySchemaErrorLive));
