import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import { fromSetCookie, toSetCookieHeaders } from 'effect/unstable/http/Cookies';
import { Context, Duration, Effect, Option, Schema } from 'effect';
import type { HttpServerRequest } from 'effect/unstable/http';

import {
  COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  CommerceSessionReferenceSchema,
} from '../../../../shared/portal-auth-contracts.ts';
import { withCause } from '../../problems-support.ts';
import { forwardSetCookieHeaders, noStoreHeaders, requestHeaders, requireTrustedOrigin } from '../../http-transport.ts';
import { consumeRateLimitBudget } from '../../rate-limit-service.ts';
import type { CommercePortalAuthRecoveryRateLimitRule } from '../../rate-limit-service.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../config.ts';
import { encodeCommerceSessionReference } from '../session-reference.ts';
import type { CommercePortalAuthSessionCookieHandoff } from '../../session/contracts.ts';
import { CommercePortalAuthStepUpInvalidRequest } from './invalid-request.ts';
import { CommercePortalAuthStepUpRejected } from './rejected.ts';
import { CommercePortalAuthStepUpService } from './step-up-service.ts';
import type { CommercePortalAuthStepUpFailure } from './step-up-service.ts';
import { CommercePortalAuthStepUpUnavailable } from './unavailable.ts';
import {
  commercePortalAuthStepUpForbiddenProblem,
  commercePortalAuthStepUpInvalidProblem,
  commercePortalAuthStepUpRejectedProblem,
  commercePortalAuthStepUpSchemaErrorLive,
  commercePortalAuthStepUpUnavailableProblem,
} from './problems.ts';
import { commerceCustomerContextApi } from '../../../../shared/api.ts';
import { CommercePortalAuthStepUpApi } from '../../../../shared/portal-auth/step-up-api.ts';
import type {
  CommercePortalAuthStepUpHttpIssueBody,
  CommercePortalAuthStepUpHttpVerifyBody,
} from '../../../../shared/portal-auth/step-up-api.ts';

/**
 * The host supplies this owner-local provider boundary. It reads the current provider session
 * from the request cookie and signs the private lifecycle handoff. The HTTP adapter never accepts
 * identity fields from the caller and never serializes a provider token.
 */
export interface CommercePortalAuthStepUpHttpProvider {
  /** Read the current provider session from the exact incoming request headers. */
  readonly readCurrentSession: (
    headers: Headers,
  ) => Effect.Effect<Option.Option<CommercePortalAuthStepUpCurrentSession>, CommercePortalAuthStepUpUnavailable>;
  /** Return only the replacement provider session Set-Cookie value(s) for this handoff. */
  readonly setSessionCookie: (
    handoff: CommercePortalAuthSessionCookieHandoff,
  ) => Effect.Effect<readonly string[], CommercePortalAuthStepUpUnavailable>;
}

interface CommercePortalAuthStepUpCurrentSession {
  readonly providerSubjectId: string;
  readonly sessionId: string;
}

export class CommercePortalAuthStepUpHttpProviderService extends Context.Service<
  CommercePortalAuthStepUpHttpProviderService,
  CommercePortalAuthStepUpHttpProvider
>()(
  '@app/commerce-customer-context/api/portal-auth/provider/step-up/http/CommercePortalAuthStepUpHttpProviderService',
) {}

const BoundedIdentifierSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const ProviderSubjectIdSchema = BoundedIdentifierSchema.pipe(Schema.brand('CommercePortalAuthStepUpProviderSubjectId'));
const ProviderSessionIdSchema = BoundedIdentifierSchema.pipe(Schema.brand('CommercePortalAuthStepUpProviderSessionId'));
const CurrentSessionSchema = Schema.Struct({
  providerSubjectId: ProviderSubjectIdSchema,
  sessionId: ProviderSessionIdSchema,
});

const COOKIE_HANDOFF_OPERATION = 'cookie-handoff';
const httpBridgeTimeout = Duration.millis(COMMERCE_PORTAL_AUTH_POLICY.session.providerCallTimeoutMilliseconds);

const unavailable = (operation: string, cause: unknown): CommercePortalAuthStepUpUnavailable =>
  withCause(
    new CommercePortalAuthStepUpUnavailable({
      operation,
      reason: 'Commerce portal step-up provider is unavailable',
    }),
    cause,
  );

