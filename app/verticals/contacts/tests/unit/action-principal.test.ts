// @effect-diagnostics asyncFunction:off anyUnknownInErrorContext:off
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Effect } from 'effect';
import {
  GatewayAssertionRedemptionUnavailableError,
  GatewayAssertionReplayError,
} from '@app/core-runtime';
import type { GatewayAssertionRedemption } from '@app/core-runtime';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { ACTION_GATEWAY_AUDIENCE, verifyActionPrincipal } from '../../api/auth/action-principal.ts';
import { makeActionGateway } from '../../src/api/action-gateway.ts';

const issuer = 'https://shell.ontos.test';
const now = 1_700_000_000;
const principal = {
  authBindingId: 'a1000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:test-session',
  authMethod: 'session' as const,
  principalId: 'a2000000-0000-4000-8000-000000000001',
  tenantId: 'a3000000-0000-4000-8000-000000000001',
};

const consumed = new Set<string>();
const redemption: GatewayAssertionRedemption = {
  consume: ({ audience, issuer: assertionIssuer, jti }) =>
    Effect.gen(function* consumeTestAssertion() {
      const key = `${assertionIssuer}\0${audience}\0${jti}`;
      if (consumed.has(key)) {
        return yield* new GatewayAssertionReplayError({ reason: 'unusable' });
      }
      consumed.add(key);
    }),
};

const makeAssertion = async (
  audience: string = ACTION_GATEWAY_AUDIENCE,
  includePrivateKeyMaterial = false,
  claims: {
    readonly expiresAt?: number | false;
    readonly includeJti?: boolean;
    readonly issuedAt?: number;
  } = {},
) => {
  const { privateKey, publicKey } = await generateKeyPair('Ed25519');
  const publicJwk = {
    ...(await exportJWK(publicKey)),
    alg: 'EdDSA',
    ext: true,
    kid: 'contacts-test',
    use: 'sig',
    x5t: 'public-sha1-thumbprint',
    'x5t#S256': 'public-sha256-thumbprint',
    x5u: 'https://shell.ontos.test/certificates/contacts-test.pem',
  };
  if (includePrivateKeyMaterial) {
    Object.assign(publicJwk, { d: 'private-key-material-must-not-cross-the-boundary' });
  }
  let signer = new SignJWT({ principal, ver: 1 })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'contacts-test', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(principal.principalId)
    .setIssuedAt(claims.issuedAt ?? now);
  if (claims.expiresAt !== false) {
    signer = signer.setExpirationTime(claims.expiresAt ?? now + 300);
  }
  if (claims.includeJti !== false) {
    signer = signer.setJti(randomUUID());
  }
  const token = await signer.sign(privateKey);
  return {
    environment: {
      ONTOS_GATEWAY_ISSUER: issuer,
      ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
    },
    token,
  };
};

test('verifies a signed Contacts-audience assertion into trusted principal context', async () => {
  const assertion = await makeAssertion();
  assert.deepEqual(
    await Effect.runPromise(
      verifyActionPrincipal(`Bearer ${assertion.token}`, {
        currentTimeSeconds: Effect.succeed(now + 1),
        environment: assertion.environment,
        redemption,
      }),
    ),
    principal,
  );
});

test('accepts public JWK metadata while rejecting private key material', async () => {
  const publicAssertion = await makeAssertion();
  assert.deepEqual(
    await Effect.runPromise(
      verifyActionPrincipal(`Bearer ${publicAssertion.token}`, {
        currentTimeSeconds: Effect.succeed(now + 1),
        environment: publicAssertion.environment,
        redemption,
      }),
    ),
    principal,
  );

  const privateAssertion = await makeAssertion(ACTION_GATEWAY_AUDIENCE, true);
  const failure = await Effect.runPromise(
    Effect.flip(
      verifyActionPrincipal(`Bearer ${privateAssertion.token}`, {
        currentTimeSeconds: Effect.succeed(now + 1),
        environment: privateAssertion.environment,
        redemption,
      }),
    ),
  );
  assert.equal(failure._tag, 'ActionPrincipalConfigurationError');
});

