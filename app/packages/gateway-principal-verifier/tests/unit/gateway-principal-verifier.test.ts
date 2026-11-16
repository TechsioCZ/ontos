import { HttpServerRequest } from 'effect/http';
import {
  isTrustedSystemPrincipalContext,
  readVerifiedGatewayWorkload,
  readVerifiedGatewayRouteScope,
  readVerifiedGatewayRecovery,
  RegisteredGatewayWorkloadSchema,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import type {
  RegisteredGatewayRouteScope,
  RegisteredGatewayWorkload,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import {
  ActiveApplicationCompositionService,
  GatewayAssertionRedemptionUnavailableError,
  GatewayAssertionReplayError,
  isVerifiedGatewayPrincipalContext,
  readVerifiedGatewayActor,
  readVerifiedGatewayCompositionRevision,
  readVerifiedGatewayScopeAssertion,
} from '@app/core-runtime';
import { Cause, Clock, ConfigProvider, Context, DateTime, Effect, Exit, Layer, Option, Redacted, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it, rs } from 'effect-rstest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { JWK, LocalJWKSet } from 'jose';
import {
  DELEGATED_GATEWAY_ASSERTION_VERSION,
  WORKLOAD_GATEWAY_ASSERTION_VERSION,
  EXTERNAL_GATEWAY_ASSERTION_VERSION,
  GATEWAY_ASSERTION_VERSION,
  REFERENCE_GATEWAY_CREDENTIALS_HEADER,
} from '@app/shared-contracts';

import {
  ActionPrincipalConfigurationErrorSchema,
  ActionPrincipalInvalidErrorSchema,
  ActionPrincipalScopeErrorSchema,
  ActionPrincipalUnavailableErrorSchema,
  GatewayPrincipalVerifierConfiguration,
  GatewayPrincipalVerifierLive,
  bindGatewayPrincipalVerifier,
  makeReferenceGatewayCredentialSource,
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

const makeRedemptionCounter = () => {
  let count = 0;
  return {
    consume: () =>
      Effect.sync(() => {
        count += 1;
      }),
    count: () => count,
  };
};

const makeFixture = (
  audience: string,
  version: number = GATEWAY_ASSERTION_VERSION,
  fixturePrincipal: FixturePrincipal = principal,
  releaseClaims: {
    readonly act?: { readonly appId: string; readonly buildMarker: string; readonly principalId: string };
    readonly compositionRevision?: string;
    readonly routeScope?: unknown;
    readonly targetBuildMarker?: string;
    readonly workload?: RegisteredGatewayWorkload;
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
        act: releaseClaims.act,
        compositionRevision: releaseClaims.compositionRevision ?? snapshot.composition.revision,
        principal: fixturePrincipal,
        routeScope: releaseClaims.routeScope,
        targetBuildMarker: releaseClaims.targetBuildMarker ?? GATEWAY_FIXTURE_BUILD_MARKER,
        ver: version,
        workload: releaseClaims.workload,
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

it.effect('attaches the redeemed token as the scope assertion only after redemption succeeds', () =>
  Effect.gen(function* verifyScopeAssertionAttachment() {
    const fixture = yield* makeFixture('party-registry');
    const verifier = bindGatewayPrincipalVerifier('party-registry', {
      appId: 'party-registry',
      buildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
    });
    const verificationOptions = {
      currentTimeSeconds: Effect.succeed(currentTimeSeconds),
      environment: fixture.environment,
    } as const;
    const signatureOnly = yield* verifier.verify(Redacted.make(`Bearer ${fixture.token}`), verificationOptions);
    expect(readVerifiedGatewayScopeAssertion(signatureOnly)).toBeUndefined();

    const replayed = yield* Effect.exit(
      verifier.verifyAndRedeem(Redacted.make(`Bearer ${fixture.token}`), {
        ...verificationOptions,
        redemption: {
          consume: () => Effect.fail(new GatewayAssertionReplayError({ reason: 'The assertion was already used' })),
        },
      }),
    );
    expect(Exit.isFailure(replayed)).toBe(true);

    const redeemed = yield* verifier.verifyAndRedeem(Redacted.make(`Bearer ${fixture.token}`), {
      ...verificationOptions,
      redemption: { consume: () => Effect.void },
    });
    const scopeAssertion = readVerifiedGatewayScopeAssertion(redeemed);
    expect(scopeAssertion?.audience).toBe('party-registry');
    expect(scopeAssertion === undefined ? undefined : Redacted.value(scopeAssertion.assertion)).toBe(fixture.token);
    expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(redeemed)).not.toContain(fixture.token);
    expect(readVerifiedGatewayScopeAssertion({ ...redeemed })).toBeUndefined();
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

it.effect('trusts only the keys of its deployment provider and refuses any other signer as invalid', () =>
  Effect.scoped(
    Effect.gen(function* deploymentKeysOnly() {
      // Two signers: the deployment trusts A; the caller's ambient configuration names B.
      const deployment = yield* makeFixture('commerce-customer-context');
      const foreign = yield* makeFixture('commerce-customer-context');
      const context = yield* Layer.build(
        GatewayPrincipalVerifierLive.pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(deployment.environment))),
        ),
      );
      const verifier = bindGatewayPrincipalVerifier('commerce-customer-context', {
        appId: 'commerce-customer-context',
        buildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
      });
      const redeemed: string[] = [];
      const present = (token: string) =>
        verifier
          .verifyAndRedeem(Redacted.make(`Bearer ${token}`), {
            currentTimeSeconds: Effect.succeed(currentTimeSeconds),
            redemption: { consume: ({ jti }) => Effect.sync(() => redeemed.push(jti)) },
          })
          .pipe(
            Effect.provideService(
              GatewayPrincipalVerifierConfiguration,
              Context.get(context, GatewayPrincipalVerifierConfiguration),
            ),
            Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(foreign.environment)),
            Effect.exit,
          );

      const refused = yield* present(foreign.token);
      expect(Exit.isFailure(refused)).toBe(true);
      if (Exit.isFailure(refused)) {
        const failure = Cause.findErrorOption(refused.cause);
        expect(Option.isSome(failure) && isInvalidError(failure.value)).toBe(true);
      }
      expect(redeemed).toEqual([]);

      const admitted = yield* present(deployment.token);
      expect(Exit.isSuccess(admitted)).toBe(true);
      expect(redeemed).toHaveLength(1);
    }),
  ).pipe(Effect.provideService(ActiveApplicationCompositionService, { load: gatewayComposition })),
);

it.effect('admits the Shell own release and refuses a different local Shell build before redemption', () =>
  Effect.gen(function* verifyShellOwnRelease() {
    const fixture = yield* makeFixture('shell-super-app', GATEWAY_ASSERTION_VERSION, principal, {
      targetBuildMarker: 'shell-fixture-build',
    });
    const redemptions = makeRedemptionCounter();
    const options = {
      currentTimeSeconds: Effect.succeed(currentTimeSeconds),
      environment: fixture.environment,
      redemption: {
        consume: redemptions.consume,
      },
    };
    const verified = yield* bindGatewayPrincipalVerifier('shell-super-app', {
      appId: 'shell-super-app',
      buildMarker: 'shell-fixture-build',
    }).verifyAndRedeem(Redacted.make(`Bearer ${fixture.token}`), options);
    expect(verified).toEqual(principal);
    expect(redemptions.count()).toBe(1);

    const failure = yield* bindGatewayPrincipalVerifier('shell-super-app', {
      appId: 'shell-super-app',
      buildMarker: 'other-shell-build',
    })
      .verifyAndRedeem(Redacted.make(`Bearer ${fixture.token}`), options)
      .pipe(Effect.flip);
    expect(isScopeError(failure)).toBe(true);
    expect(redemptions.count()).toBe(1);
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
      const redemptions = makeRedemptionCounter();
      const failure = yield* bindGatewayPrincipalVerifier('party-registry', {
        appId: 'party-registry',
        buildMarker: scenario.localBuildMarker,
      })
        .verifyAndRedeem(Redacted.make(`Bearer ${scenario.fixture.token}`), {
          currentTimeSeconds: Effect.succeed(currentTimeSeconds),
          environment: scenario.fixture.environment,
          redemption: {
            consume: redemptions.consume,
          },
        })
        .pipe(
          Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(scenario.snapshot) }),
          Effect.flip,
        );
      expect(isScopeError(failure)).toBe(true);
      expect(redemptions.count()).toBe(0);
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
      const redemptions = makeRedemptionCounter();
      const failure = yield* bindGatewayPrincipalVerifier('party-registry', {
        appId: 'party-registry',
        buildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
      })
        .verifyAndRedeem(Redacted.make(`Bearer ${fixture.token}`), {
          currentTimeSeconds: Effect.succeed(currentTimeSeconds),
          environment: fixture.environment,
          redemption: {
            consume: redemptions.consume,
          },
        })
        .pipe(
          Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(authority) }),
          Effect.flip,
        );
      expect(isUnavailableError(failure)).toBe(true);
      expect(redemptions.count()).toBe(0);
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

const calledBy = {
  appId: 'billing',
  buildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
  principalId: '80000000-0000-4000-8000-000000000001',
};

it.effect('accepts a delegated v3 assertion and exposes the calling module as the verified actor', () =>
  Effect.gen(function* verifyDelegatedActor() {
    const fixture = yield* makeFixture('party-registry', DELEGATED_GATEWAY_ASSERTION_VERSION, thirdPartyPrincipal, {
      act: calledBy,
    });
    const verifier = bindGatewayPrincipalVerifier('party-registry', {
      appId: 'party-registry',
      buildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
    });
    const verificationOptions = {
      currentTimeSeconds: Effect.succeed(currentTimeSeconds),
      environment: fixture.environment,
    } as const;
    const subject = yield* verifier.verify(Redacted.make(`Bearer ${fixture.token}`), verificationOptions);
    expect(subject).toEqual(thirdPartyPrincipal);
    expect(readVerifiedGatewayActor(subject)).toBeUndefined();

    const redeemed = yield* verifier.verifyAndRedeem(Redacted.make(`Bearer ${fixture.token}`), {
      ...verificationOptions,
      redemption: { consume: () => Effect.void },
    });
    expect(redeemed).toEqual(thirdPartyPrincipal);
    expect(readVerifiedGatewayActor(redeemed)).toEqual(calledBy);
    expect(readVerifiedGatewayActor({ ...redeemed })).toBeUndefined();
    expect(readVerifiedGatewayScopeAssertion(redeemed)?.audience).toBe('party-registry');
  }).pipe(Effect.provideService(ActiveApplicationCompositionService, { load: gatewayComposition })),
);

it.effect('refuses a delegated assertion whose calling module is unknown or on another build', () =>
  Effect.gen(function* refuseUnapprovedActor() {
    const verifier = bindGatewayPrincipalVerifier('party-registry', {
      appId: 'party-registry',
      buildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
    });
    const unknownApp = yield* makeFixture('party-registry', DELEGATED_GATEWAY_ASSERTION_VERSION, thirdPartyPrincipal, {
      act: { ...calledBy, appId: 'not-installed-app' },
    });
    const wrongBuild = yield* makeFixture('party-registry', DELEGATED_GATEWAY_ASSERTION_VERSION, thirdPartyPrincipal, {
      act: { ...calledBy, buildMarker: 'some-other-build' },
    });
    for (const fixture of [unknownApp, wrongBuild]) {
      const failure = yield* Effect.flip(
        verifier.verify(Redacted.make(`Bearer ${fixture.token}`), {
          currentTimeSeconds: Effect.succeed(currentTimeSeconds),
          environment: fixture.environment,
        }),
      );
      expect(isScopeError(failure)).toBe(true);
    }
  }).pipe(Effect.provideService(ActiveApplicationCompositionService, { load: gatewayComposition })),
);

it.effect('refuses a v2 assertion that carries a calling module claim', () =>
  Effect.gen(function* refuseActorOnV2() {
    const fixture = yield* makeFixture('party-registry', EXTERNAL_GATEWAY_ASSERTION_VERSION, thirdPartyPrincipal, {
      act: calledBy,
    });
    const failure = yield* Effect.flip(
      bindGatewayPrincipalVerifier('party-registry', {
        appId: 'party-registry',
        buildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
      }).verify(Redacted.make(`Bearer ${fixture.token}`), {
        currentTimeSeconds: Effect.succeed(currentTimeSeconds),
        environment: fixture.environment,
      }),
    );
    expect(isInvalidError(failure)).toBe(true);
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

it.effect('redeems every presentation and rejects replay across verifier instances', () =>
  Effect.gen(function* singleUseRedemption() {
    const fixture = yield* makeFixture('party-registry');
    let redemptions = 0;
    const redemption = {
      consume: () =>
        Effect.suspend(() => {
          redemptions += 1;
          return redemptions === 1
            ? Effect.void
            : Effect.fail(new GatewayAssertionReplayError({ reason: 'Already used' }));
        }),
    };
    const verifier = bindGatewayPrincipalVerifier('party-registry', {
      appId: 'party-registry',
      buildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
    });
    const options = {
      currentTimeSeconds: Effect.succeed(currentTimeSeconds),
      environment: fixture.environment,
      redemption,
    };
    const authorization = Redacted.make(`Bearer ${fixture.token}`);
    expect(yield* verifier.verifyAndRedeem(authorization, options)).toEqual(principal);
    expect(isInvalidError(yield* Effect.flip(verifier.verifyAndRedeem(authorization, options)))).toBe(true);
    const restarted = bindGatewayPrincipalVerifier('party-registry', {
      appId: 'party-registry',
      buildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
    });
    expect(isInvalidError(yield* Effect.flip(restarted.verifyAndRedeem(authorization, options)))).toBe(true);
    expect(redemptions).toBe(3);
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
    const unsupportedVersion = yield* makeFixture('party-registry', 4);
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

it.effect('imports verification keys once for configuration and the first and later assertions', () =>
  Effect.gen(function* reuseImportedVerificationKey() {
    const fixture = yield* makeFixture('party-registry');
    const verifier = bindGatewayPrincipalVerifier('party-registry', {
      appId: 'party-registry',
      buildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
    });
    const importKey = rs.spyOn(globalThis.crypto.subtle, 'importKey');
    yield* Effect.addFinalizer(() => Effect.sync(() => importKey.mockRestore()));
    const services = yield* Layer.build(
      GatewayPrincipalVerifierLive.pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(fixture.environment))),
      ),
    );
    const configuration = Context.get(services, GatewayPrincipalVerifierConfiguration);
    yield* configuration.configuration;
    expect(importKey).toHaveBeenCalledTimes(1);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const resolved = yield* verifier
        .verify(Redacted.make(`Bearer ${fixture.token}`), {
          currentTimeSeconds: Effect.succeed(currentTimeSeconds),
        })
        .pipe(Effect.provideService(GatewayPrincipalVerifierConfiguration, configuration));
      expect(resolved).toEqual(principal);
    }
    expect(importKey).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provideService(ActiveApplicationCompositionService, { load: gatewayComposition })),
);

const referenceScope = { ...principal, legalEntityId: '70000000-0000-4000-8000-000000000001' };
const referenceSource = (fixture: Effect.Success<ReturnType<typeof makeFixture>>, header?: string) =>
  makeReferenceGatewayCredentialSource(referenceScope).pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(
        new Request('https://owner.example.test/apply', {
          headers: header === undefined ? {} : { [REFERENCE_GATEWAY_CREDENTIALS_HEADER]: header },
        }),
      ),
    ),
    Effect.provideServiceEffect(
      GatewayPrincipalVerifierConfiguration,
      Effect.gen(function* referenceVerificationConfiguration() {
        const services = yield* Layer.build(GatewayPrincipalVerifierLive).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(fixture.environment)),
        );
        return Context.get(services, GatewayPrincipalVerifierConfiguration);
      }).pipe(Effect.scoped),
    ),
    Effect.provideService(ActiveApplicationCompositionService, { load: gatewayComposition }),
  );
const referenceHeader = (audience: string, token: string) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
    { apiBaseUrl: 'https://attacker.example.test/untrusted-route', audience, authorization: `Bearer ${token}` },
  ]);

