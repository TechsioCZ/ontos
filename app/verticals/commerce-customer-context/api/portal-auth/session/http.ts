import { APIError } from 'better-auth';
import { isAPIError } from 'better-auth/api';
import { getCookies } from 'better-auth/cookies';
import { HttpApiBuilder, HttpApiMiddleware, Layer } from '@modern-js/bff-effect/effect-edge';
import { Context, DateTime, Duration, Effect, Option, Result, Schema } from 'effect';
import type { HttpServerRequest } from 'effect/unstable/http';
import { empty as emptyCookies, expireCookieUnsafe, toSetCookieHeaders } from 'effect/unstable/http/Cookies';

import { commerceCustomerContextApi } from '../../../shared/api.ts';
import { CommerceSessionReferenceSchema } from '../../../shared/portal-auth-contracts.ts';
import {
  CommercePortalAuthSessionApi,
  CommercePortalAuthSessionAuthenticationProblemSchema,
  CommercePortalAuthSessionForbiddenProblemSchema,
  CommercePortalAuthSessionInvalidProblemSchema,
  CommercePortalAuthSessionRateLimitedProblemSchema,
  CommercePortalAuthSessionSchemaErrorMiddleware,
  CommercePortalAuthSessionUnavailableProblemSchema,
} from '../../../shared/portal-auth/session-api.ts';
import type { CommercePortalAuthSessionSnapshotWire } from '../../../shared/portal-auth/session-api.ts';
import {
  forwardSetCookieHeaders,
  noStoreHeaders,
  providerSetCookieHeaders,
  requestHeaders,
  requireTrustedOrigin,
  resolveClientKey,
} from '../http-transport.ts';
import { commercePortalAuthSignInAuditEvent } from '../../../src/portal-auth/audit/audit-mapping.ts';
import {
  CommercePortalAuthAudit,
  commercePortalAuthSubjectDigest,
  emitCommercePortalAuthAudit,
  unauditedCommercePortalAuthRecorder,
} from '../../../src/portal-auth/audit/audit.ts';
import { CommercePortalAuthRecoveryRateLimitService } from '../rate-limit-service.ts';
import type { CommercePortalAuthRecoveryRateLimitRule } from '../rate-limit-service.ts';
import { CommercePortalAuthInstance } from '../provider/auth.ts';
import type { CommercePortalAuth } from '../provider/auth.ts';
import { CommercePortalAuthConfig } from '../provider/config-service.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../provider/config.ts';
import type { CommercePortalAuthConfigValue } from '../provider/config.ts';
import { commerceSessionReferencePrefix } from '../provider/session-reference.ts';
import type {
  CommercePortalAuthSessionOutcome,
  CommercePortalAuthSessionReferenceInput,
  CommercePortalAuthSessionSignInOutcome,
  CommercePortalAuthSessionSnapshot,
  CommercePortalAuthSignInInputSchema,
} from './contracts.ts';
import { CommercePortalAuthSessionEvidenceRejected, CommercePortalAuthSessionInvalidRequest } from './errors.ts';
import { CommercePortalAuthSessionLifecycle } from './lifecycle.ts';
import type { CommercePortalAuthSessionEvidenceFailure, CommercePortalAuthSessionFailure } from './lifecycle.ts';

const httpBridgeTimeout = Duration.millis(COMMERCE_PORTAL_AUTH_POLICY.session.providerCallTimeoutMilliseconds);
const providerHttpFailure = (cause: unknown): APIError =>
  isAPIError(cause)
    ? cause
    : Object.defineProperty(
        new APIError('INTERNAL_SERVER_ERROR', {
          code: 'COMMERCE_AUTH_PROVIDER_FAILURE',
          message: 'The Commerce portal authentication provider call failed',
        }),
        'cause',
        { configurable: true, value: cause },
      );
const httpBridgeTimeoutPolicy = Effect.timeoutOrElse({
  duration: httpBridgeTimeout,
  orElse: () =>
    Effect.fail(
      new APIError('INTERNAL_SERVER_ERROR', {
        code: 'COMMERCE_AUTH_PROVIDER_TIMEOUT',
        message: 'The Commerce portal authentication provider call timed out',
      }),
    ),
});

