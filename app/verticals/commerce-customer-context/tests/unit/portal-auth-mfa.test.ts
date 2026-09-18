import { Effect, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { OTPOptions } from 'better-auth/plugins/two-factor';

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
  makeCommercePortalAuthMfaService().pipe(
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
    expect(narrowCommercePortalAuthMfaTrustDevice({ trustDevice: false })).toStrictEqual(
      Option.some({ trustDevice: false }),
    );
    expect(narrowCommercePortalAuthMfaTrustDevice({})).toStrictEqual(Option.some({}));
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
