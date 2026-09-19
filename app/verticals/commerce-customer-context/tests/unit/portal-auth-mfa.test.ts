import { HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { Context, Effect, Layer, Option, Redacted, Result, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import type { OTPOptions } from 'better-auth/plugins/two-factor';

import { CommercePortalAuthMfaApi } from '../../shared/portal-auth/mfa-api.ts';
import { CommercePortalAuthConfig } from '../../api/portal-auth/provider/config-service.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../../api/portal-auth/provider/config.ts';
import type { CommercePortalAuthConfigValue } from '../../api/portal-auth/provider/config.ts';
import {
  COMMERCE_PORTAL_AUTH_MFA_POLICY,
  CommercePortalAuthMfaChallengeExpired,
  CommercePortalAuthMfaProviderRejected,
  CommercePortalAuthMfaProviderUnavailable,
  CommercePortalAuthMfaProviderService,
  CommercePortalAuthMfaRateLimited,
  CommercePortalAuthMfaVerifyBackupCodeBodySchema,
  CommercePortalAuthMfaVerifyTotpBodySchema,
  commercePortalAuthMfaInvalidProblem,
  commercePortalAuthMfaProblemForFailure,
  commercePortalAuthMfaTrustDeviceProblem,
  commercePortalAuthMfaUnavailableProblem,
  createCommercePortalAuthTwoFactorPlugin,
  makeCommercePortalAuthMfaService,
  narrowCommercePortalAuthMfaTrustDevice,
} from '../../api/portal-auth/provider/mfa/index.ts';
import type {
  CommercePortalAuthMfaProvider,
  CommercePortalAuthMfaProviderFailure,
  CommercePortalAuthMfaResponse,
  CommercePortalAuthMfaServiceApi,
} from '../../api/portal-auth/provider/mfa/index.ts';
import {
  CommercePortalAuthMfaFreshnessReaderService,
  commercePortalAuthMfaFreshnessReaderFromApi,
  portalAuthMfaStandaloneApiLive,
} from '../../api/portal-auth/provider/mfa/http.ts';
import type {
  CommercePortalAuthMfaFreshnessReader,
  CommercePortalAuthMfaSessionReadApi,
  CommercePortalAuthMfaSessionSnapshot,
} from '../../api/portal-auth/provider/mfa/http.ts';
import { CommercePortalAuthMfaService } from '../../api/portal-auth/provider/mfa/service.ts';
import { CommercePortalAuthRecoveryRateLimitService } from '../../api/portal-auth/rate-limit-service.ts';
import type { CommercePortalAuthRecoveryRateLimit } from '../../api/portal-auth/rate-limit-service.ts';
import { encodeCommerceSessionReference } from '../../api/portal-auth/provider/session-reference.ts';
import { makeCommercePortalAuthSessionLifecycle } from '../../api/portal-auth/session/lifecycle.ts';
import type { CommercePortalAuthSessionProvider } from '../../api/portal-auth/session/lifecycle.ts';
import type { CommercePortalAuthSessionRecord } from '../../api/portal-auth/session/contracts.ts';
import type { CommercePortalAuthSessionStore } from '../../api/portal-auth/session/store-service.ts';
import { unauditedCommercePortalAuthRecorder } from '../../src/portal-auth/audit/audit.ts';

const headers = new Headers({ origin: 'https://portal.example.test' });
const otpDeliveryCallback: NonNullable<OTPOptions['sendOTP']> = () => Promise.resolve();
const providerResponse = <Body>(
  body: Body,
  setCookieHeaders: readonly string[] = [],
): CommercePortalAuthMfaResponse<Body> => ({
  body,
  setCookieHeaders,
});

const successfulProvider = (): CommercePortalAuthMfaProvider => ({
  disableTwoFactor: () => Effect.succeed(providerResponse({ status: true })),
  enableTwoFactor: () =>
    Effect.succeed(providerResponse({ backupCodes: ['backup-1'], method: 'totp', totpURI: 'otpauth://totp/test' })),
  generateBackupCodes: () => Effect.succeed(providerResponse({ backupCodes: ['backup-2'], status: true })),
  getTOTPURI: () => Effect.succeed(providerResponse({ totpURI: 'otpauth://totp/test' })),
  sendTwoFactorOTP: () => Effect.succeed(providerResponse({ status: true })),
  verifyBackupCode: () => Effect.succeed(providerResponse({ status: true })),
  verifyTOTP: () => Effect.succeed(providerResponse({ status: true })),
  verifyTwoFactorOTP: () => Effect.succeed(providerResponse({ status: true })),
});

const runMfa = <ResultValue>(
  provider: CommercePortalAuthMfaProvider,
  invoke: (
    service: CommercePortalAuthMfaServiceApi,
  ) => Effect.Effect<ResultValue, CommercePortalAuthMfaProviderFailure>,
) =>
  makeCommercePortalAuthMfaService(unauditedCommercePortalAuthRecorder).pipe(
    Effect.provideService(CommercePortalAuthMfaProviderService, provider),
    Effect.flatMap((service) => invoke(service)),
  );

it.effect('configures the installed two-factor plugin with the Commerce policy', () =>
  Effect.sync(() => {
    const plugin = createCommercePortalAuthTwoFactorPlugin({
      policy: COMMERCE_PORTAL_AUTH_MFA_POLICY,
      sendOTP: otpDeliveryCallback,
    });
    expect(plugin.id).toBe('two-factor');
    expect(plugin.options?.accountLockout).toStrictEqual({
      durationSeconds: COMMERCE_PORTAL_AUTH_MFA_POLICY.lockoutDurationSeconds,
      enabled: true,
      maxFailedAttempts: COMMERCE_PORTAL_AUTH_MFA_POLICY.maxFailedAttempts,
    });
    expect(plugin.options?.backupCodeOptions?.storeBackupCodes).toBe('encrypted');
    expect(plugin.options?.otpOptions).toStrictEqual({
      allowedAttempts: COMMERCE_PORTAL_AUTH_MFA_POLICY.maxFailedAttempts,
      digits: COMMERCE_PORTAL_AUTH_MFA_POLICY.otpDigits,
      period: COMMERCE_PORTAL_AUTH_MFA_POLICY.otpPeriodMinutes,
      sendOTP: otpDeliveryCallback,
    });
    expect(plugin.options?.totpOptions).toStrictEqual({ digits: 6, period: 30 });
    expect(plugin.options?.trustDeviceMaxAge).toBe(0);
    expect(plugin.options?.twoFactorCookieMaxAge).toBe(600);
  }),
);

it.effect('returns the TOTP setup material without crossing a provider token seam', () =>
  runMfa(successfulProvider(), (service) =>
    service.enableTwoFactor({ body: { method: 'totp', password: 'P'.repeat(24) }, headers }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.body).toStrictEqual({
            backupCodes: ['backup-1'],
            method: 'totp',
            totpURI: 'otpauth://totp/test',
          });
          expect(result.setCookieHeaders).toStrictEqual([]);
          expect('token' in result.body).toBe(false);
        }),
      ),
    ),
  ),
);

