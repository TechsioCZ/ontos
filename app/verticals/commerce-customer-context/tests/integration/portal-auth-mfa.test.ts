import { createHmac } from 'node:crypto';

import { betterAuth } from 'better-auth/minimal';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { splitSetCookieHeader, applySetCookies, parseCookies } from 'better-auth/cookies';
import type { Auth } from 'better-auth';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { Context, Effect, Layer, Option, Redacted, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { OTPOptions } from 'better-auth/plugins/two-factor';
import { twoFactor } from 'better-auth/plugins/two-factor';

import {
  COMMERCE_PORTAL_AUTH_MFA_POLICY,
  CommercePortalAuthMfaProviderRejected,
  CommercePortalAuthMfaProviderService,
  CommercePortalAuthMfaRateLimited,
  commercePortalAuthMfaProblemForFailure,
  commercePortalAuthMfaTrustDeviceProblem,
  createCommercePortalAuthTwoFactorPlugin,
  makeCommercePortalAuthMfaProvider,
  makeCommercePortalAuthMfaStepUpCodeVerifier,
  makeCommercePortalAuthMfaService,
  narrowCommercePortalAuthMfaTrustDevice,
} from '../../api/portal-auth/provider/mfa/index.ts';
import type { CommercePortalAuthMfaProviderFailure } from '../../api/portal-auth/provider/mfa/index.ts';
import { portalAuthMfaApiLive } from '../../api/portal-auth/provider/mfa/http.ts';
import { UNRESOLVED_PORTAL_AUTH_CLIENT_KEY } from '../../api/portal-auth/http-transport.ts';
import { CommercePortalAuthRecoveryRateLimitService } from '../../api/portal-auth/rate-limit-service.ts';
import type { CommercePortalAuthRecoveryRateLimit } from '../../api/portal-auth/rate-limit-service.ts';
import { CommercePortalAuthMfaService } from '../../api/portal-auth/provider/mfa/service.ts';
import { CommercePortalAuthStepUpCodeRejected } from '../../api/portal-auth/provider/step-up/index.ts';
import { CommercePortalAuthConfig } from '../../api/portal-auth/provider/config-service.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../../api/portal-auth/provider/config.ts';
import type { CommercePortalAuthConfigValue } from '../../api/portal-auth/provider/config.ts';
import { CommercePortalAuthMfaApi } from '../../shared/portal-auth/mfa-api.ts';

const ORIGIN = 'https://commerce.example.test';
const BASE_PATH = '/api/portal-auth';
const PASSWORD = 'P'.repeat(24);
const SECRET = 's'.repeat(64);
const otpDeliveryCallback: NonNullable<OTPOptions['sendOTP']> = () => Promise.resolve();

/**
 * The realm's own cookie naming, so every fixture mints the cookies the deployment's transport
 * reads: the MFA budget is keyed on the pending challenge, which it finds by that exact name.
 */
const realmCookies = { cookiePrefix: COMMERCE_PORTAL_AUTH_POLICY.cookie.namePrefix } as const;

const SignUpResponseSchema = Schema.Struct({
  user: Schema.Struct({ id: Schema.String }),
});
const EnableResponseSchema = Schema.Struct({
  backupCodes: Schema.Array(Schema.String),
  method: Schema.Literal('totp'),
  totpURI: Schema.String,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const makeFixture = () => {
  const database = {
    account: [],
    session: [],
    twoFactor: [],
    user: [],
    verification: [],
  };
  const auth = betterAuth({
    advanced: realmCookies,
    basePath: BASE_PATH,
    baseURL: ORIGIN,
    database: memoryAdapter(database),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
    },
    plugins: [
      createCommercePortalAuthTwoFactorPlugin({
        policy: COMMERCE_PORTAL_AUTH_MFA_POLICY,
        sendOTP: otpDeliveryCallback,
      }),
    ],
    secret: SECRET,
    trustedOrigins: [ORIGIN],
  });
  return { auth, database };
};

const makeSkipVerificationFixture = () => {
  const database = {
    account: [],
    session: [],
    twoFactor: [],
    user: [],
    verification: [],
  };
  const auth = betterAuth({
    advanced: realmCookies,
    basePath: BASE_PATH,
    baseURL: ORIGIN,
    database: memoryAdapter(database),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
    },
    plugins: [
      twoFactor({
        accountLockout: {
          durationSeconds: COMMERCE_PORTAL_AUTH_MFA_POLICY.lockoutDurationSeconds,
          enabled: true,
          maxFailedAttempts: COMMERCE_PORTAL_AUTH_MFA_POLICY.maxFailedAttempts + 1,
        },
        allowPasswordless: false,
        backupCodeOptions: { storeBackupCodes: 'encrypted' },
        issuer: 'OntOS Commerce Portal',
        otpOptions: {
          allowedAttempts: COMMERCE_PORTAL_AUTH_MFA_POLICY.maxFailedAttempts,
          digits: COMMERCE_PORTAL_AUTH_MFA_POLICY.otpDigits,
          period: COMMERCE_PORTAL_AUTH_MFA_POLICY.otpPeriodMinutes,
          sendOTP: otpDeliveryCallback,
        },
        skipVerificationOnEnable: true,
        totpOptions: {
          digits: COMMERCE_PORTAL_AUTH_MFA_POLICY.totpDigits,
          period: COMMERCE_PORTAL_AUTH_MFA_POLICY.totpPeriodSeconds,
        },
        trustDeviceMaxAge: COMMERCE_PORTAL_AUTH_MFA_POLICY.trustDeviceMaxAgeSeconds,
        twoFactorCookieMaxAge: COMMERCE_PORTAL_AUTH_MFA_POLICY.challengeMaxAgeSeconds,
      }),
    ],
    secret: SECRET,
    trustedOrigins: [ORIGIN],
  });
  return { auth, database };
};

type SkipVerificationAuth = ReturnType<typeof makeSkipVerificationFixture>['auth'];

const requestHeaders = (cookie?: string): Headers => {
  const headers = new Headers({
    'content-type': 'application/json',
    origin: ORIGIN,
  });
  if (cookie !== undefined) {
    headers.set('cookie', cookie);
  }
  return headers;
};

const request = <AuthValue extends Pick<Auth, 'handler'>>(
  auth: AuthValue,
  route: string,
  body: Schema.Json,
  cookie?: string,
) =>
  Effect.promise(() =>
    auth.handler(
      new Request(`${ORIGIN}${BASE_PATH}${route}`, {
        body: JSON.stringify(body),
        headers: requestHeaders(cookie),
        method: 'POST',
      }),
    ),
  );

const responseBody = <SchemaValue extends Schema.Constraint>(response: Response, schema: SchemaValue) =>
  Effect.promise(() => response.clone().json()).pipe(
    Effect.flatMap((body) => Schema.decodeUnknownEffect(schema)(body)),
  );

const browserHeadersFrom = (response: Response): Headers => {
  const headers = requestHeaders();
  applySetCookies(headers, splitSetCookieHeader(response.headers.get('set-cookie') ?? ''));
  return headers;
};

it.effect('registers the real Better Auth MFA HTTP routes and returns only TOTP setup material', () =>
  Effect.gen(function* realMfaHttpFlow() {
    const { auth } = makeFixture();
    const signUp = yield* request(auth, '/sign-up/email', {
      email: 'mfa-http@example.test',
      name: 'MFA HTTP User',
      password: PASSWORD,
    });
    expect(signUp.status).toBe(200);
    const signUpBody = yield* responseBody(signUp, SignUpResponseSchema);
    expect(signUpBody.user.id.length).toBeGreaterThan(0);

    const enable = yield* request(
      auth,
      '/two-factor/enable',
      { method: 'totp', password: PASSWORD },
      browserHeadersFrom(signUp).get('cookie') ?? undefined,
    );
    expect(enable.status).toBe(200);
    const setup = yield* responseBody(enable, EnableResponseSchema);
    expect(setup.backupCodes.length).toBeGreaterThan(0);
    expect(setup.totpURI.startsWith('otpauth://totp/')).toBe(true);
  }),
);

it.effect('adapts inferred Better Auth endpoints through the typed Effect owner facade', () =>
  Effect.gen(function* typedMfaFacadeFlow() {
    const { auth } = makeFixture();
    const signUp = yield* request(auth, '/sign-up/email', {
      email: 'mfa-facade@example.test',
      name: 'MFA Facade User',
      password: PASSWORD,
    });
    expect(signUp.status).toBe(200);
    const provider = makeCommercePortalAuthMfaProvider(auth.api);
    const service = yield* makeCommercePortalAuthMfaService().pipe(
      Effect.provideService(CommercePortalAuthMfaProviderService, provider),
    );
    const setup = yield* service.enableTwoFactor({
      body: { method: 'totp', password: PASSWORD },
      headers: browserHeadersFrom(signUp),
    });
    expect(setup.body.method).toBe('totp');
    expect(setup.setCookieHeaders).toStrictEqual([]);
    expect('token' in setup.body).toBe(false);
    if (setup.body.method === 'totp') {
      expect(setup.body.backupCodes.length).toBeGreaterThan(0);
      expect(setup.body.totpURI.startsWith('otpauth://totp/')).toBe(true);
    } else {
      expect(setup.body.method).toBe('totp');
    }
    const disabled = yield* service.disableTwoFactor({
      body: { password: PASSWORD },
      headers: browserHeadersFrom(signUp),
    });
    expect(disabled.body.status).toBe(true);
    expect(disabled.setCookieHeaders.length).toBeGreaterThan(0);
  }),
);

it.effect('serves the reviewed MFA HTTP routes through the typed owner service', () =>
  Effect.gen(function* mfaHttpFlow() {
    const { auth } = makeFixture();
    const signUp = yield* request(auth, '/sign-up/email', {
      email: 'mfa-http-adapter@example.test',
      name: 'MFA HTTP Adapter User',
      password: PASSWORD,
    });
    expect(signUp.status).toBe(200);
    const enabled = yield* request(
      auth,
      '/two-factor/enable',
      { method: 'otp', password: PASSWORD },
      browserHeadersFrom(signUp).get('cookie') ?? undefined,
    );
    expect(enabled.status).toBe(200);
    const enabledHeaders = browserHeadersFrom(enabled);
    yield* Effect.promise(() => auth.api.signOut({ headers: enabledHeaders }));
    const signIn = yield* Effect.promise(() =>
      auth.api.signInEmail({
        body: { email: 'mfa-http-adapter@example.test', password: PASSWORD },
        headers: requestHeaders(),
        returnHeaders: true,
      }),
    );
    expect(signIn.response).toStrictEqual({ twoFactorMethods: ['otp'], twoFactorRedirect: true });
    const challengeHeaders = requestHeaders();
    applySetCookies(challengeHeaders, splitSetCookieHeader(signIn.headers.get('set-cookie') ?? ''));
    const provider = makeCommercePortalAuthMfaProvider(auth.api);
    const service = yield* makeCommercePortalAuthMfaService().pipe(
      Effect.provideService(CommercePortalAuthMfaProviderService, provider),
    );
    const send = yield* service.sendTwoFactorOTP({ body: { trustDevice: false }, headers: challengeHeaders });
    expect(send.body.status).toBe(true);

    expect(narrowCommercePortalAuthMfaTrustDevice({ trustDevice: true })).toStrictEqual(Option.none());
    expect(commercePortalAuthMfaTrustDeviceProblem.status).toBe(400);
    expect(commercePortalAuthMfaTrustDeviceProblem.code).toBe('trust_device_not_allowed');
  }),
);

it.effect('classifies a real Better Auth credential rejection without reporting an outage', () =>
  Effect.gen(function* typedMfaFailureFlow() {
    const { auth } = makeFixture();
    const signUp = yield* request(auth, '/sign-up/email', {
      email: 'mfa-failure@example.test',
      name: 'MFA Failure User',
      password: PASSWORD,
    });
    expect(signUp.status).toBe(200);
    const provider = makeCommercePortalAuthMfaProvider(auth.api);
    const service = yield* makeCommercePortalAuthMfaService().pipe(
      Effect.provideService(CommercePortalAuthMfaProviderService, provider),
    );
    const result = yield* Effect.result(
      service.enableTwoFactor({
        body: { method: 'totp', password: 'W'.repeat(24) },
        headers: browserHeadersFrom(signUp),
      }),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(CommercePortalAuthMfaProviderRejected);
      if (Schema.is(CommercePortalAuthMfaProviderRejected)(result.failure)) {
        expect(result.failure.code).toBe('INVALID_PASSWORD');
        expect(result.failure.reason).not.toContain('password');
      }
    }
  }),
);

it.effect('forwards a Better Auth challenge-expiry cookie on a typed throttle failure', () =>
  Effect.gen(function* mfaChallengeCookieFlow() {
    const { auth } = makeSkipVerificationFixture();
    const signUp = yield* request(auth, '/sign-up/email', {
      email: 'mfa-cookie-expiry@example.test',
      name: 'MFA Cookie Expiry User',
      password: PASSWORD,
    });
    expect(signUp.status).toBe(200);
    const enabled = yield* request(
      auth,
      '/two-factor/enable',
      { method: 'totp', password: PASSWORD },
      browserHeadersFrom(signUp).get('cookie') ?? undefined,
    );
    expect(enabled.status).toBe(200);
    const enabledHeaders = browserHeadersFrom(enabled);
    const signedOut = yield* Effect.promise(() => auth.api.signOut({ headers: enabledHeaders, returnHeaders: true }));
    expect(signedOut.response.success).toBe(true);
    const signIn = yield* Effect.promise(() =>
      auth.api.signInEmail({
        body: { email: 'mfa-cookie-expiry@example.test', password: PASSWORD },
        headers: requestHeaders(),
        returnHeaders: true,
      }),
    );
    expect(signIn.response).toStrictEqual({ twoFactorMethods: ['totp', 'otp'], twoFactorRedirect: true });
    const challengeHeaders = requestHeaders();
    applySetCookies(challengeHeaders, splitSetCookieHeader(signIn.headers.get('set-cookie') ?? ''));
    const provider = makeCommercePortalAuthMfaProvider(auth.api);
    const service = yield* makeCommercePortalAuthMfaService().pipe(
      Effect.provideService(CommercePortalAuthMfaProviderService, provider),
    );
    let firstFailure: CommercePortalAuthMfaProviderFailure | undefined;
    let finalFailure: CommercePortalAuthMfaProviderFailure | undefined;
    for (let attempt = 1; attempt <= COMMERCE_PORTAL_AUTH_MFA_POLICY.maxFailedAttempts + 1; attempt += 1) {
      const outcome = yield* Effect.result(
        service.verifyTOTP({ body: { code: '000000', trustDevice: false }, headers: challengeHeaders }),
      );
      expect(Result.isFailure(outcome)).toBe(true);
      if (!Result.isFailure(outcome)) {
        return;
      }
      if (attempt === 1) {
        firstFailure = outcome.failure;
      }
      if (attempt === COMMERCE_PORTAL_AUTH_MFA_POLICY.maxFailedAttempts + 1) {
        finalFailure = outcome.failure;
      }
    }
    expect(firstFailure).toBeDefined();
    if (firstFailure !== undefined) {
      expect(Schema.is(CommercePortalAuthMfaProviderRejected)(firstFailure)).toBe(true);
      if (Schema.is(CommercePortalAuthMfaProviderRejected)(firstFailure)) {
        expect(firstFailure.code).toBe('INVALID_CODE');
      }
      const firstProblem = commercePortalAuthMfaProblemForFailure(firstFailure);
      expect(firstProblem.status).toBe(401);
      expect(firstProblem.code).toBe('mfa_rejected');
    }
    expect(finalFailure).toBeDefined();
    if (finalFailure === undefined) {
      return;
    }
    expect(Schema.is(CommercePortalAuthMfaRateLimited)(finalFailure)).toBe(true);
    const finalProblem = commercePortalAuthMfaProblemForFailure(finalFailure);
    expect(finalProblem.status).toBe(429);
    expect(finalProblem.code).toBe('TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE');
    const finalCookies = finalFailure.setCookieHeaders.join('\n');
    expect(finalCookies).toContain('two_factor=');
    expect(finalCookies).toContain('Max-Age=0');
  }),
);

it.effect('verifies the exact Better Auth subject and session before invoking MFA', () =>
  Effect.gen(function* exactStepUpBindingFlow() {
    const { auth } = makeFixture();
    const signUp = yield* request(auth, '/sign-up/email', {
      email: 'mfa-step-up@example.test',
      name: 'MFA Step Up User',
      password: PASSWORD,
    });
    expect(signUp.status).toBe(200);
    const headers = browserHeadersFrom(signUp);
    const session = yield* Effect.promise(() =>
      auth.api.getSession({
        headers,
        query: { disableCookieCache: true, disableRefresh: true },
        returnHeaders: true,
      }),
    );
    expect(session.response).not.toBeNull();
    if (session.response === null) {
      return;
    }
    const verifier = makeCommercePortalAuthMfaStepUpCodeVerifier(auth.api);
    const result = yield* Effect.result(
      verifier.verify({
        code: '123456',
        headers,
        providerSubjectId: session.response.user.id,
        sessionId: 'another-session',
      }),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(Schema.is(CommercePortalAuthStepUpCodeRejected)(result.failure)).toBe(true);
    }
  }),
);

/**
 * The published MFA group, driven as HTTP. `portalAuthMfaApiLive` is declared against the
 * vertical's composed `commerceCustomerContextApi`, so the transport under test is mounted on an
 * API with the same identifier — the group handlers the deployment serves, not a second copy.
 */
const mfaTransportApi = HttpApi.make('CommerceCustomerContextApi').addHttpApi(CommercePortalAuthMfaApi);
const mfaRequestContext = Context.makeUnsafe<unknown>(new Map());

const MFA_HTTP_CONFIG: CommercePortalAuthConfigValue = {
  baseUrl: ORIGIN,
  connectionString: Redacted.make('postgres://unused.example.test/unused'),
  nodeEnvironment: 'test',
  policy: COMMERCE_PORTAL_AUTH_POLICY,
  secret: Redacted.make('s'.repeat(64)),
  secureCookies: true,
  trustedOrigins: [ORIGIN],
  trustedProxies: [],
  versionedSecrets: [],
};

interface RecordingMfaBudget {
  readonly budget: CommercePortalAuthRecoveryRateLimit;
  /** Every key the transport actually spent against, so a test can assert what the key names. */
  readonly keys: () => readonly string[];
}

/**
 * The deployment's durable counter store, in memory: the same key shape and the same denial the
 * production store answers with once the window's budget is spent. The keys are kept because the
 * key *is* the invariant — a key that names only the resolved client would be one counter for the
 * whole deployment (`../../api/portal-auth/http-transport.ts`).
 */
const makeRecordingMfaBudget = (): RecordingMfaBudget => {
  const spent = new Map<string, number>();
  return {
    budget: {
      consume: (key, rule) =>
        Effect.sync(() => {
          const next = (spent.get(key) ?? 0) + 1;
          spent.set(key, next);
          return next <= rule.max;
        }),
    },
    keys: () => [...spent.keys()],
  };
};

/**
 * The pending challenge the transport keys its budget on, read exactly as the transport reads it:
 * the realm's `two_factor` cookie, parsed (and therefore URL-decoded) by Better Auth's own parser.
 */
const challengeSubject = (cookie: string): string => {
  for (const [name, value] of parseCookies(cookie)) {
    if (name.endsWith('.two_factor')) {
      return `${name}=${value}`;
    }
  }
  return '';
};

/** The exact durable key a request carrying this challenge cookie must spend. */
const mfaBudgetKey = (cookie: string): string =>
  `${UNRESOLVED_PORTAL_AUTH_CLIENT_KEY}|${createHmac('sha256', SECRET)
    .update(challengeSubject(cookie))
    .digest('base64url')}|/two-factor`;

/** Sign one 2FA-enabled customer in far enough to hold a pending challenge cookie of their own. */
const makeChallengeCookie = (auth: SkipVerificationAuth, email: string) =>
  Effect.gen(function* mfaChallengeCookie() {
    const signUp = yield* request(auth, '/sign-up/email', { email, name: 'MFA Budget User', password: PASSWORD });
    expect(signUp.status).toBe(200);
    const enabled = yield* request(
      auth,
      '/two-factor/enable',
      { method: 'totp', password: PASSWORD },
      browserHeadersFrom(signUp).get('cookie') ?? undefined,
    );
    expect(enabled.status).toBe(200);
    yield* Effect.promise(() => auth.api.signOut({ headers: browserHeadersFrom(enabled) }));
    const signIn = yield* Effect.promise(() =>
      auth.api.signInEmail({
        body: { email, password: PASSWORD },
        headers: requestHeaders(),
        returnHeaders: true,
      }),
    );
    const cookie = splitSetCookieHeader(signIn.headers.get('set-cookie') ?? '')
      .map((header) => header.split(';')[0] ?? '')
      .filter((pair) => pair.length > 0)
      .join('; ');
    expect(challengeSubject(cookie).length).toBeGreaterThan(0);
    return cookie;
  });

const makeMfaTransport = (
  service: Effect.Success<ReturnType<typeof makeCommercePortalAuthMfaService>>,
  budget: CommercePortalAuthRecoveryRateLimit = makeRecordingMfaBudget().budget,
) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(mfaTransportApi).pipe(
          Layer.provide(portalAuthMfaApiLive),
          Layer.provide(Layer.succeed(CommercePortalAuthMfaService, service)),
          Layer.provide(Layer.succeed(CommercePortalAuthConfig, MFA_HTTP_CONFIG)),
          Layer.provide(Layer.succeed(CommercePortalAuthRecoveryRateLimitService, budget)),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true },
      ),
    ),
    (app) => Effect.promise(app.dispose.bind(app)).pipe(Effect.orDie),
  );

