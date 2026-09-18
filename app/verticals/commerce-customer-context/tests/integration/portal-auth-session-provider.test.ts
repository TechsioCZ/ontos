import { applySetCookies, splitSetCookieHeader } from 'better-auth/cookies';
import { HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { eq, like, sql } from 'drizzle-orm';
import {
  Config,
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Redacted,
  Result,
  Schema,
} from 'effect';
import type { Scope } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';
import { randomUUID } from 'node:crypto';

import { makeCommercePortalAuthDatabase } from '../../src/portal-auth/persistence/portal-auth-database.ts';
import type { CommercePortalAuthDatabase } from '../../src/portal-auth/persistence/portal-auth-database.ts';
import { rateLimit, session, user, verification } from '../../src/portal-auth/persistence/portal-auth-tables.ts';
import { makeCommercePortalAuth } from '../../api/portal-auth/provider/auth.ts';
import { CommercePortalAuthConfig } from '../../api/portal-auth/provider/config-service.ts';
import { CommercePortalAuthRecoveryRateLimitService } from '../../api/portal-auth/rate-limit-service.ts';
import { COMMERCE_PORTAL_AUTH_POLICY, parseCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';
import { makeCommercePortalAuthSessionProvider } from '../../api/portal-auth/session/provider.ts';
import { CommercePortalAuthService, portalAuthSessionStandaloneApiLive } from '../../api/portal-auth/session/http.ts';
import {
  CommercePortalAuthSessionLifecycle,
  makeCommercePortalAuthSessionLifecycle,
} from '../../api/portal-auth/session/lifecycle.ts';
import { makeCommercePortalAuthSessionStore } from '../../src/portal-auth/persistence/portal-auth-session-store.ts';
import { CommercePortalAuthSessionApi } from '../../shared/portal-auth/session-api.ts';

const ORIGIN = 'http://localhost:3020';
const requestContext = Context.makeUnsafe<unknown>(new Map());
const PASSWORD = 'P'.repeat(24);
const SECRET = 's'.repeat(64);
const LOCK_WAIT_DEADLINE_MILLIS = 3000;
const LOCK_WAIT_POLL_MILLIS = 20;
const DATABASE_URL = Config.redacted('COMMERCE_PORTAL_AUTH_DATABASE_URL').pipe(
  Config.orElse(() => Config.redacted('DATABASE_URL')),
);

const ProviderDateSchema = Schema.Union([Schema.Date, Schema.String, Schema.Finite]);
const ProviderSessionResponseSchema = Schema.Struct({
  session: Schema.Struct({
    createdAt: ProviderDateSchema,
    expiresAt: ProviderDateSchema,
    id: Schema.String,
    updatedAt: ProviderDateSchema,
  }),
  user: Schema.Struct({ id: Schema.String }),
});
const SafePublicResponseBodySchema = Schema.Struct({
  code: Schema.optional(Schema.String),
  outcome: Schema.optional(Schema.String),
});
type ProviderDate = typeof ProviderDateSchema.Type;
type ProviderAuth = Effect.Success<ReturnType<typeof makeCommercePortalAuth>>;
type ProviderDatabase = (typeof CommercePortalAuthDatabase)['Service'];

interface ProviderFixture {
  readonly auth: ProviderAuth;
  readonly database: ProviderDatabase;
  readonly email: string;
  readonly handler: (request: Request) => Effect.Effect<Response, unknown>;
  readonly ipPrefix: string;
  readonly password: string;
}

interface ProviderSession {
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly headers: Headers;
  readonly sessionId: string;
  readonly updatedAt: Date;
  readonly userId: string;
}

const dateFromProvider = (value: ProviderDate): Date => {
  const date = DateTime.make(value);
  if (Option.isNone(date)) {
    throw new Error('Better Auth returned an invalid provider date');
  }
  return DateTime.toDate(date.value);
};

const requestHeaders = (ip: string, cookie?: string): Headers => {
  const headers = new Headers({
    origin: ORIGIN,
    'x-forwarded-for': ip,
  });
  if (cookie !== undefined) {
    headers.set('cookie', cookie);
  }
  return headers;
};

const browserHeadersFrom = (responseHeaders: Headers, baseHeaders: Headers): Headers => {
  const browserHeaders = new Headers(baseHeaders);
  applySetCookies(browserHeaders, splitSetCookieHeader(responseHeaders.get('set-cookie') ?? ''));
  return browserHeaders;
};

const hasBrowserSessionCookie = (headers: Headers): boolean =>
  headers
    .get('cookie')
    ?.split(';')
    .some((entry) => entry.trimStart().startsWith('commerce-portal.session_token=')) ?? false;

const assertProviderCookieRenewal = (headers: Headers): void => {
  const setCookie = headers.get('set-cookie') ?? '';
  expect(setCookie.length).toBeGreaterThan(0);
  expect(setCookie.includes('commerce-portal.session_token=')).toBe(true);
  expect(setCookie.includes('HttpOnly')).toBe(true);
  expect(setCookie.includes('Path=/')).toBe(true);
  expect(setCookie.includes('SameSite=Lax')).toBe(true);
  expect(setCookie.includes(`Max-Age=${COMMERCE_PORTAL_AUTH_POLICY.session.inactivityLifetimeSeconds}`)).toBe(true);
};

const readSafeResponseBody = (
  response: Response,
): Effect.Effect<Option.Option<{ readonly code?: string; readonly outcome?: string }>> =>
  Effect.tryPromise({
    catch: (cause) => cause,
    try: () => response.clone().json(),
  }).pipe(
    Effect.result,
    Effect.map((result) =>
      Result.match(result, {
        onFailure: () => Option.none(),
        onSuccess: (body) => Schema.decodeUnknownOption(SafePublicResponseBodySchema)(body),
      }),
    ),
  );

const readFixtureState = (
  fixture: ProviderFixture,
): Effect.Effect<{ readonly sessionCount: number | null; readonly userPresent: boolean }> =>
  fixture.database.executor
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, fixture.email))
    .limit(1)
    .pipe(
      Effect.flatMap((users) => {
        const fixtureUser = users.at(0);
        if (fixtureUser === undefined) {
          return Effect.succeed({ sessionCount: 0, userPresent: false });
        }
        return fixture.database.executor
          .select({ id: session.id })
          .from(session)
          .where(eq(session.userId, fixtureUser.id))
          .pipe(Effect.map((sessions) => ({ sessionCount: sessions.length, userPresent: true })));
      }),
      Effect.orElseSucceed(() => ({ sessionCount: null, userPresent: false })),
    );

