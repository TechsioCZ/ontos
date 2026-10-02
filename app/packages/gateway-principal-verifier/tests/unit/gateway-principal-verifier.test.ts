import {
  ActiveApplicationCompositionService,
  GatewayAssertionRedemptionUnavailableError,
  GatewayAssertionReplayError,
  isVerifiedGatewayPrincipalContext,
  readVerifiedGatewayCompositionRevision,
} from '@app/core-runtime';
import { Clock, ConfigProvider, Context, DateTime, Effect, Exit, Layer, Redacted, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { JWK, LocalJWKSet } from 'jose';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION, GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';

import {
  ActionPrincipalConfigurationErrorSchema,
  ActionPrincipalInvalidErrorSchema,
  ActionPrincipalScopeErrorSchema,
  ActionPrincipalUnavailableErrorSchema,
  GatewayPrincipalVerifierConfiguration,
  GatewayPrincipalVerifierLive,
  bindGatewayPrincipalVerifier,
} from '../../src/server.ts';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';

const GATEWAY_FIXTURE_BUILD_MARKER = 'gateway-test-release';
const fixtureAppIds = ['billing', 'commerce-customer-context', 'external-operation', 'party-registry'];
const gatewayComposition = makeApplicationCompositionSnapshotFixture(fixtureAppIds, GATEWAY_FIXTURE_BUILD_MARKER);

const currentTimeSeconds = 1_700_000_001;
const issuer = 'https://shell.ontos.test';
const principal = {
  authBindingId: '30000000-0000-4000-8000-000000000001',
  authContextRef: 'gateway-session-ref',
  authMethod: 'session' as const,
  principalId: '40000000-0000-4000-8000-000000000001',
  tenantId: '50000000-0000-4000-8000-000000000001',
};

const thirdPartyPrincipal = {
  authBindingId: principal.authBindingId,
  authContextRef: 'third-party-session-ref',
  authenticationNamespaceId: 'third-party.identity.v1',
  authMethod: 'session' as const,
  principalId: principal.principalId,
  tenantId: principal.tenantId,
};

const anotherNamespacePrincipal = {
  ...principal,
  authenticationNamespaceId: 'another.identity.v1',
};

interface FixturePrincipal {
  readonly authBindingId?: string;
  readonly authContextRef?: string;
  readonly authenticationNamespaceId?: string;
  readonly authMethod?: 'api_key' | 'session' | 'support_impersonation' | 'system';
  readonly legalEntityId?: string;
  readonly permissions?: readonly string[];
  readonly principalId: string;
  readonly providerSubjectId?: string;
  readonly tenantId?: string;
  readonly trustedStorefrontId?: string;
}

const makeFixture = (
  audience: string,
  version: number = GATEWAY_ASSERTION_VERSION,
  fixturePrincipal: FixturePrincipal = principal,
  releaseClaims: {
    readonly compositionRevision?: string;
    readonly targetBuildMarker?: string;
  } = {},
) =>
  Effect.gen(function* createFixture() {
    const snapshot = yield* gatewayComposition;
    const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
    const publicJwk = {
      ...(yield* Effect.promise(() => exportJWK(publicKey))),
      alg: 'EdDSA',
      kid: 'shared-verifier-test',
      use: 'sig',
    };
    const token = yield* Effect.promise(() =>
      new SignJWT({
        compositionRevision: releaseClaims.compositionRevision ?? snapshot.composition.revision,
        principal: fixturePrincipal,
        targetBuildMarker: releaseClaims.targetBuildMarker ?? GATEWAY_FIXTURE_BUILD_MARKER,
        ver: version,
      })
        .setProtectedHeader({
          alg: 'EdDSA',
          kid: 'shared-verifier-test',
          typ: 'JWT',
        })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject(fixturePrincipal.principalId)
        .setIssuedAt(1_700_000_000)
        .setExpirationTime(1_700_000_300)
        .setJti('60000000-0000-4000-8000-000000000001')
        .sign(privateKey),
    );
    return {
      environment: {
        ONTOS_GATEWAY_ISSUER: issuer,
        ONTOS_GATEWAY_PUBLIC_JWKS: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          keys: [publicJwk],
        }),
      },
      publicJwk,
      token,
    };
  });

