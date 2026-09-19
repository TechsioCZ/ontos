import { Effect, Option, Redacted, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../../api/portal-auth/provider/config.ts';
import type { CommercePortalAuthAuditEvent } from '../../src/portal-auth/audit/audit-contracts.ts';
import type {
  CommercePortalAuthProviderSignInResult,
  CommercePortalAuthSessionRecord,
} from '../../api/portal-auth/session/contracts.ts';
import { makeCommercePortalAuthSessionLifecycle } from '../../api/portal-auth/session/lifecycle.ts';
import type { CommercePortalAuthSessionProvider } from '../../api/portal-auth/session/lifecycle.ts';
import type { CommercePortalAuthSessionStore } from '../../api/portal-auth/session/store-service.ts';
import {
  CommercePortalAuthSessionEvidenceRejected,
  CommercePortalAuthSessionInvalidRequest,
  CommercePortalAuthSessionUnavailable,
} from '../../api/portal-auth/session/errors.ts';
import { unauditedCommercePortalAuthRecorder } from '../../src/portal-auth/audit/audit.ts';

const now = new Date('2026-01-01T00:00:00.000Z');
const userId = 'commerce-user-1';
const tokenA = 'provider-token-a';
const tokenB = 'provider-token-b';

const record = (
  id: string,
  token: string,
  overrides: Partial<CommercePortalAuthSessionRecord> = {},
): CommercePortalAuthSessionRecord => ({
  authenticatedAt: null,
  banExpiresAt: null,
  banned: false,
  createdAt: new Date(now.getTime() - 60_000),
  emailVerified: true,
  expiresAt: new Date(now.getTime() + 3_600_000),
  id,
  providerSubjectId: userId,
  token,
  updatedAt: new Date(now.getTime() - 60_000),
  ...overrides,
});

/**
 * The in-memory stand-in for the store's transaction: `rejectAudit` makes the audit write fail, and
 * every audited method checks it *before* touching `sessions`. A state change that cannot leave
 * evidence must not be observable afterwards — which is exactly what PostgreSQL's rollback gives
 * the real store.
 */
interface MemoryStoreAudit {
  readonly committed: CommercePortalAuthAuditEvent[];
  rejectAudit: boolean;
}

const makeMemoryStoreAudit = (): MemoryStoreAudit => ({ committed: [], rejectAudit: false });

const memoryStore = (
  initial: readonly CommercePortalAuthSessionRecord[],
  audit: MemoryStoreAudit = makeMemoryStoreAudit(),
): CommercePortalAuthSessionStore => {
  const sessions = new Map(initial.map((value) => [value.id, value]));
  const byId = (id: string) => sessions.get(id) ?? null;
  const byToken = (token: string) => [...sessions.values()].find((value) => value.token === token) ?? null;
  const commitAudit = (event: CommercePortalAuthAuditEvent, operation: string) =>
    audit.rejectAudit
      ? Effect.fail(
          new CommercePortalAuthSessionUnavailable({
            operation: `${operation}-audit`,
            reason: 'audit evidence could not be persisted',
          }),
        )
      : Effect.sync(() => {
          audit.committed.push(event);
        });
  return {
    countActive: ({ absoluteLifetimeSeconds, now: clockNow, providerSubjectId }) =>
      Effect.sync(
        () =>
          [...sessions.values()].filter((value) => {
            const createdAt = value.createdAt.getTime();
            return (
              value.providerSubjectId === providerSubjectId &&
              createdAt <= clockNow.getTime() &&
              createdAt + absoluteLifetimeSeconds * 1000 > clockNow.getTime() &&
              value.expiresAt.getTime() > clockNow.getTime()
            );
          }).length,
      ),
    disableAccountWithAudit: ({ audit: event, providerSubjectId }) =>
      Effect.gen(function* disableAccountWithAuditEffect() {
        const matching = [...sessions.values()].filter((value) => value.providerSubjectId === providerSubjectId);
        if (matching.length === 0) {
          return false;
        }
        yield* commitAudit(event, 'account-disable');
        for (const value of matching) {
          sessions.delete(value.id);
        }
        return true;
      }),
    findById: (id) =>
      Effect.sync(() => {
        const value = byId(id);
        return value === null ? Option.none() : Option.some(value);
      }),
    findByToken: (token) =>
      Effect.sync(() => {
        const value = byToken(token);
        return value === null ? Option.none() : Option.some(value);
      }),
    revoke: ({ providerSubjectId, sessionId }) =>
      Effect.sync(() => {
        const current = byId(sessionId);
        if (current === null || (providerSubjectId !== undefined && current.providerSubjectId !== providerSubjectId)) {
          return false;
        }
        sessions.delete(sessionId);
        return true;
      }),
    revokeAllWithAudit: ({ audit: event, providerSubjectId }) =>
      Effect.gen(function* revokeAllWithAuditEffect() {
        const matching = [...sessions.values()].filter((value) => value.providerSubjectId === providerSubjectId);
        if (matching.length === 0) {
          return 0;
        }
        yield* commitAudit(event, 'session-revoke-all');
        for (const value of matching) {
          sessions.delete(value.id);
        }
        return matching.length;
      }),
    revokeWithAudit: ({ audit: event, providerSubjectId, sessionId }) =>
      Effect.gen(function* revokeWithAuditEffect() {
        const current = byId(sessionId);
        if (current === null || (providerSubjectId !== undefined && current.providerSubjectId !== providerSubjectId)) {
          return false;
        }
        yield* commitAudit(event, 'session-revoke');
        sessions.delete(sessionId);
        return true;
      }),
    rotateWithAudit: ({
      audit: event,
      authenticatedAt,
      expectedProviderSubjectId,
      expiresAt,
      now: clockNow,
      sessionId,
    }) =>
      Effect.gen(function* rotateWithAuditEffect() {
        const current = byId(sessionId);
        if (
          current === null ||
          (expectedProviderSubjectId !== undefined && current.providerSubjectId !== expectedProviderSubjectId)
        ) {
          return Option.none<CommercePortalAuthSessionRecord>();
        }
        yield* commitAudit(event, 'session-rotation');
        const replacement = {
          ...current,
          // The replacement keeps `createdAt`, so only a rotation that re-authenticated the
          // customer moves the fresh-authentication stamp forward.
          authenticatedAt: authenticatedAt ?? current.authenticatedAt,
          expiresAt,
          id: `${current.id}-rotated`,
          token: `${current.token}-rotated`,
          updatedAt: clockNow,
        };
        sessions.delete(sessionId);
        sessions.set(replacement.id, replacement);
        return Option.some(replacement);
      }),
    touch: ({ expectedUpdatedAt, expiresAt, now: clockNow, sessionId }) =>
      Effect.sync(() => {
        const current = byId(sessionId);
        if (
          current === null ||
          current.updatedAt.getTime() !== expectedUpdatedAt.getTime() ||
          current.expiresAt.getTime() <= clockNow.getTime()
        ) {
          return Option.none();
        }
        const updated = { ...current, expiresAt, updatedAt: clockNow };
        sessions.set(sessionId, updated);
        return Option.some(updated);
      }),
    touchWithAudit: ({ audit: event, expectedUpdatedAt, expiresAt, now: clockNow, sessionId }) =>
      Effect.gen(function* touchWithAuditEffect() {
        const current = byId(sessionId);
        if (
          current === null ||
          current.updatedAt.getTime() !== expectedUpdatedAt.getTime() ||
          current.expiresAt.getTime() <= clockNow.getTime()
        ) {
          return Option.none<CommercePortalAuthSessionRecord>();
        }
        yield* commitAudit(event, 'session-touch');
        const updated = { ...current, expiresAt, updatedAt: clockNow };
        sessions.set(sessionId, updated);
        return Option.some(updated);
      }),
  };
};

/** Collects what the lenient recorder was handed, so the two audit paths stay distinguishable. */
const recordingRecorder = () => {
  const recorded: CommercePortalAuthAuditEvent[] = [];
  return {
    recorded,
    recorder: {
      record: (event: CommercePortalAuthAuditEvent) =>
        Effect.sync(() => {
          recorded.push(event);
        }),
    },
  };
};

const signInCookie = 'commerce-portal.session_token=provider-cookie; Path=/; HttpOnly';

const providerFor = (
  token: string,
  result?: CommercePortalAuthProviderSignInResult,
): CommercePortalAuthSessionProvider => ({
  signInEmail: () => Effect.succeed(result ?? { setCookieHeaders: [signInCookie], token }),
});

const ref = (id: string) => `better-auth-session:${COMMERCE_AUTHENTICATION_NAMESPACE_ID}:${id}`;

it('keeps the Commerce policy explicit and provider signup outside the public session routes', () => {
  expect(COMMERCE_PORTAL_AUTH_POLICY.policyVersion).toBe('commerce-portal-auth-policy.v1');
  expect(COMMERCE_PORTAL_AUTH_POLICY.session.concurrentDevice).toEqual({
    maxActiveSessions: 5,
    overflow: 'reject-new',
  });
  expect(COMMERCE_PORTAL_AUTH_POLICY.session.absoluteLifetimeSeconds).toBe(86_400);
});

it.effect('creates safe session evidence and never returns the provider token', () => {
  const service = makeCommercePortalAuthSessionLifecycle(
    memoryStore([record('session-a', tokenA)]),
    providerFor(tokenA),
    unauditedCommercePortalAuthRecorder,
    { now: () => now },
  );
  return service.signIn({ email: 'buyer@example.test', password: Redacted.make('P'.repeat(24)) }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        // The provider cookies travel beside the outcome so the transport can forward them; they
        // must never become part of the outcome the caller observes.
        expect(result.setCookieHeaders).toEqual([signInCookie]);
        const { outcome } = result;
        expect(outcome.outcome).toBe('SESSION_CREATED');
        if (outcome.outcome !== 'SESSION_CREATED') {
          throw new Error('Expected a created session');
        }
        expect(outcome.session.sessionRef).toBe(ref('session-a'));
        expect('token' in outcome).toBe(false);
        expect('setCookieHeaders' in outcome).toBe(false);
        expect('token' in outcome.session).toBe(false);
      }),
    ),
  );
});