/**
 * Better Auth is a foreign HTTP provider; its Promise surface is supplied by the root layer. Only
 * the typed API is exposed: the raw `auth.handler` proxy is no longer part of this transport.
 */
interface CommercePortalAuthHttpPort {
  readonly api: Pick<CommercePortalAuth['api'], 'getSession' | 'signOut'>;
}

export class CommercePortalAuthService extends Context.Service<CommercePortalAuthService, CommercePortalAuthHttpPort>()(
  '@app/commerce-customer-context/api/portal-auth/session/http/CommercePortalAuthService',
) {}

const PROBLEM_TYPE_PREFIX = 'https://ontos.dev/problems/commerce-portal-auth-session-';
const problemStatus = {
  authentication: 401,
  forbidden: 403,
  invalid: 400,
  rateLimited: 429,
  unavailable: 503,
} as const;

const invalidProblem = () =>
  CommercePortalAuthSessionInvalidProblemSchema.make({
    code: 'invalid_request',
    detail: 'The Commerce portal session request is invalid.',
    status: problemStatus.invalid,
    title: 'Invalid session request',
    type: `${PROBLEM_TYPE_PREFIX}invalid`,
  });

const authenticationProblem = (code: 'authentication_failed' | 'session_expired' | 'session_revoked') =>
  CommercePortalAuthSessionAuthenticationProblemSchema.make({
    code,
    detail: 'The Commerce portal session is not authenticated.',
    status: problemStatus.authentication,
    title: 'Session authentication required',
    type: `${PROBLEM_TYPE_PREFIX}authentication`,
  });

const forbiddenProblem = (code: 'account_disabled' | 'origin_not_trusted' | 'verification_required') =>
  CommercePortalAuthSessionForbiddenProblemSchema.make({
    code,
    detail: 'The Commerce portal session request is not allowed for this caller.',
    status: problemStatus.forbidden,
    title: 'Session request forbidden',
    type: `${PROBLEM_TYPE_PREFIX}forbidden`,
  });

/**
 * The concurrent-device cap is a policy refusal, not a throttle: the account already holds the
 * maximum number of live sessions, and no amount of waiting changes that. It therefore cannot
 * borrow the attempt-throttle's `retryAfterSeconds` — a caller honouring a 60-second Retry-After
 * would retry forever — so the caller is told the one remedy that does clear it.
 */
const sessionLimitProblem = () =>
  CommercePortalAuthSessionForbiddenProblemSchema.make({
    code: 'session_limit_reached',
    detail: 'This account already holds the maximum number of active Commerce portal sessions.',
    status: problemStatus.forbidden,
    title: 'Active session limit reached',
    type: `${PROBLEM_TYPE_PREFIX}forbidden`,
  });

const rateLimitedProblem = () =>
  CommercePortalAuthSessionRateLimitedProblemSchema.make({
    code: 'rate_limited',
    detail: 'Too many Commerce portal authentication attempts.',
    retryAfterSeconds: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.signIn.windowSeconds,
    status: problemStatus.rateLimited,
    title: 'Session request rate limited',
    type: `${PROBLEM_TYPE_PREFIX}rate-limited`,
  });

/**
 * The failing provider or lifecycle value is kept as a non-enumerable `cause` for diagnostics; it
 * never reaches the encoded problem body.
 */
const unavailableProblem = (cause?: unknown) =>
  Object.defineProperty(
    CommercePortalAuthSessionUnavailableProblemSchema.make({
      code: 'authentication_unavailable',
      detail: 'Commerce portal authentication is temporarily unavailable.',
      retryable: true,
      status: problemStatus.unavailable,
      title: 'Session authentication unavailable',
      type: `${PROBLEM_TYPE_PREFIX}unavailable`,
    }),
    'cause',
    { configurable: true, value: cause },
  );

const untrustedOriginProblem = () => forbiddenProblem('origin_not_trusted');

/** Only sign-in carries caller input; elsewhere an owner-input rejection is an internal fault. */
const signInFailureProblem = (error: CommercePortalAuthSessionFailure) =>
  Schema.is(CommercePortalAuthSessionInvalidRequest)(error) ? invalidProblem() : unavailableProblem();