it.effect('drives the published MFA group over HTTP and forwards provider cookies on success and failure', () =>
  Effect.scoped(
    Effect.gen(function* mfaTransportFlow() {
      const { auth } = makeSkipVerificationFixture();
      const signUp = yield* request(auth, '/sign-up/email', {
        email: 'mfa-transport@example.test',
        name: 'MFA Transport User',
        password: PASSWORD,
      });
      expect(signUp.status).toBe(200);
      const enabled = yield* request(
        auth,
        '/two-factor/enable',
        { method: 'totp', password: PASSWORD },
        browserHeadersFrom(signUp).get('cookie') ?? undefined,
      );
      expect(enabled.status).toBe(200);
      yield* Effect.promise(() => auth.api.signOut({ headers: browserHeadersFrom(enabled) }));

      const signIn = yield* Effect.promise(() =>
        auth.api.signInEmail({
          body: { email: 'mfa-transport@example.test', password: PASSWORD },
          headers: requestHeaders(),
          returnHeaders: true,
        }),
      );
      expect(signIn.response).toStrictEqual({ twoFactorMethods: ['totp', 'otp'], twoFactorRedirect: true });
      const challengeCookie = splitSetCookieHeader(signIn.headers.get('set-cookie') ?? '')
        .map((header) => header.split(';')[0] ?? '')
        .filter((pair) => pair.length > 0)
        .join('; ');
      expect(challengeCookie).toContain('two_factor=');

      const service = yield* makeCommercePortalAuthMfaService().pipe(
        Effect.provideService(CommercePortalAuthMfaProviderService, makeCommercePortalAuthMfaProvider(auth.api)),
      );
      const recorded = makeRecordingMfaBudget();
      const app = yield* makeMfaTransport(service, recorded.budget);
      const send = (route: string, body: Schema.Json, origin?: string) =>
        Effect.promise(() =>
          app.handler(
            new Request(`${ORIGIN}${BASE_PATH}${route}`, {
              body: JSON.stringify(body),
              headers:
                origin === undefined
                  ? { 'content-type': 'application/json', cookie: challengeCookie }
                  : { 'content-type': 'application/json', cookie: challengeCookie, origin },
              method: 'POST',
            }),
            mfaRequestContext,
          ),
        );

      // Every state-changing route runs the owner CSRF guard before the provider is touched — and
      // before the durable budget is spent. A third-party page can drive a visitor's browser here,
      // so a request the guard refuses must leave the visitor's own challenge budget untouched.
      const missingOrigin = yield* send('/two-factor/send-otp', { trustDevice: false });
      expect(missingOrigin.status).toBe(403);
      const crossOrigin = yield* send('/two-factor/send-otp', { trustDevice: false }, 'https://attacker.example.test');
      expect(crossOrigin.status).toBe(403);
      expect(recorded.keys()).toStrictEqual([]);

      // A trusted-device request is refused by the published payload contract, not by the provider.
      const trusted = yield* send('/two-factor/verify-totp', { code: '000000', trustDevice: true }, ORIGIN);
      expect(trusted.status).toBe(400);
      expect(yield* Effect.promise(() => trusted.json())).toMatchObject({
        code: 'trust_device_not_allowed',
        status: 400,
      });

      // An undeclared route is the router's 404; the group publishes only its four endpoints.
      const undeclared = yield* send('/two-factor/verify-anything', { code: '000000' }, ORIGIN);
      expect(undeclared.status).toBe(404);

      const sent = yield* send('/two-factor/send-otp', { trustDevice: false }, ORIGIN);
      expect(sent.status).toBe(200);
      expect(yield* Effect.promise(() => sent.json())).toStrictEqual({ status: true });
      expect(sent.headers.get('cache-control')).toBe('no-store');

      // A rejected verification still carries the provider's cookies: the challenge cookie the
      // provider rotates on a failed attempt must reach the browser with the 401 problem.
      const rejected = yield* send('/two-factor/verify-totp', { code: '000000', trustDevice: false }, ORIGIN);
      expect(rejected.status).toBe(401);
      expect(yield* Effect.promise(() => rejected.json())).toMatchObject({ code: 'mfa_rejected', status: 401 });
      expect(rejected.headers.get('content-type')).toContain('application/problem+json');

      // Everything this challenge spent went to one key, and that key names the challenge — not a
      // constant every caller in the deployment would share.
      expect(recorded.keys()).toStrictEqual([mfaBudgetKey(challengeCookie)]);
    }),
  ),
);

