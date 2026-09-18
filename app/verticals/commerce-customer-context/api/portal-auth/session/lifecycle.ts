import { DateTime, Effect, Layer, Match, Option, Schema } from 'effect';

import {
  COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  ExternalUserSubjectSchema,
} from '../../../shared/portal-auth-contracts.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../provider/config.ts';
import { encodeCommerceSessionReference, parseCommerceSessionReference } from '../provider/session-reference.ts';
import type { CommercePortalAuthSessionReferenceError } from '../provider/session-reference.ts';
import type { CommercePortalAuthProviderUnavailable } from './errors.ts';
import {
  CommercePortalAuthSessionEvidenceRejected,
  CommercePortalAuthSessionInvalidRequest,
  CommercePortalAuthSessionRefreshConflict,
  CommercePortalAuthSessionRotationRejected,
  CommercePortalAuthSessionUnavailable,
} from './errors.ts';
import {
  CommercePortalAuthAccountSubjectInputSchema,
  CommercePortalAuthProviderSubjectIdSchema,
  CommercePortalAuthSessionEvidenceSchema,
  CommercePortalAuthSessionReferenceInputSchema,
  CommercePortalAuthSessionRotationInputSchema,
  CommercePortalAuthSignInInputSchema,
  COMMERCE_PORTAL_AUTH_SESSION_ABSOLUTE_LIFETIME_SECONDS,
  COMMERCE_PORTAL_AUTH_SESSION_INACTIVITY_LIFETIME_SECONDS,
  COMMERCE_PORTAL_AUTH_SESSION_MAX_ACTIVE_SESSIONS,
  COMMERCE_PORTAL_AUTH_SESSION_POLICY_VERSION,
} from './contracts.ts';
import type {
  CommercePortalAuthSessionCookieHandoff,
  CommercePortalAuthProviderSignInResult,
  CommercePortalAuthSessionEvidence,
  CommercePortalAuthSessionOutcome,
  CommercePortalAuthSessionRecord,
  CommercePortalAuthSessionSignInResult,
  CommercePortalAuthSessionSnapshot,
  CommercePortalAuthSignInInput,
  CommercePortalAuthSessionReferenceInput,
  CommercePortalAuthSessionRotationInput,
} from './contracts.ts';
import { CommercePortalAuthSessionLifecycle } from './lifecycle-service.ts';
import type {
  CommercePortalAuthSessionEvidenceFailure,
  CommercePortalAuthSessionFailure,
  CommercePortalAuthSessionLifecycleService,
} from './lifecycle-service.ts';
import { CommercePortalAuthSessionProviderService } from './provider-service.ts';
import { CommercePortalAuthSessionStoreService } from './store-service.ts';
import type { CommercePortalAuthSessionStore } from './store-service.ts';

export { CommercePortalAuthSessionLifecycle } from './lifecycle-service.ts';
export type {
  CommercePortalAuthSessionEvidenceFailure,
  CommercePortalAuthSessionFailure,
  CommercePortalAuthSessionLifecycleService,
} from './lifecycle-service.ts';

export interface CommercePortalAuthSessionProvider {
  /**
   * Better Auth is called exactly once for an admission attempt. A successful provider response
   * contains a token only inside this owner-local boundary; the lifecycle immediately resolves
   * it to durable state and never returns it.
   */
  readonly signInEmail: (
    input: CommercePortalAuthSignInInput,
  ) => Effect.Effect<CommercePortalAuthProviderSignInResult, CommercePortalAuthProviderUnavailable>;
}

export interface CommercePortalAuthSessionClock {
  readonly now: () => Date;
}

const systemClock: CommercePortalAuthSessionClock = Object.freeze({ now: () => DateTime.toDate(DateTime.nowUnsafe()) });
const SESSION_RECONCILE_OPERATION = 'session-reconcile';

const withCause = <TError extends object>(error: TError, cause: unknown): TError =>
  Object.defineProperty(error, 'cause', { configurable: true, value: cause });

