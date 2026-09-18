import { createHmac } from 'node:crypto';

import { createCookieGetter, parseCookies } from 'better-auth/cookies';
import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import { Effect, Option, Redacted, Result } from 'effect';
import type { HttpServerRequest } from 'effect/unstable/http';

import { commerceCustomerContextApi } from '../../../../shared/api.ts';
import type {
  CommercePortalAuthMfaSendOtpBody,
  CommercePortalAuthMfaVerifyBackupCodeBody,
  CommercePortalAuthMfaVerifyOtpBody,
  CommercePortalAuthMfaVerifyTotpBody,
} from '../../../../shared/portal-auth/mfa-api.ts';
import {
  forwardSetCookieHeaders,
  noStoreHeaders,
  requestHeaders,
  requireTrustedOrigin,
  resolveClientKey,
} from '../../http-transport.ts';
import { CommercePortalAuthRecoveryRateLimitService } from '../../rate-limit-service.ts';
import type { CommercePortalAuthRecoveryRateLimitRule } from '../../rate-limit-service.ts';
import { CommercePortalAuthConfig } from '../config-service.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../config.ts';
import type { CommercePortalAuthConfigValue } from '../config.ts';
import type { CommercePortalAuthMfaProviderFailure, CommercePortalAuthMfaResponse } from './contracts.ts';
import {
  commercePortalAuthMfaChallengeExpiredProblem,
  commercePortalAuthMfaProblemForFailure,
  commercePortalAuthMfaRateLimitedProblem,
  commercePortalAuthMfaSchemaErrorLive,
  commercePortalAuthMfaTrustDeviceProblem,
  commercePortalAuthMfaUnavailableProblem,
  commercePortalAuthMfaUntrustedOriginProblem,
} from './problems.ts';
import { CommercePortalAuthMfaService } from './service.ts';
import type { CommercePortalAuthMfaServiceApi } from './service.ts';
import { narrowCommercePortalAuthMfaTrustDevice } from './trust-device.ts';

interface CommercePortalAuthMfaCall {
  readonly headers: Headers;
  readonly service: CommercePortalAuthMfaServiceApi;
  /** Already narrowed for the provider: an accepted request can only ask for `false`. */
  readonly trustDevice: { readonly trustDevice?: false };
}

const MFA_RATE_LIMIT_ROUTE = '/two-factor';
const MFA_RATE_LIMITED_CODE = 'MFA_RATE_LIMITED';
const mfaRateLimit: CommercePortalAuthRecoveryRateLimitRule = {
  max: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.mfa.max,
  windowSeconds: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.mfa.windowSeconds,
};

/**
 * The realm's own cookie names, built from the exact `advanced` options the provider realm is
 * constructed with (`../auth.ts`), so the transport reads the cookies Better Auth actually writes
 * — including the `__Secure-` prefix a secure-cookie deployment applies. The pending two-factor
 * challenge is listed after the session: `verifyTwoFactor` resolves a live session first and only
 * falls back to the challenge cookie, so the budget must name the same credential the provider
 * will act on.
 */
const mfaSubjectCookieNames = (configuration: CommercePortalAuthConfigValue): readonly string[] => {
  const cookie = createCookieGetter({
    advanced: {
      cookiePrefix: COMMERCE_PORTAL_AUTH_POLICY.cookie.namePrefix,
      useSecureCookies: configuration.secureCookies,
    },
    baseURL: configuration.baseUrl,
  });
  return [cookie('session_token').name, cookie('two_factor').name];
};

/**
 * The credential the attempt operates on, keyed under the deployment secret: the durable
 * `rate_limit` rows stay a set of opaque digests rather than a readable list of live session and
 * challenge tokens. `None` means the request names no credential at all — `verifyTwoFactor` would
 * answer such a request `UNAUTHORIZED` without touching any account, so it is refused here before
 * it can spend anything.
 */
