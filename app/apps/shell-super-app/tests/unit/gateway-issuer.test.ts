import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import { expect, rs, test } from '@rstest/core';
import { Effect, Exit, Fiber, Predicate } from 'effect';
import { TestClock } from 'effect/testing';
import { decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { parseGatewayIssuerConfig } from '../../api/auth/gateway-issuer-config.ts';
import type { GatewayIssuerConfigValue } from '../../api/auth/gateway-issuer-config.ts';
import {
  GatewayIssuer,
  issueGatewayContextAssertion,
  makeGatewayIssuerLayer,
} from '../../api/auth/gateway-issuer.ts';
import type { GatewayIssuerLayerOptions } from '../../api/auth/gateway-issuer.ts';

const withOptionalProperty = <
  Base extends object,
  Key extends PropertyKey,
  Value,
  Trailing extends object,
>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

const issuer = 'https://shell.example.test';
const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:safe-reference',
  authMethod: 'support_impersonation' as const,
  impersonatedByPrincipalId: '20000000-0000-4000-8000-000000000001',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '40000000-0000-4000-8000-000000000001',
  tenantId: '50000000-0000-4000-8000-000000000001',
};

const makeConfiguration = async (): Promise<{
  readonly configuration: GatewayIssuerConfigValue;
  readonly publicKey: CryptoKey;
}> => {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  const privateJwk = await exportJWK(privateKey);
  return {
    configuration: {
      issuer,
      privateJwk: {
        alg: 'EdDSA',
        crv: 'Ed25519',
        d: privateJwk.d ?? '',
        kid: 'current-2026-08',
        kty: 'OKP',
        use: 'sig',
        x: privateJwk.x ?? '',
      },
    },
    publicKey,
  };
};

const dependencies = (
  configuration: GatewayIssuerConfigValue,
  overrides: Partial<GatewayIssuerLayerOptions> = {},
): GatewayIssuerLayerOptions => ({
  currentTimeSeconds: Effect.succeed(1_700_000_000),
  generateJti: Effect.succeed('60000000-0000-4000-8000-000000000001'),
  loadAudiences: Effect.succeed(new Set(['property-registry'])),
  loadConfig: Effect.succeed(configuration),
  ...overrides,
});

const issueGatewayContextAssertionWith = <Principal>(
  input: {
    readonly audience: string;
    readonly principal: Principal;
  },
  options: GatewayIssuerLayerOptions,
) => issueGatewayContextAssertion(input).pipe(Effect.provide(makeGatewayIssuerLayer(options)));

test('memoises configuration within the refresh window and issues signed assertions', async () => {
  const { configuration, publicKey } = await makeConfiguration();
  let configurationLoads = 0;
  const layer = makeGatewayIssuerLayer(
    dependencies(configuration, {
      loadConfig: Effect.sync(() => {
        configurationLoads += 1;
        return configuration;
      }),
    }),
  );
  const [result] = await runEffectTestPromise(
    Effect.all(
      [
        issueGatewayContextAssertion({ audience: 'property-registry', principal }),
        issueGatewayContextAssertion({ audience: 'property-registry', principal }),
      ],
      { concurrency: 2 },
    ).pipe(Effect.provide(layer)),
  );
  const header = decodeProtectedHeader(result.token);
  const claims = decodeJwt(result.token);
  const verified = await jwtVerify(result.token, publicKey, {
    algorithms: ['EdDSA'],
    audience: 'property-registry',
    currentDate: new Date(1_700_000_001_000),
    issuer,
  });

  expect(result.expiresAt).toBe(1_700_000_300);
  expect(header).toEqual({ alg: 'EdDSA', kid: 'current-2026-08', typ: 'JWT' });
  expect(claims).toEqual({
    aud: 'property-registry',
    exp: 1_700_000_300,
    iat: 1_700_000_000,
    iss: issuer,
    jti: '60000000-0000-4000-8000-000000000001',
    principal,
    sub: principal.principalId,
    ver: 1,
  });
  expect(verified.payload['principal']).toEqual(principal);
  expect(JSON.stringify(claims)).not.toMatch(
    /email|displayName|credential|cookie|sessionToken|actionKey|permission|policy|businessPayload/u,
  );
  expect(configurationLoads).toBe(1);
});

test('shares cached configuration across concurrent valid issuances', async () => {
  const { configuration, publicKey } = await makeConfiguration();
  let loadConfigCount = 0;
  const layer = makeGatewayIssuerLayer(
    dependencies(configuration, {
      loadConfig: Effect.sync(() => {
        loadConfigCount += 1;
        return configuration;
      }),
    }),
  );
  const importKey = rs.spyOn(globalThis.crypto.subtle, 'importKey');
  let results: readonly { readonly token: string }[];
  try {
    results = await runEffectTestPromise(
      Effect.all(
        Array.from({ length: 8 }, () =>
          issueGatewayContextAssertion({ audience: 'property-registry', principal }),
        ),
        { concurrency: 8 },
      ).pipe(Effect.provide(layer)),
    );
    // The signing key is imported once and shared: the slot serialises concurrent first callers.
    expect(importKey).toHaveBeenCalledTimes(1);
  } finally {
    importKey.mockRestore();
  }
  expect(results.length).toBe(8);
  expect(loadConfigCount).toBe(1);
  await Promise.all(
    results.map(async (result) => {
      const verified = await jwtVerify(result.token, publicKey, {
        algorithms: ['EdDSA'],
        audience: 'property-registry',
        currentDate: new Date(1_700_000_001_000),
        issuer,
      });
      expect(verified.payload['principal']).toEqual(principal);
    }),
  );
});

