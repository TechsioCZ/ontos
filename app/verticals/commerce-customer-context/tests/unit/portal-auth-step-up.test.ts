import { HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { Context, DateTime, Deferred, Effect, Fiber, Layer, Option, Redacted, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import {
  COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  CommerceSessionReferenceSchema,
} from '../../shared/portal-auth-contracts.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../../api/portal-auth/provider/config.ts';
import type { CommercePortalAuthConfigValue } from '../../api/portal-auth/provider/config.ts';
import { CommercePortalAuthConfig } from '../../api/portal-auth/provider/config-service.ts';
import {
  CommercePortalAuthStepUpApi,
  CommercePortalAuthStepUpChallengeIdSchema,
  CommercePortalAuthStepUpChallengeStoreService,
  CommercePortalAuthStepUpCodeRejected,
  CommercePortalAuthStepUpCodeVerifierService,
  CommercePortalAuthStepUpForbiddenProblemSchema,
  CommercePortalAuthStepUpHttpProviderService,
  CommercePortalAuthStepUpRejected,
  CommercePortalAuthStepUpRejectedProblemSchema,
  CommercePortalAuthStepUpService,
  CommercePortalAuthStepUpUnavailable,
  CommercePortalAuthStepUpUnavailableProblemSchema,
  makeCommercePortalAuthStepUp,
  portalAuthStepUpStandaloneApiLive,
} from '../../api/portal-auth/provider/step-up/index.ts';
import type {
  CommercePortalAuthStepUpChallengeRecord,
  CommercePortalAuthStepUpChallengeStore,
  CommercePortalAuthStepUpCodeVerifier,
  CommercePortalAuthStepUpHttpProvider,
  CommercePortalAuthStepUp,
} from '../../api/portal-auth/provider/step-up/index.ts';
import { CommercePortalAuthRecoveryRateLimitService } from '../../api/portal-auth/rate-limit-service.ts';
import type { CommercePortalAuthRecoveryRateLimit } from '../../api/portal-auth/rate-limit-service.ts';
import { CommercePortalAuthSessionReaderService } from '../../api/portal-auth/provider/session-reader-service.ts';
import type { CommercePortalAuthSessionReader } from '../../api/portal-auth/provider/session-reader-service.ts';
import type { CommercePortalAuthAuthoritativeSession } from '../../api/portal-auth/provider/verification.ts';
import {
  CommercePortalAuthProviderSubjectIdSchema,
  CommercePortalAuthSessionEvidenceSchema,
} from '../../api/portal-auth/session/contracts.ts';
import type {
  CommercePortalAuthSessionCookieHandoff,
  CommercePortalAuthSessionSnapshot,
} from '../../api/portal-auth/session/contracts.ts';
import { CommercePortalAuthSessionLifecycle } from '../../api/portal-auth/session/lifecycle-service.ts';
import type { CommercePortalAuthSessionLifecycleService } from '../../api/portal-auth/session/lifecycle-service.ts';

const TEST_NOW_MILLIS = 1_800_000_000_000;
const PROVIDER_SUBJECT_ID = 'commerce-user-1';
const SESSION_ID = 'session-1';
const OTHER_SESSION_ID = 'session-2';
const CORRECT_CODE = '123456';

const asDate = (millis: number): Date => DateTime.toDate(DateTime.makeUnsafe(millis));
const sessionRef = (sessionId = SESSION_ID): string =>
  `better-auth-session:${COMMERCE_AUTHENTICATION_NAMESPACE_ID}:${sessionId}`;
const epochMillis = (date: Date): number => DateTime.toEpochMillis(DateTime.makeUnsafe(date));
const brandedProviderSubjectId = Schema.decodeUnknownSync(CommercePortalAuthProviderSubjectIdSchema)(
  PROVIDER_SUBJECT_ID,
);

interface StepUpFixture {
  readonly challenges: Map<string, CommercePortalAuthStepUpChallengeRecord>;
  readonly challengeStore: CommercePortalAuthStepUpChallengeStore;
  readonly codeVerifier: CommercePortalAuthStepUpCodeVerifier;
  readonly lifecycle: CommercePortalAuthSessionLifecycleService;
  readonly reservations: Map<
    string,
    {
      readonly challengeIdHash: string;
      readonly providerSubjectId: string;
      readonly sessionId: string;
    }
  >;
  readonly sessionReader: CommercePortalAuthSessionReader;
  readonly state: {
    currentSession: CommercePortalAuthAuthoritativeSession | null;
    rotationCount: number;
    rotationReasons: string[];
    verifierCalls: number;
    verifierEntered: Deferred.Deferred<null> | null;
    verifierGate: Deferred.Deferred<null> | null;
    verifierUnavailable: boolean;
  };
}

const makeSession = (): CommercePortalAuthAuthoritativeSession => ({
  banExpiresAt: null,
  banned: false,
  createdAt: asDate(TEST_NOW_MILLIS - 60_000),
  emailVerified: true,
  expiresAt: asDate(TEST_NOW_MILLIS + 3_600_000),
  providerSubjectId: PROVIDER_SUBJECT_ID,
  sessionId: SESSION_ID,
});

const makeFixture = (): StepUpFixture => {
  const challenges = new Map<string, CommercePortalAuthStepUpChallengeRecord>();
  const reservations = new Map<
    string,
    {
      readonly challengeIdHash: string;
      readonly providerSubjectId: string;
      readonly sessionId: string;
    }
  >();
  const state: StepUpFixture['state'] = {
    currentSession: makeSession(),
    rotationCount: 0,
    rotationReasons: [],
    verifierCalls: 0,
    verifierEntered: null,
    verifierGate: null,
    verifierUnavailable: false,
  };
  const challengeStore = {
    consume: (input) =>
      Effect.sync(() => {
        const reservation = reservations.get(input.reservationId);
        const current = challenges.get(input.challengeIdHash);
        if (
          reservation === undefined ||
          reservation.challengeIdHash !== input.challengeIdHash ||
          reservation.providerSubjectId !== input.providerSubjectId ||
          reservation.sessionId !== input.sessionId ||
          current === undefined ||
          current.providerSubjectId !== input.providerSubjectId ||
          current.sessionId !== input.sessionId ||
          current.consumedAt !== null ||
          epochMillis(current.expiresAt) <= epochMillis(input.now)
        ) {
          if (
            reservation !== undefined &&
            reservation.challengeIdHash === input.challengeIdHash &&
            reservation.providerSubjectId === input.providerSubjectId &&
            reservation.sessionId === input.sessionId &&
            current !== undefined &&
            (current.consumedAt !== null || epochMillis(current.expiresAt) <= epochMillis(input.now))
          ) {
            reservations.delete(input.reservationId);
          }
          return false;
        }
        challenges.set(input.challengeIdHash, { ...current, consumedAt: input.now });
        reservations.delete(input.reservationId);
        return true;
      }),
    create: (input) =>
      Effect.sync(() => {
        challenges.set(input.challengeIdHash, {
          attemptsRemaining: input.attemptsRemaining,
          consumedAt: null,
          expiresAt: input.expiresAt,
          providerSubjectId: input.providerSubjectId,
          sessionId: input.sessionId,
        });
      }),
    findByChallengeIdHash: (challengeIdHash) =>
      Effect.sync(() => {
        const current = challenges.get(challengeIdHash);
        return current === undefined ? Option.none() : Option.some(current);
      }),
    recordFailure: (input) =>
      Effect.sync(() => {
        const reservation = reservations.get(input.reservationId);
        const current = challenges.get(input.challengeIdHash);
        if (
          reservation === undefined ||
          reservation.challengeIdHash !== input.challengeIdHash ||
          reservation.providerSubjectId !== input.providerSubjectId ||
          reservation.sessionId !== input.sessionId ||
          current === undefined ||
          current.providerSubjectId !== input.providerSubjectId ||
          current.sessionId !== input.sessionId
        ) {
          return false;
        }
        reservations.delete(input.reservationId);
        return true;
      }),
    releaseAttempt: (input) =>
      Effect.sync(() => {
        const reservation = reservations.get(input.reservationId);
        if (
          reservation === undefined ||
          reservation.challengeIdHash !== input.challengeIdHash ||
          reservation.providerSubjectId !== input.providerSubjectId ||
          reservation.sessionId !== input.sessionId
        ) {
          return false;
        }
        reservations.delete(input.reservationId);
        const current = challenges.get(input.challengeIdHash);
        if (
          current === undefined ||
          current.providerSubjectId !== input.providerSubjectId ||
          current.sessionId !== input.sessionId ||
          current.consumedAt !== null ||
          epochMillis(current.expiresAt) <= epochMillis(input.now)
        ) {
          return true;
        }
        challenges.set(input.challengeIdHash, {
          ...current,
          attemptsRemaining: Math.min(current.attemptsRemaining + 1, COMMERCE_PORTAL_AUTH_POLICY.mfa.maxAttempts),
        });
        return true;
      }),
    reserveAttempt: (input) =>
      Effect.sync(() => {
        const current = challenges.get(input.challengeIdHash);
        if (
          current === undefined ||
          current.providerSubjectId !== input.providerSubjectId ||
          current.sessionId !== input.sessionId ||
          current.consumedAt !== null ||
          current.attemptsRemaining <= 0 ||
          epochMillis(current.expiresAt) <= epochMillis(input.now) ||
          reservations.has(input.reservationId)
        ) {
          return false;
        }
        challenges.set(input.challengeIdHash, {
          ...current,
          attemptsRemaining: current.attemptsRemaining - 1,
        });
        reservations.set(input.reservationId, {
          challengeIdHash: input.challengeIdHash,
          providerSubjectId: input.providerSubjectId,
          sessionId: input.sessionId,
        });
        return true;
      }),
  } satisfies CommercePortalAuthStepUpChallengeStore;
  const codeVerifier = {
    verify: ({ code }) => {
      state.verifierCalls += 1;
      const entered =
        state.verifierEntered === null
          ? Effect.void
          : Deferred.succeed(state.verifierEntered, null).pipe(Effect.asVoid);
      const gate =
        state.verifierGate === null ? Effect.yieldNow : Deferred.await(state.verifierGate).pipe(Effect.asVoid);
      let verificationResult: Effect.Effect<
        void,
        CommercePortalAuthStepUpCodeRejected | CommercePortalAuthStepUpUnavailable
      >;
      if (state.verifierUnavailable) {
        verificationResult = Effect.fail(
          new CommercePortalAuthStepUpUnavailable({
            operation: 'mfa-verify',
            reason: 'MFA verifier unavailable',
          }),
        );
      } else if (code === CORRECT_CODE) {
        verificationResult = Effect.void;
      } else {
        verificationResult = Effect.fail(new CommercePortalAuthStepUpCodeRejected({ reason: 'MFA code rejected' }));
      }
      return entered.pipe(Effect.andThen(gate), Effect.andThen(verificationResult));
    },
  } satisfies CommercePortalAuthStepUpCodeVerifier;
  const sessionReader = {
    findBySessionId: (sessionId: string) =>
      Effect.sync(() =>
        state.currentSession !== null && state.currentSession.sessionId === sessionId
          ? Option.some(state.currentSession)
          : Option.none(),
      ),
  } satisfies CommercePortalAuthSessionReader;
  const evidence = Schema.decodeUnknownSync(CommercePortalAuthSessionEvidenceSchema)({
    assurance: 'step-up',
    authenticatedAt: asDate(TEST_NOW_MILLIS - 60_000),
    authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
    createdAt: asDate(TEST_NOW_MILLIS - 60_000),
    expiresAt: asDate(TEST_NOW_MILLIS + 3_600_000),
    observedAt: asDate(TEST_NOW_MILLIS),
    policyVersion: COMMERCE_PORTAL_AUTH_POLICY.policyVersion,
    providerSubjectId: PROVIDER_SUBJECT_ID,
    sessionRef: sessionRef(),
    subjectType: 'user',
    updatedAt: asDate(TEST_NOW_MILLIS - 60_000),
  });
  const session: CommercePortalAuthSessionSnapshot = {
    authenticatedAt: evidence.authenticatedAt,
    authenticationNamespaceId: evidence.authenticationNamespaceId,
    createdAt: evidence.createdAt,
    expiresAt: evidence.expiresAt,
    policyVersion: evidence.policyVersion,
    providerSubjectId: evidence.providerSubjectId,
    sessionRef: evidence.sessionRef,
    subjectType: evidence.subjectType,
    updatedAt: evidence.updatedAt,
  };
  const handoff: CommercePortalAuthSessionCookieHandoff = {
    previousSessionRef: evidence.sessionRef,
    providerToken: 'private-replacement-token',
    reason: 'step-up',
    session,
  };
  const lifecycle: CommercePortalAuthSessionLifecycleService = {
    disableAccount: () => Effect.die('unused in step-up tests'),
    evidenceForSession: () => Effect.die('unused in step-up tests'),
    refresh: () => Effect.die('unused in step-up tests'),
    revoke: () => Effect.die('unused in step-up tests'),
    revokeAll: () => Effect.die('unused in step-up tests'),
    rotateIdentifierForCookie: (input) =>
      Effect.sync(() => {
        state.rotationCount += 1;
        state.rotationReasons.push(input.reason);
        return handoff;
      }),
    signIn: () => Effect.die('unused in step-up tests'),
    signOut: () => Effect.die('unused in step-up tests'),
  };
  return { challenges, challengeStore, codeVerifier, lifecycle, reservations, sessionReader, state };
};

const runWithFixture = <A, E>(
  execute: (service: CommercePortalAuthStepUp, fixture: StepUpFixture) => Effect.Effect<A, E>,
): Effect.Effect<A, E> => {
  const fixture = makeFixture();
  return Effect.gen(function* runStepUpTest() {
    yield* TestClock.setTime(TEST_NOW_MILLIS);
    const service = yield* makeCommercePortalAuthStepUp();
    return yield* execute(service, fixture);
  }).pipe(
    Effect.provideService(CommercePortalAuthStepUpChallengeStoreService, fixture.challengeStore),
    Effect.provideService(CommercePortalAuthStepUpCodeVerifierService, fixture.codeVerifier),
    Effect.provideService(CommercePortalAuthSessionLifecycle, fixture.lifecycle),
    Effect.provideService(CommercePortalAuthSessionReaderService, fixture.sessionReader),
    Effect.provide(TestClock.layer()),
  );
};

const firstChallengeHash = (fixture: StepUpFixture): string => {
  const [challengeHash] = fixture.challenges.keys();
  if (challengeHash === undefined) {
    throw new Error('Expected a stored step-up challenge');
  }
  return challengeHash;
};

const issue = (service: CommercePortalAuthStepUp) =>
  service.issue({ providerSubjectId: PROVIDER_SUBJECT_ID, sessionRef: sessionRef() });

const verify = (
  service: CommercePortalAuthStepUp,
  challengeId: string,
  code = CORRECT_CODE,
  providerSubjectId = PROVIDER_SUBJECT_ID,
  currentSessionRef = sessionRef(),
) =>
  service.verify({
    challengeId,
    code,
    headers: new Headers(),
    providerSubjectId,
    sessionRef: currentSessionRef,
  });

it.effect('issues an opaque challenge bounded by the live provider session', () =>
  runWithFixture((service, fixture) =>
    Effect.gen(function* issueChallenge() {
      const result = yield* issue(service);
      expect(result.outcome).toBe('STEP_UP_REQUIRED');
      expect(Object.keys(result)).toEqual(['attemptsRemaining', 'challengeId', 'expiresAt', 'outcome']);
      expect(result.attemptsRemaining).toBe(COMMERCE_PORTAL_AUTH_POLICY.mfa.maxAttempts);
      expect(epochMillis(result.expiresAt)).toBe(
        TEST_NOW_MILLIS + COMMERCE_PORTAL_AUTH_POLICY.mfa.challengeMaxAgeSeconds * 1000,
      );
      const challengeHash = firstChallengeHash(fixture);
      expect(challengeHash).not.toBe(result.challengeId);
      const stored = fixture.challenges.get(challengeHash);
      expect(stored?.providerSubjectId).toBe(PROVIDER_SUBJECT_ID);
      expect(stored?.sessionId).toBe(SESSION_ID);
    }),
  ),
);

it.effect('rejects a challenge claimed by another subject or session before MFA', () =>
  runWithFixture((service, fixture) =>
    Effect.gen(function* rejectMismatchedBinding() {
      const challenge = yield* issue(service);
      const wrongSubject = yield* verify(service, challenge.challengeId, CORRECT_CODE, 'other-subject');
      const wrongSession = yield* verify(
        service,
        challenge.challengeId,
        CORRECT_CODE,
        PROVIDER_SUBJECT_ID,
        sessionRef(OTHER_SESSION_ID),
      );
      expect(wrongSubject.outcome).toBe('STEP_UP_REJECTED');
      expect(wrongSession.outcome).toBe('STEP_UP_REJECTED');
      expect(Object.keys(wrongSubject)).toEqual(['outcome']);
      expect(fixture.state.verifierCalls).toBe(0);
    }),
  ),
);

it.effect('decrements failed proofs to zero and stops invoking MFA after the bound', () =>
  runWithFixture((service, fixture) =>
    Effect.gen(function* rejectFailedProofs() {
      const challenge = yield* issue(service);
      const attempts = COMMERCE_PORTAL_AUTH_POLICY.mfa.maxAttempts;
      const results = yield* Effect.forEach(
        Array.from({ length: attempts + 1 }, (_, index) => index),
        () => verify(service, challenge.challengeId, '000000'),
      );
      expect(results.every((result) => result.outcome === 'STEP_UP_REJECTED')).toBe(true);
      expect(fixture.state.verifierCalls).toBe(attempts);
      const challengeHash = firstChallengeHash(fixture);
      expect(fixture.challenges.get(challengeHash)?.attemptsRemaining).toBe(0);
    }),
  ),
);

it.effect('reserves the failed-attempt budget before concurrent MFA verification', () =>
  runWithFixture((service, fixture) =>
    Effect.gen(function* reserveConcurrentFailedProof() {
      const challenge = yield* issue(service);
      const challengeHash = firstChallengeHash(fixture);
      const current = fixture.challenges.get(challengeHash);
      if (current === undefined) {
        throw new Error('Expected a stored step-up challenge');
      }
      fixture.challenges.set(challengeHash, { ...current, attemptsRemaining: 1 });

      const results = yield* Effect.scoped(
        Effect.gen(function* concurrentFailedProofs() {
          const verifierEntered = yield* Deferred.make<null>();
          const verifierGate = yield* Deferred.make<null>();
          fixture.state.verifierEntered = verifierEntered;
          fixture.state.verifierGate = verifierGate;
          const fibers = yield* Effect.forEach(
            [1, 2, 3],
            () => Effect.forkScoped(verify(service, challenge.challengeId, '000000')),
            { concurrency: 'unbounded' },
          );
          yield* Deferred.await(verifierEntered);
          yield* Effect.forEach([1, 2, 3], () => Effect.yieldNow);
          yield* Deferred.succeed(verifierGate, null);
          return yield* Effect.forEach(fibers, Fiber.join, { concurrency: 'unbounded' });
        }),
      );

      expect(results.every((result) => result.outcome === 'STEP_UP_REJECTED')).toBe(true);
      expect(fixture.state.verifierCalls).toBe(1);
      expect(fixture.state.verifierCalls).toBeLessThanOrEqual(1);
      expect(fixture.challenges.get(challengeHash)?.attemptsRemaining).toBe(0);
      expect(fixture.reservations.size).toBe(0);
    }),
  ),
);

it.effect('rejects an expired challenge without calling the MFA verifier', () =>
  runWithFixture((service, fixture) =>
    Effect.gen(function* rejectExpiredChallenge() {
      const challenge = yield* issue(service);
      yield* TestClock.adjust(`${COMMERCE_PORTAL_AUTH_POLICY.mfa.challengeMaxAgeSeconds + 1} seconds`);
      const result = yield* verify(service, challenge.challengeId);
      expect(result.outcome).toBe('STEP_UP_REJECTED');
      expect(fixture.state.verifierCalls).toBe(0);
    }),
  ),
);

it.effect('consumes a valid proof once and rotates the provider identifier for step-up', () =>
  runWithFixture((service, fixture) =>
    Effect.gen(function* completeStepUp() {
      const challenge = yield* issue(service);
      const result = yield* verify(service, challenge.challengeId);
      expect(result.outcome).toBe('STEP_UP_COMPLETED');
      if (result.outcome !== 'STEP_UP_COMPLETED') {
        throw new Error('Expected a completed step-up');
      }
      expect(result.handoff.providerToken).toBe('private-replacement-token');
      expect(fixture.state.rotationCount).toBe(1);
      expect(fixture.state.rotationReasons).toEqual(['step-up']);
      const replay = yield* verify(service, challenge.challengeId);
      expect(replay.outcome).toBe('STEP_UP_REJECTED');
      expect(fixture.state.verifierCalls).toBe(1);
    }),
  ),
);

it.effect('allows only one concurrent valid proof to consume the challenge', () =>
  runWithFixture((service, fixture) =>
    Effect.gen(function* completeConcurrentStepUp() {
      const challenge = yield* issue(service);
      const outcomes = yield* Effect.all(
        [verify(service, challenge.challengeId), verify(service, challenge.challengeId)],
        { concurrency: 2 },
      );
      expect(outcomes.filter((result) => result.outcome === 'STEP_UP_COMPLETED')).toHaveLength(1);
      expect(outcomes.filter((result) => result.outcome === 'STEP_UP_REJECTED')).toHaveLength(1);
      expect(fixture.state.rotationCount).toBe(1);
      expect(fixture.state.verifierCalls).toBe(2);
    }),
  ),
);

it.effect('rechecks the provider session after challenge issuance', () =>
  runWithFixture((service, fixture) =>
    Effect.gen(function* rejectStaleSession() {
      const challenge = yield* issue(service);
      fixture.state.currentSession = null;
      const rejection = yield* verify(service, challenge.challengeId).pipe(Effect.flip);
      expect(Schema.is(CommercePortalAuthStepUpRejected)(rejection)).toBe(true);
      expect(fixture.state.verifierCalls).toBe(0);
    }),
  ),
);

it.effect('keeps MFA provider outages typed and leaves the challenge unconsumed', () =>
  runWithFixture((service, fixture) =>
    Effect.gen(function* surfaceUnavailable() {
      const challenge = yield* issue(service);
      fixture.state.verifierUnavailable = true;
      const failure = yield* verify(service, challenge.challengeId).pipe(Effect.flip);
      expect(Schema.is(CommercePortalAuthStepUpUnavailable)(failure)).toBe(true);
      const challengeHash = firstChallengeHash(fixture);
      expect(fixture.challenges.get(challengeHash)?.consumedAt).toBeNull();
      expect(fixture.challenges.get(challengeHash)?.attemptsRemaining).toBe(
        COMMERCE_PORTAL_AUTH_POLICY.mfa.maxAttempts,
      );
      expect(fixture.reservations.size).toBe(0);
      expect(fixture.state.rotationCount).toBe(0);
    }),
  ),
);

const HTTP_ORIGIN = 'https://portal.example.test';
const HTTP_COOKIE = 'commerce-portal.session_token=current';
const HTTP_CHALLENGE_ID = 'http-challenge';
const HTTP_CHALLENGE = Schema.decodeUnknownSync(CommercePortalAuthStepUpChallengeIdSchema)(HTTP_CHALLENGE_ID);

interface StepUpHttpFixture {
  readonly budget: CommercePortalAuthRecoveryRateLimit;
  readonly provider: CommercePortalAuthStepUpHttpProvider;
  readonly service: CommercePortalAuthStepUp;
  readonly state: {
    readonly budgetKeys: string[];
    readonly cookieHeaders: string[];
    readonly currentSession: {
      value: Option.Option<{ readonly providerSubjectId: string; readonly sessionId: string }>;
    };
    readonly handoffs: CommercePortalAuthSessionCookieHandoff[];
    readonly issueInputs: Parameters<CommercePortalAuthStepUp['issue']>[0][];
    readonly readHeaders: Headers[];
    verifyHandoff: CommercePortalAuthSessionCookieHandoff;
    readonly verifyInputs: Parameters<CommercePortalAuthStepUp['verify']>[0][];
  };
}

const httpSessionReference = Schema.decodeUnknownSync(CommerceSessionReferenceSchema)(sessionRef());
const httpReplacementSessionReference = Schema.decodeUnknownSync(CommerceSessionReferenceSchema)(
  sessionRef('session-rotated'),
);

const makeHttpHandoff = (
  replacementSessionRef = httpReplacementSessionReference,
): CommercePortalAuthSessionCookieHandoff => ({
  previousSessionRef: httpSessionReference,
  providerToken: 'private-http-token',
  reason: 'step-up',
  session: {
    authenticatedAt: asDate(TEST_NOW_MILLIS - 60_000),
    authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
    createdAt: asDate(TEST_NOW_MILLIS - 60_000),
    expiresAt: asDate(TEST_NOW_MILLIS + 3_600_000),
    policyVersion: COMMERCE_PORTAL_AUTH_POLICY.policyVersion,
    providerSubjectId: brandedProviderSubjectId,
    sessionRef: replacementSessionRef,
    subjectType: 'user',
    updatedAt: asDate(TEST_NOW_MILLIS - 60_000),
  },
});

const makeStepUpHttpFixture = (): StepUpHttpFixture => {
  const handoff = makeHttpHandoff();
  const state: StepUpHttpFixture['state'] = {
    budgetKeys: [],
    cookieHeaders: ['commerce-portal.session_token=signed; Path=/; HttpOnly; SameSite=Lax'],
    currentSession: {
      value: Option.some({ providerSubjectId: PROVIDER_SUBJECT_ID, sessionId: SESSION_ID }),
    },
    handoffs: [],
    issueInputs: [],
    readHeaders: [],
    verifyHandoff: handoff,
    verifyInputs: [],
  };
  // The deployment's durable counter store, in memory: the same key shape and the same denial the
  // production store answers with once the window's budget is spent.
  const spent = new Map<string, number>();
  const budget: CommercePortalAuthRecoveryRateLimit = {
    consume: (key, rule) =>
      Effect.sync(() => {
        state.budgetKeys.push(key);
        const next = (spent.get(key) ?? 0) + 1;
        spent.set(key, next);
        return next <= rule.max;
      }),
  };
  const provider: CommercePortalAuthStepUpHttpProvider = {
    readCurrentSession: (headers) =>
      Effect.sync(() => {
        state.readHeaders.push(headers);
        return state.currentSession.value;
      }),
    setSessionCookie: (receivedHandoff) =>
      Effect.sync(() => {
        state.handoffs.push(receivedHandoff);
        return state.cookieHeaders;
      }),
  };
  const service: CommercePortalAuthStepUp = {
    issue: (input) =>
      Effect.sync(() => {
        state.issueInputs.push(input);
        return {
          attemptsRemaining: COMMERCE_PORTAL_AUTH_POLICY.mfa.maxAttempts,
          challengeId: HTTP_CHALLENGE,
          expiresAt: asDate(TEST_NOW_MILLIS + 60_000),
          outcome: 'STEP_UP_REQUIRED' as const,
        };
      }),
    verify: (input) =>
      Effect.sync(() => {
        state.verifyInputs.push(input);
        return { handoff: state.verifyHandoff, outcome: 'STEP_UP_COMPLETED' as const };
      }),
  };
  return { budget, provider, service, state };
};

const httpRequest = (
  route: string,
  body: Readonly<Record<string, string>>,
  options: { readonly contentType?: string; readonly method?: string; readonly origin?: string } = {},
): Request => {
  const headers = new Headers({
    'content-type': options.contentType ?? 'application/json',
    cookie: HTTP_COOKIE,
    origin: options.origin ?? HTTP_ORIGIN,
  });
  const method = options.method ?? 'POST';
  return new Request(
    `https://portal.example.test/api/portal-auth${route}`,
    method === 'GET' || method === 'HEAD' ? { headers, method } : { body: JSON.stringify(body), headers, method },
  );
};

const HTTP_CONFIG: CommercePortalAuthConfigValue = {
  baseUrl: HTTP_ORIGIN,
  connectionString: Redacted.make('postgres://user:pass@localhost:5432/commerce'),
  nodeEnvironment: 'test',
  policy: COMMERCE_PORTAL_AUTH_POLICY,
  secret: Redacted.make('a'.repeat(32)),
  secureCookies: true,
  trustedOrigins: [HTTP_ORIGIN],
  trustedProxies: [],
  versionedSecrets: [],
};

const httpRequestContext = Context.makeUnsafe<unknown>(new Map());

const makeHttpApp = (fixture: StepUpHttpFixture) =>
  Effect.gen(function* makeHttpAppEffect() {
    const apiLayer = HttpApiBuilder.layer(CommercePortalAuthStepUpApi).pipe(
      Layer.provide(portalAuthStepUpStandaloneApiLive),
      Layer.provide(Layer.succeed(CommercePortalAuthStepUpHttpProviderService, fixture.provider)),
      Layer.provide(Layer.succeed(CommercePortalAuthStepUpService, fixture.service)),
      Layer.provide(Layer.succeed(CommercePortalAuthConfig, HTTP_CONFIG)),
      Layer.provide(Layer.succeed(CommercePortalAuthRecoveryRateLimitService, fixture.budget)),
      Layer.provide(HttpServer.layerServices),
    );
    return yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(apiLayer, { disableLogger: true })),
      (handler) => Effect.promise(handler.dispose.bind(handler)).pipe(Effect.orDie),
    );
  });

