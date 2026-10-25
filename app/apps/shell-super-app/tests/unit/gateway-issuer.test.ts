import { ConfigProvider, Effect, Exit, Fiber, Layer, Predicate, Redacted, Schema } from 'effect';
import { expect, rs, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';
import { decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import {
  EXTERNAL_GATEWAY_ASSERTION_VERSION,
  GatewayContextClaimsSchema,
  GatewayContextV2ClaimsSchema,
} from '@app/shared-contracts';

import { GatewayScopeGrantUnavailableError, makeActiveApplicationCompositionLayer } from '@app/core-runtime';
import { makeModuleContractFixture } from '../../../../packages/core-runtime/src/testing/module-contract.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { capturingScopeGrantRegistrar, scopeGrantRegistrarLayer } from '../support/gateway-issuer-layer.ts';

import type { GatewayAssertionRedemption } from '../../../../packages/core-runtime/src/auth/gateway-assertion-redemption.ts';
import {
  ActionPrincipalInvalidErrorSchema,
  ActionPrincipalScopeErrorSchema,
  bindGatewayPrincipalVerifier,
  makeGatewayPrincipalVerifierLayer,
} from '../../../../packages/gateway-principal-verifier/src/server.ts';
import { parseGatewayIssuerConfig } from '../../api/auth/gateway-issuer-config.ts';
import type { GatewayIssuerConfigValue } from '../../api/auth/gateway-issuer-config.ts';
import { GatewayIssuer, issueGatewayContextAssertion, makeGatewayIssuerLayer } from '../../api/auth/gateway-issuer.ts';
import type { GatewayIssuerLayerOptions } from '../../api/auth/gateway-issuer.ts';

const withOptionalProperty = <Base extends object, Key extends PropertyKey, Value, Trailing extends object>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

const issuer = 'https://shell.example.test';
const compositionRevision = 'a'.repeat(64);
const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:safe-reference',
  authMethod: 'support_impersonation' as const,
  impersonatedByPrincipalId: '20000000-0000-4000-8000-000000000001',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '40000000-0000-4000-8000-000000000001',
  tenantId: '50000000-0000-4000-8000-000000000001',
};
const namespacedPrincipal = {
  ...principal,
  authenticationNamespaceId: 'test.staff.better-auth.v1',
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
      }),
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
  overrides: Partial<GatewayIssuerLayerOptions> = {},
): GatewayIssuerLayerOptions => ({
  currentTimeSeconds: Effect.succeed(1_700_000_000),
  generateJti: Effect.succeed('60000000-0000-4000-8000-000000000001'),
  loadAdmission: Effect.succeed({
    audiences: new Map([['property-registry', 'property-registry-build']]),
    revision: compositionRevision,
  }),
  loadConfig: Effect.succeed(configuration),
  ...overrides,
});

const issueGatewayContextAssertionWith = <Principal>(
  input: {
    readonly audience: string;
    readonly compositionRevision?: string;
    readonly principal: Principal;
  },
  options: GatewayIssuerLayerOptions,
) =>
  issueGatewayContextAssertion({
    ...input,
    compositionRevision: input.compositionRevision ?? compositionRevision,
  }).pipe(Effect.provide(makeGatewayIssuerLayer(options).pipe(Layer.provide(scopeGrantRegistrarLayer()))));