it.effect(
  'reference credentials retain captured verification services, use composition routing, and pop once per request',
  () =>
    Effect.gen(function* forwardReferences() {
      yield* TestClock.setTime(currentTimeSeconds * 1000);
      const fixture = yield* makeFixture('party-registry', GATEWAY_ASSERTION_VERSION, referenceScope);
      const header = yield* referenceHeader('party-registry', fixture.token);
      const source = yield* referenceSource(fixture, header);
      // This execution occurs after factory providers have left scope; issue has no service requirements.
      const issued = yield* source.issue('party-registry');
      const snapshot = yield* gatewayComposition;
      expect(issued).toEqual({
        apiBaseUrl: new URL(
          '/party-registry-api',
          snapshot.composition.modules.find((module) => module.deployment.appId === 'party-registry')?.backend.baseUrl,
        ).href,
        authorization: `Bearer ${fixture.token}`,
        compositionRevision: snapshot.composition.revision,
      });
      expect(issued.apiBaseUrl).not.toContain('attacker');
      expect(isUnavailableError(yield* Effect.flip(source.issue('party-registry')))).toBe(true);
      const independentRequest = yield* referenceSource(fixture, header);
      expect((yield* independentRequest.issue('party-registry')).authorization).toBe(issued.authorization);
      const missing = yield* referenceSource(fixture);
      expect(isUnavailableError(yield* Effect.flip(missing.issue('party-registry')))).toBe(true);
    }),
);