it.effect('derives issue identity from the provider session and accepts no identity body fields', () =>
  Effect.gen(function* issueThroughHttp() {
    const fixture = makeStepUpHttpFixture();
    const app = yield* makeHttpApp(fixture);
    const response = yield* Effect.promise(() => app.handler(httpRequest('/step-up', {}), httpRequestContext));
    const body = yield* Effect.promise(() => response.json());
    expect(response.status).toBe(200);
    expect(body).toStrictEqual({
      attemptsRemaining: COMMERCE_PORTAL_AUTH_POLICY.mfa.maxAttempts,
      challengeId: HTTP_CHALLENGE_ID,
      expiresAt: asDate(TEST_NOW_MILLIS + 60_000).toISOString(),
      outcome: 'STEP_UP_REQUIRED',
    });
    expect(fixture.state.issueInputs[0]?.providerSubjectId).toBe(PROVIDER_SUBJECT_ID);
    expect(fixture.state.issueInputs[0]?.sessionRef).toBe(sessionRef());
    expect(fixture.state.readHeaders[0]?.get('cookie')).toBe(HTTP_COOKIE);

    const callerClaimedIdentity = yield* Effect.promise(() =>
      app.handler(
        httpRequest('/step-up', {
          providerSubjectId: 'caller-controlled-subject',
          sessionRef: 'caller-controlled-session',
        }),
        httpRequestContext,
      ),
    );
    expect(callerClaimedIdentity.status).toBe(400);
    expect(fixture.state.issueInputs).toHaveLength(1);
  }),
);