it.effect('preserves provider-set cookies as a private MFA response handoff', () => {
  const provider: CommercePortalAuthMfaProvider = {
    ...successfulProvider(),
    enableTwoFactor: () =>
      Effect.succeed(
        providerResponse({ backupCodes: ['backup-1'], method: 'totp', totpURI: 'otpauth://totp/test' }, [
          'better-auth.session_token=rotated; Path=/; HttpOnly',
        ]),
      ),
  };
  return runMfa(provider, (service) =>
    service.enableTwoFactor({ body: { method: 'totp', password: 'P'.repeat(24) }, headers }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.body.method).toBe('totp');
          expect(result.setCookieHeaders).toStrictEqual(['better-auth.session_token=rotated; Path=/; HttpOnly']);
          expect('token' in result.body).toBe(false);
        }),
      ),
    ),
  );
});

it.effect('refuses a trusted-device request and narrows every accepted value to false', () =>
  Effect.sync(() => {
    expect(narrowCommercePortalAuthMfaTrustDevice({ trustDevice: true })).toStrictEqual(Option.none());
    expect(narrowCommercePortalAuthMfaTrustDevice({ trustDevice: false })).toStrictEqual(Option.void);
    expect(narrowCommercePortalAuthMfaTrustDevice({})).toStrictEqual(Option.void);
  }),
);

it.effect('answers a trusted-device request with its own 400 problem code', () =>
  Effect.sync(() => {
    expect(commercePortalAuthMfaTrustDeviceProblem.code).toBe('trust_device_not_allowed');
    expect(commercePortalAuthMfaTrustDeviceProblem.status).toBe(400);
    expect(commercePortalAuthMfaInvalidProblem.code).toBe('invalid_request');
    expect(commercePortalAuthMfaInvalidProblem.status).toBe(400);
  }),
);