const assertPublicStatus = (
  fixture: ProviderFixture,
  response: Response,
  expectedStatus: number,
  operation: string,
): Effect.Effect<void> =>
  Effect.gen(function* assertPublicStatusEffect() {
    if (response.status === expectedStatus) {
      return;
    }
    const safeBody = yield* readSafeResponseBody(response);
    const state = yield* readFixtureState(fixture);
    const cookieNames = splitSetCookieHeader(response.headers.get('set-cookie') ?? '')
      .map((cookie) => cookie.slice(0, cookie.indexOf('=')))
      .filter((name) => name.length > 0);
    throw new Error(
      `${operation} returned ${response.status}, expected ${expectedStatus}; ` +
        `body=${JSON.stringify(Option.match(safeBody, { onNone: () => null, onSome: (body) => body }))}; ` +
        `setCookieNames=${JSON.stringify(cookieNames)}; ` +
        `fixtureUserPresent=${state.userPresent}; fixtureSessionCount=${state.sessionCount}`,
    );
  });

const readProviderSession = (
  auth: ProviderAuth,
  headers: Headers,
): Effect.Effect<Option.Option<ProviderSession>, unknown> =>
  Effect.gen(function* readProviderSessionEffect() {
    const result = yield* Effect.tryPromise({
      catch: (cause) => cause,
      try: () =>
        auth.api.getSession({
          headers,
          query: { disableCookieCache: true, disableRefresh: true },
          returnHeaders: true,
        }),
    });
    if (result === null) {
      return Option.none<ProviderSession>();
    }
    const response = Schema.decodeUnknownSync(ProviderSessionResponseSchema)(result.response);
    return Option.some({
      createdAt: dateFromProvider(response.session.createdAt),
      expiresAt: dateFromProvider(response.session.expiresAt),
      headers: result.headers,
      sessionId: response.session.id,
      updatedAt: dateFromProvider(response.session.updatedAt),
      userId: response.user.id,
    });
  });