it.effect('memoises configuration within the refresh window and issues signed assertions', () =>
  Effect.gen(function* testProgram2() {
    const { configuration, publicKey } = yield* makeConfiguration();
    let configurationLoads = 0;
    const layer = makeGatewayIssuerLayer(
      dependencies(configuration, {
        loadConfig: Effect.sync(() => {
          configurationLoads += 1;
          return configuration;
        }),
      }),
    ).pipe(Layer.provide(scopeGrantRegistrarLayer()));
    const [result] = yield* Effect.all(
      [
        issueGatewayContextAssertion({
          audience: 'property-registry',
          compositionRevision,
          principal,
        }),
        issueGatewayContextAssertion({
          audience: 'property-registry',
          compositionRevision,
          principal,
        }),
      ],
      { concurrency: 2 },
    ).pipe(Effect.provide(layer));
    const header = decodeProtectedHeader(result.token);
    const claims = decodeJwt(result.token);
    const verified = yield* Effect.promise(() =>
      jwtVerify(result.token, publicKey, {
        algorithms: ['EdDSA'],
        audience: 'property-registry',
        currentDate: new Date(1_700_000_001_000),
        issuer,
      }),
    );

    expect(result.expiresAt).toBe(1_700_000_300);
    expect(result.compositionRevision).toBe(compositionRevision);
    expect(result.apiBaseUrl).toBe(
      '/shell-super-app-api/module-api/property-registry/property-registry-build/property-registry-api',
    );
    expect(header).toEqual({
      alg: 'EdDSA',
      kid: 'current-2026-08',
      typ: 'JWT',
    });
    expect(claims).toEqual({
      aud: 'property-registry',
      compositionRevision,
      exp: 1_700_000_300,
      iat: 1_700_000_000,
      iss: issuer,
      jti: '60000000-0000-4000-8000-000000000001',
      principal,
      sub: principal.principalId,
      targetBuildMarker: 'property-registry-build',
      ver: 1,
    });
    const legacyClaims = Schema.decodeUnknownSync(GatewayContextClaimsSchema)(claims);
    expect(legacyClaims.principal.authenticationNamespaceId).toBeUndefined();
    expect(verified.payload['principal']).toEqual(principal);
    expect(JSON.stringify(claims)).not.toMatch(
      /email|displayName|credential|cookie|sessionToken|actionKey|permission|policy|businessPayload/u,
    );
    expect(configurationLoads).toBe(1);
  }),
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
      }),
    ).pipe(Layer.provide(scopeGrantRegistrarLayer()));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        rs.restoreAllMocks();
      }),
    );
    const importKey = rs.spyOn(globalThis.crypto.subtle, 'importKey');
    const results = yield* Effect.all(
      Array.from({ length: 8 }, () =>
        issueGatewayContextAssertion({
          audience: 'property-registry',
          compositionRevision,
          principal,
        }),
      ),
      { concurrency: 8 },
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
            }),
          );
          expect(verified.payload['principal']).toEqual(principal);
        }),
      ),
      { concurrency: 'unbounded' },
    );
  }),
);

it.effect('admits a document once and signs each available audience independently', () =>
  Effect.gen(function* documentIssuance() {
    const { configuration, publicKey } = yield* makeConfiguration();
    let admissionLoads = 0;
    let signatures = 0;
    const layer = makeGatewayIssuerLayer(
      dependencies(configuration, {
        generateJti: Effect.sync(() => {
          signatures += 1;
          return `document-assertion-${signatures}`;
        }),
        loadAdmission: Effect.sync(() => {
          admissionLoads += 1;
          return {
            audiences: new Map([
              ['property-registry', 'property-registry-build'],
              ['tagging', 'tagging-build'],
            ]),
            revision: compositionRevision,
          };
        }),
      }),
    ).pipe(Layer.provide(scopeGrantRegistrarLayer()));
    const assertions = yield* GatewayIssuer.pipe(
      Effect.flatMap((gateway) =>
        gateway.issueDocument({
          audiences: ['property-registry', 'unavailable-owner', 'tagging'],
          compositionRevision,
          principal,
        }),
      ),
      Effect.provide(layer),
    );
    expect(admissionLoads).toBe(1);
    expect(signatures).toBe(2);
    expect(assertions.map(({ audience }) => audience)).toEqual(['property-registry', 'tagging']);
    for (const assertion of assertions) {
      const verified = yield* Effect.promise(() =>
        jwtVerify(assertion.token, publicKey, {
          algorithms: ['EdDSA'],
          audience: assertion.audience,
          currentDate: new Date(1_700_000_001_000),
          issuer,
        }),
      );
      expect(verified.payload['principal']).toEqual(principal);
      expect(verified.payload['compositionRevision']).toBe(compositionRevision);
      expect(verified.payload['targetBuildMarker']).toBe(`${assertion.audience}-build`);
    }
  }),
);