/**
 * A request that names no live session and no pending challenge cannot be admitted by the provider
 * — `verifyTwoFactor` answers it `UNAUTHORIZED` without touching any account — so the transport
 * refuses it as an expired challenge rather than letting it spend a budget it cannot attribute.
 */
it.effect('refuses an MFA request that names no challenge without spending any budget', () =>
  Effect.scoped(
    Effect.gen(function* mfaUnattributableRequest() {
      const { auth } = makeSkipVerificationFixture();
      const service = yield* makeCommercePortalAuthMfaService().pipe(
        Effect.provideService(CommercePortalAuthMfaProviderService, makeCommercePortalAuthMfaProvider(auth.api)),
      );
      const recorded = makeRecordingMfaBudget();
      const app = yield* makeMfaTransport(service, recorded.budget);
      const response = yield* Effect.promise(() =>
        app.handler(
          new Request(`${ORIGIN}${BASE_PATH}/two-factor/send-otp`, {
            body: JSON.stringify({ trustDevice: false }),
            headers: { 'content-type': 'application/json', origin: ORIGIN },
            method: 'POST',
          }),
          mfaRequestContext,
        ),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        code: 'mfa_challenge_expired',
        status: 401,
      });
      expect(recorded.keys()).toStrictEqual([]);
    }),
  ),
);