const evidenceFailureProblem = (error: CommercePortalAuthSessionEvidenceFailure) => {
  if (!Schema.is(CommercePortalAuthSessionEvidenceRejected)(error)) {
    return unavailableProblem();
  }
  return error.reason.includes('disabled')
    ? forbiddenProblem('account_disabled')
    : authenticationProblem('session_expired');
};

interface AuthSessionResponse {
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly providerSubjectId: string;
  readonly sessionId: string;
}

const ProviderDateSchema = Schema.Union([Schema.Date, Schema.String, Schema.Finite]);
type ProviderDate = typeof ProviderDateSchema.Type;
const isProviderDate = Schema.is(ProviderDateSchema);
const ProviderSessionResponseSchema = Schema.Struct({
  session: Schema.Struct({
    createdAt: ProviderDateSchema,
    expiresAt: ProviderDateSchema,
    id: Schema.String,
  }),
  user: Schema.Struct({ id: Schema.String }),
});
type ProviderSessionResponse = typeof ProviderSessionResponseSchema.Type;

/** `returnHeaders: true` makes Better Auth answer with this envelope; only its headers are read. */
const SignOutEnvelopeSchema = Schema.Struct({ headers: Schema.instanceOf(Headers) });

const asDate = (value: ProviderDate): Date | null => {
  if (!isProviderDate(value)) {
    return null;
  }
  const date = DateTime.make(value);
  return Option.isSome(date) ? DateTime.toDate(date.value) : null;
};

const readSessionResponse = (value: ProviderSessionResponse): AuthSessionResponse | null => {
  const createdAt = asDate(value.session.createdAt);
  const expiresAt = asDate(value.session.expiresAt);
  return createdAt === null || expiresAt === null
    ? null
    : {
        createdAt,
        expiresAt,
        providerSubjectId: value.user.id,
        sessionId: value.session.id,
      };
};

const encodeSessionReference = (sessionId: string) =>
  Schema.decodeEffect(CommerceSessionReferenceSchema)(`${commerceSessionReferencePrefix}${sessionId}`).pipe(
    Effect.mapError(unavailableProblem),
  );

type HttpSessionReferenceInput = Omit<CommercePortalAuthSessionReferenceInput, 'expectedProviderSubjectId'> & {
  readonly expectedProviderSubjectId?: string;
};

interface ReadProviderSession {
  readonly headers: Headers;
  readonly session: AuthSessionResponse;
}

const readProviderSession = Effect.fn('CommercePortalAuthSessionHttp.readProviderSession')(
  function* readProviderSessionEffect(headers: Headers, allowProviderRefresh: boolean) {
    const auth = yield* CommercePortalAuthService;
    const input = {
      headers,
      query: { disableCookieCache: true, disableRefresh: !allowProviderRefresh },
      returnHeaders: true,
    } satisfies {
      readonly headers: Headers;
      readonly query: { readonly disableCookieCache: boolean; readonly disableRefresh: boolean };
      readonly returnHeaders: true;
    };
    const getSession = auth.api.getSession<false, true>;
    const result = yield* Effect.tryPromise({
      catch: providerHttpFailure,
      try: getSession.bind(auth.api, input),
    }).pipe(httpBridgeTimeoutPolicy);
    if (result === null) {
      return Option.none<ReadProviderSession>();
    }
    const parsed = Schema.decodeUnknownOption(ProviderSessionResponseSchema)(result.response);
    if (Option.isNone(parsed)) {
      return Option.none<ReadProviderSession>();
    }
    const session = readSessionResponse(parsed.value);
    return session === null ? Option.none<ReadProviderSession>() : Option.some({ headers: result.headers, session });
  },
  (effect) => effect.pipe(Effect.mapError(unavailableProblem)),
);

const referenceInput = (session: AuthSessionResponse, sessionRef: typeof CommerceSessionReferenceSchema.Type) =>
  ({
    expectedProviderSubjectId: session.providerSubjectId,
    sessionRef,
  }) satisfies HttpSessionReferenceInput;

