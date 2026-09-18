import { Effect, Option, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../../api/portal-auth/provider/config.ts';
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
} from '../../api/portal-auth/session/errors.ts';

const now = new Date('2026-01-01T00:00:00.000Z');
const userId = 'commerce-user-1';
const tokenA = 'provider-token-a';
const tokenB = 'provider-token-b';

const record = (
  id: string,
  token: string,
  overrides: Partial<CommercePortalAuthSessionRecord> = {},
): CommercePortalAuthSessionRecord => ({
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

const memoryStore = (initial: readonly CommercePortalAuthSessionRecord[]): CommercePortalAuthSessionStore => {
  const sessions = new Map(initial.map((value) => [value.id, value]));
  const byId = (id: string) => sessions.get(id) ?? null;
  const byToken = (token: string) => [...sessions.values()].find((value) => value.token === token) ?? null;
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
    disableAccount: (providerSubjectId) =>
      Effect.sync(() => {
        const matching = [...sessions.values()].filter((value) => value.providerSubjectId === providerSubjectId);
        for (const value of matching) {
          sessions.delete(value.id);
        }
        return matching.length > 0;
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
    revokeAll: (providerSubjectId) =>
      Effect.sync(() => {
        const matching = [...sessions.values()].filter((value) => value.providerSubjectId === providerSubjectId);
        for (const value of matching) {
          sessions.delete(value.id);
        }
        return matching.length;
      }),
    rotate: ({ expectedProviderSubjectId, expiresAt, now: clockNow, sessionId }) =>
      Effect.sync(() => {
        const current = byId(sessionId);
        if (
          current === null ||
          (expectedProviderSubjectId !== undefined && current.providerSubjectId !== expectedProviderSubjectId)
        ) {
          return Option.none();
        }
        const replacement = {
          ...current,
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
    const disabled = yield* makeCommercePortalAuthSessionLifecycle(banned, providerFor(tokenA), {
      now: () => now,
    }).signIn({ email: 'buyer@example.test', password: Redacted.make('P'.repeat(24)) });
    expect(disabled.outcome.outcome).toBe('ACCOUNT_DISABLED');
    // Admission revoked the durable session, so the browser must not keep the provider's cookie.
    expect(disabled.setCookieHeaders).toEqual([]);
    expect(yield* banned.findByToken(tokenA)).toStrictEqual(Option.none());

    const unverified = memoryStore([record('session-b', tokenB, { emailVerified: false })]);
    const pending = yield* makeCommercePortalAuthSessionLifecycle(unverified, providerFor(tokenB), {
      now: () => now,
    }).signIn({ email: 'buyer@example.test', password: Redacted.make('P'.repeat(24)) });
    expect(pending.outcome.outcome).toBe('VERIFICATION_REQUIRED');
    expect(pending.setCookieHeaders).toEqual([]);

    // The admitted path still hands the provider cookie to the transport.
    const admitted = yield* makeCommercePortalAuthSessionLifecycle(
      memoryStore([record('session-c', tokenA)]),
      providerFor(tokenA),
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
  const service = makeCommercePortalAuthSessionLifecycle(store, providerFor(tokenA), { now: () => now });
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
  const service = makeCommercePortalAuthSessionLifecycle(memoryStore([initial]), providerFor(tokenA), {
    now: () => now,
  });
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

it.effect('rejects malformed or cross-subject safe references before provider state use', () => {
  const service = makeCommercePortalAuthSessionLifecycle(
    memoryStore([record('session-a', tokenA)]),
    providerFor(tokenA),
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