it.effect('rereads document admission after revocation and revision changes before reusing assertions', () =>
  Effect.gen(function* documentAdmissionChanges() {
    const { configuration } = yield* makeConfiguration();
    let admissionLoads = 0;
    let admitted = true;
    let revision = compositionRevision;
    const layer = makeGatewayIssuerLayer(
      dependencies(configuration, {
        loadAdmission: Effect.sync(() => {
          admissionLoads += 1;
          return {
            audiences: admitted
              ? new Map([['property-registry', 'property-registry-build']])
              : new Map<string, string>(),
            revision,
          };
        }),
      }),
    ).pipe(Layer.provide(scopeGrantRegistrarLayer()));
    yield* Effect.gen(function* changeAdmissionBetweenDocuments() {
      const gateway = yield* GatewayIssuer;
      const input = { audiences: ['property-registry'], compositionRevision, principal };
      expect((yield* gateway.issueDocument(input)).length).toBe(1);
      admitted = false;
      expect(yield* gateway.issueDocument(input)).toEqual([]);
      admitted = true;
      revision = 'b'.repeat(64);
      expect((yield* Effect.flip(gateway.issueDocument(input))).code).toBe('gateway_revision_unsupported');
      const refreshed = yield* gateway.issueDocument({ ...input, compositionRevision: revision });
      expect(refreshed[0]?.compositionRevision).toBe(revision);
      expect(admissionLoads).toBe(4);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect('rejects an invalid document principal before admission and leaves an empty batch idle', () =>
  Effect.gen(function* invalidDocumentPrincipal() {
    const { configuration } = yield* makeConfiguration();
    let admissionLoads = 0;
    const layer = makeGatewayIssuerLayer(
      dependencies(configuration, {
        loadAdmission: Effect.sync(() => {
          admissionLoads += 1;
          return { audiences: new Map<string, string>(), revision: compositionRevision };
        }),
      }),
    ).pipe(Layer.provide(scopeGrantRegistrarLayer()));
    yield* Effect.gen(function* documentPrincipalChecks() {
      const gateway = yield* GatewayIssuer;
      const failure = yield* Effect.flip(
        gateway.issueDocument({
          audiences: ['property-registry'],
          compositionRevision,
          principal: { ...principal, principalId: 'invalid' },
        }),
      );
      expect(failure.stage).toBe('principal');
      expect(yield* gateway.issueDocument({ audiences: [], compositionRevision, principal })).toEqual([]);
      expect(admissionLoads).toBe(0);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect('issues and verifies v2 assertions for namespaced principals', () =>
  Effect.gen(function* testProgramNamespacedPrincipal() {
    const { configuration, publicKey } = yield* makeConfiguration();
    const snapshot = yield* makeCompositionSnapshot([
      makeModuleContractFixture({ appId: 'property-registry', moduleId: 'property.registry' }),
    ]);
    const selectedRevision = snapshot.composition.revision;
    const layer = makeGatewayIssuerLayer(
      dependencies(configuration, {
        loadAdmission: Effect.succeed({
          audiences: new Map([['property-registry', 'property-registry-build']]),
          revision: selectedRevision,
        }),
      }),
    ).pipe(Layer.provide(scopeGrantRegistrarLayer()));
    const [legacyResult, result] = yield* Effect.all([
      issueGatewayContextAssertion({
        audience: 'property-registry',
        compositionRevision: selectedRevision,
        principal,
      }),
      issueGatewayContextAssertion({
        audience: 'property-registry',
        compositionRevision: selectedRevision,
        principal: namespacedPrincipal,
      }),
    ]).pipe(Effect.provide(layer));
    const verified = yield* Effect.promise(() =>
      jwtVerify(result.token, publicKey, {
        algorithms: ['EdDSA'],
        audience: 'property-registry',
        currentDate: new Date(1_700_000_001_000),
        issuer,
      }),
    );
    const claims = Schema.decodeUnknownSync(GatewayContextV2ClaimsSchema)(verified.payload);

    expect(claims.ver).toBe(EXTERNAL_GATEWAY_ASSERTION_VERSION);
    expect(claims.principal).toEqual(namespacedPrincipal);
    expect(claims.sub).toBe(namespacedPrincipal.principalId);

    const receiverEnvironment = {
      ONTOS_GATEWAY_ISSUER: issuer,
      ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
        keys: [
          {
            alg: configuration.privateJwk.alg,
            crv: configuration.privateJwk.crv,
            kid: configuration.privateJwk.kid,
            kty: configuration.privateJwk.kty,
            use: configuration.privateJwk.use,
            x: configuration.privateJwk.x,
          },
        ],
      }),
    } as const;
    const receiver = bindGatewayPrincipalVerifier('property-registry', {
      appId: 'property-registry',
      buildMarker: 'property-registry-build',
    });
    const receiverLayer = makeGatewayPrincipalVerifierLayer(ConfigProvider.fromUnknown(receiverEnvironment));
    const mappedLegacy = yield* receiver
      .verify(Redacted.make(`Bearer ${legacyResult.token}`), {
        currentTimeSeconds: Effect.succeed(1_700_000_001),
      })
      .pipe(
        Effect.provide(
          makeGatewayPrincipalVerifierLayer(ConfigProvider.fromUnknown(receiverEnvironment), {
            legacyNamespaceMapping: {
              authenticationNamespaceId: namespacedPrincipal.authenticationNamespaceId,
              issuer,
            },
          }),
        ),
      );
    expect(mappedLegacy).toEqual({
      ...principal,
      authenticationNamespaceId: namespacedPrincipal.authenticationNamespaceId,
    });
    expect(mappedLegacy.tenantId).toBe(principal.tenantId);

    const verifiedByReceiver = yield* receiver
      .verify(Redacted.make(`Bearer ${result.token}`), {
        currentTimeSeconds: Effect.succeed(1_700_000_001),
      })
      .pipe(Effect.provide(receiverLayer));
    expect(verifiedByReceiver).toEqual(namespacedPrincipal);
    expect(verifiedByReceiver.tenantId).toBe(namespacedPrincipal.tenantId);

    const wrongAudienceFailure = yield* Effect.flip(
      bindGatewayPrincipalVerifier('billing', { appId: 'billing', buildMarker: 'billing-build' })
        .verify(Redacted.make(`Bearer ${result.token}`), {
          currentTimeSeconds: Effect.succeed(1_700_000_001),
        })
        .pipe(Effect.provide(receiverLayer)),
    );
    expect(Schema.is(ActionPrincipalScopeErrorSchema)(wrongAudienceFailure)).toBe(true);

    const wrongIssuerFailure = yield* Effect.flip(
      receiver
        .verify(Redacted.make(`Bearer ${result.token}`), {
          currentTimeSeconds: Effect.succeed(1_700_000_001),
        })
        .pipe(
          Effect.provide(
            makeGatewayPrincipalVerifierLayer(
              ConfigProvider.fromUnknown({
                ...receiverEnvironment,
                ONTOS_GATEWAY_ISSUER: 'https://other-shell.example.test',
              }),
            ),
          ),
        ),
    );
    expect(Schema.is(ActionPrincipalScopeErrorSchema)(wrongIssuerFailure)).toBe(true);

    const tokenParts = result.token.split('.');
    const signature = tokenParts[2] ?? '';
    const tamperedToken = [
      tokenParts[0],
      tokenParts[1],
      `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`,
    ].join('.');
    const tamperedFailure = yield* Effect.flip(
      receiver
        .verify(Redacted.make(`Bearer ${tamperedToken}`), {
          currentTimeSeconds: Effect.succeed(1_700_000_001),
        })
        .pipe(Effect.provide(receiverLayer)),
    );
    expect(Schema.is(ActionPrincipalInvalidErrorSchema)(tamperedFailure)).toBe(true);

    const redemptionInputs: Parameters<GatewayAssertionRedemption['consume']>[0][] = [];
    const redemption: GatewayAssertionRedemption = {
      consume: (input) =>
        Effect.sync(() => {
          redemptionInputs.push(input);
        }),
    };
    const redeemed = yield* receiver
      .verifyAndRedeem(Redacted.make(`Bearer ${result.token}`), {
        currentTimeSeconds: Effect.succeed(1_700_000_001),
        redemption,
      })
      .pipe(Effect.provide(receiverLayer));
    expect(redeemed).toEqual(namespacedPrincipal);
    expect(redemptionInputs).toHaveLength(1);
    expect(redemptionInputs[0]).toEqual({
      audience: 'property-registry',
      expiresAtEpochSeconds: 1_700_000_300,
      issuer,
      jti: '60000000-0000-4000-8000-000000000001',
    });
  }).pipe(
    Effect.provide(
      makeActiveApplicationCompositionLayer(
        makeCompositionSnapshot([
          makeModuleContractFixture({ appId: 'property-registry', moduleId: 'property.registry' }),
        ]),
      ),
    ),
  ),
);

it.effect('allows the next issuance after interrupting a pending key import', () =>
  Effect.gen(function* testProgram5() {
    const { configuration, publicKey } = yield* makeConfiguration();
    const started = Promise.withResolvers<boolean>();
    const blocked = Promise.withResolvers<CryptoKey>();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        blocked.resolve(publicKey);
        rs.restoreAllMocks();
      }),
    );
    rs.spyOn(globalThis.crypto.subtle, 'importKey').mockImplementationOnce(() => {
      started.resolve(true);
      return blocked.promise;
    });
    const result = yield* Effect.gen(function* interruptedImport() {
      const gatewayIssuer = yield* GatewayIssuer;
      const first = yield* gatewayIssuer
        .issue({ audience: 'property-registry', compositionRevision, principal })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => started.promise);
      yield* Fiber.interrupt(first);
      expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true);
      return yield* gatewayIssuer.issue({
        audience: 'property-registry',
        compositionRevision,
        principal,
      });
    }).pipe(
      Effect.provide(
        makeGatewayIssuerLayer(dependencies(configuration)).pipe(Layer.provide(scopeGrantRegistrarLayer())),
      ),
    );
    yield* Effect.promise(() =>
      jwtVerify(result.token, publicKey, {
        algorithms: ['EdDSA'],
        audience: 'property-registry',
        currentDate: new Date(1_700_000_001_000),
        issuer,
      }),
    );
  }),
);

it.effect('refreshes configuration after 30 seconds and replaces the rotated signing key', () =>
  Effect.gen(function* testProgram6() {
    const { configuration: initialConfiguration, publicKey: initialPublicKey } = yield* makeConfiguration();
    const { configuration: generatedRotatedConfiguration, publicKey: rotatedPublicKey } = yield* makeConfiguration();
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
    ).pipe(Layer.provide(scopeGrantRegistrarLayer()));
    const [initialResult, rotatedResult] = yield* Effect.gen(function* gatewayRotationSequence() {
      const initial = yield* issueGatewayContextAssertion({
        audience: 'property-registry',
        compositionRevision,
        principal,
      });
      const cached = yield* issueGatewayContextAssertion({
        audience: 'property-registry',
        compositionRevision,
        principal,
      });
      expect(loadConfigCount).toBe(1);
      expect(decodeProtectedHeader(cached.token).kid).toBe(initialConfiguration.privateJwk.kid);
      yield* TestClock.adjust('31 seconds');
      const rotated = yield* issueGatewayContextAssertion({
        audience: 'property-registry',
        compositionRevision,
        principal,
      });
      return [initial, rotated] as const;
    }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer()));
    const initialHeader = decodeProtectedHeader(initialResult.token);
    const rotatedHeader = decodeProtectedHeader(rotatedResult.token);

    yield* Effect.promise(() =>
      jwtVerify(initialResult.token, initialPublicKey, {
        algorithms: ['EdDSA'],
        audience: 'property-registry',
        currentDate: new Date(1_700_000_001_000),
        issuer,
      }),
    );
    yield* Effect.promise(() =>
      jwtVerify(rotatedResult.token, rotatedPublicKey, {
        algorithms: ['EdDSA'],
        audience: 'property-registry',
        currentDate: new Date(1_700_000_001_000),
        issuer,
      }),
    );

    expect(loadConfigCount).toBe(2);
    expect(rotatedHeader.kid).toBe(rotatedConfiguration.privateJwk.kid);
    expect(rotatedHeader.kid).not.toBe(initialHeader.kid);
  }),
);

it.effect('does not cache configuration failures', () =>
  Effect.gen(function* testProgram7() {
    const { configuration } = yield* makeConfiguration();
    let loadConfigCount = 0;
    const layer = makeGatewayIssuerLayer(
      dependencies(configuration, {
        loadConfig: Effect.suspend(() => {
          loadConfigCount += 1;
          return loadConfigCount === 1 ? parseGatewayIssuerConfig({}) : Effect.succeed(configuration);
        }),
      }),
    ).pipe(Layer.provide(scopeGrantRegistrarLayer()));
    const [configurationError, result] = yield* Effect.gen(function* gatewayFailureSequence() {
      const configurationFailure = yield* Effect.flip(
        issueGatewayContextAssertion({
          audience: 'property-registry',
          compositionRevision,
          principal,
        }),
      );
      const issuedResult = yield* issueGatewayContextAssertion({
        audience: 'property-registry',
        compositionRevision,
        principal,
      });
      return [configurationFailure, issuedResult] as const;
    }).pipe(Effect.provide(layer));
    expect(configurationError.stage).toBe('configuration');
    expect(result.token.length).toBeGreaterThan(0);
    expect(loadConfigCount).toBe(2);
  }),
);

it.effect('retries a failed key import on the next issuance', () =>
  Effect.gen(function* testProgram8() {
    const { configuration, publicKey } = yield* makeConfiguration();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        rs.restoreAllMocks();
      }),
    );
    rs.spyOn(globalThis.crypto.subtle, 'importKey').mockRejectedValueOnce(new Error('transient import failure'));
    const [error, result] = yield* Effect.gen(function* retryImport() {
      const failed = yield* Effect.flip(
        issueGatewayContextAssertion({
          audience: 'property-registry',
          compositionRevision,
          principal,
        }),
      );
      const issued = yield* issueGatewayContextAssertion({
        audience: 'property-registry',
        compositionRevision,
        principal,
      });
      return [failed, issued] as const;
    }).pipe(
      Effect.provide(
        makeGatewayIssuerLayer(dependencies(configuration)).pipe(Layer.provide(scopeGrantRegistrarLayer())),
      ),
    );
    expect(error.stage).toBe('signing');
    yield* Effect.promise(() =>
      jwtVerify(result.token, publicKey, {
        algorithms: ['EdDSA'],
        audience: 'property-registry',
        currentDate: new Date(1_700_000_001_000),
        issuer,
      }),
    );
  }),
);