it.effect('preserves signed Storefront scope with non-copyable verified provenance', () =>
  Effect.gen(function* verifyStorefrontProvenance() {
    const storefrontPrincipal = {
      ...principal,
      legalEntityId: '70000000-0000-4000-8000-000000000001',
      trustedStorefrontId: 'storefront-tenant-a-b2b',
    };
    const fixture = yield* makeFixture('commerce-customer-context', 1, storefrontPrincipal);
    const verifier = bindGatewayPrincipalVerifier('commerce-customer-context', {
      appId: 'commerce-customer-context',
      buildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
    });
    const verificationOptions = {
      currentTimeSeconds: Effect.succeed(currentTimeSeconds),
      environment: fixture.environment,
    } as const;
    const signatureOnly = yield* verifier.verify(Redacted.make(`Bearer ${fixture.token}`), verificationOptions);
    expect(isVerifiedGatewayPrincipalContext(signatureOnly)).toBe(false);
    expect(readVerifiedGatewayCompositionRevision(signatureOnly)).toBeUndefined();

    const verified = yield* verifier.verifyAndRedeem(Redacted.make(`Bearer ${fixture.token}`), {
      ...verificationOptions,
      redemption: { consume: () => Effect.void },
    });

    expect(verified.trustedStorefrontId).toBe('storefront-tenant-a-b2b');
    expect(isVerifiedGatewayPrincipalContext(verified)).toBe(true);
    expect(readVerifiedGatewayCompositionRevision(verified)).toBe((yield* gatewayComposition).composition.revision);
    expect(readVerifiedGatewayCompositionRevision({ ...verified })).toBeUndefined();
  }).pipe(Effect.provideService(ActiveApplicationCompositionService, { load: gatewayComposition })),
);

const isConfigurationError = Schema.is(ActionPrincipalConfigurationErrorSchema);
const isInvalidError = Schema.is(ActionPrincipalInvalidErrorSchema);
const isScopeError = Schema.is(ActionPrincipalScopeErrorSchema);
const isUnavailableError = Schema.is(ActionPrincipalUnavailableErrorSchema);
const failingKeySet = Object.assign(() => Promise.reject(new Error('fixture verifier details must be discarded')), {
  jwks: () => ({ keys: [] }),
}) satisfies LocalJWKSet;

it.effect('retains deployment configuration for a lazy verifier after its provider layer is hidden', () =>
  Effect.scoped(
    Effect.gen(function* retainDeploymentConfiguration() {
      const fixture = yield* makeFixture('party-registry');
      const environmentProvider = ConfigProvider.fromUnknown(fixture.environment);
      let configurationReads = 0;
      const deploymentProvider = ConfigProvider.make((path) =>
        Effect.suspend(() => {
          configurationReads += 1;
          return environmentProvider.load(path);
        }),
      );
      const context = yield* Layer.build(
        GatewayPrincipalVerifierLive.pipe(Layer.provide(ConfigProvider.layer(deploymentProvider))),
      );
      expect(configurationReads).toBe(0);
      const verifier = Context.get(context, GatewayPrincipalVerifierConfiguration);
      const configuration = yield* verifier.configuration.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
        Effect.exit,
      );

      expect(Exit.isSuccess(configuration)).toBe(true);
      expect(configurationReads).toBeGreaterThan(0);
      if (Exit.isSuccess(configuration)) {
        expect(configuration.value.issuer).toBe(issuer);
      }
    }),
  ),
);