it.effect('keeps a trusted-device flag decodable so the owner problem is the rejection, not a schema error', () =>
  Effect.gen(function* trustDeviceStaysDecodable() {
    const decoded = yield* Schema.decodeUnknownEffect(CommercePortalAuthMfaVerifyTotpBodySchema)({
      code: '123456',
      trustDevice: true,
    });
    expect(decoded.trustDevice).toBe(true);
    expect(narrowCommercePortalAuthMfaTrustDevice(decoded)).toStrictEqual(Option.none());
  }),
);

it.effect('rejects excess MFA payload fields at the published boundary', () =>
  Effect.gen(function* excessPayloadFieldsRejected() {
    const result = yield* Effect.result(
      Schema.decodeUnknownEffect(CommercePortalAuthMfaVerifyBackupCodeBodySchema)({
        code: 'backup-1',
        unexpected: 'field',
      }),
    );
    expect(Result.isFailure(result)).toBe(true);
  }),
);

it.effect('maps provider failures into a typed unavailable outcome', () => {
  const providerFailure = new CommercePortalAuthMfaProviderUnavailable({
    operation: 'verifyTOTP',
    reason: 'provider unavailable',
    setCookieHeaders: [],
  });
  const provider: CommercePortalAuthMfaProvider = {
    ...successfulProvider(),
    verifyTOTP: () => Effect.fail(providerFailure),
  };
  return runMfa(provider, (service) =>
    Effect.result(service.verifyTOTP({ body: { code: '123456' }, headers })).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBe(providerFailure);
          }
        }),
      ),
    ),
  );
});

it.effect('keeps sanitized rejection, expiry, and throttle outcomes typed', () => {
  const failures = [
    new CommercePortalAuthMfaProviderRejected({
      code: 'INVALID_CODE',
      operation: 'verifyTOTP',
      reason: 'rejected',
      setCookieHeaders: ['session=expired; Path=/'],
    }),
    new CommercePortalAuthMfaChallengeExpired({
      operation: 'verifyTwoFactorOTP',
      reason: 'expired',
      setCookieHeaders: ['challenge=; Max-Age=0; Path=/'],
    }),
    new CommercePortalAuthMfaRateLimited({
      code: 'ACCOUNT_TEMPORARILY_LOCKED',
      operation: 'verifyBackupCode',
      reason: 'throttled',
      setCookieHeaders: [],
    }),
  ];
  return Effect.sync(() => {
    expect(failures[0]).toBeInstanceOf(CommercePortalAuthMfaProviderRejected);
    expect(failures[1]).toBeInstanceOf(CommercePortalAuthMfaChallengeExpired);
    expect(failures[2]).toBeInstanceOf(CommercePortalAuthMfaRateLimited);
    expect(failures[0]?.setCookieHeaders).toStrictEqual(['session=expired; Path=/']);
  });
});

it.effect('preserves the published status for every provider failure', () =>
  Effect.sync(() => {
    const expired = commercePortalAuthMfaProblemForFailure(
      new CommercePortalAuthMfaChallengeExpired({
        operation: 'verifyTOTP',
        reason: 'expired',
        setCookieHeaders: [],
      }),
    );
    expect(expired.status).toBe(401);
    expect(expired.code).toBe('mfa_challenge_expired');

    const rejected = commercePortalAuthMfaProblemForFailure(
      new CommercePortalAuthMfaProviderRejected({
        code: 'INVALID_CODE',
        operation: 'verifyTOTP',
        reason: 'rejected',
        setCookieHeaders: [],
      }),
    );
    expect(rejected.status).toBe(401);
    expect(rejected.code).toBe('mfa_rejected');

    const malformed = commercePortalAuthMfaProblemForFailure(
      new CommercePortalAuthMfaProviderRejected({
        code: 'INVALID_REQUEST',
        operation: 'verifyTOTP',
        reason: 'rejected',
        setCookieHeaders: [],
      }),
    );
    expect(malformed.status).toBe(400);
    expect(malformed.code).toBe('invalid_request');

    const throttled = commercePortalAuthMfaProblemForFailure(
      new CommercePortalAuthMfaRateLimited({
        code: 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE',
        operation: 'verifyTOTP',
        reason: 'throttled',
        setCookieHeaders: ['two_factor=; Max-Age=0; Path=/'],
      }),
    );
    expect(throttled.status).toBe(429);
    expect(throttled.code).toBe('TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE');

    const unavailable = commercePortalAuthMfaProblemForFailure(
      new CommercePortalAuthMfaProviderUnavailable({
        operation: 'verifyTOTP',
        reason: 'unavailable',
        setCookieHeaders: [],
      }),
    );
    expect(unavailable.status).toBe(503);
    expect(unavailable.code).toBe('authentication_unavailable');
    expect(commercePortalAuthMfaUnavailableProblem.retryable).toBe(true);
  }),
);