it.effect('fails closed for unknown audiences and invalid Effect-managed time', () =>
  Effect.gen(function* testProgram9() {
    const { configuration } = yield* makeConfiguration();
    const audienceErrors = yield* Effect.all(
      [
        Effect.flip(issueGatewayContextAssertionWith({ audience: 'billing', principal }, dependencies(configuration))),
        Effect.flip(
          issueGatewayContextAssertionWith({ audience: 'property.registry', principal }, dependencies(configuration)),
        ),
      ].map((effect) =>
        Effect.gen(function* testProgram10() {
          return yield* effect;
        }),
      ),
      { concurrency: 'unbounded' },
    );
    const timeError = yield* Effect.flip(
      issueGatewayContextAssertionWith(
        { audience: 'property-registry', compositionRevision, principal },
        dependencies(configuration, {
          currentTimeSeconds: Effect.succeed(-1),
        }),
      ),
    );

    expect(audienceErrors.every((error) => error.code === 'gateway_audience_invalid')).toBe(true);
    expect(audienceErrors.every((error) => error.stage === 'audience')).toBe(true);
    expect(timeError.code).toBe('gateway_issuer_unavailable');
    expect(timeError.stage).toBe('clock');
  }),
);

it.effect('rejects transport correlation or any other excess principal claim', () =>
  Effect.gen(function* testProgram11() {
    const { configuration } = yield* makeConfiguration();
    const error = yield* Effect.flip(
      issueGatewayContextAssertionWith(
        {
          audience: 'property-registry',
          compositionRevision,
          principal: { ...principal, correlationId: 'must-remain-a-header' },
        },
        dependencies(configuration),
      ),
    );
    expect(error.code).toBe('gateway_issuer_unavailable');
    expect(error.stage).toBe('principal');
  }),
);