const mfaSubjectKey = (
  request: HttpServerRequest.HttpServerRequest,
  configuration: CommercePortalAuthConfigValue,
): Option.Option<string> => {
  const cookies = parseCookies(request.headers['cookie'] ?? '');
  for (const name of mfaSubjectCookieNames(configuration)) {
    const value = cookies.get(name);
    if (value !== undefined && value.length > 0) {
      return Option.some(
        createHmac('sha256', Redacted.value(configuration.secret)).update(`${name}=${value}`).digest('base64url'),
      );
    }
  }
  return Option.none();
};

/**
 * `auth.ts` declares `rateLimit.customRules['/two-factor/*']`, but Better Auth runs that limiter
 * only inside `router()`'s request hook, reachable exclusively through `auth.handler` — which this
 * transport never mounts, because every provider call is a direct `auth.api.*` invocation. Without
 * this, `POST /api/portal-auth/two-factor/send-otp` would flood OTP mail and reset the plugin's own
 * attempt counter without limit. One budget covers the group, matching the single `/two-factor/*`
 * rule the provider configuration declares.
 *
 * The key names both the resolved client and the pending challenge — or live session — the attempt
 * is for. The challenge half is what keeps one caller from denying MFA to everybody: this vertical
 * is served by a web handler whose request carries no socket peer (`../../http-transport.ts`), so
 * `resolveClientKey` answers the same unattributable value for every request and a client-only key
 * would be a single deployment-wide 5-per-300s counter — six `send-otp` calls from anywhere would
 * answer every customer's `verify-totp` with 429 and block the completion of every 2FA sign-in.
 * Keyed on the challenge, an attempt can only spend the budget of the challenge it already holds,
 * which is exactly what a per-challenge throttle exists to protect; the sibling step-up transport
 * keys its two budgets the same way, on the session its caller's own cookie resolves to.
 */
const consumeMfaBudget = Effect.fn('CommercePortalAuthMfaHttp.rateLimit')(function* consumeMfaBudgetEffect(
  request: HttpServerRequest.HttpServerRequest,
) {
  const budget = yield* CommercePortalAuthRecoveryRateLimitService;
  const configuration = yield* CommercePortalAuthConfig;
  const subject = mfaSubjectKey(request, configuration);
  if (Option.isNone(subject)) {
    return yield* Effect.fail(commercePortalAuthMfaChallengeExpiredProblem);
  }
  const client = resolveClientKey(request, configuration.trustedProxies);
  const allowed = yield* budget.consume(`${client}|${subject.value}|${MFA_RATE_LIMIT_ROUTE}`, mfaRateLimit).pipe(
    Effect.catchTag('CommercePortalAuthRecoveryProviderFailure', (failure) =>
      Effect.annotateLogs(Effect.logError('Commerce portal MFA budget could not be spent', failure), {
        operation: failure.operation,
        route: MFA_RATE_LIMIT_ROUTE,
      }).pipe(Effect.andThen(Effect.fail(commercePortalAuthMfaUnavailableProblem))),
    ),
  );
  return allowed
    ? yield* Effect.void
    : yield* Effect.fail(commercePortalAuthMfaRateLimitedProblem(MFA_RATE_LIMITED_CODE));
});

/**
 * Every published route is state-changing, so each one runs the owner's CSRF origin check and
 * spends the owner's durable MFA budget. The installed Better Auth plugin still understands
 * `trustDevice: true`, so the transport refuses it here instead of letting a trusted-device cookie
 * be minted.
 *
 * The origin gate runs before the budget is spent. These trusted origins are the only CSRF
 * authority for this route family (`../../http-transport.ts` — the transport CORS layer does not
 * cover them), and an MFA body is a CORS simple request, so a third-party page can drive a
 * visitor's browser into this handler. Spending first would let that page exhaust the visitor's own
 * challenge budget and collect a 403 only afterwards; the sibling sign-in and step-up transports
 * order it the same way.
 */
