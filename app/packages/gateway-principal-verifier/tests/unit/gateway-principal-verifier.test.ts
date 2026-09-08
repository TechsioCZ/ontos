import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GatewayAssertionRedemptionUnavailableError,
  GatewayAssertionReplayError,
} from '@app/core-runtime';
// @effect-diagnostics asyncFunction:off -- Node test callbacks and JOSE fixture creation are Promise APIs. remove-when: Effect test adapters support async Node callbacks.
import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import { Effect, Redacted, Schema } from 'effect';
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
import type { ActionPrincipalError } from '../../src/server.ts';

const currentTimeSeconds = 1_700_000_001;
const issuer = 'https://shell.ontos.test';
const principal = {
  authBindingId: '30000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:shared-verifier-test',
  authMethod: 'session' as const,
  principalId: '40000000-0000-4000-8000-000000000001',
  tenantId: '50000000-0000-4000-8000-000000000001',
};

const makeFixture = async (audience: string, version = 1) => {
  const { privateKey, publicKey } = await generateKeyPair('Ed25519');
  const publicJwk = {
    ...(await exportJWK(publicKey)),
    alg: 'EdDSA',
    kid: 'shared-verifier-test',
    use: 'sig',
  };
  const token = await new SignJWT({ principal, ver: version })
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
    .sign(privateKey);
  return {
    environment: {
      ONTOS_GATEWAY_ISSUER: issuer,
      ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
    },
    publicJwk,
    token,
  };
};

const isConfigurationError = Schema.is(ActionPrincipalConfigurationErrorSchema);
const isInvalidError = Schema.is(ActionPrincipalInvalidErrorSchema);
const isScopeError = Schema.is(ActionPrincipalScopeErrorSchema);
const isUnavailableError = Schema.is(ActionPrincipalUnavailableErrorSchema);
const failingKeySet = Object.assign(
  async () => {
    throw new Error('fixture verifier details must be discarded');
  },
  { jwks: () => ({ keys: [] }) }
) satisfies LocalJWKSet;

test('an audience-bound verifier accepts only its exact topology app ID', async () => {
  const partyFixture = await makeFixture('party-registry');
  const billingFixture = await makeFixture('billing');
  const verifier = bindGatewayPrincipalVerifier('party-registry');
  const verify = async (
    token: string,
    environment: typeof partyFixture.environment
  ) =>
    await runEffectTestPromise(
      verifier.verify(Redacted.make(`Bearer ${token}`), {
        currentTimeSeconds: Effect.succeed(currentTimeSeconds),
        environment,
      })
    );

  assert.deepEqual(
    await verify(partyFixture.token, partyFixture.environment),
    principal
  );
  await assert.rejects(
    verify(billingFixture.token, billingFixture.environment),
    isScopeError
  );
});

test('Bearer scheme matching is case insensitive without changing the signed token', async () => {
  const fixture = await makeFixture('party-registry');
  const verifier = bindGatewayPrincipalVerifier('party-registry');

  await Promise.all(
    ['Bearer', 'bearer', 'BEARER', 'bEaReR'].map(async (scheme) => {
      const verified = await runEffectTestPromise(
        verifier.verify(Redacted.make(`${scheme} ${fixture.token}`), {
          currentTimeSeconds: Effect.succeed(currentTimeSeconds),
          environment: fixture.environment,
        })
      );
      assert.deepEqual(verified, principal);
    })
  );
});

test('case insensitive Bearer matching still rejects malformed authorization headers', async () => {
  const fixture = await makeFixture('party-registry');
  const verifier = bindGatewayPrincipalVerifier('party-registry');

  await Promise.all(
    [
      ` bearer ${fixture.token}`,
      `bearer  ${fixture.token}`,
      `bearer\t${fixture.token}`,
      `bearer ${fixture.token} `,
      `bearer ${fixture.token} extra`,
      'bearer ',
      `Basic ${fixture.token}`,
    ].map(
      async (authorization) =>
        await assert.rejects(
          runEffectTestPromise(
            verifier.verify(Redacted.make(authorization), {
              currentTimeSeconds: Effect.succeed(currentTimeSeconds),
              environment: fixture.environment,
            })
          ),
          isInvalidError
        )
    )
  );
});