it.effect('passes a pending second factor through without admitting a session', () => {
  const service = makeCommercePortalAuthSessionLifecycle(
    memoryStore([record('session-a', tokenA)]),
    providerFor(tokenA, {
      methods: ['totp', 'otp'],
      outcome: 'MFA_REQUIRED',
      setCookieHeaders: [signInCookie],
    }),
    unauditedCommercePortalAuthRecorder,
    { now: () => now },
  );
  return service.signIn({ email: 'buyer@example.test', password: Redacted.make('P'.repeat(24)) }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result.setCookieHeaders).toEqual([signInCookie]);
        const { outcome } = result;
        expect(outcome.outcome).toBe('MFA_REQUIRED');
        if (outcome.outcome !== 'MFA_REQUIRED') {
          throw new Error('Expected a pending second factor');
        }
        expect(outcome.methods).toEqual(['totp', 'otp']);
        expect('session' in outcome).toBe(false);
        expect('setCookieHeaders' in outcome).toBe(false);
      }),
    ),
  );
});

it.effect('reports a provider rejection without any provider cookie', () =>
  makeCommercePortalAuthSessionLifecycle(
    memoryStore([record('session-a', tokenA)]),
    providerFor(tokenA, { outcome: 'AUTHENTICATION_FAILED' }),
    unauditedCommercePortalAuthRecorder,
    { now: () => now },
  )
    .signIn({ email: 'buyer@example.test', password: Redacted.make('P'.repeat(24)) })
    .pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.setCookieHeaders).toEqual([]);
          expect(result.outcome.outcome).toBe('AUTHENTICATION_FAILED');
        }),
      ),
    ),
);