it.effect('identifies configuration and signing failures without exposing key material', () =>
  Effect.gen(function* testProgram12() {
    const { configuration } = yield* makeConfiguration();
    const configurationError = yield* Effect.flip(
      issueGatewayContextAssertionWith(
        { audience: 'property-registry', compositionRevision, principal },
        dependencies(configuration, {
          loadConfig: parseGatewayIssuerConfig({}),
        }),
      ),
    );
    const signingError = yield* Effect.flip(
      issueGatewayContextAssertionWith(
        { audience: 'property-registry', compositionRevision, principal },
        dependencies({
          ...configuration,
          privateJwk: { ...configuration.privateJwk, d: 'invalid' },
        }),
      ),
    );

    expect(configurationError.stage).toBe('configuration');
    expect(signingError.stage).toBe('signing');
    expect(configurationError.reason).not.toContain('ONTOS_GATEWAY_PRIVATE_JWK');
    expect(signingError.reason).not.toContain(configuration.privateJwk.d);
  }),
);

it.effect('rejects missing configuration, HMAC keys, non-Ed25519 keys, and missing key IDs', () =>
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
                {},
              ),
            ),
          );
        }),
      ),
      { concurrency: 'unbounded' },
    );
    expect(errors.every((error) => Predicate.isTagged(error, 'GatewayIssuerConfigError'))).toBe(true);
  }),
);

