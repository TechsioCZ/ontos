import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { Context, Effect, Layer, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CommercePortalAuthConfig } from '../../api/portal-auth/provider/config-service.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../../api/portal-auth/provider/config.ts';
import type { CommercePortalAuthConfigValue } from '../../api/portal-auth/provider/config.ts';
import {
  COMMERCE_PORTAL_AUTH_SESSION_PUBLIC_ROUTE_ALLOWLIST,
  CommercePortalAuthProviderSubjectIdSchema,
} from '../../api/portal-auth/session/contracts.ts';
import type {
  CommercePortalAuthSessionSignInResult,
  CommercePortalAuthSessionSnapshot,
} from '../../api/portal-auth/session/contracts.ts';
import { CommercePortalAuthService, portalAuthSessionStandaloneApiLive } from '../../api/portal-auth/session/http.ts';
import { CommercePortalAuthSessionLifecycle } from '../../api/portal-auth/session/lifecycle.ts';
import type { CommercePortalAuthSessionLifecycleService } from '../../api/portal-auth/session/lifecycle.ts';
import { CommercePortalAuthRecoveryRateLimitService } from '../../api/portal-auth/rate-limit-service.ts';
import type { CommercePortalAuthRecoveryRateLimit } from '../../api/portal-auth/rate-limit-service.ts';
import { CommercePortalAuthSessionApi } from '../../shared/portal-auth/session-api.ts';

const trustedOrigin = 'https://portal.example.test';
const signInCookie = 'commerce-portal.session_token=redacted; Path=/; HttpOnly; Secure; SameSite=Lax';
const challengeCookie = 'commerce-portal.two_factor=challenge; Path=/; HttpOnly; Secure; SameSite=Lax';
const requestContext = Context.makeUnsafe<unknown>(new Map());

const configuration: CommercePortalAuthConfigValue = {
  baseUrl: trustedOrigin,
  connectionString: Redacted.make('postgres://unused.example.test/unused'),
  nodeEnvironment: 'test',
  policy: COMMERCE_PORTAL_AUTH_POLICY,
  secret: Redacted.make('s'.repeat(64)),
  secureCookies: true,
  trustedOrigins: [trustedOrigin],
  trustedProxies: [],
  versionedSecrets: [],
};

const snapshot: CommercePortalAuthSessionSnapshot = {
  authenticatedAt: new Date('2026-01-01T00:00:00.000Z'),
  authenticationNamespaceId: 'ontos.commerce.portal.better-auth.v1',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  expiresAt: new Date('2026-01-01T01:00:00.000Z'),
  policyVersion: COMMERCE_PORTAL_AUTH_POLICY.policyVersion,
  providerSubjectId: Schema.decodeUnknownSync(CommercePortalAuthProviderSubjectIdSchema)('commerce-user-1'),
  sessionRef: 'better-auth-session:ontos.commerce.portal.better-auth.v1:session-safe',
  subjectType: 'user',
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

/** Any call is a contract breach: these routes must reach the provider only past the origin guard. */
const unusedLifecycle: CommercePortalAuthSessionLifecycleService = {
  disableAccount: () => Effect.die('unused lifecycle double'),
  evidenceForSession: () => Effect.die('unused lifecycle double'),
  refresh: () => Effect.die('unused lifecycle double'),
  revoke: () => Effect.die('unused lifecycle double'),
  revokeAll: () => Effect.die('unused lifecycle double'),
  rotateIdentifierForCookie: () => Effect.die('unused lifecycle double'),
  signIn: () => Effect.die('unused lifecycle double'),
  signOut: () => Effect.die('unused lifecycle double'),
};

const providerRealm = betterAuth({
  baseURL: trustedOrigin,
  database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
  emailAndPassword: { enabled: true },
  trustedOrigins: [trustedOrigin],
});

/**
 * The deployment's durable counter store, in memory: the same key shape and the same denial the
 * production store answers with once a window's budget is spent.
 */
const makeCountingBudget = (): CommercePortalAuthRecoveryRateLimit => {
  const spent = new Map<string, number>();
  return {
    consume: (key, rule) =>
      Effect.sync(() => {
        const next = (spent.get(key) ?? 0) + 1;
        spent.set(key, next);
        return next <= rule.max;
      }),
  };
};

/** `updateAge: 0` is the production posture: every read renews the provider session cookie. */
const renewingRealm = betterAuth({
  baseURL: trustedOrigin,
  database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
  emailAndPassword: { enabled: true },
  session: { updateAge: 0 },
  trustedOrigins: [trustedOrigin],
});

const makeApp = (
  lifecycle: CommercePortalAuthSessionLifecycleService,
  budget: CommercePortalAuthRecoveryRateLimit = makeCountingBudget(),
  api: CommercePortalAuthService['Service']['api'] = providerRealm.api,
) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(CommercePortalAuthSessionApi).pipe(
          Layer.provide(portalAuthSessionStandaloneApiLive),
          Layer.provide(Layer.succeed(CommercePortalAuthSessionLifecycle, lifecycle)),
          Layer.provide(Layer.succeed(CommercePortalAuthService, { api })),
          Layer.provide(Layer.succeed(CommercePortalAuthConfig, configuration)),
          Layer.provide(Layer.succeed(CommercePortalAuthRecoveryRateLimitService, budget)),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true },
      ),
    ),
    (app) => Effect.promise(app.dispose.bind(app)).pipe(Effect.orDie),
  );

