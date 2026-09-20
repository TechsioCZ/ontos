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
  hashSubjectKey,
  noStoreHeaders,
  providerSetCookieHeaders,
  requestHeaders,
  requireTrustedOrigin,
  resolveClientKey,
} from '../http-transport.ts';
import { commercePortalAuthSignInAuditEvent } from '../../../src/portal-auth/audit/audit-mapping.ts';
import type { CommercePortalAuthAuditEvent } from '../../../src/portal-auth/audit/audit-contracts.ts';
import {
  CommercePortalAuthAudit,
  commercePortalAuthSubjectDigest,
  emitCommercePortalAuthAudit,
} from '../../../src/portal-auth/audit/audit.ts';
import { consumeRateLimitBudget } from '../rate-limit-service.ts';
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
 * Better Auth runs its `/sign-in/email` limiter only inside `auth.handler`, which this transport
 * never mounts, so the owner spends the same rule itself. The key carries the account as well as
 * the client because `resolveClientKey` is unattributable here (see `http-transport.ts`), so a
 * client-only key would answer every customer's sign-in with 429.
 */
const consumeSignInBudget = Effect.fn('CommercePortalAuthSessionHttp.signInRateLimit')(
  function* consumeSignInBudgetEffect(request: HttpServerRequest.HttpServerRequest, email: string) {
    const configuration = yield* CommercePortalAuthConfig;
    const client = resolveClientKey(request, configuration.trustedProxies);
    const subject = commercePortalAuthSubjectDigest(email, configuration.secret);
    return yield* consumeRateLimitBudget(`${client}|${subject}|${SIGN_IN_RATE_LIMIT_ROUTE}`, signInRateLimit, {
      route: SIGN_IN_RATE_LIMIT_ROUTE,
      unavailable: () => unavailableProblem(),
    });
  },
);

/** The opaque reference an admitted sign-in published, so an audit row can name the session. */
const signInAuditSessionRef = (outcome: CommercePortalAuthSessionSignInOutcome): string | undefined =>
  outcome.outcome === 'SESSION_CREATED' || outcome.outcome === 'SESSION_REFRESHED'
    ? outcome.session.sessionRef
    : undefined;

/**
 * An admitted sign-in names the subject it admitted: the evidence for the one outcome that creates
 * a live credential must not be the only one that cannot say whose credential it is. A refusal that
 * never resolved an account still names none — there is nothing to name, and guessing from the
 * attempted address would turn the audit trail into an account-existence oracle.
 */
const signInAuditProviderSubjectId = (outcome: CommercePortalAuthSessionSignInOutcome): string | undefined => {
  if (outcome.outcome === 'SESSION_CREATED') {
    return outcome.session.providerSubjectId;
  }
  return outcome.outcome === 'ACCOUNT_DISABLED' ? outcome.providerSubjectId : undefined;
};

/**
 * The strict evidence path for sign-in. A sign-in is the one transport operation that mints a
 * credential, so its evidence may not be best-effort: the intent row is written before Better Auth
 * is asked for a session (an audit outage refuses the attempt outright), and the completion row is
 * written strictly too — a session the provider already created but whose evidence was refused is
 * revoked again rather than handed to the browser.
 */