const readSessionRow = (database: ProviderDatabase, sessionId: string) =>
  database.executor
    .select({
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      updatedAt: session.updatedAt,
      userId: session.userId,
    })
    .from(session)
    .where(eq(session.id, sessionId))
    .limit(1)
    .pipe(Effect.map((rows) => rows.at(0) ?? null));

const readActiveRows = (database: ProviderDatabase, userId: string) =>
  database.executor
    .select({
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      userId: session.userId,
    })
    .from(session)
    .where(eq(session.userId, userId))
    .pipe(
      Effect.flatMap((rows) =>
        DateTime.nowAsDate.pipe(
          Effect.map((now) => {
            const nowMillis = now.getTime();
            return rows.filter(
              (row) =>
                row.userId === userId &&
                row.createdAt.getTime() <= nowMillis &&
                row.expiresAt.getTime() > nowMillis &&
                row.createdAt.getTime() + COMMERCE_PORTAL_AUTH_POLICY.session.absoluteLifetimeSeconds * 1000 >
                  nowMillis,
            );
          }),
        ),
      ),
    );

const setSessionTemporalState = (
  database: ProviderDatabase,
  sessionId: string,
  temporalState: { readonly createdAt: Date; readonly expiresAt: Date; readonly updatedAt: Date },
) => database.executor.update(session).set(temporalState).where(eq(session.id, sessionId));

const readWaitingLockCount = (database: ProviderDatabase): Effect.Effect<number, unknown> =>
  database.executor
    .execute(
      sql<{ readonly count: number }>`
        SELECT count(*)::int AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
      `,
      'objects',
    )
    .pipe(
      Effect.map((rows) => {
        const decoded = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ count: Schema.Number })))(rows);
        return decoded[0]?.count ?? 0;
      }),
    );

const awaitWaitingLocks = (database: ProviderDatabase, expectedCount: number): Effect.Effect<void, unknown> =>
  Effect.gen(function* awaitWaitingLocksEffect() {
    const deadline = (yield* TestClock.withLive(DateTime.nowAsDate)).getTime() + LOCK_WAIT_DEADLINE_MILLIS;
    let waitingCount = yield* readWaitingLockCount(database);
    while (waitingCount < expectedCount) {
      const now = yield* TestClock.withLive(DateTime.nowAsDate);
      if (now.getTime() >= deadline) {
        return yield* Effect.fail(
          new Error(`Expected ${expectedCount} PostgreSQL lock waiters, observed ${waitingCount} before deadline`),
        );
      }
      yield* TestClock.withLive(Effect.sleep(Duration.millis(LOCK_WAIT_POLL_MILLIS)));
      waitingCount = yield* readWaitingLockCount(database);
    }
    return yield* Effect.void;
  }).pipe(Effect.provide(TestClock.layer()));

const cleanupFixture = (fixture: ProviderFixture) =>
  fixture.database.executor.transaction((transaction) =>
    Effect.gen(function* cleanupProviderFixture() {
      yield* transaction.delete(user).where(eq(user.email, fixture.email));
      yield* transaction.delete(verification).where(eq(verification.identifier, fixture.email));
      yield* transaction.delete(rateLimit).where(like(rateLimit.key, `%${fixture.ipPrefix}%`));
    }),
  );

const publicSignIn = (fixture: ProviderFixture, ip: string): Effect.Effect<Response, unknown> => {
  const headers = requestHeaders(ip);
  headers.set('content-type', 'application/json');
  return fixture.handler(
    new Request(`${ORIGIN}/api/portal-auth/sign-in/email`, {
      body: JSON.stringify({ email: fixture.email, password: fixture.password }),
      headers,
      method: 'POST',
    }),
  );
};

