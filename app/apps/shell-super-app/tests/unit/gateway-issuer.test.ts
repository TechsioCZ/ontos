import { Effect, Exit, Fiber, Predicate } from 'effect';
import { expect, rs, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';
import {
  decodeJwt,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  jwtVerify,
} from 'jose';

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
  trailing: Trailing
) =>
  condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing };

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

const makeConfiguration = (): Effect.Effect<{
  readonly configuration: GatewayIssuerConfigValue;
  readonly publicKey: CryptoKey;
}> =>
  Effect.gen(function* testProgram1() {
    const { privateKey, publicKey } = yield* Effect.promise(() =>
      generateKeyPair('EdDSA', {
        crv: 'Ed25519',
        extractable: true,
      })
    );
    const privateJwk = yield* Effect.promise(() => exportJWK(privateKey));
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
  });

const dependencies = (
  configuration: GatewayIssuerConfigValue,
  overrides: Partial<GatewayIssuerLayerOptions> = {}
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
  options: GatewayIssuerLayerOptions
) =>
  issueGatewayContextAssertion(input).pipe(
    Effect.provide(makeGatewayIssuerLayer(options))
  );

it.effect(
  'memoises configuration within the refresh window and issues signed assertions',
  () =>
    Effect.gen(function* testProgram2() {
      const { configuration, publicKey } = yield* makeConfiguration();
      let configurationLoads = 0;
      const layer = makeGatewayIssuerLayer(
        dependencies(configuration, {
          loadConfig: Effect.sync(() => {
            configurationLoads += 1;
            return configuration;
          }),
        })
      );
      const [result] = yield* Effect.all(
        [
          issueGatewayContextAssertion({
            audience: 'property-registry',
            principal,
          }),
          issueGatewayContextAssertion({
            audience: 'property-registry',
            principal,
          }),
        ],
        { concurrency: 2 }
      ).pipe(Effect.provide(layer));
      const header = decodeProtectedHeader(result.token);
      const claims = decodeJwt(result.token);
      const verified = yield* Effect.promise(() =>
        jwtVerify(result.token, publicKey, {
          algorithms: ['EdDSA'],
          audience: 'property-registry',
          currentDate: new Date(1_700_000_001_000),
          issuer,
        })
      );

      expect(result.expiresAt).toBe(1_700_000_300);
      expect(header).toEqual({
        alg: 'EdDSA',
        kid: 'current-2026-08',
        typ: 'JWT',
      });
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
        /email|displayName|credential|cookie|sessionToken|actionKey|permission|policy|businessPayload/u
      );
      expect(configurationLoads).toBe(1);
    })
);

it.effect('shares cached configuration across concurrent valid issuances', () =>
  Effect.gen(function* testProgram3() {
    const { configuration, publicKey } = yield* makeConfiguration();
    let loadConfigCount = 0;
    const layer = makeGatewayIssuerLayer(
      dependencies(configuration, {
        loadConfig: Effect.sync(() => {
          loadConfigCount += 1;
          return configuration;
        }),
      })
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        rs.restoreAllMocks();
      })
    );
    const importKey = rs.spyOn(globalThis.crypto.subtle, 'importKey');
    const results = yield* Effect.all(
      Array.from({ length: 8 }, () =>
        issueGatewayContextAssertion({
          audience: 'property-registry',
          principal,
        })
      ),
      { concurrency: 8 }
    ).pipe(Effect.provide(layer));
    // The signing key is imported once and shared: the slot serialises concurrent first callers.
    expect(importKey).toHaveBeenCalledTimes(1);
    expect(results.length).toBe(8);
    expect(loadConfigCount).toBe(1);
    yield* Effect.all(
      results.map((result) =>
        Effect.gen(function* testProgram4() {
          const verified = yield* Effect.promise(() =>
            jwtVerify(result.token, publicKey, {
              algorithms: ['EdDSA'],
              audience: 'property-registry',
              currentDate: new Date(1_700_000_001_000),
              issuer,
            })
          );
          expect(verified.payload['principal']).toEqual(principal);
        })
      ),
      { concurrency: 'unbounded' }
    );
  })
);

