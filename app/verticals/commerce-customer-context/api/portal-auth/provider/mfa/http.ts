import { createCookieGetter, parseCookies } from 'better-auth/cookies';
import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import { Clock, Context, Duration, Effect, Option, Result, Schema } from 'effect';
import type { HttpServerRequest } from 'effect/unstable/http';
import type { Auth } from 'better-auth';

import { commerceCustomerContextApi } from '../../../../shared/api.ts';
import { CommercePortalAuthMfaApi } from '../../../../shared/portal-auth/mfa-api.ts';
import type {
  CommercePortalAuthMfaConfirmEnableBody,
  CommercePortalAuthMfaSendOtpBody,
  CommercePortalAuthMfaVerifyBackupCodeBody,
  CommercePortalAuthMfaVerifyOtpBody,
  CommercePortalAuthMfaVerifyTotpBody,
} from '../../../../shared/portal-auth/mfa-api.ts';
import {
  forwardSetCookieHeaders,
  hashSubjectKey,
  noStoreHeaders,
  requestHeaders,
  requireTrustedOrigin,
  resolveClientKey,
} from '../../http-transport.ts';
import { consumeRateLimitBudget } from '../../rate-limit-service.ts';
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
import type {
  CommercePortalAuthMfaAttemptEvidence,
  CommercePortalAuthMfaProviderFailure,
  CommercePortalAuthMfaResponse,
} from './contracts.ts';
import {
  commercePortalAuthMfaChallengeExpiredProblem,
  commercePortalAuthMfaInvalidProblem,
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
  /** The digests this attempt's audit rows name; every state-changing route resolves them. */
  readonly evidence: CommercePortalAuthMfaAttemptEvidence;
  readonly headers: Headers;
  readonly service: CommercePortalAuthMfaServiceApi;
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
      return Option.some(hashSubjectKey(`${name}=${value}`, configuration.secret));
    }
  }
  return Option.none();
};

/**
 * Better Auth runs its `/two-factor/*` limiter only inside `auth.handler`, which this transport
 * never mounts, so the owner spends the same rule itself. The key carries the pending challenge as
 * well as the client because `resolveClientKey` is unattributable here (see
 * `../../http-transport.ts`), so a client-only key would block every customer's 2FA sign-in.
 */
const consumeMfaBudget = Effect.fn('CommercePortalAuthMfaHttp.rateLimit')(function* consumeMfaBudgetEffect(
  request: HttpServerRequest.HttpServerRequest,
) {
  const configuration = yield* CommercePortalAuthConfig;
  const subject = mfaSubjectKey(request, configuration);
  if (Option.isNone(subject)) {
    return yield* Effect.fail(commercePortalAuthMfaChallengeExpiredProblem);
  }
  const client = resolveClientKey(request, configuration.trustedProxies);
  const allowed = yield* consumeRateLimitBudget(`${client}|${subject.value}|${MFA_RATE_LIMIT_ROUTE}`, mfaRateLimit, {
    route: MFA_RATE_LIMIT_ROUTE,
    unavailable: () => commercePortalAuthMfaUnavailableProblem,
  });
  if (!allowed) {
    return yield* Effect.fail(commercePortalAuthMfaRateLimitedProblem(MFA_RATE_LIMITED_CODE));
  }
  // The budget's own two halves are exactly what an audit row may name: the credential the attempt
  // operates on and the client it came from, both already keyed under the deployment secret.
  return { clientKeyDigest: hashSubjectKey(client, configuration.secret), subjectDigest: subject.value };
});

/**
 * Every published route is state-changing, so each runs the owner's CSRF origin check and spends
 * the owner's durable MFA budget. The origin gate runs first: an MFA body is a CORS simple request,
 * so spending first would let a third-party page exhaust the visitor's own challenge budget. The
 * installed plugin still understands `trustDevice: true`, so the transport refuses it here.
 */