/** The wire snapshot is the owner projection; evidence assurance and observation stay private. */
const toSessionSnapshot = (snapshot: CommercePortalAuthSessionSnapshot): CommercePortalAuthSessionSnapshotWire => ({
  authenticatedAt: snapshot.authenticatedAt,
  authenticationNamespaceId: snapshot.authenticationNamespaceId,
  createdAt: snapshot.createdAt,
  expiresAt: snapshot.expiresAt,
  policyVersion: snapshot.policyVersion,
  providerSubjectId: snapshot.providerSubjectId,
  sessionRef: snapshot.sessionRef,
  subjectType: snapshot.subjectType,
  updatedAt: snapshot.updatedAt,
});

const signInOutcomeResponse = (outcome: CommercePortalAuthSessionSignInOutcome) => {
  if (outcome.outcome === 'SESSION_CREATED') {
    return Effect.succeed({ outcome: outcome.outcome, session: toSessionSnapshot(outcome.session) });
  }
  if (outcome.outcome === 'MFA_REQUIRED') {
    return Effect.succeed({ methods: outcome.methods, outcome: outcome.outcome });
  }
  if (outcome.outcome === 'ACCOUNT_DISABLED') {
    return Effect.fail(forbiddenProblem('account_disabled'));
  }
  if (outcome.outcome === 'VERIFICATION_REQUIRED') {
    return Effect.fail(forbiddenProblem('verification_required'));
  }
  if (outcome.outcome === 'AUTHENTICATION_FAILED') {
    return Effect.fail(authenticationProblem('authentication_failed'));
  }
  if (outcome.outcome === 'SESSION_LIMIT_REACHED') {
    return Effect.fail(sessionLimitProblem());
  }
  if (outcome.outcome === 'RATE_LIMITED') {
    return Effect.fail(rateLimitedProblem());
  }
  if (outcome.outcome === 'SESSION_EXPIRED') {
    return Effect.fail(authenticationProblem('session_expired'));
  }
  // A revoked, refreshed or rotated session is not a sign-in result. Such a provider response is
  // indeterminate and must be reconciled by the caller rather than admitted here.
  return Effect.fail(unavailableProblem());
};

/**
 * `SESSION_EXPIRED` stays a 200 refresh variant: the caller learns the exact expiry instead of a
 * bare 401, while `getSession` reports the same state as its 401 `session_expired` problem.
 */
const refreshOutcomeResponse = (outcome: CommercePortalAuthSessionOutcome) => {
  if (outcome.outcome === 'SESSION_REFRESHED') {
    return Effect.succeed({
      identifierRotated: outcome.identifierRotated,
      outcome: outcome.outcome,
      session: toSessionSnapshot(outcome.session),
    });
  }
  if (outcome.outcome === 'SESSION_EXPIRED') {
    return Effect.succeed({ expiredAt: outcome.expiredAt, outcome: outcome.outcome });
  }
  if (outcome.outcome === 'ACCOUNT_DISABLED') {
    return Effect.fail(forbiddenProblem('account_disabled'));
  }
  if (outcome.outcome === 'VERIFICATION_REQUIRED') {
    return Effect.fail(forbiddenProblem('verification_required'));
  }
  if (outcome.outcome === 'SESSION_REVOKED') {
    return Effect.fail(authenticationProblem('session_revoked'));
  }
  if (outcome.outcome === 'AUTHENTICATION_FAILED') {
    return Effect.fail(authenticationProblem('authentication_failed'));
  }
  if (outcome.outcome === 'RATE_LIMITED') {
    return Effect.fail(rateLimitedProblem());
  }
  return Effect.fail(unavailableProblem());
};