it.effect('bounds MFA routes on the owner budget and keeps every refusal problem+json', () =>
  Effect.scoped(
    Effect.gen(function* mfaBudgetAndContentTypeAssertions() {
      const { auth } = makeSkipVerificationFixture();
      const challengeCookie = yield* makeChallengeCookie(auth, 'mfa-budget-owner@example.test');
      const service = yield* makeCommercePortalAuthMfaService().pipe(
        Effect.provideService(CommercePortalAuthMfaProviderService, makeCommercePortalAuthMfaProvider(auth.api)),
      );
      const recorded = makeRecordingMfaBudget();
      const app = yield* makeMfaTransport(service, recorded.budget);
      const send = (contentType: string, cookie: string = challengeCookie) =>
        Effect.promise(() =>
          app.handler(
            new Request(`${ORIGIN}${BASE_PATH}/two-factor/send-otp`, {
              body: JSON.stringify({ trustDevice: false }),
              headers: { 'content-type': contentType, cookie, origin: ORIGIN },
              method: 'POST',
            }),
            mfaRequestContext,
          ),
        );

      // `HttpApiBuilder`'s payload decoder answers a raw 415 as a *success* value, so without the
      // group's own rewrite this would escape as text/plain and break the published contract.
      const unsupported = yield* send('text/plain');
      expect(unsupported.status).toBe(400);
      expect(unsupported.headers.get('content-type')).toContain('application/problem+json');
      expect(yield* Effect.promise(() => unsupported.json())).toMatchObject({
        code: 'invalid_request',
        status: 400,
      });
      expect(recorded.keys()).toStrictEqual([]);

      // Better Auth's `/two-factor/*` rule lives in a router this transport never mounts, so OTP
      // mail would otherwise be unthrottled. A rejected payload never reaches the handler, so the
      // 415 above spent nothing: the whole budget is still available here.
      const budget = COMMERCE_PORTAL_AUTH_POLICY.rateLimit.mfa.max;
      const statuses = yield* Effect.forEach(
        Array.from({ length: budget }, (_unused, attempt) => attempt),
        () => send('application/json').pipe(Effect.map((response) => response.status)),
        { concurrency: 1 },
      );
      expect(statuses.some((status) => status === 429)).toBe(false);
      const exhausted = yield* send('application/json');
      expect(exhausted.status).toBe(429);
      expect(exhausted.headers.get('content-type')).toContain('application/problem+json');

      // The whole window was spent against one key, and that key is the caller's own challenge.
      // A key of `${UNRESOLVED_PORTAL_AUTH_CLIENT_KEY}|/two-factor` would be one counter for the
      // deployment, and the exhaustion above would have denied MFA to every other customer.
      expect(recorded.keys()).toStrictEqual([mfaBudgetKey(challengeCookie)]);
      expect(recorded.keys()).not.toContain(`${UNRESOLVED_PORTAL_AUTH_CLIENT_KEY}|/two-factor`);

      // Another customer, mid-sign-in in the same window, still completes their own 2FA.
      const bystanderCookie = yield* makeChallengeCookie(auth, 'mfa-budget-bystander@example.test');
      const bystander = yield* send('application/json', bystanderCookie);
      expect(bystander.status).not.toBe(429);
      expect(recorded.keys()).toStrictEqual([mfaBudgetKey(challengeCookie), mfaBudgetKey(bystanderCookie)]);
    }),
  ),
);