/**
 * Better Auth removes the backup code before it branches on `disableSession`, and its
 * `disableSession` branch answers the two-factor sign-in path with a body that carries no session
 * token — which the owner's provider result cannot decode and would publish as a retryable 503,
 * after the one-time credential was already destroyed. The published payload is closed, so the flag
 * is refused at the boundary instead, and nothing forwards it to the provider.
 */
it.effect('refuses a backup-code session-control flag before the one-time credential is spent', () => {
  let receivedBody: { readonly code: string; readonly trustDevice?: false } | undefined;
  const provider: CommercePortalAuthMfaProvider = {
    ...successfulProvider(),
    verifyBackupCode: (input) =>
      Effect.sync(() => {
        receivedBody = { ...input.body };
        return providerResponse({ status: true });
      }),
  };
  return Effect.gen(function* backupCodeSessionControlRefused() {
    const rejected = yield* Effect.result(
      Schema.decodeUnknownEffect(CommercePortalAuthMfaVerifyBackupCodeBodySchema)({
        code: 'backup-1',
        disableSession: true,
      }),
    );
    expect(Result.isFailure(rejected)).toBe(true);

    yield* runMfa(provider, (service) =>
      service.verifyBackupCode({ body: { code: 'backup-1', trustDevice: false }, headers }),
    );
    expect(receivedBody).toStrictEqual({ code: 'backup-1', trustDevice: false });
  });
});

it.effect('keeps backup-code and URI responses typed at the owner facade', () =>
  runMfa(successfulProvider(), (service) =>
    Effect.all([
      service.getTOTPURI({ body: { password: 'P'.repeat(24) }, headers }),
      service.generateBackupCodes({ body: { password: 'P'.repeat(24) }, headers }),
    ]).pipe(
      Effect.tap(([uri, backupCodes]) =>
        Effect.sync(() => {
          expect(uri.body.totpURI).toBe('otpauth://totp/test');
          expect(backupCodes.body.backupCodes).toStrictEqual(['backup-2']);
          expect(backupCodes.body.status).toBe(true);
        }),
      ),
    ),
  ),
);

/**
 * HTTP-level coverage for the five administrative enrollment routes (`enable`, `confirm-enable`,
 * `disable`, `regenerate-backup-codes`, `totp-uri`): `prepareMfaAdminCall`'s gate ordering (the
 * owner's trusted-origin check, the owner-enforced freshness window, then the durable per-subject
 * budget), and that each route reaches the correct `CommercePortalAuthMfaServiceApi` method with the
 * expected request shape. Mirrors `tests/unit/portal-auth-step-up.test.ts`'s HTTP fixture, driving
 * `portalAuthMfaStandaloneApiLive` through `HttpRouter.toWebHandler` instead of the service facade
 * the tests above exercise.
 */

const HTTP_ORIGIN = 'https://portal.example.test';
/**
 * `HTTP_CONFIG.secureCookies` is `true`, so `mfaSubjectKey` resolves the session cookie's name
 * through `createCookieGetter` with `useSecureCookies: true` — which prepends `__Secure-`
 * (`better-auth/cookies`). This must carry that same prefix or every admin-route request answers
 * a `mfa_challenge_expired` 401 for a subject the freshness gate already accepted, since the
 * budget gate would find no matching cookie at all.
 */
const HTTP_COOKIE = '__Secure-commerce-portal.session_token=current';

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

const httpRequestContextMfa = Context.makeUnsafe<unknown>(new Map());

/**
 * `makeMfaHttpApp` bakes `TestClock.layer()` into the built API runtime, so every request
 * `app.handler` processes reads this fixed instant through `Clock.currentTimeMillis` — never the
 * live wall clock. `TestClock.layer()` starts at epoch 0 and nothing here advances it, so the
 * session timestamps below are exact offsets from `TEST_NOW_MILLIS`, not wall-clock-relative.
 */
const TEST_NOW_MILLIS = 0;