it.effect(
  'allows the next issuance after interrupting a pending key import',
  () =>
    Effect.gen(function* testProgram5() {
      const { configuration, publicKey } = yield* makeConfiguration();
      const started = Promise.withResolvers<boolean>();
      const blocked = Promise.withResolvers<CryptoKey>();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          blocked.resolve(publicKey);
          rs.restoreAllMocks();
        })
      );
      rs.spyOn(globalThis.crypto.subtle, 'importKey').mockImplementationOnce(
        () => {
          started.resolve(true);
          return blocked.promise;
        }
      );
      const result = yield* Effect.gen(function* interruptedImport() {
        const gatewayIssuer = yield* GatewayIssuer;
        const first = yield* gatewayIssuer
          .issue({ audience: 'property-registry', principal })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => started.promise);
        yield* Fiber.interrupt(first);
        expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true);
        return yield* gatewayIssuer.issue({
          audience: 'property-registry',
          principal,
        });
      }).pipe(
        Effect.provide(makeGatewayIssuerLayer(dependencies(configuration)))
      );
      yield* Effect.promise(() =>
        jwtVerify(result.token, publicKey, {
          algorithms: ['EdDSA'],
          audience: 'property-registry',
          currentDate: new Date(1_700_000_001_000),
          issuer,
        })
      );
    })
);

it.effect(
  'refreshes configuration after 30 seconds and replaces the rotated signing key',
  () =>
    Effect.gen(function* testProgram6() {
      const {
        configuration: initialConfiguration,
        publicKey: initialPublicKey,
      } = yield* makeConfiguration();
      const {
        configuration: generatedRotatedConfiguration,
        publicKey: rotatedPublicKey,
      } = yield* makeConfiguration();
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
            return loadConfigCount === 1
              ? initialConfiguration
              : rotatedConfiguration;
          }),
        })
      );
      const [initialResult, rotatedResult] = yield* Effect.gen(
        function* gatewayRotationSequence() {
          const initial = yield* issueGatewayContextAssertion({
            audience: 'property-registry',
            principal,
          });
          const cached = yield* issueGatewayContextAssertion({
            audience: 'property-registry',
            principal,
          });
          expect(loadConfigCount).toBe(1);
          expect(decodeProtectedHeader(cached.token).kid).toBe(
            initialConfiguration.privateJwk.kid
          );
          yield* TestClock.adjust('31 seconds');
          const rotated = yield* issueGatewayContextAssertion({
            audience: 'property-registry',
            principal,
          });
          return [initial, rotated] as const;
        }
      ).pipe(Effect.provide(layer), Effect.provide(TestClock.layer()));
      const initialHeader = decodeProtectedHeader(initialResult.token);
      const rotatedHeader = decodeProtectedHeader(rotatedResult.token);

      yield* Effect.promise(() =>
        jwtVerify(initialResult.token, initialPublicKey, {
          algorithms: ['EdDSA'],
          audience: 'property-registry',
          currentDate: new Date(1_700_000_001_000),
          issuer,
        })
      );
      yield* Effect.promise(() =>
        jwtVerify(rotatedResult.token, rotatedPublicKey, {
          algorithms: ['EdDSA'],
          audience: 'property-registry',
          currentDate: new Date(1_700_000_001_000),
          issuer,
        })
      );

      expect(loadConfigCount).toBe(2);
      expect(rotatedHeader.kid).toBe(rotatedConfiguration.privateJwk.kid);
      expect(rotatedHeader.kid).not.toBe(initialHeader.kid);
    })
);

it.effect('does not cache configuration failures', () =>
  Effect.gen(function* testProgram7() {
    const { configuration } = yield* makeConfiguration();
    let loadConfigCount = 0;
    const layer = makeGatewayIssuerLayer(
      dependencies(configuration, {
        loadConfig: Effect.suspend(() => {
          loadConfigCount += 1;
          return loadConfigCount === 1
            ? parseGatewayIssuerConfig({})
            : Effect.succeed(configuration);
        }),
      })
    );
    const [configurationError, result] = yield* Effect.gen(
      function* gatewayFailureSequence() {
        const configurationFailure = yield* Effect.flip(
          issueGatewayContextAssertion({
            audience: 'property-registry',
            principal,
          })
        );
        const issuedResult = yield* issueGatewayContextAssertion({
          audience: 'property-registry',
          principal,
        });
        return [configurationFailure, issuedResult] as const;
      }
    ).pipe(Effect.provide(layer));
    expect(configurationError.stage).toBe('configuration');
    expect(result.token.length).toBeGreaterThan(0);
    expect(loadConfigCount).toBe(2);
  })
);

it.effect('retries a failed key import on the next issuance', () =>
  Effect.gen(function* testProgram8() {
    const { configuration, publicKey } = yield* makeConfiguration();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        rs.restoreAllMocks();
      })
    );
    rs.spyOn(globalThis.crypto.subtle, 'importKey').mockRejectedValueOnce(
      new Error('transient import failure')
    );
    const [error, result] = yield* Effect.gen(function* retryImport() {
      const failed = yield* Effect.flip(
        issueGatewayContextAssertion({
          audience: 'property-registry',
          principal,
        })
      );
      const issued = yield* issueGatewayContextAssertion({
        audience: 'property-registry',
        principal,
      });
      return [failed, issued] as const;
    }).pipe(
      Effect.provide(makeGatewayIssuerLayer(dependencies(configuration)))
    );
    expect(error.stage).toBe('signing');
    yield* Effect.promise(() =>
      jwtVerify(result.token, publicKey, {
        algorithms: ['EdDSA'],
        audience: 'property-registry',
        currentDate: new Date(1_700_000_001_000),
        issuer,
      })
    );
  })
);