it.effect('rejects stale document revisions before signing and reads admission for each issuance', () =>
  Effect.gen(function* verifyFreshReleaseAdmission() {
    const { configuration } = yield* makeConfiguration();
    let admitted = true;
    let loads = 0;
    const options = dependencies(configuration, {
      loadAdmission: Effect.sync(() => {
        loads += 1;
        return {
          audiences: admitted ? new Map([['property-registry', 'property-registry-build']]) : new Map<string, string>(),
          revision: compositionRevision,
        };
      }),
    });
    const stale = yield* Effect.flip(
      issueGatewayContextAssertionWith(
        { audience: 'property-registry', compositionRevision: 'b'.repeat(64), principal },
        options,
      ),
    );
    expect(stale.code).toBe('gateway_revision_unsupported');
    const current = yield* issueGatewayContextAssertionWith(
      { audience: 'property-registry', compositionRevision, principal },
      options,
    );
    expect(decodeJwt(current.token)['compositionRevision']).toBe(compositionRevision);
    expect(decodeJwt(current.token)['targetBuildMarker']).toBe('property-registry-build');
    admitted = false;
    const revoked = yield* Effect.flip(
      issueGatewayContextAssertionWith({ audience: 'property-registry', compositionRevision, principal }, options),
    );
    expect(revoked.code).toBe('gateway_audience_invalid');
    expect(loads).toBe(3);
  }),
);