const mfaHttpRequest = (
  path: string,
  body: Readonly<Record<string, string>>,
  options: { readonly origin?: string } = {},
): Request =>
  new Request(`${HTTP_ORIGIN}${path}`, {
    body: JSON.stringify(body),
    headers: new Headers({
      'content-type': 'application/json',
      cookie: HTTP_COOKIE,
      origin: options.origin ?? HTTP_ORIGIN,
    }),
    method: 'POST',
  });

interface MfaHttpFixtureState {
  readonly budgetKeys: string[];
  currentSession: Option.Option<{ readonly authenticatedAtMillis: number }>;
  readonly disableInputs: Parameters<CommercePortalAuthMfaServiceApi['disableTwoFactor']>[0][];
  readonly enableInputs: Parameters<CommercePortalAuthMfaServiceApi['enableTwoFactor']>[0][];
  readonly generateBackupCodesInputs: Parameters<CommercePortalAuthMfaServiceApi['generateBackupCodes']>[0][];
  readonly readHeaders: Headers[];
  readonly totpUriInputs: Parameters<CommercePortalAuthMfaServiceApi['getTOTPURI']>[0][];
  readonly verifyTotpInputs: Parameters<CommercePortalAuthMfaServiceApi['verifyTOTP']>[0][];
}

interface MfaHttpFixture {
  readonly budget: CommercePortalAuthRecoveryRateLimit;
  readonly freshnessReader: CommercePortalAuthMfaFreshnessReader;
  readonly service: CommercePortalAuthMfaServiceApi;
  readonly state: MfaHttpFixtureState;
}

const makeMfaHttpFixture = (): MfaHttpFixture => {
  const state: MfaHttpFixtureState = {
    budgetKeys: [],
    currentSession: Option.some({ authenticatedAtMillis: TEST_NOW_MILLIS - 60_000 }),
    disableInputs: [],
    enableInputs: [],
    generateBackupCodesInputs: [],
    readHeaders: [],
    totpUriInputs: [],
    verifyTotpInputs: [],
  };
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
  const freshnessReader: CommercePortalAuthMfaFreshnessReader = {
    readCurrentSession: (requestHeaders) =>
      Effect.sync(() => {
        state.readHeaders.push(requestHeaders);
        return state.currentSession;
      }),
  };
  const service: CommercePortalAuthMfaServiceApi = {
    disableTwoFactor: (input) =>
      Effect.sync(() => {
        state.disableInputs.push(input);
        return providerResponse({ status: true });
      }),
    enableTwoFactor: (input) =>
      Effect.sync(() => {
        state.enableInputs.push(input);
        return providerResponse({ backupCodes: ['backup-1'], method: 'totp', totpURI: 'otpauth://totp/test' });
      }),
    generateBackupCodes: (input) =>
      Effect.sync(() => {
        state.generateBackupCodesInputs.push(input);
        return providerResponse({ backupCodes: ['backup-2'], status: true });
      }),
    getTOTPURI: (input) =>
      Effect.sync(() => {
        state.totpUriInputs.push(input);
        return providerResponse({ totpURI: 'otpauth://totp/test' });
      }),
    sendTwoFactorOTP: () => Effect.succeed(providerResponse({ status: true })),
    verifyBackupCode: () => Effect.succeed(providerResponse({ status: true })),
    verifyTOTP: (input) =>
      Effect.sync(() => {
        state.verifyTotpInputs.push(input);
        return providerResponse({ status: true });
      }),
    verifyTwoFactorOTP: () => Effect.succeed(providerResponse({ status: true })),
  };
  return { budget, freshnessReader, service, state };
};

const makeMfaHttpApp = (
  fixture: MfaHttpFixture,
  reader: CommercePortalAuthMfaFreshnessReader = fixture.freshnessReader,
) =>
  Effect.gen(function* makeMfaHttpAppEffect() {
    const apiLayer = HttpApiBuilder.layer(CommercePortalAuthMfaApi).pipe(
      Layer.provide(portalAuthMfaStandaloneApiLive),
      Layer.provide(Layer.succeed(CommercePortalAuthMfaFreshnessReaderService, reader)),
      Layer.provide(Layer.succeed(CommercePortalAuthMfaService, fixture.service)),
      Layer.provide(Layer.succeed(CommercePortalAuthConfig, HTTP_CONFIG)),
      Layer.provide(Layer.succeed(CommercePortalAuthRecoveryRateLimitService, fixture.budget)),
      Layer.provide(HttpServer.layerServices),
      Layer.provide(TestClock.layer()),
    );
    return yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(apiLayer, { disableLogger: true })),
      (handler) => Effect.promise(handler.dispose.bind(handler)).pipe(Effect.orDie),
    );
  });