it.effect('withholds the provider cookie when admission rejects a session the provider already minted', () =>
  Effect.gen(function* rejectedAdmissionCookies() {
    const banned = memoryStore([record('session-a', tokenA, { banned: true })]);
    const disabled = yield* makeCommercePortalAuthSessionLifecycle(
      banned,
      providerFor(tokenA),
      unauditedCommercePortalAuthRecorder,
      {
        now: () => now,
      },
    ).signIn({ email: 'buyer@example.test', password: Redacted.make('P'.repeat(24)) });
    expect(disabled.outcome.outcome).toBe('ACCOUNT_DISABLED');
    // Admission revoked the durable session, so the browser must not keep the provider's cookie.
    expect(disabled.setCookieHeaders).toEqual([]);
    expect(yield* banned.findByToken(tokenA)).toStrictEqual(Option.none());

    const unverified = memoryStore([record('session-b', tokenB, { emailVerified: false })]);
    const pending = yield* makeCommercePortalAuthSessionLifecycle(
      unverified,
      providerFor(tokenB),
      unauditedCommercePortalAuthRecorder,
      {
        now: () => now,
      },
    ).signIn({ email: 'buyer@example.test', password: Redacted.make('P'.repeat(24)) });
    expect(pending.outcome.outcome).toBe('VERIFICATION_REQUIRED');
    expect(pending.setCookieHeaders).toEqual([]);

    // The admitted path still hands the provider cookie to the transport.
    const admitted = yield* makeCommercePortalAuthSessionLifecycle(
      memoryStore([record('session-c', tokenA)]),
      providerFor(tokenA),
      unauditedCommercePortalAuthRecorder,
      { now: () => now },
    ).signIn({ email: 'buyer@example.test', password: Redacted.make('P'.repeat(24)) });
    expect(admitted.outcome.outcome).toBe('SESSION_CREATED');
    expect(admitted.setCookieHeaders).toEqual([signInCookie]);
  }),
);