const invalidRequest = (cause?: unknown): CommercePortalAuthSessionInvalidRequest =>
  cause === undefined
    ? new CommercePortalAuthSessionInvalidRequest({ reason: 'Commerce portal session input is invalid' })
    : withCause(
        new CommercePortalAuthSessionInvalidRequest({ reason: 'Commerce portal session input is invalid' }),
        cause,
      );

const unavailable = (operation: string, cause: unknown): CommercePortalAuthSessionUnavailable =>
  withCause(
    new CommercePortalAuthSessionUnavailable({
      operation,
      reason: `Commerce portal authentication ${operation} could not complete`,
    }),
    cause,
  );

const evidenceRejected = (reason: string): CommercePortalAuthSessionEvidenceRejected =>
  new CommercePortalAuthSessionEvidenceRejected({ reason });

const epochMillis = (value: Date): number => {
  const date = DateTime.make(value);
  return Option.isSome(date) ? DateTime.toEpochMillis(date.value) : Number.NaN;
};

const activeBan = (record: CommercePortalAuthSessionRecord, now: number): boolean => {
  if (!record.banned) {
    return false;
  }
  if (record.banExpiresAt === null) {
    return true;
  }
  const expiresAt = epochMillis(record.banExpiresAt);
  return !Number.isFinite(expiresAt) || expiresAt > now;
};

const absoluteExpiry = (record: Pick<CommercePortalAuthSessionRecord, 'createdAt'>): number => {
  const createdAt = DateTime.make(record.createdAt);
  return Option.isSome(createdAt)
    ? DateTime.toEpochMillis(
        DateTime.add(createdAt.value, {
          seconds: COMMERCE_PORTAL_AUTH_SESSION_ABSOLUTE_LIFETIME_SECONDS,
        }),
      )
    : Number.NaN;
};

const isLive = (record: CommercePortalAuthSessionRecord, now: number): boolean => {
  const createdAt = epochMillis(record.createdAt);
  const updatedAt = epochMillis(record.updatedAt);
  const expiresAt = epochMillis(record.expiresAt);
  return (
    Number.isFinite(createdAt) &&
    Number.isFinite(updatedAt) &&
    Number.isFinite(expiresAt) &&
    createdAt <= now &&
    updatedAt <= now &&
    expiresAt > now &&
    absoluteExpiry(record) > now &&
    !activeBan(record, now) &&
    record.emailVerified
  );
};

const hasUsableSessionDates = (record: CommercePortalAuthSessionRecord): boolean =>
  [record.createdAt, record.updatedAt, record.expiresAt].every((value) => Number.isFinite(epochMillis(value)));

const safeExpiry = (record: CommercePortalAuthSessionRecord, now: Date): Date =>
  DateTime.toDate(
    DateTime.makeUnsafe(
      Math.min(
        absoluteExpiry(record),
        Math.max(
          epochMillis(record.expiresAt),
          DateTime.toEpochMillis(
            DateTime.add(DateTime.makeUnsafe(now), {
              seconds: COMMERCE_PORTAL_AUTH_SESSION_INACTIVITY_LIFETIME_SECONDS,
            }),
          ),
        ),
      ),
    ),
  );

const isRotationEnabled = (reason: CommercePortalAuthSessionRotationInput['reason']): boolean =>
  Match.value(reason).pipe(
    Match.when('credential-change', () => COMMERCE_PORTAL_AUTH_POLICY.session.identifierRotation.onCredentialChange),
    Match.when('privilege-boundary', () => COMMERCE_PORTAL_AUTH_POLICY.session.identifierRotation.onPrivilegeBoundary),
    Match.when('recovery', () => COMMERCE_PORTAL_AUTH_POLICY.session.identifierRotation.onRecovery),
    Match.when('sign-in', () => COMMERCE_PORTAL_AUTH_POLICY.session.identifierRotation.onSignIn),
    Match.when('step-up', () => COMMERCE_PORTAL_AUTH_POLICY.session.identifierRotation.onStepUp),
    Match.exhaustive,
  );