it.effect('admits the Shell own release and refuses a different local Shell build before redemption', () =>
  Effect.gen(function* verifyShellOwnRelease() {
    const fixture = yield* makeFixture('shell-super-app', GATEWAY_ASSERTION_VERSION, principal, {
      targetBuildMarker: 'shell-fixture-build',
    });
    let redemptions = 0;
    const options = {
      currentTimeSeconds: Effect.succeed(currentTimeSeconds),
      environment: fixture.environment,
      redemption: {
        consume: () =>
          Effect.sync(() => {
            redemptions += 1;
          }),
      },
    };
    const verified = yield* bindGatewayPrincipalVerifier('shell-super-app', {
      appId: 'shell-super-app',
      buildMarker: 'shell-fixture-build',
    }).verifyAndRedeem(Redacted.make(`Bearer ${fixture.token}`), options);
    expect(verified).toEqual(principal);
    expect(redemptions).toBe(1);

    const failure = yield* bindGatewayPrincipalVerifier('shell-super-app', {
      appId: 'shell-super-app',
      buildMarker: 'other-shell-build',
    })
      .verifyAndRedeem(Redacted.make(`Bearer ${fixture.token}`), options)
      .pipe(Effect.flip);
    expect(isScopeError(failure)).toBe(true);
    expect(redemptions).toBe(1);
  }).pipe(Effect.provideService(ActiveApplicationCompositionService, { load: gatewayComposition })),
);

it.effect('rejects composition and release mismatches before redeeming an assertion', () =>
  Effect.gen(function* rejectReleaseMismatches() {
    const current = yield* gatewayComposition;
    const next = yield* makeApplicationCompositionSnapshotFixture(fixtureAppIds, 'gateway-next-release');
    const currentToken = yield* makeFixture('party-registry');
    const wrongRevision = yield* makeFixture('party-registry', GATEWAY_ASSERTION_VERSION, principal, {
      compositionRevision: 'f'.repeat(64),
    });
    const wrongClaimedMarker = yield* makeFixture('party-registry', GATEWAY_ASSERTION_VERSION, principal, {
      targetBuildMarker: 'gateway-next-release',
    });
    const nextCompositionWithOldRelease = yield* makeFixture('party-registry', GATEWAY_ASSERTION_VERSION, principal, {
      compositionRevision: next.composition.revision,
    });
    const scenarios = [
      { fixture: wrongRevision, localBuildMarker: GATEWAY_FIXTURE_BUILD_MARKER, snapshot: current },
      { fixture: wrongClaimedMarker, localBuildMarker: GATEWAY_FIXTURE_BUILD_MARKER, snapshot: current },
      { fixture: currentToken, localBuildMarker: 'gateway-next-release', snapshot: current },
      { fixture: nextCompositionWithOldRelease, localBuildMarker: GATEWAY_FIXTURE_BUILD_MARKER, snapshot: next },
    ];

    for (const scenario of scenarios) {
      let redemptions = 0;
      const failure = yield* bindGatewayPrincipalVerifier('party-registry', {
        appId: 'party-registry',
        buildMarker: scenario.localBuildMarker,
      })
        .verifyAndRedeem(Redacted.make(`Bearer ${scenario.fixture.token}`), {
          currentTimeSeconds: Effect.succeed(currentTimeSeconds),
          environment: scenario.fixture.environment,
          redemption: {
            consume: () =>
              Effect.sync(() => {
                redemptions += 1;
              }),
          },
        })
        .pipe(
          Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(scenario.snapshot) }),
          Effect.flip,
        );
      expect(isScopeError(failure)).toBe(true);
      expect(redemptions).toBe(0);
    }
  }),
);

it.effect('rejects expired authority and invalid full contracts before assertion redemption', () =>
  Effect.gen(function* rejectUnavailableComposition() {
    yield* TestClock.setTime(0);
    const fixture = yield* makeFixture('party-registry');
    const snapshot = yield* gatewayComposition;
    const now = yield* Clock.currentTimeMillis;
    const scenarios = [
      {
        ...snapshot,
        observedAt: DateTime.makeUnsafe(now - 2000),
        validUntil: DateTime.makeUnsafe(now - 1000),
      },
      {
        ...snapshot,
        composition: {
          ...snapshot.composition,
          modules: snapshot.composition.modules.map((module) => ({ ...module, contractDocument: '{}' })),
        },
      },
    ];
    for (const authority of scenarios) {
      let redemptions = 0;
      const failure = yield* bindGatewayPrincipalVerifier('party-registry', {
        appId: 'party-registry',
        buildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
      })
        .verifyAndRedeem(Redacted.make(`Bearer ${fixture.token}`), {
          currentTimeSeconds: Effect.succeed(currentTimeSeconds),
          environment: fixture.environment,
          redemption: {
            consume: () =>
              Effect.sync(() => {
                redemptions += 1;
              }),
          },
        })
        .pipe(
          Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(authority) }),
          Effect.flip,
        );
      expect(isUnavailableError(failure)).toBe(true);
      expect(redemptions).toBe(0);
    }
  }),
);