const publicRefresh = (fixture: ProviderFixture, headers: Headers): Effect.Effect<Response, unknown> => {
  const requestHeadersForRefresh = new Headers(headers);
  requestHeadersForRefresh.set('content-type', 'application/json');
  return fixture.handler(
    new Request(`${ORIGIN}/api/portal-auth/refresh`, {
      body: '{}',
      headers: requestHeadersForRefresh,
      method: 'POST',
    }),
  );
};

const makeProviderFixture = Effect.fn('CommercePortalAuthProviderIntegration.makeFixture')(function* makeFixture(
  caseName: string,
  ipPrefix: string,
): Effect.fn.Return<ProviderFixture, unknown, Scope.Scope> {
  const connectionString = yield* DATABASE_URL;
  const configuration = yield* parseCommercePortalAuthConfig({
    COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(connectionString),
    COMMERCE_PORTAL_AUTH_SECRET: SECRET,
    COMMERCE_PORTAL_AUTH_URL: ORIGIN,
  });
  const database = yield* makeCommercePortalAuthDatabase(configuration);
  const verificationTokens: string[] = [];
  const auth = yield* makeCommercePortalAuth({
    configuration,
    databaseAdapter: database.adapter,
    emailDelivery: {
      sendOTP: () => Promise.resolve(),
      sendResetPassword: () => Promise.resolve(),
      sendVerificationEmail: ({ token }) => {
        verificationTokens.push(token);
        return Promise.resolve();
      },
    },
  });
  const email = `session-provider-${caseName}-${randomUUID()}@example.test`;
  const signUpHeaders = requestHeaders(`${ipPrefix}1`);
  yield* Effect.tryPromise({
    catch: (cause) => cause,
    try: () =>
      auth.api.signUpEmail({
        body: { email, name: 'Provider integration fixture', password: PASSWORD },
        headers: signUpHeaders,
        returnHeaders: true,
      }),
  });
  const verificationToken = verificationTokens.at(-1);
  if (verificationToken === undefined) {
    return yield* Effect.fail(new Error('Provider fixture did not receive an email verification token'));
  }
  yield* Effect.tryPromise({
    catch: (cause) => cause,
    try: () =>
      auth.api.verifyEmail({
        headers: signUpHeaders,
        query: { token: verificationToken },
        returnHeaders: true,
      }),
  });
  const store = makeCommercePortalAuthSessionStore(database.executor);
  const lifecycle = makeCommercePortalAuthSessionLifecycle(store, makeCommercePortalAuthSessionProvider(auth));
  const app = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(CommercePortalAuthSessionApi).pipe(
          Layer.provide(portalAuthSessionStandaloneApiLive),
          Layer.provide(Layer.succeed(CommercePortalAuthSessionLifecycle, lifecycle)),
          Layer.provide(Layer.succeed(CommercePortalAuthService, { api: auth.api })),
          Layer.provide(Layer.succeed(CommercePortalAuthConfig, configuration)),
          // This fixture drives the real provider through many deliberate sign-ins; the owner's
          // durable budget is exercised by `portal-auth-session.test.ts`, so it grants here.
          Layer.provide(
            Layer.succeed(CommercePortalAuthRecoveryRateLimitService, { consume: () => Effect.succeed(true) }),
          ),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true },
      ),
    ),
    (webHandler) => Effect.promise(webHandler.dispose.bind(webHandler)).pipe(Effect.orDie),
  );
  const handler = (request: Request): Effect.Effect<Response, unknown> =>
    Effect.promise(() => app.handler(request, requestContext));
  return { auth, database, email, handler, ipPrefix, password: PASSWORD };
});

const withFixtureCleanup = (fixture: ProviderFixture) =>
  Effect.addFinalizer(() => cleanupFixture(fixture).pipe(Effect.orDie));