it.effect('reuses one assertion per principal context, audience and revision until shortly before expiry', () =>
  Effect.gen(function* reuseIssuedAssertions() {
    const { configuration } = yield* makeConfiguration();
    let now = 1_700_000_000;
    let revision = compositionRevision;
    let minted = 0;
    const layer = makeGatewayIssuerLayer(
      dependencies(configuration, {
        currentTimeSeconds: Effect.sync(() => now),
        generateJti: Effect.sync(() => {
          minted += 1;
          return `60000000-0000-4000-8000-${String(minted).padStart(12, '0')}`;
        }),
        loadAdmission: Effect.sync(() => ({
          audiences: new Map([
            ['property-registry', 'property-registry-build'],
            ['tagging', 'tagging-build'],
          ]),
          revision,
        })),
      }),
    ).pipe(Layer.provide(scopeGrantRegistrarLayer()));
    const otherLegalEntity = { ...principal, legalEntityId: '30000000-0000-4000-8000-000000000002' };
    const otherPrincipal = {
      ...principal,
      authContextRef: 'better-auth-session:other-principal-reference',
      principalId: '40000000-0000-4000-8000-000000000002',
    };
    const otherSession = { ...principal, authContextRef: 'better-auth-session:other-reference' };
    yield* Effect.gen(function* reuseSequence() {
      const gatewayIssuer = yield* GatewayIssuer;
      const issue = (input: { readonly audience?: string; readonly principal?: typeof principal }) =>
        gatewayIssuer
          .issue({
            audience: input.audience ?? 'property-registry',
            compositionRevision: revision,
            principal: input.principal ?? principal,
          })
          .pipe(Effect.map(({ token }) => decodeJwt(token).jti));

      const first = yield* issue({});
      now = 1_700_000_100;
      expect(yield* issue({})).toBe(first);
      expect(minted).toBe(1);

      // Every other principal, session, context or audience receives its own assertion.
      const otherPrincipalAssertion = yield* issue({ principal: otherPrincipal });
      const otherSessionAssertion = yield* issue({ principal: otherSession });
      const otherAudienceAssertion = yield* issue({ audience: 'tagging' });
      expect(new Set([first, otherPrincipalAssertion, otherSessionAssertion, otherAudienceAssertion]).size).toBe(4);
      expect(yield* issue({})).toBe(first);

      // A legal-entity switch on the same session retires the earlier context's assertion.
      const switched = yield* issue({ principal: otherLegalEntity });
      expect(switched).not.toBe(first);
      const switchedBack = yield* issue({});
      expect(switchedBack).not.toBe(first);

      // Sign-out forgets the session's assertions without touching another session.
      yield* gatewayIssuer.forgetAuthContext(principal.authContextRef);
      expect(yield* issue({})).not.toBe(switchedBack);
      expect(yield* issue({ principal: otherSession })).toBe(otherSessionAssertion);

      // A composition revision change retires every earlier assertion.
      const beforeRevision = yield* issue({});
      revision = 'b'.repeat(64);
      expect(yield* issue({})).not.toBe(beforeRevision);

      // Never reused within the final 15 seconds before expiry.
      const nearExpiry = yield* issue({});
      now = 1_700_000_100 + 300 - 15;
      expect(yield* issue({})).not.toBe(nearExpiry);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect('registers a gateway scope grant for the exact signed party-registry assertion', () =>
  Effect.gen(function* registerPartyRegistryScopeGrant() {
    const { configuration } = yield* makeConfiguration();
    const { inputs, registrar } = capturingScopeGrantRegistrar();
    const result = yield* issueGatewayContextAssertion({
      audience: 'party-registry',
      compositionRevision,
      principal,
    }).pipe(
      Effect.provide(
        makeGatewayIssuerLayer(
          dependencies(configuration, {
            loadAdmission: Effect.succeed({
              audiences: new Map([['party-registry', 'party-registry-build']]),
              revision: compositionRevision,
            }),
          }),
        ).pipe(Layer.provide(scopeGrantRegistrarLayer(registrar))),
      ),
    );
    const claims = decodeJwt(result.token);

    expect(inputs).toHaveLength(1);
    const [registered] = inputs;
    expect(registered === undefined ? undefined : Redacted.value(registered.assertion)).toBe(result.token);
    expect(registered).toEqual({
      assertion: registered?.assertion,
      audience: 'party-registry',
      expiresAtEpochSeconds: (claims.iat ?? 0) + 300,
      jti: claims.jti,
      legalEntityId: principal.legalEntityId,
      principalId: principal.principalId,
      tenantId: principal.tenantId,
    });
    expect(registered?.expiresAtEpochSeconds).toBe(result.expiresAt);
    expect(JSON.stringify(registered)).not.toContain(result.token);
  }),
);

it.effect('omits the legal entity from the scope grant when the principal has none', () =>
  Effect.gen(function* registerTenantOnlyScopeGrant() {
    const { configuration } = yield* makeConfiguration();
    const { inputs, registrar } = capturingScopeGrantRegistrar();
    const { legalEntityId: _legalEntityId, ...tenantOnlyPrincipal } = principal;
    const issued = yield* issueGatewayContextAssertion({
      audience: 'property-registry',
      compositionRevision,
      principal: tenantOnlyPrincipal,
    }).pipe(
      Effect.provide(
        makeGatewayIssuerLayer(dependencies(configuration)).pipe(Layer.provide(scopeGrantRegistrarLayer(registrar))),
      ),
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0] === undefined ? undefined : Redacted.value(inputs[0].assertion)).toBe(issued.token);
    expect(Object.hasOwn(inputs[0] ?? {}, 'legalEntityId')).toBe(false);
  }),
);

it.effect('returns no token when the scope grant registration fails', () =>
  Effect.gen(function* failClosedOnScopeGrantFailure() {
    const { configuration } = yield* makeConfiguration();
    let attempts = 0;
    const error = yield* Effect.flip(
      issueGatewayContextAssertion({
        audience: 'property-registry',
        compositionRevision,
        principal,
      }).pipe(
        Effect.provide(
          makeGatewayIssuerLayer(dependencies(configuration)).pipe(
            Layer.provide(
              scopeGrantRegistrarLayer({
                register: () =>
                  Effect.suspend(() => {
                    attempts += 1;
                    return Effect.fail(
                      new GatewayScopeGrantUnavailableError({
                        reason: 'The gateway scope grant could not be registered',
                      }),
                    );
                  }),
              }),
            ),
          ),
        ),
      ),
    );

    expect(attempts).toBe(1);
    expect(error.code).toBe('gateway_issuer_unavailable');
    expect(error.stage).toBe('scope_grant');
    expect(error.reason).toBe('The gateway assertion issuer is unavailable');
    expect(JSON.stringify(error)).not.toMatch(/eyJ/u);
  }),
);

it.effect('passes every issued audience to the scope grant registrar', () =>
  Effect.gen(function* registerEveryAudience() {
    const { configuration } = yield* makeConfiguration();
    const { inputs, registrar } = capturingScopeGrantRegistrar();
    const audiences = ['shell-super-app', 'party-registry', 'property-registry', 'catalog'];
    const layer = makeGatewayIssuerLayer(
      dependencies(configuration, {
        loadAdmission: Effect.succeed({
          audiences: new Map(audiences.map((audience) => [audience, `${audience}-build`] as const)),
          revision: compositionRevision,
        }),
      }),
    ).pipe(Layer.provide(scopeGrantRegistrarLayer(registrar)));
    const results = yield* Effect.all(
      audiences.map((audience) => issueGatewayContextAssertion({ audience, compositionRevision, principal })),
    ).pipe(Effect.provide(layer));

    expect(inputs.map(({ audience }) => audience)).toEqual(audiences);
    expect(inputs.map(({ assertion }) => Redacted.value(assertion))).toEqual(results.map(({ token }) => token));
  }),
);