const prepareMfaCall = Effect.fn('CommercePortalAuthMfaHttp.prepare')(function* prepareMfaCallEffect(
  request: HttpServerRequest.HttpServerRequest,
  payload: { readonly trustDevice?: boolean },
) {
  yield* noStoreHeaders;
  yield* requireTrustedOrigin(request.headers, () => commercePortalAuthMfaUntrustedOriginProblem);
  yield* consumeMfaBudget(request);
  const trustDevice = narrowCommercePortalAuthMfaTrustDevice(payload);
  if (Option.isNone(trustDevice)) {
    return yield* Effect.fail(commercePortalAuthMfaTrustDeviceProblem);
  }
  const service = yield* CommercePortalAuthMfaService;
  const call: CommercePortalAuthMfaCall = {
    headers: requestHeaders(request.headers),
    service,
    trustDevice: trustDevice.value,
  };
  return call;
});

/**
 * MFA may rotate or expire the provider session on success *and* on failure, so the provider
 * cookies are forwarded before either outcome leaves the handler.
 */
const forwardMfaOutcome = <Body>(
  call: Effect.Effect<CommercePortalAuthMfaResponse<Body>, CommercePortalAuthMfaProviderFailure>,
) =>
  Effect.result(call).pipe(
    Effect.flatMap((outcome) =>
      Result.isFailure(outcome)
        ? forwardSetCookieHeaders(outcome.failure.setCookieHeaders).pipe(
            Effect.andThen(Effect.fail(commercePortalAuthMfaProblemForFailure(outcome.failure))),
          )
        : forwardSetCookieHeaders(outcome.success.setCookieHeaders).pipe(Effect.as(outcome.success.body)),
    ),
  );

const sendOtp = Effect.fn('CommercePortalAuthMfaHttp.sendOtp')(function* sendOtpEffect(
  payload: CommercePortalAuthMfaSendOtpBody,
  request: HttpServerRequest.HttpServerRequest,
) {
  const call = yield* prepareMfaCall(request, payload);
  return yield* forwardMfaOutcome(call.service.sendTwoFactorOTP({ body: call.trustDevice, headers: call.headers }));
});

const verifyTotp = Effect.fn('CommercePortalAuthMfaHttp.verifyTotp')(function* verifyTotpEffect(
  payload: CommercePortalAuthMfaVerifyTotpBody,
  request: HttpServerRequest.HttpServerRequest,
) {
  const call = yield* prepareMfaCall(request, payload);
  return yield* forwardMfaOutcome(
    call.service.verifyTOTP({ body: { code: payload.code, ...call.trustDevice }, headers: call.headers }),
  );
});

const verifyOtp = Effect.fn('CommercePortalAuthMfaHttp.verifyOtp')(function* verifyOtpEffect(
  payload: CommercePortalAuthMfaVerifyOtpBody,
  request: HttpServerRequest.HttpServerRequest,
) {
  const call = yield* prepareMfaCall(request, payload);
  return yield* forwardMfaOutcome(
    call.service.verifyTwoFactorOTP({ body: { code: payload.code, ...call.trustDevice }, headers: call.headers }),
  );
});

const verifyBackupCode = Effect.fn('CommercePortalAuthMfaHttp.verifyBackupCode')(function* verifyBackupCodeEffect(
  payload: CommercePortalAuthMfaVerifyBackupCodeBody,
  request: HttpServerRequest.HttpServerRequest,
) {
  const call = yield* prepareMfaCall(request, payload);
  return yield* forwardMfaOutcome(
    call.service.verifyBackupCode({
      body: { code: payload.code, ...call.trustDevice },
      headers: call.headers,
    }),
  );
});

/** Root provides the MFA service and the portal configuration this group reads. */
export const portalAuthMfaApiLive = HttpApiBuilder.group(commerceCustomerContextApi, 'portalAuthMfa', (handlers) =>
  handlers
    .handle('sendOtp', ({ payload, request }) => sendOtp(payload, request))
    .handle('verifyTotp', ({ payload, request }) => verifyTotp(payload, request))
    .handle('verifyOtp', ({ payload, request }) => verifyOtp(payload, request))
    .handle('verifyBackupCode', ({ payload, request }) => verifyBackupCode(payload, request)),
).pipe(Layer.provide(commercePortalAuthMfaSchemaErrorLive));