test('empty and malformed audience bindings fail closed as configuration errors', async () => {
  const fixture = await makeFixture('party-registry');
  await Promise.all(
    ['', 'Party Registry', 'party/registry'].map(
      async (audience) =>
        await assert.rejects(
          runEffectTestPromise(
            bindGatewayPrincipalVerifier(audience).verify(
              Redacted.make(`Bearer ${fixture.token}`),
              {
                currentTimeSeconds: Effect.succeed(currentTimeSeconds),
                environment: fixture.environment,
              }
            )
          ),
          isConfigurationError
        )
    )
  );
});

test('redemption failures remain sanitized and distinguish replay from unavailability', async () => {
  const fixture = await makeFixture('party-registry');
  const verifier = bindGatewayPrincipalVerifier('party-registry');
  const verify = async (
    redemption: Parameters<typeof verifier.verifyAndRedeem>[1]['redemption']
  ) =>
    await runEffectTestPromise(
      verifier.verifyAndRedeem(Redacted.make(`Bearer ${fixture.token}`), {
        currentTimeSeconds: Effect.succeed(currentTimeSeconds),
        environment: fixture.environment,
        redemption,
      })
    );

  await assert.rejects(
    verify({
      consume: () =>
        Effect.fail(
          new GatewayAssertionReplayError({
            reason: 'fixture replay details must be discarded',
          })
        ),
    }),
    (failure: ActionPrincipalError) => {
      assert.equal(isInvalidError(failure), true);
      assert.doesNotMatch(JSON.stringify(failure), /fixture|eyJ/u);
      return true;
    }
  );
  await assert.rejects(
    verify({
      consume: () =>
        Effect.fail(
          new GatewayAssertionRedemptionUnavailableError({
            reason: 'fixture storage details must be discarded',
          })
        ),
    }),
    (failure: ActionPrincipalError) => {
      assert.equal(isUnavailableError(failure), true);
      assert.doesNotMatch(JSON.stringify(failure), /fixture|eyJ/u);
      return true;
    }
  );
});

test('unsupported assertion versions and unexpected verifier failures fail closed', async () => {
  const unsupportedVersion = await makeFixture('party-registry', 2);
  const verifier = bindGatewayPrincipalVerifier('party-registry');
  await assert.rejects(
    runEffectTestPromise(
      verifier.verify(Redacted.make(`Bearer ${unsupportedVersion.token}`), {
        currentTimeSeconds: Effect.succeed(currentTimeSeconds),
        environment: unsupportedVersion.environment,
      })
    ),
    isInvalidError
  );

  const fixture = await makeFixture('party-registry');
  await assert.rejects(
    runEffectTestPromise(
      verifier
        .verify(Redacted.make(`Bearer ${fixture.token}`), {
          currentTimeSeconds: Effect.succeed(currentTimeSeconds),
        })
        .pipe(
          Effect.provideService(GatewayPrincipalVerifierConfiguration, {
            configuration: Effect.succeed({ issuer, keySet: failingKeySet }),
          })
        )
    ),
    (failure: ActionPrincipalError) => {
      assert.equal(isUnavailableError(failure), true);
      assert.doesNotMatch(JSON.stringify(failure), /fixture|eyJ/u);
      return true;
    }
  );
});

test('malformed Ed25519 public keys fail during configuration acquisition', async () => {
  const fixture = await makeFixture('party-registry');
  const verifier = bindGatewayPrincipalVerifier('party-registry');
  const verifyWithKey = async (key: JWK) =>
    await runEffectTestPromise(
      verifier.verify(Redacted.make(`Bearer ${fixture.token}`), {
        currentTimeSeconds: Effect.succeed(currentTimeSeconds),
        environment: {
          ONTOS_GATEWAY_ISSUER: issuer,
          ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [key] }),
        },
      })
    );

  await Promise.all([
    assert.rejects(
      verifyWithKey({ ...fixture.publicJwk, key_ops: [] }),
      isConfigurationError
    ),
    assert.rejects(
      verifyWithKey({ ...fixture.publicJwk, x: '!!!' }),
      isConfigurationError
    ),
  ]);
});