const prepareMfaCall = Effect.fn('CommercePortalAuthMfaHttp.prepare')(function* prepareMfaCallEffect(
  request: HttpServerRequest.HttpServerRequest,
  payload: { readonly trustDevice?: boolean },
) {
  yield* noStoreHeaders;
  yield* requireTrustedOrigin(request.headers, () => commercePortalAuthMfaUntrustedOriginProblem);
  const evidence = yield* consumeMfaBudget(request);
  if (Option.isNone(narrowCommercePortalAuthMfaTrustDevice(payload))) {
    return yield* Effect.fail(commercePortalAuthMfaTrustDeviceProblem);
  }
  const service = yield* CommercePortalAuthMfaService;
  const call: CommercePortalAuthMfaCall = {
    evidence,
    headers: requestHeaders(request.headers),
    service,
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
interface CommercePortalAuthMfaSessionReadFailure {
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

/** Exactly the lifecycle read this gate makes; nothing here may change session state. */
export type CommercePortalAuthMfaFreshnessLifecycle = Pick<
  CommercePortalAuthSessionLifecycle['Service'],
  'evidenceForSession'
>;

/**
 * Better Auth resolves the cookie to a session identity; the owner's lifecycle answers when that
 * session was last authenticated, because the provider has no column for it.
 *
 * Any failure to read or decode the session is treated as no session at all: freshness cannot be
 * confirmed, so the gate denies. Only a diagnostic reason is logged, never an identifier.
 */
export const commercePortalAuthMfaFreshnessReaderFromApi = (
  api: CommercePortalAuthMfaSessionReadApi,
  lifecycle: CommercePortalAuthMfaFreshnessLifecycle,
): CommercePortalAuthMfaFreshnessReader => ({
  readCurrentSession: (headers: Headers) =>
    Effect.gen(function* readCurrentSessionEffect() {
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
    ),
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
  const evidence = yield* consumeMfaBudget(request);
  const service = yield* CommercePortalAuthMfaService;
  const call: CommercePortalAuthMfaCall = { evidence, headers, service };
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
  return yield* forwardMfaOutcome(
    call.service.sendTwoFactorOTP({ body: { trustDevice: false }, headers: call.headers }),
  );
});

const verifyTotp = Effect.fn('CommercePortalAuthMfaHttp.verifyTotp')(function* verifyTotpEffect(
  payload: CommercePortalAuthMfaVerifyTotpBody,
  request: HttpServerRequest.HttpServerRequest,
) {
  const call = yield* prepareMfaCall(request, payload);
  return yield* forwardMfaOutcome(
    call.service.verifyTOTP({
      body: { code: payload.code, trustDevice: false },
      evidence: call.evidence,
      headers: call.headers,
    }),
  );
});

const verifyOtp = Effect.fn('CommercePortalAuthMfaHttp.verifyOtp')(function* verifyOtpEffect(
  payload: CommercePortalAuthMfaVerifyOtpBody,
  request: HttpServerRequest.HttpServerRequest,
) {
  const call = yield* prepareMfaCall(request, payload);
  return yield* forwardMfaOutcome(
    call.service.verifyTwoFactorOTP({
      body: { code: payload.code, trustDevice: false },
      evidence: call.evidence,
      headers: call.headers,
    }),
  );
});

const verifyBackupCode = Effect.fn('CommercePortalAuthMfaHttp.verifyBackupCode')(function* verifyBackupCodeEffect(
  payload: CommercePortalAuthMfaVerifyBackupCodeBody,
  request: HttpServerRequest.HttpServerRequest,
) {
  const call = yield* prepareMfaCall(request, payload);
  return yield* forwardMfaOutcome(
    call.service.verifyBackupCode({
      body: { code: payload.code, trustDevice: false },
      evidence: call.evidence,
      headers: call.headers,
    }),
  );
});

/**
 * Every administrative route shares the same shape: gate, decode the payload into the provider's
 * body, and forward the outcome. `toBody` carries the one difference between routes — most decode
 * through a `Schema`, `confirmEnable` needs none.
 */
const adminCall = <Payload, Body, ResponseBody, R>(
  name: string,
  toBody: (payload: Payload) => Effect.Effect<Body, Schema.SchemaError, R>,
  invoke: (
    call: CommercePortalAuthMfaCall,
    body: Body,
  ) => Effect.Effect<CommercePortalAuthMfaResponse<ResponseBody>, CommercePortalAuthMfaProviderFailure>,
) =>
  Effect.fn(name)(function* adminCallEffect(payload: Payload, request: HttpServerRequest.HttpServerRequest) {
    const call = yield* prepareMfaAdminCall(request);
    // Body decoding runs only once the admin gate above has resolved `call`: an unauthenticated or
    // stale-session caller must never learn whether their request body would otherwise decode.
    const body = yield* Effect.succeed(call).pipe(
      Effect.andThen(() => toBody(payload)),
      // The parse issue can quote the submitted password back, so only its tag is kept: the published
      // problem is encoded closed and carries exactly its declared fields.
      Effect.catchTag('SchemaError', () => Effect.fail(commercePortalAuthMfaInvalidProblem)),
    );
    return yield* forwardMfaOutcome(invoke(call, body));
  });

const enable = adminCall(
  'CommercePortalAuthMfaHttp.enable',
  Schema.decodeEffect(CommercePortalAuthMfaOwnerEnableBodySchema),
  (call, body) => call.service.enableTwoFactor({ body, headers: call.headers }),
);

/**
 * Better Auth's own `verifyTOTP` endpoint is dual-purpose: with no established session it verifies
 * a sign-in challenge, and with one it activates a just-enabled TOTP factor — rotating the session
 * and marking it verified. `confirm-enable` reaches that same provider call, through the owner
 * method that files it as an enrollment rather than a second-factor authentication; the route, the
 * freshness gate and the budget differ too.
 */
const confirmEnable = adminCall(
  'CommercePortalAuthMfaHttp.confirmEnable',
  (payload: CommercePortalAuthMfaConfirmEnableBody) =>
    Effect.succeed({ code: payload.code, trustDevice: false as const }),
  (call, body) => call.service.confirmEnableTotp({ body, evidence: call.evidence, headers: call.headers }),
);

/**
 * Both administrative mutations carry the attempt evidence the owner's strict audit rows name, the
 * same two digests the budget above was already keyed on. `totpUri` and `enable` do not: neither
 * takes a factor away nor invalidates a credential the customer already holds.
 */
const disable = adminCall(
  'CommercePortalAuthMfaHttp.disable',
  Schema.decodeEffect(CommercePortalAuthMfaOwnerDisableBodySchema),
  (call, body) => call.service.disableTwoFactor({ body, evidence: call.evidence, headers: call.headers }),
);

const regenerateBackupCodes = adminCall(
  'CommercePortalAuthMfaHttp.regenerateBackupCodes',
  Schema.decodeEffect(CommercePortalAuthMfaOwnerPasswordBodySchema),
  (call, body) => call.service.generateBackupCodes({ body, evidence: call.evidence, headers: call.headers }),
);

const totpUri = adminCall(
  'CommercePortalAuthMfaHttp.totpUri',
  Schema.decodeEffect(CommercePortalAuthMfaOwnerPasswordBodySchema),
  (call, body) => call.service.getTOTPURI({ body, headers: call.headers }),
);

/** Shared by both mounts below: every published MFA route, wired to its handler. */
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