it.effect('reference forwarding rejects mismatched signed actor, session, tenant, legal entity and binding', () =>
  Effect.gen(function* rejectMixedIdentity() {
    yield* TestClock.setTime(currentTimeSeconds * 1000);
    for (const signedScope of [
      { ...referenceScope, principalId: '40000000-0000-4000-8000-000000000002' },
      { ...referenceScope, authContextRef: 'another-signed-session' },
      { ...referenceScope, tenantId: '50000000-0000-4000-8000-000000000002' },
      { ...referenceScope, legalEntityId: '70000000-0000-4000-8000-000000000002' },
      { ...referenceScope, authBindingId: '30000000-0000-4000-8000-000000000002' },
    ]) {
      const fixture = yield* makeFixture('party-registry', GATEWAY_ASSERTION_VERSION, signedScope);
      const source = yield* referenceSource(fixture, yield* referenceHeader('party-registry', fixture.token));
      expect(isInvalidError(yield* Effect.flip(source.issue('party-registry')))).toBe(true);
      expect(isUnavailableError(yield* Effect.flip(source.issue('party-registry')))).toBe(true);
    }
  }),
);

it.effect(
  'reference forwarding rejects malformed transport headers, unapproved audiences and relabeled signed tokens',
  () =>
    Effect.gen(function* rejectReferenceTransport() {
      yield* TestClock.setTime(currentTimeSeconds * 1000);
      const fixture = yield* makeFixture('party-registry', GATEWAY_ASSERTION_VERSION, referenceScope);
      for (const header of [
        'not-json',
        '{}',
        '[{"audience":"party/registry","authorization":"Bearer token"}]',
        '[{"audience":"party-registry","authorization":""}]',
      ]) {
        expect(isInvalidError(yield* Effect.flip(referenceSource(fixture, header)))).toBe(true);
      }
      const unknown = yield* referenceSource(fixture, yield* referenceHeader('unapproved-owner', fixture.token));
      expect(isInvalidError(yield* Effect.flip(unknown.issue('unapproved-owner')))).toBe(true);
      const relabeled = yield* referenceSource(fixture, yield* referenceHeader('billing', fixture.token));
      expect(isScopeError(yield* Effect.flip(relabeled.issue('billing')))).toBe(true);
      const unauthorizedRequest = yield* referenceSource(
        fixture,
        yield* referenceHeader('party-registry', fixture.token),
      );
      expect(isUnavailableError(yield* Effect.flip(unauthorizedRequest.issue('billing')))).toBe(true);
      expect((yield* unauthorizedRequest.issue('party-registry')).authorization).toBe(`Bearer ${fixture.token}`);
    }),
);