it.effect('accepts a signed v1 assertion without requiring namespace configuration', () =>
  Effect.gen(function* verifyLegacyStaffCompatibility() {
    const fixture = yield* makeFixture('party-registry');
    const verifier = bindGatewayPrincipalVerifier('party-registry', {
      appId: 'party-registry',
      buildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
    });
    const verified = yield* verifier.verify(Redacted.make(`Bearer ${fixture.token}`), {
      currentTimeSeconds: Effect.succeed(currentTimeSeconds),
      environment: fixture.environment,
    });

    expect(verified).toEqual(principal);
  }).pipe(Effect.provideService(ActiveApplicationCompositionService, { load: gatewayComposition })),
);

it.effect('accepts v2 principals from arbitrary namespaces for Core registry admission', () =>
  Effect.gen(function* verifyUnboundedV2Namespaces() {
    const fixtures = yield* Effect.all([
      makeFixture('party-registry', EXTERNAL_GATEWAY_ASSERTION_VERSION, anotherNamespacePrincipal),
      makeFixture('external-operation', EXTERNAL_GATEWAY_ASSERTION_VERSION, thirdPartyPrincipal),
    ]);
    const expected = [anotherNamespacePrincipal, thirdPartyPrincipal];

    for (const [index, fixture] of fixtures.entries()) {
      const verified = yield* bindGatewayPrincipalVerifier(index === 0 ? 'party-registry' : 'external-operation', {
        appId: index === 0 ? 'party-registry' : 'external-operation',
        buildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
      }).verify(Redacted.make(`Bearer ${fixture.token}`), {
        currentTimeSeconds: Effect.succeed(currentTimeSeconds),
        environment: fixture.environment,
      });
      expect(verified).toEqual(expected[index]);
    }
  }).pipe(Effect.provideService(ActiveApplicationCompositionService, { load: gatewayComposition })),
);

it.effect('rejects v2 claims with a missing namespace while preserving unknown values for Core', () =>
  Effect.gen(function* rejectMissingV2Namespace() {
    const verifier = bindGatewayPrincipalVerifier('party-registry', {
      appId: 'party-registry',
      buildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
    });
    const missingNamespace = yield* makeFixture('party-registry', EXTERNAL_GATEWAY_ASSERTION_VERSION, principal);
    const failure = yield* Effect.flip(
      verifier.verify(Redacted.make(`Bearer ${missingNamespace.token}`), {
        currentTimeSeconds: Effect.succeed(currentTimeSeconds),
        environment: missingNamespace.environment,
      }),
    );
    expect(isInvalidError(failure)).toBe(true);
  }).pipe(Effect.provideService(ActiveApplicationCompositionService, { load: gatewayComposition })),
);

it.effect('rejects provider identity and permission fields from signed claims', () =>
  Effect.gen(function* rejectUntrustedClaimFields() {
    const fixtures = yield* Effect.all([
      makeFixture('party-registry', EXTERNAL_GATEWAY_ASSERTION_VERSION, {
        ...anotherNamespacePrincipal,
        providerSubjectId: 'provider-user-1',
      }),
      makeFixture('party-registry', EXTERNAL_GATEWAY_ASSERTION_VERSION, {
        ...anotherNamespacePrincipal,
        permissions: ['admin'],
      }),
    ]);
    const verifier = bindGatewayPrincipalVerifier('party-registry', {
      appId: 'party-registry',
      buildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
    });

    for (const fixture of fixtures) {
      const failure = yield* Effect.flip(
        verifier.verify(Redacted.make(`Bearer ${fixture.token}`), {
          currentTimeSeconds: Effect.succeed(currentTimeSeconds),
          environment: fixture.environment,
        }),
      );
      expect(isInvalidError(failure)).toBe(true);
    }
  }).pipe(Effect.provideService(ActiveApplicationCompositionService, { load: gatewayComposition })),
);