/** A revoked session must lose its browser cookie even when the provider call itself fails. */
const expiredSessionCookies = (configuration: CommercePortalAuthConfigValue): readonly string[] => {
  const cookieOptions = {
    httpOnly: COMMERCE_PORTAL_AUTH_POLICY.cookie.httpOnly,
    path: COMMERCE_PORTAL_AUTH_POLICY.cookie.path,
    sameSite: COMMERCE_PORTAL_AUTH_POLICY.cookie.sameSite,
    secure: configuration.secureCookies,
  };
  const providerCookies = getCookies({
    advanced: {
      cookiePrefix: COMMERCE_PORTAL_AUTH_POLICY.cookie.namePrefix,
      defaultCookieAttributes: cookieOptions,
      useSecureCookies: configuration.secureCookies,
    },
    baseURL: configuration.baseUrl,
  });
  const sessionTokenExpired = expireCookieUnsafe(emptyCookies, providerCookies.sessionToken.name, cookieOptions);
  const sessionDataExpired = expireCookieUnsafe(sessionTokenExpired, providerCookies.sessionData.name, cookieOptions);
  return toSetCookieHeaders(
    expireCookieUnsafe(sessionDataExpired, providerCookies.dontRememberToken.name, cookieOptions),
  );
};

const providerSignOutCookies = Effect.fn('CommercePortalAuthSessionHttp.providerSignOutCookies')(
  function* providerSignOutCookiesEffect(headers: Headers) {
    const auth = yield* CommercePortalAuthService;
    const configuration = yield* CommercePortalAuthConfig;
    const result = yield* Effect.result(
      Effect.tryPromise({
        catch: providerHttpFailure,
        try: auth.api.signOut.bind(auth.api, { headers, returnHeaders: true }),
      }).pipe(httpBridgeTimeoutPolicy, Effect.flatMap(Schema.decodeUnknownEffect(SignOutEnvelopeSchema))),
    );
    const cleared = Result.isFailure(result) ? [] : providerSetCookieHeaders(result.success.headers);
    return [...cleared, ...expiredSessionCookies(configuration)];
  },
);

const SIGN_IN_RATE_LIMIT_ROUTE = '/sign-in/email';
const signInRateLimit: CommercePortalAuthRecoveryRateLimitRule = {
  max: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.signIn.max,
  windowSeconds: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.signIn.windowSeconds,
};

/**
 * The attempted address is part of the budget key, never the counter store's contents: it is keyed
 * under the deployment secret, so the durable `rate_limit` rows stay a set of opaque digests rather
 * than a readable list of the portal's customers.
 */
/**
 * Better Auth declares `rateLimit.customRules['/sign-in/email']` but enforces it only inside
 * `router()`'s `onRequest`, which is reachable exclusively through `auth.handler` — a handler this
 * transport deliberately never mounts. Password attempts would therefore be unbounded, so the owner
 * spends the same rule against its own durable counter store. A store that cannot answer refuses
 * the attempt rather than serving it uncounted.
 *
 * The key names both the resolved client and the account the attempt is for. The account half is
 * what keeps one caller from denying sign-in to everybody: this vertical is served by a web handler
 * whose request carries no socket peer (`http-transport.ts`), so `resolveClientKey` answers the same
 * unattributable value for every request and a client-only key would be a single deployment-wide
 * 5-per-60s counter — six attempts from anywhere would answer every customer's sign-in with 429.
 * Keyed on the account, an attempt can only spend the budget of the address it already names, which
 * is also the thing a password-attempt throttle exists to protect. The client half is not
 * decoration: where a deployment does observe a peer it keeps one client's attempts off another
 * client's budget for the same account.
 */
const consumeSignInBudget = Effect.fn('CommercePortalAuthSessionHttp.signInRateLimit')(
  function* consumeSignInBudgetEffect(request: HttpServerRequest.HttpServerRequest, email: string) {
    const budget = yield* CommercePortalAuthRecoveryRateLimitService;
    const configuration = yield* CommercePortalAuthConfig;
    const client = resolveClientKey(request, configuration.trustedProxies);
    const subject = commercePortalAuthSubjectDigest(email, configuration.secret);
    return yield* budget.consume(`${client}|${subject}|${SIGN_IN_RATE_LIMIT_ROUTE}`, signInRateLimit).pipe(
      Effect.catchTag('CommercePortalAuthRecoveryProviderFailure', (failure) =>
        Effect.annotateLogs(Effect.logError('Commerce portal sign-in budget could not be spent', failure), {
          operation: failure.operation,
          route: SIGN_IN_RATE_LIMIT_ROUTE,
        }).pipe(Effect.andThen(Effect.fail(unavailableProblem()))),
      ),
    );
  },
);