it.live('proves the production Better Auth adapter factory initializes and public sign-in works', () =>
  Effect.scoped(
    Effect.gen(function* providerFactoryAndPublicSignIn() {
      const fixture = yield* makeProviderFixture('signin', '198.51.110.');
      yield* withFixtureCleanup(fixture);

      expect(fixture.auth.options.database).toBeDefined();
      const response = yield* publicSignIn(fixture, `${fixture.ipPrefix}2`);
      yield* assertPublicStatus(fixture, response, 200, 'Public sign-in');
      assertProviderCookieRenewal(response.headers);
      const body = yield* Effect.tryPromise({
        catch: (cause) => cause,
        try: () => response.json(),
      });
      const serializedBody = JSON.stringify(body);
      expect(/token|password/iu.test(serializedBody)).toBe(false);

      const browserHeaders = browserHeadersFrom(response.headers, requestHeaders(`${fixture.ipPrefix}2`));
      expect(hasBrowserSessionCookie(browserHeaders)).toBe(true);
      const providerSession = yield* readProviderSession(fixture.auth, browserHeaders);
      if (Option.isNone(providerSession)) {
        throw new Error('Public sign-in did not establish a provider session');
      }
      expect(providerSession.value.userId.length).toBeGreaterThan(0);
      const row = yield* readSessionRow(fixture.database, providerSession.value.sessionId);
      expect(row).not.toBeNull();
    }),
  ),
);