it.effect('refreshes inactivity only inside the absolute lifetime and rejects expired sessions', () => {
  let clockNow = new Date(now);
  const service = makeCommercePortalAuthSessionLifecycle(
    memoryStore([record('session-a', tokenA)]),
    providerFor(tokenA),
    unauditedCommercePortalAuthRecorder,
    { now: () => clockNow },
  );
  return service.refresh({ expectedProviderSubjectId: userId, sessionRef: ref('session-a') }).pipe(
    Effect.flatMap((refreshed) =>
      Effect.gen(function* refreshThenExpire() {
        expect(refreshed.outcome).toBe('SESSION_REFRESHED');
        clockNow = new Date(now.getTime() + COMMERCE_PORTAL_AUTH_POLICY.session.absoluteLifetimeSeconds * 1000 + 1);
        const expired = yield* service.refresh({ expectedProviderSubjectId: userId, sessionRef: ref('session-a') });
        expect(expired.outcome).toBe('SESSION_EXPIRED');
      }),
    ),
  );
});

it.effect('rotates identifiers at a privilege boundary and revokes only the selected session', () => {
  const service = makeCommercePortalAuthSessionLifecycle(
    memoryStore([record('session-a', tokenA), record('session-b', tokenB)]),
    providerFor(tokenA),
    unauditedCommercePortalAuthRecorder,
    { now: () => now },
  );
  return Effect.gen(function* lifecycleAssertions() {
    const rotated = yield* service.rotateIdentifierForCookie({
      expectedProviderSubjectId: userId,
      reason: 'privilege-boundary',
      sessionRef: ref('session-a'),
    });
    expect(rotated.session.sessionRef).not.toBe(ref('session-a'));
    expect(rotated.providerToken).toBe(`${tokenA}-rotated`);
    const oldEvidence = yield* Effect.flip(
      service.evidenceForSession({ expectedProviderSubjectId: userId, sessionRef: ref('session-a') }),
    );
    expect(Schema.is(CommercePortalAuthSessionEvidenceRejected)(oldEvidence)).toBe(true);
    const revoked = yield* service.revoke({ expectedProviderSubjectId: userId, sessionRef: ref('session-b') });
    expect(revoked).toEqual({ existed: true, outcome: 'SESSION_REVOKED', sessionRef: ref('session-b') });
  });
});

it.effect('contains account disable to the Commerce provider realm', () => {
  const store = memoryStore([record('session-a', tokenA), record('session-b', tokenB)]);
  const service = makeCommercePortalAuthSessionLifecycle(
    store,
    providerFor(tokenA),
    unauditedCommercePortalAuthRecorder,
    { now: () => now },
  );
  return service.disableAccount({ providerSubjectId: userId }).pipe(
    Effect.flatMap((disabled) =>
      Effect.gen(function* disabledAssertions() {
        expect(disabled.outcome).toBe('ACCOUNT_DISABLED');
        const first = yield* service.refresh({ expectedProviderSubjectId: userId, sessionRef: ref('session-a') });
        const second = yield* service.refresh({ expectedProviderSubjectId: userId, sessionRef: ref('session-b') });
        expect(first.outcome).toBe('SESSION_REVOKED');
        expect(second.outcome).toBe('SESSION_REVOKED');
      }),
    ),
  );
});