it.effect('reference forwarding verifies real signatures and the current composition revision before forwarding', () =>
  Effect.gen(function* rejectInvalidSignatureAndRelease() {
    yield* TestClock.setTime(currentTimeSeconds * 1000);
    const fixture = yield* makeFixture('party-registry', GATEWAY_ASSERTION_VERSION, referenceScope);
    const otherKey = yield* makeFixture('party-registry', GATEWAY_ASSERTION_VERSION, referenceScope);
    const wrongSignature = yield* referenceSource(fixture, yield* referenceHeader('party-registry', otherKey.token));
    expect(isInvalidError(yield* Effect.flip(wrongSignature.issue('party-registry')))).toBe(true);
    const stale = yield* makeFixture('party-registry', GATEWAY_ASSERTION_VERSION, referenceScope, {
      compositionRevision: 'f'.repeat(64),
    });
    const staleSource = yield* referenceSource(stale, yield* referenceHeader('party-registry', stale.token));
    expect(isScopeError(yield* Effect.flip(staleSource.issue('party-registry')))).toBe(true);
  }),
);

it.effect(
  'redeems a real signed registered workload without external identity or widening its Principal company scope',
  () =>
    Effect.gen(function* verifyRegisteredWorkload() {
      const runReference = '60000000-0000-4000-8000-000000000002';
      const workload: RegisteredGatewayWorkload = {
        admissionInvocationId: runReference,
        bindingIncarnation: '60000000-0000-4000-8000-000000000003',
        declarationKey: 'party.registry.party.create',
        entrypointKey: 'test.operation.read',
        jobKey: 'source-import',
        legalEntityId: '70000000-0000-4000-8000-000000000001',
        legalEntityScope: 'required',
        originalOwnerBindingIncarnation: '60000000-0000-4000-8000-000000000005',
        originalPrincipalId: '40000000-0000-4000-8000-000000000002',
        originalWorkloadBindingIncarnation: '60000000-0000-4000-8000-000000000004',
        originalWorkloadKey: 'integration.source-admit',
        runReference,
        schemaVersion: '1',
        sourceAppId: 'billing',
        sourceBuildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
        sourceMode: 'admission',
        workloadKey: 'party.registry.source-import',
      };
      const system = {
        authContextRef: `job:source-import:run:${runReference}`,
        authMethod: 'system' as const,
        principalId: principal.principalId,
        tenantId: principal.tenantId,
      };
      const fixture = yield* makeFixture('party-registry', WORKLOAD_GATEWAY_ASSERTION_VERSION, system, { workload });
      const verifier = bindGatewayPrincipalVerifier('party-registry', {
        appId: 'party-registry',
        buildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
      });
      const options = { currentTimeSeconds: Effect.succeed(currentTimeSeconds), environment: fixture.environment };
      const unredeemed = yield* verifier.verify(Redacted.make(`Bearer ${fixture.token}`), options);
      expect(isTrustedSystemPrincipalContext(unredeemed)).toBe(false);
      const verified = yield* verifier.verifyAndRedeem(Redacted.make(`Bearer ${fixture.token}`), {
        ...options,
        redemption: { consume: () => Effect.void },
      });
      expect(isTrustedSystemPrincipalContext(verified)).toBe(true);
      expect(verified.legalEntityId).toBeUndefined();
      expect(verified.authenticationNamespaceId).toBeUndefined();
      expect(readVerifiedGatewayWorkload(verified)).toEqual(workload);
      expect(isTrustedSystemPrincipalContext({ ...verified })).toBe(false);
      expect(readVerifiedGatewayActor(verified)).toBeUndefined();
      const recovery = {
        originalActionInvocationId: runReference,
        originalActionKey: 'party.registry.source-create',
        originalAuthContextRef: `job:source-import:run:${runReference}`,
        originalIdempotencyKey: 'original-command',
        originalPrincipalId: workload.originalPrincipalId,
        originalRequestHash: 'a'.repeat(64),
        requestHash: 'b'.repeat(64),
      };
      const recoveryFixture = yield* makeFixture('party-registry', WORKLOAD_GATEWAY_ASSERTION_VERSION, system, {
        workload: { ...workload, recovery },
      });
      const recoveryPrincipal = yield* verifier.verifyAndRedeem(Redacted.make(`Bearer ${recoveryFixture.token}`), {
        ...options,
        environment: recoveryFixture.environment,
        redemption: { consume: () => Effect.void },
      });
      const proof = readVerifiedGatewayRecovery(recoveryPrincipal);
      expect(proof).toEqual(recovery);
      expect(Object.isFrozen(proof)).toBe(true);
      if (proof !== undefined) {
        expect(Reflect.set(proof, 'originalRequestHash', 'f'.repeat(64))).toBe(false);
      }
      expect(readVerifiedGatewayRecovery(recoveryPrincipal)?.originalRequestHash).toBe('a'.repeat(64));
      const wrongBuild = yield* makeFixture('party-registry', WORKLOAD_GATEWAY_ASSERTION_VERSION, system, {
        workload: { ...workload, sourceBuildMarker: 'not-approved' },
      });
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            verifier.verifyAndRedeem(Redacted.make(`Bearer ${wrongBuild.token}`), {
              ...options,
              environment: wrongBuild.environment,
              redemption: { consume: () => Effect.void },
            }),
          ),
        ),
      ).toBe(true);
    }).pipe(Effect.provideService(ActiveApplicationCompositionService, { load: gatewayComposition })),
);

