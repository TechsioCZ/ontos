import { createHmac } from 'node:crypto';

import { createCookieGetter, parseCookies } from 'better-auth/cookies';
import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import { Clock, Context, Duration, Effect, Option, Redacted, Result, Schema } from 'effect';
import type { HttpServerRequest } from 'effect/unstable/http';
import type { Auth } from 'better-auth';

import { commerceCustomerContextApi } from '../../../../shared/api.ts';
import { CommercePortalAuthMfaApi } from '../../../../shared/portal-auth/mfa-api.ts';
import type {
  CommercePortalAuthMfaConfirmEnableBody,
  CommercePortalAuthMfaDisableBody,
  CommercePortalAuthMfaEnableBody,
  CommercePortalAuthMfaPasswordBody,
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
import { CommercePortalAuthService } from '../../session/http.ts';
import { CommercePortalAuthSessionLifecycle } from '../../session/lifecycle-service.ts';
import { CommercePortalAuthConfig } from '../config-service.ts';
import { encodeCommerceSessionReference } from '../session-reference.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../config.ts';
import type { CommercePortalAuthConfigValue } from '../config.ts';
import {
  CommercePortalAuthMfaDisableBodySchema as CommercePortalAuthMfaOwnerDisableBodySchema,
  CommercePortalAuthMfaEnableBodySchema as CommercePortalAuthMfaOwnerEnableBodySchema,
  CommercePortalAuthMfaPasswordBodySchema as CommercePortalAuthMfaOwnerPasswordBodySchema,
} from './contracts.ts';
import type { CommercePortalAuthMfaProviderFailure, CommercePortalAuthMfaResponse } from './contracts.ts';
import {
  commercePortalAuthMfaChallengeExpiredProblem,
  commercePortalAuthMfaInvalidRequestProblem,
  commercePortalAuthMfaNotFreshProblem,
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

/** The decoded Better Auth session identity this gate needs: nothing beyond the two ids. */
export interface CommercePortalAuthMfaSessionSnapshot {
  readonly session: { readonly id: string };
  readonly user: { readonly id: string };
}

/**
 * Better Auth session lookup, scoped to only the read this gate needs. The argument shape is taken
 * from the provider's own route so the call stays exact. The result is already decoded to a named
 * type — Promise-to-Effect conversion and Schema decoding of Better Auth's raw envelope both live
 * in `commercePortalAuthMfaSessionReadApiFromBetterAuth`, the one driver edge that constructs this
 * port from the real provider — which also lets an owner test substitute a fixture without
 * reproducing Better Auth's route descriptor.
 */
export interface CommercePortalAuthMfaSessionReadApi {
  readonly getSession: (
    input: Parameters<Auth['api']['getSession']>[0],
  ) => Effect.Effect<Option.Option<CommercePortalAuthMfaSessionSnapshot>, CommercePortalAuthMfaSessionReadFailure>;
}

export interface CommercePortalAuthMfaCurrentSession {
  /**
   * When the customer last proved who they are on this session: the persisted primary/step-up
   * authentication stamp, not the row's creation time. The two differ exactly where it matters —
   * a completed step-up rotates the session and deliberately carries `createdAt` forward so the
   * absolute session lifetime survives the rotation.
   */
  readonly authenticatedAtMillis: number;
}

/**
 * The owner-local freshness boundary. It reads the exact current provider session from the
 * incoming request's own cookies — never a caller-supplied session id — mirroring how the sibling
 * step-up group derives its current identity. Unlike that sibling's `setSessionCookie` boundary,
 * this port's Live implementation is supplied directly below, over the two tags the portal-auth
 * groups already read, so the gate adds no requirement of its own to the composition root.
 * Exported so the owner's transport tests can substitute a fixture reader — the same shape the
 * sibling step-up group's `CommercePortalAuthStepUpHttpProviderService` is overridden with.
 */
export interface CommercePortalAuthMfaFreshnessReader {
  readonly readCurrentSession: (headers: Headers) => Effect.Effect<Option.Option<CommercePortalAuthMfaCurrentSession>>;
}

export class CommercePortalAuthMfaFreshnessReaderService extends Context.Service<
  CommercePortalAuthMfaFreshnessReaderService,
  CommercePortalAuthMfaFreshnessReader
>()('@app/commerce-customer-context/api/portal-auth/provider/mfa/http/CommercePortalAuthMfaFreshnessReaderService') {}

const CurrentSessionSchema = Schema.Union([
  Schema.Null,
  Schema.Struct({
    session: Schema.Struct({ id: Schema.String }),
    user: Schema.Struct({ id: Schema.String }),
  }),
]);

/** `returnHeaders: true` makes Better Auth answer with this exact envelope; both halves are concrete. */
const SessionEnvelopeSchema = Schema.Struct({
  headers: Schema.instanceOf(Headers),
  response: CurrentSessionSchema,
});

/**
 * `cause` is kept only long enough for a caller doing deliberate debugging to inspect it — the log
 * line below annotates `reason` alone, so the underlying network fault or parse issue never rides
 * along in a log or reaches the caller.
 */
export interface CommercePortalAuthMfaSessionReadFailure {
  readonly cause?: unknown;
  readonly reason: 'evidence-rejected' | 'malformed' | 'provider-error' | 'timeout';
}

/**
 * The Better Auth driver edge: the one place this gate converts Better Auth's Promise-shaped
 * `getSession` into the typed Effect port above, decoding its raw envelope with a Schema. Every
 * other caller — including owner tests — supplies an already-Effect-shaped
 * `CommercePortalAuthMfaSessionReadApi` directly, with no Promise conversion of its own.
 */
export const commercePortalAuthMfaSessionReadApiFromBetterAuth = (
  auth: Pick<Auth['api'], 'getSession'>,
): CommercePortalAuthMfaSessionReadApi => ({
  getSession: (input) =>
    Effect.tryPromise({
      catch: (cause): CommercePortalAuthMfaSessionReadFailure => ({ cause, reason: 'provider-error' }),
      try: auth.getSession.bind(auth, input),
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(COMMERCE_PORTAL_AUTH_POLICY.session.providerCallTimeoutMilliseconds),
        orElse: () => Effect.fail<CommercePortalAuthMfaSessionReadFailure>({ reason: 'timeout' }),
      }),
      Effect.flatMap((result) =>
        Schema.decodeUnknownEffect(SessionEnvelopeSchema)(result).pipe(
          Effect.mapError((cause): CommercePortalAuthMfaSessionReadFailure => ({ cause, reason: 'malformed' })),
        ),
      ),
      Effect.map((envelope) =>
        envelope.response === null
          ? Option.none<CommercePortalAuthMfaSessionSnapshot>()
          : Option.some(envelope.response),
      ),
    ),
});

/**
 * Any failure to read or decode the session — timeout, provider fault, malformed response, a
 * session the owner's lifecycle refuses evidence for — is treated the same as no session at all:
 * freshness cannot be confirmed, so the gate denies rather than risking a stale or forged session
 * being accepted. Only a diagnostic reason is logged, never session or user identifiers.
 *
 * Better Auth resolves the cookie to a session identity; the owner's lifecycle answers when that
 * session was last authenticated. The provider has no column for it — the stamp lives on the
 * owner's own session row (`../../../../src/portal-auth/persistence/portal-auth-tables.ts`) — so
 * the two halves are read here rather than inferred from the provider's `createdAt`.
 */
const readCommercePortalAuthMfaCurrentSession = (
  api: CommercePortalAuthMfaSessionReadApi,
  lifecycle: CommercePortalAuthMfaFreshnessLifecycle,
  headers: Headers,
): Effect.Effect<Option.Option<CommercePortalAuthMfaCurrentSession>> =>
  Effect.gen(function* readCommercePortalAuthMfaCurrentSessionEffect() {
    const current = yield* api.getSession({
      asResponse: false,
      headers,
      query: { disableCookieCache: true, disableRefresh: true },
      returnHeaders: true,
    });
    if (Option.isNone(current)) {
      return Option.none<CommercePortalAuthMfaCurrentSession>();
    }
    const sessionRef = yield* encodeCommerceSessionReference(current.value.session.id).pipe(
      Effect.mapError((cause): CommercePortalAuthMfaSessionReadFailure => ({ cause, reason: 'malformed' })),
    );
    const evidence = yield* lifecycle
      .evidenceForSession({ expectedProviderSubjectId: current.value.user.id, sessionRef })
      .pipe(
        Effect.mapError((cause): CommercePortalAuthMfaSessionReadFailure => ({ cause, reason: 'evidence-rejected' })),
      );
    return Option.some({ authenticatedAtMillis: evidence.authenticatedAt.getTime() });
  }).pipe(
    Effect.matchEffect({
      onFailure: (failure: CommercePortalAuthMfaSessionReadFailure) =>
        Effect.annotateLogs(Effect.logWarning('Commerce portal MFA session freshness read failed'), {
          reason: failure.reason,
        }).pipe(Effect.as(Option.none())),
      onSuccess: (current: Option.Option<CommercePortalAuthMfaCurrentSession>) => Effect.succeed(current),
    }),
  );

/** Exactly the lifecycle read this gate makes; nothing here may change session state. */
export type CommercePortalAuthMfaFreshnessLifecycle = Pick<
  CommercePortalAuthSessionLifecycle['Service'],
  'evidenceForSession'
>;

/**
 * Exported so a caller already holding a Better Auth `api` and the owner's lifecycle — an
 * integration test driving a fixture realm over the real store, for instance — can build the same
 * reader without going through the service tags.
 */
export const commercePortalAuthMfaFreshnessReaderFromApi = (
  api: CommercePortalAuthMfaSessionReadApi,
  lifecycle: CommercePortalAuthMfaFreshnessLifecycle,
): CommercePortalAuthMfaFreshnessReader => ({
  readCurrentSession: (headers: Headers) => readCommercePortalAuthMfaCurrentSession(api, lifecycle, headers),
});

/**
 * The gate reads the current session through `CommercePortalAuthService` — the same typed Better
 * Auth `api` port the sibling session transport calls — rather than the constructed realm itself,
 * and reads when that session was last authenticated through `CommercePortalAuthSessionLifecycle`.
 * Both are tags the portal-auth groups already read, so the installed realm and the fail-closed
 * realm a host that opted out gets (`../../realm-unavailable.ts`) both satisfy them: on the
 * uninstalled realm each call refuses, the read above turns that into "no session", and the
 * freshness gate denies.
 */
const commercePortalAuthMfaFreshnessReaderLive = Layer.effect(
  CommercePortalAuthMfaFreshnessReaderService,
  Effect.gen(function* makeCommercePortalAuthMfaFreshnessReaderLive() {
    const provider = yield* CommercePortalAuthService;
    const lifecycle = yield* CommercePortalAuthSessionLifecycle;
    return commercePortalAuthMfaFreshnessReaderFromApi(
      commercePortalAuthMfaSessionReadApiFromBetterAuth(provider.api),
      lifecycle,
    );
  }),
);

/**
 * `enable`, `confirm-enable`, `disable`, `regenerate-backup-codes` and `totp-uri` all gate on an
 * owner-enforced freshness window: no two-factor plugin endpoint consults
 * `COMMERCE_PORTAL_AUTH_POLICY.session.freshAgeSeconds` on its own (confirmed against the vendored
 * Better Auth 1.7.2 plugin source), so this is the only place that window is enforced.
 *
 * "Recent authentication" is a persisted fact about this exact session, not the age of its row.
 * The gate reads the owner's `authenticatedAt` stamp, which sign-in establishes and a completed
 * step-up refreshes; that is what satisfies the "or completed step-up for this session" half of
 * the requirement. A step-up completed on some *other* session never reaches this one, because the
 * stamp is written only on the replacement row the rotation produced for the session that was
 * stepped up. Reading the row's `createdAt` instead would be wrong in both directions: rotation
 * preserves it on purpose so the absolute session lifetime survives, so an old session could never
 * become fresh no matter how the customer re-proved themselves.
 */
const requireFreshMfaAuthentication = Effect.fn('CommercePortalAuthMfaHttp.requireFresh')(
  function* requireFreshMfaAuthenticationEffect(headers: Headers) {
    const reader = yield* CommercePortalAuthMfaFreshnessReaderService;
    const current = yield* reader.readCurrentSession(headers);
    if (Option.isNone(current)) {
      return yield* Effect.fail(commercePortalAuthMfaNotFreshProblem);
    }
    const nowMillis = yield* Clock.currentTimeMillis;
    const ageMillis = nowMillis - current.value.authenticatedAtMillis;
    const freshWindowMillis = Duration.toMillis(Duration.seconds(COMMERCE_PORTAL_AUTH_POLICY.session.freshAgeSeconds));
    /** A negative age (clock skew, a stamp in the future) is never treated as fresh. */
    if (ageMillis < 0 || ageMillis >= freshWindowMillis) {
      return yield* Effect.fail(commercePortalAuthMfaNotFreshProblem);
    }
    return yield* Effect.void;
  },
);

/**
 * Shared preparation for the administrative routes: origin gate before the budget (matching
 * `prepareMfaCall`), the owner-enforced freshness gate, then the same durable per-subject budget.
 * None of these routes accept `trustDevice`.
 */
const prepareMfaAdminCall = Effect.fn('CommercePortalAuthMfaHttp.prepareAdmin')(function* prepareMfaAdminCallEffect(
  request: HttpServerRequest.HttpServerRequest,
) {
  yield* noStoreHeaders;
  yield* requireTrustedOrigin(request.headers, () => commercePortalAuthMfaUntrustedOriginProblem);
  const headers = requestHeaders(request.headers);
  yield* requireFreshMfaAuthentication(headers);
  yield* consumeMfaBudget(request);
  const service = yield* CommercePortalAuthMfaService;
  return { headers, service };
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

const enable = Effect.fn('CommercePortalAuthMfaHttp.enable')(function* enableEffect(
  payload: CommercePortalAuthMfaEnableBody,
  request: HttpServerRequest.HttpServerRequest,
) {
  const call = yield* prepareMfaAdminCall(request);
  const body = yield* Schema.decodeEffect(CommercePortalAuthMfaOwnerEnableBodySchema)(payload).pipe(
    Effect.mapError((cause) => commercePortalAuthMfaInvalidRequestProblem(cause)),
  );
  return yield* forwardMfaOutcome(call.service.enableTwoFactor({ body, headers: call.headers }));
});

/**
 * Better Auth's own `verifyTOTP` endpoint is dual-purpose: with no established session it verifies
 * a sign-in challenge, and with one it activates a just-enabled TOTP factor — rotating the session
 * and marking it verified. `confirm-enable` reuses the exact same provider call as `verifyTotp`;
 * only the route, the freshness gate and the budget differ.
 */
const confirmEnable = Effect.fn('CommercePortalAuthMfaHttp.confirmEnable')(function* confirmEnableEffect(
  payload: CommercePortalAuthMfaConfirmEnableBody,
  request: HttpServerRequest.HttpServerRequest,
) {
  const call = yield* prepareMfaAdminCall(request);
  return yield* forwardMfaOutcome(
    call.service.verifyTOTP({ body: { code: payload.code, trustDevice: false }, headers: call.headers }),
  );
});

const disable = Effect.fn('CommercePortalAuthMfaHttp.disable')(function* disableEffect(
  payload: CommercePortalAuthMfaDisableBody,
  request: HttpServerRequest.HttpServerRequest,
) {
  const call = yield* prepareMfaAdminCall(request);
  const body = yield* Schema.decodeEffect(CommercePortalAuthMfaOwnerDisableBodySchema)(payload).pipe(
    Effect.mapError((cause) => commercePortalAuthMfaInvalidRequestProblem(cause)),
  );
  return yield* forwardMfaOutcome(call.service.disableTwoFactor({ body, headers: call.headers }));
});

const regenerateBackupCodes = Effect.fn('CommercePortalAuthMfaHttp.regenerateBackupCodes')(
  function* regenerateBackupCodesEffect(
    payload: CommercePortalAuthMfaPasswordBody,
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const call = yield* prepareMfaAdminCall(request);
    const body = yield* Schema.decodeEffect(CommercePortalAuthMfaOwnerPasswordBodySchema)(payload).pipe(
      Effect.mapError((cause) => commercePortalAuthMfaInvalidRequestProblem(cause)),
    );
    return yield* forwardMfaOutcome(call.service.generateBackupCodes({ body, headers: call.headers }));
  },
);

const totpUri = Effect.fn('CommercePortalAuthMfaHttp.totpUri')(function* totpUriEffect(
  payload: CommercePortalAuthMfaPasswordBody,
  request: HttpServerRequest.HttpServerRequest,
) {
  const call = yield* prepareMfaAdminCall(request);
  const body = yield* Schema.decodeEffect(CommercePortalAuthMfaOwnerPasswordBodySchema)(payload).pipe(
    Effect.mapError((cause) => commercePortalAuthMfaInvalidRequestProblem(cause)),
  );
  return yield* forwardMfaOutcome(call.service.getTOTPURI({ body, headers: call.headers }));
});

/** Root provides the MFA service and the portal configuration this group reads. */
export const portalAuthMfaApiLive = HttpApiBuilder.group(commerceCustomerContextApi, 'portalAuthMfa', (handlers) =>
  handlers
    .handle('sendOtp', ({ payload, request }) => sendOtp(payload, request))
    .handle('verifyTotp', ({ payload, request }) => verifyTotp(payload, request))
    .handle('verifyOtp', ({ payload, request }) => verifyOtp(payload, request))
    .handle('verifyBackupCode', ({ payload, request }) => verifyBackupCode(payload, request))
    .handle('enable', ({ payload, request }) => enable(payload, request))
    .handle('confirmEnable', ({ payload, request }) => confirmEnable(payload, request))
    .handle('disable', ({ payload, request }) => disable(payload, request))
    .handle('regenerateBackupCodes', ({ payload, request }) => regenerateBackupCodes(payload, request))
    .handle('totpUri', ({ payload, request }) => totpUri(payload, request)),
).pipe(Layer.provide(commercePortalAuthMfaSchemaErrorLive), Layer.provide(commercePortalAuthMfaFreshnessReaderLive));

/**
 * The same handlers mounted on the standalone MFA API. The composed Commerce runtime uses
 * `portalAuthMfaApiLive`; this mount is the isolated MFA topology the owner's transport tests
 * drive, mirroring `portalAuthStepUpStandaloneApiLive`.
 *
 * Unlike `portalAuthMfaApiLive`, this mount does not bake in `commercePortalAuthMfaFreshnessReaderLive`:
 * `CommercePortalAuthMfaFreshnessReaderService` stays a visible requirement so the owner's transport
 * tests can substitute a fixture reader directly, the same shape the sibling step-up group's
 * `CommercePortalAuthStepUpHttpProviderService` is overridden with, instead of having to stand up a
 * full fake `CommercePortalAuthService`.
 */
export const portalAuthMfaStandaloneApiLive = HttpApiBuilder.group(
  CommercePortalAuthMfaApi,
  'portalAuthMfa',
  (handlers) =>
    handlers
      .handle('sendOtp', ({ payload, request }) => sendOtp(payload, request))
      .handle('verifyTotp', ({ payload, request }) => verifyTotp(payload, request))
      .handle('verifyOtp', ({ payload, request }) => verifyOtp(payload, request))
      .handle('verifyBackupCode', ({ payload, request }) => verifyBackupCode(payload, request))
      .handle('enable', ({ payload, request }) => enable(payload, request))
      .handle('confirmEnable', ({ payload, request }) => confirmEnable(payload, request))
      .handle('disable', ({ payload, request }) => disable(payload, request))
      .handle('regenerateBackupCodes', ({ payload, request }) => regenerateBackupCodes(payload, request))
      .handle('totpUri', ({ payload, request }) => totpUri(payload, request)),
).pipe(Layer.provide(commercePortalAuthMfaSchemaErrorLive));