it.effect('verifies with the exact request headers and forwards only the signed cookie handoff', () =>
  Effect.gen(function* verifyThroughHttp() {
    const fixture = makeStepUpHttpFixture();
    const app = yield* makeHttpApp(fixture);
    const response = yield* Effect.promise(() =>
      app.handler(
        httpRequest('/step-up/verify', { challengeId: HTTP_CHALLENGE_ID, code: CORRECT_CODE }),
        httpRequestContext,
      ),
    );
    const body = yield* Effect.promise(() => response.json());
    expect(response.status).toBe(200);
    expect(body).toStrictEqual({ outcome: 'STEP_UP_COMPLETED' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('set-cookie')).toContain('commerce-portal.session_token=signed');
    expect(fixture.state.handoffs[0]?.providerToken).toBe('private-http-token');
    expect(fixture.state.verifyInputs[0]?.providerSubjectId).toBe(PROVIDER_SUBJECT_ID);
    expect(fixture.state.verifyInputs[0]?.sessionRef).toBe(sessionRef());
    expect(fixture.state.verifyInputs[0]?.headers.get('cookie')).toBe(HTTP_COOKIE);
    expect(fixture.state.verifyInputs[0]?.headers.get('origin')).toBe(HTTP_ORIGIN);
    expect('providerToken' in body).toBe(false);
  }),
);

it.effect('maps missing sessions, wrong origin, wrong method, and non-JSON bodies without calling the service', () =>
  Effect.gen(function* rejectUnsafeRequests() {
    const fixture = makeStepUpHttpFixture();
    const app = yield* makeHttpApp(fixture);
    fixture.state.currentSession.value = Option.none();
    const missingSession = yield* Effect.promise(() =>
      app.handler(
        httpRequest('/step-up/verify', { challengeId: HTTP_CHALLENGE_ID, code: CORRECT_CODE }),
        httpRequestContext,
      ),
    );
    expect(missingSession.status).toBe(401);
    const missingSessionBody = yield* Effect.promise(() => missingSession.json());
    expect(Schema.is(CommercePortalAuthStepUpRejectedProblemSchema)(missingSessionBody)).toBe(true);
    expect(missingSessionBody).toMatchObject({ code: 'step_up_rejected', status: 401 });
    expect(fixture.state.verifyInputs).toHaveLength(0);

    const wrongOrigin = yield* Effect.promise(() =>
      app.handler(httpRequest('/step-up', {}, { origin: 'https://attacker.example.test' }), httpRequestContext),
    );
    expect(wrongOrigin.status).toBe(403);
    const wrongOriginBody = yield* Effect.promise(() => wrongOrigin.json());
    expect(Schema.is(CommercePortalAuthStepUpForbiddenProblemSchema)(wrongOriginBody)).toBe(true);
    expect(wrongOriginBody).toMatchObject({ code: 'origin_not_trusted', status: 403 });
    expect(fixture.state.readHeaders).toHaveLength(1);

    const wrongMethod = yield* Effect.promise(() =>
      app.handler(httpRequest('/step-up', {}, { method: 'GET' }), httpRequestContext),
    );
    expect(wrongMethod.status).toBe(404);

    const wrongContentType = yield* Effect.promise(() =>
      app.handler(httpRequest('/step-up', {}, { contentType: 'text/plain' }), httpRequestContext),
    );
    expect(wrongContentType.status).toBe(400);
    expect(fixture.state.readHeaders).toHaveLength(1);
  }),
);

it.effect('fails closed when the completed handoff has no replacement cookie', () =>
  Effect.gen(function* rejectMissingCookie() {
    const fixture = makeStepUpHttpFixture();
    const app = yield* makeHttpApp(fixture);
    fixture.state.cookieHeaders.length = 0;
    const response = yield* Effect.promise(() =>
      app.handler(
        httpRequest('/step-up/verify', { challengeId: HTTP_CHALLENGE_ID, code: CORRECT_CODE }),
        httpRequestContext,
      ),
    );
    expect(response.status).toBe(503);
    const body = yield* Effect.promise(() => response.json());
    expect(Schema.is(CommercePortalAuthStepUpUnavailableProblemSchema)(body)).toBe(true);
    expect(body).toMatchObject({ retryable: true, status: 503 });
  }),
);

it.effect('rejects a handoff that reuses the current session reference', () =>
  Effect.gen(function* rejectUnrotatedHandoff() {
    const fixture = makeStepUpHttpFixture();
    const app = yield* makeHttpApp(fixture);
    fixture.state.verifyHandoff = makeHttpHandoff(httpSessionReference);
    const response = yield* Effect.promise(() =>
      app.handler(
        httpRequest('/step-up/verify', { challengeId: HTTP_CHALLENGE_ID, code: CORRECT_CODE }),
        httpRequestContext,
      ),
    );
    expect(response.status).toBe(503);
    expect(fixture.state.handoffs).toHaveLength(0);
    const body = yield* Effect.promise(() => response.json());
    expect(Schema.is(CommercePortalAuthStepUpUnavailableProblemSchema)(body)).toBe(true);
    expect(body).toMatchObject({ retryable: true, status: 503 });
  }),
);

it.effect('caps challenge minting on a durable per-session budget a caller cannot reset', () =>
  Effect.gen(function* capIssuedChallenges() {
    const fixture = makeStepUpHttpFixture();
    const app = yield* makeHttpApp(fixture);
    const granted: number[] = [];
    for (let attempt = 0; attempt < COMMERCE_PORTAL_AUTH_POLICY.rateLimit.mfa.max; attempt += 1) {
      const allowed = yield* Effect.promise(() => app.handler(httpRequest('/step-up', {}), httpRequestContext));
      granted.push(allowed.status);
    }
    expect(granted).toStrictEqual(Array.from({ length: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.mfa.max }, () => 200));
    // Re-issuing is what would otherwise hand the caller a fresh `attemptsRemaining` budget.
    const exhausted = yield* Effect.promise(() => app.handler(httpRequest('/step-up', {}), httpRequestContext));
    expect(exhausted.status).toBe(401);
    expect(
      Schema.is(CommercePortalAuthStepUpRejectedProblemSchema)(yield* Effect.promise(() => exhausted.json())),
    ).toBe(true);
    expect(fixture.state.issueInputs).toHaveLength(COMMERCE_PORTAL_AUTH_POLICY.rateLimit.mfa.max);
    // The budget is keyed on the session the caller's own cookie resolves to, never on a payload
    // field or a forwarded header, so a second challenge cannot open a second budget.
    expect(new Set(fixture.state.budgetKeys)).toStrictEqual(new Set([`${sessionRef()}|/step-up`]));
  }),
);

it.effect('caps step-up code guessing across every challenge the session mints', () =>
  Effect.gen(function* capVerifiedCodes() {
    const fixture = makeStepUpHttpFixture();
    const app = yield* makeHttpApp(fixture);
    for (let attempt = 0; attempt < COMMERCE_PORTAL_AUTH_POLICY.rateLimit.mfa.max; attempt += 1) {
      const allowed = yield* Effect.promise(() =>
        app.handler(
          httpRequest('/step-up/verify', { challengeId: HTTP_CHALLENGE_ID, code: CORRECT_CODE }),
          httpRequestContext,
        ),
      );
      expect(allowed.status).toBe(200);
    }
    const exhausted = yield* Effect.promise(() =>
      app.handler(
        httpRequest('/step-up/verify', { challengeId: HTTP_CHALLENGE_ID, code: CORRECT_CODE }),
        httpRequestContext,
      ),
    );
    expect(exhausted.status).toBe(401);
    expect(fixture.state.verifyInputs).toHaveLength(COMMERCE_PORTAL_AUTH_POLICY.rateLimit.mfa.max);
    expect(new Set(fixture.state.budgetKeys)).toStrictEqual(new Set([`${sessionRef()}|/step-up/verify`]));
  }),
);