it.effect('gates enable behind the trusted origin, the freshness window, and the durable budget, in that order', () =>
  Effect.gen(function* gateOrdering() {
    const fixture = makeMfaHttpFixture();
    const app = yield* makeMfaHttpApp(fixture);

    const wrongOrigin = yield* Effect.promise(() =>
      app.handler(
        mfaHttpRequest(
          '/api/portal-auth/two-factor/enable',
          { password: 'P'.repeat(24) },
          {
            origin: 'https://attacker.example.test',
          },
        ),
        httpRequestContextMfa,
      ),
    );
    expect(wrongOrigin.status).toBe(403);
    const wrongOriginBody = yield* Effect.promise(() => wrongOrigin.json());
    expect(wrongOriginBody).toMatchObject({ code: 'origin_not_trusted', status: 403 });
    expect(fixture.state.readHeaders).toHaveLength(0);
    expect(fixture.state.budgetKeys).toHaveLength(0);
    expect(fixture.state.enableInputs).toHaveLength(0);

    fixture.state.currentSession = Option.none();
    const noSession = yield* Effect.promise(() =>
      app.handler(
        mfaHttpRequest('/api/portal-auth/two-factor/enable', { password: 'P'.repeat(24) }),
        httpRequestContextMfa,
      ),
    );
    expect(noSession.status).toBe(401);
    const noSessionBody = yield* Effect.promise(() => noSession.json());
    expect(noSessionBody).toMatchObject({ code: 'mfa_authentication_not_fresh', status: 401 });
    expect(fixture.state.readHeaders).toHaveLength(1);
    expect(fixture.state.budgetKeys).toHaveLength(0);
    expect(fixture.state.enableInputs).toHaveLength(0);

    fixture.state.currentSession = Option.some({
      authenticatedAtMillis: TEST_NOW_MILLIS - (COMMERCE_PORTAL_AUTH_POLICY.session.freshAgeSeconds + 30) * 1000,
    });
    const stale = yield* Effect.promise(() =>
      app.handler(
        mfaHttpRequest('/api/portal-auth/two-factor/enable', { password: 'P'.repeat(24) }),
        httpRequestContextMfa,
      ),
    );
    expect(stale.status).toBe(401);
    const staleBody = yield* Effect.promise(() => stale.json());
    expect(staleBody).toMatchObject({ code: 'mfa_authentication_not_fresh', status: 401 });
    expect(fixture.state.budgetKeys).toHaveLength(0);

    fixture.state.currentSession = Option.some({ authenticatedAtMillis: TEST_NOW_MILLIS - 60_000 });
    const fresh = yield* Effect.promise(() =>
      app.handler(
        mfaHttpRequest('/api/portal-auth/two-factor/enable', { password: 'P'.repeat(24) }),
        httpRequestContextMfa,
      ),
    );
    expect(fresh.status).toBe(200);
    expect(fixture.state.budgetKeys).toHaveLength(1);
    expect(fixture.state.enableInputs).toHaveLength(1);
    expect(fixture.state.enableInputs[0]?.body).toStrictEqual({ password: 'P'.repeat(24) });
  }),
);

it.effect('answers a spent MFA budget with the rate-limited problem and stops calling the provider', () =>
  Effect.gen(function* rateLimitedRejection() {
    const fixture = makeMfaHttpFixture();
    const app = yield* makeMfaHttpApp(fixture);
    for (let attempt = 0; attempt < COMMERCE_PORTAL_AUTH_POLICY.rateLimit.mfa.max; attempt += 1) {
      const response = yield* Effect.promise(() =>
        app.handler(
          mfaHttpRequest('/api/portal-auth/two-factor/disable', { password: 'P'.repeat(24) }),
          httpRequestContextMfa,
        ),
      );
      expect(response.status).toBe(200);
    }
    const limited = yield* Effect.promise(() =>
      app.handler(
        mfaHttpRequest('/api/portal-auth/two-factor/disable', { password: 'P'.repeat(24) }),
        httpRequestContextMfa,
      ),
    );
    expect(limited.status).toBe(429);
    const limitedBody = yield* Effect.promise(() => limited.json());
    expect(limitedBody).toMatchObject({ code: 'MFA_RATE_LIMITED', status: 429 });
    expect(fixture.state.disableInputs).toHaveLength(COMMERCE_PORTAL_AUTH_POLICY.rateLimit.mfa.max);
  }),
);