const makeSnapshot = Effect.fn('CommercePortalAuthSessionLifecycle.makeSnapshot')(
  function* makeSnapshot(
    record: CommercePortalAuthSessionRecord,
  ): Effect.fn.Return<CommercePortalAuthSessionSnapshot, Schema.SchemaError | CommercePortalAuthSessionReferenceError> {
    yield* Schema.decodeEffect(ExternalUserSubjectSchema)({
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      providerSubjectId: record.providerSubjectId,
      subjectType: 'user',
    });
    const providerSubjectId = yield* Schema.decodeEffect(CommercePortalAuthProviderSubjectIdSchema)(
      record.providerSubjectId,
    );
    const sessionRef = yield* encodeCommerceSessionReference(record.id);
    const snapshot: CommercePortalAuthSessionSnapshot = {
      authenticatedAt: record.createdAt,
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      policyVersion: COMMERCE_PORTAL_AUTH_SESSION_POLICY_VERSION,
      providerSubjectId,
      sessionRef,
      subjectType: 'user' as const,
      updatedAt: record.updatedAt,
    };
    return snapshot;
  },
  (effect) => effect.pipe(Effect.mapError((cause) => unavailable('session-projection', cause))),
);

const parseSessionId = (
  input: CommercePortalAuthSessionReferenceInput,
): Effect.Effect<string, CommercePortalAuthSessionInvalidRequest> =>
  parseCommerceSessionReference(input.sessionRef).pipe(Effect.mapError((cause) => invalidRequest(cause)));

const expectedSubjectMatches = (
  record: CommercePortalAuthSessionRecord,
  expectedProviderSubjectId: string | undefined,
): boolean => expectedProviderSubjectId === undefined || expectedProviderSubjectId === record.providerSubjectId;