it.effect('an audience-bound verifier accepts only its exact topology app ID', () =>
  Effect.gen(function* verifyAudienceBinding() {
    const partyFixture = yield* makeFixture('party-registry');
    const billingFixture = yield* makeFixture('billing');
    const verifier = bindGatewayPrincipalVerifier('party-registry', {
      appId: 'party-registry',
      buildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
    });
    const verify = (token: string, environment: typeof partyFixture.environment) =>
      verifier.verify(Redacted.make(`Bearer ${token}`), {
        currentTimeSeconds: Effect.succeed(currentTimeSeconds),
        environment,
      });

    expect(yield* verify(partyFixture.token, partyFixture.environment)).toEqual(principal);
    expect(isScopeError(yield* Effect.flip(verify(billingFixture.token, billingFixture.environment)))).toBe(true);
  }).pipe(Effect.provideService(ActiveApplicationCompositionService, { load: gatewayComposition })),
);

it.effect('Bearer scheme matching is case insensitive without changing the signed token', () =>
  Effect.gen(function* verifyBearerCaseVariants() {
    const fixture = yield* makeFixture('party-registry');
    const verifier = bindGatewayPrincipalVerifier('party-registry', {
      appId: 'party-registry',
      buildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
    });
    yield* Effect.forEach(
      ['Bearer', 'bearer', 'BEARER', 'bEaReR'],
      (scheme) =>
        Effect.gen(function* verifyBearerScheme() {
          const verified = yield* verifier.verify(Redacted.make(`${scheme} ${fixture.token}`), {
            currentTimeSeconds: Effect.succeed(currentTimeSeconds),
            environment: fixture.environment,
          });
          expect(verified).toEqual(principal);
        }),
      { concurrency: 'unbounded' },
    );
  }).pipe(Effect.provideService(ActiveApplicationCompositionService, { load: gatewayComposition })),
);

it.effect('case insensitive Bearer matching still rejects malformed authorization headers', () =>
  Effect.gen(function* rejectMalformedBearerHeaders() {
    const fixture = yield* makeFixture('party-registry');
    const verifier = bindGatewayPrincipalVerifier('party-registry', {
      appId: 'party-registry',
      buildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
    });
    yield* Effect.forEach(
      [
        ` bearer ${fixture.token}`,
        `bearer  ${fixture.token}`,
        `bearer\t${fixture.token}`,
        `bearer ${fixture.token} `,
        `bearer ${fixture.token} extra`,
        'bearer ',
        `Basic ${fixture.token}`,
      ],
      (authorization) =>
        Effect.gen(function* rejectMalformedBearerHeader() {
          const failure = yield* Effect.flip(
            verifier.verify(Redacted.make(authorization), {
              currentTimeSeconds: Effect.succeed(currentTimeSeconds),
              environment: fixture.environment,
            }),
          );
          expect(isInvalidError(failure)).toBe(true);
        }),
      { concurrency: 'unbounded' },
    );
  }).pipe(Effect.provideService(ActiveApplicationCompositionService, { load: gatewayComposition })),
);

it.effect('empty and malformed audience bindings fail closed as configuration errors', () =>
  Effect.gen(function* rejectMalformedBindings() {
    const fixture = yield* makeFixture('party-registry');
    yield* Effect.forEach(
      ['', 'Party Registry', 'party/registry'],
      (audience) =>
        Effect.gen(function* checkMalformedBinding() {
          const failure = yield* Effect.flip(
            bindGatewayPrincipalVerifier(audience, {
              appId: 'party-registry',
              buildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
            }).verify(Redacted.make(`Bearer ${fixture.token}`), {
              currentTimeSeconds: Effect.succeed(currentTimeSeconds),
              environment: fixture.environment,
            }),
          );
          expect(isConfigurationError(failure)).toBe(true);
        }),
      { concurrency: 'unbounded' },
    );
  }).pipe(Effect.provideService(ActiveApplicationCompositionService, { load: gatewayComposition })),
);