/** The opaque reference an admitted sign-in published, so an audit row can name the session. */
const signInAuditSessionRef = (outcome: CommercePortalAuthSessionSignInOutcome): string | undefined =>
  outcome.outcome === 'SESSION_CREATED' || outcome.outcome === 'SESSION_REFRESHED'
    ? outcome.session.sessionRef
    : undefined;

const signInAuditProviderSubjectId = (outcome: CommercePortalAuthSessionSignInOutcome): string | undefined =>
  outcome.outcome === 'ACCOUNT_DISABLED' ? outcome.providerSubjectId : undefined;

const signIn = Effect.fn('CommercePortalAuthSessionHttp.signIn')(function* signInEffect(
  payload: Schema.Codec.Encoded<typeof CommercePortalAuthSignInInputSchema>,
  request: HttpServerRequest.HttpServerRequest,
) {
  yield* noStoreHeaders;
  // The origin gate runs before the budget is spent. These trusted origins are the only CSRF
  // authority for this route (`../http-transport.ts`), and a sign-in body is a CORS simple request,
  // so a third-party page can drive a visitor's browser into this handler. Spending first would let
  // that page exhaust the visitor's own sign-in budget and collect a 403 only afterwards; the
  // sibling step-up transport orders it the same way.
  yield* requireTrustedOrigin(request.headers, untrustedOriginProblem);
  const configuration = yield* CommercePortalAuthConfig;
  const subjectDigest = commercePortalAuthSubjectDigest(payload.email, configuration.secret);
  const allowed = yield* consumeSignInBudget(request, payload.email);
  if (!allowed) {
    yield* emitCommercePortalAuthAudit(
      commercePortalAuthSignInAuditEvent({
        occurredAt: yield* DateTime.nowAsDate,
        outcome: 'RATE_LIMITED',
        subjectDigest,
      }),
    );
    return yield* Effect.fail(rateLimitedProblem());
  }
  const lifecycle = yield* CommercePortalAuthSessionLifecycle;
  const result = yield* lifecycle.signIn(payload).pipe(Effect.mapError(signInFailureProblem));
  const providerSubjectId = signInAuditProviderSubjectId(result.outcome);
  const sessionRef = signInAuditSessionRef(result.outcome);
  yield* emitCommercePortalAuthAudit(
    commercePortalAuthSignInAuditEvent({
      occurredAt: yield* DateTime.nowAsDate,
      outcome: result.outcome.outcome,
      providerSubjectId,
      sessionRef,
      subjectDigest,
    }),
  );
  // The provider cookies belong to an admitted sign-in only. A rejected admission (disabled,
  // unverified or session-capped) has already revoked the durable session, so the response hook is
  // registered after the outcome is known to be a success and never on a rejection.
  const response = yield* signInOutcomeResponse(result.outcome);
  yield* forwardSetCookieHeaders(result.setCookieHeaders);
  return response;
});

const signOut = Effect.fn('CommercePortalAuthSessionHttp.signOut')(function* signOutEffect(
  request: HttpServerRequest.HttpServerRequest,
) {
  yield* noStoreHeaders;
  yield* requireTrustedOrigin(request.headers, untrustedOriginProblem);
  const headers = requestHeaders(request.headers);
  const providerSession = yield* readProviderSession(headers, false);
  if (Option.isSome(providerSession)) {
    const lifecycle = yield* CommercePortalAuthSessionLifecycle;
    const sessionRef = yield* encodeSessionReference(providerSession.value.session.sessionId);
    yield* lifecycle
      .signOut(referenceInput(providerSession.value.session, sessionRef))
      .pipe(Effect.mapError(unavailableProblem));
  }
  yield* forwardSetCookieHeaders(yield* providerSignOutCookies(headers));
  return { outcome: 'SESSION_REVOKED' } as const;
});