test('allows the next issuance after interrupting a pending key import', async () => {
  const { configuration, publicKey } = await makeConfiguration();
  const started = Promise.withResolvers<boolean>();
  const blocked = Promise.withResolvers<CryptoKey>();
  const importKey = rs
    .spyOn(globalThis.crypto.subtle, 'importKey')
    .mockImplementationOnce(async () => {
      started.resolve(true);
      return await blocked.promise;
    });
  try {
    const result = await runEffectTestPromise(
      Effect.gen(function* interruptedImport() {
        const gatewayIssuer = yield* GatewayIssuer;
        const first = yield* gatewayIssuer
          .issue({ audience: 'property-registry', principal })
          .pipe(Effect.forkChild);
        yield* Effect.promise(async () => await started.promise);
        yield* Fiber.interrupt(first);
        expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true);
        return yield* gatewayIssuer.issue({ audience: 'property-registry', principal });
      }).pipe(Effect.provide(makeGatewayIssuerLayer(dependencies(configuration)))),
    );
    await jwtVerify(result.token, publicKey, {
      algorithms: ['EdDSA'],
      audience: 'property-registry',
      currentDate: new Date(1_700_000_001_000),
      issuer,
    });
  } finally {
    blocked.resolve(publicKey);
    importKey.mockRestore();
  }
});

test('refreshes configuration after 30 seconds and replaces the rotated signing key', async () => {
  const { configuration: initialConfiguration, publicKey: initialPublicKey } =
    await makeConfiguration();
  const { configuration: generatedRotatedConfiguration, publicKey: rotatedPublicKey } =
    await makeConfiguration();
  const rotatedConfiguration = {
    ...generatedRotatedConfiguration,
    privateJwk: {
      ...generatedRotatedConfiguration.privateJwk,
      kid: 'rotated-2026-09',
    },
  };
  let loadConfigCount = 0;
  const layer = makeGatewayIssuerLayer(
    dependencies(initialConfiguration, {
      loadConfig: Effect.sync(() => {
        loadConfigCount += 1;
        return loadConfigCount === 1 ? initialConfiguration : rotatedConfiguration;
      }),
    }),
  );
  const [initialResult, rotatedResult] = await runEffectTestPromise(
    Effect.gen(function* gatewayRotationSequence() {
      const initial = yield* issueGatewayContextAssertion({
        audience: 'property-registry',
        principal,
      });
      const cached = yield* issueGatewayContextAssertion({
        audience: 'property-registry',
        principal,
      });
      expect(loadConfigCount).toBe(1);
      expect(decodeProtectedHeader(cached.token).kid).toBe(initialConfiguration.privateJwk.kid);
      yield* TestClock.adjust('31 seconds');
      const rotated = yield* issueGatewayContextAssertion({
        audience: 'property-registry',
        principal,
      });
      return [initial, rotated] as const;
    }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer())),
  );
  const initialHeader = decodeProtectedHeader(initialResult.token);
  const rotatedHeader = decodeProtectedHeader(rotatedResult.token);

  await jwtVerify(initialResult.token, initialPublicKey, {
    algorithms: ['EdDSA'],
    audience: 'property-registry',
    currentDate: new Date(1_700_000_001_000),
    issuer,
  });
  await jwtVerify(rotatedResult.token, rotatedPublicKey, {
    algorithms: ['EdDSA'],
    audience: 'property-registry',
    currentDate: new Date(1_700_000_001_000),
    issuer,
  });

  expect(loadConfigCount).toBe(2);
  expect(rotatedHeader.kid).toBe(rotatedConfiguration.privateJwk.kid);
  expect(rotatedHeader.kid).not.toBe(initialHeader.kid);
});

test('does not cache configuration failures', async () => {
  const { configuration } = await makeConfiguration();
  let loadConfigCount = 0;
  const layer = makeGatewayIssuerLayer(
    dependencies(configuration, {
      loadConfig: Effect.suspend(() => {
        loadConfigCount += 1;
        return loadConfigCount === 1 ? parseGatewayIssuerConfig({}) : Effect.succeed(configuration);
      }),
    }),
  );
  const [configurationError, result] = await runEffectTestPromise(
    Effect.gen(function* gatewayFailureSequence() {
      const configurationFailure = yield* Effect.flip(
        issueGatewayContextAssertion({ audience: 'property-registry', principal }),
      );
      const issuedResult = yield* issueGatewayContextAssertion({
        audience: 'property-registry',
        principal,
      });
      return [configurationFailure, issuedResult] as const;
    }).pipe(Effect.provide(layer)),
  );
  expect(configurationError.stage).toBe('configuration');
  expect(result.token.length).toBeGreaterThan(0);
  expect(loadConfigCount).toBe(2);
});