it.effect('does not blind retry a concurrent refresh after the compare-and-set loses', () => {
  const initial = record('session-a', tokenA);
  const service = makeCommercePortalAuthSessionLifecycle(
    memoryStore([initial]),
    providerFor(tokenA),
    unauditedCommercePortalAuthRecorder,
    {
      now: () => now,
    },
  );
  return Effect.all([
    service.refresh({ expectedProviderSubjectId: userId, sessionRef: ref('session-a') }),
    service.refresh({ expectedProviderSubjectId: userId, sessionRef: ref('session-a') }),
  ]).pipe(
    Effect.tap((outcomes) =>
      Effect.sync(() => {
        expect(outcomes.every((outcome) => outcome.outcome === 'SESSION_REFRESHED')).toBe(true);
        expect(outcomes.every((outcome) => outcome.outcome !== 'SESSION_IDENTIFIER_ROTATED')).toBe(true);
      }),
    ),
  );
});

it.effect('never commits a state change whose audit row was refused', () =>
  Effect.gen(function* strictAuditPath() {
    const audit = makeMemoryStoreAudit();
    const store = memoryStore([record('session-a', tokenA), record('session-b', tokenB)], audit);
    const { recorded, recorder } = recordingRecorder();
    const service = makeCommercePortalAuthSessionLifecycle(store, providerFor(tokenA), recorder, { now: () => now });

    audit.rejectAudit = true;
    const revoked = yield* Effect.result(
      service.revoke({ expectedProviderSubjectId: userId, sessionRef: ref('session-a') }),
    );
    if (!Result.isFailure(revoked)) {
      throw new Error('A revoke whose evidence was refused must not report success');
    }
    expect(Schema.is(CommercePortalAuthSessionUnavailable)(revoked.failure)).toBe(true);
    // The whole point: the state change rolled back with its evidence.
    expect(Option.isSome(yield* store.findById('session-a'))).toBe(true);
    expect(audit.committed).toHaveLength(0);
    // A refused *state change* must not be quietly downgraded to a lenient log line either.
    expect(recorded).toHaveLength(0);

    const disabled = yield* Effect.result(service.disableAccount({ providerSubjectId: userId }));
    expect(Result.isFailure(disabled)).toBe(true);
    expect(Option.isSome(yield* store.findById('session-b'))).toBe(true);

    const refreshed = yield* Effect.result(
      service.refresh({ expectedProviderSubjectId: userId, sessionRef: ref('session-a') }),
    );
    expect(Result.isFailure(refreshed)).toBe(true);

    const rotated = yield* Effect.result(
      service.rotateIdentifierForCookie({
        expectedProviderSubjectId: userId,
        reason: 'step-up',
        sessionRef: ref('session-a'),
      }),
    );
    expect(Result.isFailure(rotated)).toBe(true);
    expect(Option.isSome(yield* store.findById('session-a'))).toBe(true);

    // With the audit store healthy the same calls commit exactly one row each, transactionally.
    audit.rejectAudit = false;
    yield* service.revoke({ expectedProviderSubjectId: userId, sessionRef: ref('session-a') });
    expect(Option.isNone(yield* store.findById('session-a'))).toBe(true);
    expect(audit.committed.map((event) => [event.eventType, event.operation, event.outcome])).toStrictEqual([
      ['commerce.portal-auth.session-revoked.v1', 'revoke', 'success'],
    ]);
    expect(recorded).toHaveLength(0);
  }),
);