const registeredRouteScope: RegisteredGatewayRouteScope = {
  legalEntityId: '70000000-0000-4000-8000-000000000001',
  operations: [{ entrypointKey: 'party.registry.api.route-context', schemaVersion: '1' }],
  principalId: principal.principalId,
  routeId: '70000000-0000-4000-8000-000000000002',
  routeKey: 'product-import',
  routeRevision: 'route-1',
  sourceRouteId: '70000000-0000-4000-8000-000000000003',
  sourceRouteRevision: 'source-1',
  tenantId: principal.tenantId,
};
const registeredRoutePrincipal = {
  authBindingId: principal.authBindingId,
  authContextRef: 'better-auth-api-key:registered-route-key',
  authenticationNamespaceId: 'private-route.identity.v1',
  authMethod: 'api_key' as const,
  legalEntityId: registeredRouteScope.legalEntityId,
  principalId: principal.principalId,
  tenantId: principal.tenantId,
};

it.effect('seals an exact signed V2 private route scope only after redemption without exposing a copyable marker', () =>
  Effect.gen(function* signedRouteScope() {
    const fixture = yield* makeFixture('party-registry', EXTERNAL_GATEWAY_ASSERTION_VERSION, registeredRoutePrincipal, {
      routeScope: registeredRouteScope,
    });
    const verifier = bindGatewayPrincipalVerifier('party-registry', {
      appId: 'party-registry',
      buildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
    });
    const options = { currentTimeSeconds: Effect.succeed(currentTimeSeconds), environment: fixture.environment };
    const signatureOnly = yield* verifier.verify(Redacted.make(`Bearer ${fixture.token}`), options);
    expect(readVerifiedGatewayRouteScope(signatureOnly)).toBeUndefined();
    const verified = yield* verifier.verifyAndRedeem(Redacted.make(`Bearer ${fixture.token}`), {
      ...options,
      redemption: { consume: () => Effect.void },
    });
    const scope = readVerifiedGatewayRouteScope(verified);
    expect(scope).toEqual(registeredRouteScope);
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.isFrozen(scope?.operations)).toBe(true);
    expect(Object.isFrozen(scope?.operations[0])).toBe(true);
    if (scope !== undefined) {
      expect(Reflect.set(scope, 'legalEntityId', '70000000-0000-4000-8000-000000000009')).toBe(false);
      const [operation] = scope.operations;
      if (operation !== undefined) {
        expect(Reflect.set(operation, 'entrypointKey', 'party.registry.api.other')).toBe(false);
      }
    }
    expect(Object.hasOwn(verified, 'routeScope')).toBe(false);
    expect(readVerifiedGatewayRouteScope({ ...verified })).toBeUndefined();
    expect(readVerifiedGatewayWorkload(verified)).toBeUndefined();
    expect(readVerifiedGatewayActor(verified)).toBeUndefined();
  }).pipe(Effect.provideService(ActiveApplicationCompositionService, { load: gatewayComposition })),
);