it.effect('redemption failures remain sanitized and distinguish replay from unavailability', () =>
  Effect.gen(function* verifyRedemptionFailures() {
    const fixture = yield* makeFixture('party-registry');
    const verifier = bindGatewayPrincipalVerifier('party-registry', {
      appId: 'party-registry',
      buildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
    });
    const verify = (redemption: Parameters<typeof verifier.verifyAndRedeem>[1]['redemption']) =>
      verifier.verifyAndRedeem(Redacted.make(`Bearer ${fixture.token}`), {
        currentTimeSeconds: Effect.succeed(currentTimeSeconds),
        environment: fixture.environment,
        redemption,
      });

    const replayFailure = yield* Effect.flip(
      verify({
        consume: () =>
          Effect.fail(
            new GatewayAssertionReplayError({
              reason: 'fixture replay details must be discarded',
            }),
          ),
      }),
    );
    expect(isInvalidError(replayFailure)).toBe(true);
    expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(replayFailure)).not.toMatch(
      /fixture|eyJ/u,
    );
    const unavailableFailure = yield* Effect.flip(
      verify({
        consume: () =>
          Effect.fail(
            new GatewayAssertionRedemptionUnavailableError({
              reason: 'fixture storage details must be discarded',
            }),
          ),
      }),
    );
    expect(isUnavailableError(unavailableFailure)).toBe(true);
    expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(unavailableFailure)).not.toMatch(
      /fixture|eyJ/u,
    );
  }).pipe(Effect.provideService(ActiveApplicationCompositionService, { load: gatewayComposition })),
);

it.effect('unsupported assertion versions and unexpected verifier failures fail closed', () =>
  Effect.gen(function* rejectUnsupportedAndUnexpectedFailures() {
    const unsupportedVersion = yield* makeFixture('party-registry', 3);
    const verifier = bindGatewayPrincipalVerifier('party-registry', {
      appId: 'party-registry',
      buildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
    });
    const versionFailure = yield* Effect.flip(
      verifier.verify(Redacted.make(`Bearer ${unsupportedVersion.token}`), {
        currentTimeSeconds: Effect.succeed(currentTimeSeconds),
        environment: unsupportedVersion.environment,
      }),
    );
    expect(isInvalidError(versionFailure)).toBe(true);

    const fixture = yield* makeFixture('party-registry');
    const failure = yield* Effect.flip(
      verifier
        .verify(Redacted.make(`Bearer ${fixture.token}`), {
          currentTimeSeconds: Effect.succeed(currentTimeSeconds),
        })
        .pipe(
          Effect.provideService(GatewayPrincipalVerifierConfiguration, {
            configuration: Effect.succeed({
              issuer,
              keySet: failingKeySet,
            }),
          }),
        ),
    );
    expect(isUnavailableError(failure)).toBe(true);
    expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(failure)).not.toMatch(/fixture|eyJ/u);
  }).pipe(Effect.provideService(ActiveApplicationCompositionService, { load: gatewayComposition })),
);

it.effect('malformed Ed25519 public keys fail during configuration acquisition', () =>
  Effect.gen(function* rejectMalformedPublicKeys() {
    const fixture = yield* makeFixture('party-registry');
    const verifier = bindGatewayPrincipalVerifier('party-registry', {
      appId: 'party-registry',
      buildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
    });
    const verifyWithKey = (key: JWK) =>
      Effect.gen(function* verifyPublicKey() {
        const jwks = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          keys: [key],
        });
        return yield* verifier.verify(Redacted.make(`Bearer ${fixture.token}`), {
          currentTimeSeconds: Effect.succeed(currentTimeSeconds),
          environment: {
            ONTOS_GATEWAY_ISSUER: issuer,
            ONTOS_GATEWAY_PUBLIC_JWKS: jwks,
          },
        });
      });

    yield* Effect.forEach(
      [
        { ...fixture.publicJwk, key_ops: [] },
        { ...fixture.publicJwk, x: '!!!' },
      ],
      (key) =>
        Effect.gen(function* checkMalformedPublicKey() {
          expect(isConfigurationError(yield* Effect.flip(verifyWithKey(key)))).toBe(true);
        }),
      { concurrency: 'unbounded' },
    );
  }).pipe(Effect.provideService(ActiveApplicationCompositionService, { load: gatewayComposition })),
);