test('retries a failed key import on the next issuance', async () => {
  const { configuration, publicKey } = await makeConfiguration();
  const importKey = rs
    .spyOn(globalThis.crypto.subtle, 'importKey')
    .mockRejectedValueOnce(new Error('transient import failure'));
  try {
    const [error, result] = await runEffectTestPromise(
      Effect.gen(function* retryImport() {
        const failed = yield* Effect.flip(
          issueGatewayContextAssertion({ audience: 'property-registry', principal }),
        );
        const issued = yield* issueGatewayContextAssertion({
          audience: 'property-registry',
          principal,
        });
        return [failed, issued] as const;
      }).pipe(Effect.provide(makeGatewayIssuerLayer(dependencies(configuration)))),
    );
    expect(error.stage).toBe('signing');
    await jwtVerify(result.token, publicKey, {
      algorithms: ['EdDSA'],
      audience: 'property-registry',
      currentDate: new Date(1_700_000_001_000),
      issuer,
    });
  } finally {
    importKey.mockRestore();
  }
});

test('fails closed for unknown audiences and invalid Effect-managed time', async () => {
  const { configuration } = await makeConfiguration();
  const audienceErrors = await Promise.all(
    [
      Effect.flip(
        issueGatewayContextAssertionWith(
          { audience: 'billing', principal },
          dependencies(configuration),
        ),
      ),
      Effect.flip(
        issueGatewayContextAssertionWith(
          { audience: 'property.registry', principal },
          dependencies(configuration),
        ),
      ),
    ].map(async (effect) => await runEffectTestPromise(effect)),
  );
  const timeError = await runEffectTestPromise(
    Effect.flip(
      issueGatewayContextAssertionWith(
        { audience: 'property-registry', principal },
        dependencies(configuration, { currentTimeSeconds: Effect.succeed(-1) }),
      ),
    ),
  );

  expect(audienceErrors.every((error) => error.code === 'gateway_audience_invalid')).toBe(true);
  expect(audienceErrors.every((error) => error.stage === 'audience')).toBe(true);
  expect(timeError.code).toBe('gateway_issuer_unavailable');
  expect(timeError.stage).toBe('clock');
});

test('rejects transport correlation or any other excess principal claim', async () => {
  const { configuration } = await makeConfiguration();
  const error = await runEffectTestPromise(
    Effect.flip(
      issueGatewayContextAssertionWith(
        {
          audience: 'property-registry',
          principal: { ...principal, correlationId: 'must-remain-a-header' },
        },
        dependencies(configuration),
      ),
    ),
  );
  expect(error.code).toBe('gateway_issuer_unavailable');
  expect(error.stage).toBe('principal');
});

test('identifies configuration and signing failures without exposing key material', async () => {
  const { configuration } = await makeConfiguration();
  const configurationError = await runEffectTestPromise(
    Effect.flip(
      issueGatewayContextAssertionWith(
        { audience: 'property-registry', principal },
        dependencies(configuration, {
          loadConfig: parseGatewayIssuerConfig({}),
        }),
      ),
    ),
  );
  const signingError = await runEffectTestPromise(
    Effect.flip(
      issueGatewayContextAssertionWith(
        { audience: 'property-registry', principal },
        dependencies({
          ...configuration,
          privateJwk: { ...configuration.privateJwk, d: 'invalid' },
        }),
      ),
    ),
  );

  expect(configurationError.stage).toBe('configuration');
  expect(signingError.stage).toBe('signing');
  expect(configurationError.reason).not.toContain('ONTOS_GATEWAY_PRIVATE_JWK');
  expect(signingError.reason).not.toContain(configuration.privateJwk.d);
});

test('rejects missing configuration, HMAC keys, non-Ed25519 keys, and missing key IDs', async () => {
  const invalidJwks = [
    undefined,
    { alg: 'HS256', d: 'secret', kid: 'hmac', kty: 'oct', use: 'sig', x: 'secret' },
    {
      alg: 'EdDSA',
      crv: 'X25519',
      d: 'private',
      kid: 'wrong-curve',
      kty: 'OKP',
      use: 'sig',
      x: 'public',
    },
    { alg: 'EdDSA', crv: 'Ed25519', d: 'private', kty: 'OKP', use: 'sig', x: 'public' },
  ];

  const errors = await Promise.all(
    invalidJwks.map(
      async (privateJwk) =>
        await runEffectTestPromise(
          Effect.flip(
            parseGatewayIssuerConfig(
              withOptionalProperty(
                {
                  ONTOS_GATEWAY_ISSUER: issuer,
                },
                privateJwk !== undefined,
                'ONTOS_GATEWAY_PRIVATE_JWK',
                JSON.stringify(privateJwk),
                {},
              ),
            ),
          ),
        ),
    ),
  );
  expect(errors.every((error) => Predicate.isTagged(error, 'GatewayIssuerConfigError'))).toBe(true);
});