type SessionApp = Effect.Success<ReturnType<typeof makeApp>>;

const post = (app: SessionApp) => (route: string, body: string, origin?: string) =>
  Effect.promise(() =>
    app.handler(
      new Request(`${trustedOrigin}${route}`, {
        body,
        headers:
          origin === undefined
            ? { 'content-type': 'application/json' }
            : { 'content-type': 'application/json', Origin: origin },
        method: 'POST',
      }),
      requestContext,
    ),
  );

const postWithCookie = (app: SessionApp) => (route: string, body: string, cookie: string) =>
  Effect.promise(() =>
    app.handler(
      new Request(`${trustedOrigin}${route}`, {
        body,
        headers: { 'content-type': 'application/json', cookie, Origin: trustedOrigin },
        method: 'POST',
      }),
      requestContext,
    ),
  );

const jsonBody = (response: Response) => Effect.promise(response.clone().json.bind(response.clone()));

it('publishes only the explicitly reviewed provider routes', () => {
  expect(COMMERCE_PORTAL_AUTH_SESSION_PUBLIC_ROUTE_ALLOWLIST).toEqual([
    '/get-session',
    '/refresh',
    '/sign-in/email',
    '/sign-out',
  ]);
  expect(COMMERCE_PORTAL_AUTH_SESSION_PUBLIC_ROUTE_ALLOWLIST).not.toContain('/sign-up/email');
});

it.effect('rejects missing or untrusted Origin before invoking cookie state changes', () =>
  Effect.scoped(
    Effect.gen(function* originAssertions() {
      const app = yield* makeApp(unusedLifecycle);
      const send = post(app);
      const missing = yield* send('/api/portal-auth/sign-out', '{}');
      const crossOrigin = yield* send('/api/portal-auth/sign-out', '{}', 'https://attacker.example.test');
      expect(missing.status).toBe(403);
      expect(crossOrigin.status).toBe(403);
      const missingBody = yield* jsonBody(missing);
      expect(missingBody).toMatchObject({ code: 'origin_not_trusted', status: 403 });
    }),
  ),
);