it.effect(
  'rejects a password outside the owner policy bounds after the budget is spent, without calling the provider',
  () =>
    Effect.gen(function* invalidPasswordRejected() {
      const fixture = makeMfaHttpFixture();
      const app = yield* makeMfaHttpApp(fixture);
      const tooShort = yield* Effect.promise(() =>
        app.handler(
          mfaHttpRequest('/api/portal-auth/two-factor/disable', { password: 'short' }),
          httpRequestContextMfa,
        ),
      );
      expect(tooShort.status).toBe(400);
      const tooShortBody = yield* Effect.promise(() => tooShort.json());
      expect(tooShortBody).toMatchObject({ code: 'invalid_request', status: 400 });
      expect(fixture.state.disableInputs).toHaveLength(0);
      expect(fixture.state.budgetKeys).toHaveLength(1);
    }),
);

it.effect('wires confirm-enable, regenerate-backup-codes and totp-uri to the matching provider calls', () =>
  Effect.gen(function* wiring() {
    const fixture = makeMfaHttpFixture();
    const app = yield* makeMfaHttpApp(fixture);

    const confirmEnable = yield* Effect.promise(() =>
      app.handler(
        mfaHttpRequest('/api/portal-auth/two-factor/confirm-enable', { code: '123456' }),
        httpRequestContextMfa,
      ),
    );
    expect(confirmEnable.status).toBe(200);
    expect(fixture.state.verifyTotpInputs).toHaveLength(1);
    expect(fixture.state.verifyTotpInputs[0]?.body).toStrictEqual({ code: '123456', trustDevice: false });

    const regenerate = yield* Effect.promise(() =>
      app.handler(
        mfaHttpRequest('/api/portal-auth/two-factor/regenerate-backup-codes', { password: 'P'.repeat(24) }),
        httpRequestContextMfa,
      ),
    );
    expect(regenerate.status).toBe(200);
    expect(fixture.state.generateBackupCodesInputs).toHaveLength(1);
    expect(fixture.state.generateBackupCodesInputs[0]?.body).toStrictEqual({ password: 'P'.repeat(24) });

    const totpUri = yield* Effect.promise(() =>
      app.handler(
        mfaHttpRequest('/api/portal-auth/two-factor/totp-uri', { password: 'P'.repeat(24) }),
        httpRequestContextMfa,
      ),
    );
    expect(totpUri.status).toBe(200);
    expect(fixture.state.totpUriInputs).toHaveLength(1);
    expect(fixture.state.totpUriInputs[0]?.body).toStrictEqual({ password: 'P'.repeat(24) });
  }),
);

/**
 * The freshness gate's own proof, over the real reader rather than a fixture reader: Better Auth
 * resolves the cookie to a session identity, and the owner's lifecycle answers when that session
 * was last authenticated. `CommercePortalAuthSessionStore.rotateWithAudit` preserves `createdAt` on
 * the replacement row — deliberately, so the absolute session lifetime survives a rotation — so the
 * row's age can never stand in for "recently authenticated".
 */
const FRESHNESS_SUBJECT = 'commerce-freshness-subject';
const STALE_AGE_MILLIS = (COMMERCE_PORTAL_AUTH_POLICY.session.freshAgeSeconds + 600) * 1000;

const freshnessRecord = (id: string, token: string): CommercePortalAuthSessionRecord => ({
  authenticatedAt: null,
  banExpiresAt: null,
  banned: false,
  createdAt: new Date(TEST_NOW_MILLIS - STALE_AGE_MILLIS),
  emailVerified: true,
  expiresAt: new Date(TEST_NOW_MILLIS + 3_600_000),
  id,
  providerSubjectId: FRESHNESS_SUBJECT,
  token,
  updatedAt: new Date(TEST_NOW_MILLIS - STALE_AGE_MILLIS),
});

