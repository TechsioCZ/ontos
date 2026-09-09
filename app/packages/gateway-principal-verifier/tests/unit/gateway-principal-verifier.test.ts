import { GatewayAssertionRedemptionUnavailableError, GatewayAssertionReplayError } from '@app/core-runtime';
import { Effect, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { JWK, LocalJWKSet } from 'jose';

import {
  ActionPrincipalConfigurationErrorSchema,
  ActionPrincipalInvalidErrorSchema,
  ActionPrincipalScopeErrorSchema,
  ActionPrincipalUnavailableErrorSchema,
  GatewayPrincipalVerifierConfiguration,
  bindGatewayPrincipalVerifier,
} from '../../src/server.ts';

const currentTimeSeconds = 1_700_000_001;
const issuer = 'https://shell.ontos.test';
const principal = {
  authBindingId: '30000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:shared-verifier-test',
  authMethod: 'session' as const,
  principalId: '40000000-0000-4000-8000-000000000001',
  tenantId: '50000000-0000-4000-8000-000000000001',
};

const makeFixture = (audience: string, version = 1) =>
  Effect.gen(function* createFixture() {
    const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
    const publicJwk = {
      ...(yield* Effect.promise(() => exportJWK(publicKey))),
      alg: 'EdDSA',
      kid: 'shared-verifier-test',
      use: 'sig',
    };
    const token = yield* Effect.promise(() =>
      new SignJWT({ principal, ver: version })
        .setProtectedHeader({
          alg: 'EdDSA',
          kid: 'shared-verifier-test',
          typ: 'JWT',
        })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject(principal.principalId)
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

const isConfigurationError = Schema.is(ActionPrincipalConfigurationErrorSchema);
const isInvalidError = Schema.is(ActionPrincipalInvalidErrorSchema);
const isScopeError = Schema.is(ActionPrincipalScopeErrorSchema);
const isUnavailableError = Schema.is(ActionPrincipalUnavailableErrorSchema);
const failingKeySet = Object.assign(() => Promise.reject(new Error('fixture verifier details must be discarded')), {
  jwks: () => ({ keys: [] }),
}) satisfies LocalJWKSet;

it.effect('an audience-bound verifier accepts only its exact topology app ID', () =>
  Effect.gen(function* verifyAudienceBinding() {
    const partyFixture = yield* makeFixture('party-registry');
    const billingFixture = yield* makeFixture('billing');
    const verifier = bindGatewayPrincipalVerifier('party-registry');
    const verify = (token: string, environment: typeof partyFixture.environment) =>
      verifier.verify(Redacted.make(`Bearer ${token}`), {
        currentTimeSeconds: Effect.succeed(currentTimeSeconds),
        environment,
      });

    expect(yield* verify(partyFixture.token, partyFixture.environment)).toEqual(principal);
    expect(isScopeError(yield* Effect.flip(verify(billingFixture.token, billingFixture.environment)))).toBe(true);
  }),
);

it.effect('Bearer scheme matching is case insensitive without changing the signed token', () =>
  Effect.gen(function* verifyBearerCaseVariants() {
    const fixture = yield* makeFixture('party-registry');
    const verifier = bindGatewayPrincipalVerifier('party-registry');
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
  }),
);

it.effect('case insensitive Bearer matching still rejects malformed authorization headers', () =>
  Effect.gen(function* rejectMalformedBearerHeaders() {
    const fixture = yield* makeFixture('party-registry');
    const verifier = bindGatewayPrincipalVerifier('party-registry');
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
  }),
);

it.effect('empty and malformed audience bindings fail closed as configuration errors', () =>
  Effect.gen(function* rejectMalformedBindings() {
    const fixture = yield* makeFixture('party-registry');
    yield* Effect.forEach(
      ['', 'Party Registry', 'party/registry'],
      (audience) =>
        Effect.gen(function* checkMalformedBinding() {
          const failure = yield* Effect.flip(
            bindGatewayPrincipalVerifier(audience).verify(Redacted.make(`Bearer ${fixture.token}`), {
              currentTimeSeconds: Effect.succeed(currentTimeSeconds),
              environment: fixture.environment,
            }),
          );
          expect(isConfigurationError(failure)).toBe(true);
        }),
      { concurrency: 'unbounded' },
    );
  }),
);

it.effect('redemption failures remain sanitized and distinguish replay from unavailability', () =>
  Effect.gen(function* verifyRedemptionFailures() {
    const fixture = yield* makeFixture('party-registry');
    const verifier = bindGatewayPrincipalVerifier('party-registry');
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
  }),
);

it.effect('unsupported assertion versions and unexpected verifier failures fail closed', () =>
  Effect.gen(function* rejectUnsupportedAndUnexpectedFailures() {
    const unsupportedVersion = yield* makeFixture('party-registry', 2);
    const verifier = bindGatewayPrincipalVerifier('party-registry');
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
            configuration: Effect.succeed({ issuer, keySet: failingKeySet }),
          }),
        ),
    );
    expect(isUnavailableError(failure)).toBe(true);
    expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(failure)).not.toMatch(/fixture|eyJ/u);
  }),
);

it.effect('malformed Ed25519 public keys fail during configuration acquisition', () =>
  Effect.gen(function* rejectMalformedPublicKeys() {
    const fixture = yield* makeFixture('party-registry');
    const verifier = bindGatewayPrincipalVerifier('party-registry');
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
  }),
);