it.effect('keeps signup private and answers sign-in with the owner session projection', () =>
  Effect.scoped(
    Effect.gen(function* routeAssertions() {
      let signInCalls = 0;
      const signInResult: CommercePortalAuthSessionSignInResult = {
        outcome: { outcome: 'SESSION_CREATED', session: snapshot },
        setCookieHeaders: [signInCookie],
      };
      const app = yield* makeApp({
        ...unusedLifecycle,
        signIn: () => {
          signInCalls += 1;
          return Effect.succeed(signInResult);
        },
      });
      const send = post(app);

      const signup = yield* send('/api/portal-auth/sign-up/email', '{}', trustedOrigin);
      expect(signup.status).toBe(404);
      expect(signInCalls).toBe(0);

      const signIn = yield* send(
        '/api/portal-auth/sign-in/email',
        JSON.stringify({ email: 'buyer@example.test', password: 'P'.repeat(24) }),
        trustedOrigin,
      );
      const body = yield* jsonBody(signIn);
      expect(signIn.status).toBe(200);
      expect(body).toStrictEqual({
        outcome: 'SESSION_CREATED',
        session: {
          authenticatedAt: '2026-01-01T00:00:00.000Z',
          authenticationNamespaceId: 'ontos.commerce.portal.better-auth.v1',
          createdAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-01-01T01:00:00.000Z',
          policyVersion: COMMERCE_PORTAL_AUTH_POLICY.policyVersion,
          providerSubjectId: 'commerce-user-1',
          sessionRef: 'better-auth-session:ontos.commerce.portal.better-auth.v1:session-safe',
          subjectType: 'user',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      });
      expect(JSON.stringify(body)).not.toContain('token');
      expect(signIn.headers.get('set-cookie')).toContain('HttpOnly');
      expect(signIn.headers.get('cache-control')).toBe('no-store');
      expect(signInCalls).toBe(1);

      const callbackAttempt = yield* send(
        '/api/portal-auth/sign-in/email',
        JSON.stringify({
          callbackURL: 'https://attacker.example.test',
          email: 'buyer@example.test',
          password: 'P'.repeat(24),
        }),
        trustedOrigin,
      );
      expect(callbackAttempt.status).toBe(400);
      expect(signInCalls).toBe(1);
    }),
  ),
);

it.effect('returns a typed pending MFA response while forwarding only provider cookies', () =>
  Effect.scoped(
    Effect.gen(function* pendingMfaAssertions() {
      const pendingResult: CommercePortalAuthSessionSignInResult = {
        outcome: { methods: ['totp'], outcome: 'MFA_REQUIRED' },
        setCookieHeaders: [challengeCookie],
      };
      const app = yield* makeApp({ ...unusedLifecycle, signIn: () => Effect.succeed(pendingResult) });
      const pending = yield* post(app)(
        '/api/portal-auth/sign-in/email',
        JSON.stringify({ email: 'buyer@example.test', password: 'P'.repeat(24) }),
        trustedOrigin,
      );
      const body = yield* jsonBody(pending);
      expect(pending.status).toBe(200);
      expect(body).toStrictEqual({ methods: ['totp'], outcome: 'MFA_REQUIRED' });
      expect(pending.headers.get('set-cookie')).toContain('commerce-portal.two_factor=challenge');
      expect(JSON.stringify(body)).not.toContain('token');
    }),
  ),
);

it.effect('revokes the owner session and clears every provider cookie on the sign-out route', () =>
  Effect.scoped(
    Effect.gen(function* signOutAssertions() {
      const signUp = yield* Effect.promise(() =>
        providerRealm.api.signUpEmail({
          body: { email: 'sign-out-owner@example.test', name: 'Sign Out Owner', password: 'P'.repeat(24) },
          headers: new Headers({ origin: trustedOrigin }),
          returnHeaders: true,
        }),
      );
      const browserCookie = signUp.headers
        .getSetCookie()
        .map((header) => header.split(';')[0] ?? '')
        .filter((pair) => pair.length > 0)
        .join('; ');
      expect(browserCookie.length).toBeGreaterThan(0);

      const revoked: string[] = [];
      const app = yield* makeApp({
        ...unusedLifecycle,
        signOut: (input) => {
          revoked.push(input.sessionRef);
          return Effect.succeed({ existed: true, outcome: 'SESSION_REVOKED', sessionRef: input.sessionRef });
        },
      });

      const response = yield* postWithCookie(app)('/api/portal-auth/sign-out', '{}', browserCookie);
      expect(response.status).toBe(200);
      expect(yield* jsonBody(response)).toStrictEqual({ outcome: 'SESSION_REVOKED' });
      expect(response.headers.get('cache-control')).toBe('no-store');
      // The owner lifecycle saw the exact session the provider cookie names, as a safe reference.
      expect(revoked).toHaveLength(1);
      expect(revoked[0]?.startsWith('better-auth-session:')).toBe(true);
      // Every provider cookie is expired on the way out, so a revoked session cannot be replayed.
      const cleared = response.headers.getSetCookie();
      expect(cleared.length).toBeGreaterThan(0);
      expect(cleared.some((header) => /session_token=/u.test(header))).toBe(true);
      expect(cleared.every((header) => /Max-Age=0|Expires=/u.test(header))).toBe(true);
    }),
  ),
);

it.effect('answers an anonymous sign-out without calling the owner lifecycle', () =>
  Effect.scoped(
    Effect.gen(function* anonymousSignOutAssertions() {
      // `unusedLifecycle.signOut` dies on call: reaching it would fail this test rather than pass it.
      const app = yield* makeApp(unusedLifecycle);
      const response = yield* post(app)('/api/portal-auth/sign-out', '{}', trustedOrigin);
      expect(response.status).toBe(200);
      expect(yield* jsonBody(response)).toStrictEqual({ outcome: 'SESSION_REVOKED' });
      expect(response.headers.getSetCookie().length).toBeGreaterThan(0);
    }),
  ),
);

it.effect('bounds password attempts on the owner budget Better Auth never enforces for this route', () =>
  Effect.scoped(
    Effect.gen(function* signInRateLimitAssertions() {
      let attempts = 0;
      const app = yield* makeApp({
        ...unusedLifecycle,
        signIn: () =>
          Effect.sync((): CommercePortalAuthSessionSignInResult => {
            attempts += 1;
            return { outcome: { outcome: 'AUTHENTICATION_FAILED' }, setCookieHeaders: [] };
          }),
      });
      const budget = COMMERCE_PORTAL_AUTH_POLICY.rateLimit.signIn.max;
      const body = JSON.stringify({ email: 'attacker@example.test', password: 'G'.repeat(24) });
      const statuses = yield* Effect.forEach(
        Array.from({ length: budget + 1 }, (_unused, attempt) => attempt),
        () => post(app)('/api/portal-auth/sign-in/email', body, trustedOrigin).pipe(Effect.map((r) => r.status)),
        { concurrency: 1 },
      );
      // `auth.handler` is never mounted, so the provider's own `/sign-in/email` rule never runs;
      // without the owner budget every one of these attempts would reach the credential check.
      expect(statuses).toStrictEqual([...Array.from({ length: budget }, () => 401), 429]);
      expect(attempts).toBe(budget);
      const exhausted = yield* post(app)('/api/portal-auth/sign-in/email', body, trustedOrigin);
      expect(exhausted.status).toBe(429);
      expect(exhausted.headers.get('cache-control')).toBe('no-store');
      expect(yield* jsonBody(exhausted)).toMatchObject({ code: 'rate_limited', status: 429 });
    }),
  ),
);

/**
 * This transport is mounted as a web handler, so no request carries a socket peer and the resolved
 * client is the same unattributable value for everybody. A budget keyed on that value alone would
 * be one counter for the whole deployment: the attempts above would have left every other customer
 * answering 429. The attempted account is part of the key, so an exhausted budget denies exactly
 * the address it was spent on.
 */
it.effect('keeps one caller from spending every other customer sign-in budget', () =>
  Effect.scoped(
    Effect.gen(function* signInBudgetIsolationAssertions() {
      const app = yield* makeApp({
        ...unusedLifecycle,
        signIn: () =>
          Effect.succeed<CommercePortalAuthSessionSignInResult>({
            outcome: { outcome: 'AUTHENTICATION_FAILED' },
            setCookieHeaders: [],
          }),
      });
      const budget = COMMERCE_PORTAL_AUTH_POLICY.rateLimit.signIn.max;
      const attempt = (email: string) =>
        post(app)(
          '/api/portal-auth/sign-in/email',
          JSON.stringify({ email, password: 'G'.repeat(24) }),
          trustedOrigin,
        ).pipe(Effect.map((response) => response.status));

      const targeted = yield* Effect.forEach(
        Array.from({ length: budget + 1 }, (_unused, index) => index),
        () => attempt('targeted@example.test'),
        { concurrency: 1 },
      );
      expect(targeted).toStrictEqual([...Array.from({ length: budget }, () => 401), 429]);

      // The same window, a different account: the deployment still signs its customers in.
      expect(yield* attempt('bystander@example.test')).toBe(401);
      // Casing names the same account, so a re-cased address cannot mint itself a fresh budget.
      expect(yield* attempt('TARGETED@example.test')).toBe(429);
    }),
  ),
);

/**
 * A sign-in body is a CORS simple request, so a third-party page can drive a visitor's browser into
 * this handler without a preflight. The trusted-origin list is the only CSRF authority for the
 * route, and it must refuse such a request before the durable budget is touched — otherwise the
 * page could exhaust the visitor's own sign-in budget and collect its 403 afterwards.
 */
it.effect('refuses a cross-origin sign-in before it can spend the budget', () =>
  Effect.scoped(
    Effect.gen(function* crossOriginBudgetAssertions() {
      let attempts = 0;
      const app = yield* makeApp({
        ...unusedLifecycle,
        signIn: () =>
          Effect.sync((): CommercePortalAuthSessionSignInResult => {
            attempts += 1;
            return { outcome: { outcome: 'AUTHENTICATION_FAILED' }, setCookieHeaders: [] };
          }),
      });
      const budget = COMMERCE_PORTAL_AUTH_POLICY.rateLimit.signIn.max;
      const body = JSON.stringify({ email: 'victim@example.test', password: 'G'.repeat(24) });
      const forged = yield* Effect.forEach(
        Array.from({ length: budget + 1 }, (_unused, index) => index),
        () =>
          post(app)('/api/portal-auth/sign-in/email', body, 'https://attacker.example.test').pipe(
            Effect.map((response) => response.status),
          ),
        { concurrency: 1 },
      );
      expect(forged).toStrictEqual(Array.from({ length: budget + 1 }, () => 403));
      expect(attempts).toBe(0);

      // The victim's own budget is untouched: the first genuine attempt still reaches the provider.
      const genuine = yield* post(app)('/api/portal-auth/sign-in/email', body, trustedOrigin);
      expect(genuine.status).toBe(401);
      expect(attempts).toBe(1);
    }),
  ),
);

/**
 * The concurrent-device cap is not the attempt throttle: waiting out a throttle window never clears
 * it, so it must not be published as a 429 carrying the sign-in window as `retryAfterSeconds`.
 */
it.effect('answers the concurrent-session cap with its own code instead of the attempt throttle', () =>
  Effect.scoped(
    Effect.gen(function* sessionCapAssertions() {
      const app = yield* makeApp({
        ...unusedLifecycle,
        signIn: () =>
          Effect.succeed<CommercePortalAuthSessionSignInResult>({
            outcome: { outcome: 'SESSION_LIMIT_REACHED' },
            setCookieHeaders: [signInCookie],
          }),
      });
      const response = yield* post(app)(
        '/api/portal-auth/sign-in/email',
        JSON.stringify({ email: 'capped@example.test', password: 'P'.repeat(24) }),
        trustedOrigin,
      );
      expect(response.status).toBe(403);
      const body = yield* jsonBody(response);
      expect(body).toMatchObject({ code: 'session_limit_reached', status: 403 });
      expect(body).not.toHaveProperty('retryAfterSeconds');
      // A refused admission never hands the provider cookie to the browser.
      expect(response.headers.getSetCookie()).toStrictEqual([]);
    }),
  ),
);

it.effect('never renews the browser session cookie on a rejected refresh', () =>
  Effect.scoped(
    Effect.gen(function* rejectedRefreshAssertions() {
      const signUp = yield* Effect.promise(() =>
        renewingRealm.api.signUpEmail({
          body: { email: 'refresh-rejected@example.test', name: 'Refresh Rejected', password: 'P'.repeat(24) },
          headers: new Headers({ origin: trustedOrigin }),
          returnHeaders: true,
        }),
      );
      const browserCookie = signUp.headers
        .getSetCookie()
        .map((header) => header.split(';')[0] ?? '')
        .filter((pair) => pair.length > 0)
        .join('; ');
      expect(browserCookie.length).toBeGreaterThan(0);

      // The subject is banned out-of-band while the session row is still live, so the lifecycle
      // rejects the refresh after the provider read that already renewed the cookie: the 403 must
      // not carry that renewed credential.
      const app = yield* makeApp(
        {
          ...unusedLifecycle,
          refresh: () => Effect.succeed({ outcome: 'ACCOUNT_DISABLED' as const, providerSubjectId: 'banned-subject' }),
        },
        makeCountingBudget(),
        renewingRealm.api,
      );
      const response = yield* postWithCookie(app)('/api/portal-auth/refresh', '{}', browserCookie);
      expect(response.status).toBe(403);
      expect(yield* jsonBody(response)).toMatchObject({ code: 'account_disabled', status: 403 });
      expect(response.headers.getSetCookie()).toStrictEqual([]);

      // The same read on an admitted refresh does hand the renewed cookie onward, so the assertion
      // above is about the rejection, not about a provider that never renews.
      const admitted = yield* makeApp(
        {
          ...unusedLifecycle,
          refresh: () =>
            Effect.succeed({
              identifierRotated: false as const,
              outcome: 'SESSION_REFRESHED' as const,
              session: snapshot,
            }),
        },
        makeCountingBudget(),
        renewingRealm.api,
      );
      const renewed = yield* postWithCookie(admitted)('/api/portal-auth/refresh', '{}', browserCookie);
      expect(renewed.status).toBe(200);
      expect(renewed.headers.getSetCookie().length).toBeGreaterThan(0);
    }),
  ),
);
