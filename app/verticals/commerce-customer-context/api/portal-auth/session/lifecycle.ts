import { DateTime, Effect, Match, Option, Schema } from 'effect';

import {
  COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  ExternalUserSubjectSchema,
} from '../../../shared/portal-auth-contracts.ts';
import { withCause } from '../problems-support.ts';
import { commercePortalAuthSessionOutcomeClass } from '../../../src/portal-auth/audit/audit-mapping.ts';
import { auditedLayer, commercePortalAuthAuditEmitter } from '../../../src/portal-auth/audit/audit.ts';
import type { CommercePortalAuthAuditRecorder } from '../../../src/portal-auth/audit/audit.ts';
import type {
  CommercePortalAuthAuditEvent,
  CommercePortalAuthAuditEventType,
} from '../../../src/portal-auth/audit/audit-contracts.ts';
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
const SESSION_REFRESHED_EVENT_TYPE: CommercePortalAuthAuditEventType = 'commerce.portal-auth.session-refreshed.v1';

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
      /**
       * The persisted fresh-authentication stamp, or `createdAt` for a row that has never been
       * re-authenticated — for such a row the two are the same instant. Reading `createdAt` alone
       * would be wrong after an identifier rotation, which preserves it on purpose so the absolute
       * session lifetime survives: a completed step-up would then never look recent.
       */
      authenticatedAt: record.authenticatedAt ?? record.createdAt,
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
    audit: CommercePortalAuthAuditRecorder,
    clock?: CommercePortalAuthSessionClock,
  ]
): CommercePortalAuthSessionLifecycleService => {
  const [store, provider, audit, clock = systemClock] = dependencies;
  const emitAudit = commercePortalAuthAuditEmitter(audit);
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

  /**
   * One revocation, one row. The row is written inside the store's own revoke transaction, so a
   * refused audit insert rolls the deletion back and this call fails instead of leaving a session
   * revoked with no evidence. The two branches that change nothing — a session owned by another
   * subject, and a session that was already gone — are decisions rather than state changes, so
   * their identical row is recorded through the lenient recorder.
   */
  const revokeSession = Effect.fn('CommercePortalAuthSessionLifecycle.revokeSession')(function* revokeSession(
    input: Schema.Codec.Encoded<typeof CommercePortalAuthSessionReferenceInputSchema>,
    eventType: CommercePortalAuthAuditEventType,
    operation: string,
  ): Effect.fn.Return<
    Extract<CommercePortalAuthSessionOutcome, { readonly outcome: 'SESSION_REVOKED' }>,
    CommercePortalAuthSessionFailure
  > {
    const request = yield* Schema.decodeEffect(CommercePortalAuthSessionReferenceInputSchema)(input).pipe(
      Effect.mapError((cause) => invalidRequest(cause)),
    );
    const sessionId = yield* parseSessionId(request);
    const auditEvent: CommercePortalAuthAuditEvent = {
      eventType,
      occurredAt: clock.now(),
      operation,
      outcome: 'success',
      providerSubjectId: request.expectedProviderSubjectId,
      sessionRef: request.sessionRef,
    };
    const recordOption = yield* store.findById(sessionId);
    if (Option.isSome(recordOption) && !expectedSubjectMatches(recordOption.value, request.expectedProviderSubjectId)) {
      yield* emitAudit(auditEvent);
      return { existed: false, outcome: 'SESSION_REVOKED', sessionRef: request.sessionRef };
    }
    const existed = yield* store.revokeWithAudit(
      request.expectedProviderSubjectId === undefined
        ? { audit: auditEvent, sessionId }
        : { audit: auditEvent, providerSubjectId: request.expectedProviderSubjectId, sessionId },
    );
    if (!existed) {
      yield* emitAudit(auditEvent);
    }
    return { existed, outcome: 'SESSION_REVOKED', sessionRef: request.sessionRef };
  });

  /** Owner-initiated revocation. Sign-out is the customer's own act and is audited separately. */
  const revoke = Effect.fn('CommercePortalAuthSessionLifecycle.revoke')(function* revoke(
    input: Schema.Codec.Encoded<typeof CommercePortalAuthSessionReferenceInputSchema>,
  ): Effect.fn.Return<
    Extract<CommercePortalAuthSessionOutcome, { readonly outcome: 'SESSION_REVOKED' }>,
    CommercePortalAuthSessionFailure
  > {
    return yield* revokeSession(input, 'commerce.portal-auth.session-revoked.v1', 'revoke');
  });

  /**
   * The sign-in compensation's deletion, and nothing else. It reaches the store's un-audited revoke
   * because its caller is already inside an audit outage: an audited revoke would ask the refusing
   * store for one more row, and PostgreSQL would roll the deletion back with it — leaving a live
   * credential whose creation nothing records. The attempt is not invisible either way, because the
   * intent row committed before Better Auth was ever asked for a session.
   */
  const revokeUnaudited = Effect.fn('CommercePortalAuthSessionLifecycle.revokeUnaudited')(function* revokeUnaudited(
    input: Schema.Codec.Encoded<typeof CommercePortalAuthSessionReferenceInputSchema>,
  ): Effect.fn.Return<boolean, CommercePortalAuthSessionFailure> {
    const request = yield* Schema.decodeEffect(CommercePortalAuthSessionReferenceInputSchema)(input).pipe(
      Effect.mapError((cause) => invalidRequest(cause)),
    );
    const sessionId = yield* parseSessionId(request);
    return yield* store.revoke(
      request.expectedProviderSubjectId === undefined
        ? { sessionId }
        : { providerSubjectId: request.expectedProviderSubjectId, sessionId },
    );
  });

  const signOut = Effect.fn('CommercePortalAuthSessionLifecycle.signOut')(function* signOut(
    input: Schema.Codec.Encoded<typeof CommercePortalAuthSessionReferenceInputSchema>,
  ): Effect.fn.Return<
    Extract<CommercePortalAuthSessionOutcome, { readonly outcome: 'SESSION_REVOKED' }>,
    CommercePortalAuthSessionFailure
  > {
    return yield* revokeSession(input, 'commerce.portal-auth.session-signed-out.v1', 'sign-out');
  });

  /**
   * `audited` is true only when the renewal committed its own row inside the store transaction.
   * Every other answer here is a decision that changed nothing, and `refresh` records those through
   * the lenient recorder — so a refresh leaves exactly one row either way.
   */
  interface RefreshExecution {
    readonly audited: boolean;
    readonly outcome: CommercePortalAuthSessionOutcome;
  }

  const refreshSession = Effect.fn('CommercePortalAuthSessionLifecycle.refreshSession')(function* refreshSession(
    input: Schema.Codec.Encoded<typeof CommercePortalAuthSessionReferenceInputSchema>,
  ): Effect.fn.Return<RefreshExecution, CommercePortalAuthSessionFailure> {
    const request = yield* Schema.decodeEffect(CommercePortalAuthSessionReferenceInputSchema)(input).pipe(
      Effect.mapError((cause) => invalidRequest(cause)),
    );
    const sessionId = yield* parseSessionId(request);
    const recordOption = yield* store.findById(sessionId);
    if (Option.isNone(recordOption)) {
      return {
        audited: false,
        outcome: { existed: false, outcome: 'SESSION_REVOKED', sessionRef: request.sessionRef },
      };
    }
    const record = recordOption.value;
    if (!expectedSubjectMatches(record, request.expectedProviderSubjectId)) {
      return {
        audited: false,
        outcome: { existed: false, outcome: 'SESSION_REVOKED', sessionRef: request.sessionRef },
      };
    }
    const now = clock.now();
    const nowMillis = epochMillis(now);
    if (activeBan(record, nowMillis)) {
      return { audited: false, outcome: { outcome: 'ACCOUNT_DISABLED', providerSubjectId: record.providerSubjectId } };
    }
    if (!isLive(record, nowMillis)) {
      return {
        audited: false,
        outcome: {
          expiredAt: record.expiresAt,
          outcome: 'SESSION_EXPIRED',
          sessionRef: request.sessionRef,
        },
      };
    }

    const touched = yield* store.touchWithAudit({
      audit: {
        eventType: SESSION_REFRESHED_EVENT_TYPE,
        occurredAt: now,
        operation: 'refresh',
        outcome: 'success',
        providerSubjectId: record.providerSubjectId,
        sessionRef: request.sessionRef,
      },
      expectedUpdatedAt: record.updatedAt,
      expiresAt: safeExpiry(record, now),
      now,
      sessionId,
    });
    if (Option.isSome(touched)) {
      return {
        audited: true,
        outcome: {
          identifierRotated: false,
          outcome: 'SESSION_REFRESHED',
          session: yield* makeSnapshot(touched.value),
        },
      };
    }

    // Re-read once after a lost compare-and-set. A changed row is a concurrent refresh result;
    // a missing/denied row is a revoke/disable/expiry result. There is no blind update retry.
    const latestOption = yield* store.findById(sessionId);
    if (Option.isNone(latestOption)) {
      return {
        audited: false,
        outcome: { existed: false, outcome: 'SESSION_REVOKED', sessionRef: request.sessionRef },
      };
    }
    const latest = latestOption.value;
    if (!expectedSubjectMatches(latest, request.expectedProviderSubjectId)) {
      return {
        audited: false,
        outcome: { existed: false, outcome: 'SESSION_REVOKED', sessionRef: request.sessionRef },
      };
    }
    if (activeBan(latest, nowMillis)) {
      return { audited: false, outcome: { outcome: 'ACCOUNT_DISABLED', providerSubjectId: latest.providerSubjectId } };
    }
    if (!isLive(latest, nowMillis)) {
      return {
        audited: false,
        outcome: { expiredAt: latest.expiresAt, outcome: 'SESSION_EXPIRED', sessionRef: request.sessionRef },
      };
    }
    // A concurrent refresh already renewed this row and committed its own evidence; this answer
    // observes that result rather than producing it, so it is recorded as a decision.
    return {
      audited: false,
      outcome: {
        identifierRotated: false,
        outcome: 'SESSION_REFRESHED',
        session: yield* makeSnapshot(latest),
      },
    };
  });

  /** Every refresh answer is evidence: a renewal, a disabled account, an expiry and a revocation. */
  const refresh = Effect.fn('CommercePortalAuthSessionLifecycle.refresh')(function* refresh(
    input: Schema.Codec.Encoded<typeof CommercePortalAuthSessionReferenceInputSchema>,
  ): Effect.fn.Return<CommercePortalAuthSessionOutcome, CommercePortalAuthSessionFailure> {
    const result = yield* refreshSession(input);
    if (!result.audited) {
      yield* emitAudit({
        eventType: SESSION_REFRESHED_EVENT_TYPE,
        occurredAt: clock.now(),
        operation: 'refresh',
        outcome: commercePortalAuthSessionOutcomeClass(result.outcome.outcome),
        providerSubjectId: result.outcome.outcome === 'ACCOUNT_DISABLED' ? result.outcome.providerSubjectId : undefined,
        sessionRef: input.sessionRef,
      });
    }
    return result.outcome;
  });

  /**
   * Account-wide revocation: sign-out everywhere, and the session clear-down a completed password
   * reset performs. The evidence row commits with the deletions or not at all.
   */
  const revokeAll = Effect.fn('CommercePortalAuthSessionLifecycle.revokeAll')(function* revokeAll(
    input: Schema.Codec.Encoded<typeof CommercePortalAuthAccountSubjectInputSchema>,
  ): Effect.fn.Return<number, CommercePortalAuthSessionFailure> {
    const request = yield* Schema.decodeEffect(CommercePortalAuthAccountSubjectInputSchema)(input).pipe(
      Effect.mapError((cause) => invalidRequest(cause)),
    );
    const auditEvent: CommercePortalAuthAuditEvent = {
      eventType: 'commerce.portal-auth.session-revoked.v1',
      occurredAt: clock.now(),
      operation: 'revoke-all',
      outcome: 'success',
      providerSubjectId: request.providerSubjectId,
    };
    const revoked = yield* store.revokeAllWithAudit({
      audit: auditEvent,
      providerSubjectId: request.providerSubjectId,
    });
    if (revoked === 0) {
      yield* emitAudit(auditEvent);
    }
    return revoked;
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
    const changed = yield* store.disableAccountWithAudit({
      audit: {
        eventType: 'commerce.portal-auth.account-disabled.v1',
        occurredAt: clock.now(),
        operation: 'disable-account',
        outcome: 'account_disabled',
        providerSubjectId: request.providerSubjectId,
      },
      providerSubjectId: request.providerSubjectId,
    });
    if (!changed) {
      // Nothing was disabled, so there is no transaction to join: the refusal is a decision.
      yield* emitAudit({
        eventType: 'commerce.portal-auth.account-disabled.v1',
        occurredAt: clock.now(),
        operation: 'disable-account',
        outcome: 'authentication_failed',
        providerSubjectId: request.providerSubjectId,
      });
    }
    return changed
      ? { outcome: 'ACCOUNT_DISABLED', providerSubjectId: request.providerSubjectId }
      : { outcome: 'AUTHENTICATION_FAILED' };
  });

  interface RotationExecution {
    readonly handoff?: CommercePortalAuthSessionCookieHandoff;
  }

  type MutableRotateInput = {
    -readonly [Key in keyof Parameters<CommercePortalAuthSessionStore['rotateWithAudit']>[0]]: Parameters<
      CommercePortalAuthSessionStore['rotateWithAudit']
    >[0][Key];
  };

  const rotateIdentifierResult = Effect.fn('CommercePortalAuthSessionLifecycle.rotateIdentifierResult')(
    function* rotateIdentifierResult(
      input: Schema.Codec.Encoded<typeof CommercePortalAuthSessionRotationInputSchema>,
      completion?: CommercePortalAuthAuditEvent,
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
      const rotateInput: MutableRotateInput = {
        audit: {
          eventType: SESSION_REFRESHED_EVENT_TYPE,
          occurredAt: now,
          operation: 'rotate-identifier',
          outcome: 'success',
          providerSubjectId: record.providerSubjectId,
          sessionRef: request.sessionRef,
        },
        expiresAt: safeExpiry(record, now),
        now,
        sessionId,
      };
      if (completion !== undefined) {
        rotateInput.completion = completion;
      }
      if (request.expectedProviderSubjectId !== undefined) {
        rotateInput.expectedProviderSubjectId = request.expectedProviderSubjectId;
      }
      /**
       * A completed step-up is a fresh authentication, and it is the only rotation reason that
       * is. Stamping the replacement row is what lets the owner's freshness gates see it: the
       * rotation preserves `createdAt` so the absolute lifetime survives, which by itself would
       * keep an old session permanently stale no matter how the customer re-proved themselves.
       */
      if (request.reason === 'step-up') {
        rotateInput.authenticatedAt = now;
      }
      const replacementOption = yield* store.rotateWithAudit(rotateInput);
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
      completion?: CommercePortalAuthAuditEvent,
    ): Effect.fn.Return<CommercePortalAuthSessionCookieHandoff, CommercePortalAuthSessionFailure> {
      const result = yield* rotateIdentifierResult(input, completion);
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
    revokeUnaudited,
    rotateIdentifierForCookie,
    signIn,
    signOut,
  });
};

/** The store and provider ports stay visible requirements for the composition root. */
export const CommercePortalAuthSessionLifecycleLive = auditedLayer(
  CommercePortalAuthSessionLifecycle,
  Effect.fn('CommercePortalAuthSessionLifecycle.live')(function* makeLifecycleLive(
    audit: CommercePortalAuthAuditRecorder,
  ): Effect.fn.Return<
    CommercePortalAuthSessionLifecycleService,
    never,
    CommercePortalAuthSessionProviderService | CommercePortalAuthSessionStoreService
  > {
    const store = yield* CommercePortalAuthSessionStoreService;
    const provider = yield* CommercePortalAuthSessionProviderService;
    return makeCommercePortalAuthSessionLifecycle(store, provider, audit);
  }),
);