const withTimeout = <A, E>(
  operation: string,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E | CommercePortalAuthStepUpUnavailable> =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: httpBridgeTimeout,
      orElse: () => Effect.fail(unavailable(operation, 'Commerce portal step-up operation timed out')),
    }),
  );

interface CurrentIdentity {
  readonly providerSubjectId: string;
  readonly sessionRef: CommercePortalAuthSessionCookieHandoff['previousSessionRef'];
}

/**
 * Collapses every step-up failure into its RFC-9457 problem, falling back to Unavailable for
 * anything that is not one of the two named service failures (mirrors `recoveryProblem`).
 */
const stepUpProblem = (
  failure: CommercePortalAuthStepUpFailure,
):
  | typeof commercePortalAuthStepUpInvalidProblem
  | typeof commercePortalAuthStepUpRejectedProblem
  | typeof commercePortalAuthStepUpUnavailableProblem => {
  if (Schema.is(CommercePortalAuthStepUpInvalidRequest)(failure)) {
    return commercePortalAuthStepUpInvalidProblem;
  }
  if (Schema.is(CommercePortalAuthStepUpRejected)(failure)) {
    return commercePortalAuthStepUpRejectedProblem;
  }
  return commercePortalAuthStepUpUnavailableProblem;
};

const readCurrentIdentity = Effect.fn('CommercePortalAuthStepUpHttp.readCurrentIdentity')(
  function* readCurrentIdentityEffect(
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.fn.Return<
    CurrentIdentity | null,
    CommercePortalAuthStepUpUnavailable,
    CommercePortalAuthStepUpHttpProviderService
  > {
    const provider = yield* CommercePortalAuthStepUpHttpProviderService;
    const current = yield* withTimeout(
      'current-session-read',
      provider.readCurrentSession(requestHeaders(request.headers)),
    );
    if (Option.isNone(current)) {
      return null;
    }
    const decoded = yield* Schema.decodeEffect(CurrentSessionSchema, { onExcessProperty: 'error' })(current.value).pipe(
      Effect.mapError((cause) => unavailable('current-session-read', cause)),
    );
    const sessionRef = yield* encodeCommerceSessionReference(decoded.sessionId).pipe(
      Effect.mapError((cause) => unavailable('session-reference', cause)),
    );
    return { providerSubjectId: decoded.providerSubjectId, sessionRef };
  },
);

const STEP_UP_ISSUE_RATE_LIMIT_ROUTE = '/step-up';
const STEP_UP_VERIFY_RATE_LIMIT_ROUTE = '/step-up/verify';
const stepUpRateLimit: CommercePortalAuthRecoveryRateLimitRule = {
  max: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.mfa.max,
  windowSeconds: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.mfa.windowSeconds,
};

/**
 * The per-challenge `attemptsRemaining` budget is scoped to the challenge the caller just minted,
 * so on its own a caller holding one valid session cookie could loop issue → five guesses → issue
 * indefinitely. These two budgets are the durable ceiling that loop cannot reset: they are keyed on
 * the session the caller's own cookie resolves to — a value derived server-side, never supplied —
 * and spent in the deployment's shared counter store, so re-issuing costs budget and guessing is
 * capped across every challenge the session ever mints.
 *
 * An exhausted budget answers with the group's declared rejection rather than a new status: the
 * caller learns exactly what an exhausted per-challenge budget already tells it, and the published
 * step-up contract is unchanged.
 */
const consumeStepUpBudget = Effect.fn('CommercePortalAuthStepUpHttp.rateLimit')(function* consumeStepUpBudgetEffect(
  route: string,
  identity: CurrentIdentity,
) {
  const allowed = yield* consumeRateLimitBudget(`${identity.sessionRef}|${route}`, stepUpRateLimit, {
    route,
    unavailable: () => commercePortalAuthStepUpUnavailableProblem,
  });
  return allowed ? yield* Effect.void : yield* Effect.fail(commercePortalAuthStepUpRejectedProblem);
});

const issue = Effect.fn('CommercePortalAuthStepUpHttp.issue')(function* issueEffect(
  _payload: CommercePortalAuthStepUpHttpIssueBody,
  request: HttpServerRequest.HttpServerRequest,
) {
  yield* noStoreHeaders;
  yield* requireTrustedOrigin(request.headers, () => commercePortalAuthStepUpForbiddenProblem);
  const identity = yield* readCurrentIdentity(request).pipe(Effect.mapError(stepUpProblem));
  if (identity === null) {
    return yield* Effect.fail(commercePortalAuthStepUpRejectedProblem);
  }
  yield* consumeStepUpBudget(STEP_UP_ISSUE_RATE_LIMIT_ROUTE, identity);
  const service = yield* CommercePortalAuthStepUpService;
  return yield* withTimeout(
    'challenge-issue',
    service.issue({ providerSubjectId: identity.providerSubjectId, sessionRef: identity.sessionRef }),
  ).pipe(Effect.mapError(stepUpProblem));
});

const validHandoff = (handoff: CommercePortalAuthSessionCookieHandoff, identity: CurrentIdentity): boolean =>
  handoff.reason === 'step-up' &&
  handoff.previousSessionRef === identity.sessionRef &&
  handoff.session.providerSubjectId === identity.providerSubjectId &&
  handoff.session.authenticationNamespaceId === COMMERCE_AUTHENTICATION_NAMESPACE_ID &&
  handoff.session.subjectType === 'user' &&
  Schema.is(CommerceSessionReferenceSchema)(handoff.session.sessionRef) &&
  handoff.session.sessionRef !== identity.sessionRef;

const verify = Effect.fn('CommercePortalAuthStepUpHttp.verify')(function* verifyEffect(
  payload: CommercePortalAuthStepUpHttpVerifyBody,
  request: HttpServerRequest.HttpServerRequest,
) {
  yield* noStoreHeaders;
  yield* requireTrustedOrigin(request.headers, () => commercePortalAuthStepUpForbiddenProblem);
  const identity = yield* readCurrentIdentity(request).pipe(Effect.mapError(stepUpProblem));
  if (identity === null) {
    return yield* Effect.fail(commercePortalAuthStepUpRejectedProblem);
  }
  yield* consumeStepUpBudget(STEP_UP_VERIFY_RATE_LIMIT_ROUTE, identity);
  const service = yield* CommercePortalAuthStepUpService;
  const result = yield* withTimeout(
    'challenge-verify',
    service.verify({
      challengeId: payload.challengeId,
      code: payload.code,
      headers: requestHeaders(request.headers),
      providerSubjectId: identity.providerSubjectId,
      sessionRef: identity.sessionRef,
    }),
  ).pipe(Effect.mapError(stepUpProblem));
  if (result.outcome === 'STEP_UP_REJECTED') {
    return yield* Effect.fail(commercePortalAuthStepUpRejectedProblem);
  }
  if (!validHandoff(result.handoff, identity)) {
    return yield* Effect.fail(commercePortalAuthStepUpUnavailableProblem);
  }
  const provider = yield* CommercePortalAuthStepUpHttpProviderService;
  const cookies = yield* withTimeout(COOKIE_HANDOFF_OPERATION, provider.setSessionCookie(result.handoff)).pipe(
    Effect.mapError(stepUpProblem),
  );
  const normalizedCookies = toSetCookieHeaders(fromSetCookie(cookies));
  const [cookie] = normalizedCookies;
  if (normalizedCookies.length !== 1 || cookie === undefined) {
    return yield* Effect.fail(commercePortalAuthStepUpUnavailableProblem);
  }
  yield* forwardSetCookieHeaders([cookie]);
  return { outcome: 'STEP_UP_COMPLETED' as const };
});

/** Root provides the step-up service and the portal configuration this group reads. */
export const portalAuthStepUpApiLive = HttpApiBuilder.group(
  commerceCustomerContextApi,
  'portalAuthStepUp',
  (handlers) =>
    handlers
      .handle('issue', ({ payload, request }) => issue(payload, request))
      .handle('verify', ({ payload, request }) => verify(payload, request)),
).pipe(Layer.provide(commercePortalAuthStepUpSchemaErrorLive));

/**
 * The same handlers mounted on the standalone step-up API. The composed Commerce runtime uses
 * `portalAuthStepUpApiLive`; this mount is the isolated step-up topology the owner's transport
 * tests drive, mirroring `portalAuthSessionStandaloneApiLive`.
 */
export const portalAuthStepUpStandaloneApiLive = HttpApiBuilder.group(
  CommercePortalAuthStepUpApi,
  'portalAuthStepUp',
  (handlers) =>
    handlers
      .handle('issue', ({ payload, request }) => issue(payload, request))
      .handle('verify', ({ payload, request }) => verify(payload, request)),
).pipe(Layer.provide(commercePortalAuthStepUpSchemaErrorLive));