const refresh = Effect.fn('CommercePortalAuthSessionHttp.refresh')(function* refreshEffect(
  request: HttpServerRequest.HttpServerRequest,
) {
  yield* noStoreHeaders;
  yield* requireTrustedOrigin(request.headers, untrustedOriginProblem);
  const lifecycle = yield* CommercePortalAuthSessionLifecycle;
  const providerSession = yield* readProviderSession(requestHeaders(request.headers), true);
  if (Option.isNone(providerSession)) {
    return yield* Effect.fail(authenticationProblem('session_revoked'));
  }
  const sessionRef = yield* encodeSessionReference(providerSession.value.session.sessionId);
  const outcome = yield* lifecycle
    .refresh(referenceInput(providerSession.value.session, sessionRef))
    .pipe(Effect.mapError(unavailableProblem));
  // Only an admitted session hands its cookies onward. Reading the session with provider refresh
  // enabled may already have rotated the Better Auth cookie, so the hook is registered after the
  // outcome is known to be a success: a rejection must never renew the browser's credential.
  const response = yield* refreshOutcomeResponse(outcome);
  yield* forwardSetCookieHeaders(providerSetCookieHeaders(providerSession.value.headers));
  return response;
});

const getSession = Effect.fn('CommercePortalAuthSessionHttp.getSession')(function* getSessionEffect(
  request: HttpServerRequest.HttpServerRequest,
) {
  yield* noStoreHeaders;
  const lifecycle = yield* CommercePortalAuthSessionLifecycle;
  const providerSession = yield* readProviderSession(requestHeaders(request.headers), true);
  if (Option.isNone(providerSession)) {
    return { state: 'anonymous' } as const;
  }
  const sessionRef = yield* encodeSessionReference(providerSession.value.session.sessionId);
  const evidence = yield* lifecycle
    .evidenceForSession(referenceInput(providerSession.value.session, sessionRef))
    .pipe(Effect.result);
  if (Result.isFailure(evidence)) {
    return yield* Effect.fail(evidenceFailureProblem(evidence.failure));
  }
  yield* forwardSetCookieHeaders(providerSetCookieHeaders(providerSession.value.headers));
  return { session: toSessionSnapshot(evidence.success), state: 'authenticated' } as const;
});

const portalAuthSessionSchemaErrorLive = HttpApiMiddleware.layerSchemaErrorTransform(
  CommercePortalAuthSessionSchemaErrorMiddleware,
  () => Effect.fail(invalidProblem()),
);

/** Root provides the Better Auth transport port, the session lifecycle and the realm config. */
export const portalAuthSessionApiLive = HttpApiBuilder.group(
  commerceCustomerContextApi,
  'portalAuthSession',
  (handlers) =>
    handlers
      .handle('signIn', ({ payload, request }) => signIn(payload, request))
      .handle('signOut', ({ request }) => signOut(request))
      .handle('refresh', ({ request }) => refresh(request))
      .handle('getSession', ({ request }) => getSession(request)),
).pipe(Layer.provide(portalAuthSessionSchemaErrorLive));

/**
 * The same handlers mounted on the standalone session API. The composed Commerce runtime uses
 * `portalAuthSessionApiLive`; this mount is the isolated session topology the owner's transport
 * tests drive, mirroring the Shell's standalone external-identity group.
 */
export const portalAuthSessionStandaloneApiLive = HttpApiBuilder.group(
  CommercePortalAuthSessionApi,
  'portalAuthSession',
  (handlers) =>
    handlers
      .handle('signIn', ({ payload, request }) => signIn(payload, request))
      .handle('signOut', ({ request }) => signOut(request))
      .handle('refresh', ({ request }) => refresh(request))
      .handle('getSession', ({ request }) => getSession(request)),
).pipe(
  Layer.provide(portalAuthSessionSchemaErrorLive),
  // The isolated topology has no durable audit store; decisions still complete, they are just unrecorded.
  Layer.provide(Layer.succeed(CommercePortalAuthAudit, unauditedCommercePortalAuthRecorder)),
);

/** The constructed realm stays a visible requirement; the composition root supplies it once. */
export const CommercePortalAuthServiceLive = Layer.effect(
  CommercePortalAuthService,
  Effect.gen(function* makeCommercePortalAuthServiceLive() {
    const auth = yield* CommercePortalAuthInstance;
    return { api: auth.api };
  }),
);