it.effect(
  'fails closed for unknown audiences and invalid Effect-managed time',
  () =>
    Effect.gen(function* testProgram9() {
      const { configuration } = yield* makeConfiguration();
      const audienceErrors = yield* Effect.all(
        [
          Effect.flip(
            issueGatewayContextAssertionWith(
              { audience: 'billing', principal },
              dependencies(configuration)
            )
          ),
          Effect.flip(
            issueGatewayContextAssertionWith(
              { audience: 'property.registry', principal },
              dependencies(configuration)
            )
          ),
        ].map((effect) =>
          Effect.gen(function* testProgram10() {
            return yield* effect;
          })
        ),
        { concurrency: 'unbounded' }
      );
      const timeError = yield* Effect.flip(
        issueGatewayContextAssertionWith(
          { audience: 'property-registry', principal },
          dependencies(configuration, {
            currentTimeSeconds: Effect.succeed(-1),
          })
        )
      );

      expect(
        audienceErrors.every(
          (error) => error.code === 'gateway_audience_invalid'
        )
      ).toBe(true);
      expect(audienceErrors.every((error) => error.stage === 'audience')).toBe(
        true
      );
      expect(timeError.code).toBe('gateway_issuer_unavailable');
      expect(timeError.stage).toBe('clock');
    })
);

it.effect(
  'rejects transport correlation or any other excess principal claim',
  () =>
    Effect.gen(function* testProgram11() {
      const { configuration } = yield* makeConfiguration();
      const error = yield* Effect.flip(
        issueGatewayContextAssertionWith(
          {
            audience: 'property-registry',
            principal: { ...principal, correlationId: 'must-remain-a-header' },
          },
          dependencies(configuration)
        )
      );
      expect(error.code).toBe('gateway_issuer_unavailable');
      expect(error.stage).toBe('principal');
    })
);

it.effect(
  'identifies configuration and signing failures without exposing key material',
  () =>
    Effect.gen(function* testProgram12() {
      const { configuration } = yield* makeConfiguration();
      const configurationError = yield* Effect.flip(
        issueGatewayContextAssertionWith(
          { audience: 'property-registry', principal },
          dependencies(configuration, {
            loadConfig: parseGatewayIssuerConfig({}),
          })
        )
      );
      const signingError = yield* Effect.flip(
        issueGatewayContextAssertionWith(
          { audience: 'property-registry', principal },
          dependencies({
            ...configuration,
            privateJwk: { ...configuration.privateJwk, d: 'invalid' },
          })
        )
      );

      expect(configurationError.stage).toBe('configuration');
      expect(signingError.stage).toBe('signing');
      expect(configurationError.reason).not.toContain(
        'ONTOS_GATEWAY_PRIVATE_JWK'
      );
      expect(signingError.reason).not.toContain(configuration.privateJwk.d);
    })
);

it.effect(
  'rejects missing configuration, HMAC keys, non-Ed25519 keys, and missing key IDs',
  () =>
    Effect.gen(function* testProgram13() {
      const invalidJwks = [
        undefined,
        {
          alg: 'HS256',
          d: 'secret',
          kid: 'hmac',
          kty: 'oct',
          use: 'sig',
          x: 'secret',
        },
        {
          alg: 'EdDSA',
          crv: 'X25519',
          d: 'private',
          kid: 'wrong-curve',
          kty: 'OKP',
          use: 'sig',
          x: 'public',
        },
        {
          alg: 'EdDSA',
          crv: 'Ed25519',
          d: 'private',
          kty: 'OKP',
          use: 'sig',
          x: 'public',
        },
      ];

      const errors = yield* Effect.all(
        invalidJwks.map((privateJwk) =>
          Effect.gen(function* testProgram14() {
            return yield* Effect.flip(
              parseGatewayIssuerConfig(
                withOptionalProperty(
                  {
                    ONTOS_GATEWAY_ISSUER: issuer,
                  },
                  privateJwk !== undefined,
                  'ONTOS_GATEWAY_PRIVATE_JWK',
                  JSON.stringify(privateJwk),
                  {}
                )
              )
            );
          })
        ),
        { concurrency: 'unbounded' }
      );
      expect(
        errors.every((error) =>
          Predicate.isTagged(error, 'GatewayIssuerConfigError')
        )
      ).toBe(true);
    })
);