it.live('renews cookies on repeated explicit refreshes while keeping DB inactivity and absolute bounds', () =>
  Effect.scoped(
    Effect.gen(function* providerRefreshProof() {
      const fixture = yield* makeProviderFixture('refresh', '198.51.120.');
      yield* withFixtureCleanup(fixture);

      const signInResponse = yield* publicSignIn(fixture, `${fixture.ipPrefix}2`);
      yield* assertPublicStatus(fixture, signInResponse, 200, 'Refresh proof sign-in');
      assertProviderCookieRenewal(signInResponse.headers);
      const browserHeaders = browserHeadersFrom(signInResponse.headers, requestHeaders(`${fixture.ipPrefix}2`));
      const initial = yield* readProviderSession(fixture.auth, browserHeaders);
      if (Option.isNone(initial)) {
        throw new Error('Provider sign-in did not return a session for refresh proof');
      }
      const initialRow = yield* readSessionRow(fixture.database, initial.value.sessionId);
      if (initialRow === null) {
        throw new Error('Provider sign-in session row was not persisted');
      }
      let previousExpiry = initialRow.expiresAt.getTime();

      for (const refreshIndex of [0, 1, 2]) {
        const refreshStartedAt = yield* DateTime.nowAsDate;
        const response = yield* publicRefresh(fixture, browserHeaders);
        yield* assertPublicStatus(fixture, response, 200, `Public refresh ${refreshIndex}`);
        assertProviderCookieRenewal(response.headers);
        applySetCookies(browserHeaders, splitSetCookieHeader(response.headers.get('set-cookie') ?? ''));
        expect(hasBrowserSessionCookie(browserHeaders)).toBe(true);

        const refreshed = yield* readProviderSession(fixture.auth, browserHeaders);
        if (Option.isNone(refreshed)) {
          throw new Error(`Provider refresh ${refreshIndex} lost the browser session`);
        }
        expect(refreshed.value.sessionId).toBe(initial.value.sessionId);
        const row = yield* readSessionRow(fixture.database, initial.value.sessionId);
        if (row === null) {
          throw new Error(`Provider refresh ${refreshIndex} removed the session row`);
        }
        const now = yield* DateTime.nowAsDate;
        const absoluteBound =
          row.createdAt.getTime() + COMMERCE_PORTAL_AUTH_POLICY.session.absoluteLifetimeSeconds * 1000;
        const inactivityBound =
          now.getTime() + COMMERCE_PORTAL_AUTH_POLICY.session.inactivityLifetimeSeconds * 1000 + 1000;
        expect(row.expiresAt.getTime() >= previousExpiry).toBe(true);
        expect(row.expiresAt.getTime() <= absoluteBound).toBe(true);
        expect(row.expiresAt.getTime() <= inactivityBound).toBe(true);
        expect(row.expiresAt.getTime() - row.updatedAt.getTime()).toBeLessThanOrEqual(
          COMMERCE_PORTAL_AUTH_POLICY.session.inactivityLifetimeSeconds * 1000 + 1000,
        );
        expect(now.getTime() - refreshStartedAt.getTime() < 900_000).toBe(true);
        previousExpiry = row.expiresAt.getTime();
      }

      const nearDeadlineNow = yield* DateTime.nowAsDate;
      const nearDeadlineCreatedAt = new Date(
        nearDeadlineNow.getTime() - COMMERCE_PORTAL_AUTH_POLICY.session.absoluteLifetimeSeconds * 1000 + 10_000,
      );
      yield* setSessionTemporalState(fixture.database, initial.value.sessionId, {
        createdAt: nearDeadlineCreatedAt,
        expiresAt: new Date(
          nearDeadlineNow.getTime() + COMMERCE_PORTAL_AUTH_POLICY.session.inactivityLifetimeSeconds * 1000,
        ),
        updatedAt: nearDeadlineNow,
      });
      const nearDeadlineResponse = yield* publicRefresh(fixture, browserHeaders);
      yield* assertPublicStatus(fixture, nearDeadlineResponse, 200, 'Near-deadline public refresh');
      assertProviderCookieRenewal(nearDeadlineResponse.headers);
      applySetCookies(browserHeaders, splitSetCookieHeader(nearDeadlineResponse.headers.get('set-cookie') ?? ''));
      const nearDeadlineSession = yield* readProviderSession(fixture.auth, browserHeaders);
      if (Option.isNone(nearDeadlineSession)) {
        throw new Error('Near-deadline provider refresh lost the browser session');
      }
      expect(nearDeadlineSession.value.sessionId).toBe(initial.value.sessionId);
      const nearDeadlineRow = yield* readSessionRow(fixture.database, initial.value.sessionId);
      if (nearDeadlineRow === null) {
        throw new Error('Near-deadline provider refresh removed the session row');
      }
      const nearDeadlineAbsoluteBound =
        nearDeadlineRow.createdAt.getTime() + COMMERCE_PORTAL_AUTH_POLICY.session.absoluteLifetimeSeconds * 1000;
      expect(nearDeadlineRow.expiresAt.getTime() > nearDeadlineNow.getTime()).toBe(true);
      expect(nearDeadlineRow.expiresAt.getTime() <= nearDeadlineAbsoluteBound).toBe(true);

      const pastDeadlineNow = yield* DateTime.nowAsDate;
      const pastDeadlineCreatedAt = new Date(
        pastDeadlineNow.getTime() - COMMERCE_PORTAL_AUTH_POLICY.session.absoluteLifetimeSeconds * 1000 - 1000,
      );
      yield* setSessionTemporalState(fixture.database, initial.value.sessionId, {
        createdAt: pastDeadlineCreatedAt,
        expiresAt: new Date(
          pastDeadlineNow.getTime() + COMMERCE_PORTAL_AUTH_POLICY.session.inactivityLifetimeSeconds * 1000,
        ),
        updatedAt: pastDeadlineNow,
      });
      const pastDeadlineResponse = yield* publicRefresh(fixture, browserHeaders);
      // `refresh` publishes expiry as a declared 200 success variant, not a problem: the caller
      // learns when the session died and can start a fresh sign-in without parsing an error body.
      expect(pastDeadlineResponse.status).toBe(200);
      const pastDeadlineBody = yield* Effect.tryPromise({
        catch: (cause) => cause,
        try: () => pastDeadlineResponse.json(),
      });
      // Decoding proves the wire shape: `expiredAt` is a real UTC instant, not any string.
      const pastDeadlineExpiry = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ expiredAt: Schema.DateTimeUtcFromString, outcome: Schema.Literal('SESSION_EXPIRED') }),
      )(pastDeadlineBody);
      expect(pastDeadlineExpiry.outcome).toBe('SESSION_EXPIRED');
      const pastDeadlineRow = yield* readSessionRow(fixture.database, initial.value.sessionId);
      if (pastDeadlineRow === null) {
        throw new Error('Past-deadline provider refresh removed the session row');
      }
      expect(pastDeadlineRow.createdAt.getTime()).toBe(pastDeadlineCreatedAt.getTime());
      expect(pastDeadlineRow.expiresAt.getTime() <= pastDeadlineNow.getTime()).toBe(true);
    }),
  ),
);