it.effect('keeps decision-only evidence on the lenient recorder, which an outage cannot fail', () =>
  Effect.gen(function* lenientAuditPath() {
    const audit = makeMemoryStoreAudit();
    const store = memoryStore([record('session-a', tokenA)], audit);
    const { recorded, recorder } = recordingRecorder();
    const service = makeCommercePortalAuthSessionLifecycle(store, providerFor(tokenA), recorder, { now: () => now });

    // Nothing to revoke: no transaction to join, so the decision goes to the lenient recorder.
    audit.rejectAudit = true;
    const missing = yield* service.signOut({ expectedProviderSubjectId: userId, sessionRef: ref('session-missing') });
    expect(missing).toStrictEqual({ existed: false, outcome: 'SESSION_REVOKED', sessionRef: ref('session-missing') });
    // A session owned by someone else is the same shape of non-event.
    const foreign = yield* service.revoke({ expectedProviderSubjectId: 'other-user', sessionRef: ref('session-a') });
    expect(foreign.existed).toBe(false);
    const absentAccount = yield* service.disableAccount({ providerSubjectId: 'other-user' });
    expect(absentAccount.outcome).toBe('AUTHENTICATION_FAILED');
    const nothingToRevoke = yield* service.revokeAll({ providerSubjectId: 'other-user' });
    expect(nothingToRevoke).toBe(0);

    expect(audit.committed).toHaveLength(0);
    expect(recorded.map((event) => [event.eventType, event.operation, event.outcome])).toStrictEqual([
      ['commerce.portal-auth.session-signed-out.v1', 'sign-out', 'success'],
      ['commerce.portal-auth.session-revoked.v1', 'revoke', 'success'],
      ['commerce.portal-auth.account-disabled.v1', 'disable-account', 'authentication_failed'],
      ['commerce.portal-auth.session-revoked.v1', 'revoke-all', 'success'],
    ]);
    // The session the foreign revoke named is still there: a refused decision changed nothing.
    expect(Option.isSome(yield* store.findById('session-a'))).toBe(true);
  }),
);

it.effect('moves the fresh-authentication stamp only when the rotation re-authenticated the customer', () =>
  Effect.gen(function* rotationFreshness() {
    const store = memoryStore([record('session-a', tokenA), record('session-b', tokenB)]);
    const service = makeCommercePortalAuthSessionLifecycle(
      store,
      providerFor(tokenA),
      unauditedCommercePortalAuthRecorder,
      { now: () => now },
    );

    const steppedUp = yield* service.rotateIdentifierForCookie({
      expectedProviderSubjectId: userId,
      reason: 'step-up',
      sessionRef: ref('session-a'),
    });
    // `createdAt` is preserved so the absolute lifetime survives; the stamp is what moved.
    expect(steppedUp.session.createdAt).toStrictEqual(new Date(now.getTime() - 60_000));
    expect(steppedUp.session.authenticatedAt).toStrictEqual(now);

    const boundary = yield* service.rotateIdentifierForCookie({
      expectedProviderSubjectId: userId,
      reason: 'privilege-boundary',
      sessionRef: ref('session-b'),
    });
    // A privilege-boundary rotation proves nothing new about the customer, so a session that was
    // never re-authenticated still answers its creation time.
    expect(boundary.session.authenticatedAt).toStrictEqual(new Date(now.getTime() - 60_000));

    // The step-up on `session-a` never reached the other session.
    const other = yield* store.findById('session-b-rotated');
    expect(Option.isSome(other)).toBe(true);
    expect(Option.isSome(other) ? other.value.authenticatedAt : 'missing').toBeNull();
  }),
);

it.effect('rejects malformed or cross-subject safe references before provider state use', () => {
  const service = makeCommercePortalAuthSessionLifecycle(
    memoryStore([record('session-a', tokenA)]),
    providerFor(tokenA),
    unauditedCommercePortalAuthRecorder,
    {
      now: () => now,
    },
  );
  return Effect.gen(function* invalidAssertions() {
    const malformed = yield* Effect.flip(service.evidenceForSession({ sessionRef: 'provider-token-a' }));
    expect(Schema.is(CommercePortalAuthSessionInvalidRequest)(malformed)).toBe(true);
    const mismatched = yield* Effect.flip(
      service.evidenceForSession({ expectedProviderSubjectId: 'other-user', sessionRef: ref('session-a') }),
    );
    expect(Schema.is(CommercePortalAuthSessionEvidenceRejected)(mismatched)).toBe(true);
  });
});