export const makeCommercePortalAuthSessionLifecycle = (
  ...dependencies: readonly [
    store: CommercePortalAuthSessionStore,
    provider: CommercePortalAuthSessionProvider,
    clock?: CommercePortalAuthSessionClock,
  ]
): CommercePortalAuthSessionLifecycleService => {
  const [store, provider, clock = systemClock] = dependencies;
  const admitProviderSession = Effect.fn('CommercePortalAuthSessionLifecycle.admitProviderSession')(
    function* admitProviderSession(
      token: string,
    ): Effect.fn.Return<CommercePortalAuthSessionOutcome, CommercePortalAuthSessionFailure> {
      const recordOption = yield* store.findByToken(token);
      // A successful provider response without durable state is indeterminate. The caller must
      // reconcile by lookup; this service deliberately does not retry sign-in or create a second
      // session/email side effect.
      if (Option.isNone(recordOption)) {
        return yield* unavailable(SESSION_RECONCILE_OPERATION, 'Provider session was not durable');
      }
      const record = recordOption.value;
      const now = clock.now();
      const nowMillis = epochMillis(now);
      if (activeBan(record, nowMillis)) {
        yield* store.revoke({ providerSubjectId: record.providerSubjectId, sessionId: record.id });
        return { outcome: 'ACCOUNT_DISABLED', providerSubjectId: record.providerSubjectId };
      }
      if (!record.emailVerified) {
        yield* store.revoke({ providerSubjectId: record.providerSubjectId, sessionId: record.id });
        return { outcome: 'VERIFICATION_REQUIRED' };
      }

      if (!hasUsableSessionDates(record)) {
        yield* store.revoke({ providerSubjectId: record.providerSubjectId, sessionId: record.id });
        return yield* unavailable(SESSION_RECONCILE_OPERATION, 'Provider session dates were malformed');
      }
      if (epochMillis(record.createdAt) > nowMillis || epochMillis(record.updatedAt) > nowMillis) {
        yield* store.revoke({ providerSubjectId: record.providerSubjectId, sessionId: record.id });
        return yield* unavailable(SESSION_RECONCILE_OPERATION, 'Provider session clock was ahead');
      }
      if (epochMillis(record.expiresAt) <= nowMillis || absoluteExpiry(record) <= nowMillis) {
        yield* store.revoke({ providerSubjectId: record.providerSubjectId, sessionId: record.id });
        const sessionRef = yield* encodeCommerceSessionReference(record.id).pipe(
          Effect.mapError((cause) => unavailable(SESSION_RECONCILE_OPERATION, cause)),
        );
        return {
          expiredAt: record.expiresAt,
          outcome: 'SESSION_EXPIRED',
          sessionRef,
        };
      }

      const activeCount = yield* store.countActive({
        absoluteLifetimeSeconds: COMMERCE_PORTAL_AUTH_SESSION_ABSOLUTE_LIFETIME_SECONDS,
        now,
        providerSubjectId: record.providerSubjectId,
      });
      const maxActiveSessions = COMMERCE_PORTAL_AUTH_SESSION_MAX_ACTIVE_SESSIONS;
      if (maxActiveSessions !== null && activeCount > maxActiveSessions) {
        const revoked = yield* store.revoke({ providerSubjectId: record.providerSubjectId, sessionId: record.id });
        if (!revoked) {
          return yield* unavailable('session-cap-reconciliation', 'New session disappeared');
        }
        // The concurrent-device cap, not the attempt throttle: the caller must end one of the
        // account's other sessions, so it must not be published as a retry-after-a-window refusal.
        return { outcome: 'SESSION_LIMIT_REACHED' };
      }

      const cappedExpiry = safeExpiry(record, now);
      if (epochMillis(cappedExpiry) < epochMillis(record.expiresAt)) {
        const touched = yield* store.touch({
          expectedUpdatedAt: record.updatedAt,
          expiresAt: cappedExpiry,
          now,
          sessionId: record.id,
        });
        if (Option.isSome(touched)) {
          return { outcome: 'SESSION_CREATED', session: yield* makeSnapshot(touched.value) };
        }
      }
      return { outcome: 'SESSION_CREATED', session: yield* makeSnapshot(record) };
    },
  );

  /** The provider cookies stay transport state: they leave here only for the response hook. */
  const signIn = Effect.fn('CommercePortalAuthSessionLifecycle.signIn')(function* signIn(
    input: Schema.Codec.Encoded<typeof CommercePortalAuthSignInInputSchema>,
  ): Effect.fn.Return<CommercePortalAuthSessionSignInResult, CommercePortalAuthSessionFailure> {
    const request = yield* Schema.decodeEffect(CommercePortalAuthSignInInputSchema)(input).pipe(
      Effect.mapError((cause) => invalidRequest(cause)),
    );
    const providerResult = yield* provider.signInEmail(request);
    if ('outcome' in providerResult) {
      return providerResult.outcome === 'MFA_REQUIRED'
        ? {
            outcome: { methods: providerResult.methods, outcome: 'MFA_REQUIRED' },
            setCookieHeaders: providerResult.setCookieHeaders,
          }
        : { outcome: providerResult, setCookieHeaders: [] };
    }
    const outcome = yield* admitProviderSession(providerResult.token);
    /**
     * Admission runs after the provider already minted its session cookie. Every rejection branch
     * revokes that provider session in the store, so forwarding its `Set-Cookie` would leave the
     * browser holding a credential this deployment just refused — and `getSession` would answer
     * `anonymous` for it on the next request. Only an admitted session hands its cookies onward.
     */
    return {
      outcome,
      setCookieHeaders: outcome.outcome === 'SESSION_CREATED' ? providerResult.setCookieHeaders : [],
    };
  });

  const revoke = Effect.fn('CommercePortalAuthSessionLifecycle.revoke')(function* revoke(
    input: Schema.Codec.Encoded<typeof CommercePortalAuthSessionReferenceInputSchema>,
  ): Effect.fn.Return<
    Extract<CommercePortalAuthSessionOutcome, { readonly outcome: 'SESSION_REVOKED' }>,
    CommercePortalAuthSessionFailure
  > {
    const request = yield* Schema.decodeEffect(CommercePortalAuthSessionReferenceInputSchema)(input).pipe(
      Effect.mapError((cause) => invalidRequest(cause)),
    );
    const sessionId = yield* parseSessionId(request);
    const recordOption = yield* store.findById(sessionId);
    if (Option.isSome(recordOption) && !expectedSubjectMatches(recordOption.value, request.expectedProviderSubjectId)) {
      return { existed: false, outcome: 'SESSION_REVOKED', sessionRef: request.sessionRef };
    }
    const revokeInput =
      request.expectedProviderSubjectId === undefined
        ? { sessionId }
        : { providerSubjectId: request.expectedProviderSubjectId, sessionId };
    const existed = yield* store.revoke(revokeInput);
    return { existed, outcome: 'SESSION_REVOKED', sessionRef: request.sessionRef };
  });

  const signOut = Effect.fn('CommercePortalAuthSessionLifecycle.signOut')(function* signOut(
    input: Schema.Codec.Encoded<typeof CommercePortalAuthSessionReferenceInputSchema>,
  ): Effect.fn.Return<
    Extract<CommercePortalAuthSessionOutcome, { readonly outcome: 'SESSION_REVOKED' }>,
    CommercePortalAuthSessionFailure
  > {
    return yield* revoke(input);
  });

  const refresh = Effect.fn('CommercePortalAuthSessionLifecycle.refresh')(function* refresh(
    input: Schema.Codec.Encoded<typeof CommercePortalAuthSessionReferenceInputSchema>,
  ): Effect.fn.Return<CommercePortalAuthSessionOutcome, CommercePortalAuthSessionFailure> {
    const request = yield* Schema.decodeEffect(CommercePortalAuthSessionReferenceInputSchema)(input).pipe(
      Effect.mapError((cause) => invalidRequest(cause)),
    );
    const sessionId = yield* parseSessionId(request);
    const recordOption = yield* store.findById(sessionId);
    if (Option.isNone(recordOption)) {
      return { existed: false, outcome: 'SESSION_REVOKED', sessionRef: request.sessionRef };
    }
    const record = recordOption.value;
    if (!expectedSubjectMatches(record, request.expectedProviderSubjectId)) {
      return { existed: false, outcome: 'SESSION_REVOKED', sessionRef: request.sessionRef };
    }
    const now = clock.now();
    const nowMillis = epochMillis(now);
    if (activeBan(record, nowMillis)) {
      return { outcome: 'ACCOUNT_DISABLED', providerSubjectId: record.providerSubjectId };
    }
    if (!isLive(record, nowMillis)) {
      return {
        expiredAt: record.expiresAt,
        outcome: 'SESSION_EXPIRED',
        sessionRef: request.sessionRef,
      };
    }

    const touched = yield* store.touch({
      expectedUpdatedAt: record.updatedAt,
      expiresAt: safeExpiry(record, now),
      now,
      sessionId,
    });
    if (Option.isSome(touched)) {
      return {
        identifierRotated: false,
        outcome: 'SESSION_REFRESHED',
        session: yield* makeSnapshot(touched.value),
      };
    }

    // Re-read once after a lost compare-and-set. A changed row is a concurrent refresh result;
    // a missing/denied row is a revoke/disable/expiry result. There is no blind update retry.
    const latestOption = yield* store.findById(sessionId);
    if (Option.isNone(latestOption)) {
      return { existed: false, outcome: 'SESSION_REVOKED', sessionRef: request.sessionRef };
    }
    const latest = latestOption.value;
    if (!expectedSubjectMatches(latest, request.expectedProviderSubjectId)) {
      return { existed: false, outcome: 'SESSION_REVOKED', sessionRef: request.sessionRef };
    }
    if (activeBan(latest, nowMillis)) {
      return { outcome: 'ACCOUNT_DISABLED', providerSubjectId: latest.providerSubjectId };
    }
    if (!isLive(latest, nowMillis)) {
      return { expiredAt: latest.expiresAt, outcome: 'SESSION_EXPIRED', sessionRef: request.sessionRef };
    }
    return {
      identifierRotated: false,
      outcome: 'SESSION_REFRESHED',
      session: yield* makeSnapshot(latest),
    };
  });

  const revokeAll = Effect.fn('CommercePortalAuthSessionLifecycle.revokeAll')(function* revokeAll(
    input: Schema.Codec.Encoded<typeof CommercePortalAuthAccountSubjectInputSchema>,
  ): Effect.fn.Return<number, CommercePortalAuthSessionFailure> {
    const request = yield* Schema.decodeEffect(CommercePortalAuthAccountSubjectInputSchema)(input).pipe(
      Effect.mapError((cause) => invalidRequest(cause)),
    );
    return yield* store.revokeAll(request.providerSubjectId);
  });

  const disableAccount = Effect.fn('CommercePortalAuthSessionLifecycle.disableAccount')(function* disableAccount(
    input: Schema.Codec.Encoded<typeof CommercePortalAuthAccountSubjectInputSchema>,
  ): Effect.fn.Return<
    Extract<CommercePortalAuthSessionOutcome, { readonly outcome: 'ACCOUNT_DISABLED' | 'AUTHENTICATION_FAILED' }>,
    CommercePortalAuthSessionFailure
  > {
    const request = yield* Schema.decodeEffect(CommercePortalAuthAccountSubjectInputSchema)(input).pipe(
      Effect.mapError((cause) => invalidRequest(cause)),
    );
    const changed = yield* store.disableAccount(request.providerSubjectId);
    return changed
      ? { outcome: 'ACCOUNT_DISABLED', providerSubjectId: request.providerSubjectId }
      : { outcome: 'AUTHENTICATION_FAILED' };
  });

  interface RotationExecution {
    readonly handoff?: CommercePortalAuthSessionCookieHandoff;
  }

  const rotateIdentifierResult = Effect.fn('CommercePortalAuthSessionLifecycle.rotateIdentifierResult')(
    function* rotateIdentifierResult(
      input: Schema.Codec.Encoded<typeof CommercePortalAuthSessionRotationInputSchema>,
    ): Effect.fn.Return<RotationExecution, CommercePortalAuthSessionFailure> {
      const request = yield* Schema.decodeEffect(CommercePortalAuthSessionRotationInputSchema)(input).pipe(
        Effect.mapError((cause) => invalidRequest(cause)),
      );
      if (!isRotationEnabled(request.reason)) {
        return yield* new CommercePortalAuthSessionRotationRejected({
          reason: `Session identifier rotation is disabled by ${COMMERCE_PORTAL_AUTH_SESSION_POLICY_VERSION}`,
        });
      }
      const sessionId = yield* parseSessionId(request);
      const recordOption = yield* store.findById(sessionId);
      if (Option.isNone(recordOption)) {
        return {};
      }
      const record = recordOption.value;
      if (!expectedSubjectMatches(record, request.expectedProviderSubjectId)) {
        return {};
      }
      const now = clock.now();
      const nowMillis = epochMillis(now);
      if (activeBan(record, nowMillis)) {
        return {};
      }
      if (!isLive(record, nowMillis)) {
        return {};
      }
      const rotateInput =
        request.expectedProviderSubjectId === undefined
          ? { expiresAt: safeExpiry(record, now), now, sessionId }
          : {
              expectedProviderSubjectId: request.expectedProviderSubjectId,
              expiresAt: safeExpiry(record, now),
              now,
              sessionId,
            };
      const replacementOption = yield* store.rotate(rotateInput);
      if (Option.isNone(replacementOption)) {
        return yield* new CommercePortalAuthSessionRefreshConflict({
          reason: 'Commerce portal session disappeared during identifier rotation',
        });
      }
      const replacement = replacementOption.value;
      if (replacement.token === undefined) {
        return yield* unavailable('session-rotation', 'Rotated session token was not available');
      }
      const session = yield* makeSnapshot(replacement);
      return {
        handoff: {
          previousSessionRef: request.sessionRef,
          providerToken: replacement.token,
          reason: request.reason,
          session,
        },
      };
    },
  );

  const rotateIdentifierForCookie = Effect.fn('CommercePortalAuthSessionLifecycle.rotateIdentifierForCookie')(
    function* rotateIdentifierForCookie(
      input: Schema.Codec.Encoded<typeof CommercePortalAuthSessionRotationInputSchema>,
    ): Effect.fn.Return<CommercePortalAuthSessionCookieHandoff, CommercePortalAuthSessionFailure> {
      const result = yield* rotateIdentifierResult(input);
      if (result.handoff === undefined) {
        return yield* new CommercePortalAuthSessionRefreshConflict({
          reason: 'Commerce portal session cannot be rotated for a cookie handoff',
        });
      }
      return result.handoff;
    },
  );

  const evidenceForSession = Effect.fn('CommercePortalAuthSessionLifecycle.evidenceForSession')(
    function* evidenceForSession(
      input: Schema.Codec.Encoded<typeof CommercePortalAuthSessionReferenceInputSchema>,
    ): Effect.fn.Return<CommercePortalAuthSessionEvidence, CommercePortalAuthSessionEvidenceFailure> {
      const decoded = yield* Schema.decodeEffect(CommercePortalAuthSessionReferenceInputSchema)(input).pipe(
        Effect.mapError((cause) => invalidRequest(cause)),
      );
      const sessionId = yield* parseSessionId(decoded);
      const recordOption = yield* store.findById(sessionId);
      if (Option.isNone(recordOption)) {
        return yield* evidenceRejected('Commerce portal session is not present for this subject');
      }
      const record = recordOption.value;
      if (!expectedSubjectMatches(record, decoded.expectedProviderSubjectId)) {
        return yield* evidenceRejected('Commerce portal session is not present for this subject');
      }
      const now = clock.now();
      const nowMillis = epochMillis(now);
      if (activeBan(record, nowMillis)) {
        return yield* evidenceRejected('Commerce portal account is disabled');
      }
      if (!isLive(record, nowMillis)) {
        return yield* evidenceRejected('Commerce portal session is expired or unverified');
      }
      const snapshot = yield* makeSnapshot(record).pipe(
        Effect.mapError((cause) => unavailable('session-evidence', cause)),
      );
      const evidence: CommercePortalAuthSessionEvidence = {
        ...snapshot,
        assurance: 'password',
        observedAt: now,
      };
      // Decode the final projection before handing it to a receiver adapter. This catches accidental
      // provider fields (especially token/cookie material) at the owner boundary.
      return yield* Schema.decodeEffect(CommercePortalAuthSessionEvidenceSchema)(evidence).pipe(
        Effect.mapError((cause) => unavailable('session-evidence', cause)),
      );
    },
  );

  return Object.freeze({
    disableAccount,
    evidenceForSession,
    refresh,
    revoke,
    revokeAll,
    rotateIdentifierForCookie,
    signIn,
    signOut,
  });
};

/** The store and provider ports stay visible requirements for the composition root. */
export const CommercePortalAuthSessionLifecycleLive = Layer.effect(
  CommercePortalAuthSessionLifecycle,
  Effect.gen(function* makeLifecycleLive() {
    const store = yield* CommercePortalAuthSessionStoreService;
    const provider = yield* CommercePortalAuthSessionProviderService;
    return makeCommercePortalAuthSessionLifecycle(store, provider);
  }),
);