it.live('admits exactly one concurrent public sign-in at the five-session cap', () =>
  Effect.scoped(
    Effect.gen(function* providerConcurrentSignInProof() {
      const fixture = yield* makeProviderFixture('cap', '198.51.130.');
      yield* withFixtureCleanup(fixture);

      const setupResponses: Response[] = [];
      for (const ipSuffix of [2, 3, 4, 5]) {
        setupResponses.push(yield* publicSignIn(fixture, `${fixture.ipPrefix}${ipSuffix}`));
      }
      for (const response of setupResponses) {
        yield* assertPublicStatus(fixture, response, 200, 'Concurrent proof setup sign-in');
      }
      const firstBrowserHeaders = browserHeadersFrom(
        setupResponses[0]?.headers ?? new Headers(),
        requestHeaders(`${fixture.ipPrefix}2`),
      );
      const firstSession = yield* readProviderSession(fixture.auth, firstBrowserHeaders);
      if (Option.isNone(firstSession)) {
        throw new Error('The first setup sign-in did not establish a provider session');
      }
      const before = yield* readActiveRows(fixture.database, firstSession.value.userId);
      expect(before.length).toBe(4);

      const lockAcquired = yield* Deferred.make<null>();
      const releaseLock = yield* Deferred.make<null>();
      const subjectLock = yield* Effect.forkScoped(
        fixture.database.executor.transaction((transaction) =>
          Effect.gen(function* holdSubjectLock() {
            const locked = yield* transaction
              .select({ id: user.id })
              .from(user)
              .where(eq(user.id, firstSession.value.userId))
              .for('update');
            if (locked.length === 0) {
              return yield* Effect.fail(
                new Error('The provider fixture subject row disappeared before contention proof'),
              );
            }
            yield* Deferred.succeed(lockAcquired, null);
            yield* Deferred.await(releaseLock);
            return yield* Effect.succeed(null);
          }),
        ),
      );
      yield* Deferred.await(lockAcquired);

      const concurrentFibers = yield* Effect.forEach(
        [6, 7, 8, 9, 10],
        (ipSuffix) => Effect.forkScoped(publicSignIn(fixture, `${fixture.ipPrefix}${ipSuffix}`)),
        { concurrency: 'unbounded' },
      );
      const concurrent = yield* Effect.ensuring(
        Effect.gen(function* releaseSubjectLock() {
          yield* awaitWaitingLocks(fixture.database, 5);
          yield* Deferred.succeed(releaseLock, null);
          return yield* Effect.forEach(concurrentFibers, Fiber.join, { concurrency: 'unbounded' });
        }),
        Deferred.succeed(releaseLock, null).pipe(Effect.asVoid),
      );
      yield* Fiber.join(subjectLock);
      const successful = concurrent.filter((response) => response.status === 200).length;
      const rejected = concurrent.filter((response) => response.status === 403).length;
      expect(concurrent.length).toBe(5);
      expect(successful).toBe(1);
      expect(rejected).toBe(4);
      for (const response of concurrent.filter((candidate) => candidate.status === 403)) {
        const body = yield* Effect.tryPromise({
          catch: (cause) => cause,
          try: () => response.json(),
        });
        // The device cap has its own published code: it is a policy refusal whose remedy is ending
        // another session, never a throttle window the caller can wait out. The five surviving rows
        // below are the proof that the cap is what refused these four.
        expect(body).toMatchObject({ code: 'session_limit_reached', status: 403 });
      }

      const after = yield* readActiveRows(fixture.database, firstSession.value.userId);
      expect(after.length).toBe(5);
    }),
  ),
);