test('sanitizes missing, wrong-audience, and malformed assertion failures', async () => {
  const assertion = await makeAssertion('billing');
  const failures = await Promise.all([
    Effect.runPromise(
      Effect.flip(
        verifyActionPrincipal(undefined, {
          currentTimeSeconds: Effect.succeed(now + 1),
          environment: assertion.environment,
          redemption,
        }),
      ),
    ),
    Effect.runPromise(
      Effect.flip(
        verifyActionPrincipal(`Bearer ${assertion.token}`, {
          currentTimeSeconds: Effect.succeed(now + 1),
          environment: assertion.environment,
          redemption,
        }),
      ),
    ),
    Effect.runPromise(
      Effect.flip(
        verifyActionPrincipal('Bearer not-a-jwt', {
          currentTimeSeconds: Effect.succeed(now + 1),
          environment: assertion.environment,
          redemption,
        }),
      ),
    ),
  ]);
  assert.deepEqual(
    failures.map((failure) => failure._tag),
    ['ActionPrincipalMissingError', 'ActionPrincipalScopeError', 'ActionPrincipalInvalidError'],
  );
  assert.equal(JSON.stringify(failures).includes(assertion.token), false);
});

test('rejects sequential and concurrent replay while allowing exactly one redemption', async () => {
  const assertion = await makeAssertion();
  const options = {
    currentTimeSeconds: Effect.succeed(now + 1),
    environment: assertion.environment,
    redemption,
  };
  const outcomes = await Promise.allSettled([
    Effect.runPromise(verifyActionPrincipal(`Bearer ${assertion.token}`, options)),
    Effect.runPromise(verifyActionPrincipal(`Bearer ${assertion.token}`, options)),
  ]);
  assert.deepEqual(outcomes.map(({ status }) => status).toSorted(), ['fulfilled', 'rejected']);
  const replay = await Effect.runPromise(
    Effect.flip(verifyActionPrincipal(`Bearer ${assertion.token}`, options)),
  );
  assert.equal(replay._tag, 'ActionPrincipalInvalidError');
});

test('redemption storage failure is a typed fail-closed unavailable response', async () => {
  const assertion = await makeAssertion();
  const failure = await Effect.runPromise(
    Effect.flip(
      verifyActionPrincipal(`Bearer ${assertion.token}`, {
        currentTimeSeconds: Effect.succeed(now + 1),
        environment: assertion.environment,
        redemption: {
          consume: () =>
            Effect.fail(
              new GatewayAssertionRedemptionUnavailableError({ reason: 'database unavailable' }),
            ),
        },
      }),
    ),
  );
  assert.equal(failure._tag, 'ActionPrincipalUnavailableError');
  assert.doesNotMatch(failure.reason, /database/u);
});

test('missing, expired, and incomplete replay claims fail before redemption storage', async () => {
  const assertions = await Promise.all([
    makeAssertion(ACTION_GATEWAY_AUDIENCE, false, { includeJti: false }),
    makeAssertion(ACTION_GATEWAY_AUDIENCE, false, { expiresAt: now - 31, issuedAt: now - 331 }),
    makeAssertion(ACTION_GATEWAY_AUDIENCE, false, { expiresAt: false }),
  ]);
  let redemptionAttempts = 0;
  const countingRedemption: GatewayAssertionRedemption = {
    consume: () =>
      Effect.sync(() => {
        redemptionAttempts += 1;
      }),
  };
  const failures = await Promise.all(
    assertions.map(
      async (assertion) =>
        await Effect.runPromise(
          Effect.flip(
            verifyActionPrincipal(`Bearer ${assertion.token}`, {
              currentTimeSeconds: Effect.succeed(now + 1),
              environment: assertion.environment,
              redemption: countingRedemption,
            }),
          ),
        ),
    ),
  );
  assert.deepEqual(
    failures.map(({ _tag }) => _tag),
    ['ActionPrincipalInvalidError', 'ActionPrincipalExpiredError', 'ActionPrincipalInvalidError'],
  );
  assert.equal(redemptionAttempts, 0);
});

test('acquires a fresh Contacts assertion for every gateway invocation', async () => {
  let issued = 0;
  const gateway = makeActionGateway(() =>
    Effect.sync(() => {
      issued += 1;
      return { expiresAt: now + 300, token: `token-${issued}` };
    }),
  );
  assert.equal(await Effect.runPromise(gateway.invoke(Effect.succeed)), 'Bearer token-1');
  assert.equal(await Effect.runPromise(gateway.invoke(Effect.succeed)), 'Bearer token-2');
  assert.equal(issued, 2);
});