const freshnessSessionStore = (initial: readonly CommercePortalAuthSessionRecord[]): CommercePortalAuthSessionStore => {
  const sessions = new Map(initial.map((value) => [value.id, value]));
  return {
    countActive: () => Effect.die('unused in MFA freshness tests'),
    disableAccountWithAudit: () => Effect.die('unused in MFA freshness tests'),
    findById: (id) =>
      Effect.sync(() => {
        const value = sessions.get(id);
        return value === undefined ? Option.none() : Option.some(value);
      }),
    findByToken: () => Effect.die('unused in MFA freshness tests'),
    revoke: () => Effect.die('unused in MFA freshness tests'),
    revokeAllWithAudit: () => Effect.die('unused in MFA freshness tests'),
    revokeWithAudit: () => Effect.die('unused in MFA freshness tests'),
    rotateWithAudit: ({ authenticatedAt, expiresAt, now: clockNow, sessionId }) =>
      Effect.sync(() => {
        const current = sessions.get(sessionId);
        if (current === undefined) {
          return Option.none<CommercePortalAuthSessionRecord>();
        }
        const replacement: CommercePortalAuthSessionRecord = {
          ...current,
          authenticatedAt: authenticatedAt ?? current.authenticatedAt,
          expiresAt,
          id: `${sessionId}-rotated`,
          token: `${current.token}-rotated`,
          updatedAt: clockNow,
        };
        sessions.delete(sessionId);
        sessions.set(replacement.id, replacement);
        return Option.some(replacement);
      }),
    touch: () => Effect.die('unused in MFA freshness tests'),
    touchWithAudit: () => Effect.die('unused in MFA freshness tests'),
  };
};

/** The provider half of the gate: a cookie resolves to exactly one session identity. */
const freshnessProviderApi = (currentSessionId: { value: string }): CommercePortalAuthMfaSessionReadApi => ({
  getSession: () =>
    Effect.sync((): Option.Option<CommercePortalAuthMfaSessionSnapshot> =>
      Option.some({
        session: { id: currentSessionId.value },
        user: { id: FRESHNESS_SUBJECT },
      }),
    ),
});

const unusedFreshnessSignIn: CommercePortalAuthSessionProvider = {
  signInEmail: () => Effect.die('unused in MFA freshness tests'),
};

it.effect('admits an old session only after a step-up that re-authenticated that exact session', () =>
  Effect.gen(function* freshnessThroughStepUp() {
    const store = freshnessSessionStore([
      freshnessRecord('session-stepped-up', 'token-stepped-up'),
      freshnessRecord('session-other', 'token-other'),
    ]);
    const lifecycle = makeCommercePortalAuthSessionLifecycle(
      store,
      unusedFreshnessSignIn,
      unauditedCommercePortalAuthRecorder,
      {
        now: () => new Date(TEST_NOW_MILLIS),
      },
    );
    const currentSessionId = { value: 'session-stepped-up' };
    const fixture = makeMfaHttpFixture();
    const app = yield* makeMfaHttpApp(
      fixture,
      commercePortalAuthMfaFreshnessReaderFromApi(freshnessProviderApi(currentSessionId), lifecycle),
    );
    const enable = () =>
      Effect.promise(() =>
        app.handler(
          mfaHttpRequest('/api/portal-auth/two-factor/enable', { password: 'P'.repeat(24) }),
          httpRequestContextMfa,
        ),
      );

    // An old session that was never re-authenticated is not fresh, however long it stays alive.
    const beforeStepUp = yield* enable();
    expect(beforeStepUp.status).toBe(401);
    expect(yield* Effect.promise(() => beforeStepUp.json())).toMatchObject({
      code: 'mfa_authentication_not_fresh',
    });
    expect(fixture.state.enableInputs).toHaveLength(0);

    const steppedUp = yield* lifecycle.rotateIdentifierForCookie({
      expectedProviderSubjectId: FRESHNESS_SUBJECT,
      reason: 'step-up',
      sessionRef: yield* encodeCommerceSessionReference('session-stepped-up'),
    });
    // The rotation kept the absolute lifetime anchor and moved only the authentication stamp.
    expect(steppedUp.session.createdAt).toStrictEqual(new Date(TEST_NOW_MILLIS - STALE_AGE_MILLIS));
    expect(steppedUp.session.authenticatedAt).toStrictEqual(new Date(TEST_NOW_MILLIS));

    currentSessionId.value = 'session-stepped-up-rotated';
    const afterStepUp = yield* enable();
    expect(afterStepUp.status).toBe(200);
    expect(fixture.state.enableInputs).toHaveLength(1);

    // The completed step-up belongs to one session. Another session of the same customer is
    // untouched by it and stays outside the window.
    currentSessionId.value = 'session-other';
    const otherSession = yield* enable();
    expect(otherSession.status).toBe(401);
    expect(yield* Effect.promise(() => otherSession.json())).toMatchObject({
      code: 'mfa_authentication_not_fresh',
    });
    expect(fixture.state.enableInputs).toHaveLength(1);
  }),
);