const recordSignInEvidence = Effect.fn('CommercePortalAuthSessionHttp.recordSignInEvidence')(
  function* recordSignInEvidenceEffect(event: CommercePortalAuthAuditEvent) {
    const recorder = yield* CommercePortalAuthAudit;
    yield* recorder.record(event).pipe(Effect.mapError(unavailableProblem));
  },
);

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
  const client = resolveClientKey(request, configuration.trustedProxies);
  yield* recordSignInEvidence({
    correlationDigest: hashSubjectKey(client, configuration.secret),
    eventType: 'commerce.portal-auth.session-sign-in-requested.v1',
    occurredAt: yield* DateTime.nowAsDate,
    operation: 'sign-in',
    outcome: 'requested',
    subjectDigest,
  });
  const lifecycle = yield* CommercePortalAuthSessionLifecycle;
  const result = yield* lifecycle.signIn(payload).pipe(Effect.mapError(signInFailureProblem));
  const providerSubjectId = signInAuditProviderSubjectId(result.outcome);
  const sessionRef = signInAuditSessionRef(result.outcome);
  const evidence = yield* Effect.result(
    recordSignInEvidence({
      ...commercePortalAuthSignInAuditEvent({
        occurredAt: yield* DateTime.nowAsDate,
        outcome: result.outcome.outcome,
        providerSubjectId,
        sessionRef,
        subjectDigest,
      }),
      correlationDigest: hashSubjectKey(client, configuration.secret),
    }),
  );
  if (Result.isFailure(evidence)) {
    // The provider already persisted this session. Handing its cookie to the browser would leave a
    // live credential whose creation nothing durable records, so the session is taken back and the
    // caller is told the deployment is unavailable. Every other outcome changed no state, and the
    // intent row above already stands for the attempt.
    if (result.outcome.outcome === 'SESSION_CREATED') {
      // Un-audited on purpose. The audit store is refusing right now — that is what brought this
      // branch about — and an audited revoke writes its row inside the deletion's own transaction,
      // so a continuing outage would roll the deletion back and leave exactly the live credential
      // this compensation exists to take back. A deletion that fails is an operator fact rather
      // than something to swallow: it is logged at error, and the caller is still refused without
      // a cookie, so no browser holds a credential whose evidence never committed.
      const compensated = yield* Effect.result(
        lifecycle.revokeUnaudited({
          expectedProviderSubjectId: result.outcome.session.providerSubjectId,
          sessionRef: result.outcome.session.sessionRef,
        }),
      );
      if (Result.isFailure(compensated)) {
        yield* Effect.annotateLogs(
          Effect.logError('Commerce portal authentication sign-in rollback could not delete the provider session'),
          { sessionRef: result.outcome.session.sessionRef },
        );
      }
      return yield* Effect.fail(evidence.failure);
    }
    yield* Effect.annotateLogs(Effect.logError('Commerce portal authentication sign-in evidence was not persisted'), {
      auditOutcome: result.outcome.outcome,
    });
  }
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
  const headers = requestHeaders(request.headers);
  // The identifying read never renews anything. Better Auth's own refresh commits immediately and
  // in its own transaction, so asking for it first would leave a renewed provider session behind
  // whenever the owner's audited touch then failed — a renewal with no evidence, and one the
  // rejection branches below could not take back either.
  const providerSession = yield* readProviderSession(headers, false);
  if (Option.isNone(providerSession)) {
    return yield* Effect.fail(authenticationProblem('session_revoked'));
  }
  const sessionRef = yield* encodeSessionReference(providerSession.value.session.sessionId);
  const outcome = yield* lifecycle
    .refresh(referenceInput(providerSession.value.session, sessionRef))
    .pipe(Effect.mapError(unavailableProblem));
  // Only an admitted session hands its cookies onward, so the provider refresh runs after the
  // audited renewal has committed and the outcome is known to be a success: a rejection must never
  // renew the browser's credential.
  const response = yield* refreshOutcomeResponse(outcome);
  // Sequenced on `response`, not merely written after it: the provider refresh is the last thing
  // this handler does, and only an admitted outcome ever reaches it.
  const renewed = yield* Effect.succeed(response).pipe(Effect.andThen(() => readProviderSession(headers, true)));
  if (Option.isSome(renewed)) {
    yield* forwardSetCookieHeaders(providerSetCookieHeaders(renewed.value.headers));
  }
  return response;
});

const getSession = Effect.fn('CommercePortalAuthSessionHttp.getSession')(function* getSessionEffect(
  request: HttpServerRequest.HttpServerRequest,
) {
  yield* noStoreHeaders;
  const lifecycle = yield* CommercePortalAuthSessionLifecycle;
  // Non-refreshing, like `/refresh`'s own first read: with `updateAgeSeconds: 0` a refreshing read
  // would renew the provider session before `evidenceForSession` decides it may still be admitted.
  // Renewal belongs to `/refresh` alone.
  const providerSession = yield* readProviderSession(requestHeaders(request.headers), false);
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
 *
 * Unlike `portalAuthSessionApiLive`, this mount does not bake in a recorder: sign-in evidence is
 * strict, so whether the audit store answers now decides whether a session is handed out at all.
 * Leaving `CommercePortalAuthAudit` a visible requirement is what lets the owner's transport tests
 * drive a refusing recorder — the same shape the sibling MFA group's freshness reader is
 * substituted with. A topology that wants the old silence supplies
 * `unauditedCommercePortalAuthRecorder` explicitly.
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
).pipe(Layer.provide(portalAuthSessionSchemaErrorLive));

/** The constructed realm stays a visible requirement; the composition root supplies it once. */
export const CommercePortalAuthServiceLive = Layer.effect(
  CommercePortalAuthService,
  Effect.gen(function* makeCommercePortalAuthServiceLive() {
    const auth = yield* CommercePortalAuthInstance;
    return { api: auth.api };
  }),
);