it.effect('rejects mismatched, non-finite, or non-API-key route scopes and rejects the marker on V1, V3, and V4', () =>
  Effect.gen(function* invalidSignedRouteScope() {
    const verifier = bindGatewayPrincipalVerifier('party-registry', {
      appId: 'party-registry',
      buildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
    });
    const invalidScopes: readonly unknown[] = [
      { ...registeredRouteScope, tenantId: '70000000-0000-4000-8000-000000000004' },
      { ...registeredRouteScope, principalId: '70000000-0000-4000-8000-000000000004' },
      { ...registeredRouteScope, legalEntityId: '70000000-0000-4000-8000-000000000004' },
      { ...registeredRouteScope, operations: [] },
      { ...registeredRouteScope, operations: [...registeredRouteScope.operations, ...registeredRouteScope.operations] },
      {
        ...registeredRouteScope,
        operations: Array.from({ length: 33 }, (_, index) => ({
          entrypointKey: `party.registry.api.route-${index}`,
          schemaVersion: '1',
        })),
      },
      { ...registeredRouteScope, routeRevision: '' },
      { ...registeredRouteScope, sourceRouteId: 'not-a-route-identity' },
    ];
    const redemptions = makeRedemptionCounter();
    for (const routeScope of invalidScopes) {
      const fixture = yield* makeFixture(
        'party-registry',
        EXTERNAL_GATEWAY_ASSERTION_VERSION,
        registeredRoutePrincipal,
        { routeScope },
      );
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            verifier.verifyAndRedeem(Redacted.make(`Bearer ${fixture.token}`), {
              currentTimeSeconds: Effect.succeed(currentTimeSeconds),
              environment: fixture.environment,
              redemption: {
                consume: redemptions.consume,
              },
            }),
          ),
        ),
      ).toBe(true);
    }
    const session = yield* makeFixture(
      'party-registry',
      EXTERNAL_GATEWAY_ASSERTION_VERSION,
      { ...registeredRoutePrincipal, authMethod: 'session' },
      { routeScope: registeredRouteScope },
    );
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          verifier.verify(Redacted.make(`Bearer ${session.token}`), {
            currentTimeSeconds: Effect.succeed(currentTimeSeconds),
            environment: session.environment,
          }),
        ),
      ),
    ).toBe(true);
    const runReference = '70000000-0000-4000-8000-000000000006';
    const workload = yield* Schema.decodeUnknownEffect(RegisteredGatewayWorkloadSchema)({
      admissionInvocationId: runReference,
      bindingIncarnation: runReference,
      declarationKey: 'party.registry.route.read',
      entrypointKey: 'party.registry.api.route',
      jobKey: 'route-marker-control',
      legalEntityScope: 'forbidden',
      originalOwnerBindingIncarnation: runReference,
      originalPrincipalId: principal.principalId,
      originalWorkloadBindingIncarnation: runReference,
      originalWorkloadKey: 'integration.route-admit',
      runReference,
      schemaVersion: '1',
      sourceAppId: 'billing',
      sourceBuildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
      sourceMode: 'admission',
      workloadKey: 'party.registry.route-read',
    });
    const system = {
      authContextRef: `job:route-marker-control:run:${runReference}`,
      authMethod: 'system' as const,
      principalId: principal.principalId,
      tenantId: principal.tenantId,
    };
    const versions = [
      { context: principal, extra: {}, version: GATEWAY_ASSERTION_VERSION },
      {
        context: registeredRoutePrincipal,
        extra: {
          act: {
            appId: 'billing',
            buildMarker: GATEWAY_FIXTURE_BUILD_MARKER,
            principalId: '70000000-0000-4000-8000-000000000007',
          },
        },
        version: DELEGATED_GATEWAY_ASSERTION_VERSION,
      },
      { context: system, extra: { workload }, version: WORKLOAD_GATEWAY_ASSERTION_VERSION },
    ];
    for (const version of versions) {
      const control = yield* makeFixture('party-registry', version.version, version.context, version.extra);
      yield* verifier.verify(Redacted.make(`Bearer ${control.token}`), {
        currentTimeSeconds: Effect.succeed(currentTimeSeconds),
        environment: control.environment,
      });
      const marked = yield* makeFixture('party-registry', version.version, version.context, {
        ...version.extra,
        routeScope: registeredRouteScope,
      });
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            verifier.verifyAndRedeem(Redacted.make(`Bearer ${marked.token}`), {
              currentTimeSeconds: Effect.succeed(currentTimeSeconds),
              environment: marked.environment,
              redemption: {
                consume: redemptions.consume,
              },
            }),
          ),
        ),
      ).toBe(true);
    }
    expect(redemptions.count()).toBe(0);
  }).pipe(Effect.provideService(ActiveApplicationCompositionService, { load: gatewayComposition })),
);
